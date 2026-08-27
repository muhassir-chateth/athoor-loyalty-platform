/**
 * `GET /v1/orders` (N1) and `GET /v1/orders/:orderId` (N2) — the customer's own
 * purchase history, read live from Shopify (spec tasks 8.1/8.2, design §6.3,
 * §7.1–§7.6, Req 6.1–6.5, 6.8, 6.9, 6.12).
 *
 * ── SHOPIFY IS AUTHORITATIVE AND NOTHING IS COPIED (Req 3.3) ─────────────────
 * There is no order table, no order cache in Postgres and no writer anywhere on
 * this path. §7.1 records the rejected alternative — mirroring orders locally for
 * speed — and its three costs: a second source of truth for money (the failure
 * mode is a customer reading a total that disagrees with their receipt), new
 * `ORDERS_UPDATED`/`FULFILLMENTS_*` webhook subscriptions (which Req 22.11
 * forbids), and a read-availability problem traded for a permanent consistency
 * problem. `orders.test.ts` asserts the absence rather than trusting it — a
 * recording `Queryable` proving every statement either endpoint issues is a
 * `SELECT` against `customers`, which is the only Postgres read §7.2 shows.
 *
 * ── HOW THE IDOR QUESTION IS ANSWERED ────────────────────────────────────────
 * Neither handler ever names a customer. Both obtain a branded
 * {@link CustomerScope} from {@link requireCustomerScope} — the only constructor
 * of one — and hand it to a source that traverses `customer(id: $customerGid)`
 * with the GID derived from that scope. §4.5 rows 6 and 7 are therefore satisfied
 * structurally: a foreign order is outside the connection being read, so it is
 * unreachable rather than rejected, and the `404` body carries no order field
 * because there is no order to describe.
 *
 * ── WHY VALIDATION IS IN THE HANDLER AND NOT IN A ROUTE SCHEMA ───────────────
 * `:orderId` is checked against `^\d{1,20}$` inside the handler, AFTER
 * {@link requireCustomerScope}. A Fastify `params` schema would be tidier but
 * runs at the `validation` stage, which is BEFORE `preHandler` — so the auth hook
 * would not have run yet and an unauthenticated request for a malformed id would
 * answer `400` instead of `401`. That inverts Req 9.3 (reject before any handler
 * logic) and it would break the route census, which drives every registered `/v1`
 * route through three unauthorised scenarios and requires `401` from all of them.
 * Ordering the checks 401-then-400 also means a stranger learns nothing about
 * which references are well-formed.
 *
 * ── THE ERROR MAP, AND THE ONE CASE THAT MUST NOT BE 502 ─────────────────────
 *   `ScopeUnavailableError`      → rethrown; the `/v1` scope handler answers 401
 *   `InvalidOrderReferenceError` → 400 `invalid_order_reference`
 *   source returned `null`       → 404 `order_not_found`, body has NO order field
 *   `UnscopedShopifyQueryError`  → RETHROWN → 500
 *   Shopify upstream failures    → 502 `upstream_unavailable` (allowlist below)
 *   anything else                → RETHROWN → 500, so a defect stays loud
 *
 * The fourth line is the important one. An unscoped-document rejection is OUR
 * bug — a query that would have left the customer traversal — and it is caught
 * before any request is made. Reporting it as `502 upstream_unavailable` would
 * disguise a security-relevant defect as Shopify having a bad afternoon, and the
 * degraded state the client shows would make it look handled. It is allowed to be
 * a 500 so that it is loud.
 *
 * `502` rather than `500` for genuine upstream failure is §6.3 N1's own choice:
 * it lets the client present the Orders-specific degraded state instead of
 * guessing from a generic server error.
 *
 * SAFETY: registering these routes touches no live system. The default source is
 * {@link UnconfiguredPortalOrderSource}, which REFUSES rather than answering with
 * an empty page, so an un-wired build cannot tell a customer they have never
 * bought anything.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireCustomerScope, type CustomerScope } from "../auth/customerScope.js";
import {
  InvalidOrderReferenceError,
  ORDERS_LINE_ITEM_WINDOW,
  ORDERS_PREVIEW_LINE_ITEMS,
  UnreadableUpstreamValueError,
  readScopedOrderDetail,
  readScopedOrdersPage,
  type ScopedOrderReadDeps,
} from "../portal/repository/orders.js";
import {
  AdminThrottleExhaustedError,
  ShopifyThrottleError,
} from "../shopify/adminGateway.js";
import { ShopifyAdminRequestError } from "../shopify/graphqlClient.js";
import {
  CoalescingTtlCache,
  DEFAULT_SHOPIFY_READ_MAX_ENTRIES,
  DEFAULT_SHOPIFY_READ_TIMEOUT_MS,
  DEFAULT_SHOPIFY_READ_TTL_MS,
  ShopifyReadTimeoutError,
  type CoalescingCacheOptions,
} from "../shopify/coalescingCache.js";
import {
  PORTAL_ORDERS_MAX_PAGE_SIZE,
  PORTAL_ORDER_ID_PATTERN,
  type PortalOrderDetail,
  type PortalOrdersResponse,
} from "../portal/types.js";

/* ========================================================================== *
 * Request parsing
 * ========================================================================== */

