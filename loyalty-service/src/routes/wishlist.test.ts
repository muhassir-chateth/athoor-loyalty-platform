/**
 * Tests for `PUT /v1/profile/wishlist/:productId` (N5) and the explicit-removal
 * tombstone — spec task 9.1/9.3, design §6.3 N5, §8.4, Req 7.1/7.3/7.6/7.9/7.10.
 *
 * THE CENTRAL SCENARIO, and the reason this task exists: a product removed through
 * the portal must NOT come back when a device whose `localStorage` still names it
 * reconciles. `localStorage` is never cleared (§8.4 rule 3, the owner's decision of
 * record), so the tombstone — not a storage change — is what has to hold.
 *
 * SAFETY: no network, no production. Postgres is a fake that enforces the same
 * primary keys and predicates the real schema does.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import type { Queryable } from "../ledger/repository.js";
import type { CustomerScope } from "../auth/customerScope.js";
import {
  getWishlist,
  listWishlistRemovals,
  reconcileWishlist,
} from "../profile/favouritesWishlist.js";
import { setWishlistItem } from "../portal/repository/customerOwned.js";
import { PORTAL_WISHLIST_MAX_ITEMS } from "../portal/types.js";
import {
  PgWishlistWriteStore,
  UnconfiguredWishlistWriteStore,
  WISHLIST_RATE_LIMIT_MAX_REQUESTS,
  parseWishlistBody,
} from "./wishlist.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";
const BEARER_TOKEN = "valid-caa-token";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };
const SCOPE_A = { customerId: CUSTOMER_A } as unknown as CustomerScope;
const SCOPE_B = { customerId: CUSTOMER_B } as unknown as CustomerScope;

let keyCounter = 0;
function keyed(): Record<string, string> {
  keyCounter += 1;
  return { ...AUTH, "idempotency-key": `wishlist-${keyCounter}-${Date.now()}` };
}

/**
 * A Postgres stand-in for `customer_wishlist` and `customer_wishlist_removals`.
 *
 * Dispatches on the LONGEST table name first. `customer_wishlist_removals` starts
 * with `customer_wishlist`, and a prefix matcher that tests the shorter name first
 * routes every tombstone statement to the wishlist table — which is exactly the
 * defect that caught two other test doubles during task 9.1. Unknown tables throw
 * rather than defaulting, so a new statement cannot silently corrupt another
 * table's assertions.
 */
class FakeWishlistDb implements Queryable {
  readonly wishlist = new Set<string>();
  readonly removals = new Set<string>();
  readonly statements: string[] = [];

  seedWishlist(customerId: string, ids: readonly string[]): void {
    for (const id of ids) this.wishlist.add(`${customerId}|${id}`);
  }

  rows(store: Set<string>, customerId: string): string[] {
    return [...store]
      .filter((k) => k.startsWith(`${customerId}|`))
      .map((k) => k.slice(customerId.length + 1))
      .sort((a, b) => Number(a) - Number(b));
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = sql.trim();
    this.statements.push(q);
    if (/ledger_entries|point_lots|redemptions/i.test(q)) {
      throw new Error(`FakeWishlistDb: wishlist path must never touch the ledger: ${q}`);
    }
    const store = /\bcustomer_wishlist_removals\b/.test(q)
      ? this.removals
      : /\bcustomer_wishlist\b/.test(q)
        ? this.wishlist
        : (() => {
            throw new Error(`FakeWishlistDb: unknown table in ${q}`);
          })();

    const customerId = String(values[0] ?? "");
    const productId = values[1] === undefined ? null : String(values[1]);
    const key = `${customerId}|${productId}`;

    if (q.startsWith("INSERT")) {
      const existed = store.has(key);
      store.add(key);
      return this.result<R>([], existed ? 0 : 1);
    }
    if (q.startsWith("DELETE")) {
      const existed = store.has(key);
      store.delete(key);
      return this.result<R>([], existed ? 1 : 0);
    }
    if (/^SELECT count/i.test(q)) {
      const n = this.rows(store, customerId).length;
      return this.result<R>([{ item_count: String(n) } as unknown as R], 1);
    }
    const rows = this.rows(store, customerId).map(
      (id) => ({ shopify_product_id: id }) as unknown as R,
    );
    return this.result<R>(rows, rows.length);
  }

  private result<R extends QueryResultRow>(rows: R[], rowCount: number): QueryResult<R> {
    return { rows, rowCount, command: "SELECT", oid: 0, fields: [] };
  }
}

/* ========================================================================== *
 * 1 — the body parser
 * ========================================================================== */

