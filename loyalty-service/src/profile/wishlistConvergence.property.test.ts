// Feature: customer-experience-portal, Property 3: Wishlist state converges to one source of truth
/**
 * PROPERTY 3 — spec task 9.2. Validates Requirements 7.1, 7.8, 7.9.
 *
 * The property, stated so it can fail: after ANY interleaving of storefront adds,
 * portal adds, explicit portal removals and reconciliation runs, the account-level
 * wishlist is ONE SET — no duplicate product identifier — and it equals exactly
 * "everything ever added, minus everything explicitly removed since it was last
 * added".
 *
 * That second clause is the part task 9.1 made true. Before the explicit-removal
 * tombstone, an add-only union over a device list that is never cleared could not
 * honour a removal it had no record of (§8.4 rule 3), so the property was violated
 * by construction: remove, reconcile, and the product was back.
 *
 * SAFETY: no network, no production, no real Postgres. The fake enforces the same
 * primary keys the real schema does.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import type { CustomerScope } from "../auth/customerScope.js";
import { getWishlist, listWishlistRemovals, reconcileWishlist } from "./favouritesWishlist.js";
import { setWishlistItem } from "../portal/repository/customerOwned.js";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SCOPE = { customerId: CUSTOMER } as unknown as CustomerScope;

/** Longest-table-name-first dispatch; see the note in `routes/wishlist.test.ts`. */
class FakeDb implements Queryable {
  readonly wishlist = new Set<string>();
  readonly removals = new Set<string>();

