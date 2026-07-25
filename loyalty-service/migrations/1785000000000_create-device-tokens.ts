/**
 * Migration: create the mobile-readiness Device_Token registration schema and
 * the notification-event model (task 19.1).
 *
 * Creates two ADDITIVE tables:
 *
 *   1. device_tokens — the push-notification device registry for a FUTURE
 *      native mobile app, EXACTLY as specified in design.md "Additive Data
 *      Models":
 *        id, customer_id, token, platform, created_at,
 *        revoked_at (set on de-registration), UNIQUE (customer_id, token).
 *      Registration/de-registration are exposed additively under `/v1`
 *      (`POST /v1/devices`, `DELETE /v1/devices/:token`) WITHOUT altering any
 *      existing web request/response contract (Req 19.1, 19.7).
 *
 *   2. notification_events — models a loyalty notification (e.g. points
 *      expiring, reward ready, tier upgraded) as a customer-scoped event that
 *      can be ISSUED to that customer's registered Device_Tokens, WITHOUT
 *      requiring a web client to consume it (Req 19.2). The event is bound to a
 *      `customer_id` (never to a web session/client), and its delivery target
 *      is resolved from that customer's non-revoked `device_tokens` rows — so a
 *      web client is not in the loop. Delivery itself is future (design.md:
 *      "Delivery is future"); this migration only models the event so the
 *      capability is not precluded.
 *
 * ADDITIVE-ONLY / OFF-LEDGER: both tables live ALONGSIDE the immutable ledger.
 * They reference the existing `customers(id)` (from the ledger-core migration)
 * but never touch, alter, or depend on `ledger_entries` / `point_lots`, and
 * they never affect any customer's Balance or Spendable_Balance. This file does
 * NOT edit the ledger-core, benefits, profile, or admin-audit migrations, and
 * it adds no breaking `/v1` change (Req 9.4/9.5, 19.7).
 *
 * Requirements: 19.1 (register/de-register Device_Tokens additively), 19.2
 * (model notification events targeting Device_Tokens), 19.7 (additive-only).
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it touches
 * no live/production database. Application happens at deploy time via
 * `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Push-notification device registration for a FUTURE mobile app
  // (Requirement 19). Delivery is future — this table only holds the registry.
  // `gen_random_uuid()` is already provided by the ledger-core migration's
  // `CREATE EXTENSION` statements; this migration runs after it.
  pgm.sql(`
    CREATE TABLE device_tokens (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id         UUID NOT NULL REFERENCES customers(id),
        token               TEXT NOT NULL,
        platform            TEXT NOT NULL,              -- ios | android
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at          TIMESTAMPTZ,               -- set on de-registration
        UNIQUE (customer_id, token)
    );
  `);
  // Resolve a customer's ACTIVE (non-revoked) tokens efficiently — the set a
  // notification event is issued to (Req 19.2).
  pgm.sql(
    "CREATE INDEX idx_device_tokens_active ON device_tokens(customer_id) WHERE revoked_at IS NULL;",
  );

  // Notification-event model (Req 19.2). A notification is a customer-scoped
  // event that can be delivered to that customer's registered Device_Tokens
  // without a web client consuming it. `event_type` names the notification
  // (e.g. points_expiring, reward_ready, tier_upgraded); `payload` carries the
  // event-specific data (e.g. expiring amount + expiry date). Delivery is
  // future; the row models the event so the mobile-push capability is not
  // precluded.
  pgm.sql(`
    CREATE TABLE notification_events (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id         UUID NOT NULL REFERENCES customers(id),
        event_type          TEXT NOT NULL,             -- e.g. points_expiring | reward_ready | tier_upgraded
        payload             JSONB NOT NULL DEFAULT '{}',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(
    "CREATE INDEX idx_notification_events_customer ON notification_events(customer_id, created_at);",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop in reverse creation order. Neither table is referenced by any other
  // table, so a straightforward teardown is sufficient. The `customers` table
  // (owned by the ledger-core migration) is intentionally left untouched.
  pgm.sql("DROP TABLE IF EXISTS notification_events;");
  pgm.sql("DROP TABLE IF EXISTS device_tokens;");
}
