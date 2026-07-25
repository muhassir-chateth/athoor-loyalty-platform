/**
 * Admin migration / reconciliation operations (task 17.2, Requirements 10.7, 10.9).
 *
 * Requirement 10.7: WHEN an Admin_User initiates a MIGRATION or RECONCILIATION
 * operation, THE Loyalty_Service SHALL execute the operation and return a
 * completion result reporting the count of records PROCESSED and the count of
 * records that FAILED.
 *
 * Requirement 10.9: recording a migration or reconciliation operation SHALL
 * create an immutable audit-trail record capturing the acting Admin_User
 * identifier, the operation type, and the timestamp (there is no single
 * affected customer for these system-wide operations, so `affectedCustomerId`
 * is null).
 *
 * This module is the admin-facing seam over the existing migration (task 7) and
 * reconciliation (task 12.1) jobs. Those jobs already return rich results; the
 * admin surface only needs the {processed, failed} summary Req 10.7 mandates,
 * so this module:
 *   - defines the minimal {@link AdminOperationResult} the endpoints return;
 *   - provides pure adapters ({@link summarizeReconciliation},
 *     {@link summarizeMigration}) that fold the jobs' detailed results into that
 *     summary, so the mapping is testable in isolation and reused wherever the
 *     jobs run;
 *   - exposes an injectable {@link AdminOperationsService} that runs an
 *     operation AND writes the Req-10.9 audit record, with:
 *       - {@link CallbackAdminOperationsService} — production: wraps the real
 *         job runners (injected as callbacks so this module stays decoupled
 *         from the jobs' construction-heavy dependencies) + a real audit
 *         recorder;
 *       - {@link InMemoryAdminOperationsService} — default/local/tests: returns
 *         configurable counts and records to an in-memory audit recorder, so the
 *         admin surface boots and is exercisable WITHOUT live Postgres or a real
 *         migration/reconciliation run.
 *
 * SAFETY: defining this module touches no live/production system. The in-memory
 * service performs no migration/reconciliation; the callback-backed service
 * runs a real job ONLY when production wires real runners at deploy time. A
 * migration/reconciliation is a gated operational step, never triggered by a
 * test or local run here.
 */
import {
  InMemoryAuditTrailRecorder,
  type AuditRecord,
  type AuditTrailRecorder,
} from "./auditTrail.js";
import type { AdminCtx } from "./adminAuth.js";

/** The two admin-initiated system operations (Req 10.7). */
export type AdminOperationType = "migration" | "reconciliation";

/** The {processed, failed} completion summary Req 10.7 mandates. */
export interface OperationCounts {
  /** Number of records the operation processed. */
  processed: number;
  /** Number of records that failed. */
  failed: number;
}

/** The completion result returned by an admin operation (Req 10.7), plus its audit link. */
export interface AdminOperationResult extends OperationCounts {
  /** Which operation ran. */
  operation: AdminOperationType;
  /** The immutable audit record created for the operation (Req 10.9). */
  audit: AuditRecord;
}

/* -------------------------------------------------------------------------- */
/* Pure adapters: fold the existing jobs' detailed results → {processed,failed}.*/
/* -------------------------------------------------------------------------- */

/**
 * The reconciliation shape this adapter needs (a structural subset of
 * `ReconciliationResult` from task 12.1), so this module does not import the
 * reconciliation types directly and stays decoupled.
 */
export interface ReconciliationLike {
  processed: number;
  customers: ReadonlyArray<{ status: string }>;
}

/**
 * Folds a reconciliation run into {processed, failed} (Req 10.7). `processed`
 * is the number of customers the pass visited; `failed` is those it could not
 * reconcile because the customer no longer exists
 * (`status === "skipped_unknown_customer"`). A reconciled customer — whether or
 * not drift was repaired — is a SUCCESS, so it is never counted as failed.
 */
export function summarizeReconciliation(result: ReconciliationLike): OperationCounts {
  const failed = result.customers.filter((c) => c.status === "skipped_unknown_customer").length;
  return { processed: result.processed, failed };
}

/**
 * The migration shape this adapter needs (a structural subset of `M1Result`
 * from task 7.2). The discriminated `status` tells success from the two aborted
 * outcomes.
 */
export type MigrationLike =
  | { status: "backfilled"; processed: number }
  | { status: "aborted_reconciliation_mismatch"; mismatches: ReadonlyArray<unknown> }
  | { status: "aborted_backfill_error"; detail: unknown };

/**
 * Folds a migration (M1) run into {processed, failed} (Req 10.7):
 *   - `backfilled`                       → all `processed` succeeded, `failed` 0;
 *   - `aborted_reconciliation_mismatch`  → the run is rolled back; `processed` 0
 *                                          and `failed` = number of mismatches
 *                                          (the records that did not reconcile);
 *   - `aborted_backfill_error`           → the run is rolled back on a data
 *                                          anomaly; `processed` 0, `failed` 1.
 */
