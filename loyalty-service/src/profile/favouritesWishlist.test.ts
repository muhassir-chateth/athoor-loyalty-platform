/**
 * Unit tests for favourites & account-level wishlist reconciliation (task 14.2).
 *
 * These verify Requirements 17.2 (favourite set/unset reflected on next read),
 * 17.3 (preferences owned off-ledger — nothing is written to `ledger_entries`),
 * and 17.4 / A14 (device-local wishlist merged as a UNION into the authoritative
 * account-level wishlist).
 *
 * NO live/production system is touched: the flows run against a STATEFUL,
 * IN-MEMORY fake {@link Queryable} that models the `customer_favourites` and
 * `customer_wishlist` tables — including their `(customer_id,
 * shopify_product_id)` primary key and the `ON CONFLICT DO NOTHING` semantics —
 * and records every statement so we can assert the ledger is never touched.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  InvalidPreferenceInputError,
  getWishlist,
  listFavourites,
  reconcileWishlist,
  setFavourite,
} from "./favouritesWishlist.js";

interface Row {
  customer_id: string;
  shopify_product_id: string;
}

/**
 * Models `customer_favourites` and `customer_wishlist`. Each table is a set of
 * rows keyed by (customer_id, shopify_product_id) — inserts collapse on the
 * primary key exactly as `ON CONFLICT DO NOTHING` does in Postgres.
 */
class FakeDb implements Queryable {
  readonly favourites: Row[] = [];
  readonly wishlist: Row[] = [];
  /** The task 9.1 explicit-removal tombstone. */
  readonly removals: Row[] = [];
  /** Every statement issued, for off-ledger assertions. */
  readonly queries: string[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = queryText.trim();
    this.queries.push(q);

    // Guard: this module must never touch the ledger (Req 17.3).
    if (/ledger_entries|point_lots|redemptions/i.test(q)) {
      throw new Error(`FakeDb: unexpected ledger access in preference module: ${q}`);
    }

    if (q.startsWith("INSERT INTO customer_favourites")) {
      return this.insert<R>(this.favourites, values as [string, string]);
    }
    if (q.startsWith("DELETE FROM customer_favourites")) {
      return this.remove<R>(this.favourites, values as [string, string]);
    }
    if (q.startsWith("SELECT shopify_product_id FROM customer_favourites")) {
      return this.select<R>(this.favourites, values[0] as string);
    }
    // ── ORDER MATTERS HERE, AND IT IS A REAL HAZARD ─────────────────────
    // `customer_wishlist_removals` STARTS WITH `customer_wishlist`, so a prefix
    // dispatch that tests the shorter name first silently routes every tombstone
    // statement to the wishlist table — the tombstone SELECT returns wishlist rows,
    // and the sweep then deletes the very products it just merged. These branches
    // are therefore matched BEFORE the wishlist ones. Any other prefix matcher over
    // this SQL has the same trap.
    if (q.startsWith("INSERT INTO customer_wishlist_removals")) {
      return this.insert<R>(this.removals, values as [string, string]);
    }
    if (q.startsWith("DELETE FROM customer_wishlist_removals")) {
      return this.remove<R>(this.removals, values as [string, string]);
    }
    if (q.startsWith("SELECT shopify_product_id FROM customer_wishlist_removals")) {
      return this.select<R>(this.removals, values[0] as string);
    }
    if (q.startsWith("DELETE FROM customer_wishlist")) {
      return this.remove<R>(this.wishlist, values as [string, string]);
    }
    if (q.startsWith("INSERT INTO customer_wishlist")) {
      return this.insert<R>(this.wishlist, values as [string, string]);
    }
    if (q.startsWith("SELECT shopify_product_id FROM customer_wishlist")) {
      return this.select<R>(this.wishlist, values[0] as string);
    }
    throw new Error(`Unexpected query in FakeDb: ${q}`);
  }

