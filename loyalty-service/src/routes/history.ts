/**
 * `GET /v1/history` — the authenticated customer's points activity, paginated
 * (task 6.4).
 *
 * Returns, for the customer resolved by the `/v1` auth preHandler (task 6.2,
 * `req.authCtx.customerId`), a page of the customer's ledger entries as a
 * {@link LedgerPage}:
 *
 *   - each entry carries a transaction `type` of EXACTLY one of `earned`,
 *     `spent`, or `expired`, a `reason`, an ISO 8601 `date`, and an
 *     `orderReference` for entries associated with a Shopify order (Req 6.1);
 *   - entries are ordered most-recent-first (Req 6.2);
 *   - the default page holds at most 20 entries; a caller may request a smaller
 *     page but never more than 100 (Req 6.3, 6.4);
 *   - the page reports the `totalCount` of the customer's entries and a
 *     `hasNextPage` next-page indicator (Req 6.3, 6.4);
 *   - invalid pagination (page size < 1 or > 100, page < 1, or a non-integer
 *     value) is rejected with a `400 invalid_pagination` error and NO entries
 *     (Req 6.5);
 *   - a customer with no entries yields an empty page with `totalCount` 0
 *     (Req 6.6).
 *
 * TRANSACTION-TYPE MAPPING (Req 6.1). The ledger records nine `entry_type`
 * values (see {@link LedgerEntryType}); Req 6.1 constrains the customer-facing
 * type to exactly `earned | spent | expired`. The mapping in
 * {@link mapEntryType} is:
 *
 *   - `earn_signup`, `earn_order`, `earn_first_purchase`, `earn_referral`
 *                                                        → `earned` (credits);
 *   - `spend`                                            → `spent`;
 *   - `expire`                                           → `expired`;
 *   - `clawback` (a refund/cancellation reversal, always a debit)
 *                                                        → `spent`, because the
 *     points leave the account exactly like a redemption debit; surfacing it
 *     under `spent` keeps the customer-facing set to the three allowed values
 *     while the `reason` string still explains it was a refund reversal;
 *   - `adjust` and `migration` may carry either sign, so they are mapped by
 *     sign: a positive movement (a manual credit or a migration opening
 *     balance) → `earned`; a negative movement (a compensating reversal) →
 *     `spent`.
 *
 * Equivalently: `expire` → `expired`; any other credit (points > 0) → `earned`;
 * any other debit (points < 0) → `spent`. Ledger entries are always non-zero
 * (task 2.1), so every entry maps to exactly one of the three types.
 *
 * IDENTITY-SOURCE AGNOSTIC (Req 6.7, 9.2/9.3): the handler reads only
 * `req.authCtx.customerId`, which the auth layer resolves identically whether
 * the request arrived via Shopify App Proxy (web) or a Customer Account API
 * bearer token (mobile/portal). The same local customer id, page, and page size
 * therefore yield an identical set of entries in identical order regardless of
 * identity source.
 *
 * SCOPE (task 6.4 only): this module implements the history read endpoint. It
 * does NOT implement rate limiting (task 6.5) or the metafield cache writer
 * (task 6.6). It reads the append-only ledger (task 2.1) via an injectable
 * source and never writes.
 *
 * SAFETY: defining this module touches no live/production system. The
 * Pg-backed source issues read-only SQL only when a caller passes a real
 * Pool/PoolClient at runtime; the route logic is unit-tested against an
 * in-memory fake source, so live DB verification is deferred to deploy time.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { QueryResultRow } from "pg";
import type { LedgerEntryType, Queryable } from "../ledger/repository.js";

/** The customer-facing transaction type — exactly one of three values (Req 6.1). */
export type TransactionType = "earned" | "spent" | "expired";

/** Default page size when the caller does not specify one (Req 6.3). */
export const HISTORY_DEFAULT_PAGE_SIZE = 20;
/** Maximum permitted page size; a larger request is rejected (Req 6.4, 6.5). */
export const HISTORY_MAX_PAGE_SIZE = 100;

/**
 * Maps a ledger `entry_type` + signed point amount to the customer-facing
 * transaction type (Req 6.1). Pure. See the module header for the full
 * rationale; in short: `expire` → `expired`, any other credit → `earned`, any
 * other debit → `spent`.
 */
export function mapEntryType(entryType: LedgerEntryType, points: number): TransactionType {
  if (entryType === "expire") {
    return "expired";
  }
  return points < 0 ? "spent" : "earned";
}

