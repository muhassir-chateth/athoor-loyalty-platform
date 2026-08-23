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
 *   - Req 14.6: reconciliation passes when SUM(ledger) == the MIGRATED integer
 *     points, and ABORTS with no partial state when a sum does not match;
 *   - Req 14.7: a mid-way failure aborts and retains no partial entry/lot;
 *   - the OWNER-APPROVED legacy conversion, exercised against the REAL production
 *     cohort of nine legacy customers (…4995 → 84, …4627 → 50, seven × 50, total
 *     484) so the owner's decisions are encoded and cannot drift. See the block
 *     comment above those tests for the defect they close.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { deriveTier } from "../tier/tier.js";
import {
  deriveRefundedSpendGBP,
  MIGRATION_ENTRY_TYPE,
  MIGRATION_REASON,
  runM1Backfill,
  type M1BackfillOptions,
} from "./m1Backfill.js";
import {
  BACKUP_KIND,
  isEnrolled,
  parseLoyaltyFields,
  type ExportedCustomer,
  type M0Backup,
  type ParsedLoyaltyFields,
  type RawMetafield,
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
        // `spend` is a whole number of pounds so the legacy balance `50 + spend`
        // is already whole and migrates verbatim — this property is about the 1:1
        // structural guarantee, not about the conversion. The conversion has its
        // own property below.
        fc.array(fc.record({ spend: fc.nat({ max: 5000 }) }), { minLength: 1, maxLength: 10 }),
        async (cohort) => {
          const enrolled = cohort.map((c, i) => enrolledExport(i, c.spend, 50 + c.spend));
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
            expect(bc.legacyBalance).toBe(balance);
            expect(bc.rule).toBe("exact");
            expect(bc.refundedPointsRemoved).toBe(0);
            expect(bc.roundingAdjustment).toBe(0);
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

/* ===========================================================================
 * THE OWNER-APPROVED LEGACY CONVERSION, WIRED INTO M1
 * ===========================================================================
 *
 * WHAT WAS WRONG. `requireMigrationBalance` read `customer.loyalty.pointsBalance`
 * and THREW unless it was an integer. Once `parseLoyaltyFields` started parsing
 * numerically (deliberately — a fractional balance must reach review, not vanish),
 * the two real production customers arrived as `83.75` and `55.99`, so M1 aborted
 * on the first fractional customer and NEVER applied the approved conversion. It
 * failed closed, so nothing was corrupted — but the approved values were never
 * written.
 *
 * WHAT IS NOW UNDER TEST, with the REAL production values so the owner's decisions
 * are encoded and cannot drift:
 *
 *   …4995  legacy 83.75, retained £33.75, refunded £0.00  →  84  (rounded_up)
 *   …4627  legacy 55.99, retained £0.00,  refunded £5.99  →  50  (refund_normalised)
 *   the other seven                       legacy 50.0     →  50  (exact)
 *   ------------------------------------------------------------------------
 *   TOTAL ACROSS THE COHORT                                  484 points
 *
 * The refunded component is DERIVED from the backup —
 * `max(0, legacy − 50 − retainedSpend)` — because the legacy formula was
 * `50 + spend`, un-floored and without deducting refunds. Nothing here reaches a
 * database or Shopify: the same in-memory fake used above is the only store.
 * =========================================================================== */

/** Customer …4995 — order #1005, £33.75 paid and RETAINED, legacy balance 83.75. */
const PROD_4995_ID = "11397675974995";
/** Customer …4627 — order #1006, £5.99 paid then FULLY REFUNDED, legacy balance 55.99. */
const PROD_4627_ID = "11487171084627";

/** The seven legacy customers who only ever received the signup bonus (50.0). */
const CLEAN_LEGACY_IDS = [
  "11111111116099",
  "11111111119779",
  "11111111118307",
  "11111111114851",
  "11111111110147",
  "11111111110787",
  "11111111115875",
] as const;

/** The owner-approved cohort total: 7 × 50, + 84, + 50. */
const APPROVED_COHORT_TOTAL_POINTS = 484;

/**
 * Builds a legacy customer exactly as M0 exports one: the five real metafield
 * keys, with `loyalty` derived by the REAL `parseLoyaltyFields`. The parse is not
 * hand-written here on purpose — the fixture must carry whatever M0 actually
 * produces for `"83.75"`, or the test could pass against a parse that no longer
 * exists.
 */
function legacyExport(
  id: string,
  rawBalance: string | null,
  retainedSpendGBP: number,
): ExportedCustomer {
  const metafields: RawMetafield[] = [
    { namespace: "loyalty", key: "points_balance", type: "number_integer", value: rawBalance },
    { namespace: "loyalty", key: "lifetime_points", type: "number_integer", value: rawBalance },
    { namespace: "loyalty", key: "tier", type: "single_line_text_field", value: "Bronze" },
    { namespace: "loyalty", key: "referral_code", type: "single_line_text_field", value: "JEE0787" },
    { namespace: "loyalty", key: "referral_count", type: "number_integer", value: "0" },
  ];
  return {
    id,
    gid: `gid://shopify/Customer/${id}`,
    email: null,
    enrolled: isEnrolled(metafields),
    lifetimeSpendGBP: retainedSpendGBP,
    metafields,
    loyalty: parseLoyaltyFields(metafields),
  };
}

/** The nine REAL legacy customers, plus the 31 bare customers, as M0 exported them. */
function productionLegacyBackup(): M0Backup {
  const legacy = [
    ...CLEAN_LEGACY_IDS.map((id) => legacyExport(id, "50.0", 0)),
    legacyExport(PROD_4995_ID, "83.75", 33.75),
    legacyExport(PROD_4627_ID, "55.99", 0),
  ];
  const bare = Array.from({ length: 31 }, (_v, i) => nonEnrolledExport(i));
  const backup = makeBackup([...legacy, ...bare]);
  // The production cohort as it actually stands: 40 customers, 9 carrying legacy state.
  return { ...backup, totalExpected: 40, enrolledExpected: 9 };
}

/** Finds one backfilled customer by Shopify id (they are keyed numerically). */
function byId(result: Extract<Awaited<ReturnType<typeof runM1Backfill>>, { status: "backfilled" }>, id: string) {
  const found = result.customers.find((c) => c.shopifyCustomerId === Number(id));
  if (!found) throw new Error(`customer ${id} was not backfilled`);
  return found;
}

describe("runM1Backfill — the real legacy cohort migrates at the owner-approved values", () => {
  it("migrates …4995 as 84 points (83.75 rounded UP) and preserves £33.75 lifetime spend", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;

    const c = byId(result, PROD_4995_ID);
    // THE owner decision: 83.75 must NOT become 83, and must NOT stay fractional.
    expect(c.migrationPoints).toBe(84);
    expect(c.legacyBalance).toBe(83.75);
    expect(c.refundedPointsRemoved).toBe(0);
    expect(c.roundingAdjustment).toBe(0.25);
    expect(c.rule).toBe("rounded_up");
    // Lifetime spend is preserved as MONEY and is not affected by the rounding.
    expect(c.lifetimeSpendGBP).toBe(33.75);
    expect(c.tier).toBe(deriveTier(33.75));

    // The ledger entry and the non-expiring lot both carry the integer 84.
    const entry = fake.ledger.find((e) => e.id === c.ledgerEntryId)!;
    expect(entry.points).toBe(84);
    expect(entry.entry_type).toBe(MIGRATION_ENTRY_TYPE);
    const lot = fake.lots.find((l) => l.id === c.pointLotId)!;
    expect(lot.original_points).toBe(84);
    expect(lot.remaining_points).toBe(84);
    expect(lot.expires_at).toBeNull();
  });

  it("migrates …4627 as 50 points by removing the £5.99 refunded component, not by rounding to 56", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;

    const c = byId(result, PROD_4627_ID);
    // THE owner decision: the fraction here is refunded value, so it goes — and
    // 56 (naive rounding up) would migrate points the live engine would claw back.
    expect(c.migrationPoints).toBe(50);
    expect(c.migrationPoints).not.toBe(56);
    expect(c.legacyBalance).toBe(55.99);
    expect(c.refundedPointsRemoved).toBe(5.99);
    expect(c.roundingAdjustment).toBe(0);
    expect(c.rule).toBe("refund_normalised");
    // The order was fully refunded, so no retained spend and no tier credit.
    expect(c.lifetimeSpendGBP).toBe(0);
    // The signup bonus itself survives — only the refunded component was removed.
    expect(c.migrationPoints).toBe(50);
  });

  it("migrates the other seven legacy customers as an exact 50 with no adjustment", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;

    for (const id of CLEAN_LEGACY_IDS) {
      const c = byId(result, id);
      expect(c.migrationPoints).toBe(50);
      expect(c.legacyBalance).toBe(50);
      expect(c.refundedPointsRemoved).toBe(0);
      expect(c.roundingAdjustment).toBe(0);
      expect(c.rule).toBe("exact");
    }
  });

  it("migrates 484 points in total across the nine legacy customers", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;

    expect(result.processed).toBe(9);
    expect(result.created).toBe(9);
    expect(result.nonEnrolledDeferred).toBe(31);

    // The number the owner approved, asserted three independent ways: the result
    // detail, the ledger actually written, and the point lots actually created.
    const fromResult = result.customers.reduce((sum, c) => sum + c.migrationPoints, 0);
    const fromLedger = fake.ledger.reduce((sum, e) => sum + e.points, 0);
    const fromLots = fake.lots.reduce((sum, l) => sum + l.original_points, 0);
    expect(fromResult).toBe(APPROVED_COHORT_TOTAL_POINTS);
    expect(fromLedger).toBe(APPROVED_COHORT_TOTAL_POINTS);
    expect(fromLots).toBe(APPROVED_COHORT_TOTAL_POINTS);

    // And it is NOT the raw legacy sum (7×50 + 83.75 + 55.99 = 489.74), which is
    // what a verbatim migration would have written.
    expect(fromLedger).not.toBeCloseTo(489.74, 2);
    // Every written amount is a whole number of points.
    expect(fake.ledger.every((e) => Number.isInteger(e.points))).toBe(true);
  });

  it("records the audit trail for every customer: legacy value, both adjustments, and the rule", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;

    for (const c of result.customers) {
      // The identity that makes the migration auditable after the fact:
      // legacy − refunded + rounding == what was written.
      const reconstructed = Number(
        (c.legacyBalance - c.refundedPointsRemoved + c.roundingAdjustment).toFixed(2),
      );
      expect(reconstructed).toBe(c.migrationPoints);
      expect(c.conversionNote).toContain(`${c.legacyBalance} → ${c.migrationPoints} points`);
      expect(c.conversionNote).toContain(c.rule);
    }
  });
});

