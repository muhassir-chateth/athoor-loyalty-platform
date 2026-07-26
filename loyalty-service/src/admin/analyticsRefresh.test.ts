/**
 * Unit tests for the analytics-aggregate refresh job + scheduler registration
 * (task 17.x, Requirement 20.3 / A12).
 *
 * NO live/production database or scheduler is touched. The job runs against an
 * in-memory fake {@link Queryable} that records every statement and models the
 * `analytics_aggregate_refresh` state row; registration runs against a fake
 * recurring scheduler that captures the registered name/cron/handler.
 *
 * Covers:
 *   - the job issues a `REFRESH MATERIALIZED VIEW CONCURRENTLY` per matview and
 *     stamps the refresh-state row (Req 20.3, 20.6; A12);
 *   - the job reports the stamped refresh instant;
 *   - {@link registerAnalyticsRefresh} registers under {@link ANALYTICS_REFRESH_JOB}
 *     on the hourly {@link ANALYTICS_REFRESH_CRON} within
 *     {@link ANALYTICS_REFRESH_MAX_INTERVAL_MS}, and the registered handler
 *     triggers a refresh when invoked.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";

import {
  ANALYTICS_CUSTOMERS_MATVIEW,
  ANALYTICS_LEDGER_MATVIEW,
  ANALYTICS_REDEMPTIONS_MATVIEW,
} from "./pgAnalyticsDataSource.js";
import { refreshAnalyticsAggregates } from "./analyticsRefresh.js";

/* --------------------------------- fakes ---------------------------------- */

interface FakeDb {
  db: Queryable;
  statements: string[];
}

function makeDb(refreshedAt: Date = new Date("2024-06-01T12:00:00.000Z")): FakeDb {
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
      if (/^SELECT refreshed_at/i.test(text.trim())) {
        return ok([{ refreshed_at: refreshedAt }] as unknown as R[], "SELECT");
      }
      // REFRESH / UPDATE statements return no rows.
      return ok([] as R[], /^UPDATE/i.test(text.trim()) ? "UPDATE" : "REFRESH");
    },
  };

  return { db, statements };
}

/* ------------------------------- the job ---------------------------------- */

describe("refreshAnalyticsAggregates", () => {
  it("refreshes each matview concurrently, then stamps the refresh-state row", async () => {
    const { db, statements } = makeDb();

    const result = await refreshAnalyticsAggregates({ db });

    // A concurrent refresh per matview.
    expect(statements).toContain(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY ${ANALYTICS_CUSTOMERS_MATVIEW}`,
    );
    expect(statements).toContain(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY ${ANALYTICS_LEDGER_MATVIEW}`,
    );
    expect(statements).toContain(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY ${ANALYTICS_REDEMPTIONS_MATVIEW}`,
    );

    // Then a stamp of the refresh-state row.
    expect(statements.some((s) => /UPDATE analytics_aggregate_refresh SET refreshed_at = now\(\)/i.test(s))).toBe(true);

    // The refreshes happen BEFORE the stamp.
    const lastRefreshIdx = Math.max(
      ...statements
        .map((s, i) => (/REFRESH MATERIALIZED VIEW CONCURRENTLY/i.test(s) ? i : -1))
        .filter((i) => i >= 0),
    );
    const stampIdx = statements.findIndex((s) => /UPDATE analytics_aggregate_refresh/i.test(s));
    expect(lastRefreshIdx).toBeLessThan(stampIdx);

    // Reports the views refreshed and the stamped instant.
    expect(result.refreshed).toEqual([
      ANALYTICS_CUSTOMERS_MATVIEW,
      ANALYTICS_LEDGER_MATVIEW,
      ANALYTICS_REDEMPTIONS_MATVIEW,
    ]);
    expect(result.refreshedAt).toBe("2024-06-01T12:00:00.000Z");
  });
});

/* ------------------- no scheduler registration (task 24) ------------------- */

describe("analytics refresh has no scheduler registration (task 24, A12)", () => {
  it("exports no cron-registration surface, so the orphaned hourly path cannot return", async () => {
    // The module used to export `registerAnalyticsRefresh`, which put the
    // refresh on an hourly cron. A cron window elapsing while a zero-cost host
    // sleeps is skipped silently and never replayed, and the refresh is
    // unnecessary anyway: analytics has a single consumer, so it is triggered by
    // the admin read when stale (see `lazyAnalyticsRefresh.ts`). The scheduling
    // half was REMOVED rather than merely unwired; this asserts it stays gone.
    const mod: Record<string, unknown> = await import("./analyticsRefresh.js");

    expect(mod.registerAnalyticsRefresh).toBeUndefined();
    expect(Object.keys(mod)).not.toContain("registerAnalyticsRefresh");

    // The pure refresh routine remains, and is what the read-triggered path calls.
    expect(typeof mod.refreshAnalyticsAggregates).toBe("function");
  });
});
