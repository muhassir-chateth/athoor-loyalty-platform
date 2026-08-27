/**
 * Tests for `POST /v1/orders/:orderId/reorder-plan` (N3) — spec task 8.3, design
 * §6.3 N3, §7.5, Req 6.6/6.7.
 *
 * Three layers: the per-line classifier, the scoped read (where the IDOR answer
 * lives), and the route over a REAL Fastify app with the REAL `/v1` auth and
 * idempotency layers.
 *
 * SAFETY: no network, no Postgres, no production, and — asserted below — no cart
 * write and no mutation of any kind.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import type { ScopedGraphqlTransport } from "../portal/repository/shopifyScope.js";
import { assertScopedCustomerQuery } from "../portal/repository/shopifyScope.js";
import type { ShopifyCustomerIdLookup } from "../shopify/purchaseHistory.js";
import { ShopifyAdminRequestError } from "../shopify/graphqlClient.js";
import {
  PORTAL_REORDER_PLAN_QUERY,
  classifyReorderLine,
  readScopedReorderPlan,
} from "../portal/repository/reorder.js";
import {
  REORDER_RATE_LIMIT_MAX_REQUESTS,
  ShopifyPortalOrderSource,
  UnconfiguredPortalOrderSource,
  parseReorderBody,
  type PortalOrderSource,
} from "./orders.js";
import type { CustomerScope } from "../auth/customerScope.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";
const ORDER_ID = "6543210987";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };
const SCOPE = { customerId: LOCAL_CUSTOMER_ID } as unknown as CustomerScope;

function keyed(n: number): Record<string, string> {
  return { ...AUTH, "idempotency-key": `reorder-${n}-${Math.random().toString(36).slice(2)}` };
}

/* ========================================================================== *
 * 1 — the body parser
 * ========================================================================== */

describe("parseReorderBody (§6.3 N3)", () => {
  it("treats an absent body as THE WHOLE ORDER — the Reorder case", () => {
    for (const body of [undefined, null, ""]) {
      expect(parseReorderBody(body)).toEqual({ ok: true, lineItemIds: undefined });
    }
    expect(parseReorderBody({})).toEqual({ ok: true, lineItemIds: undefined });
    expect(parseReorderBody({ lineItemIds: null })).toEqual({ ok: true, lineItemIds: undefined });
  });

  it("accepts a subset — the Buy Again case", () => {
    expect(parseReorderBody({ lineItemIds: ["11", "22"] })).toEqual({
      ok: true,
      lineItemIds: ["11", "22"],
    });
  });

  it("distinguishes an EMPTY array from an absent one", () => {
    // An empty list is a request to reorder nothing. Treating it as "the whole
    // order" would add items the customer did not ask for.
    expect(parseReorderBody({ lineItemIds: [] })).toEqual({ ok: true, lineItemIds: [] });
  });

  it("rejects a malformed body rather than silently reordering everything", () => {
    expect(parseReorderBody("nope").ok).toBe(false);
    expect(parseReorderBody([1, 2]).ok).toBe(false);
    expect(parseReorderBody({ lineItemIds: "11" }).ok).toBe(false);
    expect(parseReorderBody({ lineItemIds: [1] }).ok).toBe(false);
    expect(parseReorderBody({ lineItemIds: [""] }).ok).toBe(false);
  });
});

/* ========================================================================== *
 * 2 — the classifier (§7.5)
 * ========================================================================== */

const LIVE_PRODUCT = {
  id: "gid://shopify/Product/4400",
  status: "ACTIVE",
  publishedAt: "2024-01-01T00:00:00Z",
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/4477", availableForSale: true }] },
};

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/LineItem/11",
    title: "Oud Royale 50ml",
    quantity: 2,
    product: LIVE_PRODUCT,
    ...overrides,
  };
}

