/**
 * Expiry scheduler — daily FIFO expiry scan + pre-expiry notification sweep
 * (task 10.2).
 *
 * Implements design.md "Component 5: Scheduler" ("Daily FIFO expiry scan;
 * pre-expiry notification sweep") and the "Data Flow: Expiry (scheduled, FIFO)"
 * sequence where a daily `Scheduler` calls `runExpiryScan(today)` and then
 * `runPreExpiryNotify(today + N days)`. Time-driven jobs like these cannot be
 * triggered by Shopify (no Shopify Flow on Basic plan), so they run here in the
 * external backend.
 *
 * Requirements covered:
 *   - 5.1  Point-lot expiry window is exactly 12 months after earning. The
 *          window is SET at earn time (task 4.2, `point_lots.expires_at =
 *          earned_at + 12 months`); this module re-exports the canonical
 *          constant ({@link EXPIRY_WINDOW_MONTHS}) so the scheduler documents
 *          and shares the single source of truth, and drives the daily scan that
 *          acts on those expiry dates.
 *   - 5.4/5.5  Runs the pre-expiry sweep (see `preExpiryNotify.ts`) alongside
 *          the scan on the daily cadence.
 *
 * The recurring cadence is expressed via an INJECTABLE recurring-scheduler
 * abstraction ({@link RecurringScheduler}, structurally satisfied by e.g.
 * pg-boss `schedule(name, cron, ...)`), exactly like the reconciliation job
 * (task 12.1). Registration wires a callable handler to that abstraction;
 * production supplies a real scheduler at deploy time. Declaring the schedule or
 * registering the handler here engages NO live scheduler and touches no live
 * system — the cadence is config/documentation until a real scheduler is wired.
 *
 * SCOPE (task 10.2): this module orchestrates existing units — it calls
 * {@link runExpiryScan} (task 10.1, imported unchanged) and
 * {@link runPreExpiryNotify} (this task). It does NOT modify the expiry scan
 * internals, the earning module, reconciliation, or clawback.
 *
 * SAFETY: no live/production system is touched by defining this module. The scan
 * and sweep reach the database only through the transactors/queryables their
 * deps carry, and the ESP only through the injected notifier; all logic is
 * unit-tested against in-memory fakes.
 */
import { LOT_EXPIRY_MONTHS } from "../earning/order.js";
import { runExpiryScan, type ExpiryResult, type ExpiryScanDeps } from "./expiryScan.js";
import {
  runPreExpiryNotify,
  type PreExpiryNotifyDeps,
  type PreExpirySweepResult,
} from "./preExpiryNotify.js";

/**
 * The point-lot expiry window in months, measured from the earning timestamp
 * (Req 5.1 / A1). Re-exported from the earning module (task 4.2) so this is the
 * SINGLE source of truth: lot `expires_at` is set to exactly this many months
 * after `earned_at`, and the daily scan below acts on those dates.
 */
export const EXPIRY_WINDOW_MONTHS = LOT_EXPIRY_MONTHS;

/** The queue/job name the daily expiry run is scheduled under. */
export const EXPIRY_SCAN_JOB = "runExpiryScan" as const;

/**
 * The maximum allowed gap between expiry runs. The scan/sweep must run daily so
 * matured lots expire promptly and members are warned before points lapse; the
 * default cadence runs well within this bound.
 */
export const EXPIRY_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The default cadence: daily at 02:00 (a quiet hour), comfortably satisfying the
 * "daily" expectation of the design's Scheduler component.
 */
export const EXPIRY_SCAN_CRON = "0 2 * * *" as const;

/** Declarative schedule config for the daily expiry run. */
export interface ExpirySchedule {
  jobName: string;
  /** Cron expression for the run cadence. */
  cron: string;
  /** Upper bound on the interval between runs, in ms. */
  maxIntervalMs: number;
}

/** The default expiry schedule (doc/config; not wired to a live scheduler). */
export const EXPIRY_SCHEDULE: ExpirySchedule = {
  jobName: EXPIRY_SCAN_JOB,
  cron: EXPIRY_SCAN_CRON,
  maxIntervalMs: EXPIRY_MAX_INTERVAL_MS,
};

/**
 * A minimal structural view of a recurring scheduler (satisfied by e.g. pg-boss
 * `schedule(name, cron, data, options)`), declared locally so registering the
 * job does not hard-couple the scheduler to any concrete implementation. Mirrors
 * the reconciliation job's abstraction (task 12.1).
 */
export interface RecurringScheduler {
  schedule(jobName: string, cron: string, handler: () => Promise<void>): Promise<void> | void;
}

/** Dependencies for the daily expiry run: the scan's deps + the sweep's deps. */
export interface ExpirySchedulerDeps {
  /** Dependencies for the FIFO expiry scan (task 10.1). */
  expiry: ExpiryScanDeps;
  /** Dependencies for the pre-expiry notification sweep (Req 5.4/5.5). */
  preExpiry: PreExpiryNotifyDeps;
  /**
   * Clock injection for the run instant (defaults to `new Date()`). The SAME
   * instant is used as the scan date and the sweep date so a single day's run is
   * internally consistent.
   */
  now?: () => Date;
}

/** The combined outcome of one daily expiry run. */
export interface DailyExpiryRunResult {
  /** The run's reference instant (the scan/sweep date). */
  asOf: Date;
  /** The result of the FIFO expiry scan (task 10.1). */
  expiry: ExpiryResult;
  /** The result of the pre-expiry notification sweep (Req 5.4/5.5). */
  preExpiry: PreExpirySweepResult;
}

/**
 * Runs one daily expiry cycle at the scheduler's instant: first the idempotent
 * FIFO expiry scan (matured lots → `expire` entries, task 10.1), then the
 * pre-expiry notification sweep (upcoming lots → ESP notifications, Req 5.4/5.5).
 * Both use the SAME `asOf` so the day's scan and sweep are consistent; the sweep
 * looks FORWARD by its configured window from that date.
 *
 * This is the callable the scheduler invokes; it can also be called directly
 * (e.g. from an admin "run now" action or tests). Returns both sub-results.
 *
 * @param deps the scan deps, the sweep deps, and an optional clock.
 */
export async function runDailyExpiry(deps: ExpirySchedulerDeps): Promise<DailyExpiryRunResult> {
  const asOf = deps.now ? deps.now() : new Date();

  // (1) Expire matured lots as of today (idempotent — Req 5.2/5.3).
  const expiry = await runExpiryScan(asOf, deps.expiry);

  // (2) Warn on lots expiring within the configured window, once per lot
  // (Req 5.4/5.5). Force the sweep date to the same instant as the scan.
  const preExpiry = await runPreExpiryNotify({ ...deps.preExpiry, now: () => asOf });

  return { asOf, expiry, preExpiry };
}

/**
 * Registers the daily expiry run on a recurring scheduler so it runs daily
 * (design "Component 5: Scheduler"). The registered handler invokes
 * {@link runDailyExpiry}. Wires a callable job to the scheduler abstraction;
 * production supplies a real recurring scheduler at deploy time — calling this
 * in a test/registration context engages no live scheduler.
 *
 * @returns the {@link ExpirySchedule} that was registered.
 */
export async function registerExpiryScan(
  scheduler: RecurringScheduler,
  deps: ExpirySchedulerDeps,
  schedule: ExpirySchedule = EXPIRY_SCHEDULE,
): Promise<ExpirySchedule> {
  await scheduler.schedule(schedule.jobName, schedule.cron, async () => {
    await runDailyExpiry(deps);
  });
  return schedule;
}
