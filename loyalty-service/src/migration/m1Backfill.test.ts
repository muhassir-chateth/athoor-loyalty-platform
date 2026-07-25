/**
 * Unit + property tests for Migration Phase M1 — ledger backfill & reconciliation
 * (task 7.2).
 *
 * NO live/production system is touched and NO Shopify Admin API is called: the
 * backfill runs against a STATEFUL, IN-MEMORY fake {@link Transactor}/`Queryable`
 * that models the customers / ledger_entries / point_lots tables and the exact
 * SQL the flow issues (customer upsert, migration-entry idempotency select, the
 * append-only ledger insert, the non-expiring point_lot insert, and the
 * reconciliation SUM). The fake's transaction rolls back its in-memory state
 * when the callback throws, so we can prove that a reconciliation mismatch or a
 * mid-way failure retains NO partial ledger state (Req 14.6, 14.7). The real
 * {@link LedgerRepository} and {@link computeBalance} are exercised unchanged.
 *
 * The input is a sample M0 backup (the artefact task 7.1 produces): 8 enrolled
 * customers + 31 non-enrolled = 39. M1 reads ONLY this backup — it never reads
 * the live store.
 *
 * Covers:
 *   - Req 14.4: exactly one positive `migration` entry + one matching
 *     NON-EXPIRING point_lot (expires_at = NULL) per enrolled customer, with
 *     tier recomputed from lifetime spend;
 *   - Req 14.5: the 31 non-enrolled customers are NOT created (lazy enrolment);
 *   - Req 14.6: reconciliation passes when SUM(ledger) == exported balance, and
 *     ABORTS with no partial state when a sum does not match;
 *   - Req 14.7: a mid-way failure aborts and retains no partial entry/lot.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { deriveTier } from "../tier/tier.js";
import {
  MIGRATION_ENTRY_TYPE,
  MIGRATION_REASON,
  runM1Backfill,
  type M1BackfillOptions,
} from "./m1Backfill.js";
import {
  BACKUP_KIND,
  type ExportedCustomer,
  type M0Backup,
  type ParsedLoyaltyFields,
} from "./m0Export.js";

const STORE = "myathoorlondon.myshopify.com";
const FIXED_NOW = () => new Date("2025-01-15T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Sample M0 backup builders (the artefact produced by task 7.1).
// ---------------------------------------------------------------------------

const EMPTY_LOYALTY: ParsedLoyaltyFields = {
  pointsBalance: null,
  lifetimePoints: null,
  tier: null,
  pointsExpiryDate: null,
  referralCode: null,
  referralCount: null,
  activityLog: null,
};

/** An enrolled customer whose exported balance is `50 + floor(spend)` (unless overridden). */
function enrolledExport(index: number, spendGBP: number, balanceOverride?: number): ExportedCustomer {
  const id = String(1000 + index);
  const balance = balanceOverride ?? 50 + Math.floor(spendGBP);
  return {
    id,
    gid: `gid://shopify/Customer/${id}`,
    email: `enrolled${index}@example.com`,
    enrolled: true,
    lifetimeSpendGBP: spendGBP,
    metafields: [
      { namespace: "loyalty", key: "points_balance", type: "number_integer", value: String(balance) },
    ],
    loyalty: { ...EMPTY_LOYALTY, pointsBalance: balance, lifetimePoints: balance, tier: "bronze" },
  };
}

/** A non-enrolled customer: no loyalty metafields, not to be created at migration (Req 14.5). */
function nonEnrolledExport(index: number): ExportedCustomer {
  const id = String(2000 + index);
  return {
    id,
    gid: `gid://shopify/Customer/${id}`,
    email: null,
    enrolled: false,
    lifetimeSpendGBP: 0,
    metafields: [],
    loyalty: { ...EMPTY_LOYALTY },
  };
}

function makeBackup(customers: ExportedCustomer[]): M0Backup {
  const enrolled = customers.filter((c) => c.enrolled).length;
  return {
    schemaVersion: "1.0",
    kind: BACKUP_KIND,
    exportedAt: "2025-01-15T12:00:00.000Z",
    storeDomain: STORE,
    totalExpected: 39,
    enrolledExpected: 8,
    totalExported: customers.length,
    enrolledExported: enrolled,
    customers,
  };
}

/** Spends chosen so the 8 enrolled span every tier (bronze/silver/gold/royal_vip). */
const SAMPLE_SPENDS = [0, 100, 300, 500, 750, 1000, 1500, 3000];

/** The representative production shape: 8 enrolled (clean) + 31 non-enrolled = 39. */
function representativeBackup(): M0Backup {
  const enrolled = SAMPLE_SPENDS.map((spend, i) => enrolledExport(i, spend));
  const nonEnrolled = Array.from({ length: 31 }, (_v, i) => nonEnrolledExport(i));
  return makeBackup([...enrolled, ...nonEnrolled]);
}

