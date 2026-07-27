/**
 * Purchased fragrances from paid Shopify orders (task 44) — Req 17.1, 17.6, 17.9,
 * 17.10, 13.2.
 *
 * Every test drives the REAL client against an injected `fetch`, so the GraphQL
 * shape, the pagination, the inclusion predicate and the projection are all the
 * shipped ones. No network, no Postgres, no Shopify.
 *
 * The inclusion rules are NOT restated here as expectations of their own: they are
 * asserted to match the migration client's exported predicate, because the point
 * of reusing it is that a customer's tier and their purchase history can never
 * disagree about whether an order counted.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CachingPurchaseHistorySource,
  DEFAULT_LINE_ITEM_PAGE_SIZE,
  PgShopifyCustomerIdLookup,
  PURCHASE_HISTORY_QUERY,
  ORDER_LINE_ITEM_PRODUCTS_QUERY,
  ShopifyGraphqlPurchaseHistorySource,
  productIdFromGid,
  type ShopifyCustomerIdLookup,
} from "./purchaseHistory.js";
import {
  DEFAULT_ACCEPTED_FINANCIAL_STATUSES,
  orderCountsTowardsSpend,
} from "../migration/migrationShopifyClient.js";
import type { PurchasedFragrance, ShopifyFragranceSource } from "../profile/fragranceProfile.js";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";

const SHOP = "athoor-loyalty-staging.myshopify.com";
const TOKEN = "shpua_test_token";
const LOCAL_ID = "11111111-1111-4111-8111-111111111111";
const SHOPIFY_ID = "9000000000001";

const lookup: ShopifyCustomerIdLookup = {
  findShopifyCustomerId: async (id) => (id === LOCAL_ID ? SHOPIFY_ID : null),
};

const product = (id: string, title: string) => ({
  product: { id: `gid://shopify/Product/${id}`, title },
});

interface OrderFixture {
  id?: string;
  status?: string;
  cancelledAt?: string | null;
  test?: boolean;
  processedAt?: string | null;
  createdAt?: string | null;
  products?: Array<{ product: { id: string; title: string | null } | null }>;
  lineItemsHasNextPage?: boolean;
}

function order(fixture: OrderFixture = {}) {
  return {
    id: fixture.id ?? "gid://shopify/Order/1",
    test: fixture.test ?? false,
    cancelledAt: fixture.cancelledAt ?? null,
    displayFinancialStatus: fixture.status ?? "PAID",
    // `??` would swallow an explicit null, which is exactly what the
    // processedAt-absent case needs to express.
    processedAt: "processedAt" in fixture ? fixture.processedAt : "2026-05-01T10:00:00Z",
    createdAt: "createdAt" in fixture ? fixture.createdAt : "2026-05-01T09:00:00Z",
    lineItems: {
      pageInfo: {
        hasNextPage: fixture.lineItemsHasNextPage ?? false,
        endCursor: fixture.lineItemsHasNextPage ? "li-cursor" : null,
      },
      nodes: fixture.products ?? [product("111", "Athoor Oud")],
    },
  };
}

/** An injected fetch that answers each query from a scripted list of responses. */
function fetchStub(pages: Array<{ orders?: unknown; lineItems?: unknown }>): {
  impl: unknown;
  calls: string[];
} {
  const calls: string[] = [];
  let orderPage = 0;
  let lineItemPage = 0;
  const impl = async (_url: string, init: { body?: unknown }) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body.query.includes("profileOrderLineItemProducts") ? "lineItems" : "orders");
    const page = body.query.includes("profileOrderLineItemProducts")
      ? pages.filter((p) => p.lineItems)[lineItemPage++]
      : pages.filter((p) => p.orders)[orderPage++];
    const data = body.query.includes("profileOrderLineItemProducts")
      ? { order: page?.lineItems }
      : { customer: page?.orders === undefined ? null : { id: "gid", orders: page.orders } };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data }),
    };
  };
  return { impl: impl as never, calls };
}

function source(
  pages: Array<{ orders?: unknown; lineItems?: unknown }>,
  options: Parameters<typeof ShopifyGraphqlPurchaseHistorySource.prototype.constructor>[4] = {},
) {
  const stub = fetchStub(pages);
  const client = new ShopifyGraphqlPurchaseHistorySource(
    SHOP,
    TOKEN,
    lookup,
    stub.impl as never,
    { ...(options as object), sleep: async () => {} },
  );
  return { client, stub };
}

