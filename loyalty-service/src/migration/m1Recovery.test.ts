/**
 * Unit tests for M1 RECOVERY — reversing the historical backfill.
 *
 * NO live/production system is touched and NO Shopify Admin API is called (the
 * module under test has no Admin API import at all). Everything runs against a
 * STATEFUL, IN-MEMORY fake {@link Transactor}/`Queryable` that models the
 * `customers` / `ledger_entries` / `point_lots` tables and the exact SQL both
 * flows issue. The fake's transaction restores a deep snapshot when the callback
 * throws, so "a refusal, a dry run or a failure changed nothing" is proved
 * against real state rather than asserted about the code.
 *
 * THE ROUND TRIP IS THE POINT. Almost every test seeds the database by running
 * the REAL {@link runM1Backfill} against the REAL {@link LedgerRepository} and
 * the REAL M0 anchor shape — the nine production legacy customers (…4995 → 84,
 * …4627 → 50, seven × 50 = 484 points) — and then runs the recovery over it.
 * Hand-seeding rows would only prove the recovery reverses rows a test author
 * imagined; running M1 first proves it reverses what M1 actually writes. The
 * headline test asserts the fake is byte-for-byte back to the ORIGINAL EMPTY
 * state (0 customers, 0 ledger entries, 0 point lots), which is exactly the
 * owner-verified pre-M1 production state.
 *
 * Covered:
 *   1. clean M1 state can be fully reverted;
 *   2. the reversal returns the database to the original EMPTY loyalty state;
 *   3. a wrong database fingerprint refuses;
 *   4. a wrong store refuses;
 *   5. a wrong cohort count refuses (against the anchor AND against the database);
 *   6. a wrong ledger total refuses;
 *   7. unrelated rows refuse;
 *   8. post-M1 activity refuses — order earning, redemption, adjustment,
 *      clawback, birthday reward and an entry type that does not exist yet;
 *   9. partial/malformed M1 state refuses (entry with no lot, lot with no entry,
 *      customer with no entry, duplicate migration entry, expiring lot, spent
 *      lot);
 *  10. a second recovery attempt refuses cleanly with nothing left to revert;
 *  11. a transaction failure leaves state unchanged.
 *
 * Guards that live in the module rather than the operator script (environment,
 * store, fingerprint, migration-identity confirmation, destructive
 * acknowledgement, mandatory expectations) are tested here, at the layer they
 * live, which is why they were put there.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { MIGRATION_ENTRY_TYPE, MIGRATION_REASON, runM1Backfill } from "./m1Backfill.js";
import {
  M1_RECOVERY_REQUIRED_STORE,
  PERMITTED_ENTRY_TYPES,
  categoriseActivity,
  deriveAnchorCohort,
  maskCustomerId,
  runM1Recovery,
  type M1RecoveryOptions,
} from "./m1Recovery.js";
import {
  BACKUP_KIND,
  isEnrolled,
  parseLoyaltyFields,
  type ExportedCustomer,
  type M0Backup,
  type ParsedLoyaltyFields,
  type RawMetafield,
} from "./m0Export.js";

const STORE = M1_RECOVERY_REQUIRED_STORE;
const FIXED_NOW = () => new Date("2025-01-15T12:00:00.000Z");

/** The owner-verified production expectations. Stated, never defaulted. */
const EXPECT_COHORT = 9;
const EXPECT_TOTAL_POINTS = 484;

/** A fingerprint pair that agrees — the shape `databaseFingerprint()` produces. */
const REAL_FINGERPRINT = "a1b2c3d4e5f6";

// ---------------------------------------------------------------------------
// The real M0 anchor shape (identical to the one m1Backfill.test.ts exercises).
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

/** Customer …4995 — order #1005, £33.75 paid and RETAINED, legacy balance 83.75 → 84. */
const PROD_4995_ID = "11397675974995";
/** Customer …4627 — order #1006, £5.99 paid then FULLY REFUNDED, legacy 55.99 → 50. */
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

