/**
 * Migration: allow the operator-run redaction procedure to record an audit
 * record (spec task 15.3) — Requirements 23.5, 23.7, 10.9.
 *
 * ── WHY THIS MIGRATION IS NECESSARY AND NOT AVOIDABLE ───────────────────────
 * Task 15.3 requires the redaction procedure to "write to `admin_audit_log`", and
 * `admin_audit_log.operation_type` carries a CHECK restricting it to a closed set.
 * None of the existing values describes a redaction: recording one as
 * `reconciliation` or `migration` would put a false statement in the audit trail,
 * which is worse than no record — an audit log you cannot trust is a liability
 * rather than a control, and Requirement 23.5's whole point is that an erasure is
 * accountable.
 *
 * So the CHECK is extended, using the pattern this codebase already established:
 * migration `1785900000000_benefit-request-lifecycle` did exactly this to add
 * `benefit_request`, down to the guarded `down`. Following the existing precedent
 * rather than inventing a second mechanism.
 *
 * ── THIS IS THE ONLY SCHEMA CHANGE TASK 15 MAKES ────────────────────────────
 * `customer_erasure_requests` already exists (task 6.1) with the `status` and
 * `source` vocabularies task 15.2/15.3 need, including `'shopify_redaction'`. No
 * table is created, no column is added, and nothing is dropped.
 *
 * ── ADDITIVE, AND OFF-LEDGER ────────────────────────────────────────────────
 * A CHECK is WIDENED, never narrowed, so every row that satisfied it before still
 * does and no existing write path can begin to fail. Nothing here touches
 * `ledger_entries`, `point_lots`, `redemptions`, `discount_codes` or `referrals`,
 * so no balance and no ledger correctness property can be affected (Req 23.6).
 *
 * ── ROLLBACK REFUSES RATHER THAN DELETING HISTORY ───────────────────────────
 * `down` narrows the CHECK, which any existing `customer_redaction` row would
 * violate. It therefore RAISES rather than deleting those rows: an audit trail
 * that a rollback can quietly erase is not an audit trail. Same choice, and the
 * same shape, as the benefit-request migration's `down`.
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it executes
 * NOTHING against any live/production database. Application is a separate,
 * deploy-time action: `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The audit `operation_type` vocabulary AFTER this migration.
 *
 * Kept in step with `AUDIT_OPERATION_TYPES` in `src/admin/auditTrail.ts`, and
 * `redaction.test.ts` asserts the two agree by reading this file — so the code and
 * the constraint cannot drift into disagreement.
 */
const AUDIT_TYPES = [
  "adjustment",
  "manual_credit",
  "migration",
  "reconciliation",
  "benefit_request",
  "customer_redaction",
] as const;

const AUDIT_TYPE_LIST = AUDIT_TYPES.map((t) => `'${t}'`).join(", ");

/** The vocabulary before this migration — restored by `down`. */
const PREVIOUS_TYPES = AUDIT_TYPES.filter((t) => t !== "customer_redaction");
const PREVIOUS_TYPE_LIST = PREVIOUS_TYPES.map((t) => `'${t}'`).join(", ");

export async function up(pgm: MigrationBuilder): Promise<void> {
  // The constraint name is the one Postgres generated for the original inline
  // CHECK on this table, reused by the benefit-request migration.
  pgm.sql(`
    ALTER TABLE admin_audit_log
      DROP CONSTRAINT IF EXISTS admin_audit_log_operation_type_check;
  `);
  pgm.sql(`
    ALTER TABLE admin_audit_log
      ADD CONSTRAINT admin_audit_log_operation_type_check
      CHECK (operation_type IN (${AUDIT_TYPE_LIST}));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Narrowing would invalidate any redaction record already written. Refuse
  // loudly instead of deleting one: a redaction is the single most
  // consequence-bearing operation this service performs, and its record is the
  // only evidence it happened.
  pgm.sql(`
    DO $$
    DECLARE
      offending int;
    BEGIN
      SELECT count(*) INTO offending
        FROM admin_audit_log
       WHERE operation_type = 'customer_redaction';
      IF offending > 0 THEN
        RAISE EXCEPTION
          'Cannot narrow admin_audit_log.operation_type: % customer_redaction record(s) exist and the audit trail is immutable.',
          offending;
      END IF;
    END $$;
  `);
  pgm.sql(`
    ALTER TABLE admin_audit_log
      DROP CONSTRAINT IF EXISTS admin_audit_log_operation_type_check;
  `);
  pgm.sql(`
    ALTER TABLE admin_audit_log
      ADD CONSTRAINT admin_audit_log_operation_type_check
      CHECK (operation_type IN (${PREVIOUS_TYPE_LIST}));
  `);
}
