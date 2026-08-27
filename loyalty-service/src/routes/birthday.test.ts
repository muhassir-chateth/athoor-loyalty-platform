/**
 * Tests for `GET`/`PUT /v1/profile/birthday` (N10, N11) — task 12.2, §11.10,
 * Req 11.1, 11.2, 11.9, 21.7.
 *
 * SAFETY: no network, no production, no live Postgres. The fake enforces the same
 * primary keys and the same conditional-UPDATE semantics the real schema does.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import type { Queryable } from "../ledger/repository.js";
import { BIRTHDAY_CHANGE_LOCK_DAYS, BIRTHDAY_WINDOW_DAYS } from "../profile/birthday.js";
import { BIRTHDAY_RATE_LIMIT_MAX_REQUESTS } from "./birthday.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };

let keyN = 0;
function keyed(): Record<string, string> {
  keyN += 1;
  return { ...AUTH, "idempotency-key": `bday-${keyN}-${Math.random().toString(36).slice(2)}` };
}

class FakeDb implements Queryable {
  readonly birthdays = new Map<string, { month: number; day: number; changedAt: Date | null }>();
  readonly grants = new Set<string>();
  now = new Date("2026-06-12T12:00:00Z");

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = sql.trim();
    const cid = String(values[0] ?? "");
    const ok = (rows: QueryResultRow[], rowCount = rows.length): QueryResult<R> => ({
      rows: rows as R[],
      rowCount,
      command: "SELECT",
      oid: 0,
      fields: [],
    });
    if (q.startsWith("INSERT INTO birthday_grants")) {
      const k = `${cid}|${String(values[1])}`;
      if (this.grants.has(k)) return ok([], 0);
      this.grants.add(k);
      return ok([], 1);
    }
    if (q.includes("FROM birthday_grants")) {
      return ok(this.grants.has(`${cid}|${String(values[1])}`) ? [{ one: 1 }] : []);
    }
    if (q.startsWith("INSERT INTO customer_birthdays")) {
      if (this.birthdays.has(cid)) return ok([], 0);
      this.birthdays.set(cid, { month: Number(values[1]), day: Number(values[2]), changedAt: null });
      return ok([], 1);
    }
    if (q.startsWith("UPDATE customer_birthdays")) {
      const row = this.birthdays.get(cid);
      if (!row) return ok([], 0);
      const effective = row.changedAt ?? new Date(0);
      const threshold = new Date(this.now.getTime() - Number(values[3]) * 86_400_000);
      if (effective.getTime() > threshold.getTime()) return ok([], 0);
      this.birthdays.set(cid, {
        month: Number(values[1]),
        day: Number(values[2]),
        changedAt: this.now,
      });
      return ok([], 1);
    }
    if (q.includes("FROM customer_birthdays")) {
      const row = this.birthdays.get(cid);
      return ok(row ? [{ birth_month: row.month, birth_day: row.day, changed_at: row.changedAt }] : []);
    }
    throw new Error(`FakeDb: unknown statement: ${q}`);
  }
}

/**
 * `maxRequests` is a parameter because the production limit (5/h) is deliberately
 * tighter than some tests need. A test that sweeps six malformed payloads is asserting
 * the VALIDATION contract, and letting the limiter cut it short at the sixth would make
 * that test pass or fail for a reason it does not name. The limiter's own behaviour —
 * including the fact that a rejected body still spends allowance — is asserted
 * separately and explicitly below.
 */
function buildApp(db: FakeDb, maxRequests?: number): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    birthdayDeps: {
      db,
      clock: { now: () => db.now },
      ...(maxRequests === undefined ? {} : { birthdayRateLimit: { maxRequests } }),
    },
  });
  return app;
}