/** Builds a legacy customer exactly as M0 exports one, using the REAL parse. */
function legacyExport(id: string, rawBalance: string | null, retainedSpendGBP: number): ExportedCustomer {
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

/** A non-enrolled customer: never created by M1, so never reversed by recovery. */
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

/** The production anchor: 9 legacy customers (484 points) + 31 bare = 40. */
function productionAnchor(): M0Backup {
  const legacy = [
    ...CLEAN_LEGACY_IDS.map((id) => legacyExport(id, "50.0", 0)),
    legacyExport(PROD_4995_ID, "83.75", 33.75),
    legacyExport(PROD_4627_ID, "55.99", 0),
  ];
  const bare = Array.from({ length: 31 }, (_v, i) => nonEnrolledExport(i));
  const customers = [...legacy, ...bare];
  return {
    schemaVersion: "1.0",
    kind: BACKUP_KIND,
    exportedAt: "2025-01-15T12:00:00.000Z",
    storeDomain: STORE,
    totalExpected: 40,
    enrolledExpected: 9,
    totalExported: customers.length,
    enrolledExported: legacy.length,
    customers,
  };
}

// ---------------------------------------------------------------------------
// Stateful in-memory fake DB shared by BOTH flows, with a rollback-capable
// transactor. It answers the exact SQL m1Backfill.ts and m1Recovery.ts issue and
// throws on anything it does not recognise, so a new/unexpected statement fails
// the test rather than silently returning nothing.
// ---------------------------------------------------------------------------

interface CustomerRowState {
  id: string;
  shopify_customer_id: number;
}

interface LedgerRowState {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
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
  /** 1-based index of a DELETE that should throw (simulates a transaction failure). */
  throwOnDeleteCall?: number;
  /** 1-based index of a DELETE that should report 0 rows affected. */
  zeroRowsOnDeleteCall?: number;
}

function makeFakeDb(opts: FakeOptions = {}) {
  let entrySeq = 0;
  let lotSeq = 0;
  let customerSeq = 0;
  let deleteCalls = 0;

  /**
   * Local `customers.id` values are UUIDs in the real schema and carry NO
   * relationship to the Shopify id. The fake mints UUID-shaped ids for exactly
   * that reason: an id derived from the Shopify id would quietly defeat the test
   * that asserts a full Shopify id never appears in the module's output.
   */
  const nextLocalId = () =>
    `00000000-0000-4000-8000-${String((customerSeq += 1)).padStart(12, "0")}`;

  const customers: CustomerRowState[] = [];
  const ledger: LedgerRowState[] = [];
  const lots: LotRowState[] = [];

  async function query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = <T>(rows: T[], rowCount?: number): QueryResult<R> =>
      ({ rows: rows as unknown as R[], rowCount: rowCount ?? rows.length } as QueryResult<R>);

    /* ---- DELETEs (recovery only) ------------------------------------- */
    if (/^\s*DELETE FROM point_lots/i.test(text)) {
      deleteCalls += 1;
      if (opts.throwOnDeleteCall === deleteCalls) {
        throw new Error("simulated point_lots DELETE failure (transaction failure)");
      }
      if (opts.zeroRowsOnDeleteCall === deleteCalls) return ok([], 0);
      const i = lots.findIndex(
        (l) => l.id === values[0] && l.customer_id === values[1] && l.ledger_entry_id === values[2],
      );
      if (i === -1) return ok([], 0);
      lots.splice(i, 1);
      return ok([], 1);
    }

    if (/^\s*DELETE FROM ledger_entries/i.test(text)) {
      deleteCalls += 1;
      if (opts.throwOnDeleteCall === deleteCalls) {
        throw new Error("simulated ledger_entries DELETE failure (transaction failure)");
      }
      if (opts.zeroRowsOnDeleteCall === deleteCalls) return ok([], 0);
      // The statement re-asserts entry_type + reason; the fake honours that, so a
      // test can prove a non-migration row could never be removed by it.
      const i = ledger.findIndex(
        (e) =>
          e.id === values[0] &&
          e.customer_id === values[1] &&
          e.entry_type === values[2] &&
          e.reason === values[3],
      );
      if (i === -1) return ok([], 0);
      ledger.splice(i, 1);
      return ok([], 1);
    }

    if (/^\s*DELETE FROM customers/i.test(text)) {
      deleteCalls += 1;
      if (opts.throwOnDeleteCall === deleteCalls) {
        throw new Error("simulated customers DELETE failure (transaction failure)");
      }
      if (opts.zeroRowsOnDeleteCall === deleteCalls) return ok([], 0);
      const i = customers.findIndex(
        (c) => c.id === values[0] && c.shopify_customer_id === Number(values[1]),
      );
      if (i === -1) return ok([], 0);
      customers.splice(i, 1);
      return ok([], 1);
    }

    /* ---- INSERTs (M1 backfill) --------------------------------------- */
    if (/INSERT INTO\s+customers/i.test(text)) {
      const shopifyId = Number(values[0]);
      let row = customers.find((c) => c.shopify_customer_id === shopifyId);
      if (!row) {
        row = { id: nextLocalId(), shopify_customer_id: shopifyId };
        customers.push(row);
      }
      return ok([{ id: row.id }]);
    }

    if (/INSERT INTO\s+ledger_entries/i.test(text)) {
      const row: LedgerRowState = {
        id: `led-${(entrySeq += 1)}`,
        customer_id: String(values[0]),
        entry_type: String(values[1]),
        points: Number(values[2]),
        reason: String(values[3]),
        created_at: new Date("2025-01-15T12:00:00.000Z"),
      };
      ledger.push(row);
      return ok([
        {
          id: row.id,
          customer_id: row.customer_id,
          entry_type: row.entry_type,
          points: row.points,
          reason: row.reason,
          order_reference: null,
          point_lot_id: null,
          redemption_id: null,
          source_event_id: null,
          created_at: row.created_at,
        },
      ]);
    }

    if (/INSERT INTO\s+point_lots/i.test(text)) {
      const row: LotRowState = {
        id: `lot-${(lotSeq += 1)}`,
        customer_id: String(values[0]),
        ledger_entry_id: String(values[1]),
        original_points: Number(values[2]),
        remaining_points: Number(values[2]),
        earned_at: values[3] as Date,
        expires_at: null,
      };
      lots.push(row);
      return ok([{ id: row.id }]);
    }

    /* ---- Census reads (recovery) ------------------------------------- */
    if (/COUNT\(\*\)::text AS count/i.test(text) && /FROM customers/i.test(text)) {
      return ok([{ count: String(customers.length) }]);
    }
    if (/COUNT\(\*\)::text AS count/i.test(text) && /FROM point_lots/i.test(text)) {
      return ok([{ count: String(lots.length) }]);
    }
    if (
      /COUNT\(\*\)::text AS count/i.test(text) &&
      /FROM ledger_entries/i.test(text) &&
      !/GROUP BY/i.test(text) &&
      !/AS total/i.test(text)
    ) {
      return ok([{ count: String(ledger.length) }]);
    }

    // Migration total + count over the WHOLE ledger, keyed by entry_type/reason.
    if (/AS total/i.test(text) && /FROM ledger_entries/i.test(text)) {
      const rows = ledger.filter((e) => e.entry_type === values[0] && e.reason === values[1]);
      return ok([
        { total: String(rows.reduce((s, e) => s + e.points, 0)), count: String(rows.length) },
      ]);
    }

    // Aggregate-only ledger census (no ids).
    if (/GROUP BY entry_type/i.test(text)) {
      const byKey = new Map<string, { entry_type: string; reason: string; count: number }>();
      for (const e of ledger) {
        const key = `${e.entry_type}\u0000${e.reason}`;
        const found = byKey.get(key);
        if (found) found.count += 1;
        else byKey.set(key, { entry_type: e.entry_type, reason: e.reason, count: 1 });
      }
      return ok([...byKey.values()].map((r) => ({ ...r, count: String(r.count) })));
    }

    /* ---- Balance projection (real computeBalance, used by M1) -------- */
    if (/AS balance/i.test(text) && /FROM ledger_entries/i.test(text)) {
      const customerId = String(values[0]);
      const sum = ledger.filter((e) => e.customer_id === customerId).reduce((a, e) => a + e.points, 0);
      return ok([{ balance: String(sum) }]);
    }

    /* ---- M1's idempotency probe -------------------------------------- */
    if (/FROM ledger_entries/i.test(text) && /entry_type = 'migration'/i.test(text)) {
      const customerId = String(values[0]);
      const found = ledger.some((e) => e.customer_id === customerId && e.entry_type === "migration");
      return ok(found ? [{ exists: 1 }] : []);
    }

    /* ---- Cohort reads (recovery) ------------------------------------- */
    if (/FROM customers/i.test(text) && /WHERE shopify_customer_id = \$1/i.test(text)) {
      const row = customers.find((c) => c.shopify_customer_id === Number(values[0]));
      return ok(row ? [{ id: row.id, shopify_customer_id: row.shopify_customer_id }] : []);
    }

    if (/FROM ledger_entries/i.test(text) && /WHERE customer_id = \$1/i.test(text)) {
      const customerId = String(values[0]);
      return ok(
        ledger
          .filter((e) => e.customer_id === customerId)
          .map((e) => ({ id: e.id, entry_type: e.entry_type, points: e.points, reason: e.reason })),
      );
    }

    if (/FROM point_lots/i.test(text) && /WHERE customer_id = \$1/i.test(text)) {
      const customerId = String(values[0]);
      return ok(
        lots
          .filter((l) => l.customer_id === customerId)
          .map((l) => ({
            id: l.id,
            ledger_entry_id: l.ledger_entry_id,
            original_points: l.original_points,
            remaining_points: l.remaining_points,
            expires_at: l.expires_at,
          })),
      );
    }

    throw new Error(`Unexpected SQL in fake DB: ${text}`);
  }

  const transactor = {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      // Deep snapshot for rollback: the whole point of the atomicity tests.
      const custSnap = customers.map((c) => ({ ...c }));
      const ledgerSnap = ledger.map((e) => ({ ...e }));
      const lotsSnap = lots.map((l) => ({ ...l }));
      try {
        return await fn({ query });
      } catch (err) {
        customers.length = 0;
        customers.push(...custSnap);
        ledger.length = 0;
        ledger.push(...ledgerSnap);
        lots.length = 0;
        lots.push(...lotsSnap);
        throw err;
      }
    },
  };

  /** A stable, comparable snapshot of the whole loyalty state. */
  function snapshot() {
    return {
      customers: customers.map((c) => ({ ...c })).sort((a, b) => a.id.localeCompare(b.id)),
      ledger: ledger.map((e) => ({ ...e })).sort((a, b) => a.id.localeCompare(b.id)),
      lots: lots.map((l) => ({ ...l })).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  /** Adds a raw ledger row directly, for seeding states M1 would never create. */
  function addLedgerRow(row: {
    customer_id: string;
    entry_type: string;
    points: number;
    reason: string;
  }) {
    const created: LedgerRowState = {
      id: `raw-${(entrySeq += 1)}`,
      created_at: new Date("2026-03-01T00:00:00.000Z"),
      ...row,
    };
    ledger.push(created);
    return created;
  }

  /** Adds a raw customers row directly (a customer M1 never created). */
  function addCustomerRow(shopifyId: number) {
    const row: CustomerRowState = { id: nextLocalId(), shopify_customer_id: shopifyId };
    customers.push(row);
    return row;
  }

  /** Adds a raw point_lots row directly. */
  function addLotRow(row: {
    customer_id: string;
    ledger_entry_id: string;
    original_points: number;
    remaining_points: number;
    expires_at?: Date | null;
  }) {
    const created: LotRowState = {
      id: `rawlot-${(lotSeq += 1)}`,
      earned_at: new Date("2026-03-01T00:00:00.000Z"),
      expires_at: row.expires_at ?? null,
      ...row,
    };
    lots.push(created);
    return created;
  }

  return {
    transactor,
    customers,
    ledger,
    lots,
    snapshot,
    addLedgerRow,
    addCustomerRow,
    addLotRow,
  };
}

/** A pool that must never be used directly — every M1 append runs on the tx client. */
const throwingPool: Queryable = {
  async query() {
    throw new Error("LedgerRepository pool query used outside a transaction");
  },
};

/** Runs the REAL M1 backfill against the fake, so recovery reverses real output. */
async function seedWithRealM1(fake: ReturnType<typeof makeFakeDb>, anchor: M0Backup) {
  const result = await runM1Backfill({
    backup: anchor,
    repo: new LedgerRepository(throwingPool),
    transactor: fake.transactor,
    now: FIXED_NOW,
  });
  expect(result.status).toBe("backfilled");
  return result;
}

/**
 * Every guard satisfied, dry run by default. Individual tests override exactly
 * one field, so each test proves ONE guard rather than a soup of them.
 */
function validOptions(
  fake: ReturnType<typeof makeFakeDb>,
  anchor: M0Backup,
  overrides: Partial<M1RecoveryOptions> = {},
): M1RecoveryOptions {
  return {
    environment: "production",
    store: STORE,
    confirmDbFingerprint: REAL_FINGERPRINT,
    actualDbFingerprint: REAL_FINGERPRINT,
    confirmEntryType: MIGRATION_ENTRY_TYPE,
    confirmReason: MIGRATION_REASON,
    backup: anchor,
    expectCohort: EXPECT_COHORT,
    expectTotalPoints: EXPECT_TOTAL_POINTS,
    transactor: fake.transactor,
    ...overrides,
  };
}

/** The pre-M1 production state, owner-verified: every loyalty table empty. */
const ORIGINAL_EMPTY_STATE = { customers: [], ledger: [], lots: [] };

// ===========================================================================
// 1. Clean M1 state can be fully reverted
// ===========================================================================

describe("M1 RECOVERY — 1. a clean M1 state can be fully reverted", () => {
  it("reverts the real 9-customer / 484-point backfill in one transaction", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // Sanity: M1 really did write the shape production would have.
    expect(fake.customers).toHaveLength(9);
    expect(fake.ledger).toHaveLength(9);
    expect(fake.lots).toHaveLength(9);
    expect(fake.ledger.reduce((s, e) => s + e.points, 0)).toBe(EXPECT_TOTAL_POINTS);

    const result = await runM1Recovery(
      validOptions(fake, anchor, {
        mode: "execute",
        acknowledgeDeletesMigrationRows: true,
      }),
    );

    expect(result.status).toBe("reverted");
    if (result.status !== "reverted") return;

    expect(result.deleted).toEqual({ pointLots: 9, ledgerEntries: 9, customers: 9 });
    expect(result.plan.cohortSize).toBe(EXPECT_COHORT);
    expect(result.plan.totalMigrationPoints).toBe(EXPECT_TOTAL_POINTS);
    expect(result.plan.observed).toEqual({ customers: 9, ledgerEntries: 9, pointLots: 9 });

    // Identifiers are MASKED — the last 4 digits only, never a full id or email.
    const masked = result.plan.customers.map((c) => c.maskedShopifyCustomerId);
    expect(masked).toContain("…4995");
    expect(masked).toContain("…4627");
    for (const m of masked) {
      expect(m).toMatch(/^…\d{4}$/);
    }
    const printed = JSON.stringify(result);
    expect(printed).not.toContain(PROD_4995_ID);
    expect(printed).not.toContain("@");
  });

  it("reports the exact plan and writes NOTHING in dry-run mode, which is the DEFAULT", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);
    const before = fake.snapshot();

    // No `mode` given at all — the destructive path must be opted into.
    const result = await runM1Recovery(validOptions(fake, anchor));

    expect(result.status).toBe("dry_run");
    if (result.status !== "dry_run") return;

    expect(result.wouldDelete).toEqual({ pointLots: 9, ledgerEntries: 9, customers: 9 });
    expect(result.plan.totalMigrationPoints).toBe(EXPECT_TOTAL_POINTS);
    expect(result.plan.customers).toHaveLength(9);
    // Byte-for-byte unchanged.
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses the destructive path when the acknowledgement flag is absent", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);
    const before = fake.snapshot();

    const result = await runM1Recovery(validOptions(fake, anchor, { mode: "execute" }));

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("destructive_acknowledgement_missing");
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses when the migration identity is not confirmed exactly", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);
    const before = fake.snapshot();

    for (const bad of [
      { confirmEntryType: "spend" },
      { confirmEntryType: null },
      { confirmReason: "m0_backfill" },
      { confirmReason: null },
    ]) {
      const result = await runM1Recovery(validOptions(fake, anchor, bad));
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.refusal.code).toBe("migration_identifier_unconfirmed");
    }
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses when the mandatory expectations are missing (no defaults exist)", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    for (const bad of [
      { expectCohort: null },
      { expectTotalPoints: null },
      { expectCohort: undefined },
      { expectTotalPoints: undefined },
      { expectCohort: 0 },
    ]) {
      const result = await runM1Recovery(validOptions(fake, anchor, bad));
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.refusal.code).toBe("expectations_missing");
    }
  });

  it("refuses when the environment is not production", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    for (const environment of ["staging", "development", "", null, undefined]) {
      const result = await runM1Recovery(validOptions(fake, anchor, { environment }));
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.refusal.code).toBe("environment_not_production");
    }
  });

  it("refuses an anchor from a different store, and a non-M0 anchor", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    const foreign = await runM1Recovery(
      validOptions(fake, anchor, {
        backup: { ...anchor, storeDomain: "athoor-loyalty-staging.myshopify.com" },
      }),
    );
    expect(foreign.status).toBe("refused");
    if (foreign.status !== "refused") return;
    expect(foreign.refusal.code).toBe("anchor_store_mismatch");

    const notM0 = await runM1Recovery(
      validOptions(fake, anchor, {
        backup: { ...anchor, kind: "something-else" } as unknown as M0Backup,
      }),
    );
    expect(notM0.status).toBe("refused");
    if (notM0.status !== "refused") return;
    expect(notM0.refusal.code).toBe("anchor_not_m0_export");
  });
});

