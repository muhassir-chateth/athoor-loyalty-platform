/**
 * `GET`/`PUT /v1/profile/preferences` route tests (N12, N13) — task 13.2,
 * §12.8, Req 12.1, 12.2, 12.7, 13.1, 13.2, 21.7.
 *
 * SAFETY: no network, no production, no live Postgres. The fake enforces the same
 * keys and the same partial unique index the real schema does, and its transaction
 * is a real all-or-nothing snapshot so the atomicity claim is actually tested
 * rather than asserted.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import type { Queryable } from "../ledger/repository.js";
import { COMMUNICATION_DEFAULTS, PREFERENCE_LIMITS, PREFERENCE_VOCABULARY } from "../profile/preferences.js";
import { PREFERENCES_RATE_LIMIT_MAX_REQUESTS } from "./preferences.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BEARER_TOKEN = "valid-caa-token";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };

let keyN = 0;
function keyed(): Record<string, string> {
  keyN += 1;
  return { ...AUTH, "idempotency-key": `pref-${keyN}-${Math.random().toString(36).slice(2)}` };
}

class FakeUniqueViolation extends Error {
  constructor() {
    super('duplicate key value violates unique constraint "idx_fragrance_pref_single_intensity"');
    this.name = "FakeUniqueViolation";
  }
}

/** Postgres stand-in with a REAL all-or-nothing transaction. */
class FakeDb implements Queryable {
  declared = new Set<string>();
  communication = new Map<
    string,
    {
      product_launches: boolean;
      restock_alerts: boolean;
      birthday_messages: boolean;
      referral_updates: boolean;
    }
  >();
  /** Set to a statement fragment to make that statement throw once. */
  failOn: string | null = null;

  rowsFor(customerId: string): { dimension: string; value: string }[] {
    return [...this.declared]
      .filter((k) => k.startsWith(`${customerId}|`))
      .map((k) => {
        const [, dimension, value] = k.split("|");
        return { dimension: dimension ?? "", value: value ?? "" };
      });
  }

  /**
   * A real transaction: the work runs against a SNAPSHOT and is only published on
   * success. A pass-through would make every atomicity test vacuous.
   */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const declaredSnapshot = new Set(this.declared);
    const commsSnapshot = new Map(
      [...this.communication.entries()].map(([k, v]) => [k, { ...v }] as const),
    );
    try {
      return await fn(this);
    } catch (err) {
      this.declared = declaredSnapshot;
      this.communication = commsSnapshot;
      throw err;
    }
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = sql.trim();
    if (this.failOn !== null && q.includes(this.failOn)) {
      this.failOn = null;
      throw new Error("injected statement failure");
    }
    const cid = String(values[0] ?? "");
    const ok = (rows: QueryResultRow[], rowCount = rows.length): QueryResult<R> => ({
      rows: rows as R[],
      rowCount,
      command: "SELECT",
      oid: 0,
      fields: [],
    });

    if (q.startsWith("INSERT INTO customer_fragrance_preferences")) {
      const dimension = String(values[1]);
      const value = String(values[2]);
      if (dimension === "intensity") {
        const existing = this.rowsFor(cid).filter((r) => r.dimension === "intensity");
        if (existing.some((r) => r.value !== value)) throw new FakeUniqueViolation();
      }
      const key = `${cid}|${dimension}|${value}`;
      if (this.declared.has(key)) return ok([], 0);
      this.declared.add(key);
      return ok([], 1);
    }
    if (q.startsWith("DELETE FROM customer_fragrance_preferences")) {
      const dimension = String(values[1]);
      const keep = new Set((values[2] as string[]) ?? []);
      let deleted = 0;
      for (const key of [...this.declared]) {
        const [owner, dim, value] = key.split("|");
        if (owner !== cid || dim !== dimension) continue;
        if (!keep.has(value ?? "")) {
          this.declared.delete(key);
          deleted += 1;
        }
      }
      return ok([], deleted);
    }
    if (q.includes("FROM customer_fragrance_preferences")) {
      return ok(this.rowsFor(cid));
    }
    if (q.startsWith("INSERT INTO customer_communication_preferences")) {
      if (this.communication.has(cid)) return ok([], 0);
      this.communication.set(cid, {
        product_launches: false,
        restock_alerts: false,
        birthday_messages: true,
        referral_updates: true,
      });
      return ok([], 1);
    }
    if (q.startsWith("UPDATE customer_communication_preferences")) {
      const row = this.communication.get(cid);
      if (!row) return ok([], 0);
      const co = <T>(v: unknown, cur: T): T => (v === null ? cur : (v as T));
      this.communication.set(cid, {
        product_launches: co(values[1], row.product_launches),
        restock_alerts: co(values[2], row.restock_alerts),
        birthday_messages: co(values[3], row.birthday_messages),
        referral_updates: co(values[4], row.referral_updates),
      });
      return ok([], 1);
    }
    if (q.includes("FROM customer_communication_preferences")) {
      const row = this.communication.get(cid);
      return ok(row ? [row] : []);
    }
    throw new Error(`FakeDb: unknown statement: ${q}`);
  }
}

