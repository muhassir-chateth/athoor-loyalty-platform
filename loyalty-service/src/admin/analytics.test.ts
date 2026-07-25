/**
 * Unit tests for the Admin Analytics pure computation core (task 17.3,
 * Requirement 20). Exercises metric derivation, date-range validation
 * (Req 20.4), the default range (Req 20.5), the `computedAt` passthrough
 * (Req 20.6), and determinism (Property 16 spirit).
 */
import { describe, expect, it } from "vitest";
import {
  computeAnalytics,
  defaultDateRange,
  validateDateRange,
  InvalidDateRangeError,
  type AnalyticsSource,
} from "./analytics.js";

const COMPUTED_AT = "2025-02-01T00:00:00.000Z";
const RANGE = { start: "2025-01-01T00:00:00.000Z", end: "2025-01-31T23:59:59.999Z" };

function iso(day: number): string {
  return new Date(Date.UTC(2025, 0, day, 12, 0, 0)).toISOString();
}

/** A small fixture: 3 customers, orders, ledger earns, and redemptions in Jan 2025. */
function fixture(): AnalyticsSource {
  return {
    customers: [
      { customerId: "c1", enrolledAt: iso(1) },
      { customerId: "c2", enrolledAt: iso(2) },
      { customerId: "c3", enrolledAt: null }, // not enrolled
    ],
    orders: [
      { customerId: "c1", eligibleTotalGBP: 100, createdAt: iso(3) },
      { customerId: "c1", eligibleTotalGBP: 200, createdAt: iso(10) }, // c1 repeat
      { customerId: "c2", eligibleTotalGBP: 300, createdAt: iso(5) },
    ],
    ledger: [
      { customerId: "c1", entryType: "earn_order", points: 100, createdAt: iso(3) },
      { customerId: "c1", entryType: "earn_order", points: 400, createdAt: iso(10) },
      { customerId: "c2", entryType: "earn_order", points: 450, createdAt: iso(5) },
      { customerId: "c2", entryType: "spend", points: -100, createdAt: iso(6) }, // debit ignored for rewards
    ],
    redemptions: [
      { customerId: "c1", rewardId: "reward_5", createdAt: iso(4) },
      { customerId: "c2", rewardId: "reward_15", createdAt: iso(7) },
      { customerId: "c2", rewardId: "reward_5", createdAt: iso(8) },
    ],
  };
}

describe("validateDateRange (Req 20.4)", () => {
  it("accepts a valid range and returns parsed bounds", () => {
    const { startMs, endMs } = validateDateRange(RANGE);
    expect(startMs).toBeLessThan(endMs);
  });

  it("accepts a single-instant (start == end) range", () => {
    expect(() => validateDateRange({ start: COMPUTED_AT, end: COMPUTED_AT })).not.toThrow();
  });

  it("rejects an end-before-start range", () => {
    expect(() => validateDateRange({ start: RANGE.end, end: RANGE.start })).toThrow(
      InvalidDateRangeError,
    );
  });

  it("rejects an unparseable bound", () => {
    expect(() => validateDateRange({ start: "not-a-date", end: RANGE.end })).toThrow(
      InvalidDateRangeError,
    );
  });
});

describe("defaultDateRange (Req 20.5)", () => {
  it("returns the trailing 30 days ending at now", () => {
    const now = new Date("2025-03-31T00:00:00.000Z");
    const range = defaultDateRange(now);
    expect(range.end).toBe(now.toISOString());
    expect(range.start).toBe(new Date("2025-03-01T00:00:00.000Z").toISOString());
    // Valid by construction.
    expect(() => validateDateRange(range)).not.toThrow();
  });
});