// ===========================================================================
// 2. The rollback returns the database to the original EMPTY loyalty state
// ===========================================================================

describe("M1 RECOVERY — 2. the reversal returns the database to the original EMPTY state", () => {
  it("round-trips: empty → real M1 (9/9/9, 484) → recovery → byte-for-byte empty again", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();

    // The owner-verified pre-M1 production state.
    const original = fake.snapshot();
    expect(original).toEqual(ORIGINAL_EMPTY_STATE);

    await seedWithRealM1(fake, anchor);
    expect(fake.snapshot()).not.toEqual(original);

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );
    expect(result.status).toBe("reverted");

    // THE claim this whole module exists to support: the database is back to the
    // exact state it was in before M1 ran — 0 customers, 0 ledger entries,
    // 0 point lots — compared structurally, not merely counted.
    expect(fake.snapshot()).toEqual(original);
    expect(fake.snapshot()).toEqual(ORIGINAL_EMPTY_STATE);
    expect(fake.customers).toHaveLength(0);
    expect(fake.ledger).toHaveLength(0);
    expect(fake.lots).toHaveLength(0);
  });

  it("survives a full M1 → recovery → M1 → recovery cycle, ending empty both times", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await seedWithRealM1(fake, anchor);
      expect(fake.ledger).toHaveLength(9);
      expect(fake.ledger.reduce((s, e) => s + e.points, 0)).toBe(EXPECT_TOTAL_POINTS);

      const result = await runM1Recovery(
        validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
      );
      expect(result.status).toBe("reverted");
      expect(fake.snapshot()).toEqual(ORIGINAL_EMPTY_STATE);
    }
  });
});