describe("classifyReorderLine (§7.5, Req 6.7)", () => {
  it("resolves the CURRENT default variant, not the one recorded on the order", () => {
    // The whole reason N3 exists: a variant id on a two-year-old order may be gone.
    expect(classifyReorderLine(line())).toEqual({
      addable: { variantId: "4477", quantity: 2, title: "Oud Royale 50ml" },
    });
  });

  it("marks an out-of-stock product out_of_stock — come back later", () => {
    const product = {
      ...LIVE_PRODUCT,
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/4477", availableForSale: false }] },
    };
    expect(classifyReorderLine(line({ product }))).toEqual({
      unavailable: { title: "Oud Royale 50ml", reason: "out_of_stock" },
    });
  });

  it("marks a DELETED product discontinued", () => {
    expect(classifyReorderLine(line({ product: null }))).toEqual({
      unavailable: { title: "Oud Royale 50ml", reason: "discontinued" },
    });
  });

  it("marks an UNPUBLISHED product discontinued — it cannot be bought either", () => {
    for (const product of [
      { ...LIVE_PRODUCT, publishedAt: null },
      { ...LIVE_PRODUCT, status: "ARCHIVED" },
      { ...LIVE_PRODUCT, status: "DRAFT" },
    ]) {
      expect(classifyReorderLine(line({ product }))).toEqual({
        unavailable: { title: "Oud Royale 50ml", reason: "discontinued" },
      });
    }
  });

  it("marks a product with no nameable variant discontinued, not out of stock", () => {
    for (const variants of [{ nodes: [] }, { nodes: [{ id: null, availableForSale: true }] }, null]) {
      expect(classifyReorderLine(line({ product: { ...LIVE_PRODUCT, variants } }))).toEqual({
        unavailable: { title: "Oud Royale 50ml", reason: "discontinued" },
      });
    }
  });

  it("defaults a missing or absurd quantity to 1 rather than 0 or NaN", () => {
    for (const quantity of [null, undefined, 0, -3, 1.5]) {
      const classified = classifyReorderLine(line({ quantity }));
      expect("addable" in classified && classified.addable.quantity, String(quantity)).toBe(1);
    }
  });
});

/* ========================================================================== *
 * 3 — the scoped read (the IDOR answer)
 * ========================================================================== */

class FakeTransport implements ScopedGraphqlTransport {
  requests = 0;
  lastDocument = "";
  constructor(private readonly reply: (variables: Record<string, unknown>) => unknown) {}
  async request<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    this.requests += 1;
    this.lastDocument = document;
    return this.reply(variables) as T;
  }
}

class FakeLookup implements ShopifyCustomerIdLookup {
  async findShopifyCustomerId(): Promise<string | null> {
    return SHOPIFY_CUSTOMER_ID;
  }
}

/** Answers only when the `id:<numeric>` filter matches — as the connection would. */
function orderReply(orderId: string, lines: Record<string, unknown>[]) {
  return (variables: Record<string, unknown>): unknown => {
    const wanted = String(variables.orderQuery ?? "").replace(/^id:/, "");
    if (wanted !== orderId) return { customer: { orders: { nodes: [] } } };
    return {
      customer: {
        orders: { nodes: [{ id: `gid://shopify/Order/${orderId}`, lineItems: { nodes: lines } }] },
      },
    };
  };
}

