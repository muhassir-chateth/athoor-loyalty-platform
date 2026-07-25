/**
 * Postgres/materialized-view backed {@link AnalyticsDataSource} (task 17.x,
 * Requirement 20; design "Component 7: Analytics / Reporting").
 *
 * This is the production reader that fulfils the injectable seam declared in
 * {@link ./analyticsService}: it loads a consistent
 * {@link AnalyticsSource} snapshot from the HOURLY-REFRESHED materialized views
 * created by `migrations/1785300000000_create-analytics-aggregates.ts` (A12),
 * and stamps it with the instant those aggregates were last refreshed
 * (`analytics_aggregate_refresh.refreshed_at`) so the service can echo it as the
 * response `computedAt` (Req 20.6). The pure {@link computeAnalytics} core then
 * turns that snapshot into metrics — unchanged.
 *
 * WHAT THIS READER CAN SERVE (from real, mirrored columns):
 *   - customers    (enrolment mirror)            → analytics_customers
 *   - ledger       (immutable ledger projection) → analytics_ledger
 *   - redemptions  (redemption behaviour)        → analytics_redemptions
 *
 * DOCUMENTED BOUNDARY — `orders` is intentionally EMPTY. Shopify order facts
 * (per-order eligible GBP totals + paid-at instants) are NOT mirrored in
 * Postgres (see the migration's header). We DO NOT fabricate them; the order-
 * derived metrics (clv, repeatPurchaseRate, royalVipGrowth, and the order-only
 * contribution to engagement.activePct) therefore resolve to their empty-safe
 * zeros until a Shopify order mirror is added. Every ledger/redemption/enrolment
 * metric is served in full.
 *
 * SAFETY: constructing this reader touches nothing. It issues read-only SELECTs
 * only when a caller passes a real `pg` Pool/PoolClient at runtime, and reaches
 * no Shopify API. It is unit-tested against an in-memory fake {@link Queryable},
 * so no live database is touched during verification; applying the backing
 * migration and validating against a real Postgres is deferred to deploy time.
 */
import type { QueryResultRow } from "pg";
import type { Queryable, LedgerEntryType } from "../ledger/repository.js";
import type {
  AnalyticsCustomerRecord,
  AnalyticsLedgerRecord,
  AnalyticsRedemptionRecord,
  AnalyticsSource,
  DateRange,
} from "./analytics.js";
import type { AnalyticsDataSource, AnalyticsSnapshot } from "./analyticsService.js";

/* -------------------------------------------------------------------------- */
/* Materialized-view / state-table names (must match the migration).          */
/* -------------------------------------------------------------------------- */

/** The customer-enrolment materialized view. */
export const ANALYTICS_CUSTOMERS_MATVIEW = "analytics_customers" as const;
/** The ledger-projection materialized view. */
export const ANALYTICS_LEDGER_MATVIEW = "analytics_ledger" as const;
/** The redemption-projection materialized view. */
export const ANALYTICS_REDEMPTIONS_MATVIEW = "analytics_redemptions" as const;
/** The single-row table stamping when the aggregates were last refreshed. */
export const ANALYTICS_REFRESH_STATE_TABLE = "analytics_aggregate_refresh" as const;

/**
 * The materialized views, in a stable order. Shared with the refresh job so the
 * job and the reader agree on exactly which views back the analytics snapshot.
 */
export const ANALYTICS_MATVIEWS = [
  ANALYTICS_CUSTOMERS_MATVIEW,
  ANALYTICS_LEDGER_MATVIEW,
  ANALYTICS_REDEMPTIONS_MATVIEW,
] as const;

/* -------------------------------------------------------------------------- */
/* SQL (read-only).                                                            */
/* -------------------------------------------------------------------------- */

const SELECT_CUSTOMERS_SQL = `SELECT customer_id, enrolled_at FROM ${ANALYTICS_CUSTOMERS_MATVIEW}`;

const SELECT_LEDGER_SQL = `SELECT customer_id, entry_type, points, created_at FROM ${ANALYTICS_LEDGER_MATVIEW}`;

const SELECT_REDEMPTIONS_SQL = `SELECT customer_id, reward_id, created_at FROM ${ANALYTICS_REDEMPTIONS_MATVIEW}`;

