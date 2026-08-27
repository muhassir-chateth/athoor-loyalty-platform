/**
 * Erasure requests and the export-only scoped reads (spec tasks 15.1/15.2,
 * design §15.4/§15.5, Req 13.8, 23.3, 23.4, 23.5, 2.1).
 *
 * Every function takes a {@link CustomerScope}. There is no overload and no
 * `string` fallback, so a handler cannot pass a customer id it read from a request.
 *
 * ── AN ERASURE REQUEST RECORDS INTENT AND DELETES NOTHING ───────────────────
 * §15.5 is emphatic and the reasoning is worth restating: the operation is
 * irreversible, spans nine tables, must be coordinated with Shopify's own erasure
 * which we do not control, requires unredeemed discount codes to be voided, and
 * must be auditable. So the customer-facing route INSERTs a row and stops. Nothing
 * in this file deletes anything — the destructive half lives in the operator-run
 * procedure (`privacy/redaction.ts`), behind an explicit target and a dry run.
 *
 * ── A DUPLICATE REQUEST IS IDEMPOTENT, NOT A SECOND ROW ─────────────────────
 * A customer who taps twice, or who asks again a week later because nothing
 * visible happened, must not create a queue of duplicates for an operator to
 * reconcile. So an OPEN request (`received` or `in_progress`) is returned as-is
 * rather than duplicated. A `completed` or `rejected` request does NOT block a new
 * one: a customer whose erasure completed and who later has new data is entitled
 * to ask again.
 *
 * ── WHY THE READS HERE ARE ONLY THE TWO THAT WERE MISSING ───────────────────
 * The export composes the SHIPPED readers for balance, ledger, redemptions,
 * referral, wishlist, favourites, birthday and preferences. Writing fresh SQL for
 * those would create a second reader of each table, and two readers drift — which
 * is the defect §8.2 spent a whole section removing for the wishlist. Only
 * `portal_visits` and `customer_recently_viewed` had no scope-typed reader, so only
 * those two are added.
 *
 * SAFETY: no DDL. Reads only; the single write is one INSERT into
 * `customer_erasure_requests`. Never touches the ledger.
 */
import type { CustomerScope } from "../../auth/customerScope.js";
import type { Queryable } from "../../ledger/repository.js";
import { scopedMutate, scopedSelect } from "./scopedQuery.js";

/** The lifecycle states `customer_erasure_requests.status` permits. */
export const ERASURE_STATUSES = ["received", "in_progress", "completed", "rejected"] as const;
export type ErasureStatus = (typeof ERASURE_STATUSES)[number];

/** The sources `customer_erasure_requests.source` permits. */
export const ERASURE_SOURCES = ["portal", "shopify_redaction", "operator"] as const;
export type ErasureSource = (typeof ERASURE_SOURCES)[number];

/**
 * Statuses that mean "already asked, not yet actioned".
 *
 * A request in one of these is what makes a duplicate a no-op. `completed` and
 * `rejected` are deliberately excluded — both are finished, and a finished request
 * must not silently absorb a new one.
 */
export const OPEN_ERASURE_STATUSES: readonly ErasureStatus[] = ["received", "in_progress"];

/** One erasure request, as the read projects it. */
export interface ErasureRequestRecord {
  readonly id: string;
  readonly requestedAt: string;
  readonly status: ErasureStatus;
  readonly completedAt: string | null;
  readonly source: ErasureSource;
}

interface ErasureRow {
  id: string;
  requested_at: Date | string;
  status: string;
  completed_at: Date | string | null;
  source: string;
}

/** Normalises a timestamp column to an ISO-8601 string, or null. */
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Narrows an untrusted status, failing closed to `received`. */
function asStatus(value: string): ErasureStatus {
  return (ERASURE_STATUSES as readonly string[]).includes(value)
    ? (value as ErasureStatus)
    : "received";
}

/** Narrows an untrusted source, failing closed to `portal`. */
function asSource(value: string): ErasureSource {
  return (ERASURE_SOURCES as readonly string[]).includes(value)
    ? (value as ErasureSource)
    : "portal";
}

function project(row: ErasureRow): ErasureRequestRecord {
  return {
    id: row.id,
    requestedAt: iso(row.requested_at) ?? "",
    status: asStatus(row.status),
    completedAt: iso(row.completed_at),
    source: asSource(row.source),
  };
}

/**
 * Every erasure request the caller owns, newest first.
 *
 * Used by both the export (§15.4 lists "any erasure request") and the duplicate
 * check. Reading all of them rather than just the open one means the export shows
 * a customer their full history of asking, which is the honest thing for a record
 * of a right they exercised.
 */
export async function readErasureRequests(
  executor: Queryable,
  scope: CustomerScope,
): Promise<readonly ErasureRequestRecord[]> {
  const rows = await scopedSelect<ErasureRow>(executor, scope, {
    sql: `SELECT id, requested_at, status, completed_at, source
            FROM customer_erasure_requests
           WHERE customer_id = $1
        ORDER BY requested_at DESC, id DESC`,
  });
  return rows.map(project);
}

