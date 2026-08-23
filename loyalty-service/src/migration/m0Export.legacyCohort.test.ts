/**
 * Regression tests for the M0 legacy-cohort detection defect found by the
 * production dry run on 2026-08-19.
 *
 * WHAT WENT WRONG. `isEnrolled` required `points_balance` to parse as an INTEGER:
 *
 *     parseIntField("83.75") -> null   =>  isEnrolled -> false
 *
 * The legacy storefront earned `50 + spend` WITHOUT flooring, so real production
 * customers held fractional balances. Two of the nine customers carrying legacy
 * loyalty data were therefore classified non-enrolled, skipped
 * `validateEnrolledBalances` entirely, and M0 returned:
 *
 *     { status: "exported", enrolledExported: 7, mismatches: [] }
 *
 * A clean SUCCESS that had quietly dropped a real paying customer (£33.75 spend,
 * 83.75 points). The guard that exists to catch anomalies was bypassed by exactly
 * the anomalies it was meant to catch, because parsing decided cohort membership.
 *
 * THE RULE NOW UNDER TEST: presence of legacy loyalty state decides cohort
 * membership; parsing only decides whether migration may continue. A fractional
 * or malformed value must never make a customer disappear.
 *
 * These tests use the REAL production values (`"83.75"` / £33.75 and `"55.99"` /
 * £0.00) so they would have failed before the fix. No network, no database.
 */
import { describe, expect, it } from "vitest";
import {
  classifyLegacyBalance,
  findUnclassifiedLegacyCustomers,
  hasLegacyLoyaltyState,
  isEnrolled,
  runM0Export,
  validateEnrolledBalances,
  type BackupWriter,
  type M0Backup,
  type MigrationShopifyClient,
  type RawMetafield,
  type ShopifyCustomerRecord,
} from "./m0Export.js";

const STORE = "myathoorlondon.myshopify.com";
const FIXED_NOW = () => new Date("2026-08-19T01:13:44.431Z");

/** Builds the exact five-key legacy metafield set every production customer has. */
function legacyMetafields(pointsBalance: string | null): RawMetafield[] {
  return [
    { namespace: "loyalty", key: "points_balance", type: "number_integer", value: pointsBalance },
    { namespace: "loyalty", key: "lifetime_points", type: "number_integer", value: pointsBalance },
    { namespace: "loyalty", key: "tier", type: "single_line_text_field", value: "Bronze" },
    { namespace: "loyalty", key: "referral_code", type: "single_line_text_field", value: "JEE0787" },
    { namespace: "loyalty", key: "referral_count", type: "number_integer", value: "0" },
  ];
}

function customer(
  id: string,
  pointsBalance: string | null,
  lifetimeSpendGBP: number,
): ShopifyCustomerRecord {
  return {
    id,
    gid: `gid://shopify/Customer/${id}`,
    email: null,
    metafields: legacyMetafields(pointsBalance),
    lifetimeSpendGBP,
  };
}

/** A customer with no loyalty metafields at all — the genuinely non-enrolled cohort. */
function bareCustomer(id: string): ShopifyCustomerRecord {
  return { id, gid: `gid://shopify/Customer/${id}`, email: null, metafields: [], lifetimeSpendGBP: 0 };
}

function memoryWriter(): { writer: BackupWriter; written: string[] } {
  const written: string[] = [];
  return {
    written,
    writer: {
      async write(filename, contents) {
        written.push(contents);
        return `/memory/${filename}`;
      },
    },
  };
}

function fakeClient(records: ShopifyCustomerRecord[]): MigrationShopifyClient {
  return {
    async listCustomersWithLoyaltyMetafields() {
      return records;
    },
  };
}

/** The two real anomalies, plus one clean legacy customer for contrast. */
const PROD_4995 = customer("11111111114995", "83.75", 33.75);
const PROD_4627 = customer("11487171084627", "55.99", 0);
const PROD_CLEAN = customer("11111111116099", "50.0", 0);

