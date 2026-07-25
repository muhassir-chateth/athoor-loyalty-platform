/**
 * Migration: analytics aggregates — materialized views + refresh state (task 17.x).
 *
 * Implements design.md "Component 7: Analytics / Reporting" and Requirement 20.3
 * / A12: admin analytics metrics derive SOLELY from the immutable `ledger_entries`
 * + Shopify order data via HOURLY-REFRESHED cached aggregates / materialized
 * views. This migration creates those materialized views so the analytics data
 * source ({@link import("../src/admin/pgAnalyticsDataSource.js")}) can read a
 * consistent {@link import("../src/admin/analytics.js").AnalyticsSource} snapshot
 * cheaply, plus a tiny state table that stamps WHEN the aggregates were last
 * refreshed (Req 20.6 — the response `computedAt`).
 *
 * WHAT THE MATERIALIZED VIEWS PROJECT (only columns that ACTUALLY exist):
 *   - analytics_customers    ← customers(id, enrolled_at)
 *   - analytics_ledger       ← ledger_entries(id, customer_id, entry_type, points, created_at)
 *   - analytics_redemptions  ← redemptions(id, customer_id, reward_id, created_at)
 * The join key is the LOCAL `customers.id` UUID — the same key `ledger_entries`
 * and `redemptions` foreign-key against — so all three views join consistently.
 *
 * DOCUMENTED BOUNDARY — Shopify order facts are NOT mirrored in Postgres.
 *   `AnalyticsSource.orders` needs per-order eligible GBP totals + paid-at
 *   instants. The schema mirrors ONLY: `ledger_entries.order_reference` (the
 *   Shopify order id on `earn_order` entries) and `customers.lifetime_spend_gbp`
 *   (a CUMULATIVE cache, not per-order). Neither yields a per-order eligible
 *   total, and converting points→GBP would require the earn-rate rules (domain
 *   logic, not a column). We therefore DO NOT fabricate an orders matview; the
 *   data source returns `orders: []`. Consequently the order-derived metrics
 *   (clv, repeatPurchaseRate, royalVipGrowth, and the order-only contribution to
 *   engagement.activePct) resolve to their empty-safe zeros until a Shopify order
 *   mirror is added. The ledger/redemption/enrolment-derived metrics
 *   (mostRewardedCustomers, redemption rate + reward-tier popularity,
 *   engagement.enrolledPct, and the ledger-activity contribution to activePct)
 *   are fully served from the columns above.
 *
 * CONCURRENT REFRESH: each matview carries a UNIQUE index on its source row id,
 * which is what lets the hourly job run `REFRESH MATERIALIZED VIEW CONCURRENTLY`
 * without blocking readers. The matviews are created `WITH NO DATA` and then
 * populated by a plain (non-concurrent) `REFRESH` inside this migration — a
 * concurrent refresh cannot run in a transaction, and node-pg-migrate wraps a
 * migration in one, so the initial populate is deliberately non-concurrent.
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it touches no
 * live/production database; application happens at deploy time via
 * `npm run migrate:up`. The immutable ledger is READ ONLY here — no ledger table
 * is altered, dropped, or written.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /* Materialized view: customer enrolment mirror (customers).              */
  /* Serves AnalyticsSource.customers → { customerId, enrolledAt }.         */
  /* ---------------------------------------------------------------------- */
  pgm.sql(`
    CREATE MATERIALIZED VIEW analytics_customers AS
      SELECT
        c.id           AS customer_id,   -- local UUID, the analytics join key
        c.enrolled_at  AS enrolled_at    -- NULL until the customer enrols
      FROM customers c
    WITH NO DATA;
  `);
  // UNIQUE index on the PK column enables REFRESH ... CONCURRENTLY.
  pgm.sql(
    "CREATE UNIQUE INDEX analytics_customers_pk ON analytics_customers (customer_id);",
  );

  /* ---------------------------------------------------------------------- */
  /* Materialized view: analytics-relevant ledger projection.              */
  /* Serves AnalyticsSource.ledger → { customerId, entryType, points, createdAt }. */
  /* ---------------------------------------------------------------------- */
  pgm.sql(`
    CREATE MATERIALIZED VIEW analytics_ledger AS
      SELECT
        l.id          AS entry_id,       -- immutable ledger row id (unique key)
        l.customer_id AS customer_id,
        l.entry_type  AS entry_type,
        l.points      AS points,         -- signed BIGINT
        l.created_at  AS created_at
      FROM ledger_entries l
    WITH NO DATA;
  `);
  pgm.sql("CREATE UNIQUE INDEX analytics_ledger_pk ON analytics_ledger (entry_id);");
  // Supporting index for the range + per-customer scans the analytics reader does.
  pgm.sql(
    "CREATE INDEX analytics_ledger_customer_created ON analytics_ledger (customer_id, created_at);",
  );

  /* ---------------------------------------------------------------------- */
  /* Materialized view: redemption behaviour projection.                   */
  /* Serves AnalyticsSource.redemptions → { customerId, rewardId, createdAt }. */
  /* ---------------------------------------------------------------------- */
  pgm.sql(`
    CREATE MATERIALIZED VIEW analytics_redemptions AS
      SELECT
        r.id          AS redemption_id,  -- redemption row id (unique key)
        r.customer_id AS customer_id,
        r.reward_id   AS reward_id,
        r.created_at  AS created_at
      FROM redemptions r
    WITH NO DATA;
  `);
  pgm.sql(
    "CREATE UNIQUE INDEX analytics_redemptions_pk ON analytics_redemptions (redemption_id);",
  );
  pgm.sql(
    "CREATE INDEX analytics_redemptions_created ON analytics_redemptions (created_at);",
  );

  /* ---------------------------------------------------------------------- */
  /* Refresh-state table: stamps when the aggregates were last recomputed.  */
  /* Single-row (id = TRUE guard); the refresh job updates refreshed_at,    */
  /* the data source reads it as the response `computedAt` (Req 20.6, A12). */
  /* ---------------------------------------------------------------------- */
  pgm.sql(`
    CREATE TABLE analytics_aggregate_refresh (
        id            BOOLEAN PRIMARY KEY DEFAULT TRUE,
        refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (id)    -- enforce a single row (id is always TRUE)
    );
  `);
  // Seed the single row so the reader always finds a stamp.
  pgm.sql("INSERT INTO analytics_aggregate_refresh (id) VALUES (TRUE);");

  /* ---------------------------------------------------------------------- */
  /* Initial populate. Non-concurrent (a concurrent refresh cannot run in a */
  /* transaction); the hourly job uses CONCURRENTLY thereafter.             */
  /* ---------------------------------------------------------------------- */
  pgm.sql("REFRESH MATERIALIZED VIEW analytics_customers;");
  pgm.sql("REFRESH MATERIALIZED VIEW analytics_ledger;");
  pgm.sql("REFRESH MATERIALIZED VIEW analytics_redemptions;");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop the refresh-state table first, then the materialized views. Dropping a
  // matview also drops its indexes. The underlying ledger/customer/redemption
  // tables (owned by earlier migrations) are intentionally left untouched.
  pgm.sql("DROP TABLE IF EXISTS analytics_aggregate_refresh;");
  pgm.sql("DROP MATERIALIZED VIEW IF EXISTS analytics_redemptions;");
  pgm.sql("DROP MATERIALIZED VIEW IF EXISTS analytics_ledger;");
  pgm.sql("DROP MATERIALIZED VIEW IF EXISTS analytics_customers;");
}
