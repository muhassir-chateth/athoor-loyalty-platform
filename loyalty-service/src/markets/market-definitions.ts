/**
 * Seed configuration for Market / rule-set config (task 20.1).
 *
 * Requirement 21 externalises today's tier thresholds, tier multipliers, and
 * the reward map OUT of hardcoded constants and INTO configuration the engine
 * reads — so per-Market currencies and rule sets become an ADDITIVE change (a
 * new `markets` row + rule-set rows) with no ledger redesign and no breaking
 * `/v1` change (Req 21.2, 21.4, 21.7).
 *
 * This module is the single, human-readable source of truth for the INITIAL
 * (base) market configuration: one active UK market denominated in the
 * Base_Currency GBP (A8), plus one active earning rule set and one active
 * reward rule set. The accompanying migration
 * (`*_create-market-config.ts`) seeds these exact values into the `markets`,
 * `earning_rule_sets`, and `reward_rule_sets` tables with idempotent INSERTs,
 * so the database and this module stay in lock-step (verified by
 * `src/migrations.market-config.test.ts`).
 *
 * CRITICAL — no behavioural change: the seeded rule-set values are DERIVED
 * directly from the existing hardcoded defaults `DEFAULT_TIER_RULES`
 * (`src/tier/tier.ts`) and `REWARDS` (`src/rewards/catalog.ts`). They therefore
 * reproduce the current GBP behaviour EXACTLY. With only the base market
 * configured, the GBP rule set applies to all customers (Req 21.6), so existing
 * (UK) customers see no change.
 *
 * The ledger stays currency-agnostic (points are unitless); only these
 * money-bearing config records carry an explicit `currency` (GBP at MVP).
 *
 * SAFETY: pure data + types. Importing this module touches no live system,
 * network, or database.
 */
import { DEFAULT_TIER_RULES, TIERS, type Tier } from "../tier/tier.js";
import { REWARD_IDS, REWARDS, type RewardId } from "../rewards/catalog.js";

/** The base market's code (the single UK market operated at MVP, per A9). */
export const BASE_MARKET_CODE = "UK" as const;

/** The Base_Currency all thresholds/rewards are denominated in today (A8). */
export const BASE_CURRENCY = "GBP" as const;

/** The base market's default language (English at MVP; localizable — Req 21.5). */
export const BASE_LANGUAGE = "en" as const;

/**
 * A market definition (Req 21.3). Mirrors the `markets` table columns so a
 * definition maps 1:1 to a seeded row.
 */
export interface MarketDefinition {
  /** Stable market code, unique across markets (e.g. `UK`). */
  code: string;
  /** The market's Base_Currency (GBP at MVP, A8). Money-bearing → explicit. */
  baseCurrency: string;
  /** The market's default language (localizable — Req 21.5). */
  language: string;
  /** Whether the market is currently active. */
  active: boolean;
}

/**
 * An earning rule set definition (Req 21.1, 21.4): tier thresholds + multipliers
 * moved out of hardcoded constants. Mirrors the `earning_rule_sets` columns.
 */
export interface EarningRuleSetDefinition {
  /** The rule set's currency (money-bearing → explicit; GBP at MVP). */
  currency: string;
  /** Inclusive lower spend thresholds per tier, in `currency`. */
  tierThresholds: Readonly<Record<Tier, number>>;
  /** Earning multiplier per tier. */
  tierMultipliers: Readonly<Record<Tier, number>>;
  /** Whether this rule set is the active one for its market. */
  active: boolean;
}

/** A single reward entry within a reward map: point `cost` → `value` in currency. */
export interface RewardMapEntry {
  /** Point cost to redeem this reward. */
  cost: number;
  /** Discount value this reward converts into, in the rule set's currency. */
  value: number;
}

/**
 * A reward rule set definition (Req 21.1, 21.4): the reward map moved out of the
 * hardcoded catalog. Mirrors the `reward_rule_sets` columns.
 */
export interface RewardRuleSetDefinition {
  /** The rule set's currency (money-bearing → explicit; GBP at MVP). */
  currency: string;
  /** The reward map keyed by reward id: `{ reward_5: { cost, value }, … }`. */
  rewardMap: Readonly<Record<RewardId, RewardMapEntry>>;
  /** Whether this rule set is the active one for its market. */
  active: boolean;
}

/** The initial base UK / GBP market (Req 21.1, 21.3, 21.6). */
export const BASE_MARKET: MarketDefinition = {
  code: BASE_MARKET_CODE,
  baseCurrency: BASE_CURRENCY,
  language: BASE_LANGUAGE,
  active: true,
} as const;

/**
 * The initial base earning rule set — the current hardcoded GBP tier thresholds
 * and multipliers, derived from {@link DEFAULT_TIER_RULES} so it reproduces the
 * present behaviour EXACTLY (Req 21.1, 21.6). Built from the tier module's
 * defaults rather than re-typed, so the two can never silently diverge.
 */
export const BASE_EARNING_RULE_SET: EarningRuleSetDefinition = {
  currency: BASE_CURRENCY,
  tierThresholds: TIERS.reduce(
    (acc, tier) => {
      acc[tier] = DEFAULT_TIER_RULES.thresholds[tier];
      return acc;
    },
    {} as Record<Tier, number>,
  ),
  tierMultipliers: TIERS.reduce(
    (acc, tier) => {
      acc[tier] = DEFAULT_TIER_RULES.multipliers[tier];
      return acc;
    },
    {} as Record<Tier, number>,
  ),
  active: true,
} as const;

/**
 * The initial base reward rule set — the current hardcoded reward map, derived
 * from {@link REWARDS} so it reproduces the present catalog EXACTLY (Req 21.1,
 * 21.6). Built from the catalog's constant rather than re-typed.
 */
export const BASE_REWARD_RULE_SET: RewardRuleSetDefinition = {
  currency: BASE_CURRENCY,
  rewardMap: REWARD_IDS.reduce(
    (acc, id) => {
      acc[id] = { cost: REWARDS[id].cost, value: REWARDS[id].valueGBP };
      return acc;
    },
    {} as Record<RewardId, RewardMapEntry>,
  ),
  active: true,
} as const;
