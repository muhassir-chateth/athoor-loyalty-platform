/**
 * Migration: create the immutable admin audit-trail table (task 17.1).
 *
 * Requirement 10.9 requires that EVERY manual adjustment, manual credit,
 * migration, and reconciliation operation produces an immutable audit-trail
 * record capturing the acting Admin_User identifier, the operation type, the
 * affected customer identifier (where applicable), and the timestamp.
 *
 * This table is the single home for that audit trail. It is APPEND-ONLY at the
 * application layer (the {@link AuditTrailRecorder} exposes only an insert; no
 * update/delete path exists), mirroring the append-only discipline of
 * `ledger_entries`. Rows are never mutated once written.
 *
 * Columns (design.md → AdminCtx = { adminUserId, role: "admin" }):
 *   - admin_user_id         the acting Admin_User identifier (Req 10.9). For a
 *                           system-initiated migration/reconciliation this is a
 *                           reserved system actor id rather than null, so the
 *                           actor is always attributable.
 *   - operation_type        adjustment | manual_credit | migration | reconciliation
 *   - affected_customer_id  the customer the operation touched, or NULL for a
 *                           system-wide operation (migration/reconciliation).
 *   - ledger_entry_id       links a point-moving audit record (adjustment /
 *                           manual credit) to the exact ledger row it produced,
 *                           for a complete, cross-referenced trail. NULL for
 *                           operations that produce no single ledger row.
 *   - detail                JSONB free-form context (delta, reason, action,
 *                           processed/failed counts, …) so new operation shapes
 *                           are captured without a schema change.
 *   - created_at            the operation timestamp (Req 10.9).
 *
 * This migration is strictly ADDITIVE: it references the existing
 * `customers(id)` and `ledger_entries(id)` from the ledger-core migration but
 * modifies neither. It does NOT touch `ledger_entries`, so the append-only
 * ledger contract (task 2.1) is unchanged.
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it touches
 * no live/production database. Application happens at deploy time via
 * `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Immutable admin audit trail (Requirement 10.9). Append-only at the app
  // layer; no UPDATE/DELETE path is exposed by the recorder.
  pgm.sql(`
    CREATE TABLE admin_audit_log (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_user_id        TEXT NOT NULL,                 -- acting Admin_User (or reserved system actor)
        operation_type       TEXT NOT NULL,                 -- adjustment | manual_credit | migration | reconciliation
        affected_customer_id UUID REFERENCES customers(id), -- NULL for system-wide ops
        ledger_entry_id      UUID REFERENCES ledger_entries(id), -- NULL when no single ledger row is produced
        detail               JSONB NOT NULL DEFAULT '{}',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (operation_type IN ('adjustment', 'manual_credit', 'migration', 'reconciliation'))
    );
  `);

  // Fraud-review / customer-history reads: audit records for a given customer,
  // most-recent-first (task 17.2, Req 10.5/10.6).
  pgm.sql(
    "CREATE INDEX idx_admin_audit_customer ON admin_audit_log(affected_customer_id, created_at DESC);",
  );
  // Operation-type reporting across the whole program.
  pgm.sql(
    "CREATE INDEX idx_admin_audit_operation ON admin_audit_log(operation_type, created_at DESC);",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("DROP TABLE IF EXISTS admin_audit_log;");
}