describe("runM1Backfill — reconciliation asserts the MIGRATED points, not the legacy balance (Req 14.6)", () => {
  it("passes for the real cohort, whose ledger sums are the migrated integers", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;
    expect(result.mismatches).toEqual([]);

    // Independent re-derivation of the reconciliation from the fake's own rows:
    // SUM(ledger) per customer must equal the MIGRATED integer, and for …4995 it
    // is 84 — deliberately NOT the exported legacy 83.75 the old check used.
    for (const c of result.customers) {
      const sum = fake.ledger
        .filter((e) => e.customer_id === c.customerId)
        .reduce((acc, e) => acc + e.points, 0);
      expect(sum).toBe(c.migrationPoints);
    }
    const fourNineNineFive = byId(result, PROD_4995_ID);
    const sum4995 = fake.ledger
      .filter((e) => e.customer_id === fourNineNineFive.customerId)
      .reduce((acc, e) => acc + e.points, 0);
    expect(sum4995).toBe(84);
    expect(sum4995).not.toBe(83.75);
  });

  it("reports the mismatch against the migrated integer AND carries the legacy value", async () => {
    const backup = productionLegacyBackup();
    // A stray pre-existing entry for …4995 makes its SUM 84 + 7, so reconciliation
    // must abort — and the report must name 84 (what was written), with 83.75
    // present as context rather than as the expectation.
    const localId = `cust-${PROD_4995_ID}`;
    const fake = makeFakeDb({
      seedCustomers: [{ shopifyId: Number(PROD_4995_ID), localId }],
      seedLedger: [{ customerId: localId, entryType: "earn_order", points: 7 }],
    });

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("aborted_reconciliation_mismatch");
    if (result.status !== "aborted_reconciliation_mismatch") return;

    expect(result.mismatches).toHaveLength(1);
    const mismatch = result.mismatches[0]!;
    expect(mismatch.shopifyCustomerId).toBe(Number(PROD_4995_ID));
    expect(mismatch.expectedBalance).toBe(84);
    expect(mismatch.legacyBalance).toBe(83.75);
    expect(mismatch.actualLedgerSum).toBe(91);

    // Rolled back: only the seeded stray entry survives, no lots at all.
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger[0]!.entry_type).toBe("earn_order");
    expect(fake.lots).toHaveLength(0);
  });
});

