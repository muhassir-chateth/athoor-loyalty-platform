/**
 * Unit tests for the Pg/materialized-view backed analytics data source
 * (task 17.x, Requirement 20).
 *
 * NO live/production database is touched. The reader is exercised against an
 * in-memory fake {@link Queryable} that models the analytics materialized views
 * (`analytics_customers`, `analytics_ledger`, `analytics_redemptions`) and the
 * `analytics_aggregate_refresh` state row, returning rows in the same shapes
 * `pg` would (TIMESTAMPTZ as Date, BIGINT as string).
 *
 * Covers:
 *   - each matview is mapped into the matching AnalyticsSource segment with the
 *     correct types (points coerced from BIGINT string; timestamps → ISO);
 *   - the DOCUMENTED BOUNDARY: `orders` is always empty (Shopify order facts are
 *     not mirrored in Postgres);
 *   - `refreshedAt` is taken from the refresh-state row (Req 20.6), and falls
 *     back to the injected clock when the row is missing;
 *   - end-to-end through {@link CachedAggregateAnalyticsService}: the served
 *     ledger/redemption/enrolment metrics compute, `computedAt` = refreshedAt.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { CachedAggregateAnalyticsService } from "./analyticsService.js";
import { PgAnalyticsDataSource } from "./pgAnalyticsDataSource.js";

/* --------------------------------- fakes ---------------------------------- */

interface Seed {
  customers?: Array<{ customer_id: string; enrolled_at: Date | null }>;
  ledger?: Array<{
    customer_id: string;
    entry_type: string;
    points: number;
    created_at: Date;
  }>;
  redemptions?: Array<{ customer_id: string; reward_id: string; created_at: Date }>;
  refreshedAt?: Date | null;
  /** When true, the refresh-state query returns NO row (models a missing stamp). */
  omitRefreshRow?: boolean;
}

interface FakeDb {
  db: Queryable;
  statements: string[];
}

function makeDb(seed: Seed): FakeDb {
  const statements: string[] = [];
  const ok = <T extends QueryResultRow>(rows: T[], command: string): QueryResult<T> => ({
    rows,
    rowCount: rows.length,
    command,
    oid: 0,
    fields: [],
  });

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
    ): Promise<QueryResult<R>> {
      statements.push(text.trim());

      if (/FROM analytics_customers/i.test(text)) {
        const rows = (seed.customers ?? []).map((c) => ({
          customer_id: c.customer_id,
          enrolled_at: c.enrolled_at,
        }));
        return ok(rows as unknown as R[], "SELECT");
      }
      if (/FROM analytics_ledger/i.test(text)) {
        const rows = (seed.ledger ?? []).map((e) => ({
          customer_id: e.customer_id,
          entry_type: e.entry_type,
          // pg returns BIGINT as a string.
          points: String(e.points),
          created_at: e.created_at,
        }));
        return ok(rows as unknown as R[], "SELECT");
      }
      if (/FROM analytics_redemptions/i.test(text)) {
        const rows = (seed.redemptions ?? []).map((r) => ({
          customer_id: r.customer_id,
          reward_id: r.reward_id,
          created_at: r.created_at,
        }));
        return ok(rows as unknown as R[], "SELECT");
      }
      if (/FROM analytics_aggregate_refresh/i.test(text)) {
        if (seed.omitRefreshRow) {
          return ok([] as R[], "SELECT");
        }
        return ok(
          [{ refreshed_at: seed.refreshedAt ?? null }] as unknown as R[],
          "SELECT",
        );
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };

  return { db, statements };
}

const RANGE = { start: "2024-01-01T00:00:00.000Z", end: "2024-12-31T23:59:59.999Z" };
const REFRESHED = new Date("2024-06-01T12:00:00.000Z");

/* ------------------------------ snapshot mapping -------------------------- */