// ---------------------------------------------------------------------------
// Stateful in-memory fake DB with a rollback-capable transactor.
// ---------------------------------------------------------------------------

interface LedgerRowState {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  order_reference: number | null;
  point_lot_id: string | null;
  redemption_id: string | null;
  source_event_id: string | null;
  created_at: Date;
}

interface LotRowState {
  id: string;
  customer_id: string;
  ledger_entry_id: string;
  original_points: number;
  remaining_points: number;
  earned_at: Date;
  expires_at: Date | null;
}

interface FakeOptions {
  /** Pre-existing ledger rows keyed by local customer id (to seed a reconciliation mismatch). */
  seedLedger?: Array<{ customerId: string; entryType: string; points: number }>;
  /** Pre-existing customer id mappings (shopifyId -> localId). */
  seedCustomers?: Array<{ shopifyId: number; localId: string }>;
  /** 1-based index of a point_lots INSERT that should throw (to simulate a mid-way failure). */
  throwOnLotInsertCall?: number;
}

function makeFakeDb(opts: FakeOptions = {}) {
  let entrySeq = 0;
  let lotSeq = 0;
  let lotInsertCalls = 0;

  const customersByShopify = new Map<number, string>();
  for (const s of opts.seedCustomers ?? []) {
    customersByShopify.set(s.shopifyId, s.localId);
  }

  const ledger: LedgerRowState[] = [];
  for (const e of opts.seedLedger ?? []) {
    ledger.push({
      id: `seed-${(entrySeq += 1)}`,
      customer_id: e.customerId,
      entry_type: e.entryType,
      points: e.points,
      reason: "seed",
      order_reference: null,
      point_lot_id: null,
      redemption_id: null,
      source_event_id: null,
      created_at: new Date("2025-01-01T00:00:00.000Z"),
    });
  }
  const lots: LotRowState[] = [];

  async function query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = <T>(rows: T[]): QueryResult<R> =>
      ({ rows: rows as unknown as R[], rowCount: rows.length } as QueryResult<R>);

    if (/INSERT INTO\s+customers/i.test(text)) {
      const shopifyId = Number(values[0]);
      let id = customersByShopify.get(shopifyId);
      if (!id) {
        id = `cust-${shopifyId}`;
        customersByShopify.set(shopifyId, id);
      }
      return ok([{ id }]);
    }

    if (/INSERT INTO\s+ledger_entries/i.test(text)) {
      const row: LedgerRowState = {
        id: `led-${(entrySeq += 1)}`,
        customer_id: String(values[0]),
        entry_type: String(values[1]),
        points: Number(values[2]),
        reason: String(values[3]),
        order_reference: (values[4] as number | null) ?? null,
        point_lot_id: (values[5] as string | null) ?? null,
        redemption_id: (values[6] as string | null) ?? null,
        source_event_id: (values[7] as string | null) ?? null,
        created_at: new Date("2025-01-15T12:00:00.000Z"),
      };
      ledger.push(row);
      return ok([row]);
    }

    if (/INSERT INTO\s+point_lots/i.test(text)) {
      lotInsertCalls += 1;
      if (opts.throwOnLotInsertCall && lotInsertCalls === opts.throwOnLotInsertCall) {
        throw new Error("simulated point_lots insert failure (mid-way backfill failure)");
      }
      const row: LotRowState = {
        id: `lot-${(lotSeq += 1)}`,
        customer_id: String(values[0]),
        ledger_entry_id: String(values[1]),
        original_points: Number(values[2]),
        remaining_points: Number(values[2]),
        earned_at: values[3] as Date,
        expires_at: null, // INSERT_MIGRATION_LOT_SQL hardcodes NULL (non-expiring).
      };
      lots.push(row);
      return ok([{ id: row.id }]);
    }

    if (/SUM\(points\)/i.test(text) && /FROM ledger_entries/i.test(text)) {
      const customerId = String(values[0]);
      const sum = ledger
        .filter((e) => e.customer_id === customerId)
        .reduce((acc, e) => acc + e.points, 0);
      return ok([{ balance: String(sum) }]);
    }

    if (/FROM ledger_entries/i.test(text) && /entry_type = 'migration'/i.test(text)) {
      const customerId = String(values[0]);
      const found = ledger.some((e) => e.customer_id === customerId && e.entry_type === "migration");
      return ok(found ? [{ exists: 1 }] : []);
    }

    throw new Error(`Unexpected SQL in fake DB: ${text}`);
  }

  const transactor = {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      // Snapshot for rollback: the whole point of the atomicity test.
      const ledgerSnap = ledger.map((e) => ({ ...e }));
      const lotsSnap = lots.map((l) => ({ ...l }));
      const custSnap = new Map(customersByShopify);
      try {
        return await fn({ query });
      } catch (err) {
        ledger.length = 0;
        ledger.push(...ledgerSnap);
        lots.length = 0;
        lots.push(...lotsSnap);
        customersByShopify.clear();
        for (const [k, v] of custSnap) {
          customersByShopify.set(k, v);
        }
        throw err;
      }
    },
  };

  return { transactor, ledger, lots, customersByShopify };
}

