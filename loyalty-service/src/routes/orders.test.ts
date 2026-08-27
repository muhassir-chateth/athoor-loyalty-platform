/**
 * Tests for `GET /v1/orders` (N1) and `GET /v1/orders/:orderId` (N2)
 * — spec tasks 8.1/8.2, design §6.3, §7.1–§7.6.
 *
 * Three layers, for the same reason `history.test.ts` has three:
 *   1. the pure query parser, where the Req 6.12 capping rule lives;
 *   2. the caching source, where §7.6's coalescing claim is either true or not;
 *   3. the routes over a REAL Fastify app with the REAL `/v1` auth layer, the
 *      REAL repository projection and a fake Admin transport — so the four-state
 *      product table, the tracking rules and every status code are exercised
 *      end to end rather than at the seam.
 *
 * The layer-3 app is wired with `ShopifyPortalOrderSource` over a fake transport
 * on purpose. Injecting a hand-written fake source instead would test the routes
 * against a second implementation of the contract, which is precisely the shape
 * of the W1/W2 defects (design §8.1) — two private ideas of one contract, both
 * green.
 *
 * SAFETY: no network, no Postgres, no production. The Admin transport is a local
 * fake and the id lookup is either a fake or a RECORDING `Queryable` that never
 * connects to anything.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.8, 6.9, 6.12, 3.3, 18.5
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { registerVersioning } from "../plugins/versioning.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import type { Queryable } from "../ledger/repository.js";
import {
  PgShopifyCustomerIdLookup,
  type ShopifyCustomerIdLookup,
} from "../shopify/purchaseHistory.js";
import { ShopifyReadTimeoutError } from "../shopify/coalescingCache.js";
import { ShopifyThrottleError } from "../shopify/adminGateway.js";
import { ShopifyAdminRequestError } from "../shopify/graphqlClient.js";
import type { ScopedGraphqlTransport } from "../portal/repository/shopifyScope.js";
import { PORTAL_ORDERS_MAX_PAGE_SIZE } from "../portal/types.js";
import {
  CachingPortalOrderSource,
  InMemoryPortalOrderSource,
  ORDERS_MAX_CURSOR_LENGTH,
  ShopifyPortalOrderSource,
  UnconfiguredPortalOrderSource,
  parseOrdersQuery,
  type OrdersQuery,
  type PortalOrderSource,
} from "./orders.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";
const ORDER_ID = "6543210987";

/* ========================================================================== *
 * 1 — the query parser (Req 6.12, §7.3)
 * ========================================================================== */

describe("parseOrdersQuery (Req 6.12, §7.3)", () => {
  it("defaults to the maximum page size when unspecified", () => {
    expect(parseOrdersQuery({})).toEqual({
      ok: true,
      query: { pageSize: PORTAL_ORDERS_MAX_PAGE_SIZE },
    });
  });

  it("CAPS an oversized request at 20 rather than rejecting it (Req 6.12)", () => {
    // THE RULE §7.3 states: "a caller asking for 100 gets 20, not an error,
    // because a larger page is not a client error, it is a limit."
    for (const requested of ["21", "100", "1000", "9007199254740991"]) {
      const parsed = parseOrdersQuery({ pageSize: requested });
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.query.pageSize).toBe(20);
    }
  });

  it("caps a page size beyond MAX_SAFE_INTEGER too — it is still just a larger page", () => {
    // An `isSafeInteger` guard here would reject this as malformed, which would
    // make the cap rule depend on how large the optimism was.
    const parsed = parseOrdersQuery({ pageSize: "99999999999999999999" });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.query.pageSize).toBe(20);
  });

  it("accepts a smaller page verbatim", () => {
    expect(parseOrdersQuery({ pageSize: "1" })).toEqual({ ok: true, query: { pageSize: 1 } });
    expect(parseOrdersQuery({ pageSize: "5" })).toEqual({ ok: true, query: { pageSize: 5 } });
  });

  it("rejects a page size that is not a request for a larger page", () => {
    // The spec defines only the above-maximum case; a non-positive or
    // non-numeric size is a broken client, and serving 20 orders to a caller
    // that asked for -5 hides the bug from the only person who can fix it.
    for (const bad of ["0", "-5", "abc", "2.5", "10x", "1e3"]) {
      expect(parseOrdersQuery({ pageSize: bad }).ok, `pageSize=${bad}`).toBe(false);
    }
  });

  it("treats an opaque cursor as opaque, and bounds only its size", () => {
    expect(parseOrdersQuery({ cursor: "eyJsYXN0X2lkIjo" })).toEqual({
      ok: true,
      query: { pageSize: 20, cursor: "eyJsYXN0X2lkIjo" },
    });
    expect(parseOrdersQuery({ cursor: "x".repeat(ORDERS_MAX_CURSOR_LENGTH) }).ok).toBe(true);
    expect(parseOrdersQuery({ cursor: "x".repeat(ORDERS_MAX_CURSOR_LENGTH + 1) }).ok).toBe(false);
  });

  it("reads the first value of a repeated parameter", () => {
    expect(parseOrdersQuery({ pageSize: ["5", "20"] })).toEqual({ ok: true, query: { pageSize: 5 } });
  });
});

