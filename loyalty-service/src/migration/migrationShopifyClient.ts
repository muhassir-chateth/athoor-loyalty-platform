/**
 * Concrete, READ-ONLY {@link MigrationShopifyClient} for Migration Phase M0
 * (task 33 — the production boundary the task-26 rehearsal had to fake).
 *
 * `m0Export.ts` declares the read-only Shopify boundary; this module is its ONLY
 * production implementation. It speaks the Admin GraphQL API through the shared
 * {@link ShopifyGraphqlTransport} (HTTPS only, token in a header that is never
 * logged, 429/`THROTTLED` mapped to {@link ShopifyThrottleError} and everything
 * else to {@link ShopifyAdminRequestError}) and returns, for every customer in
 * the store:
 *
 *   - `id` / `gid` — identity;
 *   - `email` — carried because the export record declares it (NEVER logged by
 *     this module or the operator scripts);
 *   - `metafields` — EVERY metafield in the `loyalty` namespace, captured
 *     VERBATIM (`namespace`, `key`, `type`, `value`), because that verbatim
 *     capture is precisely what a rollback restores (Req 14.1 / 14.9);
 *   - `lifetimeSpendGBP` — the lifetime spend derived independently from the
 *     customer's orders, which is what the enrolled-balance formula
 *     `50 + spend×1` is validated against (Req 14.3).
 *
 * READ-ONLY BY CONSTRUCTION: this file contains GraphQL *queries* only. There is
 * no mutation document, no write method, and no delete method anywhere in it, so
 * Req 14.8 ("never delete any Shopify metafield") holds structurally for M0. A
 * test asserts the client's runtime method surface is exactly
 * `["listCustomersWithLoyaltyMetafields"]`.
 *
 * ---------------------------------------------------------------------------
 * LIFETIME SPEND DERIVATION — mirrors `deriveEligibleTotal` in `earning/order.ts`
 * ---------------------------------------------------------------------------
 * Tier placement is a function of lifetime spend, so this derivation MUST agree
 * with the one the live earning path uses. Per order the eligible amount is
 * taken in this precedence (identical to `deriveEligibleTotal`, with the REST
 * field names it reads mapped to their GraphQL equivalents):
 *
 *   1. `currentSubtotalPriceSet.shopMoney.amount`
 *      (REST `current_subtotal_price`) — the order's CURRENT line-item subtotal,
 *      after discounts, excluding shipping and tax. Preferred because it
 *      reflects the order as it stands.
 *   2. `subtotalPriceSet.shopMoney.amount`
 *      (REST `subtotal_price`) — line-item subtotal after discounts, excluding
 *      shipping and tax.
 *   3. `max(0, lineItemsOriginalTotal − discounts)` — the computed fallback,
 *      REST `max(0, total_line_items_price − total_discounts)`. GraphQL has no
 *      single `totalLineItemsPriceSet` field, so the two operands are:
 *        - `lineItemsOriginalTotal` = Σ `lineItems.nodes.originalTotalSet.shopMoney.amount`.
 *          `originalTotalSet` is the line's price × quantity BEFORE any
 *          discount is applied, so summing it over all line items reproduces
 *          REST `total_line_items_price` exactly (which is likewise the
 *          pre-discount line-item total).
 *        - `discounts` = `currentTotalDiscountsSet.shopMoney.amount`, falling
 *          back to `totalDiscountsSet.shopMoney.amount`. These are the GraphQL
 *          equivalents of REST `total_discounts`; the `current…` variant is
 *          preferred for the same reason tier 1 prefers `currentSubtotalPriceSet`
 *          — it reflects edits/returns applied after the order was placed.
 *      Because tiers 1 and 2 are non-null on essentially every real order, this
 *      fallback almost never fires; the line items are therefore fetched LAZILY
 *      (a separate query, only for an order that reached tier 3) so the common
 *      path stays cheap.
 *
 *      Shipping (`totalShippingPriceSet`) and tax (`totalTaxSet`) are NEVER
 *      included at any tier, matching A2.
 *
 * ARITHMETIC: every amount is converted to INTEGER PENCE with
 * `Math.round(amount * 100)`, summed in pence, and divided by 100 exactly once
 * at the end — mirroring `computeOrderPoints` so there is no binary-float drift
 * across an order history.
 *
 * ---------------------------------------------------------------------------
 * WHICH ORDERS COUNT — an explicit, documented, overridable policy
 * ---------------------------------------------------------------------------
 * "Payment was captured and the order was not cancelled", implemented as:
 *
 *   - `displayFinancialStatus` ∈ {@link DEFAULT_ACCEPTED_FINANCIAL_STATUSES}
 *     = `PAID`, `PARTIALLY_REFUNDED`, `REFUNDED`. That set means "was paid at
 *     some point": a later refund does NOT remove the spend, which is consistent
 *     with Req 4.7 (a refund claws back POINTS; lifetime spend — and therefore
 *     the retained tier — does not decrease). `PENDING`, `AUTHORIZED`,
 *     `EXPIRED`, `VOIDED` and `UNPAID` are excluded: payment was never captured.
 *   - `cancelledAt === null` — cancelled orders are excluded outright, even if
 *     they were paid before cancellation.
 *   - `test === false` — Shopify test-gateway orders are excluded; they are not
 *     real money.
 *
 * ⚠️ THIS POLICY DETERMINES REAL CUSTOMERS' TIERS and needs the business
 * owner's sign-off before the production cutover. Every part of it is
 * overridable via {@link MigrationShopifyClientOptions} so a decision to, say,
 * exclude fully refunded orders can be applied without editing this module.
 *
 * ---------------------------------------------------------------------------
 * CURRENCY GUARD
 * ---------------------------------------------------------------------------
 * `expectedCurrency` defaults to `"GBP"` (Req 21.1 Base_Currency). If ANY money
 * field read from an order reports a different `shopMoney.currencyCode`, the
 * client throws {@link MigrationCurrencyMismatchError} naming the customer, the
 * order and both currencies. Summing another currency as GBP would silently
 * misplace every tier, so this fails loudly instead. (The staging store is USD,
 * so the guard fires there — that is correct behaviour and is how the rehearsal
 * proves it works.)
 *
 * SCOPES: `read_customers` plus `read_orders`. Shopify restricts apps to the
 * last 60 days of orders unless `read_all_orders` is granted — for a LIFETIME
 * spend derivation, `read_all_orders` is required in production or older orders
 * are silently invisible.
 *
 * SAFETY: this module performs no mutation and is never wired into `src/index.ts`
 * (Req 10.7a keeps migration refused over HTTP). It is driven only by the gated
 * operator script `scripts/migration/m0-export.mjs`. `fetch` is injectable, so
 * unit tests never touch the network.
 */
