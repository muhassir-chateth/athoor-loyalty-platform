/**
 * Unit tests for the Market / rule-set config provider (task 20.1) —
 * Requirement 21 and design.md "Market / Rule-set config".
 *
 * NO live/production database is touched. The DB-backed provider is exercised
 * against an in-memory fake {@link Queryable} that models the three config
 * tables (`markets`, `earning_rule_sets`, `reward_rule_sets`) by matching on the
 * SQL text the provider issues.
 *
 * Covers:
 *   - the GBP defaults reproduce the current hardcoded behaviour EXACTLY, so
 *     migrating changes nothing for existing customers (Req 21.1, 21.6);
 *   - the ledger stays currency-agnostic while money-bearing config carries an
 *     explicit currency (Req 21.2);
 *   - WHERE only the base market is configured, its rule set is applied for all
 *     customers (Req 21.6);
 *   - a market with no rule sets falls back to the GBP defaults per dimension;
 *   - no configured market falls back to DEFAULT_MARKET_CONFIG (unchanged behaviour);
 *   - a market can carry a non-GBP currency and different thresholds/rewards
 *     additively, with no ledger change (Req 21.4, 21.7);
 *   - malformed rule-set JSON fails closed (InvalidMarketConfigError).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { DEFAULT_TIER_RULES } from "../tier/tier.js";
import { REWARD_CATALOG, REWARDS } from "../rewards/catalog.js";
import {
  DbMarketConfigProvider,
  DEFAULT_MARKET_CONFIG,
  InvalidMarketConfigError,
  StaticMarketConfigProvider,
} from "./marketConfig.js";

/* --------------------------------- fakes ---------------------------------- */

interface FakeRows {
  market?: Record<string, unknown> | null;
  earning?: Record<string, unknown> | null;
  reward?: Record<string, unknown> | null;
}

/**
 * Builds a fake Queryable that returns the configured rows based on which of
 * the provider's three SELECTs is issued. A `null`/absent value yields no rows.
 */
function makeDb(rows: FakeRows): Queryable {
  const result = <T extends QueryResultRow>(data: Array<Record<string, unknown>> | null | undefined): QueryResult<T> => {
    const r = (data ?? []) as unknown as T[];
    return {
      rows: r,
      rowCount: r.length,
      command: "SELECT",
      oid: 0,
      fields: [],
    };
  };

  return {
    async query<T extends QueryResultRow>(text: string): Promise<QueryResult<T>> {
      if (text.includes("FROM markets")) {
        return result<T>(rows.market ? [rows.market] : []);
      }
      if (text.includes("FROM earning_rule_sets")) {
        return result<T>(rows.earning ? [rows.earning] : []);
      }
      if (text.includes("FROM reward_rule_sets")) {
        return result<T>(rows.reward ? [rows.reward] : []);
      }
      throw new Error(`Unexpected SQL in fake: ${text}`);
    },
  } as unknown as Queryable;
}

const UK_MARKET = { id: "m-uk", code: "UK", base_currency: "GBP", language: "en" };
const GBP_EARNING = {
  currency: "GBP",
  tier_thresholds: { bronze: 0, silver: 300, gold: 750, royal_vip: 1500 },
  tier_multipliers: { bronze: 1, silver: 1.5, gold: 2, royal_vip: 3 },
};
const GBP_REWARD = {
  currency: "GBP",
  reward_map: {
    reward_5: { cost: 100, value: 5 },
    reward_15: { cost: 250, value: 15 },
    reward_35: { cost: 500, value: 35 },
    reward_75: { cost: 1000, value: 75 },
  },
};

/* --------------------------------- tests ---------------------------------- */

describe("DEFAULT_MARKET_CONFIG — reproduces current behaviour exactly (Req 21.1, 21.6)", () => {
  it("mirrors the hardcoded tier rules", () => {
    expect(DEFAULT_MARKET_CONFIG.earning.rules).toEqual(DEFAULT_TIER_RULES);
  });

  it("mirrors the hardcoded reward catalog", () => {
    expect(DEFAULT_MARKET_CONFIG.reward.catalog).toEqual(REWARD_CATALOG);
    expect(DEFAULT_MARKET_CONFIG.reward.rewardsById).toEqual(REWARDS);
  });

  it("is a single UK market denominated in GBP (money-bearing → explicit currency)", () => {
    expect(DEFAULT_MARKET_CONFIG.market.code).toBe("UK");
    expect(DEFAULT_MARKET_CONFIG.market.currency).toBe("GBP");
    expect(DEFAULT_MARKET_CONFIG.earning.currency).toBe("GBP");
    expect(DEFAULT_MARKET_CONFIG.reward.currency).toBe("GBP");
  });
});

describe("StaticMarketConfigProvider", () => {
  it("returns the GBP defaults by default", async () => {
    const provider = new StaticMarketConfigProvider();
    await expect(provider.loadActiveMarketConfig()).resolves.toEqual(DEFAULT_MARKET_CONFIG);
  });
});