describe("classifyLegacyBalance — presence first, parseability second", () => {
  it('classifies "50" as integer', () => {
    const a = classifyLegacyBalance(legacyMetafields("50"));
    expect(a).toMatchObject({ present: true, classification: "integer", numeric: 50 });
  });

  it('classifies "50.0" as integer — numerically whole despite the decimal point', () => {
    const a = classifyLegacyBalance(legacyMetafields("50.0"));
    expect(a).toMatchObject({ present: true, classification: "integer", numeric: 50 });
  });

  it('classifies the real "83.75" as fractional and keeps the value', () => {
    const a = classifyLegacyBalance(legacyMetafields("83.75"));
    expect(a).toMatchObject({ present: true, classification: "fractional", numeric: 83.75, raw: "83.75" });
  });

  it('classifies the real "55.99" as fractional and keeps the value', () => {
    const a = classifyLegacyBalance(legacyMetafields("55.99"));
    expect(a).toMatchObject({ present: true, classification: "fractional", numeric: 55.99, raw: "55.99" });
  });

  it("classifies a non-numeric value as malformed, still present", () => {
    const a = classifyLegacyBalance(legacyMetafields("not-a-number"));
    expect(a).toMatchObject({ present: true, classification: "malformed", numeric: null });
  });

  it("classifies a blank value as absent but still present as a key", () => {
    const a = classifyLegacyBalance(legacyMetafields("   "));
    expect(a).toMatchObject({ present: true, classification: "absent", numeric: null });
  });

  it("reports absent when the key does not exist", () => {
    const a = classifyLegacyBalance([]);
    expect(a).toMatchObject({ present: false, classification: "absent", numeric: null });
  });
});

describe("cohort membership never depends on parseability (the defect)", () => {
  it("includes the fractional production customers in the cohort", () => {
    // Before the fix both of these returned false.
    expect(isEnrolled(legacyMetafields("83.75"))).toBe(true);
    expect(isEnrolled(legacyMetafields("55.99"))).toBe(true);
  });

  it("includes a malformed balance in the cohort rather than dropping the customer", () => {
    expect(isEnrolled(legacyMetafields("not-a-number"))).toBe(true);
  });

  it("still excludes customers with no legacy loyalty state at all", () => {
    expect(isEnrolled([])).toBe(false);
    expect(hasLegacyLoyaltyState([])).toBe(false);
  });

  it("treats an all-blank loyalty namespace as no legacy state", () => {
    const blank: RawMetafield[] = [
      { namespace: "loyalty", key: "points_balance", type: "number_integer", value: "" },
      { namespace: "loyalty", key: "tier", type: "single_line_text_field", value: null },
    ];
    expect(hasLegacyLoyaltyState(blank)).toBe(false);
  });
});

describe("validateEnrolledBalances routes anomalies to review", () => {
  it("records the fractional …4995 case even though 50 + 33.75 reconciles exactly", () => {
    const exported = {
      id: PROD_4995.id,
      gid: PROD_4995.gid,
      email: null,
      enrolled: true,
      lifetimeSpendGBP: 33.75,
      metafields: PROD_4995.metafields,
      loyalty: { pointsBalance: 83.75 } as never,
    };
    const mismatches = validateEnrolledBalances([exported as never]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      classification: "fractional",
      rawBalance: "83.75",
      actualBalance: 83.75,
      // 50 + floor(33.75) — the integer formula value, for the operator's reference.
      expectedBalance: 83,
    });
  });

  it("records the fractional …4627 case", () => {
    const exported = {
      id: PROD_4627.id,
      gid: PROD_4627.gid,
      email: null,
      enrolled: true,
      lifetimeSpendGBP: 0,
      metafields: PROD_4627.metafields,
      loyalty: { pointsBalance: 55.99 } as never,
    };
    const mismatches = validateEnrolledBalances([exported as never]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      classification: "fractional",
      rawBalance: "55.99",
      expectedBalance: 50,
    });
  });

  it("passes a clean integer balance that matches the formula", () => {
    const exported = {
      id: PROD_CLEAN.id,
      gid: PROD_CLEAN.gid,
      email: null,
      enrolled: true,
      lifetimeSpendGBP: 0,
      metafields: PROD_CLEAN.metafields,
      loyalty: { pointsBalance: 50 } as never,
    };
    expect(validateEnrolledBalances([exported as never])).toEqual([]);
  });
});

