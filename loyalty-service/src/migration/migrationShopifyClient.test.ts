/**
 * Unit tests for the concrete, read-only M0 export client (task 33).
 *
 * Everything runs against an INJECTED fake `fetch` that serves a scripted
 * Shopify graph, so no test touches the network or the live store. What is
 * pinned here is exactly what the production cutover depends on:
 *
 *   - pagination across customers, metafields and orders;
 *   - VERBATIM metafield capture (the rollback anchor);
 *   - the lifetime-spend precedence chain (mirrors `deriveEligibleTotal`);
 *   - integer-pence arithmetic (no float drift across an order history);
 *   - the accepted-order policy (paid at some point, not cancelled, not test);
 *   - the currency guard firing;
 *   - throttle retry then success, and hard failure propagating immediately;
 *   - the read-only method surface (Req 14.8 structurally).
 */
import { describe, expect, it } from "vitest";
import {
  ShopifyAdminRequestError,
  type FetchLike,
  type FetchRequestInit,
  type HttpResponse,
} from "../shopify/graphqlClient.js";
import { AdminThrottleExhaustedError } from "../shopify/adminGateway.js";
import {
  MigrationCurrencyMismatchError,
  ShopifyGraphqlMigrationClient,
  amountFromPence,
  penceFromAmount,
} from "./migrationShopifyClient.js";

const SHOP = "athoor-loyalty-staging.myshopify.com";
const TOKEN = "shpua_test_token_never_logged";

/** Instant sleeper that records the backoff delays it was asked to wait. */
function recordingSleeper(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

interface Page<N> {
  nodes: N[];
  hasNextPage?: boolean;
  endCursor?: string | null;
}

function connection<N>(page: Page<N>): unknown {
  return {
    pageInfo: {
      hasNextPage: page.hasNextPage ?? false,
      endCursor: page.endCursor ?? null,
    },
    nodes: page.nodes,
  };
}

function money(amount: string | null, currencyCode = "GBP"): unknown {
  return amount === null ? null : { shopMoney: { amount, currencyCode } };
}

type Responder = (variables: Record<string, unknown>) => unknown;

/**
 * A fake `fetch` that dispatches on the GraphQL operation name and records every
 * request body, so tests can assert cursors, page sizes and that no mutation is
 * ever sent.
 */
function scriptedFetch(handlers: {
  customers?: Responder;
  metafields?: Responder;
  orders?: Responder;
  lineItems?: Responder;
  /** Statuses returned before the scripted data, e.g. [429, 429] then success. */
  statusScript?: number[];
}): {
  fetch: FetchLike;
  calls: Array<{ operation: string; variables: Record<string, unknown>; body: string }>;
} {
  const calls: Array<{ operation: string; variables: Record<string, unknown>; body: string }> = [];
  const statusScript = [...(handlers.statusScript ?? [])];

  const fetch: FetchLike = async (_url, init: FetchRequestInit) => {
    const parsed = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation =
      /query\s+(\w+)/.exec(parsed.query)?.[1] ?? /mutation\s+(\w+)/.exec(parsed.query)?.[1] ?? "?";
    calls.push({ operation, variables: parsed.variables, body: init.body });

    const scriptedStatus = statusScript.shift();
    if (scriptedStatus !== undefined && scriptedStatus !== 200) {
      const res: HttpResponse = {
        ok: false,
        status: scriptedStatus,
        headers: { get: () => null },
        text: async () => JSON.stringify({ errors: [{ message: "scripted failure" }] }),
      };
      return res;
    }

    let data: unknown;
    if (operation === "migrationListCustomers") {
      data = handlers.customers?.(parsed.variables);
    } else if (operation === "customerLoyaltyMetafields") {
      data = handlers.metafields?.(parsed.variables) ?? {
        customer: { id: parsed.variables.id, metafields: connection({ nodes: [] }) },
      };
    } else if (operation === "migrationCustomerOrders") {
      data = handlers.orders?.(parsed.variables) ?? {
        customer: { id: parsed.variables.id, orders: connection({ nodes: [] }) },
      };
    } else if (operation === "migrationOrderLineItemTotals") {
      data = handlers.lineItems?.(parsed.variables) ?? {
        order: { id: parsed.variables.id, lineItems: connection({ nodes: [] }) },
      };
    }

    const res: HttpResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data }),
    };
    return res;
  };

  return { fetch, calls };
}

