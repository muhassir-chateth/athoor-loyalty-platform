/**
 * Verified-webhook handler (task 3.2): the fast-ack decision core.
 *
 * By the time this runs, the HMAC gate (task 3.1) has already passed, so the
 * request is authentic. This function performs the remaining webhook-receiver
 * responsibilities in order (design "Component 1: Webhook Receiver"):
 *
 *   1. reject a verified webhook whose X-Shopify-Webhook-Id is missing/empty
 *      (Requirement 12.5);
 *   2. persist the id to durable storage as the dedupe anchor BEFORE any
 *      hand-off (Requirement 12.1);
 *   3. treat a repeated OR concurrent duplicate id as a no-op that changes no
 *      balance (Requirements 12.2, 12.4; Property 6);
 *   4. for a new event, hand off to the job queue and return — all Admin API /
 *      email work is deferred to the worker, never done inline (Requirements
 *      12.3, 13.8).
 *
 * The function is pure orchestration over the injected {@link WebhookEventStore}
 * and {@link WebhookEnqueuer}, so it is fully testable without a live Postgres
 * or queue.
 */
import { createHash } from "node:crypto";
import type { WebhookEventStore } from "./eventStore.js";
import type { WebhookEnqueuer } from "./enqueue.js";

/** Discriminated outcome the HTTP layer maps to a status code. */
export type WebhookOutcome =
  /** No/empty X-Shopify-Webhook-Id — reject, change nothing (Req 12.5). */
  | { outcome: "missing_id" }
  /** First time this id is seen — handed off to the queue (Req 12.3). */
  | { outcome: "accepted" }
  /** Id already recorded (repeat or concurrent) — 200 no-op (Req 12.2/12.4). */
  | { outcome: "duplicate" };

export interface HandleWebhookInput {
  store: WebhookEventStore;
  enqueue: WebhookEnqueuer;
  /** X-Shopify-Webhook-Id (may be undefined/empty — handled here). */
  webhookId: string | undefined;
  /** X-Shopify-Topic. */
  topic: string;
  /** X-Shopify-Shop-Domain. */
  shopDomain: string;
  /** Raw request bytes — hashed for the audit record. */
  rawBody: Buffer;
  /** Parsed body handed to the queue worker. */
  payload: unknown;
}

/** SHA-256 hex of the raw body, stored for audit instead of the raw PII payload. */
function hashPayload(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/**
 * Runs the verify(done)→dedupe→persist→enqueue pipeline for one verified
 * webhook and returns the outcome. Never performs Admin API or email work.
 */
export async function handleVerifiedWebhook(input: HandleWebhookInput): Promise<WebhookOutcome> {
  const { store, enqueue, webhookId, topic, shopDomain, rawBody, payload } = input;

  // (1) Missing/empty id: a verified webhook we cannot deduplicate must be
  // rejected without touching any balance (Requirement 12.5).
  if (typeof webhookId !== "string" || webhookId.trim() === "") {
    return { outcome: "missing_id" };
  }

  // (2)+(3) Persist the id BEFORE hand-off; the UNIQUE constraint resolves
  // repeated and concurrent duplicates atomically. Only the caller that first
  // records the id proceeds (Requirements 12.1, 12.2, 12.4; Property 6).
  const isNew = await store.recordIfNew({
    shopifyWebhookId: webhookId,
    topic,
    payloadHash: hashPayload(rawBody),
  });

  if (!isNew) {
    return { outcome: "duplicate" };
  }

  // (4) Hand off to the queue and return fast. No synchronous Admin API/email
  // work happens here (Requirements 12.3, 13.8).
  await enqueue.enqueueWebhook({ webhookId, topic, shopDomain, payload });

  return { outcome: "accepted" };
}
