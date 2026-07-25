import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SHOPIFY_HMAC_HEADER } from "../security/hmac.js";
import { InMemoryWebhookEventStore } from "./eventStore.js";
import { RecordingWebhookEnqueuer } from "./enqueue.js";
import { handleVerifiedWebhook } from "./handler.js";

/**
 * Task 3.3 — Property test for idempotent webhooks.
 *
 * **Property 6 (Idempotent webhooks):** processing the same
 * `X-Shopify-Webhook-Id` twice changes no balances.
 * **Validates: Requirements 12.2**
 *
 * The webhook receiver never mutates a balance itself: its entire observable
 * state effect for a verified webhook is (a) recording the id in
 * `webhook_events` as the dedupe anchor and (b) handing off exactly one job to
 * the queue that would later change a balance. Therefore, at the receiver, the
 * faithful expression of "reprocessing the same id changes no balances" is:
 *
 *   for ANY multiset of verified deliveries, the number of hand-offs (jobs that
 *   could change a balance) equals the number of DISTINCT webhook ids — every
 *   repeated or concurrent duplicate id is a pure no-op that enqueues nothing
 *   further and records nothing further.
 *
 * These properties assert exactly that invariant across arbitrarily generated
 * delivery sequences (repeated, interleaved, and concurrent duplicates), at
 * both the pure-handler layer and the full HTTP layer via `app.inject`. No live
 * Postgres/queue: the in-memory store + recording enqueuer are injected via
 * buildApp, matching the existing example-based tests in `idempotency.test.ts`.
 */

const WEBHOOK_SECRET = "shpss_idempotency_property_secret";
const NUM_RUNS = 200;

function sign(raw: string): string {
  return crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(Buffer.from(raw, "utf8"))
    .digest("base64");
}

interface Harness {
  app: FastifyInstance;
  store: InMemoryWebhookEventStore;
  enqueuer: RecordingWebhookEnqueuer;
}

function makeHarness(): Harness {
  const config = loadConfig({ NODE_ENV: "test", SHOPIFY_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const store = new InMemoryWebhookEventStore();
  const enqueuer = new RecordingWebhookEnqueuer();
  const app = buildApp(config, { webhookEventStore: store, webhookEnqueuer: enqueuer });
  return { app, store, enqueuer };
}

function post(app: FastifyInstance, payload: string, webhookId: string, topic: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [SHOPIFY_HMAC_HEADER]: sign(payload),
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": "myathoorlondon.myshopify.com",
    "x-shopify-webhook-id": webhookId,
  };
  return app.inject({ method: "POST", url: "/webhooks/shopify", headers, payload });
}

// ---- Smart generators constrained to the input space -----------------------

/** A Shopify webhook topic the receiver accepts. */
const topicArb = fc.constantFrom(
  "orders/paid",
  "customers/create",
  "refunds/create",
  "orders/cancelled",
);

/**
 * A small pool of webhook ids so a delivery sequence sampling from it is
 * GUARANTEED to contain duplicates (that is the whole point of the property).
 * Ids are distinct, non-empty strings shaped like Shopify's.
 */
const idPoolArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 })
  .map((ns) => ns.map((n) => `evt-${n}`));

/**
 * A single delivery: an id drawn from the pool plus an arbitrary topic/payload.
 * Payload varies independently of the id so we also cover the case where the
 * "same id" arrives carrying different bodies (a replay must still be a no-op).
 */
function deliveryArb(pool: string[]) {
  return fc.record({
    id: fc.constantFrom(...pool),
    topic: topicArb,
    orderId: fc.integer({ min: 1, max: 1_000_000 }),
    total: fc.integer({ min: 0, max: 100_000 }),
  });
}

/** A non-empty sequence of deliveries drawn from a shared id pool. */
const deliveriesArb = idPoolArb.chain((pool) =>
  fc.record({
    pool: fc.constant(pool),
    deliveries: fc.array(deliveryArb(pool), { minLength: 1, maxLength: 30 }),
  }),
);

// ---- Properties ------------------------------------------------------------

