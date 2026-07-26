/**
 * Migration: create the idempotency-keys deduplication table (task 14).
 *
 *   CREATE TABLE idempotency_keys (
 *     key          TEXT PRIMARY KEY,
 *     status_code  INT  NOT NULL,
 *     payload      TEXT NOT NULL,
 *     content_type TEXT NOT NULL,
 *     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *
 * WHY THIS TABLE: `PgIdempotencyStore` (src/idempotency/store.ts) has been
 * implemented since the beginning of the project, but it was never wired into
 * production because this table did not exist. Without it, `buildApp` fell back
 * to `InMemoryIdempotencyStore`, making the Req 9.6 **24-hour** replay window
 * process-local. On zero-cost hosting (Render Free, ~15-minute idle spin-down)
 * the effective window was minutes, not a day — a broken API contract.
 *
 * SCHEMA NOTES:
 * - `key` is the PRIMARY KEY: `ON CONFLICT (key) DO NOTHING` in the store
 *   enforces first-write-wins without a separate unique index.
 * - `created_at` drives the windowed SELECT: entries older than 24 h are
 *   treated as absent so a request after the window processes fresh.
 * - The table is intentionally small (TEXT key, INT code, TEXT payload,
 *   content-type, timestamp). Old entries older than 24 h are dead weight;
 *   a periodic DELETE WHERE created_at < now() - interval '25 hours' keeps
 *   the table lean (run manually or via the reconciliation job).
 *
 * OFF-LEDGER AND ADDITIVE: this table holds gateway-level dedupe state only.
 * It references nothing and is referenced by nothing, never touches
 * `ledger_entries`, `point_lots` or any balance — so it cannot affect any
 * ledger correctness property.
 *
 * SAFETY: a local migration DEFINITION only. Creating this file executes
 * nothing against any database; application happens at deploy time via
 * `npm run migrate:up`.
 *
 * Requirements: 9.6 (24-hour idempotency window), 9.7 (reject invalid key).
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE idempotency_keys (
      key          TEXT PRIMARY KEY,
      status_code  INT  NOT NULL,
      payload      TEXT NOT NULL,
      content_type TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dedupe state only — dropping it means the 24-hour window is lost for
  // currently live keys, but no ledger integrity is affected.
  pgm.sql("DROP TABLE IF EXISTS idempotency_keys;");
}
