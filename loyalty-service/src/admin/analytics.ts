/**
 * Admin Analytics — pure computation core (task 17.3, Requirement 20).
 *
 * This module is the SIDE-EFFECT-FREE heart of Admin_Analytics (design.md
 * "Component 7: Analytics / Reporting"). Every metric is computed as a PURE
 * FUNCTION of an {@link AnalyticsSource} — a snapshot of the immutable
 * `ledger_entries` plus Shopify order data (and the customer enrolment mirror,
 * itself derived from Shopify `customers/create`). It maintains NO mutable
 * source of truth of its own (Req 20.3), and recomputing over the same source
 * reproduces the same values — the invariant checked by the optional
 * analytics-derivation property test (task 17.4 / Property 16).
 *
 * The service layer ({@link ../admin/analyticsService}) feeds this function a
 * snapshot taken from the hourly-refreshed cached aggregates / materialized
 * views (A12) and stamps the response with the refresh instant as `computedAt`
 * (Req 20.6). Keeping computation here — pure and independent of the cache/DB —
 * is what lets the property test validate derivation without any live infra.
 *
 * Metrics (Req 20.2), all scoped to a selectable, inclusive date range:
 *   - clv                    average revenue per paying customer in range.
 *   - repeatPurchaseRate     share of paying customers with >1 paid order.
 *   - engagement.enrolledPct % of customers enrolled by the range end.
 *   - engagement.activePct   % of customers active within the range.
 *   - mostRewardedCustomers  customers ranked by points earned within range.
 *   - redemption.redemptionRate          share of enrolled customers who redeemed in range.
 *   - redemption.rewardTierPopularity    redemption count per reward tier in range.
 *   - royalVipGrowth         cumulative Royal_VIP members at each month-end in range.
 *
 * Date range (Req 20.4, 20.5): {@link validateDateRange} rejects a range whose
 * end precedes its start; {@link defaultDateRange} supplies the applied default
 * (trailing 30 days) when the caller gives none, and the applied range is
 * echoed back in {@link AnalyticsResult.range}.
 *
 * SAFETY: pure computation only. No database, no Shopify API, no clock beyond
 * the injected `now`/`computedAt`. Nothing here touches a live system.
 */
import { REWARD_IDS, type RewardId } from "../rewards/catalog.js";
import { TIER_THRESHOLDS_GBP, type Tier } from "../tier/tier.js";
import type { LedgerEntryType } from "../ledger/repository.js";

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

/** A selectable analytics window. Bounds are ISO 8601 timestamps, inclusive. */
export interface DateRange {
  /** Inclusive lower bound (ISO 8601). */
  start: string;
  /** Inclusive upper bound (ISO 8601). */
  end: string;
}

/** One customer's enrolment mirror (derived from `customers/create`). */
export interface AnalyticsCustomerRecord {
  customerId: string;
  /** ISO 8601 enrolment instant, or null when the customer has not enrolled. */
  enrolledAt: string | null;
}

/** One paid Shopify order's analytics-relevant fields (Shopify order data). */
export interface AnalyticsOrderRecord {
  customerId: string;
  /** Post-discount subtotal excluding shipping and tax, in GBP (A2). */
  eligibleTotalGBP: number;
  /** ISO 8601 order-paid instant. */
  createdAt: string;
}

/** One immutable ledger entry's analytics-relevant fields. */
export interface AnalyticsLedgerRecord {
  customerId: string;
  entryType: LedgerEntryType;
  /** Signed point amount: positive = credit, negative = debit. */
  points: number;
  /** ISO 8601 entry instant. */
  createdAt: string;
}

/** One redemption's analytics-relevant fields. */
export interface AnalyticsRedemptionRecord {
  customerId: string;
  /** The redeemed reward tier id (e.g. `reward_5`). */
  rewardId: string;
  /** ISO 8601 redemption instant. */
  createdAt: string;
}

/**
 * A consistent snapshot of everything analytics derive from: the customer
 * enrolment mirror, Shopify orders, the immutable ledger, and redemptions.
 * The service builds this from the hourly-refreshed cached aggregates /
 * materialized views (A12). All metrics are a pure function of this snapshot.
 */