describe("GET /v1/profile/birthday (N10)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("reports not_set with a null birthday and a changeable record", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/birthday", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      birthday: null,
      eligibility: { state: "not_set", windowOpensOn: null, windowDays: BIRTHDAY_WINDOW_DAYS },
      changeable: { allowed: true, allowedFrom: null },
    });
  });

  it("reports eligible inside the window", async () => {
    const db = new FakeDb();
    db.birthdays.set(CUSTOMER, { month: 6, day: 10, changedAt: null });
    app = buildApp(db);
    await app.ready();
    const body = (await app.inject({ method: "GET", url: "/v1/profile/birthday", headers: AUTH })).json();
    expect(body.eligibility).toMatchObject({ state: "eligible", windowOpensOn: "2026-06-10" });
  });

  it("reports already_granted_this_year once a grant exists for the London year", async () => {
    const db = new FakeDb();
    db.birthdays.set(CUSTOMER, { month: 6, day: 10, changedAt: null });
    db.grants.add(`${CUSTOMER}|2026`);
    app = buildApp(db);
    await app.ready();
    const body = (await app.inject({ method: "GET", url: "/v1/profile/birthday", headers: AUTH })).json();
    expect(body.eligibility.state).toBe("already_granted_this_year");
  });

  it("carries no birth year anywhere in the body (Req 11.10)", async () => {
    const db = new FakeDb();
    db.birthdays.set(CUSTOMER, { month: 2, day: 29, changedAt: null });
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/birthday", headers: AUTH });
    expect(Object.keys(res.json().birthday).sort()).toEqual(["day", "month"]);
    expect(res.json().birthday).not.toHaveProperty("year");
  });

  it("requires an identity", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/profile/birthday" })).statusCode).toBe(401);
  });
});

