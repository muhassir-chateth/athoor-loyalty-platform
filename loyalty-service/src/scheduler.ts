/**
 * The recurring-scheduler contract the domain schedulers depend on.
 *
 * Recurring jobs (the FIFO expiry scan + pre-expiry sweep, cache reconciliation)
 * are written against this one-call abstraction so they are independent of how
 * execution is actually driven.
 *
 * IMPLEMENTATION: {@link DueWorkScheduler} in `scheduling/dueWorkScheduler.ts`.
 *
 * HISTORY — why there is no pg-boss cron adapter any more (task 24): a
 * `PgBossRecurringScheduler` used to fuse `createQueue` + `work` + `schedule`
 * into this contract. Verified in `pg-boss@10.4.2` (`src/timekeeper.js`), a cron
 * schedule fires only when its previous occurrence is under 60 seconds old AND
 * the process is alive, so a window that elapses while the host sleeps is
 * skipped silently and never replayed. On zero-cost hosting, where the service
 * spins down when idle, the daily scans therefore effectively never ran. That
 * adapter has been REMOVED rather than left in place, so a cron-based path
 * cannot be reintroduced by accident; cadence now lives in `scheduled_runs` and
 * missed work is caught up on the next start (A15).
 *
 * The `cron` parameter is retained for source compatibility with the domain
 * schedulers, which still express their intended cadence that way, but it is
 * ADVISORY: {@link DueWorkScheduler} ignores it and takes the cadence from its
 * own configuration, because a persisted interval is what makes catch-up
 * possible. Treat the cron string as documentation of intent.
 */
export interface RecurringScheduler {
  schedule(jobName: string, cron: string, handler: () => Promise<void>): Promise<void>;
}
