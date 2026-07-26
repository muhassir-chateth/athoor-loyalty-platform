/**
 * SECURITY regression — idempotency keys are scoped per customer (task 38).
 *
 * THE BUG: the stored key was `METHOD route:clientKey`, with no customer in it.
 * The client controls that header value completely, so two customers using the
 * same key on the same route inside the 24-hour window collided — the second
 * received the FIRST customer's stored response verbatim and their own operation
 * never ran. No unlucky collision was needed: a guessable value like `1` was
 * enough. On `POST /v1/redeem` that meant one member could be served another
 * member's redemption response while their own spend silently did not happen.
 *
 * These tests pin the fix and, just as importantly, would FAIL against the old
 * key format — the cross-customer case is the whole point, so it is asserted
 * directly rather than inferred.
 *
 * The `PgIdempotencyStore` case matters separately: task 14 wired the durable
 * store, which is what turned a process-lifetime exposure into a 24-hour one.
 * A restart is simulated by building a brand-new app over the SAME backing rows,
 * which is exactly what a redeploy looks like to the store.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { registerIdempotency, IDEMPOTENT_REPLAY_HEADER } from "./idempotency.js";
import {
  InMemoryIdempotencyStore,
  PgIdempotencyStore,
  type IdempotencyStore,
} from "../idempotency/store.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

/**
 * A tiny in-memory `idempotency_keys` table honouring the two behaviours the
 * real schema enforces: `key` is the PRIMARY KEY, and the insert is
 * `ON CONFLICT (key) DO NOTHING` so the first write wins. Shared across
 * "restarts" so persistence is genuinely exercised.
 */
class FakeIdempotencyTable {
  readonly rows = new Map<
    string,
    { status_code: number; payload: string; content_type: string; created_at: Date }
  >();

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = (rows: QueryResultRow[], command: string): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rows.length,
      command,
      oid: 0,
      fields: [],
    });

    if (text.includes("INSERT INTO idempotency_keys")) {
      const [key, statusCode, payload, contentType] = values as [string, number, string, string];
      // ON CONFLICT (key) DO NOTHING — first write wins.
      if (!this.rows.has(key)) {
        this.rows.set(key, {
          status_code: statusCode,
          payload,
          content_type: contentType,
          created_at: new Date(),
        });
      }
      return ok([], "INSERT");
    }

    if (text.includes("FROM idempotency_keys")) {
      const [key, cutoffIso] = values as [string, string];
      const row = this.rows.get(key);
      if (!row || row.created_at <= new Date(cutoffIso)) {
        return ok([], "SELECT");
      }
      return ok(
        [{ status_code: row.status_code, payload: row.payload, content_type: row.content_type }],
        "SELECT",
      );
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

interface BuiltApp {
  app: FastifyInstance;
  /** How many times the handler actually executed. */
  executions: () => number;
}

/**
 * Builds an app whose `POST /thing` increments a counter, mounted behind an auth
 * preHandler that sets `req.authCtx` — registered BEFORE the idempotency hooks,
 * exactly as `v1.ts` does, so identity is resolved by the time the gate runs.
 *
 * `identity` of `null` models a route mounted with NO identity resolution, which
 * is the fail-closed path.
 */
function buildApp(
  store: IdempotencyStore,
  identity: string | null,
  counter: { n: number } = { n: 0 },
): BuiltApp {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (req) => {
    if (identity !== null) {
      (req as { authCtx?: unknown }).authCtx = {
        customerId: identity,
        source: "app_proxy",
        channel: "web",
      };
    }
  });

  registerIdempotency(app, store);

  app.post("/thing", async () => {
    counter.n += 1;
    return { executions: counter.n, servedTo: identity };
  });
  app.get("/thing", async () => {
    counter.n += 1;
    return { executions: counter.n };
  });

  return { app, executions: () => counter.n };
}

const post = (app: FastifyInstance, key?: string) =>
  app.inject({
    method: "POST",
    url: "/thing",
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });

