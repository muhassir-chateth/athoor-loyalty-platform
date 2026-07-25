/**
 * Append-only ledger repository (task 2.1).
 *
 * The `ledger_entries` table is the single, immutable source of truth for every
 * point movement (design.md "Data Models"; Requirement 1). This repository is
 * the ONLY sanctioned writer to that table and it deliberately exposes NO way
 * to UPDATE or DELETE an existing row — the append-only contract of
 * Requirement 1.6. It enforces, before any row is written:
 *
 *   - exactly one signed-integer entry per movement, recording entry type,
 *     amount, reason, customer id, and timestamp (Req 1.1);
 *   - earn_* movements are strictly positive (Req 1.4);
 *   - spend / clawback / expire movements are strictly negative (Req 1.5);
 *   - on append failure the originating operation is rejected and the ledger is
 *     left unchanged (Req 1.8) — a single INSERT is atomic, so a failed append
 *     writes nothing.
 *
 * Balance / spendable projection and FIFO lot consumption are NOT implemented
 * here; they belong to task 2.3. This repository only owns the append + the
 * append-only guards.
 *
 * DB access is abstracted behind {@link Queryable} (satisfied by a `pg` Pool or
 * a PoolClient), so an append can participate in a caller's transaction and so
 * the validation/append-only logic is testable without a live database.
 *
 * SAFETY: no live/production system is touched by defining this module. It
 * issues SQL only when a caller passes a real Pool/PoolClient at runtime.
 */
import type { QueryResult, QueryResultRow } from "pg";

/**
 * The nine ledger entry types, exactly as defined in the design schema comment
 * on `ledger_entries.entry_type`.
 */
export const LEDGER_ENTRY_TYPES = [
  "earn_signup",
  "earn_order",
  "earn_first_purchase",
  "earn_referral",
  "spend",
  "clawback",
  "expire",
  "adjust",
  "migration",
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** Entry types that represent an earning — their point amount is strictly > 0 (Req 1.4). */
export const EARN_ENTRY_TYPES: readonly LedgerEntryType[] = [
  "earn_signup",
  "earn_order",
  "earn_first_purchase",
  "earn_referral",
];

/** Entry types that represent a debit — their point amount is strictly < 0 (Req 1.5). */
export const DEBIT_ENTRY_TYPES: readonly LedgerEntryType[] = ["spend", "clawback", "expire"];

const ENTRY_TYPE_SET = new Set<string>(LEDGER_ENTRY_TYPES);
const EARN_TYPE_SET = new Set<string>(EARN_ENTRY_TYPES);
const DEBIT_TYPE_SET = new Set<string>(DEBIT_ENTRY_TYPES);

/**
 * The minimal database surface the repository needs. A `pg` Pool and PoolClient
 * both satisfy this, letting an append run standalone or inside a transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** Input for a single append. `points` is a signed, non-zero, safe integer. */
export interface AppendEntryInput {
  customerId: string;
  entryType: LedgerEntryType;
  /** Signed point amount: positive = credit, negative = debit. */
  points: number;
  reason: string;
  /** Shopify order id when the movement is order-attributable. */
  orderReference?: number | null;
  /** Links a spend/expire back to the point lot consumed. */
  pointLotId?: string | null;
  /** Links a spend to its redemption. */
  redemptionId?: string | null;
  /** Shopify webhook id for traceability. */
  sourceEventId?: string | null;
}

/** A persisted ledger row, mapped from `ledger_entries`. */
export interface LedgerEntry {
  id: string;
  customerId: string;
  entryType: LedgerEntryType;
  points: number;
  reason: string;
  orderReference: number | null;
  pointLotId: string | null;
  redemptionId: string | null;
  sourceEventId: string | null;
  createdAt: Date;
}

/** Stable machine-readable error codes surfaced to callers. */
export const LEDGER_ERROR_CODES = {
  appendOnly: "ledger_append_only",
  invalidEntry: "ledger_invalid_entry",
  appendFailed: "ledger_append_failed",
} as const;

/**
 * Thrown when a caller attempts to modify or delete an existing ledger row.
 * The ledger is append-only; the row store is left unchanged (Req 1.6).
 */
export class AppendOnlyViolationError extends Error {
  readonly code = LEDGER_ERROR_CODES.appendOnly;
  constructor(operation: string) {
    super(
      `The ledger is append-only: '${operation}' on an existing ledger entry is not permitted. ` +
        `Record a compensating entry (e.g. 'adjust') instead.`,
    );
    this.name = "AppendOnlyViolationError";
  }
}

/** Thrown when an append is rejected for violating the entry rules (Req 1.1/1.4/1.5). */
export class LedgerValidationError extends Error {
  readonly code = LEDGER_ERROR_CODES.invalidEntry;
  constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

/**
 * Thrown when the underlying append fails (Req 1.8). Because an append is a
 * single INSERT, a failure leaves the ledger unchanged; the originating
 * operation is rejected by propagating this error.
 */
export class LedgerAppendError extends Error {
  readonly code = LEDGER_ERROR_CODES.appendFailed;
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LedgerAppendError";
    this.cause = cause;
  }
}

const INSERT_SQL = `
  INSERT INTO ledger_entries
    (customer_id, entry_type, points, reason, order_reference, point_lot_id, redemption_id, source_event_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING id, customer_id, entry_type, points, reason,
            order_reference, point_lot_id, redemption_id, source_event_id, created_at
`;

/**
 * Validates an append request against the ledger entry rules. Throws
 * {@link LedgerValidationError} on any violation; returns nothing on success.
 *
 * Rules enforced (Requirement 1):
 *  - a recognised entry type (Req 1.1);
 *  - a non-empty reason and a customer id (Req 1.1);
 *  - a signed, non-zero, safe integer amount — a movement of zero is not a
 *    movement (Req 1.1);
 *  - earn_* strictly greater than zero (Req 1.4);
 *  - spend / clawback / expire strictly less than zero (Req 1.5).
 *
 * `adjust` and `migration` may carry either sign (an adjust can reverse a spend;
 * a migration seeds a positive opening balance) but must still be a non-zero
 * integer.
 */
export function validateAppendEntry(entry: AppendEntryInput): void {
  if (typeof entry.customerId !== "string" || entry.customerId.trim() === "") {
    throw new LedgerValidationError("A ledger entry requires a customer id.");
  }

  if (!ENTRY_TYPE_SET.has(entry.entryType)) {
    throw new LedgerValidationError(
      `Unknown ledger entry type '${String(entry.entryType)}'. ` +
        `Expected one of: ${LEDGER_ENTRY_TYPES.join(", ")}.`,
    );
  }

  if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
    throw new LedgerValidationError("A ledger entry requires a non-empty reason.");
  }

  if (typeof entry.points !== "number" || !Number.isInteger(entry.points)) {
    throw new LedgerValidationError(
      `A ledger entry amount must be a signed integer; received ${String(entry.points)}.`,
    );
  }

  if (!Number.isSafeInteger(entry.points)) {
    throw new LedgerValidationError(
      "A ledger entry amount must be within the safe integer range.",
    );
  }

  if (entry.points === 0) {
    throw new LedgerValidationError(
      "A ledger entry records a point movement and its amount must be non-zero.",
    );
  }

  if (EARN_TYPE_SET.has(entry.entryType) && entry.points <= 0) {
    throw new LedgerValidationError(
      `Earn entry '${entry.entryType}' must record a point amount strictly greater than zero ` +
        `(Requirement 1.4); received ${entry.points}.`,
    );
  }

  if (DEBIT_TYPE_SET.has(entry.entryType) && entry.points >= 0) {
    throw new LedgerValidationError(
      `Entry '${entry.entryType}' must record a point amount strictly less than zero ` +
        `(Requirement 1.5); received ${entry.points}.`,
    );
  }
}