/**
 * A raw ledger entry as loaded from the store for history rendering. This is
 * the shape a {@link LedgerHistorySource} returns; the pure
 * {@link mapHistoryEntry} projects it into the customer-facing
 * {@link HistoryEntry}.
 */
export interface RawHistoryEntry {
  /** The ledger row id (stable, opaque). */
  id: string;
  /** The ledger `entry_type` (one of nine values). */
  entryType: LedgerEntryType;
  /** The signed point movement (positive = credit, negative = debit). */
  points: number;
  /** Human-readable reason for the movement. */
  reason: string;
  /** The Shopify order id when the movement is order-attributable, else null. */
  orderReference: number | null;
  /** When the movement was recorded. */
  createdAt: Date;
}

/**
 * A single customer-facing history entry (design.md → an item of `LedgerPage`).
 * Carries the mapped transaction `type`, the signed `points`, the `reason`, the
 * ISO 8601 `date`, and the `orderReference` (null when the entry is not
 * associated with an order) — Req 6.1.
 */
export interface HistoryEntry {
  /** The ledger row id (stable, opaque) — useful for client keys/debugging. */
  id: string;
  /** Exactly one of `earned | spent | expired` (Req 6.1). */
  type: TransactionType;
  /** The signed point movement (positive = credit, negative = debit). */
  points: number;
  /** Human-readable reason for the movement (Req 6.1). */
  reason: string;
  /** The movement timestamp as an ISO 8601 string (Req 6.1). */
  date: string;
  /** The associated Shopify order id, or null when not order-associated (Req 6.1). */
  orderReference: number | null;
}

/**
 * A page of history (design.md → `LedgerPage`). Carries the page's entries plus
 * the pagination metadata Req 6.3/6.4 require: the echoed `page` and `pageSize`,
 * the `totalCount` of the customer's entries, and a `hasNextPage` next-page
 * indicator.
 *
 * The `apiVersion` field is injected by the versioning plugin at serialization
 * time and is intentionally not part of this type.
 */
export interface LedgerPage {
  /** The entries on this page, most-recent-first (Req 6.2). */
  entries: HistoryEntry[];
  /** The 1-based page number returned (Req 6.3). */
  page: number;
  /** The maximum number of entries this page may contain (Req 6.3, 6.4). */
  pageSize: number;
  /** The total number of the customer's ledger entries (Req 6.3, 6.6). */
  totalCount: number;
  /** True iff further pages exist beyond this one (Req 6.3, 6.4). */
  hasNextPage: boolean;
}

/** A validated pagination request: a 1-based page and a bounded page size. */
export interface Pagination {
  /** 1-based page number (>= 1). */
  page: number;
  /** Requested page size (1..{@link HISTORY_MAX_PAGE_SIZE}). */
  pageSize: number;
}

/** The result of parsing/validating pagination query params (Req 6.5). */
export type PaginationParseResult =
  | { ok: true; pagination: Pagination }
  | { ok: false; message: string };

/** A raw query-param value as Fastify presents it (string, repeated, or absent). */
type RawQueryValue = string | string[] | undefined;

/** Reads the first value of a possibly-repeated query param. */
function firstValue(value: RawQueryValue): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Parses a single pagination integer param. Returns the parsed integer, or
 * `undefined` when the param is absent (so the caller can apply a default), or
 * `null` when the value is present but not a valid base-10 integer (Req 6.5).
 */
function parseIntParam(value: RawQueryValue): number | undefined | null {
  const raw = firstValue(value);
  if (raw === undefined || raw === "") {
    return undefined;
  }
  // Accept only a clean base-10 integer (optional leading sign); reject
  // decimals, whitespace-padded, or non-numeric values as invalid (Req 6.5).
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    return null;
  }
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parses and validates pagination from the request query (Req 6.3/6.4/6.5).
 *
 * Defaults: `page` = 1, `pageSize` = {@link HISTORY_DEFAULT_PAGE_SIZE} (20).
 * Rejects (returns `{ ok: false }`) when `page` < 1, `pageSize` < 1, `pageSize`
 * > {@link HISTORY_MAX_PAGE_SIZE} (100), or either value is present but not a
 * valid integer — so the handler can respond with an error and NO entries.
 */