const ordersPage = (
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({ orders: { pageInfo: { hasNextPage, endCursor }, nodes } });

describe("ShopifyGraphqlPurchaseHistorySource", () => {
  it("returns the products from a paid order (Req 17.1)", async () => {
    const { client } = source([ordersPage([order()])]);

    const purchased = await client.getPurchasedFragrances(LOCAL_ID);

    expect(purchased).toEqual<PurchasedFragrance[]>([
      {
        productId: "111",
        title: "Athoor Oud",
        firstPurchasedAt: "2026-05-01T10:00:00Z",
        lastPurchasedAt: "2026-05-01T10:00:00Z",
        purchaseCount: 1,
      },
    ]);
  });

  it("counts repeat purchases and tracks the first and last dates", async () => {
    const { client } = source([
      ordersPage([
        order({ id: "gid://shopify/Order/1", processedAt: "2026-01-01T00:00:00Z" }),
        order({ id: "gid://shopify/Order/2", processedAt: "2026-06-01T00:00:00Z" }),
      ]),
    ]);

    const [entry] = await client.getPurchasedFragrances(LOCAL_ID);

    expect(entry).toMatchObject({
      productId: "111",
      purchaseCount: 2,
      firstPurchasedAt: "2026-01-01T00:00:00Z",
      lastPurchasedAt: "2026-06-01T00:00:00Z",
    });
  });

  it("orders results most-recently-purchased first, with a stable tie-break", async () => {
    const { client } = source([
      ordersPage([
        order({
          id: "gid://shopify/Order/1",
          processedAt: "2026-01-01T00:00:00Z",
          products: [product("222", "Older")],
        }),
        order({
          id: "gid://shopify/Order/2",
          processedAt: "2026-06-01T00:00:00Z",
          products: [product("333", "Newer"), product("111", "Same order")],
        }),
      ]),
    ]);

    const ids = (await client.getPurchasedFragrances(LOCAL_ID)).map((p) => p.productId);

    // Both from order 2 share a timestamp, so they tie-break on product id.
    expect(ids).toEqual(["111", "333", "222"]);
  });

  it("uses the MIGRATION CLIENT'S predicate, so inclusion cannot drift", async () => {
    // Not a restatement of the rules: this pins that the same function decides.
    const policy = {
      acceptedStatuses: new Set(DEFAULT_ACCEPTED_FINANCIAL_STATUSES.map((s) => s.toUpperCase())),
      includeCancelledOrders: false,
      includeTestOrders: false,
    };
    const cases = [
      { status: "PAID", cancelledAt: null, test: false },
      { status: "REFUNDED", cancelledAt: null, test: false },
      { status: "PARTIALLY_REFUNDED", cancelledAt: null, test: false },
      { status: "PENDING", cancelledAt: null, test: false },
      { status: "VOIDED", cancelledAt: null, test: false },
      { status: "PAID", cancelledAt: "2026-05-02T00:00:00Z", test: false },
      { status: "PAID", cancelledAt: null, test: true },
    ];

    for (const [index, c] of cases.entries()) {
      const { client } = source([
        ordersPage([
          order({
            id: `gid://shopify/Order/${index}`,
            status: c.status,
            cancelledAt: c.cancelledAt,
            test: c.test,
          }),
        ]),
      ]);
      const purchased = await client.getPurchasedFragrances(LOCAL_ID);
      const expected = orderCountsTowardsSpend(
        { id: "x", test: c.test, cancelledAt: c.cancelledAt, displayFinancialStatus: c.status },
        policy,
      );
      expect(purchased.length > 0).toBe(expected);
    }
  });

  it("paginates orders", async () => {
    const { client, stub } = source([
      ordersPage([order({ id: "gid://shopify/Order/1", products: [product("111", "A")] })], true, "c1"),
      ordersPage([order({ id: "gid://shopify/Order/2", products: [product("222", "B")] })]),
    ]);

    const ids = (await client.getPurchasedFragrances(LOCAL_ID)).map((p) => p.productId).sort();

    expect(ids).toEqual(["111", "222"]);
    expect(stub.calls.filter((c) => c === "orders")).toHaveLength(2);
  });

  it("paginates line items so a large order is never silently truncated", async () => {
    const { client, stub } = source([
      ordersPage([
        order({
          id: "gid://shopify/Order/1",
          products: [product("111", "A")],
          lineItemsHasNextPage: true,
        }),
      ]),
      {
        lineItems: {
          id: "gid://shopify/Order/1",
          lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [product("222", "B")] },
        },
      },
    ]);

    const ids = (await client.getPurchasedFragrances(LOCAL_ID)).map((p) => p.productId).sort();

    expect(ids).toEqual(["111", "222"]);
    expect(stub.calls).toContain("lineItems");
  });

  it("skips a line item whose product was deleted rather than guessing", async () => {
    const { client } = source([
      ordersPage([order({ products: [{ product: null }, product("111", "Kept")] })]),
    ]);

    const purchased = await client.getPurchasedFragrances(LOCAL_ID);

    expect(purchased.map((p) => p.productId)).toEqual(["111"]);
  });

  it("returns empty (never an error) for an unknown local customer (Req 17.9)", async () => {
    const { client, stub } = source([ordersPage([order()])]);

    await expect(client.getPurchasedFragrances("no-such-customer")).resolves.toEqual([]);
    // No Shopify call is made at all when the id cannot be resolved.
    expect(stub.calls).toEqual([]);
  });

  it("returns empty when Shopify cannot see the customer", async () => {
    const { client } = source([{ orders: undefined }]);

    await expect(client.getPurchasedFragrances(LOCAL_ID)).resolves.toEqual([]);
  });

  it("falls back to createdAt when processedAt is absent", async () => {
    const { client } = source([
      ordersPage([order({ processedAt: null, createdAt: "2026-02-02T00:00:00Z" })]),
    ]);

    const [entry] = await client.getPurchasedFragrances(LOCAL_ID);

    expect(entry!.firstPurchasedAt).toBe("2026-02-02T00:00:00Z");
  });

  it("is read-only: its runtime method surface is exactly getPurchasedFragrances", () => {
    const { client } = source([]);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter(
      (name) => name !== "constructor" && typeof (client as never as Record<string, unknown>)[name] === "function",
    );
    // Private helpers are prototype methods too, so assert no MUTATION verb exists.
    expect(methods).toContain("getPurchasedFragrances");
    for (const name of methods) {
      expect(name).not.toMatch(/create|update|delete|write|set|mutate/i);
    }
  });

  it("requests no money fields — this path cannot influence a balance", () => {
    expect(PURCHASE_HISTORY_QUERY).not.toMatch(/PriceSet|DiscountsSet|amount/);
    expect(ORDER_LINE_ITEM_PRODUCTS_QUERY).not.toMatch(/PriceSet|amount/);
    // And it contains no mutation.
    expect(PURCHASE_HISTORY_QUERY).not.toMatch(/mutation/);
    expect(DEFAULT_LINE_ITEM_PAGE_SIZE).toBeGreaterThan(0);
  });
});