describe("readScopedReorderPlan", () => {
  const deps = (reply: (v: Record<string, unknown>) => unknown) => ({
    transport: new FakeTransport(reply),
    lookup: new FakeLookup(),
  });

  it("builds a plan for the customer's own order", async () => {
    const plan = await readScopedReorderPlan(
      deps(orderReply(ORDER_ID, [line()])),
      SCOPE,
      ORDER_ID,
    );
    expect(plan).toEqual({
      addable: [{ variantId: "4477", quantity: 2, title: "Oud Royale 50ml" }],
      unavailable: [],
    });
  });

  it("returns null for an order outside this customer's connection", async () => {
    // A foreign order is UNREACHABLE, not rejected — there is no ownership
    // comparison to forget.
    const plan = await readScopedReorderPlan(
      deps(orderReply(ORDER_ID, [line()])),
      SCOPE,
      "7777777777",
    );
    expect(plan).toBeNull();
  });

  it("returns null when Shopify hands back a DIFFERENT order than asked for", async () => {
    // The post-condition N2 also carries: which order came back must not rest on
    // Shopify's search semantics.
    const mismatched = () => ({
      customer: {
        orders: { nodes: [{ id: "gid://shopify/Order/9999999999", lineItems: { nodes: [line()] } }] },
      },
    });
    expect(await readScopedReorderPlan(deps(mismatched), SCOPE, ORDER_ID)).toBeNull();
  });

  it("refuses a malformed order reference before any request is made", async () => {
    const d = deps(orderReply(ORDER_ID, [line()]));
    await expect(readScopedReorderPlan(d, SCOPE, "abc")).rejects.toThrow();
    expect(d.transport.requests).toBe(0);
  });

  it("honours a lineItemIds subset — the Buy Again case", async () => {
    const two = [line(), line({ id: "gid://shopify/LineItem/22", title: "Amber Nuit 100ml" })];
    const plan = await readScopedReorderPlan(deps(orderReply(ORDER_ID, two)), SCOPE, ORDER_ID, [
      "gid://shopify/LineItem/22",
    ]);
    expect(plan?.addable.map((a) => a.title)).toEqual(["Amber Nuit 100ml"]);
  });

  it("accepts a numeric line item id as well as a GID", async () => {
    const two = [line(), line({ id: "gid://shopify/LineItem/22", title: "Amber Nuit 100ml" })];
    const plan = await readScopedReorderPlan(deps(orderReply(ORDER_ID, two)), SCOPE, ORDER_ID, ["22"]);
    expect(plan?.addable.map((a) => a.title)).toEqual(["Amber Nuit 100ml"]);
  });

  it("IGNORES an unknown line item id rather than confirming which ids exist", async () => {
    const plan = await readScopedReorderPlan(
      deps(orderReply(ORDER_ID, [line()])),
      SCOPE,
      ORDER_ID,
      ["gid://shopify/LineItem/99999"],
    );
    expect(plan).toEqual({ addable: [], unavailable: [] });
  });

  it("separates addable from unavailable so the client can say which were dropped (Req 6.7)", async () => {
    const mixed = [
      line(),
      line({
        id: "gid://shopify/LineItem/22",
        title: "Amber Nuit 100ml",
        product: {
          ...LIVE_PRODUCT,
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", availableForSale: false }] },
        },
      }),
      line({ id: "gid://shopify/LineItem/33", title: "Gone Forever", product: null }),
    ];
    const plan = await readScopedReorderPlan(deps(orderReply(ORDER_ID, mixed)), SCOPE, ORDER_ID);
    expect(plan?.addable).toEqual([{ variantId: "4477", quantity: 2, title: "Oud Royale 50ml" }]);
    expect(plan?.unavailable).toEqual([
      { title: "Amber Nuit 100ml", reason: "out_of_stock" },
      { title: "Gone Forever", reason: "discontinued" },
    ]);
  });

  it("sends a CUSTOMER-ROOTED document, and never a mutation or a cart write", async () => {
    // The backend must not touch the cart (§6.3 N3): the client posts `addable` to
    // Shopify's own /cart/add.js.
    expect(() => assertScopedCustomerQuery(PORTAL_REORDER_PLAN_QUERY)).not.toThrow();
    expect(PORTAL_REORDER_PLAN_QUERY).not.toMatch(/\bmutation\b/i);
    expect(PORTAL_REORDER_PLAN_QUERY).not.toMatch(/cart/i);
  });
});

/* ========================================================================== *
 * 4 — the route, end to end
 * ========================================================================== */

function buildApp(source?: PortalOrderSource): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    portalOrderSource:
      source ??
      new ShopifyPortalOrderSource({
        transport: new FakeTransport(orderReply(ORDER_ID, [line()])),
        lookup: new FakeLookup(),
      }),
  });
  return app;
}