export function parsePagination(query: Record<string, RawQueryValue>): PaginationParseResult {
  const pageRaw = parseIntParam(query.page);
  const pageSizeRaw = parseIntParam(query.pageSize);

  if (pageRaw === null) {
    return { ok: false, message: "The 'page' parameter must be an integer of at least 1." };
  }
  if (pageSizeRaw === null) {
    return {
      ok: false,
      message: `The 'pageSize' parameter must be an integer between 1 and ${HISTORY_MAX_PAGE_SIZE}.`,
    };
  }

  const page = pageRaw ?? 1;
  const pageSize = pageSizeRaw ?? HISTORY_DEFAULT_PAGE_SIZE;

  if (page < 1) {
    return { ok: false, message: "The 'page' parameter must be at least 1." };
  }
  if (pageSize < 1 || pageSize > HISTORY_MAX_PAGE_SIZE) {
    return {
      ok: false,
      message: `The 'pageSize' parameter must be between 1 and ${HISTORY_MAX_PAGE_SIZE}.`,
    };
  }

  return { ok: true, pagination: { page, pageSize } };
}

/** Projects a raw ledger entry into a customer-facing {@link HistoryEntry} (pure, Req 6.1). */
export function mapHistoryEntry(entry: RawHistoryEntry): HistoryEntry {
  return {
    id: entry.id,
    type: mapEntryType(entry.entryType, entry.points),
    points: entry.points,
    reason: entry.reason,
    date: entry.createdAt.toISOString(),
    orderReference: entry.orderReference,
  };
}

/** A page of raw entries plus the total count, as returned by a {@link LedgerHistorySource}. */
export interface RawHistoryPage {
  /** The raw entries for the requested page, most-recent-first (Req 6.2). */
  entries: RawHistoryEntry[];
  /** The total number of the customer's ledger entries (Req 6.3, 6.6). */
  totalCount: number;
}

/** A validated request for a page of a customer's history. */
export interface LedgerHistoryQuery {
  customerId: string;
  page: number;
  pageSize: number;
}

/**
 * Loads a page of a customer's ledger history, most-recent-first, plus the
 * total entry count (Req 6.2, 6.3). Expressed as an injectable interface so the
 * route is unit-testable with an in-memory fake and never requires a live
 * Postgres (mirrors the balance source / resolver pattern).
 */
export interface LedgerHistorySource {
  load(query: LedgerHistoryQuery): Promise<RawHistoryPage>;
}

/**
 * Builds the {@link LedgerPage} response from a loaded raw page (pure). Maps
 * each entry (Req 6.1) and computes the `hasNextPage` indicator from the page
 * position and the total count (Req 6.3, 6.4): a next page exists iff the
 * entries seen so far (`page * pageSize`) do not yet cover the total. An empty
 * page yields an empty `entries` array with the given `totalCount` (0 for a
 * customer with no entries — Req 6.6).
 */
export function buildLedgerPage(
  rawPage: RawHistoryPage,
  page: number,
  pageSize: number,
): LedgerPage {
  const entries = rawPage.entries.map(mapHistoryEntry);
  const hasNextPage = page * pageSize < rawPage.totalCount;
  return {
    entries,
    page,
    pageSize,
    totalCount: rawPage.totalCount,
    hasNextPage,
  };
}

const SELECT_HISTORY_COUNT_SQL = `
  SELECT COUNT(*)::text AS total
  FROM ledger_entries
  WHERE customer_id = $1
`;

/**
 * Selects a page of the customer's ledger entries, most-recent-first (Req 6.2).
 * Ordering is `created_at DESC, id DESC` so entries sharing a timestamp have a
 * stable, deterministic order across pages and across identity sources
 * (Req 6.7). Uses LIMIT/OFFSET for the requested page.
 */
const SELECT_HISTORY_PAGE_SQL = `
  SELECT id, entry_type, points, reason, order_reference, created_at
  FROM ledger_entries
  WHERE customer_id = $1
  ORDER BY created_at DESC, id DESC
  LIMIT $2 OFFSET $3
`;

interface HistoryDbRow extends QueryResultRow {
  id: string;
  entry_type: string;
  points: string | number;
  reason: string;
  order_reference: string | number | null;
  created_at: Date;
}

