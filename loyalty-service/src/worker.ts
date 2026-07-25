/**
 * Webhook-processing worker registration (boot wiring only).
 *
 * The webhook receiver verifies + dedupes an inbound Shopify webhook and hands
 * it off to the `webhook.process` queue as a {@link WebhookJob} carrying the
 * `topic` (see `webhooks/enqueue.ts` / `webhooks/handler.ts`). Nothing consumes
 * that queue yet. This module is the missing consumer: it registers a pg-boss
 * worker that dispatches each job to the ALREADY-IMPLEMENTED earning/clawback
 * job handler for its topic.
 *
 * All four handlers already exist and are unit-tested:
 *   - `customers/create`  → {@link handleCustomersCreateJob} (signup +50)
 *   - `orders/paid`       → {@link handleOrdersPaidJob}       (order earn + lots)
 *   - `refunds/create`    → {@link handleRefundJob}           (refund clawback)
 *   - `orders/cancelled`  → {@link handleOrderCancelledJob}   (cancellation clawback)
 *
 * Each handler already no-ops (returns `null`) for a topic it does not own, so
 * the explicit `switch` below is purely a routing optimisation + a clear record
 * of which topics the engine acts on; an unrecognised topic is a safe no-op.
 *
 * This file is BOOT GLUE plus one small, testable piece of domain-adjacent
 * routing: the topic→handler dispatch and — new — the post-dispatch metafield
 * cache refresh enqueue after a balance-affecting outcome (Req 13.1). It invents
 * no external adapter and adds no earning/clawback behaviour — every handler is
 * imported unchanged. The pg-boss worker registration itself needs a live
 * Postgres/pg-boss and is not unit-tested, but {@link dispatchWebhookJob} and
 * its enqueue-on-balance-change glue ARE covered by `worker.test.ts` using
 * fakes.
 *
 * SAFETY: dispatch only appends to OUR immutable ledger (via the injected
 * repository + transactor) and, when an enqueuer is wired, publishes a
 * metafield-cache refresh job to OUR pg-boss queue for the affected customer. It
 * never calls the Shopify Admin API or sends email inline — the deferred Admin
 * work belongs to the discount-code / metafield-cache workers, which run off the
 * request path (Req 13.2).
 */
import type { LedgerRepository, Queryable } from "./ledger/repository.js";
import { WEBHOOK_PROCESS_QUEUE, type WebhookJob } from "./webhooks/enqueue.js";
import { handleCustomersCreateJob, CUSTOMERS_CREATE_TOPIC } from "./earning/signup.js";
import { handleOrdersPaidJob, ORDERS_PAID_TOPIC } from "./earning/order.js";
import {
  handleRefundJob,
  handleOrderCancelledJob,
  REFUNDS_CREATE_TOPIC,
  ORDERS_CANCELLED_TOPIC,
} from "./earning/clawback.js";
import type { MetafieldCacheEnqueuer } from "./shopify/metafieldCache.js";

/**
 * Runs a unit of work inside a single database transaction. Structurally
 * identical to the transactor each earning/clawback handler declares, so one
 * pool-backed transactor satisfies them all.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * The dependencies every earning/clawback handler needs: the append-only ledger
 * repository and a transactor. The clawback handlers also accept an optional
 * policy / earn-rate, but their documented defaults (no negative balance, no
 * tier downgrade, rate = 1) are exactly the intended production behaviour, so
 * nothing more is required to wire them.
 */
export interface WebhookProcessingDeps {
  repo: LedgerRepository;
  transactor: Transactor;
  /**
   * OPTIONAL metafield-cache enqueuer (Req 13.1: refresh the display metafields
   * after ANY balance change). When supplied, a balance-AFFECTING dispatch
   * outcome — a signup earning, an order earning, or a clawback — enqueues a
   * `writeMetafieldCache` job for the affected LOCAL customer id so the
   * customer's `loyalty.*` cache is refreshed off the request path (Req 13.2 /
   * 15.2). It is threaded in ONLY when the Shopify Admin token is configured
   * (so the metafield-cache worker exists to consume the job); otherwise it is
   * omitted and dispatch behaves exactly as before, with the periodic
   * reconciliation job acting as the cache safety net (Req 13.7).
   *
   * Each earning/clawback handler already returns the resolved local customer
   * id on a balance-affecting outcome (`SignupEarnOutcome.customerId`,
   * `OrderEarnOutcome.customerId`, `ClawbackOutcome.customerId`), so the enqueue
   * targets exactly the one affected customer with no extra lookup. Enqueuing is
   * best-effort relative to the ledger: the append has already committed inside
   * the handler's transaction before we enqueue, so a refresh is scheduled only
   * for a change that actually happened.
   */
  metafieldEnqueuer?: MetafieldCacheEnqueuer;
}

