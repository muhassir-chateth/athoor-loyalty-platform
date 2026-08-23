/**
 * Tests for the one-time legacy balance conversion rule (owner decision,
 * 2026-08-22): positive fractional legacy balances round UPWARD so migration
 * never reduces a customer's previously represented loyalty value.
 *
 * The two real production values are used directly, so these tests document the
 * actual decision rather than a hypothetical one. Pure arithmetic — no network,
 * no database.
 */
import { describe, expect, it } from "vitest";
import { convertLegacyBalanceToPoints, describeLegacyConversion } from "./legacyBalanceConversion.js";

describe("convertLegacyBalanceToPoints — the real production cases", () => {
  it("rounds customer …4995's 83.75 UP to 84, not down to 83", () => {
    const result = convertLegacyBalanceToPoints(83.75);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.integerPoints).toBe(84);
    expect(result.rule).toBe("rounded_up");
    // The uplift is recorded, and reads as a clean 0.25 rather than a binary
    // floating-point artefact.
    expect(result.adjustment).toBe(0.25);
    expect(result.legacyBalance).toBe(83.75);
  });

  it("would round customer …4627's 55.99 UP to 56 if that record is migrated", () => {
    const result = convertLegacyBalanceToPoints(55.99);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.integerPoints).toBe(56);
    expect(result.rule).toBe("rounded_up");
    expect(result.adjustment).toBe(0.01);
  });

  it("NEVER reduces a legacy balance — the defining property of the rule", () => {
    for (const legacy of [0, 0.01, 1, 49.5, 50, 50.0, 55.99, 83.75, 100.999, 1234.5]) {
      const result = convertLegacyBalanceToPoints(legacy);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.integerPoints).toBeGreaterThanOrEqual(legacy);
      // And never gives away more than a single point.
      expect(result.integerPoints - legacy).toBeLessThan(1);
    }
  });
});

describe("convertLegacyBalanceToPoints — whole balances are untouched", () => {
  it("leaves an integer balance exactly as it is, with no adjustment", () => {
    for (const legacy of [0, 50, 84, 1000]) {
      const result = convertLegacyBalanceToPoints(legacy);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.integerPoints).toBe(legacy);
      expect(result.adjustment).toBe(0);
      expect(result.rule).toBe("exact");
    }
  });

  it('treats "50.0" (already parsed to 50) as exact, not rounded', () => {
    const result = convertLegacyBalanceToPoints(Number("50.0"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule).toBe("exact");
    expect(result.integerPoints).toBe(50);
  });
});

describe("convertLegacyBalanceToPoints — refuses rather than guesses", () => {
  it("refuses a negative balance instead of rounding it toward zero", () => {
    const result = convertLegacyBalanceToPoints(-5.5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/negative/i);
  });

  it.each([NaN, Infinity, -Infinity])("refuses the non-finite value %s", (value) => {
    const result = convertLegacyBalanceToPoints(value);
    expect(result.ok).toBe(false);
  });

  it("refuses a non-number without throwing", () => {
    const result = convertLegacyBalanceToPoints("83.75" as never);
    expect(result.ok).toBe(false);
  });
});

describe("describeLegacyConversion — auditable, and carries no customer identifier", () => {
  it("states the uplift explicitly for a rounded conversion", () => {
    const note = describeLegacyConversion(convertLegacyBalanceToPoints(83.75));
    expect(note).toContain("83.75");
    expect(note).toContain("84");
    expect(note).toContain("+0.25");
    expect(note).toMatch(/rounded up/i);
  });

  it("says exact, with no adjustment, for a whole balance", () => {
    const note = describeLegacyConversion(convertLegacyBalanceToPoints(50));
    expect(note).toMatch(/exact/i);
    expect(note).not.toMatch(/rounded/i);
  });

  it("reports a refusal as NO CONVERSION so it cannot read as a success", () => {
    const note = describeLegacyConversion(convertLegacyBalanceToPoints(-1));
    expect(note).toMatch(/^NO CONVERSION:/);
  });
});

/* ===========================================================================
 * The two composed migration rules, against the REAL production customers.
 *
 * These are the owner's two decisions of 2026-08-22 encoded so they cannot
 * drift:
 *   …4995 — a legitimately RETAINED fraction  → round upward  → 84
 *   …4627 — a fraction from REFUNDED spend    → normalise away → 50
 * ========================================================================= */
import { describeLegacyMigration, resolveLegacyMigrationBalance } from "./legacyBalanceConversion.js";

/** Customer …4995: order #1005, £33.75 PAID and retained. */
const PROD_4995 = { legacyBalance: 83.75, retainedSpendGBP: 33.75, refundedSpendGBP: 0 };

/** Customer …4627: order #1006, £5.99 paid then cancelled and FULLY refunded. */
const PROD_4627 = { legacyBalance: 55.99, retainedSpendGBP: 0, refundedSpendGBP: 5.99 };

describe("resolveLegacyMigrationBalance — customer …4995 keeps their value", () => {
  it("rounds 83.75 UP to 84 and removes nothing", () => {
    const r = resolveLegacyMigrationBalance(PROD_4995);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.integerPoints).toBe(84);
    expect(r.refundedPointsRemoved).toBe(0);
    expect(r.roundingAdjustment).toBe(0.25);
    expect(r.rule).toBe("rounded_up");
  });

  it("preserves £33.75 retained lifetime spend separately from points", () => {
    const r = resolveLegacyMigrationBalance(PROD_4995);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.retainedSpendGBP).toBe(33.75);
  });

  it("never reduces what the customer already had", () => {
    const r = resolveLegacyMigrationBalance(PROD_4995);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.integerPoints).toBeGreaterThanOrEqual(PROD_4995.legacyBalance);
  });
});