/** Parses a BIGINT/NUMERIC column (`pg` returns these as strings) into a finite number. */
function parseIntegerColumn(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Postgres-backed {@link LedgerHistorySource}: reads the customer's total entry
 * count and the requested page of entries from `ledger_entries`, ordered
 * most-recent-first. Read-only.
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing. Not used by tests or local runs
 * — an in-memory source stands in so no live Postgres is required.
 */
export class PgLedgerHistorySource implements LedgerHistorySource {
  constructor(private readonly db: Queryable) {}

  async load(query: LedgerHistoryQuery): Promise<RawHistoryPage> {
    const countResult = await this.db.query<{ total: string }>(SELECT_HISTORY_COUNT_SQL, [
      query.customerId,
    ]);
    const totalCount = parseIntegerColumn(countResult.rows[0]?.total ?? 0);

    const offset = (query.page - 1) * query.pageSize;
    const pageResult = await this.db.query<HistoryDbRow>(SELECT_HISTORY_PAGE_SQL, [
      query.customerId,
      query.pageSize,
      offset,
    ]);

    const entries: RawHistoryEntry[] = pageResult.rows.map((row) => ({
      id: row.id,
      entryType: row.entry_type as LedgerEntryType,
      points: parseIntegerColumn(row.points),
      reason: row.reason,
      orderReference:
        row.order_reference === null ? null : parseIntegerColumn(row.order_reference),
      createdAt: row.created_at,
    }));

    return { entries, totalCount };
  }
}

/**
 * In-memory {@link LedgerHistorySource} backed by a `customerId → entries` map.
 * The default source for local runs and the vehicle for tests, so the history
 * endpoint runs with no live Postgres. Entries are sorted most-recent-first
 * (Req 6.2) and sliced to the requested page; an unknown customer yields an
 * empty page with `totalCount` 0 (Req 6.6).
 */
export class InMemoryLedgerHistorySource implements LedgerHistorySource {
  private readonly byCustomerId: Map<string, RawHistoryEntry[]>;

  constructor(
    entries: Record<string, RawHistoryEntry[]> | Map<string, RawHistoryEntry[]> = {},
  ) {
    this.byCustomerId =
      entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries));
  }

  async load(query: LedgerHistoryQuery): Promise<RawHistoryPage> {
    const all = this.byCustomerId.get(query.customerId) ?? [];
    const sorted = [...all].sort((a, b) => {
      const byDate = b.createdAt.getTime() - a.createdAt.getTime();
      if (byDate !== 0) {
        return byDate;
      }
      // Stable tie-break for entries sharing a timestamp: descending id, to
      // match the SQL source's `created_at DESC, id DESC` ordering (Req 6.2/6.7).
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    const offset = (query.page - 1) * query.pageSize;
    const entries = sorted.slice(offset, offset + query.pageSize);
    return { entries, totalCount: all.length };
  }

  /** Test/setup helper: register a customer's raw entries. */
  set(customerId: string, entries: RawHistoryEntry[]): void {
    this.byCustomerId.set(customerId, entries);
  }
}

/** Options accepted by {@link registerHistoryRoute}. */
export interface HistoryRouteOptions {
  /**
   * Loads a page of a customer's ledger history + the total count. Defaults to
   * an empty in-memory source so the route boots without a live Postgres; it
   * then returns an empty page for every customer until a real source is wired.
   */
  historySource?: LedgerHistorySource;
}

/**
 * Registers `GET /v1/history` on `app`. MUST be called inside the `/v1` router
 * scope so the auth preHandler has already resolved `req.authCtx` (task 6.2)
 * before this handler runs; the handler reads only `req.authCtx.customerId`, so
 * its output is identical across App Proxy and Customer Account API identity
 * sources (Req 6.7, 9.2/9.3).
 *
 * Responds `401` if auth did not attach an identity (defensive — the preHandler
 * normally rejects first), `400 invalid_pagination` for out-of-range/malformed
 * pagination with no entries (Req 6.5), and otherwise `200` with a
 * {@link LedgerPage} (Req 6.1–6.4, 6.6).
 */
export function registerHistoryRoute(app: FastifyInstance, opts: HistoryRouteOptions = {}): void {
  const historySource = opts.historySource ?? new InMemoryLedgerHistorySource();

  app.get("/history", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) {
      // Defensive: the auth preHandler should have rejected already (Req 9.3).
      return reply.code(401).send({
        error: "identity_resolution_failed",
        message: "Could not resolve the request to a loyalty customer identity.",
      });
    }

    const parsed = parsePagination((req.query ?? {}) as Record<string, RawQueryValue>);
    if (!parsed.ok) {
      // Reject invalid pagination before loading anything → no entries (Req 6.5).
      return reply.code(400).send({
        error: "invalid_pagination",
        message: parsed.message,
      });
    }

    const { page, pageSize } = parsed.pagination;
    const rawPage = await historySource.load({ customerId: ctx.customerId, page, pageSize });
    return buildLedgerPage(rawPage, page, pageSize);
  });
}
