/**
 * VIP membership tier logic (task 4.3): tier derivation, monotonic advancement,
 * earning-multiplier lookup, and the tier-progress summary.
 *
 * This module is the pure, side-effect-free core of Requirement 7 (VIP
 * membership tiers) and the tier-multiplier half of Requirement 2.4. It owns:
 *
 *   - {@link deriveTier}       Tier from cumulative lifetime GBP spend, using
 *                              inclusive lower thresholds Bronze £0–299.99,
 *                              Silver £300–749.99, Gold £750–1499.99,
 *                              Royal_VIP £1500+ (Req 7.1).
 *   - {@link advanceTier}      On order completion, advance to the highest tier
 *                              met and NEVER lower it — the retained tier is
 *                              held for the account's lifetime (Req 7.2, 7.3,
 *                              7.7; Property 11).
 *   - {@link tierMultiplier}   Earning multiplier Bronze 1x / Silver 1.5x /
 *                              Gold 2x / Royal_VIP 3x, defaulting to Bronze 1x
 *                              when the tier is undefined or unrecognized
 *                              (Req 2.4, 7.4).
 *   - {@link buildTierSummary} The account-data view: current tier, lifetime
 *                              spend to two decimal places, and progress toward
 *                              the next tier as the remaining GBP required — or
 *                              a top-tier indicator for Royal_VIP (Req 7.5, 7.6).
 *
 * CONFIG NOTE: the thresholds/multipliers are read from a {@link TierRuleSet}.
 * A default GBP rule set ({@link DEFAULT_TIER_RULES}) matching the design's
 * `TIER_THRESHOLDS_GBP` / `TIER_MULTIPLIER` constants is provided and used when
 * no rule set is supplied. Every function accepts an explicit rule set so the
 * config-driven market rules of task 20.1 can be layered on WITHOUT changing
 * this module (the design externalises these into `earning_rule_sets`).
 *
 * SAFETY: this is pure computation. It touches no database, no Shopify API, and
 * no live system; it only maps numbers to tiers. Persisting a tier change (e.g.
 * writing `customers.tier` or a `tier_change_history` row) is the earning
 * engine's job (task 4.2) and is intentionally NOT done here.
 */

/**
 * The four membership tiers, ordered ascending by rank (Bronze lowest,
 * Royal_VIP highest). The multiplier is non-decreasing across this order
 * (Req 7.4). Array index doubles as the tier rank (see {@link tierRank}).
 */
export const TIERS = ["bronze", "silver", "gold", "royal_vip"] as const;

/** A membership tier identifier. */
export type Tier = (typeof TIERS)[number];

/** The tier applied when a tier value is undefined or unrecognized (Req 2.4, 7.4). */
export const DEFAULT_TIER: Tier = "bronze";

/**
 * A tier rule set: the inclusive lower spend thresholds (in the rule set's
 * currency, GBP at MVP per A8) and the per-tier earning multipliers. Kept as a
 * parameter so market/config-driven rule sets (task 20.1) can replace the
 * hardcoded defaults without editing this module.
 */
export interface TierRuleSet {
  /** Inclusive lower bound of each tier, ascending with rank. Bronze must be 0. */
  readonly thresholds: Readonly<Record<Tier, number>>;
  /** Earning multiplier for each tier; non-decreasing with rank (Req 7.4). */
  readonly multipliers: Readonly<Record<Tier, number>>;
}

/**
 * Default GBP thresholds — matches the design's `TIER_THRESHOLDS_GBP`
 * (Req 7.1): Bronze £0, Silver £300, Gold £750, Royal_VIP £1500 (inclusive
 * lower bounds).
 */
export const TIER_THRESHOLDS_GBP: Readonly<Record<Tier, number>> = {
  bronze: 0,
  silver: 300,
  gold: 750,
  royal_vip: 1500,
} as const;

/**
 * Default earning multipliers — matches the design's `TIER_MULTIPLIER`
 * (Req 7.4): Bronze 1x, Silver 1.5x, Gold 2x, Royal_VIP 3x.
 */
