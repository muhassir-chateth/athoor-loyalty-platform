/**
 * Tests for the portal's customer-owned repository (spec task 5.4).
 *
 * ── WHY THE FAKE INTERPRETS PREDICATES INSTEAD OF PATTERN-MATCHING STATEMENTS ─
 * The obvious fake keys on the SQL text and returns a canned answer. That fake
 * cannot fail an isolation test: it would return "customer A's rows" for a
 * statement that filtered on nothing at all, because the *test* decided which
 * rows to hand back. Every assertion below would pass against SQL missing its
 * `WHERE customer_id = $1`, which is the one defect they exist to catch.
 *
 * So {@link FakeTables} reads the predicates out of the statement and applies
 * them to a shared two-customer table, using the values actually bound. Drop the
 * ownership predicate and B's rows appear in A's read — here, in a test, rather
 * than in production.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 2.6
 */
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { requireCustomerScope, type CustomerScope } from "../../auth/customerScope.js";
import type { Queryable } from "../../ledger/repository.js";
import { InvalidPreferenceInputError } from "../../profile/favouritesWishlist.js";
import {
  countWishlistItems,
  readFavourites,
  readWishlist,
  setFavourite,
  setWishlistItem,
} from "./customerOwned.js";
import { PortalRepositoryFaultError, PortalResourceNotFoundError } from "./scopedQuery.js";

const CUSTOMER_A = "1f0c7c4e-0000-4000-8000-00000000000a";
const CUSTOMER_B = "1f0c7c4e-0000-4000-8000-00000000000b";

function scopeFor(customerId: string): CustomerScope {
  return requireCustomerScope({
    authCtx: { customerId, channel: "web", source: "app_proxy" },
  } as unknown as FastifyRequest);
}

const SCOPE_A = scopeFor(CUSTOMER_A);
const SCOPE_B = scopeFor(CUSTOMER_B);

type TableName = "customer_wishlist" | "customer_favourites";

/**
 * A two-table store that honours the predicates a statement actually writes.
 *
 * Rows are `${customerId}|${productId}`, matching the real
 * `PRIMARY KEY (customer_id, shopify_product_id)`, so `ON CONFLICT DO NOTHING`
 * and "zero rows affected" behave as Postgres would.
 */
class FakeTables implements Queryable {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  private readonly tables: Record<TableName, Set<string>> = {
    customer_wishlist: new Set(),
    customer_favourites: new Set(),
  };

  seed(table: TableName, customerId: string, productIds: readonly string[]): void {
    for (const productId of productIds) {
      this.tables[table].add(`${customerId}|${productId}`);
    }
  }

  rowsFor(table: TableName, customerId: string): string[] {
    return [...this.tables[table]]
      .filter((key) => key.startsWith(`${customerId}|`))
      .map((key) => key.slice(customerId.length + 1))
      .sort();
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    const bound = values ?? [];
    this.calls.push({ sql: queryText, values: bound });

    const table = this.tableOf(queryText);
    const store = this.tables[table];

    // Predicates are read from the STATEMENT and applied with the values the
    // statement bound — so a missing predicate widens the result, exactly as it
    // would against a real database.
    const scopedToCustomer = /\bcustomer_id\s*=\s*\$1/i.test(queryText);
    const scopedToProduct = /\bshopify_product_id\s*=\s*\$2/i.test(queryText);
    const customerId = String(bound[0] ?? "");
    const productId = String(bound[1] ?? "");

    const matches = (key: string): boolean => {
      const separator = key.indexOf("|");
      const keyCustomer = key.slice(0, separator);
      const keyProduct = key.slice(separator + 1);
      if (scopedToCustomer && keyCustomer !== customerId) return false;
      if (scopedToProduct && keyProduct !== productId) return false;
      return true;
    };

    if (/^\s*insert/i.test(queryText)) {
      const key = `${customerId}|${productId}`;
      const existed = store.has(key);
      store.add(key);
      return this.result<R>([], existed ? 0 : 1);
    }

    if (/^\s*delete/i.test(queryText)) {
      const doomed = [...store].filter(matches);
      for (const key of doomed) store.delete(key);
      return this.result<R>([], doomed.length);
    }

    const selected = [...store].filter(matches);

    if (/count\(\*\)/i.test(queryText)) {
      return this.result<R>([{ item_count: String(selected.length) } as unknown as R], 1);
    }

    const rows = selected
      .map((key) => key.slice(key.indexOf("|") + 1))
      .sort()
      .map((shopify_product_id) => ({ shopify_product_id }) as unknown as R);
    return this.result<R>(rows, rows.length);
  }

  private tableOf(sql: string): TableName {
    return /customer_favourites/i.test(sql) ? "customer_favourites" : "customer_wishlist";
  }

  private result<R extends QueryResultRow>(rows: R[], rowCount: number): QueryResult<R> {
    return { rows, rowCount, command: "SELECT", oid: 0, fields: [] };
  }
}

/** A store that fails the way a database fails. */
class BrokenTables implements Queryable {
  constructor(private readonly failure: unknown) {}
  async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
    throw this.failure;
  }
}