describe("runM1Backfill — M1 never awards a signup bonus", () => {
  it("writes only `migration` entries for the real cohort — never `earn_signup`", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("backfilled");
    if (result.status !== "backfilled") return;

    // The 50-point signup bonus is ALREADY inside every legacy balance
    // (`50 + spend`). Awarding it again here would double it, so the only entry
    // type M1 may ever write is `migration`.
    expect(fake.ledger).toHaveLength(9);
    expect(fake.ledger.some((e) => e.entry_type === "earn_signup")).toBe(false);
    expect(new Set(fake.ledger.map((e) => e.entry_type))).toEqual(new Set([MIGRATION_ENTRY_TYPE]));
    expect(new Set(fake.ledger.map((e) => e.reason))).toEqual(new Set([MIGRATION_REASON]));
    // Exactly one entry and one lot per customer — no extra award rode along.
    expect(fake.lots).toHaveLength(9);
  });

  it("still awards nothing extra on a re-run", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });
    await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(fake.ledger.some((e) => e.entry_type === "earn_signup")).toBe(false);
    expect(fake.ledger).toHaveLength(9);
  });
});

describe("runM1Backfill — idempotent re-run of the real cohort (Req 14.4)", () => {
  it("creates nothing new on a second run: created 0, skipped 9, same 484 points", async () => {
    const backup = productionLegacyBackup();
    const fake = makeFakeDb();

    const first = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });
    expect(first.status).toBe("backfilled");
    if (first.status !== "backfilled") return;
    expect(first.created).toBe(9);
    expect(first.skipped).toBe(0);

    const second = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });
    expect(second.status).toBe("backfilled");
    if (second.status !== "backfilled") return;

    // The idempotency guard is the pre-existing `migration` entry, so a re-run
    // skips the whole cohort rather than doubling it.
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(9);
    expect(second.processed).toBe(9);
    expect(second.mismatches).toEqual([]);

    // Nothing new was written, and the ledger still totals the approved 484.
    expect(fake.ledger).toHaveLength(9);
    expect(fake.lots).toHaveLength(9);
    expect(fake.ledger.reduce((sum, e) => sum + e.points, 0)).toBe(APPROVED_COHORT_TOTAL_POINTS);

    // The skipped records still report the resolved values, so a re-run's output
    // is still a complete audit record rather than a blank.
    expect(byId(second, PROD_4995_ID).migrationPoints).toBe(84);
    expect(byId(second, PROD_4995_ID).rule).toBe("rounded_up");
    expect(byId(second, PROD_4627_ID).migrationPoints).toBe(50);
    expect(byId(second, PROD_4627_ID).rule).toBe("refund_normalised");
    expect(byId(second, PROD_4995_ID).ledgerEntryId).toBeNull();
    expect(byId(second, PROD_4995_ID).pointLotId).toBeNull();
  });
});

