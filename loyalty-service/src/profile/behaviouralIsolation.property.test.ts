/**
 * Property-based test for Property 13 — "Behavioural data never affects ledger
 * balances" (task 14.7).
 *
 *   ∀ customer c and any sequence of behavioural operations
 *   (add/remove favourite, wishlist change, record recently-viewed, portal
 *   visit): `balance(c)` and `spendableBalance(c)` are unchanged, and nothing is
 *   written to `ledger_entries`.
 *
 * **Validates: Requirements 17.3**
 *
 * This is a DISTINCT property-test file for task 14.7. It does not modify any of
 * the task 14.2/14.3/14.6 unit tests; it exercises the SAME production
 * behavioural/preference modules —
 *   - {@link setFavourite} / {@link reconcileWishlist} (favouritesWishlist.ts),
 *   - {@link RecentlyViewedStore.recordView} (recentlyViewed.ts),
 *   - {@link markPortalVisit} (portalVisit.ts)
 * — together with the SAME authoritative ledger projections
 * {@link computeBalance} and {@link computeSpendableBalance} (ledger/balance.ts),
 * all against ONE shared, self-contained in-memory fake `Queryable`.
 *
 * The test seeds an arbitrary pre-existing ledger (`ledger_entries` rows and
 * `point_lots`), snapshots `balance` + `spendableBalance`, runs a randomly
 * generated sequence of behavioural operations, then asserts:
 *   1. `balance(c)` and `spendableBalance(c)` are byte-for-byte unchanged;
 *   2. the `ledger_entries` and `point_lots` row sets are structurally identical
 *      before and after (no append/mutate/delete);
 *   3. every statement issued during the behavioural phase targets ONLY the
 *      preference tables — any attempt to touch `ledger_entries`, `point_lots`,
 *      or `redemptions` from a behavioural op throws immediately.
 *
 * NO live/production database is touched: the fake models the six relevant
 * tables purely in memory, dispatching on the SQL shapes the production code
 * emits and returning BIGINT sums as strings exactly as `pg` does.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { computeBalance, computeSpendableBalance } from "../ledger/balance.js";
import { getWishlist, reconcileWishlist, setFavourite } from "./favouritesWishlist.js";
import { RecentlyViewedStore } from "./recentlyViewed.js";
import { markPortalVisit } from "./portalVisit.js";

const CUSTOMER = "cust-behavioural-0001";
/** A second customer whose ledger must also stay untouched (cross-customer isolation). */
const OTHER_CUSTOMER = "cust-behavioural-0002";
/** Fixed reference instant so ledger/lot state and the fake clock are deterministic. */
const AS_OF = new Date("2025-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/* ── in-memory table row shapes ─────────────────────────────────────────────── */

interface LedgerRow {
  customer_id: string;
  points: number;
}

interface LotRow {
  customer_id: string;
  remaining_points: number;
  expires_at: Date | null;
}

interface PrefRow {
  customer_id: string;
  shopify_product_id: string;
}

interface RecentRow {
  customer_id: string;
  shopify_product_id: string;
  viewed_at: Date;
}

interface VisitRow {
  customer_id: string;
  first_visited_at: Date;
  last_visited_at: Date;
}

/**
 * A single self-contained in-memory fake modelling every table these flows read
 * or write: the authoritative `ledger_entries` / `point_lots` (read-only from
 * the balance projections) and the off-ledger preference tables
 * `customer_favourites`, `customer_wishlist`, `customer_recently_viewed`, and
 * `portal_visits`. Dispatches purely on the SQL text the production code emits.
 *
 * When `guardLedger` is true (the behavioural phase), any statement referencing
 * a ledger/balance table throws — so a behavioural op that so much as reads the
 * ledger, let alone writes it, fails the property loudly.
 */
class FakeDb implements Queryable {
  readonly ledger: LedgerRow[] = [];
  readonly lots: LotRow[] = [];
  readonly favourites: PrefRow[] = [];
  readonly wishlist: PrefRow[] = [];
  readonly recentlyViewed: RecentRow[] = [];
  readonly visits: VisitRow[] = [];

  /** Every statement issued (trimmed), for isolation assertions. */
  readonly queries: string[] = [];
  /** When true, touching any ledger/balance table is a hard error. */
  guardLedger = false;

  private now: Date;
  constructor(now: Date) {
    this.now = now;
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = queryText.trim();
    this.queries.push(q);

    const touchesLedger = /ledger_entries|point_lots|redemptions/i.test(q);
    if (this.guardLedger && touchesLedger) {
      throw new Error(
        `Property 13 violation: a behavioural/preference operation issued a ` +
          `statement against a ledger/balance table: ${q}`,
      );
    }

    // ── ledger projections (read-only) ──────────────────────────────────────
    if (/FROM ledger_entries/i.test(q)) {
      const sum = this.ledger
        .filter((r) => r.customer_id === values[0])
        .reduce((s, r) => s + r.points, 0);
      return this.result<R>([{ balance: String(sum) } as unknown as R]);
    }
    if (/FROM point_lots/i.test(q)) {
      const asOf = values[1] as Date;
      const sum = this.lots
        .filter(
          (r) =>
            r.customer_id === values[0] &&
            r.remaining_points > 0 &&
            (r.expires_at === null || r.expires_at.getTime() > asOf.getTime()),
        )
        .reduce((s, r) => s + r.remaining_points, 0);
      return this.result<R>([{ spendable: String(sum) } as unknown as R]);
    }

    // ── favourites ──────────────────────────────────────────────────────────
    if (q.startsWith("INSERT INTO customer_favourites")) {
      return this.insertPref<R>(this.favourites, values as [string, string]);
    }
    if (q.startsWith("DELETE FROM customer_favourites")) {
      return this.deletePref<R>(this.favourites, values as [string, string]);
    }
    if (q.startsWith("SELECT shopify_product_id FROM customer_favourites")) {
      return this.selectPref<R>(this.favourites, values[0] as string);
    }

    // -- wishlist --
    if (q.startsWith("INSERT INTO customer_wishlist")) {
      return this.insertPref<R>(this.wishlist, values as [string, string]);
    }
    if (q.startsWith("SELECT shopify_product_id FROM customer_wishlist")) {
      return this.selectPref<R>(this.wishlist, values[0] as string);
    }

    // -- recently viewed --
    if (q.startsWith("INSERT INTO customer_recently_viewed")) {
      const [customerId, productId, viewedAt] = values as [string, string, Date];
      const existing = this.recentlyViewed.find(
        (r) => r.customer_id === customerId && r.shopify_product_id === productId,
      );
      if (existing) {
        existing.viewed_at = viewedAt;
      } else {
        this.recentlyViewed.push({
          customer_id: customerId,
          shopify_product_id: productId,
          viewed_at: viewedAt,
        });
      }
      return this.result<R>([], 1);
    }

    // -- portal visits --
    if (q.startsWith("INSERT INTO portal_visits")) {
      const customerId = values[0] as string;
      const existing = this.visits.find((r) => r.customer_id === customerId);
      if (existing) {
        existing.last_visited_at = this.now;
        return this.result<R>([
          {
            first_visit: false,
            first_visited_at: existing.first_visited_at,
            last_visited_at: existing.last_visited_at,
          } as unknown as R,
        ]);
      }
      const row: VisitRow = {
        customer_id: customerId,
        first_visited_at: this.now,
        last_visited_at: this.now,
      };
      this.visits.push(row);
      return this.result<R>([
        {
          first_visit: true,
          first_visited_at: row.first_visited_at,
          last_visited_at: row.last_visited_at,
        } as unknown as R,
      ]);
    }

    throw new Error(`Unexpected query in FakeDb: ${q}`);
  }

  private insertPref<R extends QueryResultRow>(
    table: PrefRow[],
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

  private deletePref<R extends QueryResultRow>(
    table: PrefRow[],
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

  private selectPref<R extends QueryResultRow>(
    table: PrefRow[],
    customerId: string,
  ): QueryResult<R> {
    const rows = table
      .filter((r) => r.customer_id === customerId)
      .map((r) => r.shopify_product_id)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
      .map((id) => ({ shopify_product_id: id }) as unknown as R);
    return this.result<R>(rows);
  }

  private result<R extends QueryResultRow>(rows: R[], rowCount = rows.length): QueryResult<R> {
    return { rows, rowCount, command: "", oid: 0, fields: [] } as QueryResult<R>;
  }
}

/* ── generators ──────────────────────────────────────────────────────────────── */

/** A Shopify product id — a positive integer string (BIGINT column). */
const productIdArb = fc.integer({ min: 1, max: 5000 }).map(String);

/**
 * One behavioural/preference operation from the four families named in
 * Property 13: favourite set/unset, wishlist reconcile, recently-viewed
 * ingestion, and portal visit.
 */
type Op =
  | { kind: "favourite"; productId: string; on: boolean }
  | { kind: "wishlist"; productIds: string[] }
  | { kind: "recentlyViewed"; productId: string }
  | { kind: "visit" }
  | { kind: "otherCustomerFavourite"; productId: string };

/**
 * The same operation families, but addressed at an EXPLICIT customer — used by
 * the two-customer isolation property below, where which customer acted is the
 * whole point rather than an incidental detail.
 */
type ScopedOp =
  | { kind: "favourite"; productId: string; on: boolean }
  | { kind: "wishlist"; productIds: string[] }
  | { kind: "unfavourite"; productId: string };

const scopedOpArb: fc.Arbitrary<ScopedOp> = fc.oneof(
  fc.record({
    kind: fc.constant("favourite" as const),
    productId: productIdArb,
    on: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("wishlist" as const),
    productIds: fc.array(productIdArb, { maxLength: 6 }),
  }),
  fc.record({ kind: fc.constant("unfavourite" as const), productId: productIdArb }),
);

/** An interleaving of operations, each tagged with the customer performing it. */
const interleavedOpsArb = fc.array(
  fc.record({ actor: fc.constantFrom("A" as const, "B" as const), op: scopedOpArb }),
  { maxLength: 30 },
);

async function applyScopedOp(db: FakeDb, customerId: string, op: ScopedOp): Promise<void> {
  switch (op.kind) {
    case "favourite":
      await setFavourite(db, customerId, op.productId, op.on);
      return;
    case "unfavourite":
      await setFavourite(db, customerId, op.productId, false);
      return;
    case "wishlist":
      await reconcileWishlist(db, customerId, op.productIds);
      return;
  }
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("favourite" as const),
    productId: productIdArb,
    on: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("wishlist" as const),
    productIds: fc.array(productIdArb, { maxLength: 5 }),
  }),
  fc.record({ kind: fc.constant("recentlyViewed" as const), productId: productIdArb }),
  fc.record({ kind: fc.constant("visit" as const) }),
  // Exercise another customer's preferences too, to prove cross-customer isolation.
  fc.record({
    kind: fc.constant("otherCustomerFavourite" as const),
    productId: productIdArb,
  }),
);

const opsArb = fc.array(opArb, { maxLength: 25 });

/** Arbitrary pre-existing ledger entries for a customer (any signed non-zero movement). */
const ledgerSeedArb = fc.array(
  fc.integer({ min: -800, max: 800 }).filter((n) => n !== 0),
  { maxLength: 12 },
);

/** Arbitrary pre-existing point lots (mix of live, expired, and never-expiring). */
const lotsSeedArb = fc.array(
  fc.record({
    remaining: fc.nat({ max: 1000 }),
    // -60..0 => expired at AS_OF; 1..400 => live; null => never expires.
    expiryKind: fc.oneof(fc.constant<null>(null), fc.integer({ min: -60, max: 400 })),
  }),
  { maxLength: 8 },
);

function seedLedger(db: FakeDb, customerId: string, points: number[]): void {
  for (const p of points) {
    db.ledger.push({ customer_id: customerId, points: p });
  }
}

function seedLots(
  db: FakeDb,
  customerId: string,
  lots: { remaining: number; expiryKind: number | null }[],
): void {
  for (const lot of lots) {
    db.lots.push({
      customer_id: customerId,
      remaining_points: lot.remaining,
      expires_at:
        lot.expiryKind === null ? null : new Date(AS_OF.getTime() + lot.expiryKind * DAY_MS),
    });
  }
}

/** Structural snapshot of the balance-bearing tables, for before/after comparison. */
function ledgerSnapshot(db: FakeDb): string {
  return JSON.stringify({
    ledger: db.ledger,
    lots: db.lots.map((l) => ({
      customer_id: l.customer_id,
      remaining_points: l.remaining_points,
      expires_at: l.expires_at === null ? null : l.expires_at.toISOString(),
    })),
  });
}

async function applyOp(db: FakeDb, recentlyViewed: RecentlyViewedStore, op: Op): Promise<void> {
  switch (op.kind) {
    case "favourite":
      await setFavourite(db, CUSTOMER, op.productId, op.on);
      return;
    case "wishlist":
      await reconcileWishlist(db, CUSTOMER, op.productIds);
      return;
    case "recentlyViewed":
      await recentlyViewed.recordView(CUSTOMER, op.productId, db);
      return;
    case "visit":
      await markPortalVisit(CUSTOMER, db);
      return;
    case "otherCustomerFavourite":
      await setFavourite(db, OTHER_CUSTOMER, op.productId, true);
      return;
  }
}

describe("Property 13 — behavioural data never affects ledger balances (Req 17.3)", () => {
  it("leaves balance and spendableBalance unchanged and writes nothing to the ledger", async () => {
    await fc.assert(
      fc.asyncProperty(
        opsArb,
        ledgerSeedArb,
        lotsSeedArb,
        ledgerSeedArb,
        lotsSeedArb,
        async (ops, ledgerC, lotsC, ledgerOther, lotsOther) => {
          const db = new FakeDb(AS_OF);
          // Seed a non-trivial authoritative ledger for both customers.
          seedLedger(db, CUSTOMER, ledgerC);
          seedLots(db, CUSTOMER, lotsC);
          seedLedger(db, OTHER_CUSTOMER, ledgerOther);
          seedLots(db, OTHER_CUSTOMER, lotsOther);

          // Every recorded view writes (minIntervalMs = 0), maximising the
          // chances of a stray ledger write if isolation were broken.
          const recentlyViewed = new RecentlyViewedStore(db, {
            minIntervalMs: 0,
            now: () => AS_OF,
          });

          // Snapshot balances + the balance-bearing tables BEFORE.
          const balanceBefore = await computeBalance(CUSTOMER, db);
          const spendableBefore = await computeSpendableBalance(CUSTOMER, db, AS_OF);
          const otherBalanceBefore = await computeBalance(OTHER_CUSTOMER, db);
          const otherSpendableBefore = await computeSpendableBalance(OTHER_CUSTOMER, db, AS_OF);
          const tablesBefore = ledgerSnapshot(db);

          // ── behavioural phase: any ledger access now throws ──────────────
          db.guardLedger = true;
          const behaviouralStart = db.queries.length;
          for (const op of ops) {
            await applyOp(db, recentlyViewed, op);
          }
          const behaviouralQueries = db.queries.slice(behaviouralStart);
          db.guardLedger = false;

          // (3) No behavioural statement referenced any ledger/balance table.
          for (const q of behaviouralQueries) {
            expect(q).not.toMatch(/ledger_entries|point_lots|redemptions/i);
          }

          // (2) The balance-bearing tables are structurally identical.
          expect(ledgerSnapshot(db)).toBe(tablesBefore);

          // (1) Balances are unchanged for the acting customer...
          expect(await computeBalance(CUSTOMER, db)).toBe(balanceBefore);
          expect(await computeSpendableBalance(CUSTOMER, db, AS_OF)).toBe(spendableBefore);
          // ...and for any other customer.
          expect(await computeBalance(OTHER_CUSTOMER, db)).toBe(otherBalanceBefore);
          expect(await computeSpendableBalance(OTHER_CUSTOMER, db, AS_OF)).toBe(
            otherSpendableBefore,
          );
        },
      ),
    );
  });

  it("still holds when the exact same operation sequence is replayed (idempotent re-runs)", async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, ledgerSeedArb, lotsSeedArb, async (ops, ledgerC, lotsC) => {
        const db = new FakeDb(AS_OF);
        seedLedger(db, CUSTOMER, ledgerC);
        seedLots(db, CUSTOMER, lotsC);
        const recentlyViewed = new RecentlyViewedStore(db, { minIntervalMs: 0, now: () => AS_OF });

        const balanceBefore = await computeBalance(CUSTOMER, db);
        const spendableBefore = await computeSpendableBalance(CUSTOMER, db, AS_OF);
        const tablesBefore = ledgerSnapshot(db);

        db.guardLedger = true;
        // Run the sequence twice to cover repeated/duplicate behavioural ops.
        for (let round = 0; round < 2; round++) {
          for (const op of ops) {
            await applyOp(db, recentlyViewed, op);
          }
        }
        db.guardLedger = false;

        expect(ledgerSnapshot(db)).toBe(tablesBefore);
        expect(await computeBalance(CUSTOMER, db)).toBe(balanceBefore);
        expect(await computeSpendableBalance(CUSTOMER, db, AS_OF)).toBe(spendableBefore);
      }),
    );
  });
});

