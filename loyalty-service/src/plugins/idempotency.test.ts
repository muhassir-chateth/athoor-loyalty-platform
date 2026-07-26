/**
 * Behavioural tests for the reusable idempotency middleware (task 6.1,
 * Requirements 9.6, 9.7, 9.8).
 *
 * The middleware is exercised through a real Fastify instance with a
 * side-effecting POST route (a counter). This lets us assert that a replayed
 * request returns the STORED result and does NOT re-run the handler (no
 * additional state change), and that missing/invalid keys are rejected before
 * the handler runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerIdempotency, IDEMPOTENT_REPLAY_HEADER } from "./idempotency.js";
import { InMemoryIdempotencyStore } from "../idempotency/store.js";

/** Builds an app whose POST /things increments a counter and echoes it. */
function buildTestApp(store: InMemoryIdempotencyStore): { app: FastifyInstance; getCount: () => number } {
  const app = Fastify({ logger: false });
  let count = 0;

  // Encapsulated scope so the idempotency hooks are confined here, exactly as
  // they are confined to /v1 in production.
  app.register(async (scope) => {
    // Resolved identity, set by a preHandler registered BEFORE the idempotency
    // hooks — mirroring `v1.ts`, where auth always runs first. Required since
    // task 38: the storage key is scoped per customer, and a state-changing
    // request with no identity is refused rather than sharing an unscoped key.
    // These tests exercise ONE customer, so the scoping is invisible to them and
    // every Req 9.6/9.7/9.8 assertion below is unchanged. Cross-customer
    // behaviour is covered in `idempotencyScoping.test.ts`.
    scope.addHook("preHandler", async (req) => {
      (req as { authCtx?: unknown }).authCtx = {
        customerId: "00000000-0000-4000-8000-000000000001",
        source: "app_proxy",
        channel: "web",
      };
    });

    registerIdempotency(scope, store);

    scope.post("/things", async () => {
      count += 1;
      return { count };
    });

    scope.get("/things", async () => {
      return { count };
    });
  });

  return { app, getCount: () => count };
}

describe("idempotency middleware (Req 9.6/9.7/9.8)", () => {
  let store: InMemoryIdempotencyStore;
  let app: FastifyInstance;
  let getCount: () => number;

  beforeEach(async () => {
    store = new InMemoryIdempotencyStore();
    const built = buildTestApp(store);
    app = built.app;
    getCount = built.getCount;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects a state-changing request with no idempotency key (Req 9.7)", async () => {
    const res = await app.inject({ method: "POST", url: "/things" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_idempotency_key" });
    // Handler never ran → no state change.
    expect(getCount()).toBe(0);
  });

  it("rejects an over-length (129-char) idempotency key (Req 9.7)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "idempotency-key": "x".repeat(129) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_idempotency_key" });
    expect(getCount()).toBe(0);
  });

  it("rejects a blank idempotency key (Req 9.7)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "idempotency-key": "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(getCount()).toBe(0);
  });

  it("processes a first request with a valid key and stores the result", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "idempotency-key": "key-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ count: 1 });
    expect(res.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(getCount()).toBe(1);
  });

  it("returns the STORED result on a repeated key without re-running the handler (Req 9.6)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "idempotency-key": "key-1" },
    });
    expect(first.json()).toMatchObject({ count: 1 });

    const replay = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "idempotency-key": "key-1" },
    });
    // Identical stored body — NOT count: 2.
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ count: 1 });
    expect(replay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    // The side effect happened exactly once (no additional state change).
    expect(getCount()).toBe(1);
  });

  it("processes independently for distinct keys", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "idempotency-key": "key-a" },
    });
    const b = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "idempotency-key": "key-b" },
    });
    expect(a.json()).toMatchObject({ count: 1 });
    expect(b.json()).toMatchObject({ count: 2 });
    expect(getCount()).toBe(2);
  });

  it("does not gate read (GET) requests — no key required", async () => {
    const res = await app.inject({ method: "GET", url: "/things" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ count: 0 });
  });

  it("keeps handling stateless — never sets a session cookie (Req 9.8)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "idempotency-key": "key-1" },
    });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