describe("PUT /v1/profile/birthday (N11)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("sets a birthday for the FIRST time and returns the GET shape", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 6, day: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      birthday: { month: 6, day: 10 },
      eligibility: { state: "eligible" },
    });
    expect(db.birthdays.get(CUSTOMER)).toMatchObject({ month: 6, day: 10, changedAt: null });
  });

  it("ACCEPTS 29 February", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 2, day: 29 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().birthday).toEqual({ month: 2, day: 29 });
  });

  it("BLOCKS a change inside 365 days with 409 and an allowedFrom date", async () => {
    const db = new FakeDb();
    db.birthdays.set(CUSTOMER, {
      month: 6,
      day: 10,
      changedAt: new Date("2026-04-02T10:00:00Z"),
    });
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 1, day: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "birthday_change_locked",
      allowedFrom: "2027-04-02",
    });
    // The refusal changed nothing.
    expect(db.birthdays.get(CUSTOMER)).toMatchObject({ month: 6, day: 10 });
  });

  it("ALLOWS a change once 365 days have elapsed", async () => {
    const db = new FakeDb();
    db.birthdays.set(CUSTOMER, {
      month: 6,
      day: 10,
      changedAt: new Date("2025-01-01T10:00:00Z"),
    });
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 3, day: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(db.birthdays.get(CUSTOMER)).toMatchObject({ month: 3, day: 3 });
  });

  it("resolves N CONCURRENT changes to exactly one winner", async () => {
    const db = new FakeDb();
    db.birthdays.set(CUSTOMER, {
      month: 1,
      day: 1,
      changedAt: new Date("2020-01-01T00:00:00Z"),
    });
    app = buildApp(db);
    await app.ready();
    const results = await Promise.all(
      [2, 3, 4, 5].map((m) =>
        app.inject({
          method: "PUT",
          url: "/v1/profile/birthday",
          headers: keyed(),
          payload: { month: m, day: 10 },
        }),
      ),
    );
    // One 200, the rest 409 — the conditional UPDATE, not read-then-write.
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
  });

  it("returns field CODES, never sentences, for a malformed body (Req 21.7)", async () => {
    const db = new FakeDb();
    // A permissive limiter: this test is about the validation contract, and there are
    // more malformed shapes worth checking than the production allowance permits.
    app = buildApp(db, 1000);
    await app.ready();
    for (const [payload, expectedCode] of [
      [{ month: 2, day: 30 }, "invalid_day_for_month"],
      [{ month: 4, day: 31 }, "invalid_day_for_month"],
      [{ month: 13, day: 1 }, "out_of_range"],
      [{ month: 1, day: 0 }, "out_of_range"],
      [{ month: 1.5, day: 1 }, "not_an_integer"],
      [{ day: 1 }, "required"],
    ] as const) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/profile/birthday",
        headers: keyed(),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_request");
      expect(body.fields.map((f: { code: string }) => f.code)).toContain(expectedCode);
      for (const field of body.fields) {
        expect(field.code).toMatch(/^[a-z][a-z_]*$/);
      }
    }
    // Nothing was stored by any rejection.
    expect(db.birthdays.size).toBe(0);
  });

  it("DISTINGUISHES a missing field from a wrongly-typed one (Req 21.7)", async () => {
    const db = new FakeDb();
    app = buildApp(db, 1000);
    await app.ready();
    // zod reports BOTH of these as `invalid_type`, so a mapping derived from its issue
    // taxonomy collapses them into one code and the client cannot tell "you forgot this"
    // from "this is the wrong sort of thing". The codes come from `validateBirthday`
    // precisely so they stay distinct.
    const missing = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { day: 1 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().fields).toEqual([{ field: "month", code: "required" }]);

    const wrongType = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: "6", day: 10 },
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().fields).toEqual([{ field: "month", code: "not_an_integer" }]);

    const nulled = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: null, day: 10 },
    });
    expect(nulled.statusCode).toBe(400);
    expect(nulled.json().fields).toEqual([{ field: "month", code: "required" }]);
    expect(db.birthdays.size).toBe(0);
  });

  it("reduces a body that is NOT AN OBJECT to both fields required", async () => {
    const db = new FakeDb();
    app = buildApp(db, 1000);
    await app.ready();
    for (const payload of ["hello", 42, [1, 2], true] as const) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/profile/birthday",
        headers: { ...keyed(), "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
      // Never a 500, and never a 400 that names nothing.
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      const fields = res.json().fields;
      expect(Array.isArray(fields) && fields.length > 0, JSON.stringify(payload)).toBe(true);
      for (const f of fields) {
        expect(f.code).toMatch(/^[a-z][a-z_]*$/);
        expect(["month", "day"]).toContain(f.field);
      }
    }
    expect(db.birthdays.size).toBe(0);
  });

  it("STRIPS an attempted birth year rather than storing it (Req 11.10)", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 6, day: 10, year: 1990 },
    });
    expect(res.statusCode).toBe(200);
    // A field that cannot arrive cannot be stored by accident.
    expect(res.json().birthday).toEqual({ month: 6, day: 10 });
    expect(JSON.stringify(res.json())).not.toContain("1990");
  });

  it("requires an Idempotency-Key on this state-changing method", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: AUTH,
      payload: { month: 6, day: 10 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_idempotency_key");
  });

  it(`rate limits after ${BIRTHDAY_RATE_LIMIT_MAX_REQUESTS} writes in the window`, async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    for (let i = 0; i < BIRTHDAY_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await app.inject({
        method: "PUT",
        url: "/v1/profile/birthday",
        headers: keyed(),
        payload: { month: 6, day: 10 },
      });
    }
    const limited = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 6, day: 10 },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().message).toContain("birthday");
  });

  it("SPENDS rate-limit allowance on a REJECTED body, so probing is not free (task 10.4)", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    // Every one of these is refused at validation — but the limiter runs FIRST, so each
    // still costs the caller an attempt. If validation were ordered ahead of the
    // limiter, a caller could probe which month/day combinations the calendar accepts
    // an unbounded number of times, and this loop would leave a full allowance behind.
    for (let i = 0; i < BIRTHDAY_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/profile/birthday",
        headers: keyed(),
        payload: { month: 2, day: 30 },
      });
      expect(res.statusCode).toBe(400);
    }
    // The allowance is now spent. A well-formed request is refused by the LIMITER,
    // which is only possible if the five rejected bodies were counted.
    const next = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 6, day: 10 },
    });
    expect(next.statusCode).toBe(429);
    // And nothing was stored along the way.
    expect(db.birthdays.size).toBe(0);
  });

  it("rejects an UNAUTHENTICATED write before it can spend anyone's allowance", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    // Auth precedes the limiter (task 10.4), so a stranger cannot exhaust a real
    // customer's allowance — there is no identity yet to charge it to.
    for (let i = 0; i < BIRTHDAY_RATE_LIMIT_MAX_REQUESTS + 3; i += 1) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/profile/birthday",
        headers: { "idempotency-key": `anon-${i}` },
        payload: { month: 6, day: 10 },
      });
      expect(res.statusCode).toBe(401);
    }
    // The authenticated customer's allowance is untouched.
    const mine = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 6, day: 10 },
    });
    expect(mine.statusCode).toBe(200);
  });

  it("requires an identity BEFORE reporting anything about the body", async () => {
    const db = new FakeDb();
    app = buildApp(db);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      payload: { month: 99, day: 99 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("invalid_day_for_month");
  });

  it("never touches another customer's row", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const db = new FakeDb();
    db.birthdays.set(other, { month: 12, day: 25, changedAt: null });
    app = buildApp(db);
    await app.ready();
    await app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: keyed(),
      payload: { month: 1, day: 1 },
    });
    expect(db.birthdays.get(other)).toMatchObject({ month: 12, day: 25 });
    expect(db.birthdays.get(CUSTOMER)).toMatchObject({ month: 1, day: 1 });
  });

  it("uses the 365-day constant the SQL is given", () => {
    expect(BIRTHDAY_CHANGE_LOCK_DAYS).toBe(365);
  });
});
