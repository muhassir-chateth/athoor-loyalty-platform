/**
 * Webhook hand-off enqueuer (task 3.2).
 *
 * The webhook receiver's only job after verify + dedupe + persist is to hand
 * the event off to the job queue and return `200` fast (Requirements 12.3,
 * 13.8). ALL Admin API and email work — earning, discount-code minting,
 * notifications — happens later, in a queue worker, never synchronously in the
 * request path. This module is that hand-off boundary.
 *
 * The engine/worker that consumes these jobs is a later task (earning is task
 * 4.x); here we only define the job shape, the queue name, and the enqueuer
 * contract with a pg-boss-backed implementation and an in-memory recorder used
 * by tests and as the default in `buildApp`.
 *
 * SAFETY: defining this module touches no live system and calls no Admin API.
 * The pg-boss enqueuer only publishes to the local Postgres-backed queue when a
 * real pg-boss instance is injected at runtime.
 */

/** The queue a verified, deduplicated webhook is handed off to. */
export const WEBHOOK_PROCESS_QUEUE = "webhook.process" as const;

/**
 * The hand-off payload. Deliberately small: the worker re-reads authoritative
 * data as needed. Carries the identifying headers plus the parsed body so the
 * engine can process without re-parsing the raw request.
 */
export interface WebhookJob {
  /** X-Shopify-Webhook-Id — also the natural idempotency key for the job. */
  webhookId: string;
  /** X-Shopify-Topic, e.g. "orders/paid". */
  topic: string;
  /** X-Shopify-Shop-Domain. */
  shopDomain: string;
  /** The parsed webhook body. */
  payload: unknown;
}

/**
 * Hand-off contract. Implementations MUST return quickly and MUST NOT perform
 * Admin API or email work inline (Requirements 12.3, 13.8).
 */
export interface WebhookEnqueuer {
  enqueueWebhook(job: WebhookJob): Promise<void>;
}

/**
 * The subset of pg-boss this enqueuer relies on. Declared structurally so the
 * real `PgBoss` instance satisfies it without a hard type import here.
 */
export interface JobPublisher {
  send(queue: string, data: object, options?: object): Promise<string | null>;
}

/**
 * pg-boss-backed enqueuer. Publishes one job per accepted webhook, keyed by the
 * webhook id via pg-boss's `singletonKey` so a job for a given webhook id is not
 * duplicated in the queue even if the (deduped) hand-off is somehow retried.
 */
export class PgBossWebhookEnqueuer implements WebhookEnqueuer {
  constructor(private readonly boss: JobPublisher) {}

  async enqueueWebhook(job: WebhookJob): Promise<void> {
    await this.boss.send(
      WEBHOOK_PROCESS_QUEUE,
      { ...job },
      { singletonKey: job.webhookId },
    );
  }
}

/**
 * In-memory enqueuer — the default when no queue is injected and the enqueuer
 * used by tests. Records the jobs it received so tests can assert that exactly
 * one hand-off happened and that no synchronous processing occurred in the
 * request path.
 */
export class RecordingWebhookEnqueuer implements WebhookEnqueuer {
  readonly jobs: WebhookJob[] = [];

  async enqueueWebhook(job: WebhookJob): Promise<void> {
    this.jobs.push(job);
  }
}
