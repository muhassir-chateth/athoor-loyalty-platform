import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  InMemoryIdempotencyStore,
  isValidIdempotencyKey,
  type IdempotencyStore,
} from "../idempotency/store.js";

/**
 * Reusable idempotency middleware for state-changing `/v1` requests
 * (Requirements 9.6, 9.7).
 *
 * Registered inside the `/v1` router scope so it applies to every current and
 * future state-changing loyalty operation without per-handler wiring:
 *
 *   - On a state-changing request (POST/PUT/PATCH/DELETE) it requires an
 *     `Idempotency-Key` header of 1–128 characters; a missing or invalid key is
 *     rejected with `400 invalid_idempotency_key` and the handler never runs, so
 *     no state change occurs (Requirement 9.7).
 *   - If a response was already stored for that key within the 24h window, the
 *     stored result is replayed verbatim and the handler never runs, so no
 *     additional state change occurs (Requirement 9.6). The replay carries an
 *     `Idempotent-Replay: true` header for observability.
 *   - Otherwise the handler runs and its response is stored (first-write-wins)
 *     so the next repeat inside the window replays it.
 *
 * Read requests (GET/HEAD/OPTIONS) are never gated — they change no state.
 *
 * Handling is stateless (Requirement 9.8): the middleware sets no session
 * cookie and keeps no per-connection state; all dedupe state lives in the
 * injected {@link IdempotencyStore}, keyed by method + route + key.
 */

/** The header carrying the client's idempotency key (Fastify lower-cases header names). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** The header set on a replayed (deduplicated) response. */
export const IDEMPOTENT_REPLAY_HEADER = "idempotent-replay";

/** HTTP methods that mutate state and therefore require an idempotency key. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Responses with a status at or above this are transient and not cached, so a retry can reprocess. */
const NON_CACHEABLE_STATUS_FLOOR = 500;

declare module "fastify" {
  interface FastifyRequest {
    /** The namespaced store key for this request; set once a valid key is accepted. */
    idempotencyStorageKey?: string;
    /** True when this response was served from the store (do not re-store it). */
    idempotencyReplayed?: boolean;
  }
}

/** Read a single-valued header, tolerating the array form Node uses. */
function readHeader(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers[name];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Namespaces the client key by method + route pattern so the same key used on
 * two different operations never collides. Uses the matched route template
 * (e.g. `/v1/redeem`) rather than the raw URL so query strings don't fragment
 * the key.
 *
 * NOTE: once identity resolution lands (task 6.2), the resolved `customers.id`
 * should be folded into this namespace so a key is scoped per customer, exactly
 * as the redemption engine scopes `(customer_id, idempotency_key)`.
 */
function storageKeyFor(req: FastifyRequest, key: string): string {
  const routeId = req.routeOptions?.url ?? req.url;
  return `${req.method} ${routeId}:${key}`;
}

/**
 * Registers the idempotency hooks on `app`. Confine the effect to a route scope
 * by calling this inside an encapsulated plugin (the `/v1` router does exactly
 * this). The store defaults to in-memory so the gateway runs with no live
 * Postgres.
 */
export function registerIdempotency(
  app: FastifyInstance,
  store: IdempotencyStore = new InMemoryIdempotencyStore(),
): void {
  // Gate + replay before the handler runs.
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!STATE_CHANGING_METHODS.has(req.method)) {
      return;
    }

    const key = readHeader(req, IDEMPOTENCY_KEY_HEADER);
    if (!isValidIdempotencyKey(key)) {
      // Missing/invalid key on a state-changing request: reject, run no handler,
      // change no state (Requirement 9.7).
      reply.code(400).send({
        error: "invalid_idempotency_key",
        message:
          "State-changing requests require an 'Idempotency-Key' header of 1 to 128 characters.",
      });
      return reply;
    }

    const storageKey = storageKeyFor(req, key);
    req.idempotencyStorageKey = storageKey;

    const stored = await store.get(storageKey);
    if (stored) {
      // Repeat within the 24h window: replay the stored result verbatim; the
      // handler never runs, so no additional state change occurs (Req 9.6).
      req.idempotencyReplayed = true;
      reply.code(stored.statusCode);
      reply.header("content-type", stored.contentType);
      reply.header(IDEMPOTENT_REPLAY_HEADER, "true");
      return reply.send(stored.payload);
    }
  });

  // Persist the first response so the next repeat can replay it.
  app.addHook(
    "onSend",
    async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      const storageKey = req.idempotencyStorageKey;
      // Nothing to store for reads, invalid-key rejections, or replays.
      if (!storageKey || req.idempotencyReplayed) {
        return payload;
      }
      // Only cache fully-serialized string bodies; skip streams/buffers.
      if (typeof payload !== "string") {
        return payload;
      }
      // Do not cache transient server errors — let a retry reprocess them.
      if (reply.statusCode >= NON_CACHEABLE_STATUS_FLOOR) {
        return payload;
      }
      const contentType = String(
        reply.getHeader("content-type") ?? "application/json; charset=utf-8",
      );
      await store.put(storageKey, {
        statusCode: reply.statusCode,
        payload,
        contentType,
      });
      return payload;
    },
  );
}
