/**
 * Market-config drift detection (task 32) — Req 21.1–21.4, 21.6, 21.6a, A18.
 *
 * The owner's decision is that the hardcoded constants remain the MVP source of
 * truth and the rule-set tables stay as the forward path for a second market.
 * That leaves two representations of the same rules with only one obeyed, so
 * these tests pin the check that makes the deviation observable:
 *
 *   - the AS-SEEDED configuration reports NO drift, which is the standing
 *     assertion that the tables and the constants agree today;
 *   - every individual field that could diverge is detected and named;
 *   - an unreadable or malformed configuration is reported as drift with its
 *     reason, never swallowed and never thrown at the caller;
 *   - the report always states `source: "constants"`, so nobody reading it can
 *     mistake which representation the engine obeys.
 *
 * The DEFINITION-level guard (seed definitions in code versus the constants)
 * already lives in `migrations.market-config.test.ts`. What was missing — and
 * what this covers — is the comparison against the values a provider actually
 * returns, which is what the running service and its database can diverge on.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateMarketConfigDrift,
  ProviderMarketConfigDriftSource,
  RULE_SOURCE_OF_TRUTH,
} from "./configDrift.js";
import {
  DEFAULT_MARKET_CONFIG,
  StaticMarketConfigProvider,
  type MarketConfig,
  type MarketConfigProvider,
} from "./marketConfig.js";
import { DEFAULT_TIER_RULES, TIERS } from "../tier/tier.js";
import { REWARDS, REWARD_IDS } from "../rewards/catalog.js";

/** A deep-ish clone so a test can perturb exactly one field. */
function cloneConfig(): MarketConfig {
  return {
    market: { ...DEFAULT_MARKET_CONFIG.market },
    earning: {
      currency: DEFAULT_MARKET_CONFIG.earning.currency,
      rules: {
        thresholds: { ...DEFAULT_MARKET_CONFIG.earning.rules.thresholds },
        multipliers: { ...DEFAULT_MARKET_CONFIG.earning.rules.multipliers },
      },
    },
    reward: {
      currency: DEFAULT_MARKET_CONFIG.reward.currency,
      catalog: [...DEFAULT_MARKET_CONFIG.reward.catalog],
      rewardsById: { ...DEFAULT_MARKET_CONFIG.reward.rewardsById },
    },
  };
}

describe("the as-seeded configuration agrees with the constants the engine obeys", () => {
  it("reports no drift for the default (as-seeded) config", () => {
    const report = evaluateMarketConfigDrift(DEFAULT_MARKET_CONFIG);

    expect(report.drifted).toBe(false);
    expect(report.differences).toEqual([]);
    expect(report.error).toBeUndefined();
  });

  it("always names the source of truth, so the report cannot be misread", () => {
    expect(evaluateMarketConfigDrift(DEFAULT_MARKET_CONFIG).source).toBe(RULE_SOURCE_OF_TRUTH);
    expect(RULE_SOURCE_OF_TRUTH).toBe("constants");
  });

  it("compares against the ACTUAL constants, not a second copy of them", () => {
    // If DEFAULT_MARKET_CONFIG ever stopped being derived from the constants this
    // whole check would be self-referential and worthless, so pin the linkage.
    for (const tier of TIERS) {
      expect(DEFAULT_MARKET_CONFIG.earning.rules.thresholds[tier]).toBe(
        DEFAULT_TIER_RULES.thresholds[tier],
      );
      expect(DEFAULT_MARKET_CONFIG.earning.rules.multipliers[tier]).toBe(
        DEFAULT_TIER_RULES.multipliers[tier],
      );
    }
    for (const id of REWARD_IDS) {
      expect(DEFAULT_MARKET_CONFIG.reward.rewardsById[id].cost).toBe(REWARDS[id].cost);
      expect(DEFAULT_MARKET_CONFIG.reward.rewardsById[id].valueGBP).toBe(REWARDS[id].valueGBP);
    }
  });
});

