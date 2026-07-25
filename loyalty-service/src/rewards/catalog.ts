/**
 * The redeemable reward catalog (task 5.1).
 *
 * This module is the single source of truth for the four redeemable rewards
 * defined by Requirement 3.1: exactly `100→£5`, `250→£15`, `500→£35`,
 * `1000→£75`. It owns:
 *
 *   - {@link REWARDS}        The four rewards keyed by reward id, matching the
 *                            design's `REWARDS` constant (`cost` in points,
 *                            `gbp` value) — Req 3.1.
 *   - {@link REWARD_CATALOG} The catalog as an ordered array (cheapest first),
 *                            the shape returned by `GET /v1/rewards`.
 *   - {@link isRewardId}     A type guard for the four known reward ids.
 *   - {@link lookupReward}   A safe lookup returning the reward, or `undefined`
 *                            for any id outside the set (used by redemption to
 *                            reject invalid rewards — Req 3.10).
 *   - {@link getRewardOrThrow} A strict lookup that throws {@link UnknownRewardError}
 *                            for any id outside the set, so redemption (task 5.2)
 *                            can import it to satisfy the invalid-reward path.
 *
 * CONFIG NOTE: the catalog is intentionally a small, explicit constant here.
 * The design externalises the reward map into `reward_rule_sets` (task 20.1)
 * for multi-market readiness; when that lands, the config-driven map replaces
 * {@link REWARDS} WITHOUT changing this module's public shape.
 *
 * SAFETY: this is pure data + pure computation. It touches no database, no
 * Shopify API, and no live system. Minting the actual single-use discount code
 * for a redemption (Property 10) is the Admin Gateway's job (task 5.3) and is
 * intentionally NOT done here.
 */

/** A reward id — one of exactly four known rewards (Req 3.1). */
export type RewardId = "reward_5" | "reward_15" | "reward_35" | "reward_75";

/** A single redeemable reward: its id, point cost, and GBP value. */
export interface Reward {
  /** The stable reward identifier, e.g. `reward_5`. */
  readonly id: RewardId;
  /** The point cost to redeem this reward (Req 3.1). */
  readonly cost: number;
  /** The GBP discount value this reward converts into (Req 3.1). */
  readonly valueGBP: number;
  /**
   * When `true`, this reward is app-exclusive: it is granted ONLY when the
   * attributed Channel is `app` (Req 19.4, task 21.1). ADDITIVE and optional —
   * the four MVP rewards (Req 3.1) leave it unset, so they remain grantable on
   * every channel and no existing behaviour changes. Channel gating itself lives
   * in `../channel/channel.ts` (`isGrantableOnChannel`), keeping this module pure
   * data.
   */
  readonly appExclusive?: boolean;
}

/**
 * The four rewards keyed by id. Values mirror the design's `REWARDS` constant
 * exactly: `reward_5 {cost:100, gbp:5}`, `reward_15 {cost:250, gbp:15}`,
 * `reward_35 {cost:500, gbp:35}`, `reward_75 {cost:1000, gbp:75}` (Req 3.1).
 */
export const REWARDS: Readonly<Record<RewardId, Reward>> = {
  reward_5: { id: "reward_5", cost: 100, valueGBP: 5 },
  reward_15: { id: "reward_15", cost: 250, valueGBP: 15 },
  reward_35: { id: "reward_35", cost: 500, valueGBP: 35 },
  reward_75: { id: "reward_75", cost: 1000, valueGBP: 75 },
} as const;

/**
 * The complete set of known reward ids, ordered cheapest-first. Also the
 * iteration order of {@link REWARD_CATALOG}.
 */
export const REWARD_IDS: readonly RewardId[] = [
  "reward_5",
  "reward_15",
  "reward_35",
  "reward_75",
] as const;

/**
 * The catalog as an ordered array (cheapest reward first) — the exact shape
 * returned by `GET /v1/rewards`. Exactly four entries (Req 3.1).
 */
export const REWARD_CATALOG: readonly Reward[] = REWARD_IDS.map((id) => REWARDS[id]);

const REWARD_ID_SET: ReadonlySet<string> = new Set<string>(REWARD_IDS);

/**
 * Raised when a reward id outside the defined set is requested. Redemption
 * (task 5.2) maps this to an invalid-reward error for the caller (Req 3.10).
 */
export class UnknownRewardError extends Error {
  /** The offending, unrecognized reward id (as received). */
  readonly rewardId: string;

  constructor(rewardId: string) {
    super(`unknown_reward: ${rewardId}`);
    this.name = "UnknownRewardError";
    this.rewardId = rewardId;
  }
}

/**
 * Type guard: true iff `value` is one of the four known reward ids (Req 3.1).
 * Rejects everything else — unknown strings, empty string, and non-strings —
 * which is the basis for the invalid-reward rejection (Req 3.10).
 */
export function isRewardId(value: unknown): value is RewardId {
  return typeof value === "string" && REWARD_ID_SET.has(value);
}

/**
 * Safe lookup: returns the {@link Reward} for a known id, or `undefined` for any
 * id outside the defined set (Req 3.10). Callers that need a hard failure use
 * {@link getRewardOrThrow}.
 */
export function lookupReward(rewardId: unknown): Reward | undefined {
  return isRewardId(rewardId) ? REWARDS[rewardId] : undefined;
}

/**
 * Strict lookup: returns the {@link Reward} for a known id, or throws
 * {@link UnknownRewardError} for any id outside the defined set (Req 3.10).
 * Redemption uses this to reject invalid rewards before touching the ledger.
 */
export function getRewardOrThrow(rewardId: unknown): Reward {
  const reward = lookupReward(rewardId);
  if (reward === undefined) {
    throw new UnknownRewardError(typeof rewardId === "string" ? rewardId : String(rewardId));
  }
  return reward;
}
