/**
 * Portal-visit state (task 14.6).
 *
 * Implements the Profile/Preferences responsibility of tracking first-visit vs
 * returning-member portal state, exposed by the design as
 * `ProfileService.markPortalVisit(customerId): Promise<{ firstVisit: boolean }>`
 * and surfaced over the versioned API as `POST /v1/profile/visit`
 * (design.md "Component 9: Profile / Preferences Service" and the `/v1` route
 * table). It backs the private-client portal's first-visit welcome vs
 * returning-member experience (task 16.1).
 *
 * Contract (Requirements 16.1, 16.2):
 *   - WHEN no prior portal visit is recorded for the customer, marking a visit
 *     records the visit (both `first_visited_at` and `last_visited_at`) and
 *     reports `firstVisit === true` — the portal shows the first-visit welcome
 *     (Req 16.1).
 *   - WHEN a prior visit is already recorded, marking a visit updates only
 *     `last_visited_at` (the recorded first visit is preserved) and reports
 *     `firstVisit === false` — the portal shows the returning-member experience
 *     that omits the welcome (Req 16.2).
 *
 * OFF-LEDGER / ADDITIVE: this operates SOLELY on the `portal_visits` table
 * (task 14.1), which lives in the Profile/Preferences store entirely separate
 * from `ledger_entries`. Marking a visit writes nothing to the ledger and never
 * reads or changes any customer's Balance or Spendable_Balance (Req 17.3 /
 * Property 13). It never calls the Shopify Admin API.
 *
 * CONCURRENCY: the visit is recorded with a single atomic
 * `INSERT ... ON CONFLICT (customer_id) DO UPDATE` upsert, and first-vs-returning
 * is derived from Postgres' `xmax = 0` insert/update discriminator on the same
 * statement. Because it is one statement, two concurrent first visits cannot
 * both be reported as `firstVisit === true`: exactly one performs the INSERT
 * (xmax = 0) and the other takes the DO UPDATE branch (xmax <> 0).
 *
 * DB access is abstracted behind {@link Queryable} (satisfied by a `pg` Pool or
 * a PoolClient), so a visit can participate in a caller's transaction and the
 * logic is testable without a live database.
 *
 * SAFETY: defining this module touches no live/production system. It issues SQL
 * only when a caller passes a real Pool/PoolClient at runtime; all logic is
 * unit-tested against an in-memory fake Queryable, so no live system is touched
 * during verification.
 */
import type { QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";

/**
 * The result of marking a portal visit.
 *
 * `firstVisit` is the sole field of the design's `/v1/profile/visit` response
 * contract (`{ firstVisit: boolean }`); the recorded timestamps are additive,
 * non-breaking extras callers may use for personalisation/auditing.
 */
export interface PortalVisitResult {
  /**
   * True iff this call recorded the customer's FIRST portal visit (Req 16.1);
   * false for a returning member whose visit was already recorded (Req 16.2).
   */
  firstVisit: boolean;
  /** When the customer's first visit was recorded (unchanged on returning visits). */
  firstVisitedAt: Date;
  /** When this (the most recent) visit was recorded. */
  lastVisitedAt: Date;
}

/**
 * Atomic upsert into the off-ledger `portal_visits` table.
 *
 * On first visit the row is INSERTed (both timestamps default to `now()`); on a
 * returning visit the conflicting row's `last_visited_at` is advanced to `now()`
 * while `first_visited_at` is preserved. `(xmax = 0) AS first_visit` is
 * Postgres' idiomatic way to tell an INSERT (xmax = 0 ⇒ true) from a
 * DO UPDATE (xmax <> 0 ⇒ false) on the same statement.
 */
const MARK_VISIT_SQL = `
  INSERT INTO portal_visits (customer_id)
  VALUES ($1)
  ON CONFLICT (customer_id)
  DO UPDATE SET last_visited_at = now()
  RETURNING (xmax = 0) AS first_visit, first_visited_at, last_visited_at
`;

/** Stable machine-readable error codes surfaced to callers. */
export const PORTAL_VISIT_ERROR_CODES = {
  invalidCustomer: "portal_visit_invalid_customer",
  markFailed: "portal_visit_mark_failed",
} as const;

/** Thrown when a caller supplies an empty/invalid customer id. */
export class PortalVisitValidationError extends Error {
  readonly code = PORTAL_VISIT_ERROR_CODES.invalidCustomer;
  constructor(message: string) {
    super(message);
    this.name = "PortalVisitValidationError";
  }
}

/** Thrown when the visit upsert fails; the visit state is left unchanged. */
export class PortalVisitMarkError extends Error {
  readonly code = PORTAL_VISIT_ERROR_CODES.markFailed;
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PortalVisitMarkError";
    this.cause = cause;
  }
}

interface PortalVisitRow extends QueryResultRow {
  first_visit: boolean;
  first_visited_at: Date;
  last_visited_at: Date;
}

/**
 * Records a portal visit for a customer and reports whether it was their first
 * (Requirements 16.1, 16.2).
 *
 * The first call for a customer records the visit and returns
 * `firstVisit === true`; every subsequent call advances `last_visited_at`,
 * preserves the original `first_visited_at`, and returns `firstVisit === false`.
 * This is off-ledger and never affects the customer's Balance (Req 17.3).
 *
 * @param customerId the local `customers.id` opening the portal.
 * @param executor   Pool/PoolClient to run on. Pass a transaction's client to
 *                   enrol the visit in an ongoing transaction.
 * @throws {@link PortalVisitValidationError} when `customerId` is empty/blank.
 * @throws {@link PortalVisitMarkError} when the upsert fails (state unchanged).
 */
export async function markPortalVisit(
  customerId: string,
  executor: Queryable,
): Promise<PortalVisitResult> {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    throw new PortalVisitValidationError("Marking a portal visit requires a customer id.");
  }

  let row: PortalVisitRow | undefined;
  try {
    const result = await executor.query<PortalVisitRow>(MARK_VISIT_SQL, [customerId]);
    row = result.rows[0];
  } catch (cause) {
    // The upsert is a single statement: a failure persists nothing, so the
    // portal-visit state is unchanged and the operation is rejected.
    throw new PortalVisitMarkError(
      `Failed to mark a portal visit for customer ${customerId}; visit state is unchanged.`,
      cause,
    );
  }

  if (!row) {
    throw new PortalVisitMarkError(
      "Marking a portal visit returned no row; the visit did not persist.",
    );
  }

  return {
    firstVisit: row.first_visit === true,
    firstVisitedAt: row.first_visited_at,
    lastVisitedAt: row.last_visited_at,
  };
}
