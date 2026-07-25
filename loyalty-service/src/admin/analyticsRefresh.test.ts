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
  ANALYTICS_REFRESH_CRON,
  ANALYTICS_REFRESH_JOB,
  ANALYTICS_REFRESH_MAX_INTERVAL_MS,
  ANALYTICS_REFRESH_SCHEDULE,
} from "./analyticsService.js";
import {
  ANALYTICS_CUSTOMERS_MATVIEW,
  ANALYTICS_LEDGER_MATVIEW,
  ANALYTICS_REDEMPTIONS_MATVIEW,
} from "./pgAnalyticsDataSource.js";
import {
  refreshAnalyticsAggregates,
  registerAnalyticsRefresh,
  type RecurringScheduler,
} from "./analyticsRefresh.js";

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

/* --------------------------- scheduler registration ----------------------- */

describe("registerAnalyticsRefresh", () => {
  it("registers under the analytics job name with the hourly cron (A12)", async () => {
    const { db } = makeDb();

    let registeredName = "";
    let registeredCron = "";
    let handler: (() => Promise<void>) | undefined;
    const scheduler: RecurringScheduler = {
      schedule(name, cron, h) {
        registeredName = name;
        registeredCron = cron;
        handler = h;
      },
    };

    const schedule = await registerAnalyticsRefresh(scheduler, { db });

    expect(registeredName).toBe(ANALYTICS_REFRESH_JOB);
    expect(registeredName).toBe("refreshAnalyticsAggregates");
    expect(registeredCron).toBe(ANALYTICS_REFRESH_CRON);
    expect(registeredCron).toBe("0 * * * *");
    expect(schedule).toBe(ANALYTICS_REFRESH_SCHEDULE);
    expect(schedule.maxIntervalMs).toBeLessThanOrEqual(ANALYTICS_REFRESH_MAX_INTERVAL_MS);
    expect(typeof handler).toBe("function");
  });

  it("registered handler triggers a refresh when invoked", async () => {
    const { db, statements } = makeDb();

    let handler: (() => Promise<void>) | undefined;
    const scheduler: RecurringScheduler = {
      schedule(_name, _cron, h) {
        handler = h;
      },
    };

    await registerAnalyticsRefresh(scheduler, { db });
    // Nothing runs until the scheduler fires the handler.
    expect(statements.length).toBe(0);

    await handler?.();

    // The handler ran a full refresh.
    expect(statements.some((s) => /REFRESH MATERIALIZED VIEW CONCURRENTLY/i.test(s))).toBe(true);
    expect(statements.some((s) => /UPDATE analytics_aggregate_refresh/i.test(s))).toBe(true);
  });
});
