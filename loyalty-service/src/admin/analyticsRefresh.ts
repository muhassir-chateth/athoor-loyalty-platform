/**
 * Analytics-aggregate refresh job + scheduler registration (task 17.x,
 * Requirement 20.3 / A12; design "Component 5: Scheduler" + "Component 7:
 * Analytics / Reporting").
 *
 * The admin analytics metrics are served from materialized views that must be
 * refreshed AT LEAST HOURLY (A12) so the reported figures track the immutable
 * ledger + redemption/enrolment data. This module provides:
 *
 *   - {@link refreshAnalyticsAggregates}  the callable job: it runs
 *       `REFRESH MATERIALIZED VIEW CONCURRENTLY` for each analytics matview (so
 *       readers are never blocked) and then stamps
 *       `analytics_aggregate_refresh.refreshed_at = now()` — the instant the
 *       data source surfaces as the response `computedAt` (Req 20.6).
 *   - {@link registerAnalyticsRefresh}    wires that job onto the SAME
 *       {@link RecurringScheduler} abstraction the reconciliation and expiry jobs
 *       use (`schedule(name, cron, handler)`), under
 *       {@link ANALYTICS_REFRESH_JOB} on the hourly {@link ANALYTICS_REFRESH_CRON}
 *       cadence (via {@link ANALYTICS_REFRESH_SCHEDULE}).
 *
 * CONCURRENT REFRESH: `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires each
 * matview to carry a UNIQUE index (the migration adds one per view) and must NOT
 * run inside a transaction. The job therefore issues each statement on the
 * supplied {@link Queryable} directly (a pool), never inside a transactor.
 *
 * SAFETY: constructing/registering the job touches no live system. It issues SQL
 * only when a caller passes a real `pg` Pool at runtime, calls no Shopify API,
 * and sends no email. It is unit-tested against an in-memory fake Queryable and
 * a fake scheduler, so no live database/scheduler is engaged during verification.
 */
import type { Queryable } from "../ledger/repository.js";
import {
  ANALYTICS_MATVIEWS,
  ANALYTICS_REFRESH_STATE_TABLE,
} from "./pgAnalyticsDataSource.js";
import {
  ANALYTICS_REFRESH_SCHEDULE,
  type AnalyticsRefreshSchedule,
} from "./analyticsService.js";

/* -------------------------------------------------------------------------- */
/* Refresh SQL.                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One `REFRESH MATERIALIZED VIEW CONCURRENTLY` statement per analytics matview,
 * in the shared {@link ANALYTICS_MATVIEWS} order. Concurrent refresh keeps the
 * views readable throughout the refresh (A12); it relies on the UNIQUE index the
 * migration adds to each view.
 */
export const ANALYTICS_REFRESH_MATVIEW_SQL: readonly string[] = ANALYTICS_MATVIEWS.map(
  (view) => `REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`,
);

/**
 * Stamps the refresh-state row with the current instant AFTER the views have
 * been refreshed. `now()` is evaluated by Postgres so the stamp reflects the DB
 * clock. The single row is guaranteed to exist (seeded by the migration); the
 * WHERE is defensive.
 */
export const ANALYTICS_REFRESH_STAMP_SQL = `UPDATE ${ANALYTICS_REFRESH_STATE_TABLE} SET refreshed_at = now() WHERE id = TRUE`;

/** Reads back the stamped refresh instant so the job can report it. */
const SELECT_REFRESHED_AT_SQL = `SELECT refreshed_at FROM ${ANALYTICS_REFRESH_STATE_TABLE} LIMIT 1`;

/* -------------------------------------------------------------------------- */
/* Job.                                                                        */
/* -------------------------------------------------------------------------- */

/** Dependencies for the analytics-aggregate refresh job. */
export interface AnalyticsRefreshDeps {
  /**
   * A read/write connection used to run the concurrent refreshes and the state
   * stamp. MUST be a pool/connection that does NOT wrap the statements in a
   * transaction — `REFRESH ... CONCURRENTLY` cannot run inside one.
   */
  db: Queryable;
}

/** The outcome of one analytics-aggregate refresh run. */
export interface AnalyticsRefreshResult {
  /** The materialized views that were refreshed, in refresh order. */
  refreshed: readonly string[];
  /** ISO 8601 — the stamped refresh instant (the future response `computedAt`). */
  refreshedAt: string;
}

/**
 * Refreshes every analytics materialized view (concurrently) and stamps the
 * refresh-state row (Req 20.3, 20.6; A12). This is the callable the scheduler
 * invokes hourly; it can also be triggered directly (e.g. an admin "refresh now"
 * action or a test).
 *
 * @param deps the DB connection to refresh against.
 * @returns the views refreshed and the stamped refresh instant.
 */
export async function refreshAnalyticsAggregates(
  deps: AnalyticsRefreshDeps,
): Promise<AnalyticsRefreshResult> {
  // (1) Refresh each matview concurrently — order is stable and readers are
  // never blocked. Each statement runs on its own (no surrounding transaction).
  for (const sql of ANALYTICS_REFRESH_MATVIEW_SQL) {
    await deps.db.query(sql);
  }

  // (2) Stamp the refresh instant so the data source can surface it as
  // `computedAt` (Req 20.6).
  await deps.db.query(ANALYTICS_REFRESH_STAMP_SQL);

  // (3) Read back the stamped instant for the run report. Fall back to the
  // current time if (defensively) the row is missing.
  const stamped = await deps.db.query<{ refreshed_at: Date | string | null }>(
    SELECT_REFRESHED_AT_SQL,
  );
  const row = stamped.rows[0];
  const value = row ? row.refreshed_at : null;
  const refreshedAt =
    value === null || value === undefined
      ? new Date().toISOString()
      : value instanceof Date
        ? value.toISOString()
        : new Date(value).toISOString();

  return { refreshed: [...ANALYTICS_MATVIEWS], refreshedAt };
}

/* -------------------------------------------------------------------------- */
/* Scheduler registration.                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A minimal structural view of a recurring scheduler (satisfied by the boot
 * {@link import("../scheduler.js").PgBossRecurringScheduler} and by e.g. pg-boss
 * `schedule(name, cron, ...)`), declared locally so registering the job does not
 * hard-couple it to any concrete scheduler. Mirrors the reconciliation (task
 * 12.1) and expiry (task 10.2) jobs' abstraction exactly.
 */
export interface RecurringScheduler {
  schedule(jobName: string, cron: string, handler: () => Promise<void>): Promise<void> | void;
}

/**
 * Registers the analytics-aggregate refresh on a recurring scheduler so it runs
 * at least hourly (A12). The registered handler invokes
 * {@link refreshAnalyticsAggregates}. This wires a callable job onto the
 * scheduler abstraction; production supplies a real recurring scheduler at deploy
 * time — calling this in a test/registration context engages no live scheduler.
 *
 * @param scheduler the recurring scheduler to register on.
 * @param deps      the refresh job's DB dependency.
 * @param schedule  the schedule to register under (defaults to the hourly
 *                  {@link ANALYTICS_REFRESH_SCHEDULE}).
 * @returns the {@link AnalyticsRefreshSchedule} that was registered.
 */
export async function registerAnalyticsRefresh(
  scheduler: RecurringScheduler,
  deps: AnalyticsRefreshDeps,
  schedule: AnalyticsRefreshSchedule = ANALYTICS_REFRESH_SCHEDULE,
): Promise<AnalyticsRefreshSchedule> {
  await scheduler.schedule(schedule.jobName, schedule.cron, async () => {
    await refreshAnalyticsAggregates(deps);
  });
  return schedule;
}
