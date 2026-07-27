/**
 * Profile preference WRITES (task 31) — Req 17.2/17.4/17.5/17.3, Property 13.
 *
 * WHY THESE RUN THE REAL IMPLEMENTATIONS: reachability-audit finding 3 was that
 * `setFavourite`, `reconcileWishlist` and `RecentlyViewedStore` were complete,
 * unit-tested, and referenced by nothing. Stubbing them here would reproduce
 * exactly that blind spot. So these tests drive the REAL
 * `PgProfilePreferenceStore` and the REAL `RecentlyViewedStore` through the REAL
 * registered routes, over an in-memory Postgres that answers their own SQL — the
 * guards, the `ON CONFLICT DO NOTHING` idempotence, the union semantics and the
 * view sampling are all the shipped ones.
 *
 * Coverage:
 *   - favourite set, unset, and re-set (idempotent, Req 17.2);
 *   - a set is reflected in the very next read;
 *   - malformed product ids refused with no write;
 *   - wishlist union: existing account entries RETAINED, duplicates collapsed,
 *     `"007"` and `"7"` treated as the same product (A14, Req 17.4);
 *   - reconciliation with an empty device list changes nothing;
 *   - recently-viewed accepted, and a repeat view inside the sampling interval
 *     performs NO second write (Req 17.5);
 *   - Property 13: no route here ever writes `ledger_entries`;
 *   - the routes are absent when the stores are not wired (additive).
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import type { Queryable } from "../ledger/repository.js";
import { registerProfileRoutes, PgProfilePreferenceStore } from "./profile.js";
import { RecentlyViewedStore } from "../profile/recentlyViewed.js";

const CUSTOMER = "cust-uuid";

/** Models the three preference tables and nothing else. */
class FakeDb implements Queryable {
  readonly favourites = new Set<string>();
  readonly wishlist = new Set<string>();
  readonly views = new Map<string, Date>();
  /** Any entry here is a Property 13 violation. */
  readonly ledgerWrites: string[] = [];
  readonly statements: string[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push(text.trim().split("\n")[0]!.trim());
    const ok = (rows: QueryResultRow[], command = "SELECT", rowCount?: number): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rowCount ?? rows.length,
      command,
      oid: 0,
      fields: [],
    });

    if (text.includes("ledger_entries")) {
      this.ledgerWrites.push(text);
      return ok([]);
    }
    if (text.includes("INSERT INTO customer_favourites")) {
      this.favourites.add(String(values[1]));
      return ok([], "INSERT", 1);
    }
    if (text.includes("DELETE FROM customer_favourites")) {
      const had = this.favourites.delete(String(values[1]));
      return ok([], "DELETE", had ? 1 : 0);
    }
    if (text.includes("FROM customer_favourites")) {
      return ok([...this.favourites].sort().map((id) => ({ shopify_product_id: id })));
    }
    if (text.includes("INSERT INTO customer_wishlist")) {
      this.wishlist.add(String(values[1]));
      return ok([], "INSERT", 1);
    }
    if (text.includes("FROM customer_wishlist")) {
      return ok([...this.wishlist].sort().map((id) => ({ shopify_product_id: id })));
    }
    if (text.includes("INSERT INTO customer_recently_viewed")) {
      this.views.set(String(values[1]), values[2] as Date);
      return ok([], "INSERT", 1);
    }
    if (text.includes("FROM customer_recently_viewed")) {
      return ok(
        [...this.views.entries()].map(([productId, viewedAt]) => ({
          product_id: productId,
          viewed_at: viewedAt,
        })),
      );
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

interface Harness {
  app: FastifyInstance;
  db: FakeDb;
  /** Advances the clock the recently-viewed store sees. */
  advance(ms: number): void;
}

async function harness(withStores = true): Promise<Harness> {
  const db = new FakeDb();
  let nowMs = Date.parse("2026-07-27T00:00:00Z");
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    req.authCtx = { customerId: CUSTOMER, source: "app_proxy", channel: "web" };
  });
  registerProfileRoutes(app, {
    ...(withStores
      ? {
          preferenceStore: new PgProfilePreferenceStore(db),
          recentlyViewedRecorder: new RecentlyViewedStore(db, { now: () => new Date(nowMs) }),
        }
      : {}),
  });
  await app.ready();
  return { app, db, advance: (ms) => (nowMs += ms) };
}