/* ========================================================================== *
 * Shopify fixtures
 * ========================================================================== */

const PUBLISHED_PRODUCT = {
  id: "gid://shopify/Product/4400",
  handle: "oud-royale",
  status: "ACTIVE",
  publishedAt: "2024-01-01T00:00:00Z",
};

function orderNode(overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/Order/${ORDER_ID}`,
    name: "#1042",
    processedAt: "2026-07-14T10:02:11Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currencyCode: "GBP",
    totalPriceSet: { shopMoney: { amount: "184.0" } },
    subtotalPriceSet: { shopMoney: { amount: "165.6" } },
    totalShippingPriceSet: { shopMoney: { amount: "4.95" } },
    totalTaxSet: { shopMoney: { amount: "13.45" } },
    shippingAddress: {
      firstName: "A",
      lastName: "B",
      address1: "1 Road",
      address2: null,
      city: "London",
      province: null,
      zip: "W1A 1AA",
      countryCodeV2: "GB",
      phone: null,
    },
    fulfillments: [
      {
        status: "SUCCESS",
        displayStatus: "DELIVERED",
        trackingInfo: [{ company: "Royal Mail", number: "AB123", url: "https://track/AB123" }],
      },
    ],
    lineItems: {
      nodes: [
        {
          title: "Oud Royale 50ml",
          quantity: 1,
          unfulfilledQuantity: 0,
          originalUnitPriceSet: { shopMoney: { amount: "184.00" } },
          discountedTotalSet: { shopMoney: { amount: "165.60" } },
          image: { url: "https://cdn/oud.jpg", width: 800, height: 800 },
          variant: { id: "gid://shopify/ProductVariant/4477", availableForSale: true },
          product: PUBLISHED_PRODUCT,
        },
      ],
    },
    ...overrides,
  };
}

/** A fake Admin transport that answers both documents and counts requests. */
class FakeAdminTransport implements ScopedGraphqlTransport {
  requests = 0;
  constructor(
    private readonly reply: (variables: Record<string, unknown>) => unknown,
  ) {}
  async request<T>(_document: string, variables: Record<string, unknown>): Promise<T> {
    this.requests += 1;
    return this.reply(variables) as T;
  }
}

class ThrowingTransport implements ScopedGraphqlTransport {
  constructor(private readonly error: Error) {}
  async request<T>(): Promise<T> {
    throw this.error;
  }
}

class FakeLookup implements ShopifyCustomerIdLookup {
  async findShopifyCustomerId(): Promise<string | null> {
    return SHOPIFY_CUSTOMER_ID;
  }
}

/** Answers the N1 document with a page, and the N2 document with one order. */
function pagedReply(orders: Record<string, unknown>[], hasNextPage = false, endCursor: string | null = null) {
  return (variables: Record<string, unknown>): unknown => {
    if (typeof variables.orderQuery === "string") {
      // N2 — filtered by `id:<numeric>`; only return the order when it matches.
      const wanted = variables.orderQuery.replace(/^id:/, "");
      const match = orders.filter((order) => String(order.id).endsWith(`/${wanted}`));
      return { customer: { orders: { nodes: match } } };
    }
    return { customer: { orders: { pageInfo: { hasNextPage, endCursor }, nodes: orders } } };
  };
}

/* ========================================================================== *
 * 2 — the caching source (§7.6)
 * ========================================================================== */

describe("CachingPortalOrderSource (§7.6)", () => {
  const scope = { customerId: LOCAL_CUSTOMER_ID } as unknown as Parameters<
    PortalOrderSource["listOrders"]
  >[0];
  const query: OrdersQuery = { pageSize: 20 };

  it("collapses two CONCURRENT consumers into ONE Shopify read (§7.6)", async () => {
    // The stated motivation: Overview shows the most recent order while Orders
    // shows the list — two consumers, one Shopify read.
    let reads = 0;
    let release: () => void = () => {};
    const inner: PortalOrderSource = {
      listOrders: () => {
        reads += 1;
        return new Promise((resolve) => {
          release = () =>
            resolve({ orders: [], pageInfo: { hasNextPage: false, endCursor: null } });
        });
      },
      getOrder: async () => null,
    };
    const cached = new CachingPortalOrderSource(inner);

    const first = cached.listOrders(scope, query);
    const second = cached.listOrders(scope, query);
    release();
    await Promise.all([first, second]);

    expect(reads).toBe(1);
  });

  it("reuses a resolved page within the TTL", async () => {
    let reads = 0;
    const cached = new CachingPortalOrderSource({
      listOrders: async () => {
        reads += 1;
        return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      getOrder: async () => null,
    });
    await cached.listOrders(scope, query);
    await cached.listOrders(scope, query);
    expect(reads).toBe(1);
  });

  it("does NOT serve a different page size from a cached page", async () => {
    // Keying on the customer alone would satisfy §7.6's wording and answer a
    // question that was never asked.
    const sizes: number[] = [];
    const cached = new CachingPortalOrderSource({
      listOrders: async (_scope, q) => {
        sizes.push(q.pageSize);
        return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      getOrder: async () => null,
    });
    await cached.listOrders(scope, { pageSize: 20 });
    await cached.listOrders(scope, { pageSize: 5 });
    expect(sizes).toEqual([20, 5]);
  });

  it("does NOT serve one cursor's page for another cursor", async () => {
    const cursors: (string | undefined)[] = [];
    const cached = new CachingPortalOrderSource({
      listOrders: async (_scope, q) => {
        cursors.push(q.cursor);
        return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      getOrder: async () => null,
    });
    await cached.listOrders(scope, { pageSize: 20 });
    await cached.listOrders(scope, { pageSize: 20, cursor: "cur-2" });
    expect(cursors).toEqual([undefined, "cur-2"]);
  });

  it("never shares one customer's page with another", async () => {
    const asked: string[] = [];
    const cached = new CachingPortalOrderSource({
      listOrders: async (s) => {
        asked.push(s.customerId);
        return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      getOrder: async () => null,
    });
    const other = { customerId: "22222222-2222-4222-8222-222222222222" } as typeof scope;
    await cached.listOrders(scope, query);
    await cached.listOrders(other, query);
    expect(asked).toEqual([LOCAL_CUSTOMER_ID, other.customerId]);
  });

  it("does NOT degrade to an empty page on failure — it rejects (§6.3 N1)", async () => {
    // An empty list would read as "you have never bought anything". Unlike
    // purchase history, this must surface as 502.
    const cached = new CachingPortalOrderSource({
      listOrders: async () => {
        throw new Error("Shopify unavailable");
      },
      getOrder: async () => null,
    });
    await expect(cached.listOrders(scope, query)).rejects.toThrow("Shopify unavailable");
  });

  it("never caches a failure", async () => {
    let reads = 0;
    const cached = new CachingPortalOrderSource({
      listOrders: async () => {
        reads += 1;
        if (reads === 1) throw new Error("transient");
        return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      getOrder: async () => null,
    });
    await expect(cached.listOrders(scope, query)).rejects.toThrow("transient");
    await expect(cached.listOrders(scope, query)).resolves.toBeDefined();
    expect(reads).toBe(2);
  });

  it("times out a slow read with the typed timeout error", async () => {
    const cached = new CachingPortalOrderSource(
      { listOrders: () => new Promise(() => {}), getOrder: async () => null },
      { timeoutMs: 5 },
    );
    await expect(cached.listOrders(scope, query)).rejects.toBeInstanceOf(ShopifyReadTimeoutError);
  });

  it("caches order detail per order, so one order never answers for another", async () => {
    const asked: string[] = [];
    const cached = new CachingPortalOrderSource({
      listOrders: async () => ({ orders: [], pageInfo: { hasNextPage: false, endCursor: null } }),
      getOrder: async (_scope, reference) => {
        asked.push(reference);
        return null;
      },
    });
    await cached.getOrder(scope, "1");
    await cached.getOrder(scope, "2");
    await cached.getOrder(scope, "1");
    expect(asked).toEqual(["1", "2"]);
  });
});

/* ========================================================================== *
 * 3 — the routes, end to end
 * ========================================================================== */

interface AppOptions {
  transport?: ScopedGraphqlTransport;
  lookup?: ShopifyCustomerIdLookup;
  orderSource?: PortalOrderSource;
}

function buildOrdersApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  const source =
    options.orderSource ??
    new ShopifyPortalOrderSource({
      transport: options.transport ?? new FakeAdminTransport(pagedReply([orderNode()])),
      lookup: options.lookup ?? new FakeLookup(),
    });
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    portalOrderSource: source,
  });
  return app;
}

const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };

function signedQuery(params: QueryParams): string {
  const signable = { timestamp: String(Math.floor(Date.now() / 1000)), ...params };
  const withSig = { ...signable, signature: computeAppProxySignature(signable, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withSig)) {
    if (typeof value === "string") search.set(key, value);
  }
  return search.toString();
}

describe("GET /v1/orders (N1)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("returns the N1 body: orders + pageInfo (Req 6.1/6.2)", async () => {
    app = buildOrdersApp({
      transport: new FakeAdminTransport(pagedReply([orderNode()], true, "cur-2")),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pageInfo).toEqual({ hasNextPage: true, endCursor: "cur-2" });
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({
      id: ORDER_ID,
      name: "#1042",
      processedAt: "2026-07-14T10:02:11Z",
      financialStatus: "PAID",
      fulfilmentStatus: "FULFILLED",
      // `184.0` upstream, normalised to two fractional digits on the wire.
      totalGBP: "184.00",
      currencyCode: "GBP",
      lineItemCount: 1,
    });
  });

  it("returns intrinsic image dimensions on preview rows (Req 18.5)", async () => {
    app = buildOrdersApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(res.json().orders[0].previewLineItems[0]).toEqual({
      title: "Oud Royale 50ml",
      quantity: 1,
      imageUrl: "https://cdn/oud.jpg",
      imageWidth: 800,
      imageHeight: 800,
    });
  });

  it("CAPS pageSize=100 at 20 and answers 200, not 400 (Req 6.12, §7.3)", async () => {
    let requestedPageSize: unknown;
    app = buildOrdersApp({
      transport: new FakeAdminTransport((variables) => {
        requestedPageSize = variables.pageSize;
        return { customer: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      }),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders?pageSize=100", headers: AUTH });
    expect(res.statusCode).toBe(200);
    // Capped BEFORE it reached Shopify, not merely trimmed afterwards.
    expect(requestedPageSize).toBe(20);
  });

  it("rejects a non-positive or non-numeric pageSize with 400 invalid_request", async () => {
    app = buildOrdersApp();
    await app.ready();
    for (const bad of ["0", "-5", "abc"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/orders?pageSize=${bad}`,
        headers: AUTH,
      });
      expect(res.statusCode, `pageSize=${bad}`).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    }
  });

  it("forwards the cursor so 'show earlier orders' appends (§7.3)", async () => {
    let seenCursor: unknown = "unset";
    app = buildOrdersApp({
      transport: new FakeAdminTransport((variables) => {
        seenCursor = variables.cursor;
        return { customer: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      }),
    });
    await app.ready();
    await app.inject({ method: "GET", url: "/v1/orders?cursor=cur-1", headers: AUTH });
    expect(seenCursor).toBe("cur-1");
  });

  it("returns an empty page for a customer with no orders, not an error (Req 6.11)", async () => {
    app = buildOrdersApp({ transport: new FakeAdminTransport(pagedReply([])) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      orders: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
  });

  it("answers 502 upstream_unavailable when Shopify is unreachable (§6.3 N1)", async () => {
    app = buildOrdersApp({ transport: new ThrowingTransport(
        new ShopifyAdminRequestError("Shopify Admin API request failed to send."),
      ) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    // 502, DISTINCT from 500, so the client shows its Orders degraded state
    // rather than guessing from a generic server error.
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
  });

  it("answers 502 — never an empty page — when the Shopify read times out (§7.6)", async () => {
    app = buildOrdersApp({
      orderSource: new CachingPortalOrderSource(
        {
          listOrders: () => new Promise(() => {}),
          getOrder: () => new Promise(() => {}),
        },
        { timeoutMs: 5 },
      ),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
    // The distinction that matters: an empty list would have been a lie.
    expect(res.json().orders).toBeUndefined();
  });

  it("leaks no upstream detail in the 502 body (Req 2.7)", async () => {
    app = buildOrdersApp({
      transport: new ThrowingTransport(
        new ShopifyAdminRequestError("connect ECONNREFUSED 10.0.0.7:443"),
      ),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("10.0.0.7");
    expect(res.body).not.toContain("stack");
  });

  it("requires an identity — an unauthenticated request is 401, not an empty page", async () => {
    app = buildOrdersApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders" });
    expect(res.statusCode).toBe(401);
  });

  it("is identical over App Proxy and over a bearer token (Req 6.7, 9.2/9.3)", async () => {
    app = buildOrdersApp();
    await app.ready();
    const viaToken = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    const viaProxy = await app.inject({
      method: "GET",
      url: `/v1/orders?${signedQuery({
        shop: "myathoorlondon.myshopify.com",
        logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
        path_prefix: "/apps/loyalty",
      })}`,
    });
    expect(viaProxy.statusCode).toBe(200);
    expect(viaProxy.json()).toEqual(viaToken.json());
  });
});

describe("GET /v1/orders/:orderId (N2)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("returns line items, address, fulfilments and the four money fields (Req 6.3)", async () => {
    app = buildOrdersApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: ORDER_ID,
      name: "#1042",
      subtotalGBP: "165.60",
      shippingGBP: "4.95",
      taxGBP: "13.45",
      totalGBP: "184.00",
    });
    expect(body.shippingAddress).toMatchObject({ city: "London", countryCode: "GB" });
    expect(body.lineItems).toHaveLength(1);
    expect(body.lineItems[0]).toMatchObject({
      title: "Oud Royale 50ml",
      quantity: 1,
      originalUnitPriceGBP: "184.00",
      discountedTotalGBP: "165.60",
      productId: "4400",
      variantId: "4477",
      productHandle: "oud-royale",
      available: true,
      imageWidth: 800,
      imageHeight: 800,
    });
  });

  it("presents tracking when Shopify supplies it (Req 6.4)", async () => {
    app = buildOrdersApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.json().fulfilments).toEqual([
      {
        status: "DELIVERED",
        trackingCompany: "Royal Mail",
        trackingNumber: "AB123",
        trackingUrl: "https://track/AB123",
      },
    ]);
  });

  it("presents the state with NO tracking control when trackingInfo is empty (Req 6.5)", async () => {
    app = buildOrdersApp({
      transport: new FakeAdminTransport(
        pagedReply([
          orderNode({
            fulfillments: [{ status: "SUCCESS", displayStatus: "FULFILLED", trackingInfo: [] }],
          }),
        ]),
      ),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.json().fulfilments).toEqual([
      {
        status: "FULFILLED",
        trackingCompany: null,
        trackingNumber: null,
        trackingUrl: null,
      },
    ]);
  });

  it("never synthesises a carrier URL from a tracking number (§7.4)", async () => {
    app = buildOrdersApp({
      transport: new FakeAdminTransport(
        pagedReply([
          orderNode({
            fulfillments: [
              {
                status: "SUCCESS",
                displayStatus: "IN_TRANSIT",
                trackingInfo: [{ company: "Royal Mail", number: "AB123", url: null }],
              },
            ],
          }),
        ]),
      ),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    const [fulfilment] = res.json().fulfilments;
    expect(fulfilment.trackingNumber).toBe("AB123");
    expect(fulfilment.trackingUrl).toBeNull();
  });

  it("renders an OUT-OF-STOCK line with a link and Buy Again disabled (§7.5 row 2)", async () => {
    app = buildOrdersApp({
      transport: new FakeAdminTransport(
        pagedReply([
          orderNode({
            lineItems: {
              nodes: [
                {
                  ...orderNode().lineItems.nodes[0],
                  variant: { id: "gid://shopify/ProductVariant/4477", availableForSale: false },
                },
              ],
            },
          }),
        ]),
      ),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.json().lineItems[0]).toMatchObject({
      productId: "4400",
      productHandle: "oud-royale",
      available: false,
      title: "Oud Royale 50ml",
      originalUnitPriceGBP: "184.00",
    });
  });

  it("renders an UNPUBLISHED line with recorded title and price and NO link (§7.5 row 3, Req 6.9)", async () => {
    app = buildOrdersApp({
      transport: new FakeAdminTransport(
        pagedReply([
          orderNode({
            lineItems: {
              nodes: [
                {
                  ...orderNode().lineItems.nodes[0],
                  product: { ...PUBLISHED_PRODUCT, publishedAt: null },
                },
              ],
            },
          }),
        ]),
      ),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.json().lineItems[0]).toMatchObject({
      productId: "4400",
      productHandle: null,
      available: false,
      title: "Oud Royale 50ml",
      originalUnitPriceGBP: "184.00",
      discountedTotalGBP: "165.60",
    });
  });

  it("renders a DELETED line with recorded title and price and no ids (§7.5 row 4, Req 6.9)", async () => {
    app = buildOrdersApp({
      transport: new FakeAdminTransport(
        pagedReply([
          orderNode({
            lineItems: {
              nodes: [
                {
                  ...orderNode().lineItems.nodes[0],
                  product: null,
                  variant: null,
                },
              ],
            },
          }),
        ]),
      ),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.json().lineItems[0]).toMatchObject({
      productId: null,
      variantId: null,
      productHandle: null,
      available: false,
      title: "Oud Royale 50ml",
      originalUnitPriceGBP: "184.00",
    });
  });

  it("answers 404 order_not_found for an order outside this customer's connection", async () => {
    // The order exists in the shop; it is simply not in THIS customer's `orders`
    // connection, so the traversal cannot reach it (§4.5 row 6).
    app = buildOrdersApp({ transport: new FakeAdminTransport(pagedReply([orderNode()])) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders/7777777777", headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("order_not_found");
  });

  it("puts NO order attribute in the 404 body (§4.5 row 6, Req 2.2/2.3)", async () => {
    app = buildOrdersApp({ transport: new FakeAdminTransport(pagedReply([])) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders/7777777777", headers: AUTH });
    const body = res.json() as Record<string, unknown>;
    // The body describes nothing about the resource — not its existence, not its
    // owner, not its id.
    expect(Object.keys(body).sort()).toEqual(["apiVersion", "error", "message"]);
    for (const forbidden of ["id", "name", "order", "lineItems", "totalGBP", "customerId"]) {
      expect(body[forbidden], `404 body must not carry ${forbidden}`).toBeUndefined();
    }
    expect(JSON.stringify(body)).not.toContain("7777777777");
  });

  it("answers byte-identically for a nonexistent id and a foreign one (§4.5 row 14)", async () => {
    app = buildOrdersApp({ transport: new FakeAdminTransport(pagedReply([orderNode()])) });
    await app.ready();
    const nonexistent = await app.inject({ method: "GET", url: "/v1/orders/1", headers: AUTH });
    const foreign = await app.inject({ method: "GET", url: "/v1/orders/7777777777", headers: AUTH });
    expect(nonexistent.statusCode).toBe(foreign.statusCode);
    expect(nonexistent.body).toBe(foreign.body);
  });

  it("rejects a GID-encoded path with 400 invalid_order_reference (§4.5 row 7)", async () => {
    app = buildOrdersApp();
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/orders/gid%3A%2F%2Fshopify%2FOrder%2F123",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_order_reference");
  });

  it("rejects every other malformed reference the same way", async () => {
    app = buildOrdersApp();
    await app.ready();
    for (const reference of [
      "abc",
      "12.5",
      "-1",
      "123456789012345678901",
      "1%20OR%201%3D1",
      "id%3A1",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/orders/${reference}`,
        headers: AUTH,
      });
      expect(res.statusCode, reference).toBe(400);
      expect(res.json().error, reference).toBe("invalid_order_reference");
    }
  });

  it("answers 401 BEFORE 400 for an unauthenticated malformed reference (Req 9.3)", async () => {
    // Ordering matters twice over: Req 9.3 requires rejection before any handler
    // logic, and a stranger must not learn which references are well-formed.
    app = buildOrdersApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders/not-a-number" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("identity_resolution_failed");
  });

  it("answers 502 when Shopify is unreachable", async () => {
    app = buildOrdersApp({ transport: new ThrowingTransport(new ShopifyAdminRequestError("Shopify Admin API returned HTTP 503.", { statusCode: 503 })) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
  });

  it("answers 502, not 404, when the upstream fails — 'down' must not read as 'gone'", async () => {
    app = buildOrdersApp({ transport: new ThrowingTransport(new ShopifyThrottleError("throttled")) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBe(502);
  });
});

/* ========================================================================== *
 * The failure boundary — what earns a 502 and what must stay loud
 * ========================================================================== */

describe("the 502 boundary is an allowlist, not a catch-all", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("does NOT report an internal defect as upstream_unavailable", async () => {
    // A `TypeError` in projection dressed as `502 upstream_unavailable` would be
    // rendered by the client as its designed degraded state, so the defect would
    // look HANDLED. It has to be loud instead.
    app = buildOrdersApp({
      orderSource: {
        listOrders: async () => {
          throw new TypeError("cannot read property 'shopMoney' of null");
        },
        getOrder: async () => {
          throw new TypeError("cannot read property 'shopMoney' of null");
        },
      },
    });
    await app.ready();
    for (const url of ["/v1/orders", `/v1/orders/${ORDER_ID}`]) {
      const res = await app.inject({ method: "GET", url, headers: AUTH });
      expect(res.statusCode, url).toBe(500);
      expect(res.json().error, url).not.toBe("upstream_unavailable");
    }
  });

  it("does NOT report an unscoped-document rejection as upstream_unavailable", async () => {
    // A document that would have left the customer traversal is refused before any
    // request is made. It is a security-relevant defect in this codebase, not an
    // upstream outage.
    const { UnscopedShopifyQueryError } = await import("../portal/repository/shopifyScope.js");
    app = buildOrdersApp({
      orderSource: {
        listOrders: async () => {
          throw new UnscopedShopifyQueryError("forbidden_root_field");
        },
        getOrder: async () => null,
      },
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(res.statusCode).toBe(500);
  });

  it("reports every genuine Shopify failure mode as 502", async () => {
    for (const failure of [
      new ShopifyAdminRequestError("Shopify Admin API returned HTTP 500.", { statusCode: 500 }),
      new ShopifyThrottleError("throttled"),
      new ShopifyReadTimeoutError("orders list read", 2500),
    ]) {
      const local = buildOrdersApp({
        orderSource: {
          listOrders: async () => {
            throw failure;
          },
          getOrder: async () => null,
        },
      });
      await local.ready();
      const res = await local.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
      expect(res.statusCode, failure.name).toBe(502);
      expect(res.json().error, failure.name).toBe("upstream_unavailable");
      await local.close();
    }
  });
});

describe("an un-wired build refuses rather than reporting an empty history", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("answers 502, NOT 200 with an empty page, when no source is configured", async () => {
    // THE POINT: an empty orders list is not fail-closed. It says "you have never
    // bought anything" to a customer whose receipts say otherwise — the one
    // falsehood §6.3 N1's dedicated 502 exists to avoid. Every other `/v1` read
    // may default to empty; this one may not.
    app = Fastify({ logger: false });
    registerVersioning(app);
    app.register(v1Routes, {
      prefix: "/v1",
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
      appProxySecret: APP_PROXY_SECRET,
      // portalOrderSource deliberately omitted — the production shape when no
      // Shopify Admin token is configured.
    });
    await app.ready();

    const list = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(list.statusCode).toBe(502);
    expect(list.json().error).toBe("upstream_unavailable");
    expect(list.json().orders).toBeUndefined();

    const detail = await app.inject({
      method: "GET",
      url: `/v1/orders/${ORDER_ID}`,
      headers: AUTH,
    });
    expect(detail.statusCode).toBe(502);
    expect(detail.json().error).toBe("upstream_unavailable");
  });

  it("keeps the in-memory source available as an explicit test double", async () => {
    // It is no longer the default, but it must still work when a caller asks for
    // it — local runs and the route tests depend on it.
    const source = new InMemoryPortalOrderSource();
    source.set(LOCAL_CUSTOMER_ID, []);
    app = buildOrdersApp({ orderSource: source });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().orders).toEqual([]);
  });

  it("the unconfigured source refuses both reads", async () => {
    const source = new UnconfiguredPortalOrderSource();
    const scope = { customerId: LOCAL_CUSTOMER_ID } as unknown as Parameters<
      PortalOrderSource["listOrders"]
    >[0];
    await expect(source.listOrders(scope, { pageSize: 20 })).rejects.toThrow();
    await expect(source.getOrder(scope, ORDER_ID)).rejects.toThrow();
  });
});

/* ========================================================================== *
 * The composition production actually builds
 * ========================================================================== */

describe("the production composition — caching over the Shopify source", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("serves both endpoints and issues ONE Shopify read per repeated request", async () => {
    // `index.ts` builds `CachingPortalOrderSource` over `ShopifyPortalOrderSource`;
    // the other route tests wire the Shopify source alone, so nothing else
    // exercises the pair as deployed.
    const transport = new FakeAdminTransport(pagedReply([orderNode()]));
    app = buildOrdersApp({
      orderSource: new CachingPortalOrderSource(
        new ShopifyPortalOrderSource({ transport, lookup: new FakeLookup() }),
      ),
    });
    await app.ready();

    const first = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    const second = await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(transport.requests).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/orders/${ORDER_ID}`,
      headers: AUTH,
    });
    expect(detail.statusCode).toBe(200);
    // The detail read is a different key, so it is a second Shopify request.
    expect(transport.requests).toBe(2);
  });

  it("caches a 404 for the TTL, which is worth knowing about", async () => {
    // An absent order stays absent, so caching `null` is correct for the ordinary
    // case. The honest cost: an order Shopify has not yet made visible to the
    // Admin API reads as `404` for up to the TTL rather than appearing on the next
    // refresh. Pinned so the trade is visible rather than discovered later.
    const transport = new FakeAdminTransport(pagedReply([]));
    app = buildOrdersApp({
      orderSource: new CachingPortalOrderSource(
        new ShopifyPortalOrderSource({ transport, lookup: new FakeLookup() }),
      ),
    });
    await app.ready();
    const first = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    const second = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(first.statusCode).toBe(404);
    expect(second.statusCode).toBe(404);
    expect(transport.requests).toBe(1);
  });
});

/* ========================================================================== *
 * The 502 log line (§24.3)
 * ========================================================================== */

describe("the 502 log line carries no forbidden value (§24.3, Req 2.8)", () => {
  it("names the failure and the upstream, and neither the order number nor the customer", async () => {
    // The route's own log call is the one thing `logCapture.gate.test.ts` cannot
    // reach with the default in-memory source, so it is asserted here — through
    // the REAL redacting logger `buildApp` installs, not a reimplementation of it.
    const lines: string[] = [];
    const config = loadConfig({
      NODE_ENV: "test",
      SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET,
    } as NodeJS.ProcessEnv);
    const app = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
      portalOrderSource: new ShopifyPortalOrderSource({
        transport: new ThrowingTransport(
          new ShopifyAdminRequestError("ECONNRESET 10.0.0.7:443"),
        ),
        lookup: new FakeLookup(),
      }),
      logDestination: { write: (line: string) => lines.push(line) },
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: `/v1/orders/${ORDER_ID}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(502);

      const output = lines.join("\n");
      // The gate would be vacuous if nothing were captured.
      expect(output).toContain("upstream_unavailable");
      expect(output).toContain("shopify");
      // §24.3 names an order number and a full customer identifier among the
      // values never to log.
      expect(output).not.toContain(ORDER_ID);
      expect(output).not.toContain(LOCAL_CUSTOMER_ID);
      expect(output).not.toContain(SHOPIFY_CUSTOMER_ID);
      // Nor the upstream's own diagnostic text.
      expect(output).not.toContain("10.0.0.7");
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== *
 * Nothing is persisted (Req 3.3, §7.1)
 * ========================================================================== */

/** A `Queryable` that records every statement and connects to nothing. */
class RecordingDb implements Queryable {
  readonly statements: string[] = [];
  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
  ): Promise<QueryResult<R>> {
    this.statements.push(queryText);
    return {
      rows: [{ shopify_customer_id: SHOPIFY_CUSTOMER_ID } as unknown as R],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    };
  }
}

describe("no order data is written to Postgres (Req 3.3, §7.1)", () => {
  let app: FastifyInstance;
  let db: RecordingDb;

  beforeEach(async () => {
    db = new RecordingDb();
    app = buildOrdersApp({
      transport: new FakeAdminTransport(pagedReply([orderNode()], true, "cur-2")),
      lookup: new PgShopifyCustomerIdLookup(db),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("issues only read-only SELECTs across BOTH endpoints", async () => {
    await app.inject({ method: "GET", url: "/v1/orders", headers: AUTH });
    await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });

    expect(db.statements.length).toBeGreaterThan(0);
    for (const statement of db.statements) {
      expect(statement.trim()).toMatch(/^SELECT\b/i);
      for (const write of [
        /\bINSERT\b/i,
        /\bUPDATE\b/i,
        /\bDELETE\b/i,
        /\bCREATE\b/i,
        /\bON\s+CONFLICT\b/i,
        /\bMERGE\b/i,
      ]) {
        expect(write.test(statement), `statement must not write: ${statement}`).toBe(false);
      }
    }
  });

  it("touches only the customers table — no order-shaped table is read or written", async () => {
    await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(db.statements).toHaveLength(1);
    // The only Postgres access on this path is the identity lookup §7.2 shows.
    expect(db.statements[0]).toContain("FROM customers");
    // No order table exists to write to, and none is invented here.
    expect(db.statements[0]?.toLowerCase()).not.toContain("order");
  });

  it("stores nothing even after a successful read of a full order", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/orders/${ORDER_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    // The response carries line items, totals and fulfilment state — exactly the
    // three things Req 3.3 forbids copying — and the statement log proves none of
    // them was written.
    expect(res.json().lineItems).toHaveLength(1);
    expect(db.statements.every((s) => /^\s*SELECT\b/i.test(s))).toBe(true);
  });
});
