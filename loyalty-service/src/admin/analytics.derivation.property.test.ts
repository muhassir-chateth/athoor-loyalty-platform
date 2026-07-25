/**
 * Property-based test for analytics derivation (task 17.4).
 *
 * **Property 16 (Analytics derive solely from the ledger + Shopify orders):**
 * every metric returned by the analytics surface is a PURE FUNCTION of its
 * source snapshot (the enrolment mirror + Shopify orders + the immutable
 * `ledger_entries` + redemptions). The analytics maintain no mutable source of
 * truth of their own, so recomputing over the same source reproduces the
 * reported values as of `computedAt` (Req 20.3, 20.6).
 *
 * **Validates: Requirements 20.3**
 *
 * This exercises the pure computation core ({@link computeAnalytics}) and the
 * service seam ({@link CachedAggregateAnalyticsService}) with fast-check.
 * fast-check generates arbitrary {@link AnalyticsSource} snapshots (customers,
 * Shopify orders, ledger entries, redemptions) plus an arbitrary valid date
 * range, then asserts the derivation invariants:
 *
 *   1. Determinism / purity — the same source + range + computedAt yields a
 *      deeply-equal result, and a second recomputation reproduces it (Req 20.3).
 *   2. `computedAt` passthrough — the stamp is copied verbatim into the result
 *      and does NOT influence any metric (Req 20.6): changing only `computedAt`
 *      leaves every metric identical and echoes the new stamp back.
 *   3. Order-independence — permuting the row order of every input collection
 *      (a projection detail, not a fact about the data) does not change any
 *      metric. This is the operational meaning of "derived solely from" the
 *      contents of the ledger + orders, independent of scan/refresh order.
 *   4. Service parity — routing the same source through the async service seam
 *      (which reads a snapshot then computes) reproduces the pure core's
 *      metrics, confirming the service adds no state of its own.
 *
 * The fake data source below is fully self-contained (an in-memory snapshot
 * holder); no database, Shopify API, or clock is involved. This is a
 * VERIFICATION task — the approved implementation is NOT changed.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeAnalytics,
  type AnalyticsCustomerRecord,
  type AnalyticsLedgerRecord,
  type AnalyticsOrderRecord,
  type AnalyticsRedemptionRecord,
  type AnalyticsSource,
  type DateRange,
} from "./analytics.js";
import {
  CachedAggregateAnalyticsService,
  type AnalyticsDataSource,
  type AnalyticsSnapshot,
} from "./analyticsService.js";
import { LEDGER_ENTRY_TYPES } from "../ledger/repository.js";
import { REWARD_IDS } from "../rewards/catalog.js";

/* -------------------------------------------------------------------------- */
/* Self-contained fake data source                                             */
/* -------------------------------------------------------------------------- */

/**
 * A fully self-contained {@link AnalyticsDataSource}: holds a fixed source
 * snapshot and a `refreshedAt` stamp and returns them verbatim, ignoring the
 * requested range (the pure core filters by range). Mirrors the production
 * seam without any infrastructure.
 */
class FakeAnalyticsDataSource implements AnalyticsDataSource {
  constructor(
    private readonly source: AnalyticsSource,
    private readonly refreshedAt: string,
  ) {}

  async snapshot(_range: DateRange): Promise<AnalyticsSnapshot> {
    return { source: this.source, refreshedAt: this.refreshedAt };
  }
}

/* -------------------------------------------------------------------------- */
/* Generators — arbitrary source snapshots and date ranges                     */
/* -------------------------------------------------------------------------- */

/** A small pool of customer ids so orders/ledger/redemptions correlate meaningfully. */
const CUSTOMER_IDS = ["c1", "c2", "c3", "c4", "c5"] as const;

const arbCustomerId: fc.Arbitrary<string> = fc.constantFrom(...CUSTOMER_IDS);

/** An epoch-ms instant spanning ~2024–2026, as an ISO 8601 string. */
const MIN_MS = Date.UTC(2024, 0, 1);
const MAX_MS = Date.UTC(2026, 0, 1);
const arbIsoInstant: fc.Arbitrary<string> = fc
  .integer({ min: MIN_MS, max: MAX_MS })
  .map((ms) => new Date(ms).toISOString());

/** A GBP money value with pennies, non-negative and finite. */
const arbGbp: fc.Arbitrary<number> = fc
  .double({ min: 0, max: 3000, noNaN: true, noDefaultInfinity: true })
  .map((n) => Math.round(n * 100) / 100);

const arbCustomer: fc.Arbitrary<AnalyticsCustomerRecord> = fc.record({
  customerId: arbCustomerId,
  // Roughly half enrolled, half not, so enrolled% is exercised across the range.
  enrolledAt: fc.option(arbIsoInstant, { nil: null }),
});

const arbOrder: fc.Arbitrary<AnalyticsOrderRecord> = fc.record({
  customerId: arbCustomerId,
  eligibleTotalGBP: arbGbp,
  createdAt: arbIsoInstant,
});