export const TIER_MULTIPLIERS: Readonly<Record<Tier, number>> = {
  bronze: 1,
  silver: 1.5,
  gold: 2,
  royal_vip: 3,
} as const;

/** The default GBP rule set used when a caller supplies none. */
export const DEFAULT_TIER_RULES: TierRuleSet = {
  thresholds: TIER_THRESHOLDS_GBP,
  multipliers: TIER_MULTIPLIERS,
} as const;

/**
 * The account-data view of a customer's tier standing (Req 7.5, 7.6).
 * Returned by {@link buildTierSummary}.
 */
export interface TierSummary {
  /** The customer's current (retained) tier. */
  tier: Tier;
  /** The tier's earning multiplier (Req 7.4). */
  multiplier: number;
  /** Cumulative lifetime spend in GBP, rounded to two decimal places (Req 7.5). */
  lifetimeSpendGBP: number;
  /** True iff the customer is at the highest tier (Royal_VIP) — no higher tier exists (Req 7.6). */
  isTopTier: boolean;
  /** The next higher tier, or null when already at the top tier (Req 7.6). */
  nextTier: Tier | null;
  /** The next higher tier's inclusive lower threshold in GBP, or null at the top tier. */
  nextTierThresholdGBP: number | null;
  /**
   * Remaining GBP required to reach the next higher tier's lower threshold,
   * rounded to two decimal places and never negative (Req 7.5); null when the
   * customer is at the top tier, indicating no higher tier exists (Req 7.6).
   */
  progressToNextTierGBP: number | null;
}

const TIER_SET: ReadonlySet<string> = new Set<string>(TIERS);