  private insert<R extends QueryResultRow>(
    table: Row[],
    [customerId, productId]: [string, string],
  ): QueryResult<R> {
    const exists = table.some(
      (r) => r.customer_id === customerId && r.shopify_product_id === productId,
    );
    if (!exists) {
      table.push({ customer_id: customerId, shopify_product_id: productId });
      return this.result<R>([], 1);
    }
    return this.result<R>([], 0); // ON CONFLICT DO NOTHING
  }

  private remove<R extends QueryResultRow>(
    table: Row[],
    [customerId, productId]: [string, string],
  ): QueryResult<R> {
    const idx = table.findIndex(
      (r) => r.customer_id === customerId && r.shopify_product_id === productId,
    );
    if (idx >= 0) {
      table.splice(idx, 1);
      return this.result<R>([], 1);
    }
    return this.result<R>([], 0);
  }

  private select<R extends QueryResultRow>(table: Row[], customerId: string): QueryResult<R> {
    const rows = table
      .filter((r) => r.customer_id === customerId)
      .map((r) => r.shopify_product_id)
      // ORDER BY shopify_product_id (numeric BIGINT ordering).
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
      .map((id) => ({ shopify_product_id: id }) as unknown as R);
    return this.result<R>(rows);
  }

  private result<R extends QueryResultRow>(rows: R[], rowCount = rows.length): QueryResult<R> {
    return { rows, rowCount, command: "", oid: 0, fields: [] } as QueryResult<R>;
  }
}

const CUSTOMER = "cust-0001";

describe("setFavourite / listFavourites (Req 17.2, 17.3)", () => {
  it("persists a favourite so it is reflected on the next read", async () => {
    const db = new FakeDb();

    await setFavourite(db, CUSTOMER, "1001", true);

    expect(await listFavourites(db, CUSTOMER)).toEqual(["1001"]);
  });

  it("unsets a favourite so it no longer appears on the next read", async () => {
    const db = new FakeDb();
    await setFavourite(db, CUSTOMER, "1001", true);
    await setFavourite(db, CUSTOMER, "1002", true);

    await setFavourite(db, CUSTOMER, "1001", false);

    expect(await listFavourites(db, CUSTOMER)).toEqual(["1002"]);
  });

  it("is idempotent: favouriting the same product twice stores a single entry", async () => {
    const db = new FakeDb();

    await setFavourite(db, CUSTOMER, "1001", true);
    await setFavourite(db, CUSTOMER, "1001", true);

    expect(await listFavourites(db, CUSTOMER)).toEqual(["1001"]);
  });

  it("unsetting a product that is not favourited is a harmless no-op", async () => {
    const db = new FakeDb();

    await expect(setFavourite(db, CUSTOMER, "9999", false)).resolves.toBeUndefined();
    expect(await listFavourites(db, CUSTOMER)).toEqual([]);
  });

  it("scopes favourites to the requesting customer only", async () => {
    const db = new FakeDb();
    await setFavourite(db, CUSTOMER, "1001", true);
    await setFavourite(db, "other-customer", "2002", true);

    expect(await listFavourites(db, CUSTOMER)).toEqual(["1001"]);
    expect(await listFavourites(db, "other-customer")).toEqual(["2002"]);
  });

  it("returns favourites ordered by product id", async () => {
    const db = new FakeDb();
    await setFavourite(db, CUSTOMER, "300", true);
    await setFavourite(db, CUSTOMER, "100", true);
    await setFavourite(db, CUSTOMER, "200", true);

    expect(await listFavourites(db, CUSTOMER)).toEqual(["100", "200", "300"]);
  });

  it("rejects invalid product ids without writing anything", async () => {
    const db = new FakeDb();

    await expect(setFavourite(db, CUSTOMER, "not-a-number", true)).rejects.toBeInstanceOf(
      InvalidPreferenceInputError,
    );
    await expect(setFavourite(db, CUSTOMER, "0", true)).rejects.toBeInstanceOf(
      InvalidPreferenceInputError,
    );
    expect(db.favourites).toHaveLength(0);
  });

  it("rejects an empty customer id", async () => {
    const db = new FakeDb();
    await expect(setFavourite(db, "", "1001", true)).rejects.toBeInstanceOf(
      InvalidPreferenceInputError,
    );
  });
});

