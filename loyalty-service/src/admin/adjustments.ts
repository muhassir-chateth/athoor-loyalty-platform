/**
 * Admin manual adjustments and manual credit (task 17.1,
 * Requirements 10.2, 10.3, 10.4, 10.8, 15.3, 15.4).
 *
 * Two admin operations live here, both producing exactly ONE `adjust` ledger
 * entry (the ledger's designated type for a manual movement) plus exactly ONE
 * immutable audit record (Req 10.9):
 *
 *   - {@link applyAdjustment} (Req 10.2/10.3): a signed integer point delta with
 *     a 1–500 char reason. Rejects a missing/empty/over-length reason, creating
 *     NO ledger entry and NO audit record.
 *
 *   - {@link grantManualCredit} (Req 10.4/10.8): a POSITIVE credit for a
 *     non-automatable action (e.g. an Instagram follow that no Shopify/partner
 *     API can verify — design.md Goals/Non-Goals). The action is only creditable
 *     through this manual path; the automated engine must refuse it — see
 *     {@link assertAutomatableAction} / {@link isManualOnlyAction} (Req 10.8).
 *
 * The acting Admin_User identifier is recorded (a) ON the ledger entry via the
 * existing `source_event_id` traceability column as `admin:<adminUserId>`, so
 * the entry itself carries who acted (Req 10.2/10.4), and (b) in the immutable
 * audit record (Req 10.9). The adjustment timestamp is the ledger entry's
 * `created_at`, and it is echoed in both the result and the audit detail.
 *
 * Both operations run the ledger append + audit append inside ONE transaction
 * (via the injected {@link Transactor}) so a failure of either leaves neither
 * behind — the ledger and audit trail stay consistent (Req 1.8).
 *
 * SAFETY: defining this module touches no live/production system. It issues SQL
 * only via the injected repository/recorder when a real Pool/PoolClient is
 * passed at runtime; the logic is unit-tested against fakes.
 */
import type { LedgerEntry, LedgerRepository, Queryable } from "../ledger/repository.js";
import { createExpiringPointLot } from "../ledger/pointLots.js";
import type { AuditRecord, AuditTrailRecorder } from "./auditTrail.js";
import type { AdminCtx } from "./adminAuth.js";

/** The inclusive reason length bounds for a manual adjustment/credit (Req 10.2/10.3/10.4). */
export const REASON_MIN_LENGTH = 1;
export const REASON_MAX_LENGTH = 500;

/** Stable machine-readable error codes surfaced to callers. */
export const ADJUSTMENT_ERROR_CODES = {
  invalidReason: "adjustment_invalid_reason",
  invalidAmount: "adjustment_invalid_amount",
  invalidAction: "credit_invalid_action",
  automatedGrantRejected: "automated_grant_rejected",
} as const;

/**
 * Thrown when a reason is missing/empty or exceeds 500 chars (Req 10.3). The
 * caller creates NO ledger entry and NO audit record and returns an
 * invalid-reason response.
 */
export class InvalidReasonError extends Error {
  readonly code = ADJUSTMENT_ERROR_CODES.invalidReason;
  constructor(message: string) {
    super(message);
    this.name = "InvalidReasonError";
  }
}