import {
  DEFAULT_BACKOFF,
  type BackoffParams,
  type Sleeper,
} from "../shopify/adminGateway.js";
import {
  ShopifyGraphqlTransport,
  numericIdFromGid,
  type FetchLike,
} from "../shopify/graphqlClient.js";
import type { MigrationShopifyClient, RawMetafield, ShopifyCustomerRecord } from "./m0Export.js";
import {
  DEFAULT_PAGE_SIZE,
  fetchAllLoyaltyMetafields,
  withThrottleRetry,
  type Connection,
  type ThrottleRetryOptions,
} from "./shopifyMigrationSupport.js";

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `displayFinancialStatus` values counted as "payment was captured at some
 * point" (see module header). Refunded states are INCLUDED so lifetime spend
 * never decreases on a refund (Req 4.7).
 */
export const DEFAULT_ACCEPTED_FINANCIAL_STATUSES = [
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;

/** Base_Currency the export expects every order to be denominated in (Req 21.1). */
export const DEFAULT_EXPECTED_CURRENCY = "GBP" as const;

/** Options for {@link ShopifyGraphqlMigrationClient}. */
export interface MigrationShopifyClientOptions {
  /**
   * Currency every order's `shopMoney` must be in; defaults to
   * {@link DEFAULT_EXPECTED_CURRENCY}. A mismatch throws
   * {@link MigrationCurrencyMismatchError}.
   */
  expectedCurrency?: string;
  /**
   * `displayFinancialStatus` values that count towards lifetime spend; defaults
   * to {@link DEFAULT_ACCEPTED_FINANCIAL_STATUSES}. Compared case-insensitively.
   */
  acceptedFinancialStatuses?: readonly string[];
  /** Count cancelled orders too. Default `false` (cancelled orders excluded). */
  includeCancelledOrders?: boolean;
  /** Count Shopify test-gateway orders too. Default `false`. */
  includeTestOrders?: boolean;
  /** Connection page size for customers/orders/metafields; defaults to 100. */
  pageSize?: number;
  /** Backoff policy for the throttle-retry loop; defaults to {@link DEFAULT_BACKOFF}. */
  backoff?: BackoffParams;
  /** Injected pauser so tests never wait on real backoff delays. */
  sleep?: Sleeper;
}

/** Thrown when an order's money is not in the expected currency. */
export class MigrationCurrencyMismatchError extends Error {
  readonly code = "migration_currency_mismatch";
  readonly customerId: string;
  readonly customerGid: string;
  readonly orderGid: string;
  readonly field: string;
  readonly expectedCurrency: string;
  readonly foundCurrency: string;

  constructor(details: {
    customerId: string;
    customerGid: string;
    orderGid: string;
    field: string;
    expectedCurrency: string;
    foundCurrency: string;
  }) {
    super(
      `Order ${details.orderGid} for customer ${details.customerId} reports ` +
        `${details.field} in ${details.foundCurrency} but the export expects ` +
        `${details.expectedCurrency}. Summing ${details.foundCurrency} as ` +
        `${details.expectedCurrency} would misplace this customer's tier, so the export ` +
        `refuses to continue. Re-run with expectedCurrency: "${details.foundCurrency}" only ` +
        `if that is genuinely the store's base currency.`,
    );
    this.name = "MigrationCurrencyMismatchError";
    this.customerId = details.customerId;
    this.customerGid = details.customerGid;
    this.orderGid = details.orderGid;
    this.field = details.field;
    this.expectedCurrency = details.expectedCurrency;
    this.foundCurrency = details.foundCurrency;
  }
}

/* -------------------------------------------------------------------------- */
/* GraphQL documents (queries only — no mutation appears in this file)         */
/* -------------------------------------------------------------------------- */

/** Page of customers. Identity only; metafields/orders are fetched per customer. */
export const LIST_CUSTOMERS_QUERY = /* GraphQL */ `
  query migrationListCustomers($pageSize: Int!, $cursor: String) {
    customers(first: $pageSize, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        email
      }
    }
  }
`;

/**
 * Page of a customer's orders with exactly the money fields the documented
 * precedence chain needs (see module header). Shipping and tax are deliberately
 * NOT requested — they must never enter the eligible amount (A2).
 */
export const CUSTOMER_ORDERS_QUERY = /* GraphQL */ `
  query migrationCustomerOrders($id: ID!, $pageSize: Int!, $cursor: String) {
    customer(id: $id) {
      id
      orders(first: $pageSize, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          test
          cancelledAt
          displayFinancialStatus
          currentSubtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          currentTotalDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

/**
 * Pre-discount line-item totals for ONE order — the GraphQL stand-in for REST
 * `total_line_items_price`. Fetched lazily, only for an order that fell through
 * to precedence tier 3.
 */
export const ORDER_LINE_ITEM_TOTALS_QUERY = /* GraphQL */ `
  query migrationOrderLineItemTotals($id: ID!, $pageSize: Int!, $cursor: String) {
    order(id: $id) {
      id
      lineItems(first: $pageSize, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          originalTotalSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

interface ShopMoney {
  amount: string | number | null;
  currencyCode: string | null;
}

interface MoneyBag {
  shopMoney: ShopMoney | null;
}

interface CustomerIdentityNode {
  id: string;
  email: string | null;
}

interface OrderNode {
  id: string;
  test?: boolean | null;
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  currentSubtotalPriceSet?: MoneyBag | null;
  subtotalPriceSet?: MoneyBag | null;
  currentTotalDiscountsSet?: MoneyBag | null;
  totalDiscountsSet?: MoneyBag | null;
}

interface ListCustomersData {
  customers: Connection<CustomerIdentityNode>;
}

interface CustomerOrdersData {
  customer: { id: string; orders: Connection<OrderNode> } | null;
}

interface OrderLineItemTotalsData {
  order: { id: string; lineItems: Connection<{ originalTotalSet: MoneyBag | null }> } | null;
}

/** Everything the per-order derivation needs, resolved once per client run. */
interface SpendPolicy {
  expectedCurrency: string;
  acceptedStatuses: Set<string>;
  includeCancelledOrders: boolean;
  includeTestOrders: boolean;
  pageSize: number;
  retry: ThrottleRetryOptions;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (module-level so the client's method surface stays minimal)    */
/* -------------------------------------------------------------------------- */

/**
 * Converts a Shopify money amount (decimal string or number) to INTEGER PENCE,
 * or null when absent/unparseable. `Math.round(amount * 100)` mirrors
 * `computeOrderPoints`.
 */
export function penceFromAmount(amount: string | number | null | undefined): number | null {
  if (amount === null || amount === undefined || amount === "") {
    return null;
  }
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.round(n * 100);
}

/** Converts an integer-pence total back to a major-unit amount, exactly once. */
export function amountFromPence(pence: number): number {
  return pence / 100;
}

/**
 * Enforces the currency guard for one money field. A null/absent currency code
 * is not treated as a mismatch (nothing to compare); a present, differing code
 * throws.
 */
function assertExpectedCurrency(
  money: ShopMoney | null | undefined,
  field: string,
  ctx: { customerId: string; customerGid: string; orderGid: string; expectedCurrency: string },
): void {
  const found = money?.currencyCode;
  if (!found || found === ctx.expectedCurrency) {
    return;
  }
  throw new MigrationCurrencyMismatchError({
    customerId: ctx.customerId,
    customerGid: ctx.customerGid,
    orderGid: ctx.orderGid,
    field,
    expectedCurrency: ctx.expectedCurrency,
    foundCurrency: found,
  });
}

/**
 * True iff the order counts towards lifetime spend under the documented policy:
 * payment captured at some point, not cancelled, not a test order.
 */
export function orderCountsTowardsSpend(order: OrderNode, policy: SpendPolicy): boolean {
  if (!policy.includeCancelledOrders && order.cancelledAt) {
    return false;
  }
  if (!policy.includeTestOrders && order.test === true) {
    return false;
  }
  const status = (order.displayFinancialStatus ?? "").toUpperCase();
  return policy.acceptedStatuses.has(status);
}

/**
 * Sums the pre-discount line-item totals for one order (the REST
 * `total_line_items_price` equivalent), paginating `lineItems` and applying the
 * currency guard to each line. Only called for a tier-3 order.
 */
async function fetchLineItemOriginalTotalPence(
  transport: ShopifyGraphqlTransport,
  orderGid: string,
  policy: SpendPolicy,
  ctx: { customerId: string; customerGid: string },
): Promise<number> {
  let totalPence = 0;
  let cursor: string | null = null;

  for (;;) {
    const data: OrderLineItemTotalsData = await withThrottleRetry(
      () =>
        transport.request<OrderLineItemTotalsData>(ORDER_LINE_ITEM_TOTALS_QUERY, {
          id: orderGid,
          pageSize: policy.pageSize,
          cursor,
        }),
      policy.retry,
    );

    const order = data.order;
    if (!order) {
      throw new Error(
        `Shopify returned no order for ${orderGid} while deriving the line-item total for ` +
          `customer ${ctx.customerId}.`,
      );
    }

    for (const line of order.lineItems.nodes) {
      assertExpectedCurrency(line.originalTotalSet?.shopMoney, "lineItems.originalTotalSet", {
        ...ctx,
        orderGid,
        expectedCurrency: policy.expectedCurrency,
      });
      totalPence += penceFromAmount(line.originalTotalSet?.shopMoney?.amount) ?? 0;
    }

    if (!order.lineItems.pageInfo.hasNextPage) {
      return totalPence;
    }
    cursor = order.lineItems.pageInfo.endCursor;
    if (!cursor) {
      throw new Error(
        `Shopify reported another line-item page for ${orderGid} but returned no cursor; ` +
          `refusing to derive a possibly incomplete line-item total.`,
      );
    }
  }
}

/**
 * The eligible amount for one order, in INTEGER PENCE, following the documented
 * precedence chain (mirrors `deriveEligibleTotal`). Tiers 1 and 2 are returned
 * as reported — exactly as `deriveEligibleTotal` does, which clamps only the
 * computed tier-3 fallback at zero.
 */
export async function eligiblePenceForOrder(
  transport: ShopifyGraphqlTransport,
  order: OrderNode,
  policy: SpendPolicy,
  ctx: { customerId: string; customerGid: string },
): Promise<number> {
  const currencyCtx = { ...ctx, orderGid: order.id, expectedCurrency: policy.expectedCurrency };

  // Guard EVERY money field we may read, so a wrong-currency order is rejected
  // even when the winning precedence tier happens to be present.
  assertExpectedCurrency(order.currentSubtotalPriceSet?.shopMoney, "currentSubtotalPriceSet", currencyCtx);
  assertExpectedCurrency(order.subtotalPriceSet?.shopMoney, "subtotalPriceSet", currencyCtx);
  assertExpectedCurrency(order.currentTotalDiscountsSet?.shopMoney, "currentTotalDiscountsSet", currencyCtx);
  assertExpectedCurrency(order.totalDiscountsSet?.shopMoney, "totalDiscountsSet", currencyCtx);

  // (1) current subtotal — post-discount, excludes shipping and tax.
  const current = penceFromAmount(order.currentSubtotalPriceSet?.shopMoney?.amount);
  if (current !== null) {
    return current;
  }
  // (2) subtotal.
  const subtotal = penceFromAmount(order.subtotalPriceSet?.shopMoney?.amount);
  if (subtotal !== null) {
    return subtotal;
  }
  // (3) computed fallback: pre-discount line-item total − discounts, never < 0.
  const lineItemsPence = await fetchLineItemOriginalTotalPence(transport, order.id, policy, ctx);
  const discountsPence =
    penceFromAmount(order.currentTotalDiscountsSet?.shopMoney?.amount) ??
    penceFromAmount(order.totalDiscountsSet?.shopMoney?.amount) ??
    0;
  return Math.max(0, lineItemsPence - discountsPence);
}

/**
 * Sums the eligible amounts of all counting orders for one customer, in integer
 * pence. Paginates `customer.orders`.
 */
async function fetchLifetimeSpendPence(
  transport: ShopifyGraphqlTransport,
  customer: { customerId: string; customerGid: string },
  policy: SpendPolicy,
): Promise<number> {
  let totalPence = 0;
  let cursor: string | null = null;

  for (;;) {
    const data: CustomerOrdersData = await withThrottleRetry(
      () =>
        transport.request<CustomerOrdersData>(CUSTOMER_ORDERS_QUERY, {
          id: customer.customerGid,
          pageSize: policy.pageSize,
          cursor,
        }),
      policy.retry,
    );

    const node = data.customer;
    if (!node) {
      throw new Error(
        `Shopify returned no customer for ${customer.customerGid} while deriving lifetime spend.`,
      );
    }

    for (const order of node.orders.nodes) {
      if (!orderCountsTowardsSpend(order, policy)) {
        continue;
      }
      totalPence += await eligiblePenceForOrder(transport, order, policy, customer);
    }

    if (!node.orders.pageInfo.hasNextPage) {
      return totalPence;
    }
    cursor = node.orders.pageInfo.endCursor;
    if (!cursor) {
      throw new Error(
        `Shopify reported another order page for customer ${customer.customerId} but returned ` +
          `no cursor; refusing to derive a possibly incomplete lifetime spend.`,
      );
    }
  }
}

/** Derives the numeric customer id string from a customer GID. */
function customerIdFromGid(gid: string): string {
  const numeric = numericIdFromGid(gid);
  return numeric === null ? "" : String(numeric);
}

/* -------------------------------------------------------------------------- */
/* The client                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Concrete {@link MigrationShopifyClient} backed by the Admin GraphQL API.
 *
 * Construction performs no I/O. The only public method is
 * {@link listCustomersWithLoyaltyMetafields}; every helper is a module-level
 * function so the runtime method surface stays exactly one name (asserted by a
 * test) and there is no way to reach a write path through this object.
 */
export class ShopifyGraphqlMigrationClient implements MigrationShopifyClient {
  private readonly transport: ShopifyGraphqlTransport;
  private readonly policy: SpendPolicy;

  constructor(
    shopDomain: string,
    accessToken: string,
    fetchImpl?: FetchLike,
    options: MigrationShopifyClientOptions = {},
  ) {
    this.transport = new ShopifyGraphqlTransport(shopDomain, accessToken, fetchImpl);
    this.policy = {
      expectedCurrency: options.expectedCurrency ?? DEFAULT_EXPECTED_CURRENCY,
      acceptedStatuses: new Set(
        (options.acceptedFinancialStatuses ?? DEFAULT_ACCEPTED_FINANCIAL_STATUSES).map((s) =>
          s.toUpperCase(),
        ),
      ),
      includeCancelledOrders: options.includeCancelledOrders ?? false,
      includeTestOrders: options.includeTestOrders ?? false,
      pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
      retry: {
        backoff: options.backoff ?? DEFAULT_BACKOFF,
        ...(options.sleep ? { sleep: options.sleep } : {}),
      },
    };
  }

  /**
   * Lists EVERY customer in the store with their verbatim `loyalty.*` metafields
   * and their independently-derived lifetime spend. Read-only: issues queries
   * only, and never writes or deletes anything.
   */
  async listCustomersWithLoyaltyMetafields(): Promise<ShopifyCustomerRecord[]> {
    const records: ShopifyCustomerRecord[] = [];
    let cursor: string | null = null;

    for (;;) {
      const data: ListCustomersData = await withThrottleRetry(
        () =>
          this.transport.request<ListCustomersData>(LIST_CUSTOMERS_QUERY, {
            pageSize: this.policy.pageSize,
            cursor,
          }),
        this.policy.retry,
      );

      for (const node of data.customers.nodes) {
        const customerGid = node.id;
        const customerId = customerIdFromGid(customerGid);

        const metafields: RawMetafield[] = await fetchAllLoyaltyMetafields(
          this.transport,
          customerGid,
          { pageSize: this.policy.pageSize, retry: this.policy.retry },
        );

        const spendPence = await fetchLifetimeSpendPence(
          this.transport,
          { customerId, customerGid },
          this.policy,
        );

        records.push({
          id: customerId,
          gid: customerGid,
          email: node.email ?? null,
          metafields,
          // Converted out of integer pence exactly once, at the very end.
          lifetimeSpendGBP: amountFromPence(spendPence),
        });
      }

      if (!data.customers.pageInfo.hasNextPage) {
        return records;
      }
      cursor = data.customers.pageInfo.endCursor;
      if (!cursor) {
        throw new Error(
          "Shopify reported another customer page but returned no cursor; refusing to " +
            "continue with a possibly incomplete export (an incomplete export would abort " +
            "M0 anyway, but a silent truncation must never look complete).",
        );
      }
    }
  }
}