function buildApp(db: FakeDb, maxRequests?: number): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    preferencesDeps: {
      db,
      transactor: { transaction: (fn) => db.transaction(fn) },
      ...(maxRequests === undefined ? {} : { preferencesRateLimit: { maxRequests } }),
    },
  });
  return app;
}

async function put(
  app: FastifyInstance,
  payload: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: "PUT",
    url: "/v1/profile/preferences",
    headers: keyed(),
    payload: payload as never,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe("GET /v1/profile/preferences (N12)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("returns the four contract blocks and nothing else", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/preferences", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // `apiVersion` is injected by the versioning plugin on every payload (Req 9.8).
    expect(Object.keys(body).sort()).toEqual([
      "apiVersion",
      "communication",
      "declared",
      "limits",
      "vocabulary",
    ]);
  });

  it("reports empty declared values and DEFAULT communication for a new customer", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const body = (
      await app.inject({ method: "GET", url: "/v1/profile/preferences", headers: AUTH })
    ).json();
    expect(body.declared).toEqual({
      scent_family: [],
      note: [],
      intensity: null,
      occasion: [],
      season: [],
    });
    expect(body.communication).toEqual(COMMUNICATION_DEFAULTS);
  });

  it("ships the server-owned vocabulary and limits so the client renders from the API", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const body = (
      await app.inject({ method: "GET", url: "/v1/profile/preferences", headers: AUTH })
    ).json();
    expect(body.vocabulary).toEqual(PREFERENCE_VOCABULARY);
    expect(body.limits).toEqual(PREFERENCE_LIMITS);
  });

  it("reports stored values", async () => {
    const db = new FakeDb();
    db.declared.add(`${CUSTOMER}|scent_family|oud`);
    db.declared.add(`${CUSTOMER}|intensity|bold`);
    app = buildApp(db);
    await app.ready();
    const body = (
      await app.inject({ method: "GET", url: "/v1/profile/preferences", headers: AUTH })
    ).json();
    expect(body.declared.scent_family).toEqual(["oud"]);
    expect(body.declared.intensity).toBe("bold");
  });

  it("requires an identity", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    expect(
      (await app.inject({ method: "GET", url: "/v1/profile/preferences" })).statusCode,
    ).toBe(401);
  });

  it("NEVER reads another customer's rows, even when they exist (Req 2.1, IDOR)", async () => {
    // METAMORPHIC, because a substring check cannot work here: every response
    // carries the whole vocabulary, so `floral` appears in it legitimately. The
    // property that actually matters is that the OTHER customer's rows change
    // nothing — so the response is compared against one produced with those rows
    // absent, and must be byte-identical.
    const populate = (db: FakeDb): void => {
      db.declared.add(`${OTHER}|scent_family|floral`);
      db.declared.add(`${OTHER}|intensity|subtle`);
      db.communication.set(OTHER, {
        product_launches: true,
        restock_alerts: true,
        birthday_messages: false,
        referral_updates: false,
      });
    };

    const withForeign = new FakeDb();
    populate(withForeign);
    app = buildApp(withForeign);
    await app.ready();
    const seen = await app.inject({ method: "GET", url: "/v1/profile/preferences", headers: AUTH });
    await app.close();

    const clean = buildApp(new FakeDb());
    await clean.ready();
    const baseline = await clean.inject({
      method: "GET",
      url: "/v1/profile/preferences",
      headers: AUTH,
    });
    await clean.close();
    app = buildApp(new FakeDb()); // for afterEach

    expect(seen.statusCode).toBe(200);
    expect(seen.body).toBe(baseline.body);
    expect(seen.json().declared).toEqual({
      scent_family: [],
      note: [],
      intensity: null,
      occasion: [],
      season: [],
    });
    expect(seen.json().communication).toEqual(COMMUNICATION_DEFAULTS);
  });

  it("IGNORES a customer id supplied by the browser (Req 1.2)", async () => {
    const db = new FakeDb();
    db.declared.add(`${OTHER}|scent_family|floral`);
    db.declared.add(`${OTHER}|intensity|subtle`);
    app = buildApp(db);
    await app.ready();
    // Every channel a browser could try: query string, header, cookie. The
    // response must be identical to the one with no such values supplied at all.
    const plain = await app.inject({
      method: "GET",
      url: "/v1/profile/preferences",
      headers: AUTH,
    });
    const spoofed = await app.inject({
      method: "GET",
      url: `/v1/profile/preferences?customerId=${OTHER}&customer_id=${OTHER}`,
      headers: { ...AUTH, "x-customer-id": OTHER, cookie: `customerId=${OTHER}` },
    });
    expect(spoofed.statusCode).toBe(200);
    expect(spoofed.body).toBe(plain.body);
    expect(spoofed.json().declared.scent_family).toEqual([]);
    expect(spoofed.json().declared.intensity).toBeNull();
  });
});

