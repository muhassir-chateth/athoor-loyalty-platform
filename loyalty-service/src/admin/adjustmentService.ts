/**
 * Admin adjustment service (task 17.1).
 *
 * A thin, injectable seam between the admin HTTP routes and the adjustment /
 * manual-credit core logic ({@link applyAdjustment}, {@link grantManualCredit}).
 * Following the codebase convention (balance/history/profile sources), the
 * routes depend on an interface with an in-memory default so the service boots
 * and is exercisable WITHOUT live Postgres, while production injects a
 * ledger + audit backed implementation.
 *
 *   - {@link LedgerAdminAdjustmentService} — production: delegates to the core
 *     functions with a real {@link LedgerRepository}, {@link AuditTrailRecorder},
 *     and transactor (all Postgres-backed at deploy time).
 *   - {@link InMemoryAdminAdjustmentService} — default/local/tests: reuses the
 *     SAME validation + action guards as the core, appending to an in-memory
 *     ledger and an {@link InMemoryAuditTrailRecorder}. Semantics (reason 1–500,
 *     signed/positive integer amounts, manual-only actions, one ledger entry +
 *     one immutable audit record) are identical to production.
 *
 * SAFETY: neither implementation touches a live/production system on
 * construction. The Pg-backed path issues SQL only when a real Pool/PoolClient
 * is wired at runtime.
 */
import type { LedgerEntry, LedgerRepository } from "../ledger/repository.js";
import { InMemoryAuditTrailRecorder, type AuditTrailRecorder } from "./auditTrail.js";
import {
  applyAdjustment,
  grantManualCredit,
  validateReason,
  adminActorTag,
  InvalidActionError,
  InvalidAmountError,
  type AdjustmentDeps,
  type AdjustmentInput,
  type AdjustmentResult,
  type ManualCreditInput,
  type Transactor,
} from "./adjustments.js";
import type { AdminCtx } from "./adminAuth.js";

/** The admin adjustment operations the routes depend on. */
export interface AdminAdjustmentService {
  /** Apply a manual signed point adjustment (Req 10.2/10.3). */
  adjust(input: AdjustmentInput, admin: AdminCtx): Promise<AdjustmentResult>;
  /** Grant a manual credit for a non-automatable action (Req 10.4/10.8). */
  credit(input: ManualCreditInput, admin: AdminCtx): Promise<AdjustmentResult>;
}

/**
 * Production service: delegates to the adjustment/credit core with injected
 * ledger repository, audit recorder, and transactor.
 */
export class LedgerAdminAdjustmentService implements AdminAdjustmentService {
  constructor(private readonly deps: AdjustmentDeps) {}

  adjust(input: AdjustmentInput, admin: AdminCtx): Promise<AdjustmentResult> {
    return applyAdjustment(input, admin, this.deps);
  }

  credit(input: ManualCreditInput, admin: AdminCtx): Promise<AdjustmentResult> {
    return grantManualCredit(input, admin, this.deps);
  }
}

/**
 * Convenience factory building a {@link LedgerAdminAdjustmentService} from its
 * parts (used by the production wiring in index.ts / app deps).
 */
export function createLedgerAdminAdjustmentService(
  repo: LedgerRepository,
  audit: AuditTrailRecorder,
  transactor: Transactor,
): AdminAdjustmentService {
  return new LedgerAdminAdjustmentService({ repo, audit, transactor });
}

function assertNonZeroInteger(points: unknown): number {
  if (typeof points !== "number" || !Number.isInteger(points) || !Number.isSafeInteger(points)) {
    throw new InvalidAmountError("A signed integer point amount is required.");
  }
  if (points === 0) {
    throw new InvalidAmountError("An adjustment must record a non-zero point movement.");
  }
  return points;
}

/**
 * In-memory service for local runs and tests. Maintains an in-memory ledger and
 * an {@link InMemoryAuditTrailRecorder}, reusing the core validation so its
 * behaviour matches production. Fully functional (not fail-closed) so the admin
 * endpoints work end-to-end without any infrastructure.
 */
