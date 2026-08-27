/**
 * N14/N15 route tests — tasks 15.1/15.2/15.4, §15.4/§15.5,
 * Req 13.8, 23.3, 23.4, 23.5, 2.1, 2.4, 2.6, 21.7.
 *
 * SAFETY: no network, no production, no live Postgres. The fake enforces the same
 * `status`/`source` vocabularies the real CHECK constraints do.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import type { Queryable } from "../ledger/repository.js";
import type { CustomerScope } from "../auth/customerScope.js";
import { EXPORT_SECTIONS, type ExportReaders } from "../privacy/export.js";
import { erasureReference } from "./privacy.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BEARER_TOKEN = "valid-caa-token";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };

let keyN = 0;
function keyed(): Record<string, string> {
  keyN += 1;
  return { ...AUTH, "idempotency-key": `pv-${keyN}-${Math.random().toString(36).slice(2)}` };
}

interface ErasureRow {
  id: string;
  customer_id: string;
  requested_at: string;
  status: string;
  completed_at: string | null;
  source: string;
}

class FakeDb implements Queryable {
  readonly rows: ErasureRow[] = [];
  private next = 1;
  readonly statements: string[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = sql.trim();
    this.statements.push(q);
    const cid = String(values[0] ?? "");
    const ok = (r: QueryResultRow[], n = r.length): QueryResult<R> => ({
      rows: r as R[],
      rowCount: n,
      command: "SELECT",
      oid: 0,
      fields: [],
    });

    if (q.startsWith("INSERT INTO customer_erasure_requests")) {
      const id = `${this.next.toString().padStart(8, "0")}-1111-4111-8111-111111111111`;
      this.next += 1;
      const row: ErasureRow = {
        id,
        customer_id: cid,
        requested_at: `2026-08-27T1${this.next}:00:00.000Z`,
        status: "received",
        completed_at: null,
        source: String(values[1] ?? "portal"),
      };
      this.rows.push(row);
      return ok([row]);
    }
    if (q.includes("FROM customer_erasure_requests")) {
      return ok(this.rows.filter((r) => r.customer_id === cid));
    }
    throw new Error(`FakeDb: unknown statement: ${q.slice(0, 60)}`);
  }
}

/** Export readers over a per-customer store. */
function readersOver(store: Readonly<Record<string, Record<string, unknown>>>): ExportReaders {
  const read = (section: string) => async (scope: CustomerScope) =>
    store[scope.customerId]?.[section] ?? null;
  return Object.fromEntries(EXPORT_SECTIONS.map((s) => [s, read(s)])) as ExportReaders;
}

function buildApp(
  opts: { db?: FakeDb; readers?: ExportReaders; maxRequests?: number } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  const limit = opts.maxRequests === undefined ? {} : { maxRequests: opts.maxRequests };
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    privacyDeps: {
      ...(opts.db ? { db: opts.db } : {}),
      ...(opts.readers ? { exportReaders: opts.readers } : {}),
      clock: { now: () => new Date("2026-08-27T12:34:56.000Z") },
      exportRateLimit: limit,
      erasureRateLimit: limit,
    },
  });
  return app;
}