describe("PgAnalyticsDataSource.snapshot: maps matviews into AnalyticsSource", () => {
  it("maps customers, ledger, and redemptions with correct types", async () => {
    const { db } = makeDb({
      customers: [
        { customer_id: "c1", enrolled_at: new Date("2024-01-02T00:00:00.000Z") },
        { customer_id: "c2", enrolled_at: null },
      ],
      ledger: [
        {
          customer_id: "c1",
          entry_type: "earn_order",
          points: 200,
          created_at: new Date("2024-03-01T00:00:00.000Z"),
        },
      ],
      redemptions: [
        {
          customer_id: "c1",
          reward_id: "reward_5",
          created_at: new Date("2024-04-01T00:00:00.000Z"),
        },
      ],
      refreshedAt: REFRESHED,
    });

    const source = new PgAnalyticsDataSource(db);
    const snapshot = await source.snapshot(RANGE);

    expect(snapshot.source.customers).toEqual([
      { customerId: "c1", enrolledAt: "2024-01-02T00:00:00.000Z" },
      { customerId: "c2", enrolledAt: null },
    ]);
    expect(snapshot.source.ledger).toEqual([
      {
        customerId: "c1",
        entryType: "earn_order",
        points: 200, // coerced from BIGINT string
        createdAt: "2024-03-01T00:00:00.000Z",
      },
    ]);
    expect(snapshot.source.redemptions).toEqual([
      { customerId: "c1", rewardId: "reward_5", createdAt: "2024-04-01T00:00:00.000Z" },
    ]);
    expect(snapshot.refreshedAt).toBe("2024-06-01T12:00:00.000Z");
  });

  it("documents the boundary: orders is always empty (Shopify order facts not mirrored)", async () => {
    const { db } = makeDb({
      ledger: [
        {
          customer_id: "c1",
          entry_type: "earn_order",
          points: 500,
          created_at: new Date("2024-03-01T00:00:00.000Z"),
        },
      ],
      refreshedAt: REFRESHED,
    });

    const snapshot = await new PgAnalyticsDataSource(db).snapshot(RANGE);
    expect(snapshot.source.orders).toEqual([]);
  });

  it("falls back to the injected clock when the refresh-state row is missing", async () => {
    const { db } = makeDb({ omitRefreshRow: true });
    const fixed = new Date("2030-01-01T00:00:00.000Z");
    const source = new PgAnalyticsDataSource(db, { now: () => fixed });

    const snapshot = await source.snapshot(RANGE);
    expect(snapshot.refreshedAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("reads all matviews (issues a SELECT against each)", async () => {
    const { db, statements } = makeDb({ refreshedAt: REFRESHED });
    await new PgAnalyticsDataSource(db).snapshot(RANGE);

    expect(statements.some((s) => /FROM analytics_customers/i.test(s))).toBe(true);
    expect(statements.some((s) => /FROM analytics_ledger/i.test(s))).toBe(true);
    expect(statements.some((s) => /FROM analytics_redemptions/i.test(s))).toBe(true);
    expect(statements.some((s) => /FROM analytics_aggregate_refresh/i.test(s))).toBe(true);
  });
});

/* --------------------------- end-to-end via service ----------------------- */

describe("CachedAggregateAnalyticsService over PgAnalyticsDataSource", () => {
  it("computes ledger/redemption/enrolment metrics and stamps computedAt = refreshedAt", async () => {
    const { db } = makeDb({
      customers: [
        { customer_id: "c1", enrolled_at: new Date("2024-01-02T00:00:00.000Z") },
        { customer_id: "c2", enrolled_at: new Date("2024-01-03T00:00:00.000Z") },
      ],
      ledger: [
        {
          customer_id: "c1",
          entry_type: "earn_order",
          points: 300,
          created_at: new Date("2024-03-01T00:00:00.000Z"),
        },
        {
          customer_id: "c2",
          entry_type: "earn_signup",
          points: 50,
          created_at: new Date("2024-03-02T00:00:00.000Z"),
        },
      ],
      redemptions: [
        {
          customer_id: "c1",
          reward_id: "reward_5",
          created_at: new Date("2024-04-01T00:00:00.000Z"),
        },
      ],
      refreshedAt: REFRESHED,
    });

    const service = new CachedAggregateAnalyticsService(new PgAnalyticsDataSource(db));
    const result = await service.getOverview(RANGE);

    // computedAt echoes the aggregate refresh instant (Req 20.6).
    expect(result.computedAt).toBe("2024-06-01T12:00:00.000Z");

    // Both customers enrolled by range end → 100%.
    expect(result.engagement.enrolledPct).toBe(100);
    // Both active in range (each has a ledger entry) → 100%.
    expect(result.engagement.activePct).toBe(100);

    // Most-rewarded ranked by earn points in range.
    expect(result.mostRewardedCustomers).toEqual([
      { customerId: "c1", points: 300 },
      { customerId: "c2", points: 50 },
    ]);

    // One of two enrolled customers redeemed → 0.5; reward_5 popularity = 1.
    expect(result.redemption.redemptionRate).toBe(0.5);
    expect(result.redemption.rewardTierPopularity.reward_5).toBe(1);
    expect(result.redemption.rewardTierPopularity.reward_15).toBe(0);

    // BOUNDARY: order-derived metrics resolve to empty-safe zeros (no orders).
    expect(result.clv).toBe(0);
    expect(result.repeatPurchaseRate).toBe(0);
    expect(result.royalVipGrowth.every((p) => p.count === 0)).toBe(true);
  });
});