  private rows(store: Set<string>, customerId: string): string[] {
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
    const store = /\bcustomer_wishlist_removals\b/.test(q)
      ? this.removals
      : /\bcustomer_wishlist\b/.test(q)
        ? this.wishlist
        : (() => {
            throw new Error(`FakeDb: unknown table in ${q}`);
          })();
    const customerId = String(values[0] ?? "");
    const key = `${customerId}|${values[1] === undefined ? null : String(values[1])}`;
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
      return this.result<R>(
        [{ item_count: String(this.rows(store, customerId).length) } as unknown as R],
        1,
      );
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

/** The three entry points §8.4 names, plus the merge. */
type Op =
  | { kind: "storefrontAdd"; productId: string }
  | { kind: "portalAdd"; productId: string }
  | { kind: "portalRemove"; productId: string }
  | { kind: "reconcile" };

const productId = fc.integer({ min: 1, max: 12 }).map(String);

const op: fc.Arbitrary<Op> = fc.oneof(
  productId.map((p) => ({ kind: "storefrontAdd", productId: p }) as Op),
  productId.map((p) => ({ kind: "portalAdd", productId: p }) as Op),
  productId.map((p) => ({ kind: "portalRemove", productId: p }) as Op),
  fc.constant({ kind: "reconcile" } as Op),
);

/**
 * The model: what the account wishlist SHOULD hold.
 *
 * `deviceLocal` only ever grows, because `localStorage` is never cleared (§8.4
 * rule 3) — that is the whole difficulty. `removed` is the tombstone: an explicit
 * removal suppresses the product until an explicit add supersedes it.
 */
function expected(ops: readonly Op[]): Set<string> {
  const deviceLocal = new Set<string>();
  const account = new Set<string>();
  const removed = new Set<string>();
  for (const o of ops) {
    switch (o.kind) {
      case "storefrontAdd":
        // Anonymous/storefront heart writes the device list only.
        deviceLocal.add(o.productId);
        break;
      case "portalAdd":
        account.add(o.productId);
        removed.delete(o.productId);
        break;
      case "portalRemove":
        account.delete(o.productId);
        removed.add(o.productId);
        break;
      case "reconcile":
        for (const p of deviceLocal) if (!removed.has(p)) account.add(p);
        break;
    }
  }
  return account;
}

async function run(db: FakeDb, ops: readonly Op[]): Promise<void> {
  const deviceLocal = new Set<string>();
  for (const o of ops) {
    switch (o.kind) {
      case "storefrontAdd":
        deviceLocal.add(o.productId);
        break;
      case "portalAdd":
        await setWishlistItem(db, SCOPE, o.productId, true);
        break;
      case "portalRemove":
        await setWishlistItem(db, SCOPE, o.productId, false);
        break;
      case "reconcile":
        await reconcileWishlist(db, CUSTOMER, [...deviceLocal]);
        break;
    }
  }
}

describe("Property 3: wishlist state converges to one source of truth", () => {
  it("converges to one set for any interleaving of adds, removals and reconciles", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 40 }), async (ops) => {
        const db = new FakeDb();
        await run(db, ops);
        const actual = await getWishlist(db, CUSTOMER);

        // ONE SET, NO DUPLICATES (Req 7.9).
        expect(new Set(actual).size).toBe(actual.length);

        // AND IT IS THE RIGHT SET: everything added, minus what was explicitly
        // removed and not re-added (Req 7.1, 7.8).
        expect([...actual].sort()).toEqual([...expected(ops)].sort());
      }),
      { numRuns: 200 },
    );
  });

  it("a removal is never undone by a later reconcile, however many run", async () => {
    await fc.assert(
      fc.asyncProperty(
        productId,
        fc.integer({ min: 1, max: 6 }),
        async (target, reconciles) => {
          const db = new FakeDb();
          // The product reaches the device list AND the account, then is removed.
          await setWishlistItem(db, SCOPE, target, true);
          await setWishlistItem(db, SCOPE, target, false);
          for (let i = 0; i < reconciles; i += 1) {
            // The device list still names it — localStorage is never cleared.
            await reconcileWishlist(db, CUSTOMER, [target]);
          }
          expect(await getWishlist(db, CUSTOMER)).not.toContain(target);
          expect(await listWishlistRemovals(db, CUSTOMER)).toContain(target);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("repeated adds of the same product store exactly one entry (Req 7.9)", async () => {
    await fc.assert(
      fc.asyncProperty(productId, fc.integer({ min: 2, max: 8 }), async (target, times) => {
        const db = new FakeDb();
        for (let i = 0; i < times; i += 1) {
          await setWishlistItem(db, SCOPE, target, true);
        }
        expect(await getWishlist(db, CUSTOMER)).toEqual([target]);
      }),
      { numRuns: 100 },
    );
  });

  it("simultaneous adds of the same product still yield one entry (concurrency)", async () => {
    await fc.assert(
      fc.asyncProperty(productId, fc.integer({ min: 2, max: 6 }), async (target, writers) => {
        const db = new FakeDb();
        await Promise.all(
          Array.from({ length: writers }, () => setWishlistItem(db, SCOPE, target, true)),
        );
        expect(await getWishlist(db, CUSTOMER)).toEqual([target]);
      }),
      { numRuns: 100 },
    );
  });

  it("the model itself is falsifiable — an add-only union would fail this property", async () => {
    // Non-vacuity. Reproduce the PRE-9.1 behaviour (merge ignoring tombstones) and
    // show the property rejects it, so a passing suite means the tombstone works
    // rather than that the property is toothless.
    const db = new FakeDb();
    await setWishlistItem(db, SCOPE, "5", true);
    await setWishlistItem(db, SCOPE, "5", false);
    // The old union: insert every device-local id with no tombstone check.
    await db.query(
      `INSERT INTO customer_wishlist (customer_id, shopify_product_id)
       VALUES ($1, $2)
       ON CONFLICT (customer_id, shopify_product_id) DO NOTHING`,
      [CUSTOMER, "5"],
    );
    // That is precisely the resurrection §8.4 described, and it contradicts the model.
    expect(await getWishlist(db, CUSTOMER)).toContain("5");
    expect([...expected([
      { kind: "portalAdd", productId: "5" },
      { kind: "portalRemove", productId: "5" },
      { kind: "storefrontAdd", productId: "5" },
      { kind: "reconcile" },
    ])]).not.toContain("5");
  });
});