interface LedgerRow extends QueryResultRow {
  id: string;
  customer_id: string;
  entry_type: string;
  points: string | number;
  reason: string;
  order_reference: string | number | null;
  point_lot_id: string | null;
  redemption_id: string | null;
  source_event_id: string | null;
  created_at: Date;
}

/** Parses a BIGINT column (`pg` returns it as a string) into a safe integer. */
function parseBigIntColumn(value: string | number | null, column: string): number {
  if (value === null) {
    throw new LedgerAppendError(`Expected a value for '${column}' in the returned ledger row.`);
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new LedgerAppendError(
      `Ledger column '${column}' value '${value}' is outside the safe integer range.`,
    );
  }
  return n;
}

function mapRow(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    customerId: row.customer_id,
    entryType: row.entry_type as LedgerEntryType,
    points: parseBigIntColumn(row.points, "points"),
    reason: row.reason,
    orderReference:
      row.order_reference === null ? null : parseBigIntColumn(row.order_reference, "order_reference"),
    pointLotId: row.point_lot_id,
    redemptionId: row.redemption_id,
    sourceEventId: row.source_event_id,
    createdAt: row.created_at,
  };
}

/**
 * Append-only repository for `ledger_entries`.
 *
 * Construct with a `pg` Pool; pass a PoolClient to {@link append} to enrol the
 * append in an ongoing transaction. There are intentionally no update/delete
 * methods — {@link update} and {@link remove} exist solely to reject such
 * attempts with an append-only error (Req 1.6).
 */
export class LedgerRepository {
  constructor(private readonly pool: Queryable) {}

  /**
   * Appends exactly one signed-integer ledger entry (Req 1.1). Validates the
   * entry first (Req 1.4/1.5); on any DB failure the append writes nothing and
   * a {@link LedgerAppendError} is thrown, leaving the ledger unchanged (Req 1.8).
   *
   * @param entry    the movement to record.
   * @param executor optional Pool/PoolClient to run within (defaults to the
   *                 repository's pool). Pass a transaction's client so the
   *                 append commits/rolls back atomically with the caller.
   */
  async append(entry: AppendEntryInput, executor: Queryable = this.pool): Promise<LedgerEntry> {
    validateAppendEntry(entry);

    let result: QueryResult<LedgerRow>;
    try {
      result = await executor.query<LedgerRow>(INSERT_SQL, [
        entry.customerId,
        entry.entryType,
        entry.points,
        entry.reason,
        entry.orderReference ?? null,
        entry.pointLotId ?? null,
        entry.redemptionId ?? null,
        entry.sourceEventId ?? null,
      ]);
    } catch (cause) {
      // A single INSERT is atomic: a failed append persists nothing, so the
      // ledger is unchanged and the originating operation is rejected (Req 1.8).
      throw new LedgerAppendError(
        `Failed to append ${entry.entryType} entry for customer ${entry.customerId}; ` +
          `the ledger is unchanged.`,
        cause,
      );
    }

    const row = result.rows[0];
    if (!row) {
      throw new LedgerAppendError("Ledger append returned no row; the append did not persist.");
    }
    return mapRow(row);
  }

  /**
   * Append-only guard (Req 1.6). The ledger never mutates an existing row;
   * always throws {@link AppendOnlyViolationError}. Use a compensating `adjust`
   * entry via {@link append} to reverse a prior movement.
   */
  update(): never {
    throw new AppendOnlyViolationError("update");
  }

  /**
   * Append-only guard (Req 1.6). The ledger never deletes an existing row;
   * always throws {@link AppendOnlyViolationError}.
   */
  remove(): never {
    throw new AppendOnlyViolationError("delete");
  }
}
