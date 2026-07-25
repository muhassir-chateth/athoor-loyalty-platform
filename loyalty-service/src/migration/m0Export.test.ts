/**
 * Unit + property tests for Migration Phase M0 export & validation (task 7.1).
 *
 * NO live/production Shopify Admin API is touched and NO live data is modified:
 * the export runs against a FAKE, read-only {@link MigrationShopifyClient} that
 * returns the representative dataset — the known 8 enrolled + 31 non-enrolled
 * customers — and an IN-MEMORY {@link BackupWriter} that captures the backup
 * without touching disk. The fake client exposes only a read method, so there
 * is no code path that could delete or modify a metafield (Req 14.8).
 *
 * Covers:
 *   - complete export succeeds and writes the versioned backup anchor (Req 14.1);
 *   - an incomplete export (fewer than 39, or a record missing data) aborts
 *     before any change and writes no backup (Req 14.2);
 *   - an enrolled balance that violates `50 + spend×1` halts the migration and
 *     records the mismatching customer, while the backup anchor is still written
 *     (Req 14.3);
 *   - the export never deletes/mutates any metafield (Req 14.8).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ENROLLED_CUSTOMER_COUNT,
  TOTAL_CUSTOMER_COUNT,
  expectedEnrolledBalance,
  runM0Export,
  validateEnrolledBalances,
  type BackupWriter,
  type MigrationShopifyClient,
  type RawMetafield,
  type ShopifyCustomerRecord,
} from "./m0Export.js";

const STORE = "myathoorlondon.myshopify.com";

/** Builds a full set of loyalty.* metafields for an enrolled customer. */
function enrolledMetafields(balance: number, lifetimePoints: number, referralCount: number): RawMetafield[] {
  const ns = "loyalty";
  return [
    { namespace: ns, key: "points_balance", type: "number_integer", value: String(balance) },
    { namespace: ns, key: "lifetime_points", type: "number_integer", value: String(lifetimePoints) },
    { namespace: ns, key: "tier", type: "single_line_text_field", value: "bronze" },
    { namespace: ns, key: "points_expiry_date", type: "single_line_text_field", value: "" },
    { namespace: ns, key: "referral_code", type: "single_line_text_field", value: "ATH-REF-0001" },
    { namespace: ns, key: "referral_count", type: "number_integer", value: String(referralCount) },
    { namespace: ns, key: "activity_log", type: "json", value: "[]" },
  ];
}

/** One enrolled customer with a CLEAN balance (`50 + spend×1`). */
function enrolledCustomer(index: number, spendGBP: number): ShopifyCustomerRecord {
  const id = String(1000 + index);
  const balance = expectedEnrolledBalance(spendGBP);
  return {
    id,
    gid: `gid://shopify/Customer/${id}`,
    email: `enrolled${index}@example.com`,
    metafields: enrolledMetafields(balance, balance, 0),
    lifetimeSpendGBP: spendGBP,
  };
}

/** One non-enrolled customer: no loyalty metafields at all. */
function nonEnrolledCustomer(index: number, spendGBP = 0): ShopifyCustomerRecord {
  const id = String(2000 + index);
  return {
    id,
    gid: `gid://shopify/Customer/${id}`,
    email: `guest${index}@example.com`,
    metafields: [],
    lifetimeSpendGBP: spendGBP,
  };
}

/** The representative production shape: 8 enrolled (clean) + 31 non-enrolled = 39. */
function representativeDataset(): ShopifyCustomerRecord[] {
  const enrolled = Array.from({ length: ENROLLED_CUSTOMER_COUNT }, (_v, i) =>
    // A spread of spends: 0, 50, 100, ... so balances are 50, 100, 150, ...
    enrolledCustomer(i, i * 50),
  );
  const nonEnrolled = Array.from(
    { length: TOTAL_CUSTOMER_COUNT - ENROLLED_CUSTOMER_COUNT },
    (_v, i) => nonEnrolledCustomer(i, i % 3 === 0 ? 20 : 0),
  );
  return [...enrolled, ...nonEnrolled];
}

