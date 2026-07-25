import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { SHOPIFY_HMAC_HEADER, verifyShopifyHmac } from "../security/hmac.js";
import {
  InMemoryWebhookEventStore,
  type WebhookEventStore,
} from "../webhooks/eventStore.js";
import {
  RecordingWebhookEnqueuer,
  type WebhookEnqueuer,
} from "../webhooks/enqueue.js";
import { handleVerifiedWebhook } from "../webhooks/handler.js";

/**
 * The raw request body bytes, captured by the scoped content-type parser so
 * HMAC verification runs over exactly what Shopify sent (Requirement 11.1).
 */
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** Shopify identifying headers (Fastify normalises names to lower-case). */
const SHOPIFY_WEBHOOK_ID_HEADER = "x-shopify-webhook-id";
const SHOPIFY_TOPIC_HEADER = "x-shopify-topic";
const SHOPIFY_SHOP_DOMAIN_HEADER = "x-shopify-shop-domain";

export interface WebhookPluginOptions {
  config: AppConfig;
  /**
   * Durable dedupe anchor. Production injects a Pg-backed store; when omitted
   * (tests / local) an in-memory store is used so no live Postgres is required.
   */
  eventStore?: WebhookEventStore;
  /**
   * Hand-off boundary to the job queue. Production injects a pg-boss enqueuer;
   * when omitted a recording no-op is used (tests / local).
   */
  enqueuer?: WebhookEnqueuer;
}

/** Read a single-valued header, tolerating the array form Node uses. */
function readHeader(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers[name];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Encapsulated webhook receiver plugin.
 *
 * Because this is registered WITHOUT `fastify-plugin`, the content-type parser
 * and lifecycle hooks added here are confined to this plugin's scope — the
 * default JSON parsing used by `/v1` and `/health` is left untouched
 * (Requirement 11.2).
 *
 * Pipeline: HMAC verification (task 3.1) then verify→dedupe→persist→enqueue
 * (task 3.2). A verified webhook is deduplicated by its `X-Shopify-Webhook-Id`
 * against `webhook_events`, persisted before hand-off, and handed to the job
 * queue; all Admin API/email work is deferred to the worker so the receiver
 * always answers fast (Requirements 12.1–12.5, 13.8).
 */
export async function webhookRoutes(
  app: FastifyInstance,
  opts: WebhookPluginOptions,
): Promise<void> {
  const { config } = opts;
  // Default to in-memory implementations so the plugin runs without a live
  // Postgres or queue. Production wires the Pg-backed store + pg-boss enqueuer.
  const eventStore = opts.eventStore ?? new InMemoryWebhookEventStore();
  const enqueuer = opts.enqueuer ?? new RecordingWebhookEnqueuer();

  // Capture the raw body bytes for JSON webhooks. `parseAs: "buffer"` hands us
  // the exact bytes; we stash them on the request for the HMAC hook and then
  // parse leniently so that signature verification — not JSON validity — is the
  // gatekeeper. This parser is encapsulated to the webhook scope only.
  app.addContentTypeParser<Buffer>(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body;
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch {
        // Defer to the HMAC hook: an unverified request must be rejected with
        // 401 rather than leaking a 400 parse error.
        done(null, undefined);
      }
    },
  );

  // Verify HMAC before any handler runs. preValidation fires after body parsing
  // (so rawBody is available) but before the route handler, so a rejected
  // webhook never reaches business logic and changes no state.
  app.addHook("preValidation", async (req: FastifyRequest, reply: FastifyReply) => {
    const secret = config.shopify.webhookSecret;

    // Without a configured secret we cannot verify authenticity; never process
    // an unverified event — reject rather than fail open (Requirement 11.2).
    if (!secret) {
      req.log.error("SHOPIFY_WEBHOOK_SECRET is not configured; rejecting webhook");
      reply.code(401).send({ error: "webhook_verification_unavailable" });
      return reply;
    }

    const rawBody = req.rawBody;
    const provided = readHeader(req, SHOPIFY_HMAC_HEADER);

    if (!rawBody || !verifyShopifyHmac(rawBody, provided, secret)) {
      reply.code(401).send({ error: "invalid_hmac" });
      return reply;
    }
  });

  // Single verified-webhook entrypoint. Reaching this handler means the HMAC
  // check passed (task 3.1). We now run dedupe/persist/enqueue (task 3.2) and
  // always answer fast: 200 for accepted OR duplicate; 400 only for a verified
  // webhook missing its idempotency id (Requirement 12.5).
  app.post("/shopify", async (req: FastifyRequest, reply: FastifyReply) => {
    const webhookId = readHeader(req, SHOPIFY_WEBHOOK_ID_HEADER);
    const topic = readHeader(req, SHOPIFY_TOPIC_HEADER) ?? "";
    const shopDomain = readHeader(req, SHOPIFY_SHOP_DOMAIN_HEADER) ?? config.shopify.shopDomain;

    const result = await handleVerifiedWebhook({
      store: eventStore,
      enqueue: enqueuer,
      webhookId,
      topic,
      shopDomain,
      // rawBody is guaranteed present here: the HMAC hook rejects otherwise.
      rawBody: req.rawBody ?? Buffer.alloc(0),
      payload: req.body,
    });

    switch (result.outcome) {
      case "missing_id":
        // Verified but un-deduplicable: reject, change nothing (Req 12.5).
        reply.code(400).send({ error: "missing_webhook_id" });
        return reply;
      case "duplicate":
        // Repeat or concurrent duplicate: 200 no-op (Req 12.2, 12.4).
        return { received: true, duplicate: true };
      case "accepted":
        // Handed off to the queue; worker does the rest (Req 12.3, 13.8).
        return { received: true, duplicate: false };
    }
  });
}