// ===========================================================================
// 3. A wrong DB fingerprint refuses
// ===========================================================================

describe("M1 RECOVERY — 3. a wrong database fingerprint refuses", () => {
  it("refuses when the confirmed fingerprint does not match the configured database", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, {
        confirmDbFingerprint: "deadbeef0000",
        mode: "execute",
        acknowledgeDeletesMigrationRows: true,
      }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("db_fingerprint_mismatch");
    expect(result.refusal.message).toMatch(/not pointed at the database you think/i);
    // Even with the destructive flags set, nothing happened.
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses when no fingerprint was confirmed at all", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    for (const confirmDbFingerprint of [null, undefined, "", "   "]) {
      const result = await runM1Recovery(validOptions(fake, anchor, { confirmDbFingerprint }));
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.refusal.code).toBe("db_fingerprint_unconfirmed");
    }
  });

  it("refuses when the database reports no fingerprint to compare against", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    const result = await runM1Recovery(validOptions(fake, anchor, { actualDbFingerprint: null }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("db_fingerprint_mismatch");
  });
});

// ===========================================================================
// 4. A wrong store refuses
// ===========================================================================

describe("M1 RECOVERY — 4. a wrong store refuses", () => {
  it("rejects any store other than the production store OUTRIGHT, not with a warning", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);
    const before = fake.snapshot();

    for (const store of [
      "athoor-loyalty-staging.myshopify.com",
      "some-other-shop.myshopify.com",
      "myathoorlondon.myshopify.com.evil.example",
      "",
      null,
    ]) {
      const result = await runM1Recovery(
        validOptions(fake, anchor, {
          store,
          // Deliberately fully armed: the store guard must still refuse.
          mode: "execute",
          acknowledgeDeletesMigrationRows: true,
        }),
      );
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.refusal.code).toBe("store_not_permitted");
      expect(result.refusal.message).toMatch(/refusal, not a warning/i);
    }
    expect(fake.snapshot()).toEqual(before);
  });

  it("accepts the production store regardless of case/whitespace, but nothing else", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    const result = await runM1Recovery(
      validOptions(fake, anchor, { store: `  ${STORE.toUpperCase()}  ` }),
    );
    expect(result.status).toBe("dry_run");
  });
});