/** A pool that must never be used directly — every append runs on the tx client. */
const throwingPool: Queryable = {
  async query() {
    throw new Error("LedgerRepository pool query used outside a transaction");
  },
};

function makeDeps(fake: ReturnType<typeof makeFakeDb>): Pick<M1BackfillOptions, "repo" | "transactor"> {
  return { repo: new LedgerRepository(throwingPool), transactor: fake.transactor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runM1Backfill — enrolled backfill (Req 14.4)", () => {
  it("creates one migration entry + one non-expiring lot with recomputed tier per enrolled customer", async () => {
    const backup = representativeBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;

    expect(result.processed).toBe(8);
    expect(result.created).toBe(8);
    expect(result.skipped).toBe(0);
    expect(result.mismatches).toEqual([]);

    // Exactly 8 migration ledger entries, all positive and equal to the balance.
    expect(fake.ledger).toHaveLength(8);
    for (const entry of fake.ledger) {
      expect(entry.entry_type).toBe(MIGRATION_ENTRY_TYPE);
      expect(entry.reason).toBe(MIGRATION_REASON);
      expect(entry.points).toBeGreaterThan(0);
    }

    // Exactly 8 point lots, all NON-EXPIRING with original == remaining == balance.
    expect(fake.lots).toHaveLength(8);
    for (const lot of fake.lots) {
      expect(lot.expires_at).toBeNull();
      expect(lot.original_points).toBe(lot.remaining_points);
    }

    // Each enrolled customer: migration points == exported balance, tier from spend.
    for (const bc of result.customers) {
      const source = backup.customers.find((c) => Number(c.id) === bc.shopifyCustomerId)!;
      expect(bc.migrationPoints).toBe(source.loyalty.pointsBalance);
      expect(bc.tier).toBe(deriveTier(source.lifetimeSpendGBP));
      expect(bc.created).toBe(true);
      expect(bc.ledgerEntryId).not.toBeNull();
      expect(bc.pointLotId).not.toBeNull();

      // The migration entry and lot carry exactly the balance.
      const entry = fake.ledger.find((e) => e.id === bc.ledgerEntryId)!;
      expect(entry.points).toBe(source.loyalty.pointsBalance);
      const lot = fake.lots.find((l) => l.id === bc.pointLotId)!;
      expect(lot.original_points).toBe(source.loyalty.pointsBalance);
      expect(lot.expires_at).toBeNull();
    }

    // The tier span is genuinely exercised (bronze .. royal_vip).
    const tiers = result.customers.map((c) => c.tier);
    expect(tiers).toContain("bronze");
    expect(tiers).toContain("silver");
    expect(tiers).toContain("gold");
    expect(tiers).toContain("royal_vip");
  });
});

describe("runM1Backfill — lazy enrolment (Req 14.5)", () => {
  it("does NOT create the 31 non-enrolled customers; only the 8 enrolled are keyed", async () => {
    const backup = representativeBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;

    expect(result.nonEnrolledDeferred).toBe(31);
    // Only the 8 enrolled Shopify ids were ever upserted into customers.
    expect(fake.customersByShopify.size).toBe(8);
    for (let i = 0; i < 31; i += 1) {
      expect(fake.customersByShopify.has(2000 + i)).toBe(false);
    }
    for (let i = 0; i < 8; i += 1) {
      expect(fake.customersByShopify.has(1000 + i)).toBe(true);
    }
  });
});

describe("runM1Backfill — reconciliation passes on match (Req 14.6)", () => {
  it("reports no mismatches when every ledger sum equals the exported balance", async () => {
    const backup = representativeBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;
    expect(result.mismatches).toEqual([]);
  });
});

describe("runM1Backfill — reconciliation mismatch aborts with no partial state (Req 14.6)", () => {
  it("rolls back the entire backfill and retains no new ledger/lot state on a sum mismatch", async () => {
    const backup = representativeBackup();
    // Seed a stray pre-existing ledger entry for the FIRST enrolled customer so
    // its SUM(ledger) becomes balance + 25, which will not equal the exported
    // balance after backfill -> reconciliation must abort.
    const firstShopifyId = 1000;
    const localId = `cust-${firstShopifyId}`;
    const fake = makeFakeDb({
      seedCustomers: [{ shopifyId: firstShopifyId, localId }],
      seedLedger: [{ customerId: localId, entryType: "earn_order", points: 25 }],
    });

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("aborted_reconciliation_mismatch");
    if (result.status !== "aborted_reconciliation_mismatch") return;

    expect(result.mismatches).toHaveLength(1);
    const mismatch = result.mismatches[0]!;
    expect(mismatch.shopifyCustomerId).toBe(firstShopifyId);
    const expectedBalance = backup.customers.find((c) => c.id === "1000")!.loyalty.pointsBalance!;
    expect(mismatch.expectedBalance).toBe(expectedBalance);
    expect(mismatch.actualLedgerSum).toBe(expectedBalance + 25);

    // Rolled back: only the seeded stray entry survives, and NO lots were kept.
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger[0]!.entry_type).toBe("earn_order");
    expect(fake.lots).toHaveLength(0);
  });
});

