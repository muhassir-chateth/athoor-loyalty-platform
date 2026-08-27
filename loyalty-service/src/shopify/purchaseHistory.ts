/**
 * Purchased fragrances from a customer's paid Shopify orders (task 44) —
 * Req 17.1, 17.6, 17.9, 17.10.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * `PgFragranceProfileDataSource` was constructed with the default
 * `EmptyShopifyFragranceSource`, so `purchasedFragrances` was ALWAYS empty in
 * production. Req 17.1 ("derived solely from that customer's paid Shopify
 * orders") was unmet end to end, and Req 17.6's "exclude any fragrance the
 * customer has already purchased" silently excluded nothing — suggestions were
 * ranked from view history alone. Found while wiring task 31.
 *
 * ── WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────────
 * It is ONE thing: a `ShopifyFragranceSource` that reads a customer's orders and
 * reports which products they bought, how often, and when. It contains **no
 * ranking and no exclusion logic** — those stay in `RulesBasedSuggestionEngine`,
 * which already receives this data through `SuggestionDataSource` and already
 * excludes purchased products. Wiring this source is therefore the whole fix for
 * Req 17.6; nothing about suggestions changes.
 *
 * ── REUSE, NOT DUPLICATION ───────────────────────────────────────────────────
 * Order reading is not reimplemented:
 *   - {@link ShopifyGraphqlTransport} — the shared Admin transport with its
 *     error mapping and token handling;
 *   - {@link withThrottleRetry} + `DEFAULT_BACKOFF` — the same throttle policy
 *     the migration client uses (Req 13.2);
 *   - {@link orderCountsTowardsSpend} with {@link OrderInclusionPolicy} and
 *     `DEFAULT_ACCEPTED_FINANCIAL_STATUSES} — **the migration client's own
 *     predicate**, so "a paid order" means exactly the same thing here as it does
 *     when lifetime spend is derived. Restating those rules is precisely how the
 *     two would drift apart, and a customer's tier and their purchase history
 *     disagreeing about whether an order counted would be very hard to explain.
 * What is genuinely new is only the *projection*: which products a line item
 * refers to, which the migration queries never needed (they request money only).
 *
 * ── READ-ONLY ────────────────────────────────────────────────────────────────
 * Queries only. No mutation appears in this file, and a test asserts the client's
 * runtime method surface is exactly `["getPurchasedFragrances"]`.
 *
 * ── WHY A CACHE AND A FAIL-SAFE WRAPPER ──────────────────────────────────────
 * This runs on `GET /v1/profile`, a customer read path with a 3-second budget
 * (Req 8.1). Req 13.2 forbids synchronous Admin API calls inside a **webhook
 * handler**, which this is not, and Req 17.10 explicitly says order data comes
 * from Shopify — so a read here is permitted. But an unbounded Shopify round trip
 * per profile view would put both latency and throttle exposure on the dashboard,
 * so {@link CachingPurchaseHistorySource} adds a short TTL, a hard timeout, and
 * degradation to empty on failure (Req 17.9 — empty, never an error).
 *
 * **The honest cost of that degradation:** when the Shopify read fails, purchases
 * read as empty, so the suggestion engine has nothing to exclude and MAY suggest
 * a fragrance the member already owns. That is a visible-quality regression, not
 * a correctness one — no balance, ledger row or entitlement depends on it — and
 * it is logged so it is not silent. Failing the whole profile instead would take
 * the dashboard down for a recommendation feature, which is the worse trade.
 */
import {
  ShopifyGraphqlTransport,
  type FetchLike,
} from "./graphqlClient.js";
import {
  DEFAULT_ACCEPTED_FINANCIAL_STATUSES,
  orderCountsTowardsSpend,
  type OrderInclusionPolicy,
} from "../migration/migrationShopifyClient.js";
import {
  DEFAULT_PAGE_SIZE,
  withThrottleRetry,
  type Connection,
  type ThrottleRetryOptions,
} from "../migration/shopifyMigrationSupport.js";
import { DEFAULT_BACKOFF, type BackoffParams, type Sleeper } from "./adminGateway.js";
import {
  CoalescingTtlCache,
  DEFAULT_SHOPIFY_READ_MAX_ENTRIES,
  DEFAULT_SHOPIFY_READ_TIMEOUT_MS,
  DEFAULT_SHOPIFY_READ_TTL_MS,
} from "./coalescingCache.js";
import type { PurchasedFragrance, ShopifyFragranceSource } from "../profile/fragranceProfile.js";
import type { Queryable } from "../ledger/repository.js";

/**
 * A customer's orders with the product of each line item. Money is deliberately
 * NOT requested: purchase history needs no amounts, and asking for none keeps the
 * query cost down and makes it obvious this path cannot influence a balance.
 */