/** A read-only fake Shopify client returning a fixed dataset. Records call count. */
function fakeClient(dataset: ShopifyCustomerRecord[]): {
  client: MigrationShopifyClient;
  reads: () => number;
} {
  let reads = 0;
  return {
    client: {
      async listCustomersWithLoyaltyMetafields(): Promise<ShopifyCustomerRecord[]> {
        reads += 1;
        return dataset;
      },
    },
    reads: () => reads,
  };
}

/** An in-memory backup writer that captures what would be written to disk. */
function memoryWriter(): {
  writer: BackupWriter;
  writes: Array<{ filename: string; contents: string }>;
} {
  const writes: Array<{ filename: string; contents: string }> = [];
  return {
    writer: {
      async write(filename: string, contents: string): Promise<string> {
        writes.push({ filename, contents });
        return `memory://${filename}`;
      },
    },
    writes,
  };
}

const FIXED_NOW = () => new Date("2025-01-15T12:00:00.000Z");

describe("runM0Export — complete export (Req 14.1)", () => {
  it("succeeds and writes a versioned backup anchor for all 39 customers", async () => {
    const { client, reads } = fakeClient(representativeDataset());
    const { writer, writes } = memoryWriter();

    const result = await runM0Export({ client, backupWriter: writer, storeDomain: STORE, now: FIXED_NOW });

    expect(result.status).toBe("exported");
    if (result.status !== "exported") return;

    // The backup was written exactly once — the rollback anchor exists.
    expect(writes).toHaveLength(1);
    expect(reads()).toBe(1);

    const backup = result.backup;
    expect(backup.kind).toBe("m0-metafield-export");
    expect(backup.customers).toHaveLength(TOTAL_CUSTOMER_COUNT);
    expect(backup.totalExported).toBe(TOTAL_CUSTOMER_COUNT);
    expect(backup.enrolledExported).toBe(ENROLLED_CUSTOMER_COUNT);
    expect(result.mismatches).toEqual([]);

    // The written file is valid JSON matching the returned backup.
    const written = writes[0]!;
    expect(written.filename).toBe("m0-metafield-export-2025-01-15T12-00-00-000Z.json");
    expect(JSON.parse(written.contents)).toEqual(backup);
  });

  it("captures every loyalty.* metafield verbatim for enrolled customers", async () => {
    const { client } = fakeClient(representativeDataset());
    const { writer } = memoryWriter();

    const result = await runM0Export({ client, backupWriter: writer, storeDomain: STORE, now: FIXED_NOW });
    expect(result.status).toBe("exported");
    if (result.status !== "exported") return;

    const firstEnrolled = result.backup.customers.find((c) => c.enrolled)!;
    // All 7 known loyalty keys were preserved.
    const keys = firstEnrolled.metafields.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "activity_log",
        "lifetime_points",
        "points_balance",
        "points_expiry_date",
        "referral_code",
        "referral_count",
        "tier",
      ].sort(),
    );
    // Non-enrolled customers carry no loyalty metafields.
    const nonEnrolled = result.backup.customers.find((c) => !c.enrolled)!;
    expect(nonEnrolled.metafields).toEqual([]);
  });
});

describe("runM0Export — incomplete export aborts (Req 14.2)", () => {
  it("aborts and writes no backup when fewer than 39 customers are exported", async () => {
    const dataset = representativeDataset().slice(0, 38); // one customer missing
    const { client } = fakeClient(dataset);
    const { writer, writes } = memoryWriter();

    const result = await runM0Export({ client, backupWriter: writer, storeDomain: STORE, now: FIXED_NOW });

    expect(result.status).toBe("aborted_incomplete_export");
    if (result.status !== "aborted_incomplete_export") return;
    expect(result.detail.found).toBe(38);
    expect(result.detail.expected).toBe(TOTAL_CUSTOMER_COUNT);
    // No backup anchor is written from a partial export.
    expect(writes).toHaveLength(0);
  });

  it("aborts when an exported record is missing required identity data", async () => {
    const dataset = representativeDataset();
    // Corrupt one record: blank the gid so the record is incomplete.
    dataset[0] = { ...dataset[0]!, gid: "" };
    const { client } = fakeClient(dataset);
    const { writer, writes } = memoryWriter();

    const result = await runM0Export({ client, backupWriter: writer, storeDomain: STORE, now: FIXED_NOW });

    expect(result.status).toBe("aborted_incomplete_export");
    if (result.status !== "aborted_incomplete_export") return;
    expect(result.detail.incompleteRecordIds).toContain(dataset[0]!.id);
    expect(writes).toHaveLength(0);
  });

  it("aborts when an exported record is missing its id", async () => {
    const dataset = representativeDataset();
    dataset[5] = { ...dataset[5]!, id: "   " }; // whitespace-only id is incomplete
    const { client } = fakeClient(dataset);
    const { writer, writes } = memoryWriter();

    const result = await runM0Export({ client, backupWriter: writer, storeDomain: STORE, now: FIXED_NOW });

    expect(result.status).toBe("aborted_incomplete_export");
    if (result.status !== "aborted_incomplete_export") return;
    expect(result.detail.incompleteRecordIds.length).toBeGreaterThan(0);
    expect(writes).toHaveLength(0);
  });
});