describe("resolveLegacyMigrationBalance — customer …4627 is refund-normalised", () => {
  it("removes the 5.99 refunded component, landing exactly on 50", () => {
    const r = resolveLegacyMigrationBalance(PROD_4627);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 55.99 - 5.99 = 50.00 exactly, so no rounding is involved at all.
    expect(r.integerPoints).toBe(50);
    expect(r.refundedPointsRemoved).toBe(5.99);
    expect(r.roundingAdjustment).toBe(0);
    expect(r.rule).toBe("refund_normalised");
  });

  it("does NOT round 55.99 up to 56 — that would migrate refunded value", () => {
    const r = resolveLegacyMigrationBalance(PROD_4627);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The distinction this whole rule exists to make.
    expect(r.integerPoints).not.toBe(56);
    expect(r.integerPoints).toBe(50);
  });

  it("preserves £0.00 retained spend, because the order was fully refunded", () => {
    const r = resolveLegacyMigrationBalance(PROD_4627);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Lifetime spend drives tier; a refunded order must not hold a tier up.
    expect(r.retainedSpendGBP).toBe(0);
  });

  it("leaves the signup bonus intact — only the refunded component goes", () => {
    const r = resolveLegacyMigrationBalance(PROD_4627);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.integerPoints).toBe(50);
  });
});

describe("resolveLegacyMigrationBalance — the rules COMPOSE, not compete", () => {
  it("applies refund normalisation AND rounding when both are needed", () => {
    // A hypothetical customer who retained £10.50 and had £5.25 refunded:
    // legacy would hold 50 + 15.75 = 65.75.
    // step 1: 65.75 - 5.25 = 60.50   step 2: ceil(60.50) = 61
    const r = resolveLegacyMigrationBalance({
      legacyBalance: 65.75,
      retainedSpendGBP: 10.5,
      refundedSpendGBP: 5.25,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refundedPointsRemoved).toBe(5.25);
    expect(r.integerPoints).toBe(61);
    expect(r.roundingAdjustment).toBe(0.5);
    expect(r.rule).toBe("refund_normalised_and_rounded_up");
  });

  it("reports `exact` for the seven clean 50-point customers", () => {
    const r = resolveLegacyMigrationBalance({
      legacyBalance: 50,
      retainedSpendGBP: 0,
      refundedSpendGBP: 0,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.integerPoints).toBe(50);
    expect(r.rule).toBe("exact");
    expect(r.refundedPointsRemoved).toBe(0);
    expect(r.roundingAdjustment).toBe(0);
  });

  it("never returns fewer points than the retained value justifies", () => {
    for (const retained of [0, 0.5, 10, 33.75, 100.99]) {
      for (const refunded of [0, 1, 5.99]) {
        const legacy = Number((50 + retained + refunded).toFixed(2));
        const r = resolveLegacyMigrationBalance({
          legacyBalance: legacy,
          retainedSpendGBP: retained,
          refundedSpendGBP: refunded,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        // Signup bonus plus every retained pound, never less.
        expect(r.integerPoints).toBeGreaterThanOrEqual(50 + Math.floor(retained));
      }
    }
  });
});

describe("resolveLegacyMigrationBalance — refuses incoherent legacy data", () => {
  it("refuses when the refunded component exceeds the whole legacy balance", () => {
    const r = resolveLegacyMigrationBalance({
      legacyBalance: 4,
      retainedSpendGBP: 0,
      refundedSpendGBP: 99,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/negative/i);
    expect(r.reason).toMatch(/operator/i);
  });

  it.each([
    ["legacyBalance", { legacyBalance: -1, retainedSpendGBP: 0, refundedSpendGBP: 0 }],
    ["retainedSpendGBP", { legacyBalance: 50, retainedSpendGBP: -1, refundedSpendGBP: 0 }],
    ["refundedSpendGBP", { legacyBalance: 50, retainedSpendGBP: 0, refundedSpendGBP: -1 }],
  ])("refuses a negative %s", (_label, input) => {
    expect(resolveLegacyMigrationBalance(input).ok).toBe(false);
  });

  it.each([NaN, Infinity])("refuses the non-finite legacy balance %s", (legacyBalance) => {
    expect(
      resolveLegacyMigrationBalance({ legacyBalance, retainedSpendGBP: 0, refundedSpendGBP: 0 }).ok,
    ).toBe(false);
  });
});

describe("describeLegacyMigration — the audit line names the rule applied", () => {
  it("states the customer-safe uplift for …4995", () => {
    const note = describeLegacyMigration(resolveLegacyMigrationBalance(PROD_4995));
    expect(note).toContain("83.75 → 84");
    expect(note).toContain("+0.25");
    expect(note).toContain("rounded_up");
    expect(note).not.toContain("refund normalisation");
  });

  it("states the refund normalisation for …4627", () => {
    const note = describeLegacyMigration(resolveLegacyMigrationBalance(PROD_4627));
    expect(note).toContain("55.99 → 50");
    expect(note).toContain("refund normalisation −5.99");
    expect(note).toContain("refund_normalised");
  });

  it("reports a refusal as NO MIGRATION so it cannot read as success", () => {
    const note = describeLegacyMigration(
      resolveLegacyMigrationBalance({ legacyBalance: 1, retainedSpendGBP: 0, refundedSpendGBP: 9 }),
    );
    expect(note).toMatch(/^NO MIGRATION:/);
  });
});
