/**
 * Benefit-request fulfilment workflow (task 41) — Req 18.5, 10.5, 10.9.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * Task 30 gave `POST /v1/benefits/:key/request` a production call site, so
 * `benefit_requests` rows are now genuinely created — and nothing read or
 * advanced them. A member could book a private consultation and no member of
 * staff would ever see it. The row was durable and operationally invisible,
 * which is worse than refusing the booking.
 *
 * ── THE LIFECYCLE ────────────────────────────────────────────────────────────
 *   requested ──▶ confirmed ──▶ fulfilled          (accepted, then delivered)
 *       │             │
 *       ├──▶ fulfilled                              (delivered immediately)
 *       ├──▶ declined                               (staff will not grant it)
 *       └──▶ cancelled ◀── confirmed                (withdrawn before delivery)
 *
 * `fulfilled`, `declined` and `cancelled` are TERMINAL. `declined` is not the
 * same event as `cancelled` — a refusal is a decision, a cancellation is a
 * withdrawal — so they are distinct statuses rather than one ambiguous one (see
 * the migration header for the spec amendment this represents).
 *
 * ── IDEMPOTENT BY CONSTRUCTION ───────────────────────────────────────────────
 * Transitioning a request to the status it already holds is a NO-OP that reports
 * success and writes nothing — not an error, because an operator double-clicking
 * "fulfil" has not done anything wrong and must not see a failure. Transitioning
 * a terminal request to a DIFFERENT status is refused: a fulfilled consultation
 * cannot later become declined, and quietly allowing it would rewrite history.
 *
 * The gate is a guarded `UPDATE … WHERE status = ANY($allowedFrom)`, so two
 * concurrent operators cannot both win; the loser re-reads and is told the truth.
 * The application check selects the RESPONSE, never the outcome — the same lesson
 * as task 40.
 *
 * ── AUDITABLE ────────────────────────────────────────────────────────────────
 * Every accepted transition writes one immutable `admin_audit_log` record
 * (operation type `benefit_request`) in the SAME transaction as the status
 * change, so a transition can never exist unattributed (Req 10.9). A no-op
 * writes no audit record, because nothing happened.
 *
 * OFF-LEDGER: touches `benefit_requests` and `admin_audit_log` only. No ledger
 * entry, point lot or balance is read or written.
 *
 * SAFETY: defining this module touches no live system; SQL is issued only when a
 * caller passes a real Pool/PoolClient at runtime.
 */
