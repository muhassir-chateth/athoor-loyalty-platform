/**
 * Admin Analytics service + cached-aggregate data source (task 17.3,
 * Requirement 20; design "Component 7: Analytics / Reporting").
 *
 * This is the injectable seam between the admin `GET /v1/admin/analytics` route
 * and the pure metric core ({@link computeAnalytics}). Following the codebase
 * convention (balance/history/profile/adjustment sources), the route depends on
 * an interface with an in-memory default so the surface boots and is
 * exercisable WITHOUT live Postgres, while production injects a data source
 * reading the hourly-refreshed materialized views (A12).
 *
 * Separation of concerns:
 *   - {@link AnalyticsDataSource}  supplies a consistent {@link AnalyticsSnapshot}
 *                                  (ledger + Shopify orders + enrolment) taken
 *                                  from the cached aggregates / materialized
 *                                  views, along with the `refreshedAt` instant
 *                                  those aggregates were last recomputed.
 *   - {@link computeAnalytics}     turns that snapshot into metrics — PURELY.
 *   - {@link AnalyticsService}     validates/defaults the range (Req 20.4/20.5),
 *                                  reads the snapshot, computes, and stamps the
 *                                  response `computedAt` with `refreshedAt`
 *                                  (Req 20.6). It performs the admin-auth check's
 *                                  effect indirectly: the route mounts under the
 *                                  admin-auth preHandler so an unauthenticated
 *                                  caller never reaches this service (Req 20.1).
 *
 * Because metrics are derived from the immutable ledger + Shopify orders and the
 * data source maintains no separate mutable truth (it is a periodically
 * refreshed projection), recomputing over the same snapshot reproduces the
 * reported values (Req 20.3; Property 16, task 17.4).
 *
 * SAFETY: neither the interface nor the in-memory default touches a live system.
 * A Pg/materialized-view backed data source is wired at deploy time; live-DB
 * verification of that reader is deferred, consistent with the reconciliation /
 * backup-verification modules.
 */
import {
  computeAnalytics,
  defaultDateRange,
  validateDateRange,
  type AnalyticsResult,
  type AnalyticsSource,
  type DateRange,
} from "./analytics.js";

/**
 * A consistent snapshot from the cached aggregates / materialized views, plus
 * the instant those aggregates were last refreshed. `refreshedAt` becomes the
 * response `computedAt` (Req 20.6, A12).
 */
export interface AnalyticsSnapshot {
  source: AnalyticsSource;
  /** ISO 8601 — when the backing cached aggregates were last recomputed. */
  refreshedAt: string;
}

/**
 * Supplies the analytics snapshot for a requested range. Production reads the
 * hourly-refreshed materialized views; the range lets a reader scope its scan,
 * though {@link computeAnalytics} re-filters defensively so a source returning a
 * superset stays correct.
 */
export interface AnalyticsDataSource {
  snapshot(range: DateRange): Promise<AnalyticsSnapshot>;
}

/** The analytics operation the admin route depends on (design `AnalyticsService`). */
export interface AnalyticsService {
  /**
   * Compute the analytics overview for a range (Req 20.2). When `range` is
   * omitted the default trailing-30-day range is applied and echoed back
   * (Req 20.5). Throws {@link InvalidDateRangeError} when the supplied range's
   * end precedes its start (Req 20.4).
   */
  getOverview(range?: DateRange): Promise<AnalyticsResult>;
}

/** Options for {@link CachedAggregateAnalyticsService}. */
export interface AnalyticsServiceOptions {
  /** Clock for computing the default range (defaults to `new Date()`). */
  now?: () => Date;
  /** How many customers to include in `mostRewardedCustomers` (default 10). */
  mostRewardedLimit?: number;
}

/**
 * The analytics service: validates/defaults the range, reads a snapshot from
 * the injected {@link AnalyticsDataSource}, and computes metrics purely. Used in
 * both production (Pg/matview data source) and tests/local runs (in-memory data
 * source), since the computation is identical regardless of the backing store.
 */
