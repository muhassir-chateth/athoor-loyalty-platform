/**
 * Due-work scheduling (task 24, zero-cost architecture).
 *
 * WHY THIS EXISTS
 * ---------------
 * The recurring jobs (daily FIFO expiry scan + pre-expiry sweep, cache
 * reconciliation) were driven by pg-boss cron. Verified against
 * `pg-boss@10.4.2` (`src/timekeeper.js`), a cron schedule fires ONLY when its
 * previous occurrence is less than 60 seconds old, and only while the process is
 * alive:
 *
 *     const prevDiff = (databaseTime - prevTime.getTime()) / 1000
 *     return prevDiff < 60
 *
 * So a window that elapses while the host is asleep is skipped SILENTLY and
 * never replayed — no catch-up, no backlog, no error. On a free host that spins
 * down when idle, a 02:00 scan therefore almost never runs, which is exactly the
 * failure staging exhibited.
 *
 * This module replaces the cron window with DUE WORK derived from persisted
 * state: `scheduled_runs.last_run_at` records when each job last ran, and a job
 * is due once `interval_seconds` have elapsed since then. Because the decision
 * is a function of stored timestamps rather than of "is the process awake at
 * this instant", missed work is never lost — it is merely DELAYED until the next
 * time the service is running, where it is claimed and enqueued as an ordinary
 * durable `pgboss.job` row.
 *
 * SEMANTICS
 * ---------
 *   - At-least-once, catch-up-on-wake. A job overdue by five days is enqueued
 *     ONCE on the next wake (not five times): the point is to bring the system
 *     up to date, and every handler is already idempotent (expiry is idempotent
 *     per lot — Property 9; reconciliation recomputes from the ledger).
 *   - Claiming is ATOMIC. `claimDueJobs` uses a single conditional UPDATE …
 *     RETURNING, so two concurrent evaluators (two instances, or a boot tick
 *     racing the interval tick) cannot both claim the same job.
 *   - `last_run_at` is stamped at CLAIM time, not completion. A handler that
 *     throws is retried by pg-boss's own retry policy; stamping on claim is what
 *     prevents a failing job from being re-enqueued on every tick.
 *
 * LEDGER SAFETY: this module never touches `ledger_entries`, `point_lots` or any
 * balance. It only reads/writes `scheduled_runs` and publishes queue jobs; all
 * loyalty behaviour stays in the existing handlers, unchanged.
 */
import type { Queryable } from "../ledger/repository.js";

/** Default cadence for a registered job when none is given: once per day. */
export const DEFAULT_INTERVAL_SECONDS = 86_400 as const;

/**
 * How far past its due time a job may drift before monitoring calls it overdue.
 * Generous by design: on a free host a job legitimately waits for the next wake,
 * so this is tuned to catch "stopped running entirely", not "ran a bit late".
 */
export const DEFAULT_OVERDUE_GRACE_SECONDS = 86_400 as const;

/** A job registered for due-work evaluation. */
export interface DueWorkJob {
  jobName: string;
  intervalSeconds: number;
}

/** A job whose due time has passed by more than the grace period. */
export interface OverdueJob {
  jobName: string;
  intervalSeconds: number;
  lastRunAt: Date | null;
  /** Seconds since the job became due; null when it has never run. */
  overdueBySeconds: number | null;
}

/** Publishes a claimed job onto its queue — satisfied by pg-boss's `send`. */
export interface DueWorkPublisher {
  send(queue: string, data: object): Promise<string | null>;
}

/**
 * Registers (or re-registers) a job for due-work evaluation.
 *
 * Idempotent: re-running on every boot updates the cadence but PRESERVES
 * `last_run_at`, so a redeploy never resets a job's clock and never causes a
 * spurious immediate run. A brand-new row is created with `last_run_at = NULL`,
 * which makes the job due immediately — the correct behaviour for a first
 * deploy, where we want the scan to establish a baseline.
 */
const UPSERT_JOB_SQL = `
  INSERT INTO scheduled_runs (job_name, interval_seconds)
  VALUES ($1, $2)
  ON CONFLICT (job_name) DO UPDATE
    SET interval_seconds = EXCLUDED.interval_seconds
  RETURNING job_name
`;

/**
 * Atomically claims every job whose due time has passed, stamping `last_run_at`
 * so a concurrent evaluator cannot claim the same row. Returns the claimed job
 * names, which the caller then enqueues.
 *
 * A single statement does the read, the guard and the write, so the claim is
 * race-free without an explicit lock: `WHERE last_run_at IS NULL OR
 * last_run_at + interval <= now()` re-evaluates against the row's committed
 * state under the UPDATE's own row lock.
 */