/** A single-customer store with no orders and no metafields, for focused tests. */
function singleCustomer(gid = "gid://shopify/Customer/9034269556935"): Responder {
  return () => ({ customers: connection({ nodes: [{ id: gid, email: null }] }) });
}

describe("penceFromAmount / amountFromPence", () => {
  it("converts decimal-string money into integer pence", () => {
    expect(penceFromAmount("125.40")).toBe(12540);
    expect(penceFromAmount(0.07)).toBe(7);
    expect(penceFromAmount("0")).toBe(0);
  });

  it("returns null for absent or unparseable amounts", () => {
    expect(penceFromAmount(null)).toBeNull();
    expect(penceFromAmount(undefined)).toBeNull();
    expect(penceFromAmount("")).toBeNull();
    expect(penceFromAmount("not-money")).toBeNull();
  });

  it("round-trips pence back to major units", () => {
    expect(amountFromPence(3037)).toBe(30.37);
  });
});

describe("ShopifyGraphqlMigrationClient — read-only surface (Req 14.8)", () => {
  it("exposes exactly one method: listCustomersWithLoyaltyMetafields", () => {
    const { fetch } = scriptedFetch({});
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
      .filter((name) => name !== "constructor")
      .filter((name) => typeof (client as unknown as Record<string, unknown>)[name] === "function")
      .sort();

    expect(surface).toEqual(["listCustomersWithLoyaltyMetafields"]);
  });

  it("sends only GraphQL queries — never a mutation", async () => {
    const { fetch, calls } = scriptedFetch({
      customers: singleCustomer(),
      orders: (v) => ({
        customer: {
          id: v.id,
          orders: connection({
            nodes: [
              {
                id: "gid://shopify/Order/1",
                test: false,
                cancelledAt: null,
                displayFinancialStatus: "PAID",
                currentSubtotalPriceSet: null,
                subtotalPriceSet: null,
                currentTotalDiscountsSet: money("0.00"),
                totalDiscountsSet: null,
              },
            ],
          }),
        },
      }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);
    await client.listCustomersWithLoyaltyMetafields();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.body).not.toMatch(/mutation/);
      expect(call.body).toMatch(/query /);
    }
  });
});

