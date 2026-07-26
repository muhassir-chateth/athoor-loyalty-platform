/**
 * Migration: create the backup-run bookkeeping table (task 29, Option B).
 *
 *   CREATE TABLE backup_runs (
 *       id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *       kind         TEXT NOT NULL,
 *       destination  TEXT NOT NULL,
 *       size_bytes   BIGINT NOT NULL CHECK (size_bytes > 0),
 *       sha256       TEXT NOT NULL,
 *       encrypted    BOOLEAN NOT NULL DEFAULT true,
 *       started_at   TIMESTAMPTZ NOT NULL,
 *       completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *
 * WHY THIS TABLE: Requirement 13.6 asks for point-in-time recovery, automated
 * backups and WAL retention of at least 7 days. The zero-cost hosting decision
 * (Supabase Free) provides NONE of those three: no automated backups, no PITR,
 * no WAL retention. Rather than leave the requirement quietly unmet, the
 * platform takes daily ENCRYPTED LOGICAL DUMPS from CI
 * (`.github/workflows/backup.yml`) and amends the standard to a 24-hour RPO with
 * a manual RTO, until traffic justifies the paid tier that restores real PITR.
 *
 * A backup mechanism that stops running without anyone noticing is worthless —
 * and silent failure is the exact failure mode this codebase has repeatedly
 * shipped (pg-boss cron skipping windows; four rounds of "implemented but never
 * reachable" wiring). So each SUCCESSFUL backup records one row here, and the
 * service reads the latest row on `/health` (`backups.stale`). Absence of a
 * recent row is therefore observable, and the keep-alive watchdog can fail
 * loudly on it, exactly as it does for overdue scheduled jobs.
 *
 * SCHEMA NOTES:
 * - `sha256` + `size_bytes` describe the ENCRYPTED artifact, so the recorded
 *   digest can be checked against the artifact an operator actually downloads
 *   before spending time on a restore. `size_bytes > 0` rejects the classic
 *   "backup succeeded, file is empty" outcome.
 * - `encrypted` defaults to true and is recorded per row rather than assumed:
 *   dumps contain customer PII (`customers.email` is CITEXT), so an unencrypted
 *   dump would be a data-handling incident and must be visible as such.
 * - `started_at` is supplied by the writer and `completed_at` defaults to now(),
 *   so duration is derivable without a second write.
 * - The index on `completed_at DESC` serves the only read this table has: "what
 *   is the most recent successful backup?".
 * - Nothing here records a FAILED backup: CI failing loudly is the failure
 *   signal, and a stale `completed_at` is the durable one. Storing attempted-
 *   but-failed rows would make `completed_at DESC` mean "last attempt" instead
 *   of "last recoverable point", which is the value we actually need.
 *
 * OFF-LEDGER AND ADDITIVE: this table holds operational bookkeeping only. It
 * references nothing and is referenced by nothing, never touches
 * `ledger_entries`, `point_lots` or any balance, and alters no existing table —
 * so it cannot affect any ledger correctness property. Deleting every row would
 * degrade observability and nothing else.
 *
 * SAFETY: a local migration DEFINITION only. Creating this file executes nothing
 * against any database; application happens at deploy time via
 * `npm run migrate:up`.
 *
 * Requirements: 13.6 (as amended — daily automated logical backups with ≥7-day
 * retention; PITR deferred above the upgrade threshold).
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // `gen_random_uuid()` is built in from PostgreSQL 13 (and provided by pgcrypto
  // on Supabase regardless), matching the id default used by the existing tables.
  pgm.sql(`
    CREATE TABLE backup_runs (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind         TEXT NOT NULL,
        destination  TEXT NOT NULL,
        size_bytes   BIGINT NOT NULL CHECK (size_bytes > 0),
        sha256       TEXT NOT NULL,
        encrypted    BOOLEAN NOT NULL DEFAULT true,
        started_at   TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // The staleness watchdog reads exactly one row: the newest completion.
  pgm.sql("CREATE INDEX backup_runs_completed_at_desc_idx ON backup_runs (completed_at DESC);");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Operational bookkeeping only — nothing references it, so teardown is safe.
  // Dropping it loses the backup history, which makes `/health` report the
  // never-backed-up state; it destroys no backup artifact and no ledger data.
  pgm.sql("DROP TABLE IF EXISTS backup_runs;");
}