describe("productIdFromGid", () => {
  it("extracts the numeric id and rejects anything else", () => {
    expect(productIdFromGid("gid://shopify/Product/8828510306503")).toBe("8828510306503");
    expect(productIdFromGid("nonsense")).toBeNull();
  });
});

describe("PgShopifyCustomerIdLookup", () => {
  it("returns the numeric Shopify id, or null for an unknown customer", async () => {
    const db: Queryable = {
      query: async <R extends QueryResultRow>(_t: string, values?: unknown[]) => {
        const rows = values?.[0] === LOCAL_ID ? [{ shopify_customer_id: SHOPIFY_ID }] : [];
        return { rows: rows as R[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<R>;
      },
    };
    const lookupUnderTest = new PgShopifyCustomerIdLookup(db);

    await expect(lookupUnderTest.findShopifyCustomerId(LOCAL_ID)).resolves.toBe(SHOPIFY_ID);
    await expect(lookupUnderTest.findShopifyCustomerId("other")).resolves.toBeNull();
  });
});

describe("CachingPurchaseHistorySource", () => {
  const entry: PurchasedFragrance = {
    productId: "111",
    title: "A",
    firstPurchasedAt: null,
    lastPurchasedAt: null,
    purchaseCount: 1,
  };

  it("reuses a resolved result within the TTL and re-reads after it", async () => {
    let calls = 0;
    let nowMs = 1_000;
    const inner: ShopifyFragranceSource = {
      getPurchasedFragrances: async () => {
        calls += 1;
        return [entry];
      },
    };
    const cached = new CachingPurchaseHistorySource(inner, { ttlMs: 1_000, now: () => nowMs });

    await cached.getPurchasedFragrances(LOCAL_ID);
    await cached.getPurchasedFragrances(LOCAL_ID);
    expect(calls).toBe(1);

    nowMs += 1_001;
    await cached.getPurchasedFragrances(LOCAL_ID);
    expect(calls).toBe(2);
  });

  it("degrades to empty on failure, reports it, and does NOT cache the failure", async () => {
    let calls = 0;
    const inner: ShopifyFragranceSource = {
      getPurchasedFragrances: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Shopify unavailable");
        return [entry];
      },
    };
    const onDegraded = vi.fn();
    const cached = new CachingPurchaseHistorySource(inner, { onDegraded });

    await expect(cached.getPurchasedFragrances(LOCAL_ID)).resolves.toEqual([]);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    // A transient failure must not pin an empty history for the whole TTL.
    await expect(cached.getPurchasedFragrances(LOCAL_ID)).resolves.toEqual([entry]);
  });

  it("times out a slow read rather than blowing the profile's 3s budget", async () => {
    const inner: ShopifyFragranceSource = {
      getPurchasedFragrances: () => new Promise(() => {}), // never settles
    };
    const onDegraded = vi.fn();
    const cached = new CachingPurchaseHistorySource(inner, { timeoutMs: 10, onDegraded });

    await expect(cached.getPurchasedFragrances(LOCAL_ID)).resolves.toEqual([]);
    expect(onDegraded.mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining("exceeded") });
  });

  it("caches per customer, never sharing one member's purchases with another", async () => {
    const inner: ShopifyFragranceSource = {
      getPurchasedFragrances: async (id) => [{ ...entry, productId: `p-${id}` }],
    };
    const cached = new CachingPurchaseHistorySource(inner);

    const a = await cached.getPurchasedFragrances("customer-a");
    const b = await cached.getPurchasedFragrances("customer-b");

    expect(a[0]!.productId).toBe("p-customer-a");
    expect(b[0]!.productId).toBe("p-customer-b");
  });

  it("evicts the oldest entries so the cache cannot grow without bound", async () => {
    const inner: ShopifyFragranceSource = { getPurchasedFragrances: async () => [entry] };
    const cached = new CachingPurchaseHistorySource(inner, { maxEntries: 2 });

    for (const id of ["a", "b", "c"]) {
      await cached.getPurchasedFragrances(id);
    }

    // `a` was evicted, so reading it again calls through.
    let calls = 0;
    const counting = new CachingPurchaseHistorySource(
      {
        getPurchasedFragrances: async () => {
          calls += 1;
          return [entry];
        },
      },
      { maxEntries: 2 },
    );
    for (const id of ["a", "b", "c", "a"]) {
      await counting.getPurchasedFragrances(id);
    }
    expect(calls).toBe(4);
  });
});

