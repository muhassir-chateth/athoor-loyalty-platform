/**
 * Migration: create the pre-expiry notification dedupe/tracking table (task 10.2).
 *
 * Creates `pre_expiry_notifications` EXACTLY as documented by
 * {@link import("../src/expiry/preExpiryNotify.js").PRE_EXPIRY_NOTIFICATIONS_DDL}
 * in `src/expiry/preExpiryNotify.ts` — the authoritative spec for this table:
 *
 *   CREATE TABLE pre_expiry_notifications (
 *       id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *       point_lot_id  UUID NOT NULL REFERENCES point_lots(id),
 *       customer_id   UUID NOT NULL REFERENCES customers(id),
 *       expires_at    TIMESTAMPTZ NOT NULL,
 *       points        BIGINT NOT NULL,
 *       window_days   INTEGER NOT NULL,
 *       notified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
 *       UNIQUE (point_lot_id)
 *   );
 *
 * WHY THIS TABLE (Requirements 5.4, 5.5): the pre-expiry sweep
 * (`runPreExpiryNotify`) records ONE row here each time a lot is notified within
 * its pre-expiry window. The `UNIQUE (point_lot_id)` guard — combined with the
 * sweep's window-scoped `NOT EXISTS` filter — guarantees at most one pre-expiry
 * notification per lot, so repeat sweeps inside a lot's window are a no-op (Req
 * 5.5). It references `point_lots(id)` and `customers(id)` (owned by the
 * ledger-core migration) but is entirely separate from the immutable ledger:
 * a pre-expiry heads-up is NOT a point movement, so nothing is written to
 * `ledger_entries` and no balance is affected.
 *
 * ADDITIVE / OFF-LEDGER: this migration only CREATES the new tracking table. It
 * does NOT touch, alter, or depend on any existing migration file, and it never
 * mutates `point_lots`, `customers`, or `ledger_entries`.
 *
 * `gen_random_uuid()` is already provided by the ledger-core migration's
 * `CREATE EXTENSION` statements; this migration runs after it.
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it does NOT
 * execute anything against any live/production database. Application happens at
 * deploy time via `npm run migrate:up` against the target Postgres.
 *
 * Requirements: 5.4 (enqueue exactly one pre-expiry notification per qualifying
 * lot), 5.5 (never enqueue a duplicate within a lot's pre-expiry window).
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Dedupe/tracking table for pre-expiry notifications (Req 5.4, 5.5). Emitted
  // verbatim from PRE_EXPIRY_NOTIFICATIONS_DDL — the schema-verification test
  // asserts this matches the documented DDL exactly. SEPARATE from the ledger:
  // never affects balances. `gen_random_uuid()` comes from the ledger-core
  // migration's extensions; the FKs point at ledger-core tables it runs after.
  pgm.sql(`
    CREATE TABLE pre_expiry_notifications (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        point_lot_id  UUID NOT NULL REFERENCES point_lots(id),
        customer_id   UUID NOT NULL REFERENCES customers(id),
        expires_at    TIMESTAMPTZ NOT NULL,
        points        BIGINT NOT NULL,
        window_days   INTEGER NOT NULL,
        notified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (point_lot_id)
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Nothing references this tracking table, so a straightforward teardown is
  // sufficient. The shared `point_lots` / `customers` tables (owned by the
  // ledger-core migration) are intentionally left untouched.
  pgm.sql("DROP TABLE IF EXISTS pre_expiry_notifications;");
}