describe("getWishlist / reconcileWishlist union (Req 17.4, A14)", () => {
  it("returns an empty account-level wishlist before any reconciliation", async () => {
    const db = new FakeDb();
    expect(await getWishlist(db, CUSTOMER)).toEqual([]);
  });

  it("merges the device-local wishlist into an empty account wishlist", async () => {
    const db = new FakeDb();

    const merged = await reconcileWishlist(db, CUSTOMER, ["10", "20", "30"]);

    expect(merged).toEqual(["10", "20", "30"]);
    expect(await getWishlist(db, CUSTOMER)).toEqual(["10", "20", "30"]);
  });

  it("merges as a UNION, retaining pre-existing account entries and adding new ones without duplicates", async () => {
    const db = new FakeDb();
    // Pre-existing account-level wishlist.
    await reconcileWishlist(db, CUSTOMER, ["10", "20"]);

    // Device-local entries overlap (20) and introduce new ones (30, 40).
    const merged = await reconcileWishlist(db, CUSTOMER, ["20", "30", "40"]);

    expect(merged).toEqual(["10", "20", "30", "40"]);
    // No duplicate rows for the overlapping id.
    expect(db.wishlist.filter((r) => r.shopify_product_id === "20")).toHaveLength(1);
  });

  it("collapses duplicate/repeated device-local ids to a single entry", async () => {
    const db = new FakeDb();

    const merged = await reconcileWishlist(db, CUSTOMER, ["7", "7", "007", "7"]);

    expect(merged).toEqual(["7"]);
    expect(db.wishlist).toHaveLength(1);
  });

  it("treats an empty device-local list as a no-op, leaving the account wishlist authoritative", async () => {
    const db = new FakeDb();
    await reconcileWishlist(db, CUSTOMER, ["10", "20"]);

    const merged = await reconcileWishlist(db, CUSTOMER, []);

    expect(merged).toEqual(["10", "20"]);
  });

  it("keeps the account-level wishlist authoritative and scoped per customer", async () => {
    const db = new FakeDb();
    await reconcileWishlist(db, CUSTOMER, ["10", "20"]);
    await reconcileWishlist(db, "other-customer", ["99"]);

    expect(await getWishlist(db, CUSTOMER)).toEqual(["10", "20"]);
    expect(await getWishlist(db, "other-customer")).toEqual(["99"]);
  });

  it("rejects an invalid device-local id and writes nothing", async () => {
    const db = new FakeDb();

    await expect(reconcileWishlist(db, CUSTOMER, ["10", "bad"])).rejects.toBeInstanceOf(
      InvalidPreferenceInputError,
    );
    expect(db.wishlist).toHaveLength(0);
  });

  it("rejects a non-array device-local input", async () => {
    const db = new FakeDb();
    await expect(
      reconcileWishlist(db, CUSTOMER, "10" as unknown as string[]),
    ).rejects.toBeInstanceOf(InvalidPreferenceInputError);
  });
});

describe("off-ledger isolation (Req 17.3)", () => {
  it("never issues a statement against any ledger/balance table", async () => {
    const db = new FakeDb();

    await setFavourite(db, CUSTOMER, "1001", true);
    await setFavourite(db, CUSTOMER, "1001", false);
    await listFavourites(db, CUSTOMER);
    await reconcileWishlist(db, CUSTOMER, ["10", "20"]);
    await getWishlist(db, CUSTOMER);

    expect(db.queries.length).toBeGreaterThan(0);
    for (const q of db.queries) {
      expect(q).not.toMatch(/ledger_entries|point_lots|redemptions/i);
      expect(q).toMatch(/customer_favourites|customer_wishlist/);
    }
  });
});