/** Thrown when a point amount is not a valid signed/positive integer as required. */
export class InvalidAmountError extends Error {
  readonly code = ADJUSTMENT_ERROR_CODES.invalidAmount;
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

/** Thrown when a manual credit does not identify a non-empty action. */
export class InvalidActionError extends Error {
  readonly code = ADJUSTMENT_ERROR_CODES.invalidAction;
  constructor(message: string) {
    super(message);
    this.name = "InvalidActionError";
  }
}

/**
 * Thrown when an AUTOMATED grant is attempted for an action that can only be
 * verified/credited manually (Req 10.8). The automated engine calls
 * {@link assertAutomatableAction} and this error signals the grant must be
 * refused.
 */
export class AutomatedGrantRejectedError extends Error {
  readonly code = ADJUSTMENT_ERROR_CODES.automatedGrantRejected;
  readonly action: string;
  constructor(action: string) {
    super(
      `Action '${action}' cannot be verified through any Shopify or partner API and may be ` +
        `credited only through a manual Admin_User credit (Requirement 10.8).`,
    );
    this.name = "AutomatedGrantRejectedError";
    this.action = action;
  }
}

/**
 * Runs `work` inside a single transaction, passing the transaction's
 * {@link Queryable} client so the ledger append + audit append commit or roll
 * back together. Mirrors the Transactor used across redemption/expiry/migration.
 */
export type Transactor = <T>(work: (tx: Queryable) => Promise<T>) => Promise<T>;

/** Prefix marking a ledger entry's `source_event_id` as admin-originated. */
const ADMIN_ACTOR_PREFIX = "admin:";

/** Build the ledger `source_event_id` value that records the acting admin (Req 10.2/10.4). */
export function adminActorTag(adminUserId: string): string {
  return `${ADMIN_ACTOR_PREFIX}${adminUserId}`;
}

/**
 * Validate and normalise a reason to 1–500 characters (Req 10.2/10.3/10.4).
 * Trims surrounding whitespace; the trimmed value must be non-empty and at most
 * 500 chars. Throws {@link InvalidReasonError} otherwise.
 */
export function validateReason(reason: unknown): string {
  if (typeof reason !== "string") {
    throw new InvalidReasonError("A reason of 1 to 500 characters is required.");
  }
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN_LENGTH) {
    throw new InvalidReasonError("A non-empty reason of 1 to 500 characters is required.");
  }
  if (trimmed.length > REASON_MAX_LENGTH) {
    throw new InvalidReasonError(
      `The reason must not exceed ${REASON_MAX_LENGTH} characters; received ${trimmed.length}.`,
    );
  }
  return trimmed;
}

/**
 * Actions that CANNOT be verified through any Shopify or partner API and are
 * therefore creditable ONLY through a manual Admin_User credit (Req 10.8;
 * design.md Goals/Non-Goals — e.g. an Instagram follow). This is the single
 * source of truth for the manual-only action set; the automated earning engine
 * consults it via {@link assertAutomatableAction}.
 */
export const MANUAL_ONLY_ACTIONS: readonly string[] = [
  "instagram_follow",
  "social_share",
  "in_store_event_attendance",
  "offline_action",
];

const MANUAL_ONLY_ACTION_SET = new Set<string>(MANUAL_ONLY_ACTIONS);

/** True iff `action` may be credited only via a manual Admin_User credit (Req 10.8). */
export function isManualOnlyAction(action: string): boolean {
  return MANUAL_ONLY_ACTION_SET.has(normaliseAction(action));
}

/**
 * Guard for the AUTOMATED grant path (Req 10.8): the earning engine calls this
 * before granting points for an action. It throws
 * {@link AutomatedGrantRejectedError} for a manual-only action so the automated
 * grant is refused and the points are only ever awarded through a manual admin
 * credit.
 */
export function assertAutomatableAction(action: string): void {
  if (isManualOnlyAction(action)) {
    throw new AutomatedGrantRejectedError(normaliseAction(action));
  }
}

function normaliseAction(action: unknown): string {
  return typeof action === "string" ? action.trim() : "";
}

/** Input for a manual point adjustment (Req 10.2). */
export interface AdjustmentInput {
  /** The customer whose balance is adjusted. */
  customerId: string;
  /** Signed, non-zero integer point delta (positive credit / negative debit). */
  points: number;
  /** A 1–500 char reason for the adjustment. */
  reason: string;
}

/** Input for a manual credit for a non-automatable action (Req 10.4). */
export interface ManualCreditInput {
  /** The customer being credited. */
  customerId: string;
  /** POSITIVE integer point amount to credit. */
  points: number;
  /** The non-automatable action being credited (identified in the ledger + audit). */
  action: string;
  /** A 1–500 char reason that identifies the action. */
  reason: string;
}

/** The result of a manual adjustment / manual credit. */
export interface AdjustmentResult {
  /** The single `adjust` ledger entry created. */
  entry: LedgerEntry;
  /** The immutable audit record created (Req 10.9). */
  audit: AuditRecord;
}

/** Dependencies shared by the adjustment/credit operations. */
export interface AdjustmentDeps {
  /** The append-only ledger repository (task 2.1) — the only ledger writer. */
  repo: LedgerRepository;
  /** The immutable audit trail recorder (Req 10.9). */
  audit: AuditTrailRecorder;
  /** Runs the ledger append + audit append inside one transaction. */
  transactor: Transactor;
}