import type { QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { SYSTEM_ACTOR_ID, type AuditTrailRecorder } from "./auditTrail.js";

/** Every status a benefit request may hold (mirrors the DB CHECK). */
export const BENEFIT_REQUEST_STATUSES = [
  "requested",
  "confirmed",
  "fulfilled",
  "declined",
  "cancelled",
] as const;

export type BenefitRequestStatus = (typeof BENEFIT_REQUEST_STATUSES)[number];

/** Statuses an operator may transition a request INTO. */
export const BENEFIT_REQUEST_TRANSITIONS = ["confirmed", "fulfilled", "declined", "cancelled"] as const;

export type BenefitRequestTransition = (typeof BENEFIT_REQUEST_TRANSITIONS)[number];

/** Statuses from which each transition is permitted. Terminal states appear in no list. */
export const ALLOWED_FROM: Readonly<Record<BenefitRequestTransition, readonly BenefitRequestStatus[]>> = {
  confirmed: ["requested"],
  fulfilled: ["requested", "confirmed"],
  declined: ["requested", "confirmed"],
  cancelled: ["requested", "confirmed"],
};

/** Terminal statuses: no transition leaves them. */
export const TERMINAL_STATUSES: readonly BenefitRequestStatus[] = ["fulfilled", "declined", "cancelled"];

/** True iff `status` admits no further transition. Pure. */
export function isTerminal(status: BenefitRequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** True iff `to` may be reached from `from`. Pure — the single rule of the workflow. */
export function canTransition(from: BenefitRequestStatus, to: BenefitRequestTransition): boolean {
  return ALLOWED_FROM[to].includes(from);
}

/** A benefit request as the admin queue shows it (Req 10.5). */
export interface AdminBenefitRequest {
  id: string;
  status: BenefitRequestStatus;
  /** The requesting customer's local id. */
  customerId: string;
  /** The benefit's stable key, so the row is readable without a second lookup. */
  benefitKey: string;
  benefitName: string;
  requestedAt: string;
  /** When the status last changed, or null while never actioned. */
  statusChangedAt: string | null;
}

/** The queue payload: open requests first, because those are the ones to action. */
export interface AdminBenefitRequestView {
  /** `requested` + `confirmed`, oldest first — the work queue. */
  open: AdminBenefitRequest[];
  /** Terminal requests, most recent first — the record of what was done. */
  closed: AdminBenefitRequest[];
}

/** Stable machine-readable error codes. */
export const BENEFIT_REQUEST_ERROR_CODES = {
  notFound: "benefit_request_not_found",
  invalidTransition: "benefit_request_invalid_transition",
  invalidStatus: "benefit_request_invalid_status",
} as const;

/** Thrown when no request exists for the given id. */
export class BenefitRequestNotFoundError extends Error {
  readonly code = BENEFIT_REQUEST_ERROR_CODES.notFound;
  constructor(readonly requestId: string) {
    super(`No benefit request exists with id ${requestId}.`);
    this.name = "BenefitRequestNotFoundError";
  }
}

/**
 * Thrown when the requested transition is not permitted from the request's
 * current status. Carries both statuses so the caller can report precisely, and
 * NOTHING is written.
 */
export class BenefitRequestInvalidTransitionError extends Error {
  readonly code = BENEFIT_REQUEST_ERROR_CODES.invalidTransition;
  constructor(
    readonly requestId: string,
    readonly from: BenefitRequestStatus,
    readonly to: BenefitRequestTransition,
  ) {
    super(
      `A benefit request in status '${from}' cannot transition to '${to}'` +
        (isTerminal(from) ? ` — '${from}' is terminal.` : "."),
    );
    this.name = "BenefitRequestInvalidTransitionError";
  }
}

/** The outcome of a transition attempt. */
export interface BenefitRequestTransitionResult {
  request: AdminBenefitRequest;
  /**
   * False when the request already held the target status, so nothing was
   * written and no audit record was created. The operator still sees success.
   */
  changed: boolean;
}

/* ----------------------------- SQL statements ----------------------------- */

const SELECT_REQUESTS_SQL = `
  SELECT br.id, br.status, br.customer_id, br.requested_at, br.status_changed_at,
         b.key AS benefit_key, b.name AS benefit_name
    FROM benefit_requests br
    JOIN benefits b ON b.id = br.benefit_id
   ORDER BY br.requested_at ASC, br.id ASC
`;

const SELECT_REQUEST_BY_ID_SQL = `
  SELECT br.id, br.status, br.customer_id, br.requested_at, br.status_changed_at,
         b.key AS benefit_key, b.name AS benefit_name
    FROM benefit_requests br
    JOIN benefits b ON b.id = br.benefit_id
   WHERE br.id = $1
   LIMIT 1
`;

/**
 * The guarded transition. `WHERE status = ANY($3)` is the gate: two concurrent
 * operators cannot both succeed, and a terminal row matches nothing.
 */
const TRANSITION_SQL = `
  UPDATE benefit_requests
     SET status = $2, status_changed_at = now()
   WHERE id = $1
     AND status = ANY($3)
  RETURNING id
`;

interface RequestDbRow extends QueryResultRow {
  id: string;
  status: string;
  customer_id: string;
  requested_at: Date;
  status_changed_at: Date | null;
  benefit_key: string;
  benefit_name: string;
}

function toAdminRequest(row: RequestDbRow): AdminBenefitRequest {
  return {
    id: row.id,
    status: row.status as BenefitRequestStatus,
    customerId: row.customer_id,
    benefitKey: row.benefit_key,
    benefitName: row.benefit_name,
    requestedAt: row.requested_at.toISOString(),
    statusChangedAt: row.status_changed_at ? row.status_changed_at.toISOString() : null,
  };
}

/**
 * Splits requests into the work queue and the record of what was done (pure).
 * Open oldest-first: the request waiting longest is the one to action next.
 */
export function buildBenefitRequestView(
  requests: readonly AdminBenefitRequest[],
): AdminBenefitRequestView {
  const open = requests
    .filter((r) => !isTerminal(r.status))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
  const closed = requests
    .filter((r) => isTerminal(r.status))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id));
  return { open, closed };
}

/** Reads and transitions benefit requests. Injectable so routes are testable. */
export interface BenefitRequestStore {
  list(): Promise<AdminBenefitRequest[]>;
  /**
   * Reads one request. `executor` MUST be passed when reading inside a
   * transaction that has already written: a read on the pool takes a different
   * connection and cannot see the uncommitted UPDATE, so the caller would echo
   * the pre-change state back to the operator. (That is exactly what happened on
   * the first staging run — the in-memory store has no isolation, so no unit test
   * could have caught it.)
   */
  find(requestId: string, executor?: Queryable): Promise<AdminBenefitRequest | null>;
  /**
   * Applies the guarded transition and returns true iff a row changed. MUST run
   * inside the caller's transaction so the audit record is atomic with it.
   */
  applyTransition(
    requestId: string,
    to: BenefitRequestTransition,
    allowedFrom: readonly BenefitRequestStatus[],
    executor: Queryable,
  ): Promise<boolean>;
}

/** Postgres-backed {@link BenefitRequestStore}. */
export class PgBenefitRequestStore implements BenefitRequestStore {
  constructor(private readonly db: Queryable) {}

  async list(): Promise<AdminBenefitRequest[]> {
    const result = await this.db.query<RequestDbRow>(SELECT_REQUESTS_SQL);
    return result.rows.map(toAdminRequest);
  }