describe("every divergence is detected and named", () => {
  it.each(TIERS)("detects a changed %s threshold", (tier) => {
    const config = cloneConfig();
    config.earning.rules.thresholds[tier] = config.earning.rules.thresholds[tier] + 1;

    const report = evaluateMarketConfigDrift(config);

    expect(report.drifted).toBe(true);
    expect(report.differences.join(" ")).toContain(`earning.thresholds.${tier}`);
  });

  it.each(TIERS)("detects a changed %s multiplier", (tier) => {
    const config = cloneConfig();
    config.earning.rules.multipliers[tier] = 99;

    const report = evaluateMarketConfigDrift(config);

    expect(report.drifted).toBe(true);
    expect(report.differences.join(" ")).toContain(`earning.multipliers.${tier}`);
    expect(report.differences.join(" ")).toContain("99");
  });

  it.each(REWARD_IDS)("detects a changed %s cost", (id) => {
    const config = cloneConfig();
    config.reward.rewardsById = {
      ...config.reward.rewardsById,
      [id]: { ...config.reward.rewardsById[id], cost: 1 },
    };

    const report = evaluateMarketConfigDrift(config);

    expect(report.drifted).toBe(true);
    expect(report.differences.join(" ")).toContain(`reward.${id}.cost`);
  });

  it.each(REWARD_IDS)("detects a changed %s value", (id) => {
    const config = cloneConfig();
    config.reward.rewardsById = {
      ...config.reward.rewardsById,
      [id]: { ...config.reward.rewardsById[id], valueGBP: 999 },
    };

    const report = evaluateMarketConfigDrift(config);

    expect(report.drifted).toBe(true);
    expect(report.differences.join(" ")).toContain(`reward.${id}.value`);
  });

  it("detects a missing reward entry", () => {
    const config = cloneConfig();
    const { reward_5: _removed, ...rest } = config.reward.rewardsById;
    config.reward.rewardsById = rest as typeof config.reward.rewardsById;

    const report = evaluateMarketConfigDrift(config);

    expect(report.drifted).toBe(true);
    expect(report.differences.join(" ")).toContain("reward.reward_5 is missing");
  });

  it("detects a currency switch even when every number is unchanged (A8)", () => {
    // The state most likely to mislead: a market flipped to EUR while the engine
    // keeps treating the identical numbers as GBP.
    const config = cloneConfig();
    config.market.currency = "EUR";
    config.earning.currency = "EUR";
    config.reward.currency = "EUR";

    const report = evaluateMarketConfigDrift(config);

    expect(report.drifted).toBe(true);
    expect(report.differences.join(" ")).toContain("market.currency configured 'EUR'");
    expect(report.differences.join(" ")).toContain("earning.currency");
    expect(report.differences.join(" ")).toContain("reward.currency");
  });

  it("caps the reported differences so a wildly wrong row cannot bloat /health", () => {
    const config = cloneConfig();
    for (const tier of TIERS) {
      config.earning.rules.thresholds[tier] = -1;
      config.earning.rules.multipliers[tier] = -1;
    }
    for (const id of REWARD_IDS) {
      config.reward.rewardsById = {
        ...config.reward.rewardsById,
        [id]: { ...config.reward.rewardsById[id], cost: 1, valueGBP: 2 },
      };
    }
    config.market.currency = "EUR";
    config.earning.currency = "EUR";
    config.reward.currency = "EUR";

    const report = evaluateMarketConfigDrift(config);

    expect(report.drifted).toBe(true);
    expect(report.differences.length).toBeLessThanOrEqual(20);
  });
});

describe("ProviderMarketConfigDriftSource", () => {
  it("reports no drift when the provider returns the as-seeded config", async () => {
    const source = new ProviderMarketConfigDriftSource(new StaticMarketConfigProvider());

    await expect(source.report()).resolves.toMatchObject({
      source: "constants",
      drifted: false,
      differences: [],
    });
  });

  it("reports drift when the provider returns diverged values", async () => {
    const config = cloneConfig();
    config.earning.rules.thresholds.silver = 250;
    const source = new ProviderMarketConfigDriftSource(new StaticMarketConfigProvider(config));

    const report = await source.report();

    expect(report.drifted).toBe(true);
    expect(report.differences.join(" ")).toContain("earning.thresholds.silver configured 250");
  });

  it("reports an unreadable configuration as drift WITH the reason, and never throws", async () => {
    const broken: MarketConfigProvider = {
      loadActiveMarketConfig: async () => {
        throw new Error("earning_rule_sets.tier_thresholds is missing a tier");
      },
    };
    const source = new ProviderMarketConfigDriftSource(broken);

    const report = await source.report();

    // An unreadable rule set is at least as misleading as a wrong one, so it is
    // drift — but it must not propagate to the health probe as a failure.
    expect(report.drifted).toBe(true);
    expect(report.error).toContain("tier_thresholds");
    expect(report.differences).toEqual(["the configured rule set could not be read"]);
  });
});
