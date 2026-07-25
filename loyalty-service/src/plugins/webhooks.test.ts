import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SHOPIFY_HMAC_HEADER } from "../security/hmac.js";

const WEBHOOK_SECRET = "shpss_integration_test_secret";

function sign(raw: string, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(raw, "utf8")).digest("base64");
}

describe("POST /webhooks/shopify — HMAC verification (Req 11.1, 11.2)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_WEBHOOK_SECRET: WEBHOOK_SECRET });
    app = buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const payload = JSON.stringify({ id: 820982911946154508, email: "customer@example.com" });

  it("accepts a webhook whose signature matches the raw body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        [SHOPIFY_HMAC_HEADER]: sign(payload),
        // A valid, verifiable webhook now also carries its idempotency id
        // (Req 12.5): a verified webhook without one is rejected (see 3.2 tests).
        "x-shopify-webhook-id": "evt-accepts-1",
        "x-shopify-topic": "orders/paid",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
  });

  it("rejects a tampered body with HTTP 401", async () => {
    // Sign the original, then send a modified body under the same signature.
    const signature = sign(payload);
    const tampered = JSON.stringify({ id: 820982911946154508, email: "attacker@example.com" });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        [SHOPIFY_HMAC_HEADER]: signature,
      },
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_hmac" });
  });

  it("rejects an invalid signature with HTTP 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        [SHOPIFY_HMAC_HEADER]: "totally-invalid-signature",
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_hmac" });
  });

  it("rejects a signature made with the wrong secret with HTTP 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        [SHOPIFY_HMAC_HEADER]: sign(payload, "wrong_secret"),
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing HMAC header with HTTP 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_hmac" });
  });
});

describe("webhook HMAC gate is fail-closed when unconfigured", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // No SHOPIFY_WEBHOOK_SECRET provided.
    const config = loadConfig({ NODE_ENV: "test" });
    app = buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects with 401 when no webhook secret is configured", async () => {
    const payload = JSON.stringify({ id: 1 });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        [SHOPIFY_HMAC_HEADER]: sign(payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "webhook_verification_unavailable" });
  });
});

describe("raw-body parser is encapsulated to /webhooks", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_WEBHOOK_SECRET: WEBHOOK_SECRET });
    app = buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("leaves default JSON handling on /v1 and /health intact", async () => {
    // Existing non-webhook routes still respond normally — proving the scoped
    // content-type parser did not leak into the rest of the app.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const version = await app.inject({ method: "GET", url: "/v1/version" });
    expect(version.statusCode).toBe(200);
  });
});
