/**
 * Due-work {@link RecurringScheduler} adapter + ticker (task 24, boot wiring).
 *
 * Drop-in replacement for {@link PgBossRecurringScheduler}. It satisfies the
 * SAME `schedule(jobName, cron, handler)` contract the domain schedulers already
 * depend on, so `registerExpiryScan` and `registerReconciliationJob` are used
 * completely unchanged — only the adapter injected at boot differs.
 *
 * The difference is what drives execution:
 *
 *   - pg-boss cron  → an in-memory window; if the process is asleep when the
 *     window elapses, the run is skipped silently and never replayed.
 *   - this adapter  → the job's cadence is persisted in `scheduled_runs`, and a
 *     ticker claims whatever is due whenever the process happens to be running.
 *     Missed work is delayed, not lost.
 *
 * The consume half is identical: the queue is created and a `work` consumer runs
 * the handler for each delivered job. The `cron` argument is accepted for
 * interface compatibility and deliberately IGNORED — cadence comes from
 * `intervalsByJob` (defaulting to daily), because a persisted interval is what
 * makes catch-up possible. The mapping is explicit rather than parsed from the
 * cron string so the cadence is reviewable in one place.
 *
 * SAFETY: talks only to OUR Postgres/pg-boss. It makes no Shopify Admin API call
 * and sends no email; those remain the existing workers' concern. Like the
 * adapter it replaces, this is boot glue with no loyalty/domain logic — the
 * claim/enqueue core it delegates to (`dueWork.ts`) IS unit-tested.
 */
import type PgBoss from "pg-boss";
import type { Queryable } from "../ledger/repository.js";
import type { RecurringScheduler } from "../scheduler.js";
import { DEFAULT_INTERVAL_SECONDS, registerDueWorkJob, runDueWork } from "./dueWork.js";

/** How often the ticker re-evaluates due work while the process is awake. */
export const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;

export interface DueWorkSchedulerOptions {
  /** Per-job cadence overrides, in seconds. Unlisted jobs default to daily. */
  intervalsByJob?: Readonly<Record<string, number>>;
}

/**
 * Registers recurring jobs as due work and consumes their queues.
 *
 * Registration order matters and is preserved from the adapter this replaces:
 * the queue and its consumer exist BEFORE the job is registered as due, so a
 * job claimed by the very first tick always has something to run it.
 */
export class DueWorkScheduler implements RecurringScheduler {
  constructor(
    private readonly boss: PgBoss,
    private readonly db: Queryable,
    private readonly options: DueWorkSchedulerOptions = {},
  ) {}

  async schedule(jobName: string, _cron: string, handler: () => Promise<void>): Promise<void> {
    // (0) Remove any legacy pg-boss cron entry for this job. `pgboss.schedule`
    // rows persist in the database across deploys, so a job that was previously
    // registered with `boss.schedule(name, cron)` would keep publishing
    // occurrences alongside due work — double-triggering while the process
    // happens to be awake. Idempotent: unscheduling an absent job is a no-op.
    await this.boss.unschedule(jobName);
    // (1) The queue must exist before we consume from or publish to it (v10).
    await this.boss.createQueue(jobName);
    // (2) Consume: run the handler once per delivered job. A recurring job
    // carries no payload — the handler recomputes what it needs.
    await this.boss.work(jobName, async (jobs) => {
      for (let i = 0; i < jobs.length; i++) {
        await handler();
      }
    });
    // (3) Record the cadence. Idempotent, and preserves `last_run_at`, so a
    // redeploy neither resets the clock nor triggers a spurious run.
    const intervalSeconds = this.options.intervalsByJob?.[jobName] ?? DEFAULT_INTERVAL_SECONDS;
    await registerDueWorkJob(this.db, jobName, intervalSeconds);
  }
}

export interface DueWorkTickerDeps {
  db: Queryable;
  boss: PgBoss;
  /** Called with the outcome of each pass; used for boot/tick logging. */
  onTick?: (enqueued: readonly string[]) => void;
  /** Called when a pass throws. A tick failure must never crash the process. */
  onError?: (err: unknown) => void;
  tickIntervalMs?: number;
}

/** Stops a running ticker. */
export interface DueWorkTicker {
  stop(): void;
}

/**
 * Runs one due-work pass immediately, then repeats on an interval while the
 * process is awake.
 *
 * The immediate pass is the mechanism that recovers work missed while the host
 * slept: whatever became due overnight is claimed and enqueued moments after the
 * service starts serving again. The interval then covers a process that stays up
 * across a due time.
 *
 * Errors are reported and swallowed: a scheduling hiccup must never take down
 * request handling, and the next tick simply retries.
 */
export async function startDueWorkTicker(deps: DueWorkTickerDeps): Promise<DueWorkTicker> {
  const publisher = {
    send: (queue: string, data: object) => deps.boss.send(queue, data),
  };

  const pass = async (): Promise<void> => {
    try {
      const { enqueued } = await runDueWork({ db: deps.db, publisher });
      deps.onTick?.(enqueued);
    } catch (err) {
      deps.onError?.(err);
    }
  };

  // Catch up on anything missed while the process was down, before the interval.
  await pass();

  const timer = setInterval(() => void pass(), deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
  // Never hold the event loop open on shutdown.
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