const put = (app: FastifyInstance, id: string, on: boolean) =>
  app.inject({ method: "PUT", url: `/profile/favourites/${id}`, payload: { on } });

describe("PUT /v1/profile/favourites/:id (Req 17.2)", () => {
  it("marks a favourite and reflects it in the very next read", async () => {
    const { app, db } = await harness();

    const res = await put(app, "111", true);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ productId: "111", on: true, favourites: ["111"] });
    expect(await (await app.inject({ method: "GET", url: "/profile/favourites" })).json()).toEqual({
      favourites: ["111"],
    });
    expect(db.favourites.has("111")).toBe(true);
    await app.close();
  });

  it("is idempotent: setting twice leaves exactly one favourite", async () => {
    const { app, db } = await harness();

    await put(app, "111", true);
    const second = await put(app, "111", true);

    expect(second.json().favourites).toEqual(["111"]);
    expect(db.favourites.size).toBe(1);
    await app.close();
  });

  it("unsets a favourite, and unsetting one that is not set is a no-op", async () => {
    const { app, db } = await harness();
    await put(app, "111", true);

    expect((await put(app, "111", false)).json().favourites).toEqual([]);
    expect((await put(app, "222", false)).json().favourites).toEqual([]);
    expect(db.favourites.size).toBe(0);
    await app.close();
  });

  it("refuses a malformed product id with no write (the module's own guard)", async () => {
    const { app, db } = await harness();

    for (const id of ["abc", "0", "1.5", "-3"]) {
      const res = await put(app, id, true);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("profile_invalid_input");
    }
    expect(db.favourites.size).toBe(0);
    await app.close();
  });

  it("refuses a body that is not { on: boolean }", async () => {
    const { app, db } = await harness();

    const res = await app.inject({
      method: "PUT",
      url: "/profile/favourites/111",
      payload: { on: "yes" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(db.favourites.size).toBe(0);
    await app.close();
  });
});

describe("POST /v1/profile/wishlist/reconcile — union on authentication (Req 17.4, A14)", () => {
  it("merges the device-local list into the account wishlist and RETAINS existing entries", async () => {
    const { app, db } = await harness();
    db.wishlist.add("100"); // pre-existing account-level entry

    const res = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: ["200", "300"] },
    });

    expect(res.statusCode).toBe(200);
    // Union, not replace: the account entry survives.
    expect(res.json().wishlist).toEqual(["100", "200", "300"]);
    await app.close();
  });

  it("collapses duplicates and equivalent ids (`007` === `7`) to one entry", async () => {
    const { app } = await harness();

    const res = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: ["7", "007", "7", "0007"] },
    });

    expect(res.json().wishlist).toEqual(["7"]);
    await app.close();
  });

  it("changes nothing for an empty device-local list, and is idempotent on repeat", async () => {
    const { app, db } = await harness();
    db.wishlist.add("100");

    const empty = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: [] },
    });
    expect(empty.json().wishlist).toEqual(["100"]);

    await app.inject({ method: "POST", url: "/profile/wishlist/reconcile", payload: { deviceLocal: ["200"] } });
    const again = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: ["200"] },
    });
    expect(again.json().wishlist).toEqual(["100", "200"]);
    await app.close();
  });

  it("never DELETES from the wishlist — reconciliation only adds", async () => {
    const { app, db } = await harness();
    db.wishlist.add("100");

    await app.inject({ method: "POST", url: "/profile/wishlist/reconcile", payload: { deviceLocal: ["200"] } });

    expect(db.statements.some((s) => s.startsWith("DELETE") && s.includes("wishlist"))).toBe(false);
    await app.close();
  });

  it("refuses a malformed device-local id with a 400", async () => {
    const { app, db } = await harness();

    const res = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: ["200", "athoor-oud"] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("profile_invalid_input");
    // The valid id before the invalid one may or may not have been written; what
    // matters is that the caller is told, rather than silently losing an entry.
    expect(db.wishlist.has("athoor-oud")).toBe(false);
    await app.close();
  });

  it("refuses a body that is not { deviceLocal: string[] }", async () => {
    const { app } = await harness();

    const res = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: "200" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    await app.close();
  });
});