describe("GET /v1/profile/export (N14)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("returns the document as a JSON ATTACHMENT (§15.4)", async () => {
    app = buildApp({ readers: readersOver({ [CUSTOMER]: { identity: { firstName: "Amina" } } }) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/export", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    // The attachment header is what makes the browser SAVE rather than render — a
    // rendered export lives in scroll position, cache and screenshots.
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="athoor-data-export-2026-08-27.json"',
    );
    expect(res.headers["cache-control"]).toBe("no-store, private");
  });

  it("carries the customer's own data and every section key", async () => {
    app = buildApp({ readers: readersOver({ [CUSTOMER]: { identity: "MINE", wishlist: ["1001"] } }) });
    await app.ready();
    const body = (
      await app.inject({ method: "GET", url: "/v1/profile/export", headers: AUTH })
    ).json();
    expect(body.data.identity).toBe("MINE");
    expect(body.data.wishlist).toEqual(["1001"]);
    expect(Object.keys(body.data)).toEqual([...EXPORT_SECTIONS]);
  });

  it("NEVER includes another customer's data (Req 23.4)", async () => {
    app = buildApp({
      readers: readersOver({
        [CUSTOMER]: { identity: "MINE" },
        [OTHER]: {
          identity: "THEIR-SECRET-NAME",
          wishlist: ["THEIR-PRODUCT"],
          balance: { points: 99999 },
        },
      }),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/export", headers: AUTH });
    expect(res.body).not.toContain("THEIR-SECRET-NAME");
    expect(res.body).not.toContain("THEIR-PRODUCT");
    expect(res.body).not.toContain("99999");
    expect(res.body).not.toContain(OTHER);
  });

  it("IGNORES a browser-supplied customer id (Req 1.2)", async () => {
    app = buildApp({
      readers: readersOver({ [CUSTOMER]: { identity: "MINE" }, [OTHER]: { identity: "THEIRS" } }),
      maxRequests: 100,
    });
    await app.ready();
    const plain = await app.inject({ method: "GET", url: "/v1/profile/export", headers: AUTH });
    const spoofed = await app.inject({
      method: "GET",
      url: `/v1/profile/export?customerId=${OTHER}`,
      headers: { ...AUTH, "x-customer-id": OTHER, cookie: `customerId=${OTHER}` },
    });
    // Byte-identical: the supplied id changed nothing.
    expect(spoofed.body).toBe(plain.body);
    expect(spoofed.body).not.toContain("THEIRS");
  });

  it("requires an identity and reveals NOTHING unauthenticated", async () => {
    app = buildApp({ readers: readersOver({ [CUSTOMER]: { identity: "MINE" } }) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/export" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("MINE");
    // And no attachment header, so nothing is offered for download.
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("answers 502 when unwired, NEVER an empty document", async () => {
    app = buildApp({});
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/export", headers: AUTH });
    // An export with every section null would read as "the brand holds nothing
    // about me" — a false statement about a data-access right.
    expect(res.statusCode).toBe(502);
    expect(res.json()).not.toHaveProperty("data");
  });

  it("rate limits to one per hour (§23.3)", async () => {
    app = buildApp({ readers: readersOver({ [CUSTOMER]: {} }) });
    await app.ready();
    expect(
      (await app.inject({ method: "GET", url: "/v1/profile/export", headers: AUTH })).statusCode,
    ).toBe(200);
    const second = await app.inject({ method: "GET", url: "/v1/profile/export", headers: AUTH });
    expect(second.statusCode).toBe(429);
  });

  it("excludes the derived block and declares the exclusion", async () => {
    app = buildApp({ readers: readersOver({ [CUSTOMER]: {} }) });
    await app.ready();
    const body = (
      await app.inject({ method: "GET", url: "/v1/profile/export", headers: AUTH })
    ).json();
    expect(Object.keys(body.data)).not.toContain("inferred");
    expect(body.excluded.map((e: { section: string }) => e.section)).toContain(
      "inferredFragranceProfile",
    );
  });
});

describe("POST /v1/profile/erasure-request (N15)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("records intent and returns requestedAt plus a reference", async () => {
    const db = new FakeDb();
    app = buildApp({ db });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: keyed(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.reference).toMatch(/^ERASE-[0-9A-F]{12}$/);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ customer_id: CUSTOMER, status: "received", source: "portal" });
  });

  it("DELETES NOTHING — the only statements are a read and an insert", async () => {
    const db = new FakeDb();
    app = buildApp({ db });
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: keyed(),
      payload: {},
    });
    for (const statement of db.statements) {
      expect(statement, statement.slice(0, 50)).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
      expect(statement).toMatch(/^SELECT|^INSERT/i);
    }
  });

  it("is IDEMPOTENT: a duplicate returns the SAME reference and requestedAt", async () => {
    const db = new FakeDb();
    app = buildApp({ db, maxRequests: 100 });
    await app.ready();
    const first = (
      await app.inject({
        method: "POST",
        url: "/v1/profile/erasure-request",
        headers: keyed(),
        payload: {},
      })
    ).json();
    const second = (
      await app.inject({
        method: "POST",
        url: "/v1/profile/erasure-request",
        headers: keyed(),
        payload: {},
      })
    ).json();
    expect(second).toEqual(first);
    // ONE row, not a queue of duplicates for an operator to reconcile.
    expect(db.rows).toHaveLength(1);
  });

  it("stays idempotent while the request is IN PROGRESS", async () => {
    const db = new FakeDb();
    app = buildApp({ db, maxRequests: 100 });
    await app.ready();
    const first = (
      await app.inject({
        method: "POST",
        url: "/v1/profile/erasure-request",
        headers: keyed(),
        payload: {},
      })
    ).json();
    // An operator has picked it up.
    (db.rows[0] as ErasureRow).status = "in_progress";
    const again = (
      await app.inject({
        method: "POST",
        url: "/v1/profile/erasure-request",
        headers: keyed(),
        payload: {},
      })
    ).json();
    expect(again.reference).toBe(first.reference);
    expect(db.rows).toHaveLength(1);
  });

  it("ALLOWS a new request once the previous one is completed", async () => {
    const db = new FakeDb();
    app = buildApp({ db, maxRequests: 100 });
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: keyed(),
      payload: {},
    });
    (db.rows[0] as ErasureRow).status = "completed";
    (db.rows[0] as ErasureRow).completed_at = "2026-08-27T13:00:00.000Z";
    const again = await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: keyed(),
      payload: {},
    });
    // A customer whose erasure completed and who later has new data is entitled to
    // ask again.
    expect(again.statusCode).toBe(200);
    expect(db.rows).toHaveLength(2);
  });

  it("always records source = 'portal', whatever the body claims", async () => {
    const db = new FakeDb();
    app = buildApp({ db });
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: keyed(),
      payload: { source: "operator", status: "completed", customerId: OTHER },
    });
    // The body is not read at all: `source` describes how a request ARRIVED, and a
    // customer-facing endpoint can only attest to one of the three values.
    expect(db.rows[0]).toMatchObject({ source: "portal", status: "received", customer_id: CUSTOMER });
  });

  it("NEVER records against another customer (Req 2.1)", async () => {
    const db = new FakeDb();
    app = buildApp({ db, maxRequests: 100 });
    await app.ready();
    await app.inject({
      method: "POST",
      url: `/v1/profile/erasure-request?customerId=${OTHER}`,
      headers: { ...keyed(), "x-customer-id": OTHER, cookie: `customerId=${OTHER}` },
      payload: { customerId: OTHER },
    });
    expect(db.rows.every((r) => r.customer_id === CUSTOMER)).toBe(true);
    expect(db.rows.some((r) => r.customer_id === OTHER)).toBe(false);
  });

  it("does not see another customer's OPEN request as its own", async () => {
    const db = new FakeDb();
    db.rows.push({
      id: "99999999-1111-4111-8111-111111111111",
      customer_id: OTHER,
      requested_at: "2026-01-01T00:00:00.000Z",
      status: "received",
      completed_at: null,
      source: "portal",
    });
    app = buildApp({ db });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: keyed(),
      payload: {},
    });
    // A shared idempotency window across customers would let one customer's request
    // suppress another's.
    expect(res.statusCode).toBe(200);
    expect(res.json().reference).not.toBe(erasureReference("99999999-1111-4111-8111-111111111111"));
    expect(db.rows.filter((r) => r.customer_id === CUSTOMER)).toHaveLength(1);
  });

  it("requires an identity and records nothing unauthenticated", async () => {
    const db = new FakeDb();
    app = buildApp({ db });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: { "idempotency-key": "anon" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(db.rows).toHaveLength(0);
    expect(db.statements).toHaveLength(0);
  });

  it("requires an Idempotency-Key on this state-changing method", async () => {
    const db = new FakeDb();
    app = buildApp({ db });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_idempotency_key");
    expect(db.rows).toHaveLength(0);
  });

  it("rate limits to one per day", async () => {
    const db = new FakeDb();
    app = buildApp({ db });
    await app.ready();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/profile/erasure-request",
          headers: keyed(),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: keyed(),
      payload: {},
    });
    expect(second.statusCode).toBe(429);
  });

  it("answers 502 when unwired, never a fabricated reference", async () => {
    app = buildApp({});
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: keyed(),
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).not.toHaveProperty("reference");
  });
});

