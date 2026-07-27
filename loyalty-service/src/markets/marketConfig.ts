/**
 * Market / rule-set configuration provider (task 20.1) — design.md "Market /
 * Rule-set config" (`markets`, `earning_rule_sets`, `reward_rule_sets`) and
 * Requirement 21 (international / configuration readiness).
 *
 * **STATUS (task 32 decision, A18): the engine does NOT read this module.** The
 * hardcoded constants (`DEFAULT_TIER_RULES`, `REWARDS`) remain the MVP source of
 * truth; this provider is the retained, tested forward path for a second market,
 * and its only production call site is the read-only drift check in
 * `configDrift.ts` that publishes on `/health` whether the configured rows still
 * agree with those constants. Wiring it into the earning and redemption paths was
 * evaluated and declined — see A18 and criterion 21.6a for the reasoning.
 *
 * It resolves the active market's rule sets into the exact shapes the rest of
 * the engine already consumes, so that wiring remains a small change when a
 * second market arrives:
 *
 *   - a {@link TierRuleSet} (thresholds + multipliers) for the tier module
 *     (`deriveTier` / `advanceTier` / `tierMultiplier` / `buildTierSummary`),
 *     which already accept an injected rule set (task 4.3); and
 *   - a reward catalog ({@link Reward}[] + a by-id map) for the reward /
 *     redemption path (task 5.1/5.2), identical in shape to `REWARD_CATALOG`.
 *
 * WHERE only the Base_Currency market is configured, the base GBP rule set is
 * applied to ALL customers (Req 21.6): the provider resolves the single active
 * market's rule sets regardless of the customer. When NO market config exists
 * yet (e.g. before the seed migration runs, or in a pure unit test), it falls
 * back to {@link DEFAULT_MARKET_CONFIG} — the GBP defaults derived from the
 * existing constants — so behaviour is unchanged.
 *
 * ADDITIVE & LEDGER-AGNOSTIC (Req 21.2, 21.4, 21.7): adding a market or a rule
 * set is a data change (new rows), never a schema/ledger change. Every
 * money-bearing config record carries an explicit `currency`; the ledger itself
 * stays currency-agnostic (points are unitless), so nothing here writes a
 * currency onto `ledger_entries`.
 *
 * DB access is abstracted behind {@link Queryable} (satisfied by a `pg` Pool or
 * PoolClient), so resolution can join a caller's transaction and every path is
 * unit-testable against an in-memory fake with no live database.
 *
 * SAFETY: defining this module touches no live/production system. It issues SQL
 * only when a caller passes a real Pool/PoolClient at runtime; all logic is
 * unit-tested against an in-memory fake Queryable, so no live system is touched
 * during verification.
 */
