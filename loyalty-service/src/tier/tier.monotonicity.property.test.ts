/**
 * Property-based test for tier monotonicity (task 4.5).
 *
 * **Property 11 (Tier monotonic per order):** processing a paid order never
 * lowers a customer's tier. Because a paid order can only increase cumulative
 * lifetime spend (spend is cumulative and non-decreasing), applying
 * {@link advanceTier} for each processed order must yield a tier whose rank is
 * always greater than or equal to the tier held immediately before that order.
 *
 * **Validates: Requirements 7.3**
 *
 * This exercises the pure tier core ({@link advanceTier}, {@link tierRank},
 * {@link deriveTier}) with fast-check: an arbitrary starting tier and lifetime
 * spend, followed by an arbitrary sequence of non-negative spend increments
 * (each modelling one processed paid order). The invariant asserted is that the
 * retained tier's rank is monotonically non-decreasing across the whole
 * sequence and never drops below where it started.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  TIERS,
  advanceTier,
  deriveTier,
  tierRank,
  DEFAULT_TIER_RULES,
  type Tier,
  type TierRuleSet,
} from "./tier.js";

/** An arbitrary recognized tier (Bronze … Royal_VIP). */
const arbTier: fc.Arbitrary<Tier> = fc.constantFrom(...TIERS);

/**
 * An arbitrary lifetime spend in GBP: non-negative, finite, with pennies.
 * Bounded generously so the whole tier range (up to Royal_VIP £1500+) is
 * reachable while keeping shrinking fast.
 */
const arbSpend: fc.Arbitrary<number> = fc
  .double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true })
  .map((n) => Math.round(n * 100) / 100);

/**
 * A sequence of per-order spend increments. Each increment is >= 0 (a paid
 * order can only add to lifetime spend, and £0-eligible orders add nothing —
 * Req 2.3), modelling successive `orders/paid` events for one customer.
 */
const arbIncrements: fc.Arbitrary<number[]> = fc.array(
  fc.double({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true }).map((n) => Math.round(n * 100) / 100),
  { minLength: 0, maxLength: 25 },
);

describe("Property 11 — tier monotonic per order (Req 7.3)", () => {
  it("advanceTier never lowers the tier across a sequence of paid orders", () => {
    fc.assert(
      fc.property(arbTier, arbSpend, arbIncrements, (startTier, startSpend, increments) => {
        let tier: Tier = startTier;
        let spend = startSpend;

        for (const inc of increments) {
          const before = tier;
          spend += inc; // a paid order only ever increases lifetime spend
          tier = advanceTier(before, spend);

          // Core invariant (Property 11 / Req 7.3): the retained tier is never
          // lowered by processing an order.
          expect(tierRank(tier)).toBeGreaterThanOrEqual(tierRank(before));
        }

        // The end tier is never below where the customer started.
        expect(tierRank(tier)).toBeGreaterThanOrEqual(tierRank(startTier));
      }),
    );
  });

  it("advanceTier never lowers the tier even when derived spend maps lower", () => {
    // Independent of spend direction: even if the derived tier from the current
    // spend is lower than the retained tier (e.g. an out-of-band adjustment),
    // advanceTier must retain the higher tier (Req 7.3, 7.7).
    fc.assert(
      fc.property(arbTier, arbSpend, (retained, spend) => {
        const result = advanceTier(retained, spend);
        expect(tierRank(result)).toBeGreaterThanOrEqual(tierRank(retained));
        // And it is also at least the tier the spend alone would derive.
        expect(tierRank(result)).toBeGreaterThanOrEqual(tierRank(deriveTier(spend)));
      }),
    );
  });

  it("holds under a custom (config-driven) rule set as well", () => {
    // Task 20.1 readiness: monotonicity is a property of advanceTier, not of the
    // specific GBP thresholds, so it must hold for any rule set.
    const custom: TierRuleSet = {
      thresholds: { bronze: 0, silver: 100, gold: 200, royal_vip: 300 },
      multipliers: { bronze: 1, silver: 2, gold: 3, royal_vip: 4 },
    };
    fc.assert(
      fc.property(
        arbTier,
        fc.array(fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }), {
          minLength: 0,
          maxLength: 25,
        }),
        (startTier, increments) => {
          let tier: Tier = startTier;
          let spend = 0;
          for (const inc of increments) {
            const before = tier;
            spend += inc;
            tier = advanceTier(before, spend, custom);
            expect(tierRank(tier)).toBeGreaterThanOrEqual(tierRank(before));
          }
        },
      ),
    );
  });

  it("sanity: DEFAULT_TIER_RULES multipliers are non-decreasing with rank", () => {
    // Guards the assumption underpinning why advancing is always desirable.
    const ranked = [...TIERS].sort((a, b) => tierRank(a) - tierRank(b));
    for (let i = 1; i < ranked.length; i += 1) {
      expect(DEFAULT_TIER_RULES.multipliers[ranked[i] as Tier]).toBeGreaterThanOrEqual(
        DEFAULT_TIER_RULES.multipliers[ranked[i - 1] as Tier],
      );
    }
  });
});