/**
 * Two-customer isolation — design §4.6 item 2, added as part of the Phase 0
 * wishlist repair (spec tasks 1.3–1.6).
 *
 * The wishlist reconcile fix made `POST /v1/profile/wishlist/reconcile` reachable
 * for the first time in production. Before that endpoint starts writing real
 * rows, the DATA LAYER's isolation is asserted here as a property rather than as
 * a spot check:
 *
 *   ∀ interleavings of behavioural operations by customers A and B:
 *     A's operations never add, remove or alter any of B's rows, and never appear
 *     in B's reads — and vice versa.
 *
 * This is the layer below the HTTP one. `wishlistIdor.integration.test.ts` covers
 * the request surface (foreign identifiers in the body, query, headers and
 * cookies); this covers the SQL, so a future statement that forgets its
 * `customer_id = $1` predicate fails here.
 *
 * Validates: Requirements 7.1, 7.8, 17.4
 */
describe("two-customer isolation across the behavioural tables (design §4.6 item 2)", () => {
  /** Snapshot of one customer's preference rows, order-independent. */
  function preferenceSnapshot(db: FakeDb, customerId: string): string {
    const pick = (rows: PrefRow[]) =>
      rows
        .filter((r) => r.customer_id === customerId)
        .map((r) => r.shopify_product_id)
        .sort();
    return JSON.stringify({ favourites: pick(db.favourites), wishlist: pick(db.wishlist) });
  }

  it("A's operations never alter B's rows, in any interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(interleavedOpsArb, async (tagged) => {
        const db = new FakeDb(AS_OF);

        // Run the interleaving, checking after EVERY step that the customer who
        // did not act is byte-identical. Checking only at the end would let a
        // leak followed by a coincidental repair pass.
        for (const { actor, op } of tagged) {
          const actingId = actor === "A" ? CUSTOMER : OTHER_CUSTOMER;
          const bystanderId = actor === "A" ? OTHER_CUSTOMER : CUSTOMER;
          const bystanderBefore = preferenceSnapshot(db, bystanderId);

          await applyScopedOp(db, actingId, op);

          expect(
            preferenceSnapshot(db, bystanderId),
            `an operation by ${actor} changed the other customer's rows`,
          ).toBe(bystanderBefore);
        }
      }),
    );
  });

  it("neither customer's reads ever return the other's products", async () => {
    await fc.assert(
      fc.asyncProperty(interleavedOpsArb, async (tagged) => {
        const db = new FakeDb(AS_OF);
        const written = { A: new Set<string>(), B: new Set<string>() };

        for (const { actor, op } of tagged) {
          const actingId = actor === "A" ? CUSTOMER : OTHER_CUSTOMER;
          await applyScopedOp(db, actingId, op);
          if (op.kind === "wishlist") for (const id of op.productIds) written[actor].add(id);
        }

        const aWishlist = await getWishlist(db, CUSTOMER);
        const bWishlist = await getWishlist(db, OTHER_CUSTOMER);

        // Every id A can read was written by A. An id both wrote is legitimately
        // in both lists — as two independent rows, never one shared row.
        for (const id of aWishlist) expect(written.A.has(id)).toBe(true);
        for (const id of bWishlist) expect(written.B.has(id)).toBe(true);
        // And nothing A never wrote leaked in from B.
        for (const id of bWishlist) {
          if (!written.A.has(id)) expect(aWishlist).not.toContain(id);
        }
      }),
    );
  });

  it("reconciling A's device list can never remove one of B's wishlist entries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(productIdArb, { minLength: 1, maxLength: 8 }),
        fc.array(productIdArb, { maxLength: 8 }),
        async (bIds, aDeviceIds) => {
          const db = new FakeDb(AS_OF);
          // B owns a wishlist first.
          await reconcileWishlist(db, OTHER_CUSTOMER, bIds);
          const bBefore = await getWishlist(db, OTHER_CUSTOMER);

          // A reconciles — including, deliberately, ids that B also holds.
          await reconcileWishlist(db, CUSTOMER, [...aDeviceIds, ...bIds]);

          // Reconciliation is add-only AND customer-scoped: B is untouched.
          expect(await getWishlist(db, OTHER_CUSTOMER)).toEqual(bBefore);
        },
      ),
    );
  });

  it("un-favouriting a product A does not own never deletes B's row", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(productIdArb, { minLength: 1, maxLength: 8 }), async (bIds) => {
        const db = new FakeDb(AS_OF);
        for (const id of bIds) await setFavourite(db, OTHER_CUSTOMER, id, true);
        const bBefore = preferenceSnapshot(db, OTHER_CUSTOMER);

        // A tries to unset every one of B's favourites by naming the product id.
        for (const id of bIds) await setFavourite(db, CUSTOMER, id, false);

        expect(preferenceSnapshot(db, OTHER_CUSTOMER)).toBe(bBefore);
      }),
    );
  });
});