export interface AnalyticsSource {
  customers: readonly AnalyticsCustomerRecord[];
  orders: readonly AnalyticsOrderRecord[];
  ledger: readonly AnalyticsLedgerRecord[];
  redemptions: readonly AnalyticsRedemptionRecord[];
}

/** A single most-rewarded-customer entry: total points earned within the range. */
export interface RewardedCustomer {
  customerId: string;
  points: number;
}

/** A single Royal_VIP-growth data point: cumulative members at a month-end. */
export interface RoyalVipGrowthPoint {
  /** Calendar month bucket, `YYYY-MM` (UTC). */
  period: string;
  /** Cumulative count of customers who had reached Royal_VIP by the period end. */
  count: number;
}

/** The computed analytics payload (design "AnalyticsResult"; Req 20.2, 20.6). */
export interface AnalyticsResult {
  /** The applied date range — the default when none was supplied (Req 20.5). */
  range: DateRange;
  /** Average revenue (GBP) per paying customer in the range, 2dp. */
  clv: number;
  /** Share (0–1) of paying customers with more than one paid order in the range, 4dp. */
  repeatPurchaseRate: number;
  engagement: {
    /** Percentage (0–100) of all customers enrolled by the range end, 2dp. */
    enrolledPct: number;
    /** Percentage (0–100) of all customers active within the range, 2dp. */
    activePct: number;
  };
  /** Customers ranked by points earned within the range (descending), top N. */
  mostRewardedCustomers: RewardedCustomer[];
  redemption: {
    /** Share (0–1) of enrolled customers who redeemed within the range, 4dp. */
    redemptionRate: number;
    /** Count of redemptions per reward tier within the range (all tiers keyed). */
    rewardTierPopularity: Record<RewardId, number>;
  };
  /** Cumulative Royal_VIP members at each month-end within the range. */
  royalVipGrowth: RoyalVipGrowthPoint[];
  /** ISO 8601 — when the returned (cached) metrics were computed (Req 20.6, A12). */
  computedAt: string;
}

/** Options controlling non-metric-defining computation choices. */
export interface AnalyticsOptions {
  /** How many customers to include in `mostRewardedCustomers` (default 10). */
  mostRewardedLimit?: number;
}

/** Stable machine-readable error codes surfaced to callers. */
export const ANALYTICS_ERROR_CODES = {
  invalidDateRange: "analytics_invalid_date_range",
} as const;

/**
 * Thrown when a requested range is invalid because its end precedes its start,
 * or a bound is not a parseable ISO 8601 timestamp (Req 20.4). No analytics are
 * returned.
 */
export class InvalidDateRangeError extends Error {
  readonly code = ANALYTICS_ERROR_CODES.invalidDateRange;
  constructor(message: string) {
    super(message);
    this.name = "InvalidDateRangeError";
  }
}

/* -------------------------------------------------------------------------- */
/* Date-range helpers (Req 20.4, 20.5)                                         */
/* -------------------------------------------------------------------------- */

const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MOST_REWARDED_LIMIT = 10;

/** Parse an ISO 8601 timestamp to epoch ms, or null when unparseable. */
function parseInstant(value: string): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validates a {@link DateRange} (Req 20.4): both bounds must be parseable ISO
 * timestamps and the end must NOT precede the start. Returns the parsed epoch
 * bounds on success; throws {@link InvalidDateRangeError} otherwise. An empty
 * (start == end) range is permitted — it selects a single instant.
 */
export function validateDateRange(range: DateRange): { startMs: number; endMs: number } {
  const startMs = parseInstant(range.start);
  const endMs = parseInstant(range.end);
  if (startMs === null) {
    throw new InvalidDateRangeError(`Invalid range start '${String(range.start)}': expected an ISO 8601 timestamp.`);
  }
  if (endMs === null) {
    throw new InvalidDateRangeError(`Invalid range end '${String(range.end)}': expected an ISO 8601 timestamp.`);
  }
  if (endMs < startMs) {
    throw new InvalidDateRangeError(
      `Invalid date range: end (${range.end}) precedes start (${range.start}).`,
    );
  }
  return { startMs, endMs };
}

/**
 * The default analytics range applied when the caller supplies none (Req 20.5):
 * the trailing {@link DEFAULT_RANGE_DAYS} days ending at `now`. The applied
 * range is echoed back to the caller in {@link AnalyticsResult.range}.
 *
 * @param now the reference instant (defaults to the current time).
 */