describe("POST /v1/profile/recently-viewed (Req 17.5)", () => {
  it("accepts a view and writes it", async () => {
    const { app, db } = await harness();

    const res = await app.inject({
      method: "POST",
      url: "/profile/recently-viewed",
      payload: { productId: "555" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true });
    expect(db.views.has("555")).toBe(true);
    await app.close();
  });

  it("SAMPLES OUT a repeat view of the same product inside the interval (no second write)", async () => {
    const { app, db } = await harness();

    await app.inject({ method: "POST", url: "/profile/recently-viewed", payload: { productId: "555" } });
    const writesAfterFirst = db.statements.filter((s) =>
      s.includes("INSERT INTO customer_recently_viewed"),
    ).length;
    const second = await app.inject({
      method: "POST",
      url: "/profile/recently-viewed",
      payload: { productId: "555" },
    });

    // Still accepted from the caller's point of view, but no write happened.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: true });
    expect(
      db.statements.filter((s) => s.includes("INSERT INTO customer_recently_viewed")).length,
    ).toBe(writesAfterFirst);
    await app.close();
  });

  it("writes again once the sampling interval has elapsed", async () => {
    const { app, db, advance } = await harness();

    await app.inject({ method: "POST", url: "/profile/recently-viewed", payload: { productId: "555" } });
    advance(61_000);
    await app.inject({ method: "POST", url: "/profile/recently-viewed", payload: { productId: "555" } });

    expect(
      db.statements.filter((s) => s.includes("INSERT INTO customer_recently_viewed")).length,
    ).toBe(2);
    await app.close();
  });

  it("refuses a malformed product id with no write", async () => {
    const { app, db } = await harness();

    const res = await app.inject({
      method: "POST",
      url: "/profile/recently-viewed",
      payload: { productId: "not-an-id" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("recently_viewed_invalid_input");
    expect(db.views.size).toBe(0);
    await app.close();
  });
});

describe("off-ledger guarantee and additivity", () => {
  it("Property 13: no preference write ever touches ledger_entries", async () => {
    const { app, db } = await harness();

    await put(app, "111", true);
    await put(app, "111", false);
    await app.inject({ method: "POST", url: "/profile/wishlist/reconcile", payload: { deviceLocal: ["222"] } });
    await app.inject({ method: "POST", url: "/profile/recently-viewed", payload: { productId: "333" } });

    expect(db.ledgerWrites).toEqual([]);
    // Every statement issued targeted a preference table only.
    for (const statement of db.statements) {
      expect(statement).not.toMatch(/ledger_entries|point_lots/);
    }
    await app.close();
  });

  it("registers none of the write routes when the stores are not wired", async () => {
    const { app } = await harness(false);

    for (const [method, url] of [
      ["PUT", "/profile/favourites/111"],
      ["GET", "/profile/favourites"],
      ["GET", "/profile/wishlist"],
      ["POST", "/profile/wishlist/reconcile"],
      ["POST", "/profile/recently-viewed"],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(404);
    }
    // The pre-existing read routes are unaffected.
    expect((await app.inject({ method: "GET", url: "/profile" })).statusCode).toBe(200);
    await app.close();
  });
});