describe("Property 6 — idempotent webhooks change no balances (Req 12.2)", () => {
  it("handler: hand-offs equal DISTINCT ids for any sequence of repeated deliveries", async () => {
    await fc.assert(
      fc.asyncProperty(deliveriesArb, async ({ deliveries }) => {
        // Fresh state per run so each property case is independent.
        const store = new InMemoryWebhookEventStore();
        const enqueuer = new RecordingWebhookEnqueuer();

        const acceptedIds = new Set<string>();
        for (const d of deliveries) {
          const rawBody = Buffer.from(
            JSON.stringify({ id: d.orderId, total_price: d.total }),
            "utf8",
          );
          const outcome = await handleVerifiedWebhook({
            store,
            enqueue: enqueuer,
            webhookId: d.id,
            topic: d.topic,
            shopDomain: "myathoorlondon.myshopify.com",
            rawBody,
            payload: { id: d.orderId, total_price: d.total },
          });

          // First sighting of an id must be accepted; every later sighting of
          // that same id must be a no-op duplicate (Property 6 / Req 12.2).
          if (acceptedIds.has(d.id)) {
            expect(outcome).toEqual({ outcome: "duplicate" });
          } else {
            expect(outcome).toEqual({ outcome: "accepted" });
            acceptedIds.add(d.id);
          }
        }

        const distinctIds = new Set(deliveries.map((d) => d.id));
        // Exactly one hand-off per distinct id — reprocessing enqueued nothing
        // more, so no additional balance-changing work was created.
        expect(enqueuer.jobs).toHaveLength(distinctIds.size);
        expect(store.size).toBe(distinctIds.size);
        // Each distinct id was handed off exactly once.
        const enqueuedIds = enqueuer.jobs.map((j) => j.webhookId).sort();
        expect(enqueuedIds).toEqual([...distinctIds].sort());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("HTTP: exactly one accepted response per distinct id, the rest 200 no-ops", async () => {
    await fc.assert(
      fc.asyncProperty(deliveriesArb, async ({ deliveries }) => {
        const h = makeHarness();
        await h.app.ready();
        try {
          const acceptedIds = new Set<string>();
          for (const d of deliveries) {
            const payload = JSON.stringify({ id: d.orderId, total_price: d.total });
            const res = await post(h.app, payload, d.id, d.topic);

            // Never a retry-storm: verified deliveries always ack 200.
            expect(res.statusCode).toBe(200);
            const body = res.json();
            if (acceptedIds.has(d.id)) {
              expect(body).toMatchObject({ received: true, duplicate: true });
            } else {
              expect(body).toMatchObject({ received: true, duplicate: false });
              acceptedIds.add(d.id);
            }
          }

          const distinctIds = new Set(deliveries.map((d) => d.id));
          expect(h.enqueuer.jobs).toHaveLength(distinctIds.size);
          expect(h.store.size).toBe(distinctIds.size);
        } finally {
          await h.app.close();
        }
      }),
      { numRuns: 60 },
    );
  });

  it("concurrent duplicates: N simultaneous copies of one id hand off exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
        async (n, idSuffix) => {
          const store = new InMemoryWebhookEventStore();
          const enqueuer = new RecordingWebhookEnqueuer();
          const webhookId = `evt-concurrent-${encodeURIComponent(idSuffix)}`;
          const rawBody = Buffer.from(JSON.stringify({ id: 1, total_price: 10 }), "utf8");

          const outcomes = await Promise.all(
            Array.from({ length: n }, () =>
              handleVerifiedWebhook({
                store,
                enqueue: enqueuer,
                webhookId,
                topic: "orders/paid",
                shopDomain: "myathoorlondon.myshopify.com",
                rawBody,
                payload: { id: 1 },
              }),
            ),
          );

          // Exactly one of N concurrent copies is accepted; the rest are no-ops.
          const accepted = outcomes.filter((o) => o.outcome === "accepted");
          expect(accepted).toHaveLength(1);
          expect(enqueuer.jobs).toHaveLength(1);
          expect(store.size).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