describe("computeAnalytics — metrics (Req 20.2)", () => {
  it("computes CLV as average revenue per paying customer in range", () => {
    const result = computeAnalytics(fixture(), RANGE, COMPUTED_AT);
    // revenue = 100 + 200 + 300 = 600 across 2 paying customers → 300.00
    expect(result.clv).toBe(300);
  });

  it("computes repeat purchase rate (share of payers with >1 order)", () => {
    const result = computeAnalytics(fixture(), RANGE, COMPUTED_AT);
    // c1 has 2 orders, c2 has 1 → 1 of 2 payers repeat → 0.5
    expect(result.repeatPurchaseRate).toBe(0.5);
  });

  it("computes engagement enrolled% and active% over all customers", () => {
    const result = computeAnalytics(fixture(), RANGE, COMPUTED_AT);
    // 2 of 3 customers enrolled → 66.67%
    expect(result.engagement.enrolledPct).toBeCloseTo(66.67, 2);
    // c1 + c2 active (orders/ledger in range), c3 not → 66.67%
    expect(result.engagement.activePct).toBeCloseTo(66.67, 2);
  });

  it("ranks most-rewarded customers by points earned in range (desc)", () => {
    const result = computeAnalytics(fixture(), RANGE, COMPUTED_AT);
    // c1 earned 100+400=500, c2 earned 450 (spend excluded)
    expect(result.mostRewardedCustomers).toEqual([
      { customerId: "c1", points: 500 },
      { customerId: "c2", points: 450 },
    ]);
  });

  it("computes redemption rate and reward-tier popularity", () => {
    const result = computeAnalytics(fixture(), RANGE, COMPUTED_AT);
    // 2 of 2 enrolled customers redeemed → 1.0
    expect(result.redemption.redemptionRate).toBe(1);
    expect(result.redemption.rewardTierPopularity).toEqual({
      reward_5: 2,
      reward_15: 1,
      reward_35: 0,
      reward_75: 0,
    });
  });

  it("computes cumulative Royal_VIP growth by month-end", () => {
    // Give c2 a big order so cumulative spend >= £1500 within January.
    const source = fixture();
    const orders = [...source.orders, { customerId: "c2", eligibleTotalGBP: 1500, createdAt: iso(9) }];
    const result = computeAnalytics({ ...source, orders }, RANGE, COMPUTED_AT);
    expect(result.royalVipGrowth).toEqual([{ period: "2025-01", count: 1 }]);
  });

  it("passes computedAt through unchanged and echoes the range (Req 20.5/20.6)", () => {
    const result = computeAnalytics(fixture(), RANGE, COMPUTED_AT);
    expect(result.computedAt).toBe(COMPUTED_AT);
    expect(result.range).toEqual(RANGE);
  });

  it("respects the mostRewardedLimit option", () => {
    const result = computeAnalytics(fixture(), RANGE, COMPUTED_AT, { mostRewardedLimit: 1 });
    expect(result.mostRewardedCustomers).toHaveLength(1);
    expect(result.mostRewardedCustomers[0]?.customerId).toBe("c1");
  });
});

describe("computeAnalytics — empty and boundary behaviour", () => {
  it("returns empty-safe zeros for an empty source", () => {
    const empty: AnalyticsSource = { customers: [], orders: [], ledger: [], redemptions: [] };
    const result = computeAnalytics(empty, RANGE, COMPUTED_AT);
    expect(result.clv).toBe(0);
    expect(result.repeatPurchaseRate).toBe(0);
    expect(result.engagement).toEqual({ enrolledPct: 0, activePct: 0 });
    expect(result.mostRewardedCustomers).toEqual([]);
    expect(result.redemption.redemptionRate).toBe(0);
    expect(result.royalVipGrowth).toEqual([{ period: "2025-01", count: 0 }]);
  });

  it("excludes activity outside the range", () => {
    const source = fixture();
    // An order in February must not count toward a January range.
    const orders = [
      ...source.orders,
      { customerId: "c3", eligibleTotalGBP: 999, createdAt: "2025-02-15T12:00:00.000Z" },
    ];
    const result = computeAnalytics({ ...source, orders }, RANGE, COMPUTED_AT);
    // c3 still not a payer in January.
    expect(result.clv).toBe(300);
  });

  it("is deterministic — recomputing reproduces the same result (Property 16)", () => {
    const source = fixture();
    const a = computeAnalytics(source, RANGE, COMPUTED_AT);
    const b = computeAnalytics(source, RANGE, COMPUTED_AT);
    expect(a).toEqual(b);
  });
});