function assertNonZeroInteger(points: unknown): number {
  if (typeof points !== "number" || !Number.isInteger(points)) {
    throw new InvalidAmountError("A signed integer point amount is required.");
  }
  if (!Number.isSafeInteger(points)) {
    throw new InvalidAmountError("The point amount must be within the safe integer range.");
  }
  if (points === 0) {
    throw new InvalidAmountError("An adjustment must record a non-zero point movement.");
  }
  return points;
}

/**
 * Apply a manual point adjustment (Req 10.2/10.3). Validates the reason (1–500
 * chars, {@link InvalidReasonError} otherwise — NO ledger entry / audit) and
 * the signed non-zero integer amount, then, in ONE transaction, appends exactly
 * one `adjust` ledger entry recording the delta, reason, acting admin (via
 * `source_event_id`) and timestamp, and one immutable audit record.
 */
export async function applyAdjustment(
  input: AdjustmentInput,
  admin: AdminCtx,
  deps: AdjustmentDeps,
): Promise<AdjustmentResult> {
  // Validate FIRST so a bad request creates nothing (Req 10.3).
  const reason = validateReason(input.reason);
  const points = assertNonZeroInteger(input.points);

  return deps.transactor(async (tx) => {
    const entry = await deps.repo.append(
      {
        customerId: input.customerId,
        entryType: "adjust",
        points,
        reason,
        sourceEventId: adminActorTag(admin.adminUserId),
      },
      tx,
    );

    // A positive adjustment credits the customer, so back it with a matching
    // 12-month Point_Lot to keep the credited points spendable (Req 10.2a,
    // Req 1.3a, Property 17). A negative adjustment creates no lot.
    await createExpiringPointLot(tx, input.customerId, entry);

    const audit = await deps.audit.record(
      {
        adminUserId: admin.adminUserId,
        operationType: "adjustment",
        affectedCustomerId: input.customerId,
        ledgerEntryId: entry.id,
        detail: {
          points,
          reason,
          adjustmentTimestamp: entry.createdAt.toISOString(),
        },
      },
      tx,
    );

    return { entry, audit };
  });
}

/**
 * Grant a manual credit for a non-automatable action (Req 10.4/10.8). Validates
 * the reason (1–500 chars) and a positive integer amount, requires a non-empty
 * action identifier, and — in ONE transaction — appends exactly one positive
 * `adjust` (adjustment earning) ledger entry recording the credited amount, the
 * identified action, the acting admin (via `source_event_id`) and timestamp,
 * plus one immutable audit record typed `manual_credit`.
 *
 * This is the ONLY path that credits a manual-only action; the automated engine
 * refuses such actions via {@link assertAutomatableAction} (Req 10.8).
 */
export async function grantManualCredit(
  input: ManualCreditInput,
  admin: AdminCtx,
  deps: AdjustmentDeps,
): Promise<AdjustmentResult> {
  const reason = validateReason(input.reason);
  const action = normaliseAction(input.action);
  if (action.length === 0) {
    throw new InvalidActionError("A manual credit must identify the action being credited.");
  }
  const points = assertNonZeroInteger(input.points);
  if (points < 0) {
    throw new InvalidAmountError("A manual credit must be a positive point amount.");
  }

  return deps.transactor(async (tx) => {
    const entry = await deps.repo.append(
      {
        customerId: input.customerId,
        entryType: "adjust",
        points,
        // The reason identifies the action (Req 10.4); the action is also
        // captured structurally in the audit detail below.
        reason,
        sourceEventId: adminActorTag(admin.adminUserId),
      },
      tx,
    );

    // Manual credits are always positive, so every one gets a matching
    // 12-month Point_Lot (Req 10.4, Req 1.3a, Property 17).
    await createExpiringPointLot(tx, input.customerId, entry);

    const audit = await deps.audit.record(
      {
        adminUserId: admin.adminUserId,
        operationType: "manual_credit",
        affectedCustomerId: input.customerId,
        ledgerEntryId: entry.id,
        detail: {
          points,
          action,
          reason,
          creditTimestamp: entry.createdAt.toISOString(),
        },
      },
      tx,
    );

    return { entry, audit };
  });
}