import { z } from "zod";
import type { QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { DEFAULT_TIER_RULES, TIERS, type Tier, type TierRuleSet } from "../tier/tier.js";
import { REWARD_IDS, REWARDS, type Reward, type RewardId } from "../rewards/catalog.js";
import {
  BASE_CURRENCY,
  BASE_LANGUAGE,
  BASE_MARKET_CODE,
} from "./market-definitions.js";

/**
 * A resolved market's config, in the shapes the engine consumes. Produced by a
 * {@link MarketConfigProvider}.
 */
export interface MarketConfig {
  /** The active market (Req 21.3). `currency` is money-bearing → explicit (A8). */
  market: {
    code: string;
    /** The market's Base_Currency (GBP at MVP). */
    currency: string;
    /** The market's default language (localizable — Req 21.5). */
    language: string;
  };
  /** Earning rules for the tier engine, plus the money-bearing currency. */
  earning: {
    /** The rule set's explicit currency (GBP at MVP). */
    currency: string;
    /** Thresholds + multipliers, ready to pass to the tier module (task 4.3). */
    rules: TierRuleSet;
  };
  /** Reward config for the redemption path, plus the money-bearing currency. */
  reward: {
    /** The rule set's explicit currency (GBP at MVP). */
    currency: string;
    /** The catalog ordered cheapest-first (shape of `REWARD_CATALOG`). */
    catalog: readonly Reward[];
    /** The rewards keyed by id (shape of `REWARDS`). */
    rewardsById: Readonly<Record<RewardId, Reward>>;
  };
}

/**
 * The GBP default config, derived from the existing hardcoded constants
 * ({@link DEFAULT_TIER_RULES}, {@link REWARDS}) so it reproduces the current
 * behaviour EXACTLY. Used as the fallback when no market rows are configured
 * (Req 21.6 base posture), and by {@link StaticMarketConfigProvider}.
 */
export const DEFAULT_MARKET_CONFIG: MarketConfig = {
  market: {
    code: BASE_MARKET_CODE,
    currency: BASE_CURRENCY,
    language: BASE_LANGUAGE,
  },
  earning: {
    currency: BASE_CURRENCY,
    rules: DEFAULT_TIER_RULES,
  },
  reward: {
    currency: BASE_CURRENCY,
    catalog: REWARD_IDS.map((id) => REWARDS[id]),
    rewardsById: REWARDS,
  },
};

/** The contract the engine depends on to read rule-set config. */
export interface MarketConfigProvider {
  /**
   * Resolves the active market's config. WHERE only the base market is
   * configured, this returns that market's rule sets for ALL customers
   * (Req 21.6). When no market config exists, returns {@link DEFAULT_MARKET_CONFIG}.
   */
  loadActiveMarketConfig(): Promise<MarketConfig>;
}

/**
 * A fixed-config provider (defaults to the GBP {@link DEFAULT_MARKET_CONFIG}).
 * Handy for tests and for wiring the engine before a DB is available, keeping
 * behaviour identical to the pre-config hardcoded path.
 */
export class StaticMarketConfigProvider implements MarketConfigProvider {
  constructor(private readonly config: MarketConfig = DEFAULT_MARKET_CONFIG) {}

  async loadActiveMarketConfig(): Promise<MarketConfig> {
    return this.config;
  }
}

/* ----------------------------- validation --------------------------------- */

/** A per-tier numeric record covering exactly the four known tiers. */
const tierRecordSchema = z.object({
  bronze: z.number().finite(),
  silver: z.number().finite(),
  gold: z.number().finite(),
  royal_vip: z.number().finite(),
});

const rewardMapEntrySchema = z.object({
  cost: z.number().int().positive(),
  value: z.number().nonnegative(),
});

/** The reward map must define exactly the four known reward ids (Req 3.1). */
const rewardMapSchema = z.object({
  reward_5: rewardMapEntrySchema,
  reward_15: rewardMapEntrySchema,
  reward_35: rewardMapEntrySchema,
  reward_75: rewardMapEntrySchema,
});

/** Thrown when a configured rule set is malformed; the engine must fail closed. */
export class InvalidMarketConfigError extends Error {
  readonly code = "invalid_market_config";
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "InvalidMarketConfigError";
    this.cause = cause;
  }
}

/* ----------------------------- SQL statements ----------------------------- */

/** The active market (the single market operated at MVP, per A9). */
const SELECT_ACTIVE_MARKET_SQL = `
  SELECT id, code, base_currency, language
  FROM markets
  WHERE active = true
  ORDER BY code
  LIMIT 1
`;

/** The active earning rule set for a market. */
const SELECT_ACTIVE_EARNING_RULE_SET_SQL = `
  SELECT currency, tier_thresholds, tier_multipliers
  FROM earning_rule_sets
  WHERE market_id = $1 AND active = true
  LIMIT 1
`;

/** The active reward rule set for a market. */
const SELECT_ACTIVE_REWARD_RULE_SET_SQL = `
  SELECT currency, reward_map
  FROM reward_rule_sets
  WHERE market_id = $1 AND active = true
  LIMIT 1
`;

/* -------------------------------- DB rows --------------------------------- */

interface MarketDbRow extends QueryResultRow {
  id: string;
  code: string;
  base_currency: string;
  language: string;
}

interface EarningRuleSetDbRow extends QueryResultRow {
  currency: string;
  tier_thresholds: unknown;
  tier_multipliers: unknown;
}

interface RewardRuleSetDbRow extends QueryResultRow {
  currency: string;
  reward_map: unknown;
}

/** Coerces a JSONB column (`pg` may hand back an object or a JSON string) to a value. */
function parseJsonColumn(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (cause) {
      throw new InvalidMarketConfigError("A rule-set JSONB column was not valid JSON.", cause);
    }
  }
  return value;
}