describe("DbMarketConfigProvider — base market applies to all customers (Req 21.6)", () => {
  it("resolves the seeded UK GBP config identical to the defaults", async () => {
    const provider = new DbMarketConfigProvider(
      makeDb({ market: UK_MARKET, earning: GBP_EARNING, reward: GBP_REWARD }),
    );
    const config = await provider.loadActiveMarketConfig();

    expect(config.market).toEqual({ code: "UK", currency: "GBP", language: "en" });
    expect(config.earning.currency).toBe("GBP");
    expect(config.earning.rules).toEqual(DEFAULT_TIER_RULES);
    expect(config.reward.currency).toBe("GBP");
    expect(config.reward.catalog).toEqual(REWARD_CATALOG);
    expect(config.reward.rewardsById).toEqual(REWARDS);
  });

  it("parses rule sets delivered as JSON strings (pg JSONB variant)", async () => {
    const provider = new DbMarketConfigProvider(
      makeDb({
        market: UK_MARKET,
        earning: {
          currency: "GBP",
          tier_thresholds: JSON.stringify(GBP_EARNING.tier_thresholds),
          tier_multipliers: JSON.stringify(GBP_EARNING.tier_multipliers),
        },
        reward: { currency: "GBP", reward_map: JSON.stringify(GBP_REWARD.reward_map) },
      }),
    );
    const config = await provider.loadActiveMarketConfig();
    expect(config.earning.rules).toEqual(DEFAULT_TIER_RULES);
    expect(config.reward.catalog).toEqual(REWARD_CATALOG);
  });
});

describe("DbMarketConfigProvider — fallbacks keep behaviour unchanged", () => {
  it("falls back to DEFAULT_MARKET_CONFIG when no market is configured", async () => {
    const provider = new DbMarketConfigProvider(makeDb({ market: null }));
    await expect(provider.loadActiveMarketConfig()).resolves.toEqual(DEFAULT_MARKET_CONFIG);
  });

  it("falls back to GBP defaults per dimension when a market has no rule sets", async () => {
    const provider = new DbMarketConfigProvider(
      makeDb({ market: UK_MARKET, earning: null, reward: null }),
    );
    const config = await provider.loadActiveMarketConfig();
    expect(config.earning.rules).toEqual(DEFAULT_TIER_RULES);
    expect(config.reward.catalog).toEqual(REWARD_CATALOG);
    // The currency still reflects the configured market (money-bearing → explicit).
    expect(config.earning.currency).toBe("GBP");
  });
});

describe("DbMarketConfigProvider — additive multi-market readiness (Req 21.4, 21.7)", () => {
  it("resolves a non-GBP market with different thresholds/rewards without ledger change", async () => {
    const provider = new DbMarketConfigProvider(
      makeDb({
        market: { id: "m-eu", code: "EU", base_currency: "EUR", language: "fr" },
        earning: {
          currency: "EUR",
          tier_thresholds: { bronze: 0, silver: 350, gold: 900, royal_vip: 1800 },
          tier_multipliers: { bronze: 1, silver: 1.5, gold: 2, royal_vip: 3 },
        },
        reward: {
          currency: "EUR",
          reward_map: {
            reward_5: { cost: 100, value: 6 },
            reward_15: { cost: 250, value: 18 },
            reward_35: { cost: 500, value: 40 },
            reward_75: { cost: 1000, value: 85 },
          },
        },
      }),
    );
    const config = await provider.loadActiveMarketConfig();

    expect(config.market).toEqual({ code: "EU", currency: "EUR", language: "fr" });
    expect(config.earning.currency).toBe("EUR");
    expect(config.earning.rules.thresholds.silver).toBe(350);
    expect(config.reward.currency).toBe("EUR");
    expect(config.reward.rewardsById.reward_5.valueGBP).toBe(6);
    // Reward ids/costs remain the four known points costs (unitless on the ledger).
    expect(config.reward.catalog.map((r) => r.cost)).toEqual([100, 250, 500, 1000]);
  });
});

describe("DbMarketConfigProvider — fails closed on malformed config", () => {
  it("throws InvalidMarketConfigError when tier thresholds are incomplete", async () => {
    const provider = new DbMarketConfigProvider(
      makeDb({
        market: UK_MARKET,
        earning: {
          currency: "GBP",
          tier_thresholds: { bronze: 0, silver: 300 },
          tier_multipliers: GBP_EARNING.tier_multipliers,
        },
        reward: GBP_REWARD,
      }),
    );
    await expect(provider.loadActiveMarketConfig()).rejects.toBeInstanceOf(InvalidMarketConfigError);
  });

  it("throws InvalidMarketConfigError when the reward map is missing a reward", async () => {
    const provider = new DbMarketConfigProvider(
      makeDb({
        market: UK_MARKET,
        earning: GBP_EARNING,
        reward: {
          currency: "GBP",
          reward_map: { reward_5: { cost: 100, value: 5 } },
        },
      }),
    );
    await expect(provider.loadActiveMarketConfig()).rejects.toBeInstanceOf(InvalidMarketConfigError);
  });

  it("throws InvalidMarketConfigError when a JSONB column is not valid JSON", async () => {
    const provider = new DbMarketConfigProvider(
      makeDb({
        market: UK_MARKET,
        earning: {
          currency: "GBP",
          tier_thresholds: "{not valid json",
          tier_multipliers: GBP_EARNING.tier_multipliers,
        },
        reward: GBP_REWARD,
      }),
    );
    await expect(provider.loadActiveMarketConfig()).rejects.toBeInstanceOf(InvalidMarketConfigError);
  });
});