describe("parseWishlistBody", () => {
  it("accepts a strict boolean", () => {
    expect(parseWishlistBody({ on: true })).toEqual({ ok: true, on: true });
    expect(parseWishlistBody({ on: false })).toEqual({ ok: true, on: false });
  });

  it('REFUSES "false", 0 and null rather than coercing them', () => {
    // `on: "false"` is a truthy string. Coercion here would ADD the product the
    // customer asked to remove — the worst available outcome for this endpoint.
    for (const body of [{ on: "false" }, { on: "true" }, { on: 0 }, { on: 1 }, { on: null }, {}]) {
      expect(parseWishlistBody(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("refuses a non-object body", () => {
    for (const body of [null, undefined, "on", 5, [true]]) {
      expect(parseWishlistBody(body).ok).toBe(false);
    }
  });
});

/* ========================================================================== *
 * 2 — the tombstone at the repository layer
 * ========================================================================== */

describe("the explicit-removal tombstone (§8.4 rule 3)", () => {
  it("records a removal and deletes the row", async () => {
    const db = new FakeWishlistDb();
    db.seedWishlist(CUSTOMER_A, ["1001"]);
    await setWishlistItem(db, SCOPE_A, "1001", false);
    expect(await getWishlist(db, CUSTOMER_A)).toEqual([]);
    expect(await listWishlistRemovals(db, CUSTOMER_A)).toEqual(["1001"]);
  });

  it("STALE localStorage DOES NOT RESURRECT a removed item — the whole point", async () => {
    const db = new FakeWishlistDb();
    db.seedWishlist(CUSTOMER_A, ["1001", "1002"]);

    // The customer removes 1001 in the portal.
    await setWishlistItem(db, SCOPE_A, "1001", false);

    // The device list still names it, because localStorage is NEVER cleared.
    const deviceLocal = ["1001", "1002", "1003"];
    const merged = await reconcileWishlist(db, CUSTOMER_A, deviceLocal);

    // 1001 stays gone; the legitimate device-local addition 1003 still arrives.
    expect(merged).toEqual(["1002", "1003"]);
    expect(merged).not.toContain("1001");
  });

  it("does not resurrect across REPEATED reconciliations (once per page load)", async () => {
    const db = new FakeWishlistDb();
    db.seedWishlist(CUSTOMER_A, ["1001"]);
    await setWishlistItem(db, SCOPE_A, "1001", false);
    for (let i = 0; i < 5; i += 1) {
      const merged = await reconcileWishlist(db, CUSTOMER_A, ["1001"]);
      expect(merged, `reconcile ${i + 1}`).toEqual([]);
    }
  });

  it("still imports LEGITIMATE device-local additions", async () => {
    const db = new FakeWishlistDb();
    const merged = await reconcileWishlist(db, CUSTOMER_A, ["2001", "2002"]);
    expect(merged).toEqual(["2001", "2002"]);
    expect(await listWishlistRemovals(db, CUSTOMER_A)).toEqual([]);
  });

  it("an explicit ADD supersedes an earlier removal, so a removal is not permanent", async () => {
    const db = new FakeWishlistDb();
    db.seedWishlist(CUSTOMER_A, ["1001"]);
    await setWishlistItem(db, SCOPE_A, "1001", false);
    expect(await listWishlistRemovals(db, CUSTOMER_A)).toEqual(["1001"]);

    await setWishlistItem(db, SCOPE_A, "1001", true);
    expect(await listWishlistRemovals(db, CUSTOMER_A)).toEqual([]);
    expect(await getWishlist(db, CUSTOMER_A)).toEqual(["1001"]);

    // And it now survives a reconcile rather than being suppressed.
    expect(await reconcileWishlist(db, CUSTOMER_A, ["1001"])).toEqual(["1001"]);
  });

  it("is IDEMPOTENT: repeated removals leave one tombstone and one outcome", async () => {
    const db = new FakeWishlistDb();
    db.seedWishlist(CUSTOMER_A, ["1001"]);
    for (let i = 0; i < 4; i += 1) {
      await setWishlistItem(db, SCOPE_A, "1001", false);
    }
    expect(await listWishlistRemovals(db, CUSTOMER_A)).toEqual(["1001"]);
    expect(await getWishlist(db, CUSTOMER_A)).toEqual([]);
  });

  it("is idempotent under CONCURRENT duplicate reconciliations", async () => {
    const db = new FakeWishlistDb();
    await Promise.all([
      reconcileWishlist(db, CUSTOMER_A, ["3001", "3002"]),
      reconcileWishlist(db, CUSTOMER_A, ["3002", "3003"]),
      reconcileWishlist(db, CUSTOMER_A, ["3001", "3003"]),
    ]);
    // One set, no duplicates — the primary key does the work.
    expect(await getWishlist(db, CUSTOMER_A)).toEqual(["3001", "3002", "3003"]);
  });

  it("isolates tombstones per customer — A's removal never suppresses B's product", async () => {
    const db = new FakeWishlistDb();
    await setWishlistItem(db, SCOPE_A, "1001", false);
    const bMerged = await reconcileWishlist(db, CUSTOMER_B, ["1001"]);
    // B never removed it, so B gets it.
    expect(bMerged).toEqual(["1001"]);
    expect(await listWishlistRemovals(db, CUSTOMER_B)).toEqual([]);
  });

  it("cannot delete another customer's row (design §4.5 row 8)", async () => {
    const db = new FakeWishlistDb();
    db.seedWishlist(CUSTOMER_B, ["2001"]);
    const changed = await setWishlistItem(db, SCOPE_A, "2001", false);
    expect(changed).toBe(false);
    expect(await getWishlist(db, CUSTOMER_B)).toEqual(["2001"]);
  });

  it("normalises leading zeros identically on both paths", async () => {
    const db = new FakeWishlistDb();
    await setWishlistItem(db, SCOPE_A, "0001", true);
    expect(await getWishlist(db, CUSTOMER_A)).toEqual(["1"]);
    await setWishlistItem(db, SCOPE_A, "1", false);
    // The removal of "1" must suppress a device-local "0001".
    expect(await reconcileWishlist(db, CUSTOMER_A, ["0001"])).toEqual([]);
  });

  it("refuses a malformed product id before any statement runs", async () => {
    const db = new FakeWishlistDb();
    for (const bad of ["abc", "", "-1", "0", "1.5", "1; DROP TABLE customer_wishlist"]) {
      await expect(setWishlistItem(db, SCOPE_A, bad, false), bad).rejects.toThrow();
    }
    expect(db.statements).toHaveLength(0);
  });

  it("never touches the ledger", async () => {
    const db = new FakeWishlistDb();
    await setWishlistItem(db, SCOPE_A, "1001", true);
    await setWishlistItem(db, SCOPE_A, "1001", false);
    await reconcileWishlist(db, CUSTOMER_A, ["1002"]);
    for (const s of db.statements) {
      expect(s).not.toMatch(/ledger_entries|point_lots|redemptions/i);
    }
  });

  it("RECONCILE NEVER DELETES — the add-only invariant (Req 17.4, A14)", async () => {
    // Asserted here as well as in profileWrites.test.ts because task 9.1 was the
    // change most likely to break it: an earlier draft closed a race with a
    // post-merge sweep that deleted tombstoned rows, which would have made every
    // reconcile a deletion path. Removal authority stays on N5 alone (§8.4 rule 5).
    const db = new FakeWishlistDb();
    db.seedWishlist(CUSTOMER_A, ["1001"]);
    db.statements.length = 0;
    await reconcileWishlist(db, CUSTOMER_A, ["1002"]);
    expect(db.statements.filter((s) => s.startsWith("DELETE"))).toEqual([]);
  });
});

/* ========================================================================== *
 * 3 — the route
 * ========================================================================== */

function buildWishlistApp(db?: Queryable): { app: FastifyInstance; db: FakeWishlistDb } {
  const fake = (db as FakeWishlistDb) ?? new FakeWishlistDb();
  const app = Fastify({ logger: false });
  registerVersioning(app);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER_A }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    wishlistStore: new PgWishlistWriteStore(fake),
  });
  return { app, db: fake };
}

describe("PUT /v1/profile/wishlist/:productId (N5)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("adds a product and echoes the resulting set (§6.3 N5)", async () => {
    const built = buildWishlistApp();
    app = built.app;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/1001",
      headers: keyed(),
      payload: { on: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ productId: "1001", on: true, wishlist: ["1001"] });
  });

  it("removes a product, echoes the set, and records the tombstone (Req 7.3)", async () => {
    const built = buildWishlistApp();
    built.db.seedWishlist(CUSTOMER_A, ["1001", "1002"]);
    app = built.app;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/1001",
      headers: keyed(),
      payload: { on: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ productId: "1001", on: false, wishlist: ["1002"] });
    expect(await listWishlistRemovals(built.db, CUSTOMER_A)).toEqual(["1001"]);
  });

  it("requires an Idempotency-Key on this state-changing method (Req 9.7)", async () => {
    const built = buildWishlistApp();
    app = built.app;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/1001",
      headers: AUTH,
      payload: { on: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_idempotency_key");
  });

  it("answers 409 wishlist_limit_reached at the cap (§6.3 N5)", async () => {
    const built = buildWishlistApp();
    const full = Array.from({ length: PORTAL_WISHLIST_MAX_ITEMS }, (_v, i) => String(10_000 + i));
    built.db.seedWishlist(CUSTOMER_A, full);
    app = built.app;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/99999",
      headers: keyed(),
      payload: { on: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("wishlist_limit_reached");
    // The refusal changed nothing.
    expect(built.db.rows(built.db.wishlist, CUSTOMER_A)).toHaveLength(PORTAL_WISHLIST_MAX_ITEMS);
  });

  it("permits the 500th add and refuses the 501st", async () => {
    const built = buildWishlistApp();
    const nearlyFull = Array.from({ length: PORTAL_WISHLIST_MAX_ITEMS - 1 }, (_v, i) =>
      String(10_000 + i),
    );
    built.db.seedWishlist(CUSTOMER_A, nearlyFull);
    app = built.app;
    await app.ready();
    const five_hundredth = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/77777",
      headers: keyed(),
      payload: { on: true },
    });
    expect(five_hundredth.statusCode).toBe(200);
    const beyond = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/88888",
      headers: keyed(),
      payload: { on: true },
    });
    expect(beyond.statusCode).toBe(409);
  });

  it("NEVER caps a removal — that would trap a customer at their limit", async () => {
    const built = buildWishlistApp();
    const full = Array.from({ length: PORTAL_WISHLIST_MAX_ITEMS }, (_v, i) => String(10_000 + i));
    built.db.seedWishlist(CUSTOMER_A, full);
    app = built.app;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/10000",
      headers: keyed(),
      payload: { on: false },
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not cap a REPEAT add of a product already saved", async () => {
    const built = buildWishlistApp();
    const full = Array.from({ length: PORTAL_WISHLIST_MAX_ITEMS }, (_v, i) => String(10_000 + i));
    built.db.seedWishlist(CUSTOMER_A, full);
    app = built.app;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/10000",
      headers: keyed(),
      payload: { on: true },
    });
    // Already saved, so this changes nothing and must not fail at the boundary.
    expect(res.statusCode).toBe(200);
  });

  it("answers 400 for a malformed body or product id", async () => {
    const built = buildWishlistApp();
    app = built.app;
    await app.ready();
    const badBody = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/1001",
      headers: keyed(),
      payload: { on: "false" },
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error).toBe("invalid_request");

    for (const id of ["abc", "-1", "0", "1.5"]) {
      const res = await app.inject({
        method: "PUT",
        url: `/v1/profile/wishlist/${id}`,
        headers: keyed(),
        payload: { on: true },
      });
      expect(res.statusCode, id).toBe(400);
    }
  });

  it("never echoes a malformed product id back into the body", async () => {
    const built = buildWishlistApp();
    app = built.app;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/%3Cscript%3E",
      headers: keyed(),
      payload: { on: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("script");
  });

  it("requires an identity — 401 before any 400 about the id", async () => {
    const built = buildWishlistApp();
    app = built.app;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/abc",
      payload: { on: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it(`rate limits after ${WISHLIST_RATE_LIMIT_MAX_REQUESTS} writes in the window`, async () => {
    const built = buildWishlistApp();
    app = built.app;
    await app.ready();
    for (let i = 0; i < WISHLIST_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const ok = await app.inject({
        method: "PUT",
        url: `/v1/profile/wishlist/${20_000 + i}`,
        headers: keyed(),
        payload: { on: true },
      });
      expect(ok.statusCode, `write ${i + 1}`).toBe(200);
    }
    const limited = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/30000",
      headers: keyed(),
      payload: { on: true },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("rate_limit_exceeded");
    expect(limited.json().message).toContain("wishlist");
  });

  it("registers even with no store wired, and REFUSES rather than answering 404", async () => {
    // An absent route answers 404, which a client reads as "not on your wishlist" —
    // the precise falsehood this endpoint exists to prevent.
    const bare = Fastify({ logger: false });
    registerVersioning(bare);
    bare.register(v1Routes, {
      prefix: "/v1",
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER_A }),
      tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
      appProxySecret: APP_PROXY_SECRET,
      wishlistStore: new UnconfiguredWishlistWriteStore(),
    });
    app = bare;
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/1001",
      headers: keyed(),
      payload: { on: true },
    });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });
});
