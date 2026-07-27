/**
 * Migration: give a benefit request a lifecycle an operator can act on
 * (task 41) — Req 18.5, 10.5, 10.9.
 *
 *   ALTER TABLE benefit_requests
 *     ADD COLUMN status_changed_at TIMESTAMPTZ,
 *     ADD CONSTRAINT benefit_requests_status_check
 *         CHECK (status IN ('requested','confirmed','fulfilled','declined','cancelled'));
 *
 *   ALTER TABLE admin_audit_log  -- extend the operation_type CHECK
 *     … CHECK (operation_type IN
 *        ('adjustment','manual_credit','migration','reconciliation','benefit_request'));
 *
 * WHY: task 30 gave `POST /v1/benefits/:key/request` a production call site, so
 * `benefit_requests` rows are now really created — and **nothing read or advanced
 * them**. A member could book a private consultation and no member of staff would
 * ever see it: durable, and operationally invisible, which is worse than refusing
 * the booking outright. Found while wiring task 30 and tracked as this task.
 *
 * STATUS SET. The design comments the column as
 * `requested | confirmed | fulfilled | cancelled`. This adds **`declined`**,
 * because the four documented values cannot express the commonest real outcome:
 * staff refusing a request. Folding a refusal into `cancelled` would make the
 * two indistinguishable, and they are not the same event — `cancelled` is
 * withdrawal (by the member or by staff before any decision), `declined` is a
 * decision not to grant. `confirmed` is RETAINED as the optional intermediate the
 * design allows ("accepted, not yet delivered"), not dropped. Recorded as a spec
 * amendment rather than a silent divergence.
 *
 * A CHECK now constrains the column, which it never did. The set is closed, so an
 * unknown status is rejected by the database rather than stored and later
 * misread. Every existing row is `requested`, which satisfies it.
 *
 * `status_changed_at` is NULLABLE and deliberately left NULL for existing rows: a
 * request that has never been actioned HAS no transition time, and back-filling
 * `requested_at` into it would fabricate a decision that never happened (the same
 * rule already applied to `webhook_events.processed_at` under task 23).
 *
 * WHY NO `decided_by` COLUMN: the acting admin belongs in `admin_audit_log`,
 * which is immutable and already the answer to "who did this" (Req 10.9). A copy
 * on the row would be a second, mutable source of truth for the same fact. The
 * audit trail is extended instead with a `benefit_request` operation type, so
 * every transition is attributable without duplicating the actor.
 *
 * OFF-LEDGER: touches `benefit_requests` and the audit CHECK only. No ledger
 * entry, point lot or balance is involved, so no ledger correctness property can
 * be affected.
 *
 * SAFETY: a local migration DEFINITION only; applied via `npm run migrate:up`.
 *
 * Requirements: 18.5, 10.5, 10.9.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Every status a benefit request may hold. Mirrored by the application. */
export const BENEFIT_REQUEST_STATUSES = [
  "requested",
  "confirmed",
  "fulfilled",
  "declined",
  "cancelled",
] as const;

const STATUS_LIST = BENEFIT_REQUEST_STATUSES.map((s) => `'${s}'`).join(", ");

/** Audit operation types after this migration (the 4 existing + benefit_request). */
const AUDIT_OPERATION_TYPES = [
  "adjustment",
  "manual_credit",
  "migration",
  "reconciliation",
  "benefit_request",
];

const AUDIT_TYPE_LIST = AUDIT_OPERATION_TYPES.map((t) => `'${t}'`).join(", ");

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Fail loudly rather than silently rejecting rows the CHECK cannot accept.
  pgm.sql(`
    DO $$
    DECLARE
      offending int;
    BEGIN
      SELECT count(*) INTO offending
        FROM benefit_requests
       WHERE status NOT IN (${STATUS_LIST});
      IF offending > 0 THEN
        RAISE EXCEPTION
          'Cannot constrain benefit_requests.status: % row(s) hold a status outside (%). Resolve those rows first; this migration will not rewrite them.',
          offending, '${BENEFIT_REQUEST_STATUSES.join(", ")}';
      END IF;
    END $$;
  `);

  pgm.sql("ALTER TABLE benefit_requests ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;");

  pgm.sql(`
    ALTER TABLE benefit_requests
      DROP CONSTRAINT IF EXISTS benefit_requests_status_check;
  `);
  pgm.sql(`
    ALTER TABLE benefit_requests
      ADD CONSTRAINT benefit_requests_status_check
      CHECK (status IN (${STATUS_LIST}));
  `);

  // The operator queue reads open requests oldest-first: the thing waiting
  // longest is the thing to action next.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_benefit_requests_status
      ON benefit_requests (status, requested_at);
  `);

  // Extend the audit CHECK so a transition can be recorded (Req 10.9). The
  // constraint name is the one node-pg-migrate/Postgres generated for the
  // original inline CHECK on this table.
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
  // Reverting narrows both CHECKs. Any row already holding a new value would
  // violate them, so the audit narrowing refuses rather than deleting history.
  pgm.sql(`
    DO $$
    DECLARE
      offending int;
    BEGIN
      SELECT count(*) INTO offending FROM admin_audit_log WHERE operation_type = 'benefit_request';
      IF offending > 0 THEN
        RAISE EXCEPTION
          'Cannot narrow admin_audit_log.operation_type: % benefit_request record(s) exist and the audit trail is immutable.',
          offending;
      END IF;
      SELECT count(*) INTO offending FROM benefit_requests WHERE status = 'declined';
      IF offending > 0 THEN
        RAISE EXCEPTION 'Cannot narrow benefit_requests.status: % row(s) are declined.', offending;
      END IF;
    END $$;
  `);
  pgm.sql("DROP INDEX IF EXISTS idx_benefit_requests_status;");
  pgm.sql("ALTER TABLE benefit_requests DROP CONSTRAINT IF EXISTS benefit_requests_status_check;");
  pgm.sql("ALTER TABLE benefit_requests DROP COLUMN IF EXISTS status_changed_at;");
  pgm.sql(`
    ALTER TABLE admin_audit_log
      DROP CONSTRAINT IF EXISTS admin_audit_log_operation_type_check;
  `);
  pgm.sql(`
    ALTER TABLE admin_audit_log
      ADD CONSTRAINT admin_audit_log_operation_type_check
      CHECK (operation_type IN ('adjustment', 'manual_credit', 'migration', 'reconciliation'));
  `);
}
