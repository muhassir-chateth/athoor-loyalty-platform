/**
 * Migration: create the configurable, tier-gated Benefits schema + seed the
 * initial Benefit catalogue (task 15.1).
 *
 * Creates the two additive tables from design.md "Additive Data Models"
 * EXACTLY as specified:
 *   - benefits          (id, key UNIQUE, name, min_qualifying_tier,
 *                        config JSONB DEFAULT '{}', active BOOLEAN DEFAULT true)
 *   - benefit_requests  (id, customer_id, benefit_id, status DEFAULT 'requested',
 *                        requested_at) + idx_benefit_requests_customer
 *
 * Requirement 18 models entitlements as *configuration-driven* definitions:
 * each Benefit pairs a `key` with a `min_qualifying_tier` and a free-form JSONB
 * `config`, so new Benefit types are added by configuration (a new seed row)
 * with NO schema redesign and NO breaking `/v1` change (Req 18.1, 18.7).
 *
 * These tables are strictly ADDITIVE: they reference the existing
 * `customers(id)` from the ledger-core migration but do not modify it, and they
 * never touch `ledger_entries`. This file does NOT edit the ledger-core or
 * profile migrations.
 *
 * Seed (Req 18.4 / A13): the Royal_VIP private-client perks (private
 * consultations, early access to launches, limited-edition releases, exclusive
 * samples, dedicated personal service/concierge, invitation-only experiences)
 * are inserted as configurable Benefits gated to `royal_vip` with
 * `active = false` — they are future roadmap, so the framework is proven while
 * the perks stay switched off until the business enables them. The INSERTs use
 * `ON CONFLICT (key) DO NOTHING` so the migration is idempotent and safe to
 * re-run. This seed list is kept in lock-step with
 * `src/benefits/benefit-definitions.ts` (verified by a test) but is inlined
 * here so the migration is self-contained and deploy-safe (no dependency on
 * evolving application code).
 *
 * The Entitlement Resolver (task 15.2) is intentionally NOT implemented here.
 *
 * Requirements: 18.1, 18.4, 18.7.
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it touches
 * no live/production database. Application happens at deploy time via
 * `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Configurable, tier-gated entitlements (Requirement 18). New Benefit types
  // are added by configuration — no schema redesign (Req 18.1, 18.7).
  pgm.sql(`
    CREATE TABLE benefits (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key                 TEXT UNIQUE NOT NULL,       -- e.g. private_consultation, exclusive_release
        name                TEXT NOT NULL,
        min_qualifying_tier TEXT NOT NULL,              -- bronze | silver | gold | royal_vip
        config              JSONB NOT NULL DEFAULT '{}',-- perk-specific config for future types (A13)
        active              BOOLEAN NOT NULL DEFAULT true
    );
  `);

  // Benefit invocations (e.g. a private-consultation booking) recorded when a
  // qualifying member requests an enabled Benefit (Req 18.5; resolver is 15.2).
  pgm.sql(`
    CREATE TABLE benefit_requests (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id         UUID NOT NULL REFERENCES customers(id),
        benefit_id          UUID NOT NULL REFERENCES benefits(id),
        status              TEXT NOT NULL DEFAULT 'requested', -- requested | confirmed | fulfilled | cancelled
        requested_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(
    "CREATE INDEX idx_benefit_requests_customer ON benefit_requests(customer_id, requested_at);",
  );

  // Seed the initial Benefit catalogue (Req 18.4 / A13). Future-roadmap
  // Royal_VIP perks are seeded active = false. Idempotent on the unique `key`.
  pgm.sql(`
    INSERT INTO benefits (key, name, min_qualifying_tier, config, active) VALUES
        ('private_consultation',        'Private Consultation Booking',        'royal_vip', '{"roadmap": true, "category": "private_client", "bookable": true}',  false),
        ('early_access_launches',       'Early Access to Launches',            'royal_vip', '{"roadmap": true, "category": "private_client"}',                    false),
        ('limited_edition_access',      'Limited-Edition Release Access',      'royal_vip', '{"roadmap": true, "category": "private_client"}',                    false),
        ('exclusive_samples',           'Exclusive Samples',                   'royal_vip', '{"roadmap": true, "category": "private_client"}',                    false),
        ('dedicated_service',           'Dedicated Personal Customer Service', 'royal_vip', '{"roadmap": true, "category": "private_client", "concierge": true}', false),
        ('invitation_only_experiences', 'Invitation-Only Experiences',         'royal_vip', '{"roadmap": true, "category": "private_client"}',                    false)
    ON CONFLICT (key) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse dependency order: benefit_requests references benefits.
  pgm.sql("DROP TABLE IF EXISTS benefit_requests;");
  pgm.sql("DROP TABLE IF EXISTS benefits;");
}
