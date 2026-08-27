/**
 * Migration: create the communication / notification preference store
 * (task 6.3) — Requirements 13.1, 13.2, 3.2.
 *
 * Creates one table EXACTLY as specified in design.md §14.2 (Table 4):
 *   customer_communication_preferences  — one row per customer, five booleans
 *
 * NO `marketing_consent` COLUMN, DELIBERATELY. Marketing consent is Shopify's
 * (Req 13.4, §13.8, and the source-of-truth table of §13.1) and is read and
 * written through the N9 settings path. A second copy here would create precisely
 * the dual source of truth Requirement 3.2 refuses — and the failure mode is not
 * a cosmetic mismatch: a customer who withdrew consent in one place and still
 * received mail is a compliance failure. One field, one home.
 *
 * EXPLICIT BOOLEAN COLUMNS, NOT JSONB (§14.2). Five named preferences that each
 * need a documented meaning, a default, and a purpose statement at the point of
 * collection (Req 23.8). A JSONB blob would let an undocumented key appear
 * without review, and there would be no schema to review it against.
 *
 * THE DEFAULTS ARE THE POLICY: opt-OUT for the two promotional channels, opt-IN
 * for the two the customer has already asked for by using the feature.
 *   product_launches  false  — promotional; not asked for
 *   restock_alerts    false  — promotional; not asked for
 *   birthday_messages true   — the customer entered a birthday to be recognised
 *   referral_updates  true   — the customer shared a referral code to hear back
 *   push_enabled      false  — reserved for the future app; nothing can send yet
 * Transactional order messages are not represented at all, because they are not
 * optional and a column implying otherwise would be a lie.
 *
 * `push_enabled` IS A RESERVED COLUMN. It pairs with the existing, web-unused
 * `device_tokens` table (§14.2) and appears in NO wire contract in §6.3 or §12.8
 * — `PortalCommunicationPreferences` in `src/portal/types.ts` deliberately omits
 * it. It exists here so the app does not need a migration on its first day;
 * exposing it is additive when there is something to expose (Req 20.6).
 *
 * `updated_at` carries the last change, which is what Requirement 13.2's
 * "present the stored state on the next read" is verified against. Marketing
 * consent's own last-changed date (Req 13.3) is Shopify's and is read from
 * Shopify, not from this column.
 *
 * ADDITIVE / OFF-LEDGER: `CREATE TABLE` only. No existing table is altered. The
 * only reference to existing schema is the `customers(id)` foreign key. Nothing
 * here touches `ledger_entries`, `point_lots`, `redemptions`, `discount_codes` or
 * `referrals`, so no balance can be affected.
 *
 * ROLLBACK IS DESTRUCTIVE (§14.6): these are choices the customer made and that
 * cannot be re-derived — and a lost opt-out is the worst kind of loss here.
 * Rolling back the FEATURE is a feature-flag flip, never a migration;
 * `migrate:down` is permitted only once `SELECT count(*)` returns zero (the
 * precondition of task 6.5).
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it executes
 * NOTHING against any live/production database. Application is a separate,
 * deploy-time action: `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // One row per customer. PK on `customer_id`: every access path is
  // `WHERE customer_id = $1`, which the PK serves, so no further index is added
  // (§14.4). A missing row means "defaults apply" — the row is created on first
  // write, so a customer who never opens Settings is never written to.
  pgm.sql(`
    CREATE TABLE customer_communication_preferences (
        customer_id         UUID PRIMARY KEY REFERENCES customers(id),
        product_launches    BOOLEAN NOT NULL DEFAULT false,   -- promotional: opt-out
        restock_alerts      BOOLEAN NOT NULL DEFAULT false,   -- promotional: opt-out
        birthday_messages   BOOLEAN NOT NULL DEFAULT true,    -- asked for by setting a birthday
        referral_updates    BOOLEAN NOT NULL DEFAULT true,    -- asked for by referring
        push_enabled        BOOLEAN NOT NULL DEFAULT false,   -- reserved for the future app
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // The table is referenced by nothing and its PK index goes with it, so one
  // statement is the whole teardown. The shared `customers` table (owned by the
  // ledger-core migration) is left untouched.
  pgm.sql("DROP TABLE IF EXISTS customer_communication_preferences;");
}