/**
 * Longest `cursor` accepted.
 *
 * Shopify's cursors are opaque and their format is not ours to validate, so this
 * bounds the SIZE and nothing else — an unbounded query parameter forwarded to an
 * upstream is a needless amplification surface. A well-formed but stale cursor
 * still reaches Shopify and surfaces as `502`, which is correct: we genuinely
 * cannot tell a stale cursor from an unavailable upstream, and inventing a `400`
 * would state a cause we do not know.
 */
export const ORDERS_MAX_CURSOR_LENGTH = 1024;

/** A validated N1 query. Carries no customer identifier — the scope does that. */
export interface OrdersQuery {
  /** 1..{@link PORTAL_ORDERS_MAX_PAGE_SIZE}, already capped. */
  pageSize: number;
  cursor?: string | undefined;
}

/** Outcome of parsing the N1 query string. */
export type OrdersQueryParseResult =
  | { ok: true; query: OrdersQuery }
  | { ok: false; message: string };

/** A raw query-param value as Fastify presents it (string, repeated, or absent). */
type RawQueryValue = string | string[] | undefined;

function firstValue(value: RawQueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parses `?pageSize=&cursor=` for N1.
 *
 * ── THE CAP IS NOT AN ERROR, AND THAT IS THE WHOLE RULE (Req 6.12, §7.3) ─────
 * A caller asking for 100 orders gets 20. §7.3 states the reasoning: "a larger
 * page is not a client error, it is a limit". A `400` there would turn a client's
 * optimism into a broken page, and every client would then have to know our
 * maximum in order to avoid tripping it.
 *
 * ── WHERE THE SPEC IS SILENT, AND WHAT IS DONE ABOUT IT ──────────────────────
 * §6.3 gives the range as 1–20 and §7.3 defines only the ABOVE-maximum case. It
 * says nothing about `pageSize=0`, `pageSize=-5` or `pageSize=abc`. Those are
 * rejected with `400 invalid_request`, because none of them is a request for a
 * larger page: a non-positive or non-numeric page size is a broken client, and
 * silently serving 20 orders to a caller that asked for -5 hides the bug from the
 * only person who can fix it. Recorded as a spec gap rather than assumed.
 *
 * Deliberately DIFFERENT from `parsePagination` in `history.ts`, which rejects an
 * oversized page too. That endpoint is offset-paged over our own append-only
 * table and Req 6.5 requires rejection there; this one is cursor-paged over
 * Shopify's connection and Req 6.12 requires capping. Two rules because the two
 * requirements differ — see §7.3 on why the paging models are not unified.
 */
export function parseOrdersQuery(query: Record<string, RawQueryValue>): OrdersQueryParseResult {
  const rawPageSize = firstValue(query.pageSize);
  let pageSize = PORTAL_ORDERS_MAX_PAGE_SIZE;

  if (rawPageSize !== undefined && rawPageSize.trim() !== "") {
    const text = rawPageSize.trim();
    if (!/^\+?\d+$/.test(text)) {
      return {
        ok: false,
        message: `The 'pageSize' parameter must be a whole number of at least 1.`,
      };
    }
    const requested = Number(text);
    if (requested < 1) {
      return {
        ok: false,
        message: `The 'pageSize' parameter must be a whole number of at least 1.`,
      };
    }
    // CAPPED, not rejected (Req 6.12).
    //
    // NO SAFE-INTEGER CHECK HERE, deliberately. `pageSize=99999999999999999999`
    // exceeds `Number.MAX_SAFE_INTEGER`, so an `isSafeInteger` guard would reject
    // it — but it is unambiguously a request for a LARGER page, which §7.3 says is
    // a limit rather than an error. Since `text` is a pure digit string, the
    // imprecision of the parsed double cannot change which side of 20 it falls on.
    pageSize = Math.min(requested, PORTAL_ORDERS_MAX_PAGE_SIZE);
  }

  const rawCursor = firstValue(query.cursor);
  const cursor = rawCursor !== undefined && rawCursor !== "" ? rawCursor : undefined;
  if (cursor !== undefined && cursor.length > ORDERS_MAX_CURSOR_LENGTH) {
    return { ok: false, message: "The 'cursor' parameter is not a usable cursor." };
  }

  return { ok: true, query: { pageSize, ...(cursor !== undefined ? { cursor } : {}) } };
}

/* ========================================================================== *
 * The source
 * ========================================================================== */

/**
 * Loads the scope's orders. Injectable so the routes are unit-testable with no
 * live Shopify, mirroring the `LedgerHistorySource` / `CustomerBalanceSource`
 * pattern the shipped routes already use.
 *
 * NOTE WHAT IS ABSENT: no method takes a customer identifier. Every method takes
 * the branded {@link CustomerScope}, so an implementation cannot be handed a
 * customer chosen by a caller. That is the same guarantee the portal repository
 * layer enforces, carried up to the injection boundary.
 */
export interface PortalOrderSource {
  /** One page of the scope's orders, newest first. */
  listOrders(scope: CustomerScope, query: OrdersQuery): Promise<PortalOrdersResponse>;
  /**
   * One of the scope's orders in full, or `null` when the reference names no
   * order reachable by this scope — which covers "does not exist" and "is
   * someone else's" identically.
   */
  getOrder(scope: CustomerScope, orderReference: string): Promise<PortalOrderDetail | null>;
}

/** The Shopify-backed source. Read-only: it issues Admin queries and nothing else. */
export class ShopifyPortalOrderSource implements PortalOrderSource {
  constructor(private readonly deps: ScopedOrderReadDeps) {}

  listOrders(scope: CustomerScope, query: OrdersQuery): Promise<PortalOrdersResponse> {
    return readScopedOrdersPage(this.deps, scope, {
      pageSize: query.pageSize,
      cursor: query.cursor,
    });
  }

  getOrder(scope: CustomerScope, orderReference: string): Promise<PortalOrderDetail | null> {
    return readScopedOrderDetail(this.deps, scope, orderReference);
  }
}

/** Options for {@link CachingPortalOrderSource}. */
export type CachingPortalOrderSourceOptions = Pick<
  CoalescingCacheOptions,
  "ttlMs" | "timeoutMs" | "maxEntries" | "now" | "onFailure"
>;

/**
 * Adds the §7.6 caching shape to any {@link PortalOrderSource}: 60 s TTL, 2.5 s
 * hard timeout, in-flight coalescing, failures never cached.
 *
 * ── THE MECHANISM IS SHARED WITH `CachingPurchaseHistorySource` ──────────────
 * Both wrap {@link CoalescingTtlCache}. §7.6 asks the Orders read to reuse the
 * shape "already proven in `CachingPurchaseHistorySource`"; extracting the
 * mechanism was how that was honoured, because the four properties interact and
 * two copies of an interacting mechanism drift. See `shopify/coalescingCache.ts`
 * for the argument in full.
 *
 * ── WHY THIS DOES NOT DEGRADE TO EMPTY ──────────────────────────────────────
 * The purchase-history wrapper swallows a failure and returns an empty list,
 * because Req 17.9 wants the profile to render. This one deliberately does NOT.
 * An empty orders list is indistinguishable from "you have never bought
 * anything", which is a false statement about a customer's own money, and §6.3 N1
 * provides `502 upstream_unavailable` precisely so the truth can be told instead.
 *
 * ── WHY THE KEY INCLUDES THE PAGE ARGUMENTS, AND WHAT THAT COSTS ────────────
 * §7.6 describes coalescing as "keyed by customer". Keying on the customer ALONE
 * would satisfy that sentence and be wrong: a request for `pageSize=5` would be
 * served the cached 20-item page, and a request for page two would be served page
 * one. So the key is the customer PLUS the page arguments.
 *
 * STATE THE CONSEQUENCE PLAINLY. §7.6 motivates coalescing with "Overview shows
 * the most recent order (Req 4.4) while Orders shows the list — two consumers,
 * one Shopify read". If Overview asks for `pageSize=1` and Orders for
 * `pageSize=20`, those are two keys and therefore TWO Shopify reads — the example
 * §7.6 cites is not collapsed by this key. What is collapsed is concurrent or
 * repeated requests for the SAME page, which is the common case in practice.
 *
 * Closing the gap needs a decision above this class: either Overview reads the
 * same first page the list reads and slices locally (one key, one read), or §7.6's
 * example is corrected. Serving a 20-item page to a caller who asked for one is
 * not an option — answering a question that was not asked is how a cache becomes
 * a source of wrong answers.
 */
export class CachingPortalOrderSource implements PortalOrderSource {
  private readonly listCache: CoalescingTtlCache<PortalOrdersResponse>;
  private readonly detailCache: CoalescingTtlCache<PortalOrderDetail | null>;

  constructor(
    private readonly inner: PortalOrderSource,
    options: CachingPortalOrderSourceOptions = {},
  ) {
    const shared: CoalescingCacheOptions = {
      ttlMs: options.ttlMs ?? DEFAULT_SHOPIFY_READ_TTL_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_SHOPIFY_READ_TIMEOUT_MS,
      maxEntries: options.maxEntries ?? DEFAULT_SHOPIFY_READ_MAX_ENTRIES,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onFailure ? { onFailure: options.onFailure } : {}),
    };
    this.listCache = new CoalescingTtlCache<PortalOrdersResponse>({
      ...shared,
      label: "orders list read",
    });
    this.detailCache = new CoalescingTtlCache<PortalOrderDetail | null>({
      ...shared,
      label: "order detail read",
    });
  }

  listOrders(scope: CustomerScope, query: OrdersQuery): Promise<PortalOrdersResponse> {
    // `\u0000` as the separator: it cannot occur in a customer UUID or a Shopify
    // cursor, so no combination of arguments can be made to collide with another
    // customer's key by choosing a cursor that contains the separator.
    const key = `${scope.customerId}\u0000list\u0000${query.pageSize}\u0000${query.cursor ?? ""}`;
    return this.listCache.read(key, () => this.inner.listOrders(scope, query));
  }

  getOrder(scope: CustomerScope, orderReference: string): Promise<PortalOrderDetail | null> {
    const key = `${scope.customerId}\u0000detail\u0000${orderReference}`;
    return this.detailCache.read(key, () => this.inner.getOrder(scope, orderReference));
  }
}