describe("runM0Export — the exact production scenario must NOT report SUCCESS", () => {
  /**
   * The production cohort as it actually stands: 40 customers, 9 carrying legacy
   * loyalty state, of which 2 are fractional. Before the fix this produced
   * `{ status: "exported", enrolledExported: 7, mismatches: [] }`.
   */
  function productionLikeDataset(): ShopifyCustomerRecord[] {
    const legacy = [
      PROD_CLEAN,
      customer("11111111119779", "50.0", 0),
      PROD_4995,
      customer("11111111118307", "50.0", 0),
      customer("11111111114851", "50.0", 0),
      customer("11111111110147", "50.0", 0),
      customer("11111111110787", "50.0", 0),
      PROD_4627,
      customer("11111111115875", "50.0", 0),
    ];
    const bare = Array.from({ length: 31 }, (_, i) => bareCustomer(`2000000000${String(i).padStart(4, "0")}`));
    return [...legacy, ...bare];
  }

  it("halts for review instead of exporting a quietly short cohort", async () => {
    const { writer } = memoryWriter();

    const result = await runM0Export({
      client: fakeClient(productionLikeDataset()),
      backupWriter: writer,
      storeDomain: STORE,
      totalExpected: 40,
      enrolledExpected: 9,
      now: FIXED_NOW,
    });

    // The precise regression: this was "exported" before the fix.
    expect(result.status).toBe("halted_balance_mismatch");
    if (result.status !== "halted_balance_mismatch") return;

    // Both real anomalies are surfaced, and only those.
    expect(result.mismatches).toHaveLength(2);
    expect(result.mismatches.map((m) => m.rawBalance).sort()).toEqual(["55.99", "83.75"]);
    expect(result.mismatches.every((m) => m.classification === "fractional")).toBe(true);
    expect(result.mismatches.every((m) => m.reason.length > 0)).toBe(true);
  });

  it("counts all 9 legacy customers in the cohort, not 7", async () => {
    const { writer } = memoryWriter();

    const result = await runM0Export({
      client: fakeClient(productionLikeDataset()),
      backupWriter: writer,
      storeDomain: STORE,
      totalExpected: 40,
      enrolledExpected: 9,
      now: FIXED_NOW,
    });

    expect(result.status).toBe("halted_balance_mismatch");
    if (result.status !== "halted_balance_mismatch") return;

    const backup: M0Backup = result.backup;
    expect(backup.totalExported).toBe(40);
    // Was 7 before the fix — the two fractional customers were invisible.
    expect(backup.enrolledExported).toBe(9);
    expect(backup.enrolledExported).toBe(backup.enrolledExpected);
  });

  it("preserves the fractional values verbatim in the backup for rollback fidelity", async () => {
    const { writer } = memoryWriter();

    const result = await runM0Export({
      client: fakeClient(productionLikeDataset()),
      backupWriter: writer,
      storeDomain: STORE,
      totalExpected: 40,
      enrolledExpected: 9,
      now: FIXED_NOW,
    });
    if (result.status !== "halted_balance_mismatch") throw new Error("expected halt");

    const fourNineNineFive = result.backup.customers.find((c) => c.id === PROD_4995.id);
    const raw = fourNineNineFive?.metafields.find((m) => m.key === "points_balance");
    expect(raw?.value).toBe("83.75");
    expect(fourNineNineFive?.enrolled).toBe(true);
  });

  it("still reports SUCCESS when every legacy balance is a clean matching integer", async () => {
    const clean = [
      customer("11111111110001", "50", 0),
      customer("11111111110002", "50.0", 0),
      customer("11111111110003", "83", 33.75), // 50 + floor(33.75)
      bareCustomer("2000000000001"),
    ];
    const { writer } = memoryWriter();

    const result = await runM0Export({
      client: fakeClient(clean),
      backupWriter: writer,
      storeDomain: STORE,
      totalExpected: 4,
      enrolledExpected: 3,
      now: FIXED_NOW,
    });

    expect(result.status).toBe("exported");
    if (result.status !== "exported") return;
    expect(result.mismatches).toEqual([]);
    expect(result.backup.enrolledExported).toBe(3);
  });
});

describe("findUnclassifiedLegacyCustomers — the recurrence guard", () => {
  it("flags a legacy customer that some future change drops from the cohort", () => {
    const dropped = {
      id: "11111111114995",
      gid: "gid://shopify/Customer/11111111114995",
      email: null,
      enrolled: false, // simulates a regression in cohort detection
      lifetimeSpendGBP: 33.75,
      metafields: legacyMetafields("83.75"),
      loyalty: { pointsBalance: 83.75 } as never,
    };
    expect(findUnclassifiedLegacyCustomers([dropped as never])).toEqual(["11111111114995"]);
  });

  it("does not flag a customer who genuinely has no legacy state", () => {
    const bare = {
      id: "2000000000001",
      gid: "gid://shopify/Customer/2000000000001",
      email: null,
      enrolled: false,
      lifetimeSpendGBP: 0,
      metafields: [],
      loyalty: { pointsBalance: null } as never,
    };
    expect(findUnclassifiedLegacyCustomers([bare as never])).toEqual([]);
  });
});