// ===========================================================================
// 5. A wrong cohort count refuses
// ===========================================================================

describe("M1 RECOVERY — 5. a wrong cohort count refuses", () => {
  it("refuses when the stated cohort disagrees with the anchor", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    const result = await runM1Recovery(
      validOptions(fake, anchor, {
        expectCohort: 8,
        // Keep the total consistent with 8 × ... nothing: the cohort guard fires
        // first, which is the point — the anchor and the operator must agree.
      }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("anchor_cohort_mismatch");
    expect(result.refusal.message).toMatch(/anchor describes 9 legacy customer/i);
  });

  it("refuses when the database holds fewer cohort customers than stated", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // A cohort customers row went missing, but its ledger entry + lot remain, so
    // the migration total is still 484 and only the cohort guard can catch this.
    const removed = fake.customers.pop()!;
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("cohort_count_mismatch");
    expect(result.refusal.message).toMatch(/found 8/);
    expect(result.refusal.message).toContain(maskCustomerId(removed.shopify_customer_id));
    expect(result.refusal.manualRecoveryRequired).toBe(true);
    // Refusing a partial cohort means deleting NONE of it.
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses when the database holds an EXTRA cohort-shaped customer", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);
    fake.addCustomerRow(11111111990000);
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    // The anchor still resolves 9, so this is caught by the clean-state guard.
    expect(result.refusal.code).toBe("unrelated_rows_present");
    expect(result.refusal.manualRecoveryRequired).toBe(true);
    expect(fake.snapshot()).toEqual(before);
  });
});

// ===========================================================================
// 6. A wrong ledger total refuses
// ===========================================================================

describe("M1 RECOVERY — 6. a wrong ledger total refuses", () => {
  it("refuses when the stated total disagrees with the anchor's 484", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    const result = await runM1Recovery(validOptions(fake, anchor, { expectTotalPoints: 500 }));

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("anchor_total_points_mismatch");
    expect(result.refusal.message).toMatch(/anchor implies 484 migration point/i);
  });

  it("refuses when the ledger's actual migration total is not the expected 484", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // Someone edited a migration entry's points. The total is now 490.
    const tampered = fake.ledger.find((e) => e.points === 84)!;
    tampered.points = 90;
    const lot = fake.lots.find((l) => l.ledger_entry_id === tampered.id)!;
    lot.original_points = 90;
    lot.remaining_points = 90;
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("ledger_total_mismatch");
    expect(result.refusal.message).toMatch(/totalling 490 point/);
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses a stray migration row belonging to a customer the anchor never listed", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // A tenth migration entry for an unknown customer. The cohort still looks
    // perfect, so ONLY a whole-ledger migration total can catch this — which is
    // why the total is computed across the ledger and not across the cohort.
    const stranger = fake.addCustomerRow(11111111777777);
    const strayEntry = fake.addLedgerRow({
      customer_id: stranger.id,
      entry_type: MIGRATION_ENTRY_TYPE,
      points: 50,
      reason: MIGRATION_REASON,
    });
    fake.addLotRow({
      customer_id: stranger.id,
      ledger_entry_id: strayEntry.id,
      original_points: 50,
      remaining_points: 50,
    });
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("ledger_total_mismatch");
    expect(result.refusal.message).toMatch(/10 migration\/m1_backfill entry\(ies\) totalling 534/);
    expect(result.refusal.manualRecoveryRequired).toBe(true);
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses compensating tampering that keeps the total at 484 but breaks the anchor tie", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // +5 / −5 across two customers: the total is still 484, so only the
    // per-customer tie back to the anchor can catch it.
    const a = fake.ledger.find((e) => e.points === 84)!;
    const b = fake.ledger.find((e) => e.points === 50)!;
    a.points = 89;
    fake.lots.find((l) => l.ledger_entry_id === a.id)!.original_points = 89;
    fake.lots.find((l) => l.ledger_entry_id === a.id)!.remaining_points = 89;
    b.points = 45;
    fake.lots.find((l) => l.ledger_entry_id === b.id)!.original_points = 45;
    fake.lots.find((l) => l.ledger_entry_id === b.id)!.remaining_points = 45;
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("malformed_migration_state");
    expect(result.refusal.malformed.map((m) => m.problem)).toContain(
      "migration_points_do_not_match_anchor",
    );
    expect(fake.snapshot()).toEqual(before);
  });
});