describe("PUT /v1/profile/preferences (N13)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("stores a declared set and RETURNS the stored state, not an echo", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const { statusCode, body } = await put(app, { declared: { scent_family: ["woody", "oud"] } });
    expect(statusCode).toBe(200);
    // Vocabulary order, not submitted order — proof it came back from storage.
    expect((body.declared as Record<string, unknown>).scent_family).toEqual(["oud", "woody"]);
    expect(db.rowsFor(CUSTOMER)).toHaveLength(2);
  });

  it("accepts an EMPTY body as a no-op and still returns the stored state", async () => {
    const db = new FakeDb();
    db.declared.add(`${CUSTOMER}|note|rose`);
    app = buildApp(db);
    await app.ready();
    const { statusCode, body } = await put(app, {});
    expect(statusCode).toBe(200);
    expect((body.declared as Record<string, unknown>).note).toEqual(["rose"]);
  });

  it("applies a SUBSET without clobbering an untouched dimension", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    await put(app, { declared: { scent_family: ["oud"], note: ["rose"] } });
    await put(app, { declared: { note: ["saffron"] } });
    const { body } = await put(app, {});
    const declared = body.declared as Record<string, unknown>;
    expect(declared.scent_family).toEqual(["oud"]);
    expect(declared.note).toEqual(["saffron"]);
  });

  it("is IDEMPOTENT: the same body twice leaves identical state", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const payload = { declared: { scent_family: ["oud", "amber"] }, communication: { restockAlerts: true } };
    const first = await put(app, payload);
    const second = await put(app, payload);
    expect(second.body.declared).toEqual(first.body.declared);
    expect(second.body.communication).toEqual(first.body.communication);
    expect(db.rowsFor(CUSTOMER)).toHaveLength(2);
  });

  it("CHANGES intensity across the partial unique index without a violation", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    expect((await put(app, { declared: { intensity: "subtle" } })).statusCode).toBe(200);
    const changed = await put(app, { declared: { intensity: "bold" } });
    expect(changed.statusCode).toBe(200);
    expect((changed.body.declared as Record<string, unknown>).intensity).toBe("bold");
    expect(db.rowsFor(CUSTOMER).filter((r) => r.dimension === "intensity")).toHaveLength(1);
  });

  it("clears intensity with null", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    await put(app, { declared: { intensity: "bold" } });
    const cleared = await put(app, { declared: { intensity: null } });
    expect((cleared.body.declared as Record<string, unknown>).intensity).toBeNull();
  });

  it("applies a PARTIAL communication patch and leaves the rest at its stored value", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const { body } = await put(app, { communication: { productLaunches: true } });
    expect(body.communication).toEqual({
      productLaunches: true,
      restockAlerts: false,
      birthdayMessages: true,
      referralUpdates: true,
    });
  });

  it("writes declared and communication together in ONE save", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const { body } = await put(app, {
      declared: { season: ["winter"] },
      communication: { birthdayMessages: false },
    });
    expect((body.declared as Record<string, unknown>).season).toEqual(["winter"]);
    expect((body.communication as Record<string, unknown>).birthdayMessages).toBe(false);
  });

  it("ROLLS BACK every dimension when one statement fails (§12.8 atomicity)", async () => {
    const db = new FakeDb();
    db.declared.add(`${CUSTOMER}|scent_family|oud`);
    app = buildApp(db);
    await app.ready();
    // Fail the communication insert, which runs AFTER both dimensions were written.
    db.failOn = "INSERT INTO customer_communication_preferences";
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/preferences",
      headers: keyed(),
      payload: { declared: { scent_family: ["amber"], note: ["rose"] }, communication: { restockAlerts: true } },
    });
    expect(res.statusCode).toBe(500);
    // Neither dimension moved, and the pre-existing value survived — a half-applied
    // save is the outcome the transaction exists to prevent.
    expect(db.rowsFor(CUSTOMER)).toEqual([{ dimension: "scent_family", value: "oud" }]);
    expect(db.communication.has(CUSTOMER)).toBe(false);
  });

  it("REJECTS marketingConsent by name — Shopify owns consent (§13.1, Req 13.4)", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const { statusCode, body } = await put(app, { communication: { marketingConsent: true } });
    expect(statusCode).toBe(400);
    expect(body.error).toBe("invalid_request");
    expect(body.fields).toEqual([
      { field: "communication.marketingConsent", code: "unknown_key" },
    ]);
    // Nothing was created — a 200 here would imply consent was recorded.
    expect(db.communication.has(CUSTOMER)).toBe(false);
  });

  it("returns field CODES, never sentences, for every malformed shape (Req 21.7)", async () => {
    const db = new FakeDb();
    app = buildApp(db, 1000);
    await app.ready();
    const cases: readonly [unknown, string][] = [
      [{ declared: { scent_family: ["plutonium"] } }, "unknown_value"],
      [{ declared: { scentFamily: ["oud"] } }, "unknown_dimension"],
      [{ declared: { scent_family: "oud" } }, "not_an_array"],
      [{ declared: { note: [7] } }, "not_a_string"],
      [{ declared: { intensity: ["bold"] } }, "not_a_string"],
      [{ declared: { season: ["spring", "spring"] } }, "duplicate_value"],
      [{ declared: { season: [...PREFERENCE_VOCABULARY.season, "spring"] } }, "too_many_values"],
      [{ communication: { productLaunches: "yes" } }, "not_a_boolean"],
      [{ nope: 1 }, "unknown_key"],
      [{ declared: [] }, "not_an_object"],
    ];
    for (const [payload, expectedCode] of cases) {
      const { statusCode, body } = await put(app, payload);
      expect(statusCode, JSON.stringify(payload)).toBe(400);
      expect(body.error).toBe("invalid_request");
      const codes = (body.fields as { code: string }[]).map((f) => f.code);
      expect(codes, JSON.stringify(payload)).toContain(expectedCode);
      for (const code of codes) expect(code).toMatch(/^[a-z][a-z_]*$/);
    }
    expect(db.declared.size).toBe(0);
  });

  it("reduces a body that is NOT AN OBJECT to a single named code", async () => {
    const db = new FakeDb();
    app = buildApp(db, 1000);
    await app.ready();
    for (const payload of ["hello", 42, [1, 2], true]) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/profile/preferences",
        headers: { ...keyed(), "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().fields).toEqual([{ field: "body", code: "not_an_object" }]);
    }
    expect(db.declared.size).toBe(0);
  });

  it("stores NOTHING when any part of the body is invalid", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    // `scent_family` is valid, `note` is not. Applying the good half would be a
    // partial save the customer never asked for.
    const { statusCode } = await put(app, {
      declared: { scent_family: ["oud"], note: ["plutonium"] },
    });
    expect(statusCode).toBe(400);
    expect(db.declared.size).toBe(0);
  });

  it("requires an Idempotency-Key on this state-changing method", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/preferences",
      headers: AUTH,
      payload: { declared: { scent_family: ["oud"] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_idempotency_key");
  });

  it(`rate limits after ${PREFERENCES_RATE_LIMIT_MAX_REQUESTS} writes in the window`, async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    for (let i = 0; i < PREFERENCES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await put(app, { declared: { scent_family: ["oud"] } });
    }
    const limited = await put(app, { declared: { scent_family: ["oud"] } });
    expect(limited.statusCode).toBe(429);
    expect(String(limited.body.message)).toContain("preference");
  });

  it("SPENDS allowance on a REJECTED body, so probing the vocabulary is not free", async () => {
    const db = new FakeDb();
    app = buildApp(db, 3);
    await app.ready();
    for (let i = 0; i < 3; i += 1) {
      expect((await put(app, { declared: { scent_family: ["plutonium"] } })).statusCode).toBe(400);
    }
    // A well-formed request now hits the limiter, which is only possible if the
    // three rejections were counted. Without this ordering a caller could
    // enumerate the accepted vocabulary an unbounded number of times.
    expect((await put(app, { declared: { scent_family: ["oud"] } })).statusCode).toBe(429);
    expect(db.declared.size).toBe(0);
  });

  it("requires an identity BEFORE reporting anything about the body", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/preferences",
      payload: { declared: { scent_family: ["plutonium"] } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("unknown_value");
    expect(res.body).not.toContain("oud");
  });

  it("rejects an UNAUTHENTICATED write before it can spend a real customer's allowance", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    for (let i = 0; i < PREFERENCES_RATE_LIMIT_MAX_REQUESTS + 3; i += 1) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/profile/preferences",
        headers: { "idempotency-key": `anon-${i}` },
        payload: { declared: { scent_family: ["oud"] } },
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await put(app, { declared: { scent_family: ["oud"] } })).statusCode).toBe(200);
  });

  it("NEVER writes another customer's rows (Req 2.1, 2.3)", async () => {
    const db = new FakeDb();
    db.declared.add(`${OTHER}|scent_family|floral`);
    db.communication.set(OTHER, {
      product_launches: true,
      restock_alerts: true,
      birthday_messages: true,
      referral_updates: true,
    });
    app = buildApp(db);
    await app.ready();
    // A clear on this customer must not empty the other customer's set.
    await put(app, { declared: { scent_family: [] }, communication: { productLaunches: false } });
    expect(db.rowsFor(OTHER)).toEqual([{ dimension: "scent_family", value: "floral" }]);
    expect(db.communication.get(OTHER)?.product_launches).toBe(true);
  });

  it("IGNORES a browser-supplied customer id on the write path (Req 1.2)", async () => {
    const db = new FakeDb();
    db.declared.add(`${OTHER}|note|rose`);
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/profile/preferences?customerId=${OTHER}`,
      headers: { ...keyed(), "x-customer-id": OTHER, cookie: `customerId=${OTHER}` },
      payload: { declared: { note: [] }, customerId: OTHER },
    });
    // `customerId` in the body is an unknown top-level key, so the body is refused
    // outright — and the other customer's row is untouched either way.
    expect(res.statusCode).toBe(400);
    expect(db.rowsFor(OTHER)).toEqual([{ dimension: "note", value: "rose" }]);
  });

  it("accepts every value of every vocabulary end to end", async () => {
    const db = new FakeDb();
    app = buildApp(db, 1000);
    await app.ready();
    for (const dimension of ["scent_family", "note", "occasion", "season"] as const) {
      const values = [...PREFERENCE_VOCABULARY[dimension]].slice(0, PREFERENCE_LIMITS[dimension]);
      const { statusCode, body } = await put(app, { declared: { [dimension]: values } });
      expect(statusCode, dimension).toBe(200);
      expect((body.declared as Record<string, unknown>)[dimension]).toEqual(values);
    }
    for (const value of PREFERENCE_VOCABULARY.intensity) {
      const { body } = await put(app, { declared: { intensity: value } });
      expect((body.declared as Record<string, unknown>).intensity).toBe(value);
    }
  });
});

describe("the routes register even with NO dependency wired", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("answers 401 rather than 404 for an unauthenticated caller", async () => {
    app = Fastify({ logger: false });
    registerVersioning(app);
    app.register(v1Routes, { prefix: "/v1", appProxySecret: APP_PROXY_SECRET });
    await app.ready();
    // A 404 would read to a client as "this account has no preferences" and would
    // silently shrink the unauthenticated route census.
    for (const method of ["GET", "PUT"] as const) {
      const res = await app.inject({
        method,
        url: "/v1/profile/preferences",
        ...(method === "PUT" ? { headers: { "idempotency-key": "x" }, payload: {} } : {}),
      });
      expect(res.statusCode, method).toBe(401);
    }
  });

  it("REFUSES rather than inventing a state for an authenticated caller", async () => {
    app = Fastify({ logger: false });
    registerVersioning(app);
    app.register(v1Routes, {
      prefix: "/v1",
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER }),
      tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
      appProxySecret: APP_PROXY_SECRET,
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/preferences", headers: AUTH });
    // Loud, not a reassuring empty set of preferences.
    expect(res.statusCode).toBe(500);
  });

  it("REFUSES a write rather than applying it outside a transaction", async () => {
    const db = new FakeDb();
    app = Fastify({ logger: false });
    registerVersioning(app);
    app.register(v1Routes, {
      prefix: "/v1",
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER }),
      tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
      appProxySecret: APP_PROXY_SECRET,
      // A db but NO transactor: the dangerous half-wiring. A pass-through default
      // would apply set-replacements without atomicity and every test would pass.
      preferencesDeps: { db },
    });
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/preferences",
      headers: keyed(),
      payload: { declared: { scent_family: ["oud"] } },
    });
    expect(res.statusCode).toBe(500);
    expect(db.declared.size).toBe(0);
  });
});
