/**
 * Migration: create the due-work scheduling state table (task 24).
 *
 *   CREATE TABLE scheduled_runs (
 *       job_name         TEXT PRIMARY KEY,
 *       interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
 *       last_run_at      TIMESTAMPTZ,
 *       created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *
 * WHY THIS TABLE: the recurring jobs were driven by pg-boss cron, which fires
 * only when the previous cron occurrence is under 60 seconds old AND the process
 * is alive (verified in `pg-boss@10.4.2` `src/timekeeper.js`). On a host that
 * sleeps when idle, an elapsed window is skipped silently and never replayed, so
 * the daily expiry scan effectively never ran.
 *
 * Persisting `last_run_at` turns "did the cron instant coincide with the process
 * being awake?" into "have `interval_seconds` elapsed since the last run?" — a
 * question answerable at any later time. Work missed while the service slept is
 * therefore DELAYED until the next wake rather than lost (Req 5.2/5.3, 13.7).
 *
 * `last_run_at` is NULLABLE: a newly registered job has never run and is due
 * immediately, which is the wanted behaviour on a first deploy.
 *
 * OFF-LEDGER AND ADDITIVE: this table holds scheduling bookkeeping only. It
 * references nothing and is referenced by nothing, never touches
 * `ledger_entries`, `point_lots` or any balance, and alters no existing table —
 * so it cannot affect any ledger correctness property.
 *
 * SAFETY: a local migration DEFINITION only. Creating this file executes nothing
 * against any database; application happens at deploy time via
 * `npm run migrate:up`.
 *
 * Requirements: 5.2, 5.3 (expiry scan cadence and catch-up), 13.7
 * (reconciliation cadence).
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE scheduled_runs (
        job_name         TEXT PRIMARY KEY,
        interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
        last_run_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Scheduling bookkeeping only — nothing references it, so teardown is safe.
  // Dropping it loses only the last-run timestamps; every job would simply be
  // treated as due on the next boot.
  pgm.sql("DROP TABLE IF EXISTS scheduled_runs;");
}