/**
 * Enqueues a metafield-cache refresh for `customerId` when an enqueuer is wired.
 * A no-op when no enqueuer is configured (Admin token absent) — the periodic
 * reconciliation job then keeps the cache converged (Req 13.7).
 */
async function enqueueCacheRefresh(
  deps: WebhookProcessingDeps,
  customerId: string,
): Promise<void> {
  if (deps.metafieldEnqueuer) {
    await deps.metafieldEnqueuer.enqueueMetafieldCache({ customerId });
  }
}

/**
 * Routes one verified/deduped {@link WebhookJob} to the handler that owns its
 * topic. Unknown topics are a safe no-op (the engine simply does not earn or
 * claw back on them). Any error thrown by a handler propagates so pg-boss can
 * apply its own retry policy.
 *
 * On a BALANCE-AFFECTING outcome (a fresh signup/order earning, or a clawback
 * that moved points) the affected customer's metafield cache is enqueued for
 * refresh via {@link WebhookProcessingDeps.metafieldEnqueuer} (Req 13.1) — a
 * no-op replay (`already_earned`), a `no_earning` order, or a clawback `no_op`
 * changes no balance, so nothing is enqueued for those.
 */
export async function dispatchWebhookJob(
  job: WebhookJob,
  deps: WebhookProcessingDeps,
): Promise<void> {
  switch (job.topic) {
    case CUSTOMERS_CREATE_TOPIC: {
      const outcome = await handleCustomersCreateJob(job, deps);
      if (outcome && outcome.status === "earned") {
        await enqueueCacheRefresh(deps, outcome.customerId);
      }
      return;
    }
    case ORDERS_PAID_TOPIC: {
      const outcome = await handleOrdersPaidJob(job, deps);
      if (outcome && outcome.status === "earned") {
        await enqueueCacheRefresh(deps, outcome.customerId);
      }
      return;
    }
    case REFUNDS_CREATE_TOPIC: {
      const outcome = await handleRefundJob(job, deps);
      if (outcome && outcome.status === "clawed_back") {
        await enqueueCacheRefresh(deps, outcome.customerId);
      }
      return;
    }
    case ORDERS_CANCELLED_TOPIC: {
      const outcome = await handleOrderCancelledJob(job, deps);
      if (outcome && outcome.status === "clawed_back") {
        await enqueueCacheRefresh(deps, outcome.customerId);
      }
      return;
    }
    default:
      // A topic the earning/clawback engine does not act on — nothing to do.
      return;
  }
}

/**
 * The minimal pg-boss consumer surface this worker relies on, declared
 * structurally so the real `PgBoss` satisfies it (mirrors the structural
 * `*JobConsumer` interfaces the worker modules already use).
 */
export interface WebhookJobConsumer {
  work<ReqData>(
    name: string,
    handler: (jobs: Array<{ data: ReqData }>) => Promise<unknown>,
  ): Promise<string>;
}

/**
 * Registers the `webhook.process` consumer. Each delivered job is dispatched by
 * {@link dispatchWebhookJob}; the queue itself is created by the caller
 * (`index.ts`) before the receiver enqueues to it.
 *
 * @returns the pg-boss worker id.
 */
export async function registerWebhookProcessingWorker(
  consumer: WebhookJobConsumer,
  deps: WebhookProcessingDeps,
  queueName: string = WEBHOOK_PROCESS_QUEUE,
): Promise<string> {
  return consumer.work<WebhookJob>(queueName, async (jobs) => {
    for (const job of jobs) {
      await dispatchWebhookJob(job.data, deps);
    }
  });
}
