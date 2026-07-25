/**
 * Migration: attribute redemptions to an originating Channel (task 21.1).
 *
 * Adds the ADDITIVE `channel` column to `redemptions` EXACTLY as specified in
 * design.md "Channel attribution (Requirement 19)":
 *
 *   ALTER TABLE redemptions ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';  -- web | app
 *
 * A CHECK constraint restricts the value to the two known channels (`web`,
 * `app`), matching the {@link import("../src/channel/channel.js").Channel} type
 * used by the engine.
 *
 * WHY ADDITIVE & SAFE (Req 19.7, 9.4/9.5):
 *   - The column is `NOT NULL DEFAULT 'web'`, so every EXISTING redemption row
 *     is backfilled to `web` automatically — the pre-app channel — and no read
 *     path that ignores the column changes. This does not alter any existing
 *     `/v1` request/response contract; it only lets the reward layer record and
 *     gate on channel (Req 19.3, 19.4).
 *   - Only `redemptions` gains a column. The immutable ledger (`ledger_entries`,
 *     `point_lots`) is NOT touched: it stays currency-/channel-agnostic, so
 *     balances and the FIFO projection are unaffected.
 *
 * This file edits no other migration. Applying it against a real Postgres is
 * deferred to deploy time via `npm run migrate:up`.
 *
 * Requirements: 19.3 (attribute rewards to an originating Channel), 19.4
 * (app-exclusive rewards granted only for `app`), 19.7 (additive-only).
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it touches no
 * live/production database.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Additive channel column; existing rows default to 'web' (the pre-app
  // channel), so the backfill is automatic and no existing behaviour changes.
  pgm.sql("ALTER TABLE redemptions ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';");
  // Constrain to the two known channels, mirroring the engine's Channel type.
  pgm.sql(
    "ALTER TABLE redemptions ADD CONSTRAINT redemptions_channel_check " +
      "CHECK (channel IN ('web', 'app'));",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse in creation order: drop the constraint, then the column. Nothing
  // else references the column, so teardown is clean and the ledger is untouched.
  pgm.sql(
    "ALTER TABLE redemptions DROP CONSTRAINT IF EXISTS redemptions_channel_check;",
  );
  pgm.sql("ALTER TABLE redemptions DROP COLUMN IF EXISTS channel;");
}