describe("CachingPurchaseHistorySource — concurrent coalescing", () => {
  const entry: PurchasedFragrance = {
    productId: "111",
    title: "A",
    firstPurchasedAt: null,
    lastPurchasedAt: null,
    purchaseCount: 1,
  };

  it("collapses concurrent asks for the same customer into ONE read", async () => {
    let calls = 0;
    let release: (v: readonly PurchasedFragrance[]) => void = () => {};
    const inner: ShopifyFragranceSource = {
      getPurchasedFragrances: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const cached = new CachingPurchaseHistorySource(inner);

    const both = Promise.all([
      cached.getPurchasedFragrances(LOCAL_ID),
      cached.getPurchasedFragrances(LOCAL_ID),
    ]);
    release([entry]);
    const [a, b] = await both;

    // The profile composition asks twice, concurrently, per request.
    expect(calls).toBe(1);
    expect(a).toEqual([entry]);
    expect(b).toEqual([entry]);
  });

  it("does not coalesce across DIFFERENT customers", async () => {
    const seen: string[] = [];
    const inner: ShopifyFragranceSource = {
      getPurchasedFragrances: async (id) => {
        seen.push(id);
        return [entry];
      },
    };
    const cached = new CachingPurchaseHistorySource(inner);

    await Promise.all([
      cached.getPurchasedFragrances("customer-a"),
      cached.getPurchasedFragrances("customer-b"),
    ]);

    expect(seen.sort()).toEqual(["customer-a", "customer-b"]);
  });

  it("reports a shared failure ONCE, and still retries on the next request", async () => {
    let calls = 0;
    const onDegraded = vi.fn();
    const inner: ShopifyFragranceSource = {
      getPurchasedFragrances: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Shopify unavailable");
        return [entry];
      },
    };
    const cached = new CachingPurchaseHistorySource(inner, { onDegraded });

    const [a, b] = await Promise.all([
      cached.getPurchasedFragrances(LOCAL_ID),
      cached.getPurchasedFragrances(LOCAL_ID),
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(onDegraded).toHaveBeenCalledTimes(1);

    // The failure was not cached, so the next request reads again and succeeds.
    await expect(cached.getPurchasedFragrances(LOCAL_ID)).resolves.toEqual([entry]);
  });
});