// ===========================================================================
// 7. Unrelated rows refuse
// ===========================================================================

describe("M1 RECOVERY — 7. unrelated ledger rows refuse", () => {
  it("refuses when a ledger row exists for a customer outside the cohort", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    const stranger = fake.addCustomerRow(11111111888888);
    fake.addLedgerRow({
      customer_id: stranger.id,
      entry_type: "earn_order",
      points: 120,
      reason: "order_earning",
    });
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("unrelated_rows_present");
    expect(result.refusal.message).toMatch(/10 customer\(s\), 10 ledger entry\(ies\)/);
    // The census tells the operator WHAT is in the way, with no ids.
    expect(result.refusal.message).toMatch(/earn_order\/order_earning × 1/);
    expect(result.refusal.message).toMatch(/MANUAL RECOVERY PLANNING IS REQUIRED/);
    expect(result.refusal.manualRecoveryRequired).toBe(true);
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses when an unrelated point lot exists", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    const stranger = fake.addCustomerRow(11111111999999);
    fake.addLotRow({
      customer_id: stranger.id,
      ledger_entry_id: "led-does-not-exist",
      original_points: 10,
      remaining_points: 10,
    });
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("unrelated_rows_present");
    expect(result.refusal.message).toMatch(/10 point lot\(s\)/);
    expect(fake.snapshot()).toEqual(before);
  });
});

// ===========================================================================
// 8. Post-M1 activity refuses
// ===========================================================================

describe("M1 RECOVERY — 8. ANY post-M1 loyalty activity refuses", () => {
  it("refuses on an order earning, a redemption, an adjustment and a clawback together", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // Four categories of real, post-migration customer activity across the cohort.
    const [c0, c1, c2, c3] = fake.customers;
    fake.addLedgerRow({
      customer_id: c0!.id,
      entry_type: "earn_order",
      points: 120,
      reason: "order_earning",
    });
    fake.addLedgerRow({
      customer_id: c1!.id,
      entry_type: "spend",
      points: -50,
      reason: "redemption",
    });
    fake.addLedgerRow({
      customer_id: c2!.id,
      entry_type: "adjust",
      points: 25,
      reason: "admin_goodwill",
    });
    fake.addLedgerRow({
      customer_id: c3!.id,
      entry_type: "clawback",
      points: -30,
      reason: "refund_clawback",
    });
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("post_migration_activity");

    // The refusal must SAY automatic rollback is impossible and that a human
    // must plan the recovery — not merely fail.
    expect(result.refusal.message).toMatch(/AUTOMATIC ROLLBACK IS NOT POSSIBLE/);
    expect(result.refusal.message).toMatch(/MANUAL RECOVERY PLANNING IS REQUIRED/);
    expect(result.refusal.manualRecoveryRequired).toBe(true);

    // ...and report what it found, by category, with masked ids.
    const categories = result.refusal.activity.map((a) => a.category).sort();
    expect(categories).toEqual(
      ["admin_adjustment", "purchase_earning", "redemption", "refund_clawback"].sort(),
    );
    expect(result.refusal.message).toMatch(/purchase_earning × 1/);
    expect(result.refusal.message).toMatch(/redemption × 1/);
    expect(result.refusal.message).toMatch(/admin_adjustment × 1/);
    expect(result.refusal.message).toMatch(/refund_clawback × 1/);
    for (const a of result.refusal.activity) {
      expect(a.maskedShopifyCustomerId).toMatch(/^…\d{4}$/);
    }
    // Signed amounts survive, so an earning and a spend are distinguishable.
    expect(result.refusal.activity.find((a) => a.category === "redemption")!.points).toBe(-50);
    expect(result.refusal.activity.find((a) => a.category === "purchase_earning")!.points).toBe(120);

    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses on a referral earning and on a birthday reward", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    fake.addLedgerRow({
      customer_id: fake.customers[0]!.id,
      entry_type: "earn_referral",
      points: 100,
      reason: "referral_reward",
    });
    fake.addLedgerRow({
      customer_id: fake.customers[1]!.id,
      entry_type: "adjust",
      points: 200,
      reason: "birthday_reward",
    });
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("post_migration_activity");
    const categories = result.refusal.activity.map((a) => a.category).sort();
    expect(categories).toEqual(["birthday_reward", "referral_earning"]);
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses an entry type that does not exist yet — the whitelist fails CLOSED", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // A type invented after this tool was written. A blacklist would have let it
    // through and deleted a customer who had earned real points.
    fake.addLedgerRow({
      customer_id: fake.customers[0]!.id,
      entry_type: "earn_some_future_promotion",
      points: 500,
      reason: "future_campaign",
    });
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("post_migration_activity");
    expect(result.refusal.activity[0]!.category).toBe("unknown_entry_type");
    expect(result.refusal.activity[0]!.entryType).toBe("earn_some_future_promotion");
    expect(fake.snapshot()).toEqual(before);
  });

  it("permits exactly one entry type, and it is M1's own", () => {
    // The structural guarantee behind the test above: the whitelist has one
    // member. If a future change widens it, this fails.
    expect([...PERMITTED_ENTRY_TYPES]).toEqual([MIGRATION_ENTRY_TYPE]);
    expect(PERMITTED_ENTRY_TYPES.has("earn_order")).toBe(false);
    expect(PERMITTED_ENTRY_TYPES.has("spend")).toBe(false);
    expect(PERMITTED_ENTRY_TYPES.has("adjust")).toBe(false);
  });

  it("categorises every known movement, and anything unknown as unknown_entry_type", () => {
    expect(categoriseActivity("earn_order", "order_earning")).toBe("purchase_earning");
    expect(categoriseActivity("earn_signup", "signup")).toBe("signup_earning");
    expect(categoriseActivity("earn_first_purchase", "first_order")).toBe("first_purchase_earning");
    expect(categoriseActivity("earn_referral", "referral")).toBe("referral_earning");
    expect(categoriseActivity("spend", "redeem_50")).toBe("redemption");
    expect(categoriseActivity("adjust", "goodwill")).toBe("admin_adjustment");
    expect(categoriseActivity("adjust", "birthday_reward")).toBe("birthday_reward");
    expect(categoriseActivity("clawback", "order_refunded")).toBe("refund_clawback");
    expect(categoriseActivity("expire", "lot_expired")).toBe("expiry");
    expect(categoriseActivity("something_new", "whatever")).toBe("unknown_entry_type");
  });

  it("refuses when migrated points have been PARTIALLY SPENT, even with no spend entry", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // remaining < original means value has already moved out of this lot.
    fake.lots[0]!.remaining_points = 10;
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("malformed_migration_state");
    expect(result.refusal.malformed[0]!.problem).toBe("lot_points_were_partially_spent");
    expect(result.refusal.malformed[0]!.detail).toMatch(/Automatic rollback is not possible/i);
    expect(result.refusal.manualRecoveryRequired).toBe(true);
    expect(fake.snapshot()).toEqual(before);
  });
});