const CLAIM_DUE_SQL = `
  UPDATE scheduled_runs
     SET last_run_at = now()
   WHERE last_run_at IS NULL
      OR last_run_at + (interval_seconds * INTERVAL '1 second') <= now()
  RETURNING job_name, interval_seconds
`;

/** Jobs overdue by more than the grace period — for health/monitoring only. */
const OVERDUE_SQL = `
  SELECT job_name,
         interval_seconds,
         last_run_at,
         CASE
           WHEN last_run_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (now() - (last_run_at + (interval_seconds * INTERVAL '1 second'))))
         END AS overdue_by_seconds
    FROM scheduled_runs
   WHERE last_run_at IS NULL
      OR last_run_at + ((interval_seconds + $1) * INTERVAL '1 second') <= now()
   ORDER BY job_name
`;

interface ClaimRow {
  job_name: string;
  interval_seconds: number | string;
}

interface OverdueRow {
  job_name: string;
  interval_seconds: number | string;
  last_run_at: Date | null;
  overdue_by_seconds: number | string | null;
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

/** Registers a job's cadence, preserving any existing `last_run_at`. */
export async function registerDueWorkJob(
  db: Queryable,
  jobName: string,
  intervalSeconds: number = DEFAULT_INTERVAL_SECONDS,
): Promise<void> {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error(
      `Due-work interval for '${jobName}' must be a positive whole number of seconds; received ${intervalSeconds}.`,
    );
  }
  await db.query(UPSERT_JOB_SQL, [jobName, intervalSeconds]);
}

/** Claims all currently-due jobs, stamping each so it is claimed exactly once. */
export async function claimDueJobs(db: Queryable): Promise<DueWorkJob[]> {
  const { rows } = await db.query<ClaimRow>(CLAIM_DUE_SQL);
  return rows.map((r) => ({
    jobName: r.job_name,
    intervalSeconds: toNumber(r.interval_seconds),
  }));
}

/** Lists jobs overdue beyond the grace period (monitoring; changes no state). */
export async function listOverdueJobs(
  db: Queryable,
  graceSeconds: number = DEFAULT_OVERDUE_GRACE_SECONDS,
): Promise<OverdueJob[]> {
  const { rows } = await db.query<OverdueRow>(OVERDUE_SQL, [graceSeconds]);
  return rows.map((r) => ({
    jobName: r.job_name,
    intervalSeconds: toNumber(r.interval_seconds),
    lastRunAt: r.last_run_at,
    overdueBySeconds:
      r.overdue_by_seconds === null ? null : Math.round(toNumber(r.overdue_by_seconds)),
  }));
}

/**
 * Read-only view of scheduling health, surfaced on `/health` so an external
 * monitor can detect a schedule that has stopped firing. Declared here (next to
 * the state it reports) and satisfied in production by
 * {@link PgDueWorkStatusSource}.
 */
export interface DueWorkStatusSource {
  listOverdue(): Promise<OverdueJob[]>;
}

/** Postgres-backed {@link DueWorkStatusSource}. Changes no state. */
export class PgDueWorkStatusSource implements DueWorkStatusSource {
  constructor(
    private readonly db: Queryable,
    private readonly graceSeconds: number = DEFAULT_OVERDUE_GRACE_SECONDS,
  ) {}

  listOverdue(): Promise<OverdueJob[]> {
    return listOverdueJobs(this.db, this.graceSeconds);
  }
}

export interface RunDueWorkDeps {
  db: Queryable;
  publisher: DueWorkPublisher;
}

export interface RunDueWorkResult {
  /** Job names claimed and enqueued on this pass. */
  enqueued: string[];
}

/**
 * One evaluation pass: claim every due job and enqueue it.
 *
 * Called on boot and on an interval while the process is awake. Because
 * claiming is atomic and stamped, calling this more often than necessary is
 * harmless — a job that is not yet due is simply not claimed.
 */
export async function runDueWork(deps: RunDueWorkDeps): Promise<RunDueWorkResult> {
  const due = await claimDueJobs(deps.db);
  const enqueued: string[] = [];
  for (const job of due) {
    // The queue carries no meaningful payload: the handler is registered per
    // job name and recomputes everything it needs from the database.
    await deps.publisher.send(job.jobName, {});
    enqueued.push(job.jobName);
  }
  return { enqueued };
}
