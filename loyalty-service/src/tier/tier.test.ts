/**
 * Unit tests for the VIP membership tier logic (task 4.3).
 *
 * Covers threshold boundaries, multi-threshold crossing, the no-downgrade
 * (monotonic) guarantee, the multiplier default fallback, the progress
 * calculation, and the Royal_VIP top-tier indicator — the acceptance criteria
 * of Requirement 7 (7.1–7.7) and the tier-multiplier half of Requirement 2.4.
 */
import { describe, it, expect } from "vitest";
import {
  TIERS,
  DEFAULT_TIER,
  DEFAULT_TIER_RULES,
  TIER_THRESHOLDS_GBP,
  TIER_MULTIPLIERS,
  deriveTier,
  advanceTier,
  tierMultiplier,
  tierRank,
  normalizeTier,
  buildTierSummary,
  type TierRuleSet,
} from "./tier.js";

describe("deriveTier — thresholds (Req 7.1)", () => {
  it("returns Bronze at the very bottom of the range (£0.00)", () => {
    expect(deriveTier(0)).toBe("bronze");
  });

  it("treats each inclusive lower threshold as the start of its tier", () => {
    expect(deriveTier(300)).toBe("silver");
    expect(deriveTier(750)).toBe("gold");
    expect(deriveTier(1500)).toBe("royal_vip");
  });

  it("keeps the tier for spend just below the next threshold (boundary − 0.01)", () => {
    expect(deriveTier(299.99)).toBe("bronze");
    expect(deriveTier(749.99)).toBe("silver");
    expect(deriveTier(1499.99)).toBe("gold");
  });

  it("keeps the tier for spend just below the next threshold (boundary − 1)", () => {
    expect(deriveTier(299)).toBe("bronze");
    expect(deriveTier(749)).toBe("silver");
    expect(deriveTier(1499)).toBe("gold");
  });

  it("stays Royal_VIP for arbitrarily large spend", () => {
    expect(deriveTier(1500)).toBe("royal_vip");
    expect(deriveTier(10_000)).toBe("royal_vip");
    expect(deriveTier(1_000_000.55)).toBe("royal_vip");
  });

  it("floors negative or non-finite spend to Bronze", () => {
    // Non-finite values are clamped to 0 for safety, so they all map to Bronze.
    expect(deriveTier(-1)).toBe("bronze");
    expect(deriveTier(-1000)).toBe("bronze");
    expect(deriveTier(Number.NaN)).toBe("bronze");
    expect(deriveTier(Number.POSITIVE_INFINITY)).toBe("bronze");
    expect(deriveTier(Number.NEGATIVE_INFINITY)).toBe("bronze");
  });
});

describe("advanceTier — highest tier met, never lowered (Req 7.2, 7.3, 7.7; Property 11)", () => {
  it("advances across a single threshold on order completion", () => {
    expect(advanceTier("bronze", 300)).toBe("silver");
    expect(advanceTier("silver", 750)).toBe("gold");
    expect(advanceTier("gold", 1500)).toBe("royal_vip");
  });

  it("advances across MULTIPLE thresholds in one step (Bronze → Gold)", () => {
    expect(advanceTier("bronze", 800)).toBe("gold");
    expect(advanceTier("bronze", 1500)).toBe("royal_vip");
  });

  it("never lowers a retained tier even if the derived tier is lower", () => {
    // A retained Gold customer whose (out-of-band) spend maps to Bronze keeps Gold.
    expect(advanceTier("gold", 0)).toBe("gold");
    expect(advanceTier("royal_vip", 100)).toBe("royal_vip");
    expect(advanceTier("silver", 299.99)).toBe("silver");
  });

  it("keeps the same tier when the spend maps to the same tier", () => {
    expect(advanceTier("silver", 500)).toBe("silver");
  });

  it("treats an undefined/unrecognized current tier as Bronze then derives", () => {
    expect(advanceTier(undefined, 800)).toBe("gold");
    expect(advanceTier(null, 0)).toBe("bronze");
    expect(advanceTier("platinum", 300)).toBe("silver");
    expect(advanceTier("", 1500)).toBe("royal_vip");
  });
});

describe("tierMultiplier — lookup and default fallback (Req 2.4, 7.4)", () => {
  it("maps each tier to its multiplier", () => {
    expect(tierMultiplier("bronze")).toBe(1);
    expect(tierMultiplier("silver")).toBe(1.5);
    expect(tierMultiplier("gold")).toBe(2);
    expect(tierMultiplier("royal_vip")).toBe(3);
  });

  it("defaults to the Bronze multiplier (1x) when the tier is undefined", () => {
    expect(tierMultiplier(undefined)).toBe(1);
    expect(tierMultiplier(null)).toBe(1);
  });

  it("defaults to the Bronze multiplier (1x) when the tier is unrecognized", () => {
    expect(tierMultiplier("platinum")).toBe(1);
    expect(tierMultiplier("")).toBe(1);
    expect(tierMultiplier("BRONZE")).toBe(1); // case-sensitive: unrecognized
  });

  it("is non-decreasing from Bronze through Royal_VIP (Req 7.4)", () => {
    const values = TIERS.map((t) => tierMultiplier(t));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] as number);
    }
  });
});