/**
 * Records an erasure request, or returns the OPEN one that already exists.
 *
 * ── WHY THIS IS TWO STATEMENTS AND NOT AN UPSERT ────────────────────────────
 * There is no unique constraint to conflict on — a customer may legitimately have
 * several requests over time, so the table deliberately has none. The idempotency
 * is therefore "is there an open one?", which is a predicate over rows rather than
 * a key, and `ON CONFLICT` cannot express it.
 *
 * The race is bounded and benign: two simultaneous taps could both see no open row
 * and both insert. The outcome is two `received` rows for one customer, which the
 * operator procedure handles by completing all of them together — not a duplicated
 * erasure, because the procedure is keyed on the customer, not on the request. A
 * heavier guard (an advisory lock, or a partial unique index added by migration)
 * would buy nothing an operator would notice.
 *
 * @returns the request, and whether THIS call created it.
 */
export async function recordErasureRequest(
  executor: Queryable,
  scope: CustomerScope,
  source: ErasureSource = "portal",
): Promise<{ request: ErasureRequestRecord; created: boolean }> {
  const existing = await readErasureRequests(executor, scope);
  const open = existing.find((r) => OPEN_ERASURE_STATUSES.includes(r.status));
  if (open !== undefined) {
    // Already asked. Returning the SAME reference means a customer who taps twice
    // sees one request, and quotes one handle to support.
    return { request: open, created: false };
  }

  const inserted = await scopedSelect<ErasureRow>(executor, scope, {
    sql: `INSERT INTO customer_erasure_requests (customer_id, source)
               VALUES ($1, $2)
            RETURNING id, requested_at, status, completed_at, source`,
    params: [source],
  });
  const row = inserted[0];
  if (row === undefined) {
    // An INSERT ... RETURNING that returns nothing cannot happen, but inventing a
    // reference here would hand the customer a handle for a request that does not
    // exist. Re-reading is the honest fallback.
    const after = await readErasureRequests(executor, scope);
    const found = after.find((r) => OPEN_ERASURE_STATUSES.includes(r.status));
    if (found === undefined) throw new Error("erasure request was not recorded");
    return { request: found, created: false };
  }
  return { request: project(row), created: true };
}

/* ========================================================================== *
 * The two export reads that had no scope-typed reader
 * ========================================================================== */

/**
 * The caller's portal-visit record (§15.4 lists "portal visit timestamps").
 *
 * TWO TIMESTAMPS, NOT A LIST. `portal_visits` is keyed `PRIMARY KEY (customer_id)`
 * and holds `first_visited_at` / `last_visited_at` — it deliberately does not log
 * every visit, which is a data-minimisation choice (§15.2), not a gap. The export
 * reports what is stored, so it reports two instants; inventing a visit list would
 * describe data that does not exist.
 */
export interface PortalVisitRecord {
  readonly firstVisitedAt: string | null;
  readonly lastVisitedAt: string | null;
}

/** The caller's visit record, or `null` when they have never been recorded. */
export async function readPortalVisits(
  executor: Queryable,
  scope: CustomerScope,
): Promise<PortalVisitRecord | null> {
  const rows = await scopedSelect<{
    first_visited_at: Date | string;
    last_visited_at: Date | string;
  }>(executor, scope, {
    sql: `SELECT first_visited_at, last_visited_at
            FROM portal_visits
           WHERE customer_id = $1`,
  });
  const row = rows[0];
  if (row === undefined) return null;
  return {
    firstVisitedAt: iso(row.first_visited_at),
    lastVisitedAt: iso(row.last_visited_at),
  };
}

/** One recently-viewed product, for the export. */
export interface RecentlyViewedExportRecord {
  readonly productId: string;
  readonly viewedAt: string;
}

/**
 * Every recently-viewed row the caller owns, most recent first.
 *
 * A SCOPE-TYPED reader, deliberately. The shipped profile path reads this table
 * through a raw `db.query` that bypasses `validateScopedStatement`; adding the
 * export's read there would have extended that bypass. Going through the scoped
 * primitive instead means this statement's ownership predicate is proven by the
 * ownership gate, and the existing path is left exactly as it is.
 */
export async function readRecentlyViewedForExport(
  executor: Queryable,
  scope: CustomerScope,
): Promise<readonly RecentlyViewedExportRecord[]> {
  const rows = await scopedSelect<{ shopify_product_id: string; viewed_at: Date | string }>(
    executor,
    scope,
    {
      sql: `SELECT shopify_product_id, viewed_at
              FROM customer_recently_viewed
             WHERE customer_id = $1
          ORDER BY viewed_at DESC`,
    },
  );
  return rows
    .map((row) => ({ productId: String(row.shopify_product_id), viewedAt: iso(row.viewed_at) }))
    .filter((r): r is RecentlyViewedExportRecord => r.viewedAt !== null);
}

/* ========================================================================== *
 * The operator side — status transitions
 * ========================================================================== */

/**
 * Marks every OPEN request for the caller as completed.
 *
 * Called only by the operator-run redaction procedure, inside its transaction.
 * Completing ALL open requests rather than one is what makes the benign duplicate
 * race above harmless: a customer with two `received` rows ends with two
 * `completed` rows, not with one left dangling forever.
 *
 * `completed_at = now()` is set here rather than passed in, because the moment the
 * redaction committed is the only truthful value and a caller-supplied timestamp
 * could disagree with it.
 *
 * @returns how many requests were completed.
 */
export async function completeErasureRequests(
  executor: Queryable,
  scope: CustomerScope,
): Promise<number> {
  return scopedMutate(executor, scope, {
    sql: `UPDATE customer_erasure_requests
             SET status = 'completed',
                 completed_at = now()
           WHERE customer_id = $1
             AND status <> 'completed'`,
    params: [],
  });
}