  async find(requestId: string, executor: Queryable = this.db): Promise<AdminBenefitRequest | null> {
    // Reads through `executor` so a read inside the writing transaction sees the
    // uncommitted UPDATE; on the pool it would not.
    const result = await executor.query<RequestDbRow>(SELECT_REQUEST_BY_ID_SQL, [requestId]);
    const row = result.rows[0];
    return row ? toAdminRequest(row) : null;
  }

  async applyTransition(
    requestId: string,
    to: BenefitRequestTransition,
    allowedFrom: readonly BenefitRequestStatus[],
    executor: Queryable,
  ): Promise<boolean> {
    const result = await executor.query(TRANSITION_SQL, [requestId, to, [...allowedFrom]]);
    return (result.rowCount ?? 0) > 0;
  }
}

/** In-memory store for local runs and tests. */
export class InMemoryBenefitRequestStore implements BenefitRequestStore {
  private readonly rows: AdminBenefitRequest[];

  constructor(seed: readonly AdminBenefitRequest[] = []) {
    this.rows = seed.map((r) => ({ ...r }));
  }

  async list(): Promise<AdminBenefitRequest[]> {
    return this.rows.map((r) => ({ ...r }));
  }

  async find(requestId: string, _executor?: Queryable): Promise<AdminBenefitRequest | null> {
    const row = this.rows.find((r) => r.id === requestId);
    return row ? { ...row } : null;
  }

  async applyTransition(
    requestId: string,
    to: BenefitRequestTransition,
    allowedFrom: readonly BenefitRequestStatus[],
  ): Promise<boolean> {
    const row = this.rows.find((r) => r.id === requestId);
    if (!row || !allowedFrom.includes(row.status)) {
      return false;
    }
    row.status = to;
    row.statusChangedAt = new Date("2026-07-27T00:00:00Z").toISOString();
    return true;
  }
}

/** Runs a unit of work in one transaction (mirrors the admin adjustment service). */
export type BenefitRequestTransactor = <T>(work: (tx: Queryable) => Promise<T>) => Promise<T>;

/** Dependencies of {@link BenefitRequestService}. */
export interface BenefitRequestServiceDeps {
  store: BenefitRequestStore;
  audit: AuditTrailRecorder;
  /** Makes the status change and its audit record atomic (Req 10.9). */
  transactor: BenefitRequestTransactor;
}

/**
 * The fulfilment workflow. Owns the decision of what a transition means; the
 * store owns only the guarded write.
 */
export class BenefitRequestService {
  constructor(private readonly deps: BenefitRequestServiceDeps) {}

  /** The operator queue (Req 10.5). Read-only. */
  async view(): Promise<AdminBenefitRequestView> {
    return buildBenefitRequestView(await this.deps.store.list());
  }

  /**
   * Transitions a request, atomically with its audit record.
   *
   * @throws BenefitRequestNotFoundError when no such request exists.
   * @throws BenefitRequestInvalidTransitionError when the move is not permitted;
   *         nothing is written.
   */
  async transition(
    requestId: string,
    to: BenefitRequestTransition,
    adminUserId: string,
    reason?: string,
  ): Promise<BenefitRequestTransitionResult> {
    const current = await this.deps.store.find(requestId);
    if (!current) {
      throw new BenefitRequestNotFoundError(requestId);
    }

    // Idempotent no-op: already there. Nothing written, no audit record, and the
    // operator is NOT shown an error for repeating a harmless action.
    if (current.status === to) {
      return { request: current, changed: false };
    }

    // This read chooses the RESPONSE. The guarded UPDATE below is the gate.
    if (!canTransition(current.status, to)) {
      throw new BenefitRequestInvalidTransitionError(requestId, current.status, to);
    }

    return this.deps.transactor(async (tx) => {
      const changed = await this.deps.store.applyTransition(requestId, to, ALLOWED_FROM[to], tx);
      if (!changed) {
        // Lost a race, or the row moved between the read and the write. Re-read
        // and answer from the truth rather than reporting a change that did not
        // happen.
        const latest = await this.deps.store.find(requestId, tx);
        if (!latest) {
          throw new BenefitRequestNotFoundError(requestId);
        }
        if (latest.status === to) {
          // A concurrent operator applied the same transition: idempotent.
          return { request: latest, changed: false };
        }
        throw new BenefitRequestInvalidTransitionError(requestId, latest.status, to);
      }

      await this.deps.audit.record(
        {
          adminUserId: adminUserId || SYSTEM_ACTOR_ID,
          operationType: "benefit_request",
          affectedCustomerId: current.customerId,
          detail: {
            benefitRequestId: requestId,
            benefitKey: current.benefitKey,
            fromStatus: current.status,
            toStatus: to,
            ...(reason ? { reason } : {}),
          },
        },
        tx,
      );

      // Read through `tx`: the UPDATE above is not committed yet, so a read on
      // the pool would return the PRE-change row and the operator would be shown
      // a status that had already moved on.
      const updated = await this.deps.store.find(requestId, tx);
      return { request: updated ?? { ...current, status: to }, changed: true };
    });
  }
}