/** Fixtures with both customers populated, so isolation has something to fail on. */
function twoCustomerStore(): FakeTables {
  const db = new FakeTables();
  db.seed("customer_wishlist", CUSTOMER_A, ["1001", "1002"]);
  db.seed("customer_wishlist", CUSTOMER_B, ["2001", "2002", "2003"]);
  db.seed("customer_favourites", CUSTOMER_A, ["3001"]);
  db.seed("customer_favourites", CUSTOMER_B, ["4001", "4002"]);
  return db;
}

/* ========================================================================== *
 * Reads
 * ========================================================================== */

describe("reads return only the caller's rows (Requirements 2.1, 2.5, 2.6)", () => {
  it("reads the caller's wishlist and none of the other customer's", async () => {
    const db = twoCustomerStore();
    await expect(readWishlist(db, SCOPE_A)).resolves.toEqual(["1001", "1002"]);
    await expect(readWishlist(db, SCOPE_B)).resolves.toEqual(["2001", "2002", "2003"]);
  });

  it("reads the caller's favourites and none of the other customer's", async () => {
    const db = twoCustomerStore();
    await expect(readFavourites(db, SCOPE_A)).resolves.toEqual(["3001"]);
    await expect(readFavourites(db, SCOPE_B)).resolves.toEqual(["4001", "4002"]);
  });

  it("counts only the caller's saved products", async () => {
    // N5's 500-item cap is per customer; a count that included another customer's
    // rows would lock a member out of their own wishlist.
    const db = twoCustomerStore();
    await expect(countWishlistItems(db, SCOPE_A)).resolves.toBe(2);
    await expect(countWishlistItems(db, SCOPE_B)).resolves.toBe(3);
  });

  it("returns an empty list for a customer with nothing saved, not an error", async () => {
    const db = twoCustomerStore();
    const newcomer = scopeFor("1f0c7c4e-0000-4000-8000-00000000000c");
    await expect(readWishlist(db, newcomer)).resolves.toEqual([]);
    await expect(countWishlistItems(db, newcomer)).resolves.toBe(0);
  });

  it("binds the caller's own id as $1 on every statement it issues", async () => {
    const db = twoCustomerStore();
    await readWishlist(db, SCOPE_A);
    await readFavourites(db, SCOPE_A);
    await countWishlistItems(db, SCOPE_A);
    await setWishlistItem(db, SCOPE_A, "1003", true);
    await setWishlistItem(db, SCOPE_A, "1003", false);
    await setFavourite(db, SCOPE_A, "3002", true);

    expect(db.calls.length).toBe(6);
    for (const call of db.calls) {
      expect(call.values[0]).toBe(CUSTOMER_A);
    }
  });
});

/* ========================================================================== *
 * Writes, and the IDOR case that matters
 * ========================================================================== */

describe("writes touch only the caller's rows (Requirement 2.2, design §4.5 row 8)", () => {
  it("leaves the other customer's row intact when asked to remove their product", async () => {
    // THE CENTRAL TEST. A asks to remove `2001`, which belongs to B. The delete
    // carries `WHERE customer_id = $1 AND shopify_product_id = $2`, so it matches
    // zero rows: A's set is unchanged, B's row survives, and A learns nothing
    // about whether `2001` exists at all.
    const db = twoCustomerStore();

    const changed = await setWishlistItem(db, SCOPE_A, "2001", false);

    expect(changed).toBe(false);
    expect(db.rowsFor("customer_wishlist", CUSTOMER_B)).toEqual(["2001", "2002", "2003"]);
    expect(db.rowsFor("customer_wishlist", CUSTOMER_A)).toEqual(["1001", "1002"]);
  });

  it("reports a foreign removal exactly as it reports an absent one", async () => {
    // No existence oracle: "not yours" and "never existed" are the same answer,
    // because the statement cannot tell them apart either.
    const db = twoCustomerStore();
    const foreign = await setWishlistItem(db, SCOPE_A, "2001", false);
    const fictional = await setWishlistItem(db, SCOPE_A, "99999999", false);
    expect(foreign).toBe(fictional);
  });

  it("adds a product for the caller alone, even one another customer also saved", async () => {
    const db = twoCustomerStore();

    await expect(setWishlistItem(db, SCOPE_A, "2001", true)).resolves.toBe(true);

    expect(db.rowsFor("customer_wishlist", CUSTOMER_A)).toEqual(["1001", "1002", "2001"]);
    expect(db.rowsFor("customer_wishlist", CUSTOMER_B)).toEqual(["2001", "2002", "2003"]);
  });

  it("treats a repeated add as an unchanged success rather than a conflict", async () => {
    // N5 answers `200` for a repeat add. `false` means "already so", which the
    // route must not confuse with `404`.
    const db = twoCustomerStore();
    await expect(setWishlistItem(db, SCOPE_A, "1001", true)).resolves.toBe(false);
    expect(db.rowsFor("customer_wishlist", CUSTOMER_A)).toEqual(["1001", "1002"]);
  });

  it("removes the caller's own product and reports the change", async () => {
    const db = twoCustomerStore();
    await expect(setWishlistItem(db, SCOPE_A, "1001", false)).resolves.toBe(true);
    expect(db.rowsFor("customer_wishlist", CUSTOMER_A)).toEqual(["1002"]);
  });

  it("keeps favourites and wishlist as separate sets", async () => {
    const db = twoCustomerStore();
    await setWishlistItem(db, SCOPE_A, "5001", true);
    expect(db.rowsFor("customer_favourites", CUSTOMER_A)).toEqual(["3001"]);

    await setFavourite(db, SCOPE_A, "5002", true);
    expect(db.rowsFor("customer_wishlist", CUSTOMER_A)).toEqual(["1001", "1002", "5001"]);
  });

  it("no sequence of one customer's writes changes the other's row count", async () => {
    const db = twoCustomerStore();
    const before = db.rowsFor("customer_wishlist", CUSTOMER_B);

    for (const productId of ["2001", "2002", "2003", "1001", "9999"]) {
      await setWishlistItem(db, SCOPE_A, productId, false);
      await setWishlistItem(db, SCOPE_A, productId, true);
      await setWishlistItem(db, SCOPE_A, productId, false);
    }

    expect(db.rowsFor("customer_wishlist", CUSTOMER_B)).toEqual(before);
  });
});