/**
 * Raised when no orders source is wired — no Shopify Admin token, or a local run.
 *
 * ── WHY THE DEFAULT IS THIS AND NOT AN EMPTY IN-MEMORY SOURCE ────────────────
 * Every other `/v1` read in this service defaults to an empty source, and for
 * balance, history and profile that is genuinely fail-closed: an empty ledger page
 * says "no activity recorded", which is true of a customer this service knows
 * nothing about.
 *
 * Orders are different, and the difference is the whole argument of §6.3 N1. An
 * empty orders list does not say "we cannot answer" — it says "you have never
 * bought anything", about a customer whose receipts prove otherwise. This module,
 * `CachingPortalOrderSource` and `readScopedOrdersPage` all refuse to degrade to
 * empty on a transient failure; defaulting to empty on a CONFIGURATION gap would
 * make the same false statement permanently, which is the worse of the two.
 *
 * It maps to `502 upstream_unavailable`, which the closed `PortalErrorCode` union
 * makes the honest choice available: the store cannot be reached, because there is
 * no credential with which to reach it.
 */
export class PortalOrderSourceUnconfiguredError extends Error {
  readonly code = "portal_order_source_unconfigured" as const;

  constructor() {
    super("No Shopify-backed orders source is configured for this build.");
    this.name = "PortalOrderSourceUnconfiguredError";
  }
}

