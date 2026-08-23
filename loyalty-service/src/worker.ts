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
 *   - `customers/create`  → {@link handleCustomersCreateEnrollment} (enrol, then
 *                          signup +50 only when genuinely due)
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
import { CUSTOMERS_CREATE_TOPIC, type SignupJobDeps } from "./earning/signup.js";
// The single enrollment implementation. `customers/create` is dispatched through
// this rather than calling the signup earning directly, so the webhook path, the
// authenticated fallback and the migration backfill all share one definition of
// "ensure this customer is enrolled" and one signup-award gate.
import { handleCustomersCreateEnrollment } from "./enrollment/ensureCustomerEnrollment.js";
import {
  handleOrdersPaidJob,
  ORDERS_PAID_TOPIC,
  type OrderJobDeps,
} from "./earning/order.js";
import {
  handleRefundJob,
  handleOrderCancelledJob,
  REFUNDS_CREATE_TOPIC,
  ORDERS_CANCELLED_TOPIC,
} from "./earning/clawback.js";
import type { MetafieldCacheEnqueuer } from "./shopify/metafieldCache.js";
import type { WebhookEventOutcomeRecorder } from "./webhooks/eventStore.js";

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
  /**
   * OPTIONAL outcome recorder (task 23, Req 12.1/12.3/13.8). Advances
   * `webhook_events.status` to `processed` (stamping `processed_at`) after a
   * successful dispatch, or to `failed` when dispatch throws, so the dedupe
   * table records OUTCOME as well as receipt. Without it every row stayed at
   * `received` with a NULL `processed_at`, leaving no way to distinguish
   * "handled", "failed" and "still queued" during an investigation.
   *
   * Best-effort and NON-FATAL: the ledger append has already committed inside
   * the handler's transaction before the outcome is recorded, so a status-write
   * failure must never fail — or re-run — the work itself.
   */
  outcomeRecorder?: WebhookEventOutcomeRecorder;
  /**
   * OPTIONAL referral-code assigner (task 25), forwarded to the signup handler
   * so a new member leaves `customers/create` with their own shareable code.
   */
  ensureReferralCode?: SignupJobDeps["ensureReferralCode"];
  /**
   * OPTIONAL referral stage advance (task 25), forwarded to the order handler so
   * a friend's FIRST paid purchase credits their referrer +250 (Req 2.10/11.9)
   * inside the same transaction as the order earning.
   */
  advanceReferralStage?: OrderJobDeps["advanceReferralStage"];
  /**
   * OPTIONAL observability hook for a FAILED cache-refresh enqueue (task 35).
   * The enqueue is best-effort: the ledger append has already committed, so a
   * queue failure must never fail — or re-run — the earning. Reporting it here
   * keeps that non-fatality from being silent; without a hook the failure is
   * swallowed and the periodic reconciliation job is the safety net (Req 13.7).
   */
  onCacheEnqueueError?: (err: unknown, customerId: string) => void;
}

/**
 * Enqueues a metafield-cache refresh for `customerId` when an enqueuer is wired.
 * A no-op when no enqueuer is configured (Admin token absent) — the periodic
 * reconciliation job then keeps the cache converged (Req 13.7).
 *
 * BEST-EFFORT (task 35): the balance change has already committed by the time
 * this runs, so a queue failure is reported and swallowed rather than thrown. If
 * it propagated, pg-boss would retry an already-applied earning and the webhook
 * would be recorded `failed` because a NON-AUTHORITATIVE cache write could not
 * be scheduled (Req 13.1/13.5).
 */
async function enqueueCacheRefresh(
  deps: WebhookProcessingDeps,
  customerId: string,
): Promise<void> {
  if (!deps.metafieldEnqueuer) {
    return;
  }
  try {
    await deps.metafieldEnqueuer.enqueueMetafieldCache({ customerId });
  } catch (err) {
    deps.onCacheEnqueueError?.(err, customerId);
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
 *
 * `orders/paid` can move TWO balances: the buyer's earning and, on the buyer's
 * first paid purchase as a referred friend, the REFERRER's +250. Both are
 * enqueued (task 35).
 */
export async function dispatchWebhookJob(
  job: WebhookJob,
  deps: WebhookProcessingDeps,
): Promise<void> {
  switch (job.topic) {
    case CUSTOMERS_CREATE_TOPIC: {
      // Routed through the SHARED enrollment service (task: enrollment repair).
      // Previously this called `handleCustomersCreateJob` directly, which left
      // two enrollment implementations: the webhook path and the lazy-fallback /
      // backfill path. One of them owned the migration veto and the other did
      // not, so a `customers/create` replayed for a MIGRATED customer could have
      // credited +50 on top of an imported legacy balance.
      //
      // The award itself is unchanged — the service delegates to the same
      // `earnSignup`, so the +50 amount, the per-customer `earn_signup`
      // idempotency guard, the 12-month Point_Lot and referral-code assignment
      // all keep exactly one definition. What is added is the Layer 2 ledger
      // veto (migrated state ⇒ never a signup).
      const outcome = await handleCustomersCreateEnrollment(job, deps);
      if (outcome && outcome.signupAward === "awarded") {
        await enqueueCacheRefresh(deps, outcome.customerId);
      }
      return;
    }
    case ORDERS_PAID_TOPIC: {
      const outcome = await handleOrdersPaidJob(job, deps);
      if (outcome && outcome.status === "earned") {
        // The BUYER earned points on this order.
        await enqueueCacheRefresh(deps, outcome.customerId);
        // …and if this was the buyer's first paid purchase as a referred friend,
        // their REFERRER was credited +250 in the same transaction. That is a
        // DIFFERENT customer, so the buyer's refresh above does nothing for them
        // — without this the referrer's cached `loyalty.points_balance` stayed
        // stale after the award (task 35, audit F4). Enqueued here, after the
        // order transaction has committed, never from inside it.
        if (outcome.referralAward) {
          await enqueueCacheRefresh(deps, outcome.referralAward.referrerId);
        }
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
      await dispatchWithOutcome(job.data, deps);
    }
  });
}

/**
 * Dispatches one job and records its outcome on `webhook_events` (task 23).
 *
 * The error is always re-thrown after being recorded, so pg-boss's retry policy
 * is unchanged: recording the outcome is observability, never flow control. The
 * recorder itself is guarded, because a failure to WRITE A STATUS must not
 * convert a successful ledger append into a retried one.
 */
export async function dispatchWithOutcome(
  job: WebhookJob,
  deps: WebhookProcessingDeps,
): Promise<void> {
  try {
    await dispatchWebhookJob(job, deps);
  } catch (err) {
    await recordOutcome(deps, job.webhookId, "failed");
    throw err;
  }
  await recordOutcome(deps, job.webhookId, "processed");
}

/** Best-effort status write; swallows its own failure by design (task 23). */
async function recordOutcome(
  deps: WebhookProcessingDeps,
  webhookId: string | undefined,
  outcome: "processed" | "failed",
): Promise<void> {
  // A job always carries the id the receiver deduped on; guard defensively so a
  // malformed job can never throw from the observability path.
  if (!deps.outcomeRecorder || !webhookId) {
    return;
  }
  try {
    if (outcome === "processed") {
      await deps.outcomeRecorder.markProcessed(webhookId);
    } else {
      await deps.outcomeRecorder.markFailed(webhookId);
    }
  } catch {
    // Non-fatal: the ledger is authoritative and already committed.
  }
}