describe("POST /v1/orders/:orderId/reorder-plan (N3)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("returns addable and unavailable (§6.3 N3)", async () => {
    app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers: keyed(1),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      addable: [{ variantId: "4477", quantity: 2, title: "Oud Royale 50ml" }],
      unavailable: [],
    });
  });

  it("returns a NUMERIC variantId, because the client posts it to /cart/add.js", async () => {
    app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers: keyed(2),
      payload: {},
    });
    expect(res.json().addable[0].variantId).toBe("4477");
    expect(res.body).not.toContain("gid://");
  });

  it("REQUIRES an Idempotency-Key on this state-changing method (Req 9.7)", async () => {
    app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_idempotency_key");
  });

  it("replays the same result for a repeated key without re-reading Shopify (Req 9.6)", async () => {
    const transport = new FakeTransport(orderReply(ORDER_ID, [line()]));
    app = buildApp(new ShopifyPortalOrderSource({ transport, lookup: new FakeLookup() }));
    await app.ready();
    const headers = { ...AUTH, "idempotency-key": "fixed-reorder-key" };
    const first = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers,
      payload: {},
    });
    const readsAfterFirst = transport.requests;
    const second = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers,
      payload: {},
    });
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    // The handler never ran the second time.
    expect(transport.requests).toBe(readsAfterFirst);
  });

  it(`rejects the request after ${REORDER_RATE_LIMIT_MAX_REQUESTS} in the window (design line 3780)`, async () => {
    app = buildApp();
    await app.ready();
    for (let i = 0; i < REORDER_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const ok = await app.inject({
        method: "POST",
        url: `/v1/orders/${ORDER_ID}/reorder-plan`,
        headers: keyed(100 + i),
        payload: {},
      });
      expect(ok.statusCode, `request ${i + 1}`).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers: keyed(999),
      payload: {},
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("rate_limit_exceeded");
    // The message names the right action, not "redemption".
    expect(limited.json().message).toContain("reorder");
  });

  it("answers 400 invalid_order_reference for a malformed path", async () => {
    app = buildApp();
    await app.ready();
    for (const reference of ["abc", "-1", "gid%3A%2F%2Fshopify%2FOrder%2F123", "123456789012345678901"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/orders/${reference}/reorder-plan`,
        headers: keyed(200),
        payload: {},
      });
      expect(res.statusCode, reference).toBe(400);
      expect(res.json().error).toBe("invalid_order_reference");
    }
  });

  it("answers 400 invalid_request for a malformed body", async () => {
    app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers: keyed(3),
      payload: { lineItemIds: "not-an-array" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("answers 404 order_not_found for a foreign order, with no order field", async () => {
    app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders/7777777777/reorder-plan",
      headers: keyed(4),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("order_not_found");
    expect(Object.keys(res.json()).sort()).toEqual(["apiVersion", "error", "message"]);
    expect(res.body).not.toContain("7777777777");
  });

  it("answers 502 upstream_unavailable when Shopify is unreachable", async () => {
    app = buildApp(
      new ShopifyPortalOrderSource({
        transport: {
          async request() {
            throw new ShopifyAdminRequestError("down");
          },
        },
        lookup: new FakeLookup(),
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers: keyed(5),
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
  });

  it("REFUSES rather than answering an empty plan when unwired", async () => {
    // An empty plan says "nothing on this order can be bought again".
    app = buildApp(new UnconfiguredPortalOrderSource());
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${ORDER_ID}/reorder-plan`,
      headers: keyed(6),
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().addable).toBeUndefined();
  });

  it("requires an identity — 401 before any 400 about the reference", async () => {
    app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders/abc/reorder-plan",
      payload: {},
    });
    // A stranger learns nothing about which references are well-formed.
    expect(res.statusCode).toBe(401);
  });
});