/**
 * The DEFAULT source: it refuses, rather than pretending the customer has no
 * orders. See {@link PortalOrderSourceUnconfiguredError}.
 *
 * Mirrors `UnconfiguredTokenVerifier` in `auth/identity.ts` — the established way
 * this codebase expresses "this collaborator is absent, so fail rather than
 * improvise".
 */
export class UnconfiguredPortalOrderSource implements PortalOrderSource {
  async listOrders(): Promise<PortalOrdersResponse> {
    throw new PortalOrderSourceUnconfiguredError();
  }

  async getOrder(): Promise<PortalOrderDetail | null> {
    throw new PortalOrderSourceUnconfiguredError();
  }
}

/**
 * In-memory {@link PortalOrderSource}, keyed by local customer id. A TEST DOUBLE
 * and a local-development convenience — deliberately NOT the route default, for
 * the reason {@link PortalOrderSourceUnconfiguredError} gives.
 *
 * It reuses the projection CONSTANTS rather than restating them, so the page it
 * produces has the same shape rules as the Shopify-backed source; a double that
 * disagreed with the real source about its own contract would let a route test
 * pass against behaviour production does not have.
 */
export class InMemoryPortalOrderSource implements PortalOrderSource {
  private readonly byCustomerId = new Map<string, readonly PortalOrderDetail[]>();

