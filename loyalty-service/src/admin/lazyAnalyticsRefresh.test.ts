/**
 * Lazy analytics refresh tests (task 24).
 *
 * Replaces the hourly pg-boss cron refresh, which a sleeping host cannot fire
 * reliably (an elapsed window is skipped silently and never replayed). Analytics
 * has a single consumer — an admin opening the view — so the refresh happens on
 * read when the aggregates are stale.
 *
 * Asserts: stale aggregates are refreshed before the read; fresh ones are left
 * alone; never-refreshed aggregates count as stale; and a refresh failure is
 * non-fatal so the read still succeeds against the current views (Req 20.3/20.6).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  DEFAULT_MAX_AGE_SECONDS,
  analyticsAreStale,
  createStaleAnalyticsRefresher,
} from "./lazyAnalyticsRefresh.js";

interface FakeOptions {
  /** Age of the aggregates in seconds; null models a NULL timestamp. */
  ageSeconds?: number | null;
  /** When true, the state row is missing entirely. */
  missingRow?: boolean;
  /** When true, REFRESH MATERIALIZED VIEW throws. */
  failRefresh?: boolean;
}

class FakeDb implements Queryable {
  readonly refreshed: string[] = [];
  stamped = 0;

  constructor(private readonly options: FakeOptions = {}) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
  ): Promise<QueryResult<R>> {
    const ok = <T extends QueryResultRow>(rows: T[]): QueryResult<T> => ({
      rows,
      rowCount: rows.length,
      command: "SELECT",
      oid: 0,
      fields: [],
    });

    if (text.includes("EXTRACT(EPOCH FROM (now() - refreshed_at))")) {
      if (this.options.missingRow) {
        return ok([] as unknown as R[]);
      }
      const age = this.options.ageSeconds === undefined ? 0 : this.options.ageSeconds;
      return ok([{ age_seconds: age } as unknown as R]);
    }
    if (text.includes("REFRESH MATERIALIZED VIEW")) {
      if (this.options.failRefresh) {
        throw new Error("refresh failed");
      }
      this.refreshed.push(text.trim());
      return ok([] as unknown as R[]);
    }
    if (text.includes("SET refreshed_at = now()")) {
      this.stamped += 1;
      return ok([] as unknown as R[]);
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

describe("analyticsAreStale (task 24, Req 20.3)", () => {
  it("treats aggregates older than the budget as stale", async () => {
    expect(await analyticsAreStale(new FakeDb({ ageSeconds: DEFAULT_MAX_AGE_SECONDS + 1 }))).toBe(
      true,
    );
  });

  it("treats recently refreshed aggregates as fresh", async () => {
    expect(await analyticsAreStale(new FakeDb({ ageSeconds: 60 }))).toBe(false);
  });

  it("treats a never-refreshed timestamp as stale", async () => {
    expect(await analyticsAreStale(new FakeDb({ ageSeconds: null }))).toBe(true);
  });

  it("treats a missing state row as stale", async () => {
    expect(await analyticsAreStale(new FakeDb({ missingRow: true }))).toBe(true);
  });
});

describe("createStaleAnalyticsRefresher (task 24, Req 20.3/20.6)", () => {
  it("refreshes the views and stamps the timestamp when stale", async () => {
    const db = new FakeDb({ ageSeconds: 7200 });
    await createStaleAnalyticsRefresher({ db })();

    expect(db.refreshed.length).toBeGreaterThan(0);
    expect(db.stamped).toBe(1);
  });

  it("does no work when the aggregates are still fresh", async () => {
    const db = new FakeDb({ ageSeconds: 5 });
    await createStaleAnalyticsRefresher({ db })();

    expect(db.refreshed).toEqual([]);
    expect(db.stamped).toBe(0);
  });

  it("is non-fatal when the refresh fails, so the read still proceeds", async () => {
    const db = new FakeDb({ ageSeconds: 7200, failRefresh: true });
    const errors: unknown[] = [];

    // Must NOT throw: the caller serves the current views with their true
    // computedAt rather than failing the request.
    await expect(
      createStaleAnalyticsRefresher({ db, onError: (e) => errors.push(e) })(),
    ).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(db.stamped).toBe(0);
  });

  it("honours a custom freshness budget", async () => {
    const db = new FakeDb({ ageSeconds: 120 });
    await createStaleAnalyticsRefresher({ db, maxAgeSeconds: 60 })();
    expect(db.refreshed.length).toBeGreaterThan(0);
  });
});