export const PURCHASE_HISTORY_QUERY = /* GraphQL */ `
  query profilePurchaseHistory(
    $id: ID!
    $pageSize: Int!
    $lineItemPageSize: Int!
    $cursor: String
  ) {
    customer(id: $id) {
      id
      orders(first: $pageSize, after: $cursor, sortKey: PROCESSED_AT) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          test
          cancelledAt
          displayFinancialStatus
          processedAt
          createdAt
          lineItems(first: $lineItemPageSize) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              product {
                id
                title
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Line-item products for ONE order, used only when an order carries more line
 * items than the first page returned. Mirrors the migration client's lazy
 * per-order follow-up so a large order is never silently truncated.
 */
export const ORDER_LINE_ITEM_PRODUCTS_QUERY = /* GraphQL */ `
  query profileOrderLineItemProducts($id: ID!, $pageSize: Int!, $cursor: String) {
    order(id: $id) {
      id
      lineItems(first: $pageSize, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          product {
            id
            title
          }
        }
      }
    }
  }
`;

/** Default line items requested per order before a follow-up page is needed. */
export const DEFAULT_LINE_ITEM_PAGE_SIZE = 50 as const;

interface LineItemNode {
  product?: { id: string; title: string | null } | null;
}

interface PurchaseOrderNode {
  id: string;
  test?: boolean | null;
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  processedAt?: string | null;
  createdAt?: string | null;
  lineItems: Connection<LineItemNode>;
}

interface PurchaseHistoryData {
  customer: { id: string; orders: Connection<PurchaseOrderNode> } | null;
}

interface OrderLineItemProductsData {
  order: { id: string; lineItems: Connection<LineItemNode> } | null;
}

/**
 * Maps a LOCAL `customers.id` to the numeric Shopify customer id.
 *
 * Needed because `ShopifyFragranceSource.getPurchasedFragrances` is handed the
 * local id (the profile composition never passes a Shopify id around), while the
 * Admin API is addressed by Shopify GID. Read-only.
 */
export interface ShopifyCustomerIdLookup {
  /** The numeric Shopify customer id, or `null` when the customer is unknown. */
  findShopifyCustomerId(localCustomerId: string): Promise<string | null>;
}

/** Postgres-backed {@link ShopifyCustomerIdLookup}. One read-only SELECT. */
export class PgShopifyCustomerIdLookup implements ShopifyCustomerIdLookup {
  constructor(private readonly db: Queryable) {}

  async findShopifyCustomerId(localCustomerId: string): Promise<string | null> {
    const result = await this.db.query<{ shopify_customer_id: string }>(
      `SELECT shopify_customer_id::text FROM customers WHERE id = $1 LIMIT 1`,
      [localCustomerId],
    );
    return result.rows[0]?.shopify_customer_id ?? null;
  }
}

/** Options for {@link ShopifyGraphqlPurchaseHistorySource}. */
export interface PurchaseHistoryOptions {
  /** `displayFinancialStatus` values that count as purchased; defaults to the migration client's set. */
  acceptedFinancialStatuses?: readonly string[];
  /** Count cancelled orders too. Default `false`. */
  includeCancelledOrders?: boolean;
  /** Count Shopify test-gateway orders too. Default `false`. */
  includeTestOrders?: boolean;
  /** Orders requested per page; defaults to 100. */
  pageSize?: number;
  /** Line items requested per order before a follow-up page; defaults to 50. */
  lineItemPageSize?: number;
  /** Backoff policy for the throttle-retry loop; defaults to the shared `DEFAULT_BACKOFF`. */
  backoff?: BackoffParams;
  /** Injected pauser so tests never wait on real backoff delays. */
  sleep?: Sleeper;
}

/** Accumulator per product while folding orders. */
interface Accumulator {
  productId: string;
  title: string | null;
  first: string | null;
  last: string | null;
  count: number;
}

/** The order's effective purchase timestamp, preferring `processedAt`. */
function orderTimestamp(order: PurchaseOrderNode): string | null {
  return order.processedAt ?? order.createdAt ?? null;
}

/** Numeric id from a Shopify product GID (`gid://shopify/Product/123` → `123`). */
export function productIdFromGid(gid: string): string | null {
  const tail = gid.split("/").pop();
  return tail && /^\d+$/.test(tail) ? tail : null;
}

/**
 * Reads a customer's paid Shopify orders and reports the distinct products they
 * purchased. Queries only.
 */
export class ShopifyGraphqlPurchaseHistorySource implements ShopifyFragranceSource {
  private readonly transport: ShopifyGraphqlTransport;
  private readonly inclusion: OrderInclusionPolicy;
  private readonly pageSize: number;
  private readonly lineItemPageSize: number;
  private readonly retry: ThrottleRetryOptions;