  constructor(orders: Record<string, readonly PortalOrderDetail[]> = {}) {
    for (const [customer, list] of Object.entries(orders)) {
      this.byCustomerId.set(customer, list);
    }
  }

  /** Test/setup helper: register a customer's orders, newest first. */
  set(localCustomerId: string, orders: readonly PortalOrderDetail[]): void {
    this.byCustomerId.set(localCustomerId, orders);
  }

  async listOrders(scope: CustomerScope, query: OrdersQuery): Promise<PortalOrdersResponse> {
    const all = this.byCustomerId.get(scope.customerId) ?? [];
    const start = query.cursor ? Number(query.cursor) : 0;
    const offset = Number.isSafeInteger(start) && start >= 0 ? start : 0;
    const page = all.slice(offset, offset + query.pageSize);
    const end = offset + page.length;
    return {
      orders: page.map((order) => ({
        id: order.id,
        name: order.name,
        processedAt: order.processedAt,
        financialStatus: order.financialStatus,
        fulfilmentStatus: order.fulfilmentStatus,
        totalGBP: order.totalGBP,
        currencyCode: order.currencyCode,
        // The same window and preview bounds the Shopify projection applies.
        lineItemCount: Math.min(order.lineItems.length, ORDERS_LINE_ITEM_WINDOW),
        previewLineItems: order.lineItems.slice(0, ORDERS_PREVIEW_LINE_ITEMS).map((item) => ({
          title: item.title,
          quantity: item.quantity,
          imageUrl: item.imageUrl,
          imageWidth: item.imageWidth,
          imageHeight: item.imageHeight,
        })),
      })),
      pageInfo: { hasNextPage: end < all.length, endCursor: page.length > 0 ? String(end) : null },
    };
  }

  async getOrder(
    scope: CustomerScope,
    orderReference: string,
  ): Promise<PortalOrderDetail | null> {
    if (!PORTAL_ORDER_ID_PATTERN.test(orderReference)) {
      throw new InvalidOrderReferenceError();
    }
    const all = this.byCustomerId.get(scope.customerId) ?? [];
    return all.find((order) => order.id === orderReference) ?? null;
  }
}

/* ========================================================================== *
 * The routes
 * ========================================================================== */

/** Options accepted by {@link registerOrdersRoutes}. */
export interface OrdersRouteOptions {
  /**
   * Loads the scope's orders. Defaults to {@link UnconfiguredPortalOrderSource},
   * which answers `502 upstream_unavailable` — NOT to an empty page. See that
   * class for why orders differ from every other `/v1` read on this point.
   */
  orderSource?: PortalOrderSource;
}

/** The `502` body, defined once so the two handlers cannot describe it differently. */
const UPSTREAM_UNAVAILABLE_BODY = {
  error: "upstream_unavailable",
  message: "Your orders could not be loaded from the store just now.",
} as const;

/**
 * Reports an upstream failure and answers `502`.
 *
 * The log payload carries only §24.3-allowlisted keys — `errorCode`, `upstream`,
 * `route`. No order reference and no customer id: §24.3 names both among the
 * values never to log, and a 502 on this path would otherwise emit an order
 * number on every occurrence.
 */
function replyUpstreamUnavailable(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  req.log.warn(
    {
      errorCode: "upstream_unavailable",
      upstream: "shopify",
      route: req.routeOptions?.url ?? "/v1/orders",
    },
    "orders read could not reach Shopify",
  );
  return reply.code(502).send(UPSTREAM_UNAVAILABLE_BODY);
}