const arbLedger: fc.Arbitrary<AnalyticsLedgerRecord> = fc
  .record({
    customerId: arbCustomerId,
    entryType: fc.constantFrom(...LEDGER_ENTRY_TYPES),
    // Signed points; earns positive, debits negative — but the metric logic
    // keys off entryType + sign, so a free signed range exercises both paths.
    points: fc.integer({ min: -1000, max: 1000 }),
    createdAt: arbIsoInstant,
  });

const arbRedemption: fc.Arbitrary<AnalyticsRedemptionRecord> = fc.record({
  customerId: arbCustomerId,
  // Mostly known reward ids, occasionally an unknown id (must be ignored by
  // the tier-popularity tally but still count toward redemption rate).
  rewardId: fc.oneof(fc.constantFrom(...REWARD_IDS), fc.constant("reward_unknown")),
  createdAt: arbIsoInstant,
});

/** An arbitrary source snapshot with correlated customer ids. */
const arbSource: fc.Arbitrary<AnalyticsSource> = fc.record({
  customers: fc.array(arbCustomer, { minLength: 0, maxLength: 8 }),
  orders: fc.array(arbOrder, { minLength: 0, maxLength: 20 }),
  ledger: fc.array(arbLedger, { minLength: 0, maxLength: 20 }),
  redemptions: fc.array(arbRedemption, { minLength: 0, maxLength: 15 }),
});

/** An arbitrary VALID date range (end never precedes start) as ISO strings. */
const arbRange: fc.Arbitrary<DateRange> = fc
  .tuple(fc.integer({ min: MIN_MS, max: MAX_MS }), fc.integer({ min: MIN_MS, max: MAX_MS }))
  .map(([a, b]) => {
    const startMs = Math.min(a, b);
    const endMs = Math.max(a, b);
    return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
  });

/** Deterministically permute an array from an arbitrary index list (Fisher–Yates driven by draws). */
function permute<T>(items: readonly T[], swaps: readonly number[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = (swaps[i] ?? 0) % (i + 1);
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

/* -------------------------------------------------------------------------- */
/* The property                                                                */
/* -------------------------------------------------------------------------- */

describe("Property 16 — analytics derive solely from the ledger + Shopify orders (Req 20.3)", () => {
  it("is deterministic: same source + range + computedAt reproduces identical metrics", () => {
    fc.assert(
      fc.property(arbSource, arbRange, arbIsoInstant, (source, range, computedAt) => {
        const a = computeAnalytics(source, range, computedAt);
        const b = computeAnalytics(source, range, computedAt);
        expect(b).toEqual(a);
      }),
    );
  });

  it("passes computedAt through verbatim without affecting any metric (Req 20.6)", () => {
    fc.assert(
      fc.property(
        arbSource,
        arbRange,
        arbIsoInstant,
        arbIsoInstant,
        (source, range, computedAtA, computedAtB) => {
          const a = computeAnalytics(source, range, computedAtA);
          const b = computeAnalytics(source, range, computedAtB);

          // The stamp is echoed verbatim.
          expect(a.computedAt).toBe(computedAtA);
          expect(b.computedAt).toBe(computedAtB);

          // ...and it does not influence any metric: strip the stamp and the
          // two results are identical regardless of the computedAt supplied.
          const { computedAt: _a, ...metricsA } = a;
          const { computedAt: _b, ...metricsB } = b;
          expect(metricsB).toEqual(metricsA);
        },
      ),
    );
  });

  it("is order-independent: permuting input rows changes no metric", () => {
    const arbSwaps = fc.array(fc.nat(), { minLength: 20, maxLength: 20 });
    fc.assert(
      fc.property(
        arbSource,
        arbRange,
        arbIsoInstant,
        arbSwaps,
        arbSwaps,
        arbSwaps,
        arbSwaps,
        (source, range, computedAt, sc, so, sl, sr) => {
          const shuffled: AnalyticsSource = {
            customers: permute(source.customers, sc),
            orders: permute(source.orders, so),
            ledger: permute(source.ledger, sl),
            redemptions: permute(source.redemptions, sr),
          };
          const original = computeAnalytics(source, range, computedAt);
          const reordered = computeAnalytics(shuffled, range, computedAt);
          expect(reordered).toEqual(original);
        },
      ),
    );
  });

  it("routes through the service seam and reproduces the pure core's metrics", () => {
    fc.assert(
      fc.asyncProperty(arbSource, arbRange, arbIsoInstant, async (source, range, refreshedAt) => {
        const service = new CachedAggregateAnalyticsService(
          new FakeAnalyticsDataSource(source, refreshedAt),
        );
        const viaService = await service.getOverview(range);
        const viaCore = computeAnalytics(source, range, refreshedAt);

        // The service adds no state: its output equals the pure core's, and the
        // refresh instant becomes computedAt verbatim (Req 20.6).
        expect(viaService).toEqual(viaCore);
        expect(viaService.computedAt).toBe(refreshedAt);
      }),
    );
  });
});