const SELECT_REFRESHED_AT_SQL = `SELECT refreshed_at FROM ${ANALYTICS_REFRESH_STATE_TABLE} LIMIT 1`;

/* -------------------------------------------------------------------------- */
/* Row shapes (as `pg` returns them).                                          */
/* -------------------------------------------------------------------------- */

interface CustomerRow extends QueryResultRow {
  customer_id: string;
  enrolled_at: Date | string | null;
}

interface LedgerRow extends QueryResultRow {
  customer_id: string;
  entry_type: string;
  points: string | number;
  created_at: Date | string;
}

interface RedemptionRow extends QueryResultRow {
  customer_id: string;
  reward_id: string;
  created_at: Date | string;
}

interface RefreshStateRow extends QueryResultRow {
  refreshed_at: Date | string | null;
}

/* -------------------------------------------------------------------------- */
/* Column coercion helpers.                                                    */
/* -------------------------------------------------------------------------- */

/** Coerce a timestamp column (`pg` returns TIMESTAMPTZ as a Date) to ISO 8601. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Coerce a nullable timestamp column to ISO 8601, preserving null. */
function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** Coerce a BIGINT column (`pg` returns it as a string) to a JS number. */
function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * A read-only {@link AnalyticsDataSource} backed by the analytics materialized
 * views. Construct with any {@link Queryable} (a `pg` Pool or PoolClient).
 *
 * The requested `range` is accepted for interface compatibility but the reader
 * returns the full projection: {@link computeAnalytics} re-filters by range
 * defensively, so returning a superset stays correct (and the views are small,
 * pre-aggregated projections). A future optimisation may push the range into the
 * SQL `WHERE` clause without changing this contract.
 */
export class PgAnalyticsDataSource implements AnalyticsDataSource {
  private readonly now: () => Date;

  constructor(
    private readonly db: Queryable,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async snapshot(_range: DateRange): Promise<AnalyticsSnapshot> {
    const [customersResult, ledgerResult, redemptionsResult, refreshResult] = await Promise.all([
      this.db.query<CustomerRow>(SELECT_CUSTOMERS_SQL),
      this.db.query<LedgerRow>(SELECT_LEDGER_SQL),
      this.db.query<RedemptionRow>(SELECT_REDEMPTIONS_SQL),
      this.db.query<RefreshStateRow>(SELECT_REFRESHED_AT_SQL),
    ]);

    const customers: AnalyticsCustomerRecord[] = customersResult.rows.map((row) => ({
      customerId: row.customer_id,
      enrolledAt: toIsoOrNull(row.enrolled_at),
    }));

    const ledger: AnalyticsLedgerRecord[] = ledgerResult.rows.map((row) => ({
      customerId: row.customer_id,
      entryType: row.entry_type as LedgerEntryType,
      points: toNumber(row.points),
      createdAt: toIso(row.created_at),
    }));

    const redemptions: AnalyticsRedemptionRecord[] = redemptionsResult.rows.map((row) => ({
      customerId: row.customer_id,
      rewardId: row.reward_id,
      createdAt: toIso(row.created_at),
    }));

    // BOUNDARY (see header): Shopify order facts are not mirrored in Postgres,
    // so the orders array is empty. Order-derived metrics resolve to empty-safe
    // zeros in the pure core until a Shopify order mirror exists.
    const source: AnalyticsSource = { customers, orders: [], ledger, redemptions };

    // `refreshed_at` is the instant the aggregates were last recomputed (Req
    // 20.6). Fall back to the injected clock if the state row is missing/null.
    const stateRow = refreshResult.rows[0];
    const refreshedAt =
      stateRow && stateRow.refreshed_at !== null
        ? toIso(stateRow.refreshed_at)
        : this.now().toISOString();

    return { source, refreshedAt };
  }
}

/** Convenience factory mirroring the in-memory factory in `analyticsService`. */
export function createPgAnalyticsDataSource(
  db: Queryable,
  options?: { now?: () => Date },
): AnalyticsDataSource {
  return new PgAnalyticsDataSource(db, options ?? {});
}