/**
 * Whether a thrown value is a genuine UPSTREAM failure and therefore earns
 * `502 upstream_unavailable`.
 *
 * ── AN ALLOWLIST, NOT A DENYLIST, AND THAT INVERSION IS THE POINT ────────────
 * The tempting shape is "502 unless it is one of our known bugs". It is wrong for
 * the same reason a denylist is always wrong: it protects against the defects
 * somebody already thought of. A `TypeError` in the projection, a `RangeError`, a
 * future repository error about something other than Shopify — all of them would
 * answer `502 upstream_unavailable` with a reassuring "could not be loaded from
 * the store just now", and the client would render its designed degraded state.
 * The defect would look HANDLED. That is precisely the disguise this function
 * exists to prevent, so the question is asked the other way round: name the
 * upstream failures, and let everything else be a loud 500.
 *
 * The listed types are exactly the ways the Shopify boundary can fail:
 *   - {@link ShopifyAdminRequestError} — the transport's hard failure (network,
 *     non-2xx, GraphQL errors, unparseable body);
 *   - {@link ShopifyThrottleError} / {@link AdminThrottleExhaustedError} — rate
 *     limited, before and after the bounded retry;
 *   - {@link ShopifyReadTimeoutError} — the 2.5 s budget expired;
 *   - {@link UnreadableUpstreamValueError} — Shopify answered with a money amount
 *     or an order id this service will not guess at;
 *   - {@link PortalOrderSourceUnconfiguredError} — there is no credential with
 *     which to reach the store at all.
 *
 * Deliberately NOT listed: {@link UnscopedShopifyQueryError}. A document that
 * would have left the customer traversal is refused before any request is made,
 * and it is a security-relevant defect in this codebase — the loudest possible
 * failure is the correct one.
 */
function isUpstreamFailure(err: unknown): boolean {
  return (
    err instanceof ShopifyAdminRequestError ||
    err instanceof ShopifyThrottleError ||
    err instanceof AdminThrottleExhaustedError ||
    err instanceof ShopifyReadTimeoutError ||
    err instanceof UnreadableUpstreamValueError ||
    err instanceof PortalOrderSourceUnconfiguredError
  );
}

/**
 * Registers `GET /v1/orders` and `GET /v1/orders/:orderId`. MUST be called inside
 * the `/v1` router scope, so the auth preHandler has resolved `req.authCtx` and
 * the scope-level error handler is installed before either handler runs.
 */
export function registerOrdersRoutes(app: FastifyInstance, opts: OrdersRouteOptions = {}): void {
  const orderSource = opts.orderSource ?? new UnconfiguredPortalOrderSource();

  // N1 — the paged list (§6.3 N1, Req 6.1/6.2/6.12).
  app.get("/orders", async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = requireCustomerScope(req);

    const parsed = parseOrdersQuery((req.query ?? {}) as Record<string, RawQueryValue>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.message });
    }

    try {
      return await orderSource.listOrders(scope, parsed.query);
    } catch (err) {
      if (!isUpstreamFailure(err)) throw err;
      return replyUpstreamUnavailable(req, reply);
    }
  });

  // N2 — one order in full (§6.3 N2, Req 6.3/6.4/6.5/6.8/6.9).
  app.get<{ Params: { orderId: string } }>(
    "/orders/:orderId",
    async (req, reply: FastifyReply) => {
      // Identity FIRST, so an unauthorised request cannot learn which references
      // are well-formed, and so a `401` is never displaced by a `400`.
      const scope = requireCustomerScope(req);

      const orderReference = req.params.orderId;
      if (!PORTAL_ORDER_ID_PATTERN.test(orderReference)) {
        // A GID-encoded path (`gid%3A%2F%2Fshopify%2FOrder%2F123`) decodes to a
        // value with slashes and colons and lands here — §4.5 row 7.
        return reply.code(400).send({
          error: "invalid_order_reference",
          message: "That is not a valid order reference.",
        });
      }

      let order: PortalOrderDetail | null;
      try {
        order = await orderSource.getOrder(scope, orderReference);
      } catch (err) {
        if (err instanceof InvalidOrderReferenceError) {
          // Reachable only if a source re-checks and disagrees with the guard
          // above; kept so the two checks cannot produce different statuses.
          return reply.code(400).send({
            error: "invalid_order_reference",
            message: "That is not a valid order reference.",
          });
        }
        if (!isUpstreamFailure(err)) throw err;
        return replyUpstreamUnavailable(req, reply);
      }

      if (order === null) {
        // NO ORDER FIELD IN THIS BODY (§4.5 row 6, Req 2.2/2.3). The body is
        // identical whether the reference names nobody's order or someone else's,
        // so there is no existence oracle to probe (§4.5 row 14).
        return reply.code(404).send({
          error: "order_not_found",
          message: "That order is not available on this account.",
        });
      }

      return order;
    },
  );
}
