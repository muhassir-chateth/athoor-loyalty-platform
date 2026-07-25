import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SHOPIFY_HMAC_HEADER } from "../security/hmac.js";
import { InMemoryWebhookEventStore } from "./eventStore.js";
import { RecordingWebhookEnqueuer } from "./enqueue.js";
import { handleVerifiedWebhook } from "./handler.js";

/**
 * Task 3.2 — webhook idempotency, dedupe, and fast acknowledgement.
 * Covers Requirements 12.1–12.5 and 13.8, and Property 6 (same webhook id twice
 * changes no balances). No live Postgres/queue: the store and enqueuer are
 * in-memory, injected via buildApp.
 */

const WEBHOOK_SECRET = "shpss_idempotency_test_secret";

function sign(raw: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(Buffer.from(raw, "utf8")).digest("base64");
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

function post(app: FastifyInstance, payload: string, webhookId?: string, topic = "orders/paid") {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [SHOPIFY_HMAC_HEADER]: sign(payload),
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": "myathoorlondon.myshopify.com",
  };
  if (webhookId !== undefined) {
    headers["x-shopify-webhook-id"] = webhookId;
  }
  return app.inject({ method: "POST", url: "/webhooks/shopify", headers, payload });
}

describe("webhook dedupe — repeated duplicate is a 200 no-op (Req 12.2, Property 6)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.app.close();
  });

  it("processes a new id once and treats a replay as a no-op that enqueues nothing more", async () => {
    h = makeHarness();
    await h.app.ready();
    const payload = JSON.stringify({ id: 555, total_price: "120.00" });

    const first = await post(h.app, payload, "evt-dupe-1");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, duplicate: false });

    const second = await post(h.app, payload, "evt-dupe-1");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, duplicate: true });

    // Property 6: the same id handed off to the engine exactly once.
    expect(h.enqueuer.jobs).toHaveLength(1);
    expect(h.store.size).toBe(1);
  });
});

describe("webhook dedupe — concurrent duplicates (Req 12.4, Property 6)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.app.close();
  });

  it("hands off exactly one of N concurrent copies of the same id; the rest are no-ops", async () => {
    h = makeHarness();
    await h.app.ready();
    const payload = JSON.stringify({ id: 777, total_price: "50.00" });

    const N = 8;
    const responses = await Promise.all(
      Array.from({ length: N }, () => post(h.app, payload, "evt-concurrent-1")),
    );

    // All are acknowledged 200 (accepted OR duplicate) — never a retry-storm.
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }
    // Exactly one hand-off and one recorded id regardless of concurrency.
    const accepted = responses.filter((r) => r.json().duplicate === false);
    expect(accepted).toHaveLength(1);
    expect(h.enqueuer.jobs).toHaveLength(1);
    expect(h.store.size).toBe(1);
  });
});

describe("webhook missing/empty id rejection (Req 12.5)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.app.close();
  });

  it("rejects a verified webhook with no X-Shopify-Webhook-Id and changes nothing", async () => {
    h = makeHarness();
    await h.app.ready();
    const payload = JSON.stringify({ id: 1 });

    const res = await post(h.app, payload, undefined);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_webhook_id" });

    // Nothing recorded, nothing handed off.
    expect(h.store.size).toBe(0);
    expect(h.enqueuer.jobs).toHaveLength(0);
  });

  it("rejects a verified webhook with an empty/whitespace id", async () => {
    h = makeHarness();
    await h.app.ready();
    const payload = JSON.stringify({ id: 2 });

    const res = await post(h.app, payload, "   ");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_webhook_id" });
    expect(h.store.size).toBe(0);
    expect(h.enqueuer.jobs).toHaveLength(0);
  });
});

describe("webhook fast-ack — defers all work to the queue (Req 12.3, 13.8)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.app.close();
  });

  it("answers 200 and only records + enqueues; no synchronous downstream work", async () => {
    h = makeHarness();
    await h.app.ready();
    const payload = JSON.stringify({ id: 999, total_price: "80.00" });

    const start = Date.now();
    const res = await post(h.app, payload, "evt-fastack-1", "customers/create");
    const elapsedMs = Date.now() - start;

    expect(res.statusCode).toBe(200);
    // Well within the 5-second budget (Req 12.3).
    expect(elapsedMs).toBeLessThan(5000);

    // The receiver's entire effect is: persist the id + enqueue one job.
    expect(h.store.size).toBe(1);
    expect(h.enqueuer.jobs).toHaveLength(1);
    expect(h.enqueuer.jobs[0]).toMatchObject({
      webhookId: "evt-fastack-1",
      topic: "customers/create",
      shopDomain: "myathoorlondon.myshopify.com",
    });
  });
});

describe("handleVerifiedWebhook — persist happens before hand-off (Req 12.1)", () => {
  it("records the id, then enqueues, and only for the first occurrence", async () => {
    const store = new InMemoryWebhookEventStore();
    const enqueuer = new RecordingWebhookEnqueuer();
    const rawBody = Buffer.from(JSON.stringify({ id: 42 }), "utf8");

    const first = await handleVerifiedWebhook({
      store,
      enqueue: enqueuer,
      webhookId: "evt-unit-1",
      topic: "orders/paid",
      shopDomain: "myathoorlondon.myshopify.com",
      rawBody,
      payload: { id: 42 },
    });
    expect(first).toEqual({ outcome: "accepted" });
    expect(store.has("evt-unit-1")).toBe(true);
    expect(enqueuer.jobs).toHaveLength(1);

    const replay = await handleVerifiedWebhook({
      store,
      enqueue: enqueuer,
      webhookId: "evt-unit-1",
      topic: "orders/paid",
      shopDomain: "myathoorlondon.myshopify.com",
      rawBody,
      payload: { id: 42 },
    });
    expect(replay).toEqual({ outcome: "duplicate" });
    expect(enqueuer.jobs).toHaveLength(1); // no second hand-off
  });

  it("returns missing_id without recording or enqueuing when id is empty", async () => {
    const store = new InMemoryWebhookEventStore();
    const enqueuer = new RecordingWebhookEnqueuer();

    const result = await handleVerifiedWebhook({
      store,
      enqueue: enqueuer,
      webhookId: "",
      topic: "orders/paid",
      shopDomain: "myathoorlondon.myshopify.com",
      rawBody: Buffer.from("{}", "utf8"),
      payload: {},
    });
    expect(result).toEqual({ outcome: "missing_id" });
    expect(store.size).toBe(0);
    expect(enqueuer.jobs).toHaveLength(0);
  });
});