/** Rounds a money amount to two decimal places, avoiding binary-float drift. */
function roundGBP(amount: number): number {
  // e.g. 299.995 -> 300.00; the +EPSILON scaling corrects representations like 1.005.
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Clamps a non-finite or negative spend to a safe, non-negative number. */
function normalizeSpend(lifetimeSpendGBP: number): number {
  if (typeof lifetimeSpendGBP !== "number" || !Number.isFinite(lifetimeSpendGBP)) {
    return 0;
  }
  return lifetimeSpendGBP > 0 ? lifetimeSpendGBP : 0;
}

/**
 * The rank of a tier (0 = Bronze … 3 = Royal_VIP). Higher rank = higher tier.
 * A recognized tier always has a rank >= 0.
 */
export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/**
 * Coerces an arbitrary/untrusted tier value to a known {@link Tier}, returning
 * {@link DEFAULT_TIER} (Bronze) when the value is undefined, null, or not one of
 * the recognized tiers (Req 2.4, 7.4).
 */
export function normalizeTier(value: string | null | undefined): Tier {
  return typeof value === "string" && TIER_SET.has(value) ? (value as Tier) : DEFAULT_TIER;
}

/**
 * Derives the membership tier from cumulative lifetime GBP spend using inclusive
 * lower thresholds (Req 7.1). Scans from the highest tier down and returns the
 * first whose threshold the spend reaches or exceeds; a spend below every
 * threshold (including a negative or non-finite spend) yields {@link DEFAULT_TIER}.
 *
 * With the default GBP rules: £0–299.99 → Bronze, £300–749.99 → Silver,
 * £750–1499.99 → Gold, £1500+ → Royal_VIP.
 *
 * @param lifetimeSpendGBP cumulative lifetime spend in the rule set's currency.
 * @param rules            tier rule set to apply (defaults to GBP defaults).
 */
export function deriveTier(
  lifetimeSpendGBP: number,
  rules: TierRuleSet = DEFAULT_TIER_RULES,
): Tier {
  const spend = normalizeSpend(lifetimeSpendGBP);
  for (let i = TIERS.length - 1; i >= 0; i -= 1) {
    const tier = TIERS[i] as Tier;
    if (spend >= rules.thresholds[tier]) {
      return tier;
    }
  }
  return DEFAULT_TIER;
}

/**
 * Advances a customer's tier after processing a paid order (Req 7.2): returns
 * the higher of the tier derived from the updated lifetime spend and the tier
 * the customer already held. It NEVER lowers the tier — the retained tier is
 * held for the account's lifetime (Req 7.3, 7.7; Property 11). An
 * undefined/unrecognized current tier is treated as Bronze (Req 2.4).
 *
 * Because lifetime spend is cumulative and non-decreasing, the derived tier is
 * normally >= the retained tier; the explicit `max` guards against any
 * out-of-band lowering (e.g. a clawback policy) so order processing itself can
 * only advance, never demote.
 *
 * @param currentTier      the tier held immediately before processing (may be
 *                         undefined/unrecognized → Bronze).
 * @param lifetimeSpendGBP the updated cumulative lifetime spend.
 * @param rules            tier rule set to apply (defaults to GBP defaults).
 */
export function advanceTier(
  currentTier: string | null | undefined,
  lifetimeSpendGBP: number,
  rules: TierRuleSet = DEFAULT_TIER_RULES,
): Tier {
  const current = normalizeTier(currentTier);
  const derived = deriveTier(lifetimeSpendGBP, rules);
  return tierRank(derived) >= tierRank(current) ? derived : current;
}

/**
 * Looks up a tier's earning multiplier (Req 2.4, 7.4). Defaults to the Bronze
 * multiplier (1x) when the tier is undefined or unrecognized.
 *
 * @param tier  the tier whose multiplier to return (may be undefined/unrecognized).
 * @param rules tier rule set to apply (defaults to GBP defaults).
 */
export function tierMultiplier(
  tier: string | null | undefined,
  rules: TierRuleSet = DEFAULT_TIER_RULES,
): number {
  return rules.multipliers[normalizeTier(tier)];
}

/**
 * Builds the account-data tier summary (Req 7.5, 7.6): the current tier, its
 * multiplier, lifetime spend to two decimal places, and the progress toward the
 * next tier expressed as the remaining GBP to reach the next higher tier's lower
 * threshold. For Royal_VIP (the top tier) the progress is reported as null with
 * `isTopTier = true`, indicating no higher tier exists (Req 7.6).
 *
 * The reported tier is the customer's RETAINED tier: it is at least the passed
 * `currentTier` and at least the tier derived from the spend, so the summary
 * never shows a tier below what the customer has already achieved (Req 7.3, 7.7).
 *
 * @param lifetimeSpendGBP cumulative lifetime spend in the rule set's currency.
 * @param currentTier      the customer's retained tier (may be
 *                         undefined/unrecognized → Bronze); the summary never
 *                         reports below this.
 * @param rules            tier rule set to apply (defaults to GBP defaults).
 */
export function buildTierSummary(
  lifetimeSpendGBP: number,
  currentTier?: string | null,
  rules: TierRuleSet = DEFAULT_TIER_RULES,
): TierSummary {
  const spend = normalizeSpend(lifetimeSpendGBP);
  const tier = advanceTier(currentTier, spend, rules);
  const multiplier = rules.multipliers[tier];
  const lifetimeSpendGBP2dp = roundGBP(spend);

  const nextIndex = tierRank(tier) + 1;
  const isTopTier = nextIndex >= TIERS.length;

  if (isTopTier) {
    // Royal_VIP: highest tier reached, no higher tier exists (Req 7.6).
    return {
      tier,
      multiplier,
      lifetimeSpendGBP: lifetimeSpendGBP2dp,
      isTopTier: true,
      nextTier: null,
      nextTierThresholdGBP: null,
      progressToNextTierGBP: null,
    };
  }

  const nextTier = TIERS[nextIndex] as Tier;
  const nextTierThresholdGBP = rules.thresholds[nextTier];
  const remaining = roundGBP(Math.max(0, nextTierThresholdGBP - spend));

  return {
    tier,
    multiplier,
    lifetimeSpendGBP: lifetimeSpendGBP2dp,
    isTopTier: false,
    nextTier,
    nextTierThresholdGBP,
    progressToNextTierGBP: remaining,
  };
}