describe("runM0Export — balance mismatch halts (Req 14.3)", () => {
  it("halts and records the mismatching customer, still writing the anchor", async () => {
    const dataset = representativeDataset();
    // Tamper one enrolled balance so it violates 50 + spend×1.
    const target = dataset[3]!;
    const wrongBalance = expectedEnrolledBalance(target.lifetimeSpendGBP) + 7;
    dataset[3] = {
      ...target,
      metafields: target.metafields.map((m) =>
        m.key === "points_balance" ? { ...m, value: String(wrongBalance) } : m,
      ),
    };
    const { client } = fakeClient(dataset);
    const { writer, writes } = memoryWriter();

    const result = await runM0Export({ client, backupWriter: writer, storeDomain: STORE, now: FIXED_NOW });

    expect(result.status).toBe("halted_balance_mismatch");
    if (result.status !== "halted_balance_mismatch") return;
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!.id).toBe(target.id);
    expect(result.mismatches[0]!.actualBalance).toBe(wrongBalance);
    expect(result.mismatches[0]!.expectedBalance).toBe(
      expectedEnrolledBalance(target.lifetimeSpendGBP),
    );
    // The backup anchor is still written before halting (Req 14.1 / 14.3).
    expect(writes).toHaveLength(1);
  });
});

describe("runM0Export — never deletes/mutates metafields (Req 14.8)", () => {
  it("uses a read-only client with no write/delete surface and does not mutate input", async () => {
    const dataset = representativeDataset();
    const snapshot = JSON.stringify(dataset);
    const { client } = fakeClient(dataset);
    const { writer } = memoryWriter();

    // The injected client type exposes only a read method — structurally there
    // is no delete/write path. Confirm at runtime too.
    expect(Object.keys(client)).toEqual(["listCustomersWithLoyaltyMetafields"]);

    await runM0Export({ client, backupWriter: writer, storeDomain: STORE, now: FIXED_NOW });

    // The source dataset (representing live metafields) is unchanged.
    expect(JSON.stringify(dataset)).toBe(snapshot);
  });
});

describe("validateEnrolledBalances — property (Req 14.3)", () => {
  it("passes for any clean cohort and flags every tampered balance", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 5000 }), { minLength: 1, maxLength: 12 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 12 }),
        (spends, deltas) => {
          const clean = spends.map((spend, i) => enrolledCustomer(i, spend));
          const exported = clean.map((r) => ({
            id: r.id,
            gid: r.gid,
            email: r.email,
            enrolled: true,
            lifetimeSpendGBP: r.lifetimeSpendGBP,
            metafields: r.metafields,
            loyalty: {
              pointsBalance: expectedEnrolledBalance(r.lifetimeSpendGBP),
              lifetimePoints: null,
              tier: "bronze",
              pointsExpiryDate: null,
              referralCode: null,
              referralCount: null,
              activityLog: null,
            },
          }));
          // Clean cohort → no mismatches.
          expect(validateEnrolledBalances(exported)).toEqual([]);

          // Tamper each balance by a non-zero delta → every one is flagged.
          const tampered = exported.map((c, i) => ({
            ...c,
            loyalty: {
              ...c.loyalty,
              pointsBalance: c.loyalty.pointsBalance! + (deltas[i % deltas.length] ?? 1),
            },
          }));
          expect(validateEnrolledBalances(tampered)).toHaveLength(tampered.length);
        },
      ),
    );
  });
});
