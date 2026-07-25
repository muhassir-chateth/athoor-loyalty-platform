/**
 * Immutable admin audit trail (task 17.1, Requirement 10.9).
 *
 * Requirement 10.9: when the Loyalty_Service records any manual adjustment,
 * manual credit, migration, or reconciliation operation, it SHALL create an
 * immutable audit-trail record capturing the acting Admin_User identifier, the
 * operation type, the affected customer identifier (where applicable), and the
 * timestamp.
 *
 * This module owns that audit trail. It mirrors the append-only discipline of
 * the ledger repository (task 2.1): the recorder exposes ONLY an append —
 * there is deliberately no update/delete path, so a written audit record is
 * immutable. Records are written to the `admin_audit_log` table
 * (see migration `*_create-admin-audit-log.ts`).
 *
 * DB access is abstracted behind {@link Queryable} (a `pg` Pool or PoolClient),
 * so a record can participate in a caller's transaction — e.g. the same
 * transaction that appends the adjustment ledger entry — and so the recorder is
 * testable without a live database.
 *
 * SAFETY: defining this module touches no live/production system. It issues SQL
 * only when a caller passes a real Pool/PoolClient at runtime.
 */
import type { QueryResult, QueryResultRow } from "pg";

/** The four operation types that MUST produce an audit record (Req 10.9). */
export const AUDIT_OPERATION_TYPES = [
  "adjustment",
  "manual_credit",
  "migration",
  "reconciliation",
] as const;

export type AuditOperationType = (typeof AUDIT_OPERATION_TYPES)[number];

const OPERATION_TYPE_SET = new Set<string>(AUDIT_OPERATION_TYPES);

/**
 * A reserved actor id used when a migration/reconciliation is initiated by the
 * system (scheduler) rather than by a named Admin_User, so every audit record
 * is attributable to an actor (the `admin_user_id` column is NOT NULL).
 */
export const SYSTEM_ACTOR_ID = "system" as const;

/**
 * The minimal database surface the recorder needs. A `pg` Pool and PoolClient
 * both satisfy this, letting a record be written standalone or inside a
 * transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** Input for a single audit record append (Req 10.9). */
export interface AuditRecordInput {
  /** The acting Admin_User id, or {@link SYSTEM_ACTOR_ID} for a system op. */
  adminUserId: string;
  /** adjustment | manual_credit | migration | reconciliation. */
  operationType: AuditOperationType;
  /** The customer the operation touched, or null for a system-wide op. */
  affectedCustomerId?: string | null;
  /** Links a point-moving audit record to the exact ledger row it produced. */
  ledgerEntryId?: string | null;
  /** Free-form context (delta, reason, action, processed/failed counts, …). */
  detail?: Record<string, unknown>;
}

/** A persisted audit record, mapped from `admin_audit_log`. */
export interface AuditRecord {
  id: string;
  adminUserId: string;
  operationType: AuditOperationType;
  affectedCustomerId: string | null;
  ledgerEntryId: string | null;
  detail: Record<string, unknown>;
  createdAt: Date;
}

/** Stable machine-readable error code surfaced to callers. */
export const AUDIT_ERROR_CODES = {
  invalidRecord: "audit_invalid_record",
  appendFailed: "audit_append_failed",
} as const;

/** Thrown when an audit record is rejected for violating the record rules. */
export class AuditValidationError extends Error {
  readonly code = AUDIT_ERROR_CODES.invalidRecord;
  constructor(message: string) {
    super(message);
    this.name = "AuditValidationError";
  }
}

/** Thrown when the underlying audit append fails; nothing is persisted. */
export class AuditAppendError extends Error {
  readonly code = AUDIT_ERROR_CODES.appendFailed;
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AuditAppendError";
    this.cause = cause;
  }
}

/**
 * Append-only audit trail recorder. The single sanctioned interface for writing
 * audit records; it exposes ONLY {@link record}, so a written record is
 * immutable (Req 10.9).
 */
export interface AuditTrailRecorder {
  /** Append exactly one immutable audit record. */
  record(input: AuditRecordInput, executor?: Queryable): Promise<AuditRecord>;
}