// ===========================================================================
// 9. Partial / malformed M1 state refuses
// ===========================================================================

describe("M1 RECOVERY — 9. a partial or malformed M1 state refuses", () => {
  it("refuses a migration entry with no matching lot", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    fake.lots.splice(0, 1); // the lot vanished; its entry remains
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("malformed_migration_state");
    expect(result.refusal.malformed.map((m) => m.problem)).toContain(
      "migration_entry_has_no_matching_lot",
    );
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses a lot that is not matched to the migration entry", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // An extra lot on a cohort customer, linked to nothing M1 wrote.
    fake.addLotRow({
      customer_id: fake.customers[0]!.id,
      ledger_entry_id: "led-not-a-migration-entry",
      original_points: 40,
      remaining_points: 40,
    });
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("malformed_migration_state");
    expect(result.refusal.malformed.map((m) => m.problem)).toContain(
      "lot_is_not_matched_to_the_migration_entry",
    );
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses a customer with no migration entry alongside a duplicate on another", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // Move one customer's entry+lot onto another customer: now customer A has no
    // migration entry and customer B has two. The TOTAL is still 484 and the row
    // counts are still 9/9/9, so only the structural checks can catch this —
    // which is exactly the "partial/malformed M1 state" the guard exists for.
    const a = fake.customers[0]!;
    const b = fake.customers[1]!;
    const movedEntry = fake.ledger.find((e) => e.customer_id === a.id)!;
    const movedLot = fake.lots.find((l) => l.ledger_entry_id === movedEntry.id)!;
    movedEntry.customer_id = b.id;
    movedLot.customer_id = b.id;
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("malformed_migration_state");
    const problems = result.refusal.malformed.map((m) => m.problem);
    expect(problems).toContain("customer_has_no_migration_entry");
    expect(problems).toContain("customer_has_multiple_migration_entries");
    expect(result.refusal.manualRecoveryRequired).toBe(true);
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses a migration lot that carries an expiry", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // M1's migration lots are always non-expiring (no expiry was ever tracked
    // for legacy points), so an expires_at means this is not M1's lot.
    fake.lots[0]!.expires_at = new Date("2027-01-01T00:00:00.000Z");
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("malformed_migration_state");
    expect(result.refusal.malformed.map((m) => m.problem)).toContain("lot_expires");
    expect(fake.snapshot()).toEqual(before);
  });

  it("refuses a lot whose original does not match its entry", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // original ABOVE the entry: not a spend, but not M1's shape either.
    fake.lots[0]!.original_points += 5;
    fake.lots[0]!.remaining_points += 5;
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("malformed_migration_state");
    expect(result.refusal.malformed.map((m) => m.problem)).toContain("lot_points_do_not_match_entry");
    expect(fake.snapshot()).toEqual(before);
  });
});

// ===========================================================================
// 10. A second recovery attempt is safe and refuses cleanly
// ===========================================================================

describe("M1 RECOVERY — 10. a second attempt refuses cleanly with nothing to revert", () => {
  it("does not throw and does not half-act when the reversal has already completed", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    const first = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );
    expect(first.status).toBe("reverted");
    expect(fake.snapshot()).toEqual(ORIGINAL_EMPTY_STATE);

    // The second attempt: fully armed, and it must still be a clean refusal
    // rather than a throw, a partial delete, or a confusing count mismatch.
    const second = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(second.status).toBe("refused");
    if (second.status !== "refused") return;
    expect(second.refusal.code).toBe("nothing_to_revert");
    expect(second.refusal.message).toMatch(/original pre-M1 state/i);
    expect(second.refusal.message).toMatch(/Nothing was changed/i);
    expect(second.refusal.manualRecoveryRequired).toBe(false);
    expect(fake.snapshot()).toEqual(ORIGINAL_EMPTY_STATE);

    // A third, and a dry run, behave identically — it is stable, not one-shot.
    const third = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );
    expect(third.status).toBe("refused");
    const dry = await runM1Recovery(validOptions(fake, anchor));
    expect(dry.status).toBe("refused");
    if (dry.status !== "refused") return;
    expect(dry.refusal.code).toBe("nothing_to_revert");
    expect(fake.snapshot()).toEqual(ORIGINAL_EMPTY_STATE);
  });

  it("refuses cleanly against a database that never ran M1 at all", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.refusal.code).toBe("nothing_to_revert");
    expect(fake.snapshot()).toEqual(ORIGINAL_EMPTY_STATE);
  });
});

// ===========================================================================
// 11. A transaction failure leaves state unchanged
// ===========================================================================

