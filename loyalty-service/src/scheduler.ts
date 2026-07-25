/**
 * pg-boss recurring-scheduler adapter (boot wiring only).
 *
 * The scheduled/recurring jobs in this service (the daily FIFO expiry scan,
 * and — once their production adapters exist — reconciliation and analytics
 * refresh) are written against a tiny injectable {@link RecurringScheduler}
 * abstraction:
 *
 *     schedule(name, cron, handler)
 *
 * pg-boss v10 splits that single concept into two calls: `schedule(name, cron)`
 * PUBLISHES a job onto a named queue on the cron cadence, and `work(name, …)`
 * CONSUMES that queue and runs the handler. It also requires the queue to exist
 * (`createQueue`) before either is used. This adapter is the thin glue that
 * fuses those three pg-boss calls into the one-call abstraction the domain
 * schedulers expect, so a cron tick actually results in the handler running.
 *
 * This file is PURE BOOT GLUE: it contains no loyalty/domain logic, invents no
 * new external adapter, and is only reachable from `index.ts` at startup. It is
 * intentionally NOT exercised by the unit-test suite (which runs without a live
 * Postgres/pg-boss); its correctness is a type-level + static concern.
 *
 * SAFETY: constructing the adapter touches nothing. Calling {@link schedule}
 * only ever talks to OUR pg-boss-backed Postgres queue (create the queue,
 * register a consumer, register a cron publisher). It makes no Shopify Admin API
 * call and sends no email.
 */
import type PgBoss from "pg-boss";

/**
 * The minimal recurring-scheduler contract the domain schedulers depend on
 * (structurally identical to the interfaces declared in
 * `reconciliation/reconcile.ts` and `expiry/scheduler.ts`): register a `handler`
 * to run on a `cron` cadence under a stable `jobName`.
 */
export interface RecurringScheduler {
  schedule(jobName: string, cron: string, handler: () => Promise<void>): Promise<void>;
}

/**
 * pg-boss-backed {@link RecurringScheduler}. For each registered job it:
 *   1. ensures the backing queue exists (`createQueue`, idempotent);
 *   2. registers a consumer (`work`) that runs the handler for every delivered
 *      occurrence — this is the half that actually executes the job; and
 *   3. registers the cron publisher (`schedule`) that enqueues one occurrence
 *      per tick.
 *
 * Without both `work` and `schedule` a cron tick would enqueue jobs that nothing
 * consumes; this adapter guarantees the consume side is always wired first.
 */
export class PgBossRecurringScheduler implements RecurringScheduler {
  constructor(private readonly boss: PgBoss) {}

  async schedule(jobName: string, cron: string, handler: () => Promise<void>): Promise<void> {
    // (1) The queue must exist before we consume from or publish to it (v10).
    await this.boss.createQueue(jobName);
    // (2) Consume: run the handler for each delivered occurrence. pg-boss
    // delivers a batch; a recurring job carries no meaningful payload, so we
    // simply invoke the handler once per delivered job.
    await this.boss.work(jobName, async (jobs) => {
      for (let i = 0; i < jobs.length; i++) {
        await handler();
      }
    });
    // (3) Publish one occurrence per cron tick.
    await this.boss.schedule(jobName, cron);
  }
}