export class InMemoryAdminAdjustmentService implements AdminAdjustmentService {
  private readonly ledger: LedgerEntry[] = [];
  private seq = 0;
  readonly auditRecorder: InMemoryAuditTrailRecorder;

  constructor(auditRecorder: InMemoryAuditTrailRecorder = new InMemoryAuditTrailRecorder()) {
    this.auditRecorder = auditRecorder;
  }

  private appendLedger(
    customerId: string,
    points: number,
    reason: string,
    admin: AdminCtx,
  ): LedgerEntry {
    this.seq += 1;
    const entry: LedgerEntry = {
      id: `adjust-${this.seq}`,
      customerId,
      entryType: "adjust",
      points,
      reason,
      orderReference: null,
      pointLotId: null,
      redemptionId: null,
      sourceEventId: adminActorTag(admin.adminUserId),
      createdAt: new Date(),
    };
    this.ledger.push(entry);
    return entry;
  }

  async adjust(input: AdjustmentInput, admin: AdminCtx): Promise<AdjustmentResult> {
    const reason = validateReason(input.reason);
    const points = assertNonZeroInteger(input.points);
    const entry = this.appendLedger(input.customerId, points, reason, admin);
    const audit = await this.auditRecorder.record({
      adminUserId: admin.adminUserId,
      operationType: "adjustment",
      affectedCustomerId: input.customerId,
      ledgerEntryId: entry.id,
      detail: { points, reason, adjustmentTimestamp: entry.createdAt.toISOString() },
    });
    return { entry, audit };
  }

  async credit(input: ManualCreditInput, admin: AdminCtx): Promise<AdjustmentResult> {
    const reason = validateReason(input.reason);
    const action = typeof input.action === "string" ? input.action.trim() : "";
    if (action.length === 0) {
      throw new InvalidActionError("A manual credit must identify the action being credited.");
    }
    const points = assertNonZeroInteger(input.points);
    if (points < 0) {
      throw new InvalidAmountError("A manual credit must be a positive point amount.");
    }
    const entry = this.appendLedger(input.customerId, points, reason, admin);
    const audit = await this.auditRecorder.record({
      adminUserId: admin.adminUserId,
      operationType: "manual_credit",
      affectedCustomerId: input.customerId,
      ledgerEntryId: entry.id,
      detail: { points, action, reason, creditTimestamp: entry.createdAt.toISOString() },
    });
    return { entry, audit };
  }

  /** Read-only snapshot of the in-memory ledger (test helper). */
  entries(): readonly LedgerEntry[] {
    return [...this.ledger];
  }
}

/** Serialisable shape returned by the admin adjustment/credit endpoints. */
export interface AdjustmentResponse {
  entry: {
    id: string;
    customerId: string;
    entryType: string;
    points: number;
    reason: string;
    actingAdminUserId: string | null;
    timestamp: string;
  };
  audit: {
    id: string;
    adminUserId: string;
    operationType: string;
    affectedCustomerId: string | null;
    timestamp: string;
  };
}

/** Map a core {@link AdjustmentResult} to the HTTP response body. */
export function toAdjustmentResponse(result: AdjustmentResult): AdjustmentResponse {
  const { entry, audit } = result;
  const actingAdminUserId =
    entry.sourceEventId && entry.sourceEventId.startsWith("admin:")
      ? entry.sourceEventId.slice("admin:".length)
      : null;
  return {
    entry: {
      id: entry.id,
      customerId: entry.customerId,
      entryType: entry.entryType,
      points: entry.points,
      reason: entry.reason,
      actingAdminUserId,
      timestamp: entry.createdAt.toISOString(),
    },
    audit: {
      id: audit.id,
      adminUserId: audit.adminUserId,
      operationType: audit.operationType,
      affectedCustomerId: audit.affectedCustomerId,
      timestamp: audit.createdAt.toISOString(),
    },
  };
}