/** Builds a {@link TierRuleSet} from a validated earning-rule-set row. */
function toTierRuleSet(row: EarningRuleSetDbRow): TierRuleSet {
  const thresholds = tierRecordSchema.safeParse(parseJsonColumn(row.tier_thresholds));
  const multipliers = tierRecordSchema.safeParse(parseJsonColumn(row.tier_multipliers));
  if (!thresholds.success) {
    throw new InvalidMarketConfigError(
      "earning_rule_sets.tier_thresholds is missing a tier or has a non-numeric value.",
      thresholds.error,
    );
  }
  if (!multipliers.success) {
    throw new InvalidMarketConfigError(
      "earning_rule_sets.tier_multipliers is missing a tier or has a non-numeric value.",
      multipliers.error,
    );
  }
  // Rebuild through TIERS so the object shape is exactly Record<Tier, number>.
  const thresholdRecord = {} as Record<Tier, number>;
  const multiplierRecord = {} as Record<Tier, number>;
  for (const tier of TIERS) {
    thresholdRecord[tier] = thresholds.data[tier];
    multiplierRecord[tier] = multipliers.data[tier];
  }
  return { thresholds: thresholdRecord, multipliers: multiplierRecord };
}

/** Builds the reward catalog (array + by-id map) from a validated reward-rule-set row. */
function toRewardCatalog(row: RewardRuleSetDbRow): {
  catalog: Reward[];
  rewardsById: Record<RewardId, Reward>;
} {
  const parsed = rewardMapSchema.safeParse(parseJsonColumn(row.reward_map));
  if (!parsed.success) {
    throw new InvalidMarketConfigError(
      "reward_rule_sets.reward_map must define exactly reward_5/reward_15/reward_35/reward_75 " +
        "with a positive integer cost and non-negative value.",
      parsed.error,
    );
  }
  const rewardsById = {} as Record<RewardId, Reward>;
  const catalog: Reward[] = [];
  for (const id of REWARD_IDS) {
    const entry = parsed.data[id];
    const reward: Reward = { id, cost: entry.cost, valueGBP: entry.value };
    rewardsById[id] = reward;
    catalog.push(reward);
  }
  return { catalog, rewardsById };
}

/**
 * Postgres/`Queryable`-backed {@link MarketConfigProvider}.
 *
 * Reads the single active market and its active earning/reward rule sets and
 * assembles the {@link MarketConfig} the engine consumes. Applies the resolved
 * market's rule sets to all customers (Req 21.6). Falls back to
 * {@link DEFAULT_MARKET_CONFIG} when no active market (or no rule set) is
 * configured, so the engine keeps the current GBP behaviour before/without the
 * seed.
 */
export class DbMarketConfigProvider implements MarketConfigProvider {
  constructor(private readonly db: Queryable) {}

  async loadActiveMarketConfig(): Promise<MarketConfig> {
    const marketResult = await this.db.query<MarketDbRow>(SELECT_ACTIVE_MARKET_SQL);
    const market = marketResult.rows[0];
    if (!market) {
      // No market configured yet → base GBP posture (Req 21.6, unchanged behaviour).
      return DEFAULT_MARKET_CONFIG;
    }

    const [earningResult, rewardResult] = await Promise.all([
      this.db.query<EarningRuleSetDbRow>(SELECT_ACTIVE_EARNING_RULE_SET_SQL, [market.id]),
      this.db.query<RewardRuleSetDbRow>(SELECT_ACTIVE_REWARD_RULE_SET_SQL, [market.id]),
    ]);

    const earningRow = earningResult.rows[0];
    const rewardRow = rewardResult.rows[0];

    // A configured market with no active rule set falls back to the GBP defaults
    // for that dimension, so a partially-seeded market still behaves correctly.
    const earning = earningRow
      ? { currency: earningRow.currency, rules: toTierRuleSet(earningRow) }
      : { currency: market.base_currency, rules: DEFAULT_MARKET_CONFIG.earning.rules };

    const reward = rewardRow
      ? { currency: rewardRow.currency, ...toRewardCatalog(rewardRow) }
      : {
          currency: market.base_currency,
          catalog: DEFAULT_MARKET_CONFIG.reward.catalog,
          rewardsById: DEFAULT_MARKET_CONFIG.reward.rewardsById,
        };

    return {
      market: {
        code: market.code,
        currency: market.base_currency,
        language: market.language,
      },
      earning,
      reward,
    };
  }
}