describe("runM1Backfill — a conversion refusal aborts the whole migration (Req 14.7)", () => {
  it("aborts with `aborted_backfill_error` and leaves no partial state for an incoherent legacy balance", async () => {
    // A negative legacy balance has never been observed in production. The
    // approved rules REFUSE it rather than guessing, because migrating it would
    // encode a misunderstanding of the legacy data. Placed SECOND so the first
    // customer's entry + lot are already written when the refusal fires — which
    // is what proves the rollback is cohort-wide, not per customer.
    const backup = makeBackup([
      legacyExport(CLEAN_LEGACY_IDS[0], "50.0", 0),
      legacyExport("11111111112222", "-5", 0),
      legacyExport(PROD_4995_ID, "83.75", 33.75),
    ]);
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("aborted_backfill_error");
    if (result.status !== "aborted_backfill_error") return;

    expect(result.detail.shopifyCustomerId).toBe(11111111112222);
    expect(result.detail.reason).toMatch(/cannot be migrated/i);
    expect(result.detail.reason).toMatch(/negative/i);

    // No partial state: not even the first customer's entry/lot survived, and no
    // customers row was retained (Req 14.7).
    expect(fake.ledger).toHaveLength(0);
    expect(fake.lots).toHaveLength(0);
    expect(fake.customersByShopify.size).toBe(0);
  });

  it("aborts rather than assuming a balance when the legacy value is absent", async () => {
    const backup = makeBackup([legacyExport(CLEAN_LEGACY_IDS[0], null, 0)]);
    const fake = makeFakeDb();

    const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

    expect(result.status).toBe("aborted_backfill_error");
    if (result.status !== "aborted_backfill_error") return;
    expect(result.detail.reason).toMatch(/no usable numeric points balance/i);
    expect(fake.ledger).toHaveLength(0);
    expect(fake.lots).toHaveLength(0);
  });
});