/* ========================================================================== *
 * Input validation
 * ========================================================================== */

describe("a product id is validated before any statement runs", () => {
  it.each([
    ["an empty string", ""],
    ["a non-numeric value", "not-a-product"],
    ["zero", "0"],
    ["a negative id", "-5"],
    ["a fractional id", "1.5"],
    ["a SQL metacharacter payload", "1; DROP TABLE customer_wishlist"],
    ["a GID", "gid://shopify/Product/1001"],
  ])("refuses %s without issuing a query", async (_label, productId) => {
    const db = twoCustomerStore();
    await expect(setWishlistItem(db, SCOPE_A, productId, true)).rejects.toBeInstanceOf(
      InvalidPreferenceInputError,
    );
    expect(db.calls).toEqual([]);
  });

  it("collapses leading zeros the same way the shipped reconcile path does", async () => {
    // Two normalisers free to disagree would disagree here, and the disagreement
    // decides whether `007` and `7` are one row or two.
    const db = new FakeTables();
    await setWishlistItem(db, SCOPE_A, "007", true);
    await expect(setWishlistItem(db, SCOPE_A, "7", true)).resolves.toBe(false);
    expect(db.rowsFor("customer_wishlist", CUSTOMER_A)).toEqual(["7"]);
  });
});

/* ========================================================================== *
 * Faults
 * ========================================================================== */

describe("a database fault is reported as a fault, never as 404 or unauthorised", () => {
  it("wraps a fault raised on a primitive-backed statement", async () => {
    const db = new BrokenTables(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));

    for (const attempt of [
      () => countWishlistItems(db, SCOPE_A),
      () => setWishlistItem(db, SCOPE_A, "1001", true),
      () => setWishlistItem(db, SCOPE_A, "1001", false),
    ]) {
      let thrown: unknown;
      try {
        await attempt();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PortalRepositoryFaultError);
      expect(thrown).not.toBeInstanceOf(PortalResourceNotFoundError);
    }
  });

  it("lets a fault on a delegating read propagate rather than reading as empty", async () => {
    // HONEST DIFFERENCE, recorded rather than smoothed over: a delegating wrapper
    // does not pass through the primitive, so its failure arrives as the driver's
    // own error rather than a PortalRepositoryFaultError. Both become a 500 and
    // neither is a 404 or a 401, so the property that matters holds — but the
    // classes differ, and a route that branches on the class needs to know.
    const failure = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    const db = new BrokenTables(failure);

    await expect(readWishlist(db, SCOPE_A)).rejects.toBe(failure);
    await expect(readFavourites(db, SCOPE_A)).rejects.toBe(failure);
    await expect(setFavourite(db, SCOPE_A, "1", true)).rejects.toBe(failure);
  });

  it("never returns an empty set in place of a fault", async () => {
    const db = new BrokenTables(new Error("down"));
    await expect(readWishlist(db, SCOPE_A)).rejects.toBeTruthy();
    await expect(countWishlistItems(db, SCOPE_A)).rejects.toBeTruthy();
  });
});

/* ========================================================================== *
 * The fake is capable of failing
 * ========================================================================== */

describe("the fake would notice a missing ownership predicate", () => {
  it("widens the result when a statement omits WHERE customer_id = $1", async () => {
    // Proof that the isolation assertions above are load-bearing. The fake reads
    // predicates from the statement, so an unscoped read returns BOTH customers'
    // rows — which is why those assertions can fail.
    const db = twoCustomerStore();
    const unscoped = await db.query<{ shopify_product_id: string }>(
      "SELECT shopify_product_id FROM customer_wishlist",
      [CUSTOMER_A],
    );
    expect(unscoped.rows.map((row) => row.shopify_product_id)).toEqual([
      "1001",
      "1002",
      "2001",
      "2002",
      "2003",
    ]);
  });
});