describe("same customer + same key → replay (Req 9.6 preserved)", () => {
  it("replays the stored response and does not re-execute the handler", async () => {
    const store = new InMemoryIdempotencyStore();
    const { app, executions } = buildApp(store, ALICE);

    const first = await post(app, "shared-key");
    const second = await post(app, "shared-key");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(first.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    // The whole point: exactly one execution.
    expect(executions()).toBe(1);

    await app.close();
  });
});

describe("same customer + different key → executes twice", () => {
  it("treats a different key as a different operation", async () => {
    const store = new InMemoryIdempotencyStore();
    const { app, executions } = buildApp(store, ALICE);

    const first = await post(app, "key-one");
    const second = await post(app, "key-two");

    expect(first.json()).toMatchObject({ executions: 1 });
    expect(second.json()).toMatchObject({ executions: 2 });
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(executions()).toBe(2);

    await app.close();
  });
});

describe("different customers + same key → independent execution (THE FIX)", () => {
  it("does not leak one customer's response to another, and does not suppress theirs", async () => {
    // One shared store, as in production: the two customers differ only by the
    // identity their auth preHandler resolves.
    const store = new InMemoryIdempotencyStore();
    const counter = { n: 0 };
    const alice = buildApp(store, ALICE, counter);
    const bob = buildApp(store, BOB, counter);

    const aliceRes = await post(alice.app, "1"); // a trivially guessable key
    const bobRes = await post(bob.app, "1");

    // Bob's request RAN — it was not suppressed by Alice's stored entry.
    expect(counter.n).toBe(2);
    expect(bobRes.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();

    // Bob did NOT receive Alice's response body.
    expect(aliceRes.json()).toMatchObject({ servedTo: ALICE });
    expect(bobRes.json()).toMatchObject({ servedTo: BOB });
    expect(bobRes.body).not.toBe(aliceRes.body);
    expect(bobRes.body).not.toContain(ALICE);

    await alice.app.close();
    await bob.app.close();
  });

  it("each customer still replays their OWN key independently", async () => {
    const store = new InMemoryIdempotencyStore();
    const counter = { n: 0 };
    const alice = buildApp(store, ALICE, counter);
    const bob = buildApp(store, BOB, counter);

    await post(alice.app, "same");
    await post(bob.app, "same");
    const aliceReplay = await post(alice.app, "same");
    const bobReplay = await post(bob.app, "same");

    // Two executions total, then two replays — never three or four.
    expect(counter.n).toBe(2);
    expect(aliceReplay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(bobReplay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(aliceReplay.json()).toMatchObject({ servedTo: ALICE });
    expect(bobReplay.json()).toMatchObject({ servedTo: BOB });

    await alice.app.close();
    await bob.app.close();
  });

  it("a client cannot forge another customer's namespace via separators in the key", async () => {
    const store = new InMemoryIdempotencyStore();
    const counter = { n: 0 };
    const alice = buildApp(store, ALICE, counter);
    const bob = buildApp(store, BOB, counter);

    await post(alice.app, "k");
    // Bob crafts a key that, under naive concatenation, could reconstruct
    // Alice's namespace.
    const forged = await post(bob.app, `k`);
    const forged2 = await post(bob.app, `${ALICE}|POST /thing:k`);

    expect(forged.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(forged2.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(forged.json()).toMatchObject({ servedTo: BOB });
    expect(forged2.json()).toMatchObject({ servedTo: BOB });
    expect(forged.body).not.toContain(ALICE);

    await alice.app.close();
    await bob.app.close();
  });
});

describe("replay after a process restart still works (PgIdempotencyStore)", () => {
  it("replays across a rebuilt app over the same rows, still scoped per customer", async () => {
    // Task 14 wired this durable store, which is what made the old exposure last
    // 24 hours instead of a process lifetime. A "restart" is a new app over the
    // same table.
    const table = new FakeIdempotencyTable();
    const store = new PgIdempotencyStore(table);
    const counter = { n: 0 };

    const before = buildApp(store, ALICE, counter);
    const first = await post(before.app, "durable-key");
    expect(counter.n).toBe(1);
    await before.app.close();

    // --- restart ---
    const after = buildApp(store, ALICE, counter);
    const replayed = await post(after.app, "durable-key");

    expect(replayed.statusCode).toBe(first.statusCode);
    expect(replayed.body).toBe(first.body);
    expect(replayed.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(counter.n).toBe(1); // Still exactly one execution across the restart.

    // …and the scoping survives the restart too: Bob's identical key executes.
    const bobAfter = buildApp(store, BOB, counter);
    const bobRes = await post(bobAfter.app, "durable-key");
    expect(bobRes.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(counter.n).toBe(2);
    expect(bobRes.json()).toMatchObject({ servedTo: BOB });

    await after.app.close();
    await bobAfter.app.close();
  });

  it("persists the customer-scoped key, so the stored row is not shareable", async () => {
    const table = new FakeIdempotencyTable();
    const store = new PgIdempotencyStore(table);
    const { app } = buildApp(store, ALICE);

    await post(app, "inspect-me");

    const keys = [...table.rows.keys()];
    expect(keys).toHaveLength(1);
    // The customer id is part of the stored key — the property the whole task
    // turns on. Asserting the shape directly is what makes this a regression
    // test rather than a behavioural coincidence.
    expect(keys[0]).toContain(ALICE);
    expect(keys[0]).toBe(`${ALICE}|POST /thing:inspect-me`);

    await app.close();
  });
});

describe("reads and unauthenticated routes are unaffected", () => {
  it("GET is never gated and needs no key", async () => {
    const store = new InMemoryIdempotencyStore();
    const { app, executions } = buildApp(store, ALICE);

    const first = await app.inject({ method: "GET", url: "/thing" });
    const second = await app.inject({ method: "GET", url: "/thing" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Both ran: reads change no state, so they are never deduplicated.
    expect(executions()).toBe(2);

    await app.close();
  });

  it("a GET is not gated even with no identity at all", async () => {
    const store = new InMemoryIdempotencyStore();
    const { app } = buildApp(store, null);

    const res = await app.inject({ method: "GET", url: "/thing" });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("still rejects a missing/invalid key before considering identity (Req 9.7)", async () => {
    const store = new InMemoryIdempotencyStore();
    const { app, executions } = buildApp(store, ALICE);

    const missing = await post(app);
    const blank = await post(app, "   ");

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "invalid_idempotency_key" });
    expect(blank.statusCode).toBe(400);
    expect(executions()).toBe(0);

    await app.close();
  });

  it("FAILS CLOSED on a state-changing request with no resolved identity", async () => {
    const store = new InMemoryIdempotencyStore();
    const { app, executions } = buildApp(store, null);

    const res = await post(app, "orphan-key");

    // Refused rather than falling back to an unscoped, shareable key.
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "idempotency_scope_unavailable" });
    expect(executions()).toBe(0);
    // Nothing was stored, so a later identified request is unaffected.
    expect((store as InMemoryIdempotencyStore).size).toBe(0);

    await app.close();
  });
});