describe("deriveRefundedSpendGBP — the refunded component is derived, never guessed", () => {
  it("derives £0.00 refunded for …4995, whose £33.75 was retained", () => {
    expect(deriveRefundedSpendGBP(83.75, 33.75)).toBe(0);
  });

  it("derives £5.99 refunded for …4627, whose only order was fully refunded", () => {
    // 55.99 − 50 − 0.00 = 5.99, and NOT 5.990000000000002: an audit figure must
    // read as pence.
    expect(deriveRefundedSpendGBP(55.99, 0)).toBe(5.99);
  });

  it("derives nothing for the seven clean 50.0 customers", () => {
    expect(deriveRefundedSpendGBP(50, 0)).toBe(0);
  });

  it("floors at zero rather than reinterpreting a shortfall as a refund", () => {
    // A balance BELOW `50 + spend` is a different anomaly; it must reach the
    // resolver as "nothing refunded" and be judged on its own terms.
    expect(deriveRefundedSpendGBP(40, 100)).toBe(0);
  });
});

describe("runM1Backfill — property: the conversion never loses retained value and never keeps refunded value", () => {
  it("migrates ceil(50 + retained) and removes exactly the refunded component", () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            // Pence, so the generated legacy balances are fractional like the real ones.
            retainedPence: fc.nat({ max: 500_000 }),
            refundedPence: fc.nat({ max: 50_000 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (cohort) => {
          const customers = cohort.map((c, i) => {
            const retained = Number((c.retainedPence / 100).toFixed(2));
            const refunded = Number((c.refundedPence / 100).toFixed(2));
            // The legacy formula: `50 + spend`, un-floored and WITHOUT deducting
            // the refund — which is exactly how these fractions came to exist.
            const legacy = Number((50 + retained + refunded).toFixed(2));
            return {
              customer: legacyExport(String(11_000_000_000_000 + i), String(legacy), retained),
              retained,
              refunded,
            };
          });
          const backup = makeBackup(customers.map((c) => c.customer));
          const fake = makeFakeDb();

          const result = await runM1Backfill({ backup, now: FIXED_NOW, ...makeDeps(fake) });

          expect(result.status).toBe("backfilled");
          if (result.status !== "backfilled") return;

          for (const { customer, retained, refunded } of customers) {
            const bc = byId(result, customer.id);
            // Independent oracle: refunded value goes, retained value is kept and
            // any remaining fraction is rounded UP — never down.
            const expected = Math.ceil(Number((50 + retained).toFixed(2)));
            expect(bc.migrationPoints).toBe(expected);
            expect(bc.refundedPointsRemoved).toBe(refunded);
            // Migration never reduces retained value...
            expect(bc.migrationPoints).toBeGreaterThanOrEqual(50 + retained);
            // ...and never keeps refunded value.
            expect(bc.migrationPoints).toBeLessThan(50 + retained + 1);
            expect(Number.isInteger(bc.migrationPoints)).toBe(true);
            // The ledger holds exactly what was resolved.
            const entry = fake.ledger.find((e) => e.id === bc.ledgerEntryId)!;
            expect(entry.points).toBe(expected);
            expect(entry.entry_type).toBe(MIGRATION_ENTRY_TYPE);
          }
          expect(result.mismatches).toEqual([]);
        },
      ),
      { numRuns: 50 },
    );
  });
});