  constructor(
    shopDomain: string,
    accessToken: string,
    private readonly lookup: ShopifyCustomerIdLookup,
    fetchImpl?: FetchLike,
    options: PurchaseHistoryOptions = {},
  ) {
    this.transport = new ShopifyGraphqlTransport(shopDomain, accessToken, fetchImpl);
    this.inclusion = {
      acceptedStatuses: new Set(
        (options.acceptedFinancialStatuses ?? DEFAULT_ACCEPTED_FINANCIAL_STATUSES).map((s) =>
          s.toUpperCase(),
        ),
      ),
      includeCancelledOrders: options.includeCancelledOrders ?? false,
      includeTestOrders: options.includeTestOrders ?? false,
    };
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.lineItemPageSize = options.lineItemPageSize ?? DEFAULT_LINE_ITEM_PAGE_SIZE;
    this.retry = {
      backoff: options.backoff ?? DEFAULT_BACKOFF,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    };
  }

  async getPurchasedFragrances(customerId: string): Promise<readonly PurchasedFragrance[]> {
    const shopifyCustomerId = await this.lookup.findShopifyCustomerId(customerId);
    if (!shopifyCustomerId) {
      // Unknown customer → empty, never an error (Req 17.9).
      return [];
    }
    const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

    const byProduct = new Map<string, Accumulator>();
    let cursor: string | null = null;

    for (;;) {
      const data = await withThrottleRetry(
        () =>
          this.transport.request<PurchaseHistoryData>(PURCHASE_HISTORY_QUERY, {
            id: gid,
            pageSize: this.pageSize,
            lineItemPageSize: this.lineItemPageSize,
            cursor,
          }),
        this.retry,
      );

      const orders = data.customer?.orders;
      if (!orders) {
        // The customer is not readable (deleted, or the token cannot see them).
        return [];
      }

      for (const order of orders.nodes) {
        // THE shared predicate — the same one lifetime spend uses.
        if (!orderCountsTowardsSpend(order, this.inclusion)) {
          continue;
        }
        const at = orderTimestamp(order);
        const lineItems = await this.collectLineItems(order);
        for (const item of lineItems) {
          const productGid = item.product?.id;
          if (!productGid) {
            // A line item whose product was deleted carries no product; it
            // cannot be attributed, so it is skipped rather than guessed at.
            continue;
          }
          const productId = productIdFromGid(productGid) ?? productGid;
          this.accumulate(byProduct, productId, item.product?.title ?? null, at);
        }
      }

      if (!orders.pageInfo.hasNextPage) {
        break;
      }
      cursor = orders.pageInfo.endCursor;
      if (!cursor) {
        break;
      }
    }

    // Most-recently-purchased first, with a stable tie-break so the response is
    // deterministic for a customer who bought several products in one order.
    return [...byProduct.values()]
      .map((acc) => ({
        productId: acc.productId,
        title: acc.title,
        firstPurchasedAt: acc.first,
        lastPurchasedAt: acc.last,
        purchaseCount: acc.count,
      }))
      .sort((a, b) => {
        const left = a.lastPurchasedAt ?? "";
        const right = b.lastPurchasedAt ?? "";
        if (left !== right) return right.localeCompare(left);
        return a.productId.localeCompare(b.productId);
      });
  }

  /** All line items for an order, paginating only when the first page is partial. */
  private async collectLineItems(order: PurchaseOrderNode): Promise<LineItemNode[]> {
    const items = [...order.lineItems.nodes];
    let cursor = order.lineItems.pageInfo.hasNextPage
      ? order.lineItems.pageInfo.endCursor
      : null;

    while (cursor) {
      const data = await withThrottleRetry(
        () =>
          this.transport.request<OrderLineItemProductsData>(ORDER_LINE_ITEM_PRODUCTS_QUERY, {
            id: order.id,
            pageSize: this.lineItemPageSize,
            cursor,
          }),
        this.retry,
      );
      const page = data.order?.lineItems;
      if (!page) break;
      items.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    }

    return items;
  }

  /** Folds one line item into the per-product accumulator. */
  private accumulate(
    byProduct: Map<string, Accumulator>,
    productId: string,
    title: string | null,
    at: string | null,
  ): void {
    const existing = byProduct.get(productId);
    if (!existing) {
      byProduct.set(productId, { productId, title, first: at, last: at, count: 1 });
      return;
    }
    existing.count += 1;
    if (title && !existing.title) existing.title = title;
    if (at) {
      if (!existing.first || at < existing.first) existing.first = at;
      if (!existing.last || at > existing.last) existing.last = at;
    }
  }
}