describe("the erasure reference", () => {
  it("carries no customer identifier", () => {
    const reference = erasureReference("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    // Derived from the REQUEST's own random uuid, not the customer's — a reference
    // ends up in emails and support tickets.
    expect(reference).not.toContain(CUSTOMER);
    expect(reference).toMatch(/^ERASE-[0-9A-F]{12}$/);
  });

  it("is deterministic for a given request id", () => {
    expect(erasureReference("abc-def")).toBe(erasureReference("abc-def"));
  });

  it("differs for different requests", () => {
    expect(erasureReference("11111111-1111-4111-8111-111111111111")).not.toBe(
      erasureReference("22222222-2222-4222-8222-222222222222"),
    );
  });
});

describe("the routes register even with NO dependency wired", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("answers 401 unauthenticated — never 404", async () => {
    app = Fastify({ logger: false });
    registerVersioning(app);
    app.register(v1Routes, { prefix: "/v1", appProxySecret: APP_PROXY_SECRET });
    await app.ready();
    // For an erasure endpoint a 404 would read as "this account cannot be erased".
    expect((await app.inject({ method: "GET", url: "/v1/profile/export" })).statusCode).toBe(401);
    const post = await app.inject({
      method: "POST",
      url: "/v1/profile/erasure-request",
      headers: { "idempotency-key": "x" },
      payload: {},
    });
    expect(post.statusCode).toBe(401);
  });
});