export class CachedAggregateAnalyticsService implements AnalyticsService {
  private readonly now: () => Date;
  private readonly mostRewardedLimit: number | undefined;

  constructor(
    private readonly dataSource: AnalyticsDataSource,
    options: AnalyticsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.mostRewardedLimit = options.mostRewardedLimit;
  }

  async getOverview(range?: DateRange): Promise<AnalyticsResult> {
    // Apply + report a default range when none is given (Req 20.5); otherwise
    // validate the supplied range, rejecting end-before-start (Req 20.4).
    const applied: DateRange = range ?? defaultDateRange(this.now());
    validateDateRange(applied);

    const snapshot = await this.dataSource.snapshot(applied);
    return computeAnalytics(
      snapshot.source,
      applied,
      snapshot.refreshedAt,
      this.mostRewardedLimit === undefined ? {} : { mostRewardedLimit: this.mostRewardedLimit },
    );
  }
}

/**
 * In-memory {@link AnalyticsDataSource} for local runs and tests. Holds a fixed
 * snapshot and a `refreshedAt` stamp; ignores the requested range (the pure core
 * filters by range), returning the full source. Seed it with fixtures to
 * exercise the metrics, or leave empty to model a program with no activity yet
 * (all metrics resolve to their empty-safe zeros).
 */
export class InMemoryAnalyticsDataSource implements AnalyticsDataSource {
  private source: AnalyticsSource;
  private refreshedAt: string;

  constructor(
    source: AnalyticsSource = { customers: [], orders: [], ledger: [], redemptions: [] },
    refreshedAt: string = new Date().toISOString(),
  ) {
    this.source = source;
    this.refreshedAt = refreshedAt;
  }

  async snapshot(_range: DateRange): Promise<AnalyticsSnapshot> {
    return { source: this.source, refreshedAt: this.refreshedAt };
  }

  /** Test/setup helper: replace the snapshot and (optionally) its refresh stamp. */
  set(source: AnalyticsSource, refreshedAt?: string): void {
    this.source = source;
    if (refreshedAt !== undefined) {
      this.refreshedAt = refreshedAt;
    }
  }
}

/**
 * Convenience factory: an {@link AnalyticsService} backed by an in-memory data
 * source. Used as the route default so the admin analytics endpoint works
 * end-to-end without any infrastructure (returning empty-safe metrics until a
 * real materialized-view data source is wired).
 */
export function createInMemoryAnalyticsService(
  source?: AnalyticsSource,
  options?: AnalyticsServiceOptions,
): AnalyticsService {
  return new CachedAggregateAnalyticsService(new InMemoryAnalyticsDataSource(source), options ?? {});
}

/* -------------------------------------------------------------------------- */
/* Hourly refresh cadence (A12) — config/doc, not wired to a live scheduler.   */
/* -------------------------------------------------------------------------- */

/** The job name the analytics-aggregate refresh is scheduled under. */
export const ANALYTICS_REFRESH_JOB = "refreshAnalyticsAggregates" as const;

/**
 * The maximum allowed gap between analytics-aggregate refreshes (A12: "refreshed
 * at least hourly"). The default cadence runs well within this bound.
 */
export const ANALYTICS_REFRESH_MAX_INTERVAL_MS = 60 * 60 * 1000;

/** The default cadence: hourly, on the hour (A12). */
export const ANALYTICS_REFRESH_CRON = "0 * * * *" as const;

/** Declarative schedule config for the analytics refresh job (A12). */
export interface AnalyticsRefreshSchedule {
  jobName: string;
  /** Cron expression for the refresh cadence. */
  cron: string;
  /** Upper bound on the interval between refreshes, in ms (A12). */
  maxIntervalMs: number;
}

/** The default analytics refresh schedule (doc/config; not wired to a live scheduler). */
export const ANALYTICS_REFRESH_SCHEDULE: AnalyticsRefreshSchedule = {
  jobName: ANALYTICS_REFRESH_JOB,
  cron: ANALYTICS_REFRESH_CRON,
  maxIntervalMs: ANALYTICS_REFRESH_MAX_INTERVAL_MS,
};