describe("normalizeTier / tierRank", () => {
  it("passes through recognized tiers and defaults others to Bronze", () => {
    expect(normalizeTier("gold")).toBe("gold");
    expect(normalizeTier("nope")).toBe(DEFAULT_TIER);
    expect(normalizeTier(undefined)).toBe(DEFAULT_TIER);
  });

  it("ranks tiers ascending Bronze(0) → Royal_VIP(3)", () => {
    expect(tierRank("bronze")).toBe(0);
    expect(tierRank("silver")).toBe(1);
    expect(tierRank("gold")).toBe(2);
    expect(tierRank("royal_vip")).toBe(3);
  });
});

describe("buildTierSummary — account data (Req 7.5)", () => {
  it("reports current tier, multiplier, and lifetime spend to 2dp", () => {
    const summary = buildTierSummary(123.456, "bronze");
    expect(summary.tier).toBe("bronze");
    expect(summary.multiplier).toBe(1);
    expect(summary.lifetimeSpendGBP).toBe(123.46);
  });

  it("computes progress as the remaining GBP to the next tier's lower threshold", () => {
    // Bronze at £100 → £200 remaining to Silver (£300).
    const bronze = buildTierSummary(100, "bronze");
    expect(bronze.nextTier).toBe("silver");
    expect(bronze.nextTierThresholdGBP).toBe(300);
    expect(bronze.progressToNextTierGBP).toBe(200);

    // Silver at £500 → £250 remaining to Gold (£750).
    const silver = buildTierSummary(500, "silver");
    expect(silver.nextTier).toBe("gold");
    expect(silver.progressToNextTierGBP).toBe(250);

    // Gold at £1000 → £500 remaining to Royal_VIP (£1500).
    const gold = buildTierSummary(1000, "gold");
    expect(gold.nextTier).toBe("royal_vip");
    expect(gold.progressToNextTierGBP).toBe(500);
  });

  it("rounds the remaining progress to 2dp and never returns a negative", () => {
    const summary = buildTierSummary(150.005, "bronze");
    // 300 - 150.005 = 149.995 -> 150.00 (2dp)
    expect(summary.progressToNextTierGBP).toBe(150);
    expect(summary.progressToNextTierGBP).toBeGreaterThanOrEqual(0);
  });

  it("reports zero remaining exactly at the next threshold boundary before advancement", () => {
    // £299.99 is still Bronze; £0.01 remains to Silver.
    const summary = buildTierSummary(299.99, "bronze");
    expect(summary.tier).toBe("bronze");
    expect(summary.progressToNextTierGBP).toBe(0.01);
  });

  it("reflects the retained tier, never below what the customer achieved (Req 7.3, 7.7)", () => {
    // Retained Gold with low spend: summary still shows Gold and progress to Royal_VIP.
    const summary = buildTierSummary(50, "gold");
    expect(summary.tier).toBe("gold");
    expect(summary.nextTier).toBe("royal_vip");
    expect(summary.progressToNextTierGBP).toBe(1450); // 1500 - 50
  });

  it("advances the reported tier when spend crosses a threshold", () => {
    const summary = buildTierSummary(800, "bronze");
    expect(summary.tier).toBe("gold");
    expect(summary.nextTier).toBe("royal_vip");
    expect(summary.progressToNextTierGBP).toBe(700);
  });
});

describe("buildTierSummary — Royal_VIP top-tier indicator (Req 7.6)", () => {
  it("marks Royal_VIP as the top tier with no higher tier", () => {
    const summary = buildTierSummary(2000, "royal_vip");
    expect(summary.tier).toBe("royal_vip");
    expect(summary.isTopTier).toBe(true);
    expect(summary.nextTier).toBeNull();
    expect(summary.nextTierThresholdGBP).toBeNull();
    expect(summary.progressToNextTierGBP).toBeNull();
  });

  it("non-top tiers are not flagged as top tier", () => {
    expect(buildTierSummary(0, "bronze").isTopTier).toBe(false);
    expect(buildTierSummary(300, "silver").isTopTier).toBe(false);
    expect(buildTierSummary(750, "gold").isTopTier).toBe(false);
  });

  it("clamps negative/non-finite lifetime spend to £0.00 in the summary", () => {
    const summary = buildTierSummary(-5, "bronze");
    expect(summary.lifetimeSpendGBP).toBe(0);
    expect(summary.progressToNextTierGBP).toBe(300);
  });
});

describe("config-driven rule sets (task 20.1 readiness)", () => {
  it("honours a custom rule set without changing the module", () => {
    const custom: TierRuleSet = {
      thresholds: { bronze: 0, silver: 100, gold: 200, royal_vip: 300 },
      multipliers: { bronze: 1, silver: 2, gold: 3, royal_vip: 4 },
    };
    expect(deriveTier(150, custom)).toBe("silver");
    expect(tierMultiplier("gold", custom)).toBe(3);
    const summary = buildTierSummary(150, "bronze", custom);
    expect(summary.tier).toBe("silver");
    expect(summary.progressToNextTierGBP).toBe(50); // 200 - 150
  });

  it("defaults match the design constants (Req 7.1, 7.4)", () => {
    expect(DEFAULT_TIER_RULES.thresholds).toEqual(TIER_THRESHOLDS_GBP);
    expect(DEFAULT_TIER_RULES.multipliers).toEqual(TIER_MULTIPLIERS);
    expect(TIER_THRESHOLDS_GBP).toEqual({ bronze: 0, silver: 300, gold: 750, royal_vip: 1500 });
    expect(TIER_MULTIPLIERS).toEqual({ bronze: 1, silver: 1.5, gold: 2, royal_vip: 3 });
  });
});
