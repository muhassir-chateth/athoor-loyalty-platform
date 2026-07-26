/**
 * Lazy, read-triggered analytics refresh (task 24).
 *
 * WHY: the analytics materialized views were refreshed by an hourly pg-boss cron
 * schedule. On a host that sleeps when idle that schedule is unreliable — an
 * elapsed window is skipped silently and never replayed — and it is also
 * unnecessary, because the aggregates have exactly ONE consumer: an admin
 * opening the analytics view (Req 20).
 *
 * So the schedule is removed entirely and the refresh becomes demand-driven:
 * before serving a response, if the views are older than the freshness budget,
 * refresh them. This is strictly BETTER than the hourly cron for the reader —
 * figures are fresh as of the request rather than up to an hour stale — and it
 * removes a schedule that could silently stop.
 *
 * The staleness check needs no new state: `analytics_aggregate_refresh.refreshed_at`
 * is already maintained by the existing refresh routine and is already the
 * `computedAt` the response reports (Req 20.6).
 *
 * NON-FATAL BY DESIGN: if the refresh fails, the caller still gets a response
 * built from whatever the views currently hold, carrying its true (older)
 * `computedAt`. Serving slightly stale analytics beats failing the request, and
 * the ledger remains the authoritative source either way.
 *
 * LEDGER SAFETY: refreshing a materialized view is a read-only projection over
 * `ledger_entries` / `redemptions` / `customers`. Nothing here writes to the
 * ledger, so no correctness property is affected.
 */
import type { Queryable } from "../ledger/repository.js";
import { refreshAnalyticsAggregates } from "./analyticsRefresh.js";

/**
 * How old the aggregates may be before a read refreshes them. One hour matches
 * the cadence of the cron schedule this replaces, so the documented freshness
 * guarantee is unchanged (Req 20.3).
 */
export const DEFAULT_MAX_AGE_SECONDS = 3600 as const;

/** Age of the current aggregates in seconds; null when never refreshed. */
const AGE_SQL = `
  SELECT EXTRACT(EPOCH FROM (now() - refreshed_at)) AS age_seconds
    FROM analytics_aggregate_refresh
   WHERE id = TRUE
`;

interface AgeRow {
  age_seconds: number | string | null;
}

export interface LazyAnalyticsRefreshDeps {
  db: Queryable;
  maxAgeSeconds?: number;
  /** Reports a failed refresh; the read still proceeds with stale aggregates. */
  onError?: (err: unknown) => void;
}

/**
 * True when the aggregates are older than the freshness budget, or have never
 * been refreshed (no row, or a NULL timestamp).
 */
export async function analyticsAreStale(
  db: Queryable,
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
): Promise<boolean> {
  const { rows } = await db.query<AgeRow>(AGE_SQL);
  const row = rows[0];
  if (!row || row.age_seconds === null || row.age_seconds === undefined) {
    return true;
  }
  const age = typeof row.age_seconds === "number" ? row.age_seconds : Number(row.age_seconds);
  if (!Number.isFinite(age)) {
    return true;
  }
  return age >= maxAgeSeconds;
}

/**
 * Builds the `refreshIfStale` hook the analytics service calls before reading.
 *
 * Refreshes only when stale, so repeated dashboard loads inside the freshness
 * window cost nothing extra.
 */
export function createStaleAnalyticsRefresher(
  deps: LazyAnalyticsRefreshDeps,
): () => Promise<void> {
  const maxAgeSeconds = deps.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  return async (): Promise<void> => {
    try {
      if (!(await analyticsAreStale(deps.db, maxAgeSeconds))) {
        return;
      }
      await refreshAnalyticsAggregates({ db: deps.db });
    } catch (err) {
      // Non-fatal: serve what the views hold, with their true computedAt.
      deps.onError?.(err);
    }
  };
}