/** Options for {@link CachingPurchaseHistorySource}. */
export interface CachingPurchaseHistoryOptions {
  /** How long a resolved result is reused, in ms. Default 60_000. */
  ttlMs?: number;
  /** Hard timeout for one resolution, in ms. Default 2_500 (inside the 3s budget, Req 8.1). */
  timeoutMs?: number;
  /** Upper bound on cached customers before the oldest are evicted. Default 500. */
  maxEntries?: number;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /**
   * Reports a degraded read (timeout or Shopify failure). Wired to the app logger
   * so the degradation — which can let a purchased fragrance appear in
   * suggestions — is visible rather than silent.
   */
  onDegraded?: (err: unknown, customerId: string) => void;
}

/**
 * Wraps a {@link ShopifyFragranceSource} with a short TTL cache, a hard timeout,
 * and degradation to empty on failure.
 *
 * ── THE MECHANISM IS NOW SHARED, NOT LOCAL (task 8.1, design §7.6) ───────────
 * The TTL, the hard timeout, the in-flight coalescing and the never-cache-a-
 * failure rule used to live in this class. Design §7.6 requires the Orders read
 * to use the SAME shape, so the mechanism moved to
 * {@link CoalescingTtlCache} and both consumers now share one definition of it
 * rather than holding two copies that agree today and drift later.
 *
 * WHAT STAYED HERE IS THE POLICY, WHICH IS NOT SHARED. The cache REJECTS on
 * failure; this class catches that and returns an empty list, because Req 17.9
 * requires the profile to render with empty categories rather than fail. The
 * Orders read does the opposite and maps the same rejection to
 * `502 upstream_unavailable`, because an empty orders list would read to a
 * customer as "you have never bought anything". Same mechanism, opposite policy
 * — which is exactly why the policy could not move into the cache.
 *
 * A FAILURE IS NEVER CACHED: only a successful read is stored, so a transient
 * Shopify error does not pin an empty purchase history for the whole TTL. The
 * in-flight promise is shared, so one failed read produces one degradation
 * report rather than one per consumer.
 *
 * WHY THE COALESCING MATTERS HERE SPECIFICALLY. The profile composition asks for
 * purchases TWICE per request — once for the `purchasedFragrances` field and once
 * as the suggestion engine's purchase history — and it asks CONCURRENTLY, so a
 * value cache alone is always cold for both and doubles the Shopify calls per
 * profile view.
 */
export class CachingPurchaseHistorySource implements ShopifyFragranceSource {
  private readonly onDegraded?: (err: unknown, customerId: string) => void;
  private readonly cache: CoalescingTtlCache<readonly PurchasedFragrance[]>;

  constructor(
    private readonly inner: ShopifyFragranceSource,
    options: CachingPurchaseHistoryOptions = {},
  ) {
    this.cache = new CoalescingTtlCache<readonly PurchasedFragrance[]>({
      ttlMs: options.ttlMs ?? DEFAULT_SHOPIFY_READ_TTL_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_SHOPIFY_READ_TIMEOUT_MS,
      maxEntries: options.maxEntries ?? DEFAULT_SHOPIFY_READ_MAX_ENTRIES,
      // The label reproduces the shipped timeout wording exactly, so what the
      // degradation reporter observes is unchanged by the extraction.
      // The MESSAGE is preserved verbatim (`purchase-history read exceeded Nms`),
      // so a reader of the degradation log line sees the same wording as before.
      // The error TYPE did change: a plain `Error` became
      // `ShopifyReadTimeoutError`, so pino's serialiser emits a different
      // `err.type` and an extra `code`. That is an improvement, not an accident —
      // the orders route maps a timeout by TYPE rather than by matching message
      // text — but it is a change, and worth saying so rather than claiming the
      // extraction was invisible.
      label: "purchase-history read",
      // Reported from INSIDE the shared read, not from the catch below. Two
      // concurrent profile reads share one in-flight promise, so a caller-side
      // report would fire twice for one upstream failure and the log would
      // suggest Shopify failed twice. The hook fires once per read.
      onFailure: (err, customerId) => this.onDegraded?.(err, customerId),
      ...(options.now ? { now: options.now } : {}),
    });
    if (options.onDegraded) this.onDegraded = options.onDegraded;
  }

  async getPurchasedFragrances(customerId: string): Promise<readonly PurchasedFragrance[]> {
    try {
      return await this.cache.read(customerId, () =>
        this.inner.getPurchasedFragrances(customerId),
      );
    } catch {
      // Degrade, do not fail: the profile still renders (Req 17.9). The
      // consequence — suggestions may include an already-purchased product this
      // time — was already reported by `onFailure` above, so it is not silent
      // and it is not double-counted.
      return [];
    }
  }
}
