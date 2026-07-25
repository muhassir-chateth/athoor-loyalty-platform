/**
 * Unit tests for the reward catalog (task 5.1).
 *
 * Covers the exact catalog contents (Req 3.1) and the rejection of any reward
 * id outside the defined set via the lookups (Req 3.10) — the basis redemption
 * (task 5.2) relies on for its invalid-reward path.
 */
import { describe, it, expect } from "vitest";
import {
  REWARDS,
  REWARD_IDS,
  REWARD_CATALOG,
  UnknownRewardError,
  isRewardId,
  lookupReward,
  getRewardOrThrow,
  type Reward,
} from "./catalog.js";

describe("reward catalog contents (Req 3.1)", () => {
  it("defines exactly four rewards", () => {
    expect(REWARD_CATALOG).toHaveLength(4);
    expect(REWARD_IDS).toHaveLength(4);
    expect(Object.keys(REWARDS)).toHaveLength(4);
  });

  it("maps the exact point cost → GBP value for every reward", () => {
    expect(REWARDS.reward_5).toEqual({ id: "reward_5", cost: 100, valueGBP: 5 });
    expect(REWARDS.reward_15).toEqual({ id: "reward_15", cost: 250, valueGBP: 15 });
    expect(REWARDS.reward_35).toEqual({ id: "reward_35", cost: 500, valueGBP: 35 });
    expect(REWARDS.reward_75).toEqual({ id: "reward_75", cost: 1000, valueGBP: 75 });
  });

  it("exposes the catalog cheapest-first as { id, cost, valueGBP } entries", () => {
    expect(REWARD_CATALOG).toEqual([
      { id: "reward_5", cost: 100, valueGBP: 5 },
      { id: "reward_15", cost: 250, valueGBP: 15 },
      { id: "reward_35", cost: 500, valueGBP: 35 },
      { id: "reward_75", cost: 1000, valueGBP: 75 },
    ]);
  });

  it("orders REWARD_IDS ascending by cost", () => {
    expect(REWARD_IDS).toEqual(["reward_5", "reward_15", "reward_35", "reward_75"]);
    const costs = REWARD_CATALOG.map((r) => r.cost);
    for (let i = 1; i < costs.length; i += 1) {
      expect(costs[i]).toBeGreaterThan(costs[i - 1] as number);
    }
  });

  it("keeps every catalog entry consistent with the keyed REWARDS map", () => {
    for (const reward of REWARD_CATALOG) {
      expect(REWARDS[reward.id]).toEqual(reward);
    }
  });
});

describe("isRewardId — recognizes only the defined set (Req 3.1)", () => {
  it("accepts each known reward id", () => {
    for (const id of REWARD_IDS) {
      expect(isRewardId(id)).toBe(true);
    }
  });

  it("rejects unknown ids, empty string, and non-strings", () => {
    expect(isRewardId("reward_10")).toBe(false);
    expect(isRewardId("reward_5 ")).toBe(false); // trailing space
    expect(isRewardId("REWARD_5")).toBe(false); // case-sensitive
    expect(isRewardId("")).toBe(false);
    expect(isRewardId(undefined)).toBe(false);
    expect(isRewardId(null)).toBe(false);
    expect(isRewardId(100)).toBe(false);
    expect(isRewardId({ id: "reward_5" })).toBe(false);
  });
});

describe("lookupReward — safe lookup (Req 3.10)", () => {
  it("returns the reward for a known id", () => {
    const reward = lookupReward("reward_35");
    expect(reward).toEqual({ id: "reward_35", cost: 500, valueGBP: 35 });
  });

  it("returns undefined for any id outside the set", () => {
    expect(lookupReward("reward_10")).toBeUndefined();
    expect(lookupReward("")).toBeUndefined();
    expect(lookupReward(undefined)).toBeUndefined();
    expect(lookupReward(null)).toBeUndefined();
    expect(lookupReward(500)).toBeUndefined();
  });
});

describe("getRewardOrThrow — strict lookup rejects invalid rewards (Req 3.10)", () => {
  it("returns the reward for a known id", () => {
    const reward: Reward = getRewardOrThrow("reward_75");
    expect(reward).toEqual({ id: "reward_75", cost: 1000, valueGBP: 75 });
  });

  it("throws UnknownRewardError for an id outside the set", () => {
    expect(() => getRewardOrThrow("reward_10")).toThrow(UnknownRewardError);
    expect(() => getRewardOrThrow("")).toThrow(UnknownRewardError);
    expect(() => getRewardOrThrow(undefined)).toThrow(UnknownRewardError);
  });

  it("carries the offending reward id on the thrown error", () => {
    try {
      getRewardOrThrow("reward_999");
      expect.unreachable("expected getRewardOrThrow to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownRewardError);
      expect((err as UnknownRewardError).rewardId).toBe("reward_999");
    }
  });
});