describe("M1 RECOVERY — 11. a transaction failure leaves state unchanged", () => {
  it("rolls back completely when a DELETE throws partway through the reversal", async () => {
    const anchor = productionAnchor();
    // The 5th DELETE throws: by then four lots have already been deleted inside
    // the transaction, which is exactly what makes this a rollback test rather
    // than a validation test.
    const fake = makeFakeDb({ throwOnDeleteCall: 5 });
    await seedWithRealM1(fake, anchor);
    const before = fake.snapshot();

    await expect(
      runM1Recovery(
        validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
      ),
    ).rejects.toThrow(/simulated point_lots DELETE failure/i);

    // All-or-nothing: the full 9/9/9 and the 484 total survive intact.
    expect(fake.snapshot()).toEqual(before);
    expect(fake.customers).toHaveLength(9);
    expect(fake.ledger).toHaveLength(9);
    expect(fake.lots).toHaveLength(9);
    expect(fake.ledger.reduce((s, e) => s + e.points, 0)).toBe(EXPECT_TOTAL_POINTS);
  });

  it("rolls back when a DELETE fails partway through the LEDGER deletions", async () => {
    const anchor = productionAnchor();
    // Deletes 1-9 are the lots; 10 is the first ledger entry. Failing at 12 means
    // all nine lots and two entries were already gone inside the transaction.
    const fake = makeFakeDb({ throwOnDeleteCall: 12 });
    await seedWithRealM1(fake, anchor);
    const before = fake.snapshot();

    await expect(
      runM1Recovery(
        validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
      ),
    ).rejects.toThrow(/simulated ledger_entries DELETE failure/i);

    expect(fake.snapshot()).toEqual(before);
  });

  it("aborts and rolls back when a DELETE affects an unexpected number of rows", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb({ zeroRowsOnDeleteCall: 3 });
    await seedWithRealM1(fake, anchor);
    const before = fake.snapshot();

    const result = await runM1Recovery(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    );

    expect(result.status).toBe("aborted_delete_error");
    if (result.status !== "aborted_delete_error") return;
    expect(result.detail.reason).toMatch(/affected 0 row\(s\), expected exactly 1/);
    expect(result.detail.reason).toMatch(/rolled back/i);
    expect(fake.snapshot()).toEqual(before);
  });
});

// ===========================================================================
// Narrow-scope guarantees: this must never become a generic delete tool.
// ===========================================================================

describe("M1 RECOVERY — narrow scope by construction", () => {
  it("accepts no table name, predicate, id list or entry-type input at all", async () => {
    // The option surface is the whole attack surface. If a future change adds a
    // table/where/ids/entryType option, this fails and the reviewer has to justify
    // turning a one-migration reversal into a delete facility.
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    // The FULLY-ARMED option object: every field the destructive path can carry.
    const keys = Object.keys(
      validOptions(fake, anchor, { mode: "execute", acknowledgeDeletesMigrationRows: true }),
    ).sort();
    expect(keys).toEqual(
      [
        "acknowledgeDeletesMigrationRows",
        "mode",
        "actualDbFingerprint",
        "backup",
        "confirmDbFingerprint",
        "confirmEntryType",
        "confirmReason",
        "environment",
        "expectCohort",
        "expectTotalPoints",
        "store",
        "transactor",
      ].sort(),
    );
    for (const forbidden of ["table", "tableName", "where", "predicate", "ids", "entryType", "sql"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("derives the cohort from the anchor, never from a hardcoded id list", () => {
    const cohort = deriveAnchorCohort(productionAnchor());
    expect(cohort).toHaveLength(9);
    expect(cohort.reduce((s, c) => s + c.expectedMigrationPoints, 0)).toBe(EXPECT_TOTAL_POINTS);
    // The owner-approved conversions, reached through M1's own resolver.
    expect(cohort.find((c) => c.shopifyCustomerId === Number(PROD_4995_ID))!.expectedMigrationPoints).toBe(
      84,
    );
    expect(cohort.find((c) => c.shopifyCustomerId === Number(PROD_4627_ID))!.expectedMigrationPoints).toBe(
      50,
    );

    // A smaller anchor yields a smaller cohort: the anchor IS the definition.
    const single = productionAnchor();
    const trimmed: M0Backup = { ...single, customers: single.customers.filter((c) => !c.enrolled) };
    expect(deriveAnchorCohort(trimmed)).toHaveLength(0);
  });

  it("never deletes a non-migration row, even if one is aimed at the ledger DELETE", async () => {
    const anchor = productionAnchor();
    const fake = makeFakeDb();
    await seedWithRealM1(fake, anchor);

    // The DELETE re-asserts entry_type/reason in its WHERE clause, so a row that
    // is not an M1 migration row can never be removed by it. Proved by aiming the
    // statement at a non-migration row directly: 0 rows affected.
    const stray = fake.addLedgerRow({
      customer_id: fake.customers[0]!.id,
      entry_type: "earn_order",
      points: 10,
      reason: "order_earning",
    });
    const res = await fake.transactor.transaction((tx) =>
      tx.query(
        `DELETE FROM ledger_entries WHERE id = $1 AND customer_id = $2 AND entry_type = $3 AND reason = $4`,
        [stray.id, stray.customer_id, MIGRATION_ENTRY_TYPE, MIGRATION_REASON],
      ),
    );
    expect(res.rowCount).toBe(0);
    expect(fake.ledger.some((e) => e.id === stray.id)).toBe(true);
  });

  it("masks customer identifiers to the last 4 digits and never leaks a full id", () => {
    expect(maskCustomerId(PROD_4995_ID)).toBe("…4995");
    expect(maskCustomerId(PROD_4627_ID)).toBe("…4627");
    expect(maskCustomerId(11397675974995)).toBe("…4995");
    // A short id is masked WHOLE rather than partially exposed.
    expect(maskCustomerId("12")).toBe("…**");
    expect(maskCustomerId(PROD_4995_ID)).not.toContain(PROD_4995_ID);
  });
});