export function summarizeMigration(result: MigrationLike): OperationCounts {
  switch (result.status) {
    case "backfilled":
      return { processed: result.processed, failed: 0 };
    case "aborted_reconciliation_mismatch":
      return { processed: 0, failed: result.mismatches.length };
    case "aborted_backfill_error":
      return { processed: 0, failed: 1 };
  }
}

/* -------------------------------------------------------------------------- */
/* Service interface + implementations.                                        */
/* -------------------------------------------------------------------------- */

/**
 * Runs an admin-initiated migration/reconciliation and records the Req-10.9
 * audit entry, returning the {@link AdminOperationResult}. Injectable so the
 * routes depend on an interface with an in-memory default.
 */
export interface AdminOperationsService {
  runMigration(admin: AdminCtx): Promise<AdminOperationResult>;
  runReconciliation(admin: AdminCtx): Promise<AdminOperationResult>;
}

/** Writes the immutable audit record for a completed operation (Req 10.9). */
async function recordOperationAudit(
  audit: AuditTrailRecorder,
  admin: AdminCtx,
  operation: AdminOperationType,
  counts: OperationCounts,
): Promise<AuditRecord> {
  return audit.record({
    adminUserId: admin.adminUserId,
    operationType: operation,
    // Migration/reconciliation are system-wide: no single affected customer.
    affectedCustomerId: null,
    detail: {
      processed: counts.processed,
      failed: counts.failed,
      operationTimestamp: new Date().toISOString(),
    },
  });
}

/**
 * Production service: runs the real migration/reconciliation job (supplied as a
 * callback that already yields {processed, failed} — use the pure adapters
 * above to fold the jobs' detailed results) and writes the audit record.
 *
 * Callbacks keep this module decoupled from the jobs' heavy construction
 * (an M1 run needs the M0 backup + repo + transactor; a reconciliation needs
 * the metafield writer + transactor); the wiring layer composes those and
 * hands over a simple runner.
 */
export class CallbackAdminOperationsService implements AdminOperationsService {
  constructor(
    private readonly deps: {
      audit: AuditTrailRecorder;
      runMigration: () => Promise<OperationCounts>;
      runReconciliation: () => Promise<OperationCounts>;
    },
  ) {}

  async runMigration(admin: AdminCtx): Promise<AdminOperationResult> {
    const counts = await this.deps.runMigration();
    const audit = await recordOperationAudit(this.deps.audit, admin, "migration", counts);
    return { operation: "migration", ...counts, audit };
  }

  async runReconciliation(admin: AdminCtx): Promise<AdminOperationResult> {
    const counts = await this.deps.runReconciliation();
    const audit = await recordOperationAudit(this.deps.audit, admin, "reconciliation", counts);
    return { operation: "reconciliation", ...counts, audit };
  }
}

/**
 * In-memory service for local runs and tests. Returns configurable
 * {processed, failed} counts (default `{0, 0}`) and records the Req-10.9 audit
 * entry to an in-memory recorder, so the admin operation endpoints work
 * end-to-end without any infrastructure and without running a real migration.
 */
export class InMemoryAdminOperationsService implements AdminOperationsService {
  readonly auditRecorder: InMemoryAuditTrailRecorder;
  private readonly migrationCounts: OperationCounts;
  private readonly reconciliationCounts: OperationCounts;

  constructor(
    opts: {
      auditRecorder?: InMemoryAuditTrailRecorder;
      migrationCounts?: OperationCounts;
      reconciliationCounts?: OperationCounts;
    } = {},
  ) {
    this.auditRecorder = opts.auditRecorder ?? new InMemoryAuditTrailRecorder();
    this.migrationCounts = opts.migrationCounts ?? { processed: 0, failed: 0 };
    this.reconciliationCounts = opts.reconciliationCounts ?? { processed: 0, failed: 0 };
  }

  async runMigration(admin: AdminCtx): Promise<AdminOperationResult> {
    const audit = await recordOperationAudit(
      this.auditRecorder,
      admin,
      "migration",
      this.migrationCounts,
    );
    return { operation: "migration", ...this.migrationCounts, audit };
  }

  async runReconciliation(admin: AdminCtx): Promise<AdminOperationResult> {
    const audit = await recordOperationAudit(
      this.auditRecorder,
      admin,
      "reconciliation",
      this.reconciliationCounts,
    );
    return { operation: "reconciliation", ...this.reconciliationCounts, audit };
  }
}

/** Serialisable response body for an admin operation endpoint (Req 10.7/10.9). */
export interface AdminOperationResponse {
  operation: AdminOperationType;
  processed: number;
  failed: number;
  audit: {
    id: string;
    adminUserId: string;
    operationType: string;
    timestamp: string;
  };
}

/** Maps an {@link AdminOperationResult} to its HTTP response body. */
export function toAdminOperationResponse(result: AdminOperationResult): AdminOperationResponse {
  return {
    operation: result.operation,
    processed: result.processed,
    failed: result.failed,
    audit: {
      id: result.audit.id,
      adminUserId: result.audit.adminUserId,
      operationType: result.audit.operationType,
      timestamp: result.audit.createdAt.toISOString(),
    },
  };
}