describe("ShopifyGraphqlMigrationClient — pagination", () => {
  it("follows hasNextPage/endCursor across customer pages", async () => {
    const { fetch, calls } = scriptedFetch({
      customers: (v) =>
        v.cursor === null
          ? {
              customers: connection({
                nodes: [{ id: "gid://shopify/Customer/1", email: null }],
                hasNextPage: true,
                endCursor: "CUR-1",
              }),
            }
          : {
              customers: connection({
                nodes: [{ id: "gid://shopify/Customer/2", email: null }],
              }),
            },
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const records = await client.listCustomersWithLoyaltyMetafields();

    expect(records.map((r) => r.id)).toEqual(["1", "2"]);
    const customerCalls = calls.filter((c) => c.operation === "migrationListCustomers");
    expect(customerCalls.map((c) => c.variables.cursor)).toEqual([null, "CUR-1"]);
    expect(customerCalls[0]?.variables.pageSize).toBe(100);
  });

  it("follows metafield pages for a customer with more than one page", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer("gid://shopify/Customer/7"),
      metafields: (v) =>
        v.cursor === null
          ? {
              customer: {
                id: v.id,
                metafields: connection({
                  nodes: [
                    { namespace: "loyalty", key: "points_balance", type: "number_integer", value: "175" },
                  ],
                  hasNextPage: true,
                  endCursor: "MF-1",
                }),
              },
            }
          : {
              customer: {
                id: v.id,
                metafields: connection({
                  nodes: [{ namespace: "loyalty", key: "tier", type: "single_line_text_field", value: "bronze" }],
                }),
              },
            },
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();

    expect(record?.metafields.map((m) => m.key)).toEqual(["points_balance", "tier"]);
  });

  it("follows order pages and sums across them", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: (v) =>
        v.cursor === null
          ? {
              customer: {
                id: v.id,
                orders: connection({
                  nodes: [
                    {
                      id: "gid://shopify/Order/1",
                      test: false,
                      cancelledAt: null,
                      displayFinancialStatus: "PAID",
                      currentSubtotalPriceSet: money("10.00"),
                    },
                  ],
                  hasNextPage: true,
                  endCursor: "ORD-1",
                }),
              },
            }
          : {
              customer: {
                id: v.id,
                orders: connection({
                  nodes: [
                    {
                      id: "gid://shopify/Order/2",
                      test: false,
                      cancelledAt: null,
                      displayFinancialStatus: "PAID",
                      currentSubtotalPriceSet: money("5.50"),
                    },
                  ],
                }),
              },
            },
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();
    expect(record?.lifetimeSpendGBP).toBe(15.5);
  });

  it("refuses to continue when Shopify claims another page but returns no cursor", async () => {
    const { fetch } = scriptedFetch({
      customers: () => ({
        customers: connection({
          nodes: [{ id: "gid://shopify/Customer/1", email: null }],
          hasNextPage: true,
          endCursor: null,
        }),
      }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    await expect(client.listCustomersWithLoyaltyMetafields()).rejects.toThrow(
      /returned no cursor/,
    );
  });
});

describe("ShopifyGraphqlMigrationClient — verbatim metafield capture", () => {
  it("captures namespace, key, type and value exactly as Shopify returns them", async () => {
    const stored = [
      { namespace: "loyalty", key: "points_balance", type: "number_integer", value: "949" },
      { namespace: "loyalty", key: "activity_log", type: "json", value: '{"events":[{"p":10}]}' },
      { namespace: "loyalty", key: "referral_code", type: "single_line_text_field", value: "" },
      { namespace: "loyalty", key: "points_expiry_date", type: "date", value: null },
    ];
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      metafields: (v) => ({
        customer: { id: v.id, metafields: connection({ nodes: stored }) },
      }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();

    expect(record?.metafields).toEqual(stored);
  });

  it("requests the loyalty namespace only", async () => {
    const { fetch, calls } = scriptedFetch({ customers: singleCustomer() });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);
    await client.listCustomersWithLoyaltyMetafields();

    const mfCall = calls.find((c) => c.operation === "customerLoyaltyMetafields");
    expect(mfCall?.variables.namespace).toBe("loyalty");
  });
});

describe("ShopifyGraphqlMigrationClient — lifetime spend precedence chain", () => {
  function withOrders(nodes: unknown[]): Responder {
    return (v) => ({ customer: { id: v.id, orders: connection({ nodes }) } });
  }

  it("(1) prefers currentSubtotalPriceSet over everything else", async () => {
    const { fetch, calls } = scriptedFetch({
      customers: singleCustomer(),
      orders: withOrders([
        {
          id: "gid://shopify/Order/1",
          test: false,
          cancelledAt: null,
          displayFinancialStatus: "PAID",
          currentSubtotalPriceSet: money("40.00"),
          subtotalPriceSet: money("99.99"),
          currentTotalDiscountsSet: money("5.00"),
        },
      ]),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();
    expect(record?.lifetimeSpendGBP).toBe(40);
    // No line-item query is needed when tier 1 resolves.
    expect(calls.some((c) => c.operation === "migrationOrderLineItemTotals")).toBe(false);
  });

  it("(2) falls back to subtotalPriceSet when the current subtotal is absent", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: withOrders([
        {
          id: "gid://shopify/Order/1",
          test: false,
          cancelledAt: null,
          displayFinancialStatus: "PAID",
          currentSubtotalPriceSet: null,
          subtotalPriceSet: money("33.25"),
          currentTotalDiscountsSet: money("5.00"),
        },
      ]),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();
    expect(record?.lifetimeSpendGBP).toBe(33.25);
  });

  it("(3) computes max(0, line-item original total − discounts) when both subtotals are absent", async () => {
    const { fetch, calls } = scriptedFetch({
      customers: singleCustomer(),
      orders: withOrders([
        {
          id: "gid://shopify/Order/55",
          test: false,
          cancelledAt: null,
          displayFinancialStatus: "PAID",
          currentSubtotalPriceSet: null,
          subtotalPriceSet: null,
          currentTotalDiscountsSet: money("10.00"),
          totalDiscountsSet: money("99.00"),
        },
      ]),
      lineItems: (v) => ({
        order: {
          id: v.id,
          lineItems: connection({
            nodes: [
              { originalTotalSet: money("30.00") },
              { originalTotalSet: money("20.00") },
            ],
          }),
        },
      }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();

    // 50.00 line items − 10.00 current discounts (preferred over totalDiscountsSet).
    expect(record?.lifetimeSpendGBP).toBe(40);
    const lineItemCall = calls.find((c) => c.operation === "migrationOrderLineItemTotals");
    expect(lineItemCall?.variables.id).toBe("gid://shopify/Order/55");
  });

  it("(3) never returns a negative amount when discounts exceed the line-item total", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: withOrders([
        {
          id: "gid://shopify/Order/56",
          test: false,
          cancelledAt: null,
          displayFinancialStatus: "PAID",
          currentSubtotalPriceSet: null,
          subtotalPriceSet: null,
          currentTotalDiscountsSet: money("80.00"),
        },
      ]),
      lineItems: (v) => ({
        order: { id: v.id, lineItems: connection({ nodes: [{ originalTotalSet: money("50.00") }] }) },
      }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();
    expect(record?.lifetimeSpendGBP).toBe(0);
  });

  it("(3) paginates line items across pages", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: withOrders([
        {
          id: "gid://shopify/Order/57",
          test: false,
          cancelledAt: null,
          displayFinancialStatus: "PAID",
          currentSubtotalPriceSet: null,
          subtotalPriceSet: null,
          currentTotalDiscountsSet: money("0.00"),
        },
      ]),
      lineItems: (v) =>
        v.cursor === null
          ? {
              order: {
                id: v.id,
                lineItems: connection({
                  nodes: [{ originalTotalSet: money("1.11") }],
                  hasNextPage: true,
                  endCursor: "LI-1",
                }),
              },
            }
          : {
              order: {
                id: v.id,
                lineItems: connection({ nodes: [{ originalTotalSet: money("2.22") }] }),
              },
            },
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();
    expect(record?.lifetimeSpendGBP).toBe(3.33);
  });

  it("sums in integer pence so a float-drifting series stays exact", async () => {
    // 0.10 + 0.20 + 0.07 in floats is 0.37000000000000005; in pence it is 37.
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: withOrders(
        ["0.10", "0.20", "0.07"].map((amount, i) => ({
          id: `gid://shopify/Order/${i + 1}`,
          test: false,
          cancelledAt: null,
          displayFinancialStatus: "PAID",
          currentSubtotalPriceSet: money(amount),
        })),
      ),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();
    expect(record?.lifetimeSpendGBP).toBe(0.37);
  });

  it("reports £0.00 for a customer with no counting orders", async () => {
    const { fetch } = scriptedFetch({ customers: singleCustomer() });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const [record] = await client.listCustomersWithLoyaltyMetafields();
    expect(record?.lifetimeSpendGBP).toBe(0);
  });
});

describe("ShopifyGraphqlMigrationClient — which orders count", () => {
  function order(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "gid://shopify/Order/1",
      test: false,
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      currentSubtotalPriceSet: money("100.00"),
      ...overrides,
    };
  }

  async function spendFor(nodes: unknown[], options?: Record<string, unknown>): Promise<number> {
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: (v) => ({ customer: { id: v.id, orders: connection({ nodes }) } }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch, options ?? {});
    const [record] = await client.listCustomersWithLoyaltyMetafields();
    return record?.lifetimeSpendGBP ?? -1;
  }

  it("counts PAID, PARTIALLY_REFUNDED and REFUNDED (spend does not decrease on refund, Req 4.7)", async () => {
    const spend = await spendFor([
      order({ id: "gid://shopify/Order/1", displayFinancialStatus: "PAID" }),
      order({ id: "gid://shopify/Order/2", displayFinancialStatus: "PARTIALLY_REFUNDED" }),
      order({ id: "gid://shopify/Order/3", displayFinancialStatus: "REFUNDED" }),
    ]);
    expect(spend).toBe(300);
  });

  it("excludes statuses where payment was never captured", async () => {
    const spend = await spendFor([
      order({ id: "gid://shopify/Order/1", displayFinancialStatus: "PENDING" }),
      order({ id: "gid://shopify/Order/2", displayFinancialStatus: "AUTHORIZED" }),
      order({ id: "gid://shopify/Order/3", displayFinancialStatus: "VOIDED" }),
      order({ id: "gid://shopify/Order/4", displayFinancialStatus: "EXPIRED" }),
      order({ id: "gid://shopify/Order/5", displayFinancialStatus: null }),
    ]);
    expect(spend).toBe(0);
  });

  it("excludes cancelled orders even when they were paid", async () => {
    const spend = await spendFor([order({ cancelledAt: "2026-01-01T00:00:00Z" })]);
    expect(spend).toBe(0);
  });

  it("excludes Shopify test-gateway orders", async () => {
    const spend = await spendFor([order({ test: true })]);
    expect(spend).toBe(0);
  });

  it("honours an overridden accepted-status policy (owner sign-off knob)", async () => {
    const spend = await spendFor(
      [
        order({ id: "gid://shopify/Order/1", displayFinancialStatus: "PAID" }),
        order({ id: "gid://shopify/Order/2", displayFinancialStatus: "REFUNDED" }),
      ],
      { acceptedFinancialStatuses: ["PAID"] },
    );
    expect(spend).toBe(100);
  });

  it("honours includeCancelledOrders / includeTestOrders overrides", async () => {
    const spend = await spendFor(
      [
        order({ id: "gid://shopify/Order/1", cancelledAt: "2026-01-01T00:00:00Z" }),
        order({ id: "gid://shopify/Order/2", test: true }),
      ],
      { includeCancelledOrders: true, includeTestOrders: true },
    );
    expect(spend).toBe(200);
  });
});

describe("ShopifyGraphqlMigrationClient — currency guard (Req 21.1)", () => {
  const usdOrder = {
    id: "gid://shopify/Order/9001",
    test: false,
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    currentSubtotalPriceSet: money("125.40", "USD"),
  };

  it("throws a dedicated error naming the customer, order and both currencies", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer("gid://shopify/Customer/9036662472903"),
      orders: (v) => ({ customer: { id: v.id, orders: connection({ nodes: [usdOrder] }) } }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    await expect(client.listCustomersWithLoyaltyMetafields()).rejects.toBeInstanceOf(
      MigrationCurrencyMismatchError,
    );

    const err = await client.listCustomersWithLoyaltyMetafields().catch((e: unknown) => e);
    const mismatch = err as MigrationCurrencyMismatchError;
    expect(mismatch.customerId).toBe("9036662472903");
    expect(mismatch.orderGid).toBe("gid://shopify/Order/9001");
    expect(mismatch.expectedCurrency).toBe("GBP");
    expect(mismatch.foundCurrency).toBe("USD");
    expect(mismatch.message).toContain("USD");
    expect(mismatch.message).toContain("GBP");
  });

  it("accepts the store currency when expectedCurrency is set deliberately", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: (v) => ({ customer: { id: v.id, orders: connection({ nodes: [usdOrder] }) } }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch, {
      expectedCurrency: "USD",
    });

    const [record] = await client.listCustomersWithLoyaltyMetafields();
    expect(record?.lifetimeSpendGBP).toBe(125.4);
  });

  it("fires even when a non-winning precedence field carries the wrong currency", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: (v) => ({
        customer: {
          id: v.id,
          orders: connection({
            nodes: [
              {
                id: "gid://shopify/Order/9002",
                test: false,
                cancelledAt: null,
                displayFinancialStatus: "PAID",
                currentSubtotalPriceSet: money("10.00", "GBP"),
                totalDiscountsSet: money("1.00", "EUR"),
              },
            ],
          }),
        },
      }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    await expect(client.listCustomersWithLoyaltyMetafields()).rejects.toThrow(
      /totalDiscountsSet in EUR/,
    );
  });

  it("guards line-item money on the tier-3 fallback too", async () => {
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      orders: (v) => ({
        customer: {
          id: v.id,
          orders: connection({
            nodes: [
              {
                id: "gid://shopify/Order/9003",
                test: false,
                cancelledAt: null,
                displayFinancialStatus: "PAID",
                currentSubtotalPriceSet: null,
                subtotalPriceSet: null,
              },
            ],
          }),
        },
      }),
      lineItems: (v) => ({
        order: {
          id: v.id,
          lineItems: connection({ nodes: [{ originalTotalSet: money("5.00", "USD") }] }),
        },
      }),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    await expect(client.listCustomersWithLoyaltyMetafields()).rejects.toBeInstanceOf(
      MigrationCurrencyMismatchError,
    );
  });
});

describe("ShopifyGraphqlMigrationClient — throttling and hard failures", () => {
  it("retries a throttled request with the shared backoff, then succeeds", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetch, calls } = scriptedFetch({
      customers: singleCustomer(),
      statusScript: [429, 429],
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch, { sleep });

    const records = await client.listCustomersWithLoyaltyMetafields();

    expect(records).toHaveLength(1);
    // Two throttles → two backoff waits, 1s then 2s (Req 13.2).
    expect(delays).toEqual([1000, 2000]);
    expect(calls.filter((c) => c.operation === "migrationListCustomers")).toHaveLength(3);
  });

  it("gives up with AdminThrottleExhaustedError when every attempt is throttled", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetch } = scriptedFetch({
      customers: singleCustomer(),
      statusScript: Array.from({ length: 10 }, () => 429),
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch, {
      sleep,
      backoff: { initialMs: 1000, factor: 2, capMs: 60000, maxAttempts: 10 },
    });

    await expect(client.listCustomersWithLoyaltyMetafields()).rejects.toBeInstanceOf(
      AdminThrottleExhaustedError,
    );
    expect(delays).toHaveLength(9);
  });

  it("propagates a hard failure immediately without retrying", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetch, calls } = scriptedFetch({
      customers: singleCustomer(),
      statusScript: [500],
    });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch, { sleep });

    await expect(client.listCustomersWithLoyaltyMetafields()).rejects.toBeInstanceOf(
      ShopifyAdminRequestError,
    );
    expect(delays).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("never puts the access token in a thrown error", async () => {
    const { fetch } = scriptedFetch({ customers: singleCustomer(), statusScript: [500] });
    const client = new ShopifyGraphqlMigrationClient(SHOP, TOKEN, fetch);

    const err = await client.listCustomersWithLoyaltyMetafields().catch((e: unknown) => e);
    expect(JSON.stringify({ message: (err as Error).message, err })).not.toContain(TOKEN);
  });
});