describe("runM1Backfill — mid-way failure aborts with no partial state (Req 14.7)", () => {
  it("rolls back so no partial migration entry or lot is retained when the backfill fails midway", async () => {
    const backup = representativeBackup();
    // The 2nd point_lots INSERT throws — i.e. the backfill fails after the first
    // customer's entry+lot and the second customer's entry were written.
    const fake = makeFakeDb({ throwOnLotInsertCall: 2 });

    await expect(runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) })).rejects.toThrow(
      /mid-way backfill failure/i,
    );

    // The transaction rolled back: nothing persisted (Req 14.7).
    expect(fake.ledger).toHaveLength(0);
    expect(fake.lots).toHaveLength(0);
    expect(fake.customersByShopify.size).toBe(0);
  });
});

describe("runM1Backfill — backfill anomaly aborts (Req 14.7)", () => {
  it("aborts with a backfill error and no partial state for a non-positive enrolled balance", async () => {
    // An enrolled customer whose exported balance is 0 cannot be backfilled: a
    // migration entry must record a positive opening balance.
    const bad = enrolledExport(0, 0, 0);
    const backup = makeBackup([bad, enrolledExport(1, 100)]);
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("aborted_backfill_error");
    if (result.status !== "aborted_backfill_error") return;
    expect(result.detail.shopifyCustomerId).toBe(1000);

    // No partial state.
    expect(fake.ledger).toHaveLength(0);
    expect(fake.lots).toHaveLength(0);
  });
});

describe("runM1Backfill — idempotent re-run (Req 14.4)", () => {
  it("skips creating a second migration entry when one already exists and still reconciles", async () => {
    const backup = makeBackup([enrolledExport(0, 100)]); // one enrolled, balance 150
    const shopifyId = 1000;
    const localId = `cust-${shopifyId}`;
    // Pre-seed the customer already backfilled with the correct migration entry.
    const fake = makeFakeDb({
      seedCustomers: [{ shopifyId, localId }],
      seedLedger: [{ customerId: localId, entryType: "migration", points: 150 }],
    });

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    // No second migration entry, no new lot; the existing entry still reconciles.
    expect(fake.ledger).toHaveLength(1);
    expect(fake.lots).toHaveLength(0);
    expect(result.mismatches).toEqual([]);
  });
});

describe("runM1Backfill — property: clean cohort always backfills 1:1 and reconciles (Req 14.4, 14.6)", () => {
  it("creates one positive migration entry + one non-expiring lot equal to each balance", () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ spend: fc.nat({ max: 5000 }), extra: fc.nat({ max: 500 }) }),
          { minLength: 1, maxLength: 10 },
        ),
        async (cohort) => {
          const enrolled = cohort.map((c, i) => enrolledExport(i, c.spend, 50 + c.spend + c.extra));
          const backup = makeBackup(enrolled);
          const fake = makeFakeDb();

          const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

          expect(result.status).toBe("backfilled");
          if (result.status !== "backfilled") return;

          expect(result.processed).toBe(enrolled.length);
          expect(result.created).toBe(enrolled.length);
          expect(fake.ledger).toHaveLength(enrolled.length);
          expect(fake.lots).toHaveLength(enrolled.length);

          for (const bc of result.customers) {
            const source = enrolled.find((c) => Number(c.id) === bc.shopifyCustomerId)!;
            const balance = source.loyalty.pointsBalance!;
            // migration entry equals balance, positive, non-expiring lot equals balance.
            expect(bc.migrationPoints).toBe(balance);
            expect(bc.tier).toBe(deriveTier(source.lifetimeSpendGBP));
            const entry = fake.ledger.find((e) => e.id === bc.ledgerEntryId)!;
            expect(entry.points).toBe(balance);
            expect(entry.entry_type).toBe("migration");
            const lot = fake.lots.find((l) => l.id === bc.pointLotId)!;
            expect(lot.original_points).toBe(balance);
            expect(lot.remaining_points).toBe(balance);
            expect(lot.expires_at).toBeNull();
          }
          // Reconciliation held for every customer.
          expect(result.mismatches).toEqual([]);
        },
      ),
      { numRuns: 50 },
    );
  });
});