export function defaultDateRange(now: Date = new Date()): DateRange {
  const endMs = now.getTime();
  const startMs = endMs - DEFAULT_RANGE_DAYS * DAY_MS;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

/* -------------------------------------------------------------------------- */
/* Rounding helpers                                                            */
/* -------------------------------------------------------------------------- */

function round(value: number, dp: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** dp;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const roundMoney = (v: number): number => round(v, 2);
const roundRate = (v: number): number => round(v, 4);
const roundPct = (v: number): number => round(v, 2);

/** UTC `YYYY-MM` bucket key for an epoch-ms instant. */
function monthKey(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

/** The ordered list of `YYYY-MM` buckets (with their exclusive end) spanning [startMs, endMs]. */
function monthBuckets(startMs: number, endMs: number): Array<{ period: string; endExclusiveMs: number }> {
  const buckets: Array<{ period: string; endExclusiveMs: number }> = [];
  const start = new Date(startMs);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  // Iterate month-by-month until we pass the range end.
  // Guard the loop bound defensively (a 100-year range is 1200 iterations max).
  for (let guard = 0; guard < 100_000; guard += 1) {
    const firstOfMonthMs = Date.UTC(year, month, 1);
    if (firstOfMonthMs > endMs) {
      break;
    }
    const endExclusiveMs = Date.UTC(year, month + 1, 1);
    buckets.push({ period: monthKey(firstOfMonthMs), endExclusiveMs });
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return buckets;
}

/* -------------------------------------------------------------------------- */
/* The pure metric computation (Req 20.2, 20.3; Property 16)                   */
/* -------------------------------------------------------------------------- */

/** Entry types that represent an earning (positive credit) for reward ranking. */
const EARN_PREFIX = "earn";

/**
 * Computes the full {@link AnalyticsResult} purely from an {@link AnalyticsSource}
 * over the given range (Req 20.2, 20.3). Deterministic: the same source + range
 * always yields the same metrics, so recomputation reproduces the reported
 * values as of `computedAt` (Property 16, task 17.4).
 *
 * The `range` is assumed already validated by {@link validateDateRange}; this
 * function re-parses the bounds and treats both as INCLUSIVE. `computedAt` is
 * the instant the backing cached aggregates were refreshed (Req 20.6) and is
 * copied verbatim into the result — it does NOT affect any metric.
 *
 * @param source     the ledger + Shopify-order + enrolment snapshot.
 * @param range      the inclusive analytics window (validated by the caller).
 * @param computedAt ISO 8601 refresh instant echoed into the result (Req 20.6).
 * @param options    non-metric-defining knobs (e.g. `mostRewardedLimit`).
 */
export function computeAnalytics(
  source: AnalyticsSource,
  range: DateRange,
  computedAt: string,
  options: AnalyticsOptions = {},
): AnalyticsResult {
  const { startMs, endMs } = validateDateRange(range);
  const limit = Math.max(0, Math.trunc(options.mostRewardedLimit ?? DEFAULT_MOST_REWARDED_LIMIT));

  const inRange = (iso: string): boolean => {
    const ms = parseInstant(iso);
    return ms !== null && ms >= startMs && ms <= endMs;
  };

  const totalCustomers = source.customers.length;

  /* --- CLV + repeat purchase rate (from Shopify orders in range) --------- */
  const ordersInRange = source.orders.filter((o) => inRange(o.createdAt));
  let totalRevenue = 0;
  const ordersByCustomer = new Map<string, number>();
  for (const order of ordersInRange) {
    const value = Number.isFinite(order.eligibleTotalGBP) ? order.eligibleTotalGBP : 0;
    totalRevenue += value;
    ordersByCustomer.set(order.customerId, (ordersByCustomer.get(order.customerId) ?? 0) + 1);
  }
  const payingCustomers = ordersByCustomer.size;
  const clv = payingCustomers > 0 ? roundMoney(totalRevenue / payingCustomers) : 0;

  let repeatCustomers = 0;
  for (const count of ordersByCustomer.values()) {
    if (count > 1) {
      repeatCustomers += 1;
    }
  }
  const repeatPurchaseRate = payingCustomers > 0 ? roundRate(repeatCustomers / payingCustomers) : 0;

  /* --- Engagement: enrolled % and active % ------------------------------- */
  // Enrolled by the range end (Req 20.2): a non-null enrolment at or before end.
  let enrolledCount = 0;
  for (const c of source.customers) {
    const enrolledMs = c.enrolledAt === null ? null : parseInstant(c.enrolledAt);
    if (enrolledMs !== null && enrolledMs <= endMs) {
      enrolledCount += 1;
    }
  }
  // Active within the range: any ledger entry or paid order inside the window.
  const activeCustomers = new Set<string>();
  for (const e of source.ledger) {
    if (inRange(e.createdAt)) {
      activeCustomers.add(e.customerId);
    }
  }
  for (const o of ordersInRange) {
    activeCustomers.add(o.customerId);
  }
  const enrolledPct = totalCustomers > 0 ? roundPct((enrolledCount / totalCustomers) * 100) : 0;
  const activePct = totalCustomers > 0 ? roundPct((activeCustomers.size / totalCustomers) * 100) : 0;

  /* --- Most-rewarded customers (points earned in range) ------------------ */
  const earnedByCustomer = new Map<string, number>();
  for (const e of source.ledger) {
    if (e.entryType.startsWith(EARN_PREFIX) && e.points > 0 && inRange(e.createdAt)) {
      earnedByCustomer.set(e.customerId, (earnedByCustomer.get(e.customerId) ?? 0) + e.points);
    }
  }
  const mostRewardedCustomers: RewardedCustomer[] = [...earnedByCustomer.entries()]
    .map(([customerId, points]) => ({ customerId, points }))
    // Descending by points; deterministic tie-break by customerId ascending.
    .sort((a, b) => (b.points - a.points) || (a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0))
    .slice(0, limit);

  /* --- Redemption behaviour: rate + reward-tier popularity --------------- */
  const rewardTierPopularity = REWARD_IDS.reduce(
    (acc, id) => {
      acc[id] = 0;
      return acc;
    },
    {} as Record<RewardId, number>,
  );
  const redeemingCustomers = new Set<string>();
  for (const r of source.redemptions) {
    if (!inRange(r.createdAt)) {
      continue;
    }
    redeemingCustomers.add(r.customerId);
    if ((REWARD_IDS as readonly string[]).includes(r.rewardId)) {
      rewardTierPopularity[r.rewardId as RewardId] += 1;
    }
  }
  const redemptionRate = enrolledCount > 0 ? roundRate(redeemingCustomers.size / enrolledCount) : 0;

  /* --- Royal_VIP growth: cumulative members at each month-end ------------ */
  const royalVipThreshold = TIER_THRESHOLDS_GBP.royal_vip;
  const buckets = monthBuckets(startMs, endMs);
  // Pre-accumulate each customer's spend so a month-end count is a threshold test.
  const orderEvents = source.orders
    .map((o) => ({
      customerId: o.customerId,
      value: Number.isFinite(o.eligibleTotalGBP) ? o.eligibleTotalGBP : 0,
      ms: parseInstant(o.createdAt),
    }))
    .filter((o): o is { customerId: string; value: number; ms: number } => o.ms !== null);
  const royalVipGrowth: RoyalVipGrowthPoint[] = buckets.map((bucket) => {
    const spendByCustomer = new Map<string, number>();
    for (const ev of orderEvents) {
      if (ev.ms < bucket.endExclusiveMs) {
        spendByCustomer.set(ev.customerId, (spendByCustomer.get(ev.customerId) ?? 0) + ev.value);
      }
    }
    let count = 0;
    for (const spend of spendByCustomer.values()) {
      if (spend >= royalVipThreshold) {
        count += 1;
      }
    }
    return { period: bucket.period, count };
  });

  return {
    range: { start: range.start, end: range.end },
    clv,
    repeatPurchaseRate,
    engagement: { enrolledPct, activePct },
    mostRewardedCustomers,
    redemption: { redemptionRate, rewardTierPopularity },
    royalVipGrowth,
    computedAt,
  };
}

/** Re-export so callers deriving Royal_VIP growth can reference the tier name. */
export type { Tier };