/** Validates an audit record request. Throws {@link AuditValidationError}. */
export function validateAuditRecord(input: AuditRecordInput): void {
  if (typeof input.adminUserId !== "string" || input.adminUserId.trim() === "") {
    throw new AuditValidationError("An audit record requires an acting actor id.");
  }
  if (!OPERATION_TYPE_SET.has(input.operationType)) {
    throw new AuditValidationError(
      `Unknown audit operation type '${String(input.operationType)}'. ` +
        `Expected one of: ${AUDIT_OPERATION_TYPES.join(", ")}.`,
    );
  }
}

const INSERT_SQL = `
  INSERT INTO admin_audit_log
    (admin_user_id, operation_type, affected_customer_id, ledger_entry_id, detail)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING id, admin_user_id, operation_type, affected_customer_id,
            ledger_entry_id, detail, created_at
`;

interface AuditRow extends QueryResultRow {
  id: string;
  admin_user_id: string;
  operation_type: string;
  affected_customer_id: string | null;
  ledger_entry_id: string | null;
  detail: Record<string, unknown> | string | null;
  created_at: Date;
}

function mapRow(row: AuditRow): AuditRecord {
  const detail =
    row.detail === null
      ? {}
      : typeof row.detail === "string"
        ? (JSON.parse(row.detail) as Record<string, unknown>)
        : row.detail;
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    operationType: row.operation_type as AuditOperationType,
    affectedCustomerId: row.affected_customer_id,
    ledgerEntryId: row.ledger_entry_id,
    detail,
    createdAt: row.created_at,
  };
}

/**
 * Postgres-backed {@link AuditTrailRecorder}: appends one immutable row to
 * `admin_audit_log`. There is intentionally no update/delete method.
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing.
 */
export class PgAuditTrailRecorder implements AuditTrailRecorder {
  constructor(private readonly pool: Queryable) {}

  async record(input: AuditRecordInput, executor: Queryable = this.pool): Promise<AuditRecord> {
    validateAuditRecord(input);

    let result: QueryResult<AuditRow>;
    try {
      result = await executor.query<AuditRow>(INSERT_SQL, [
        input.adminUserId,
        input.operationType,
        input.affectedCustomerId ?? null,
        input.ledgerEntryId ?? null,
        JSON.stringify(input.detail ?? {}),
      ]);
    } catch (cause) {
      throw new AuditAppendError(
        `Failed to append ${input.operationType} audit record; nothing was persisted.`,
        cause,
      );
    }

    const row = result.rows[0];
    if (!row) {
      throw new AuditAppendError("Audit append returned no row; the record did not persist.");
    }
    return mapRow(row);
  }
}

/**
 * In-memory {@link AuditTrailRecorder} for local runs and tests: appends to an
 * internal array. Exposes read helpers so tests can assert the immutable trail
 * without a live Postgres. Never mutates a recorded entry.
 */
export class InMemoryAuditTrailRecorder implements AuditTrailRecorder {
  private readonly records: AuditRecord[] = [];
  private seq = 0;

  async record(input: AuditRecordInput, _executor?: Queryable): Promise<AuditRecord> {
    validateAuditRecord(input);
    this.seq += 1;
    const rec: AuditRecord = {
      id: `audit-${this.seq}`,
      adminUserId: input.adminUserId,
      operationType: input.operationType,
      affectedCustomerId: input.affectedCustomerId ?? null,
      ledgerEntryId: input.ledgerEntryId ?? null,
      // Defensive copy so the stored record cannot be mutated via the caller's ref.
      detail: { ...(input.detail ?? {}) },
      createdAt: new Date(),
    };
    // Freeze to make the immutability contract concrete in-memory too.
    Object.freeze(rec.detail);
    Object.freeze(rec);
    this.records.push(rec);
    return rec;
  }

  /** All recorded audit entries, in append order (read-only snapshot). */
  all(): readonly AuditRecord[] {
    return [...this.records];
  }

  /** Audit entries for a given customer, most-recent-first (task 17.2 read path). */
  forCustomer(customerId: string): readonly AuditRecord[] {
    return this.records.filter((r) => r.affectedCustomerId === customerId).reverse();
  }
}
