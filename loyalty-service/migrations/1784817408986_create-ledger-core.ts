/**
 * Migration: create the immutable ledger core schema (task 1.2).
 *
 * Creates the seven core tables of the Athoor loyalty ledger EXACTLY as
 * specified in design.md "Data Models":
 *   customers, ledger_entries, point_lots, redemptions, discount_codes,
 *   webhook_events, referrals
 * — including all columns, defaults, indexes (idx_ledger_customer,
 * idx_lots_fifo, idx_lots_expiry) and CHECK / UNIQUE constraints.
 *
 * The ledger is append-only: rows in `ledger_entries` are never UPDATEd or
 * DELETEd by the application (enforced in the repository layer, task 2.1).
 *
 * NOTE on the circular foreign key: the design defines
 *   redemptions.discount_code_id -> discount_codes(id)   and
 *   discount_codes.redemption_id -> redemptions(id).
 * A single ordered DDL script cannot declare both inline, so we create the
 * `discount_code_id` column first and add its foreign key with ALTER TABLE
 * once `discount_codes` exists. The resulting end-state schema is identical
 * to the design.
 *
 * Requirements: 1.1 (ledger as the single, append-only source of truth).
 *
 * SAFETY: this file is a local migration definition only. It is NOT executed
 * against any live/production database by creating it; application happens at
 * deploy time via `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Extensions required by the schema:
  //  - citext:   case-insensitive email columns (customers.email, referrals.referred_email)
  //  - pgcrypto: gen_random_uuid() default for UUID primary keys
  //    (gen_random_uuid is core from PG13+, but pgcrypto guarantees availability).
  pgm.sql("CREATE EXTENSION IF NOT EXISTS citext;");
  pgm.sql("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

  // Customers: mirror of Shopify identity, keyed by Shopify customer id.
  pgm.sql(`
    CREATE TABLE customers (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shopify_customer_id BIGINT UNIQUE NOT NULL,     -- numeric Shopify id
        email               CITEXT,
        tier                TEXT NOT NULL DEFAULT 'bronze',   -- derived, cached for reads
        lifetime_points     BIGINT NOT NULL DEFAULT 0,        -- derived, cached for reads
        lifetime_spend_gbp  NUMERIC(12,2) NOT NULL DEFAULT 0, -- drives tier
        referral_code       TEXT UNIQUE,
        referred_by         UUID REFERENCES customers(id),    -- self-referral guard
        enrolled_at         TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // The immutable ledger: the single source of truth. Never UPDATE/DELETE rows.
  pgm.sql(`
    CREATE TABLE ledger_entries (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id         UUID NOT NULL REFERENCES customers(id),
        entry_type          TEXT NOT NULL,   -- earn_signup | earn_order | earn_first_purchase
                                             -- | earn_referral | spend | clawback | expire | adjust | migration
        points              BIGINT NOT NULL, -- positive for credit, negative for debit
        reason              TEXT NOT NULL,
        order_reference     BIGINT,          -- Shopify order id when applicable
        point_lot_id        UUID,            -- links spend/expire back to the lot consumed
        redemption_id       UUID,            -- links spend to a redemption
        source_event_id     TEXT,            -- Shopify webhook id for traceability
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql("CREATE INDEX idx_ledger_customer ON ledger_entries(customer_id, created_at);");

  // Point lots: each earning creates a lot with an expiry date for FIFO consumption.
  pgm.sql(`
    CREATE TABLE point_lots (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id         UUID NOT NULL REFERENCES customers(id),
        ledger_entry_id     UUID NOT NULL REFERENCES ledger_entries(id),
        original_points     BIGINT NOT NULL CHECK (original_points > 0),
        remaining_points    BIGINT NOT NULL CHECK (remaining_points >= 0),
        earned_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at          TIMESTAMPTZ,     -- NULL = never expires
        CHECK (remaining_points <= original_points)
    );
  `);
  pgm.sql(`
    CREATE INDEX idx_lots_fifo ON point_lots(customer_id, earned_at)
        WHERE remaining_points > 0;
  `);
  pgm.sql(`
    CREATE INDEX idx_lots_expiry ON point_lots(expires_at)
        WHERE remaining_points > 0;
  `);

  // Redemptions: a spend that produces a Shopify discount code.
  // discount_code_id's FK to discount_codes is added after that table exists
  // (see ALTER TABLE below) to resolve the circular reference.
  pgm.sql(`
    CREATE TABLE redemptions (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id         UUID NOT NULL REFERENCES customers(id),
        reward_id           TEXT NOT NULL,          -- e.g. reward_5, reward_15
        points_spent        BIGINT NOT NULL CHECK (points_spent > 0),
        value_gbp           NUMERIC(8,2) NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending_code', -- pending_code | issued | failed | voided
        idempotency_key     TEXT NOT NULL,
        discount_code_id    UUID,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (customer_id, idempotency_key)        -- double-submit protection
    );
  `);

  // Discount codes minted in Shopify, one per redemption, single-use, customer-bound.
  pgm.sql(`
    CREATE TABLE discount_codes (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        redemption_id         UUID NOT NULL REFERENCES redemptions(id),
        code                  TEXT UNIQUE NOT NULL,
        shopify_price_rule_id BIGINT,
        shopify_discount_id   BIGINT,
        amount_off_gbp        NUMERIC(8,2) NOT NULL,
        status                TEXT NOT NULL DEFAULT 'active', -- active | used | expired | revoked
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Complete the circular reference now that discount_codes exists.
  pgm.sql(`
    ALTER TABLE redemptions
        ADD CONSTRAINT redemptions_discount_code_id_fkey
        FOREIGN KEY (discount_code_id) REFERENCES discount_codes(id);
  `);

  // Webhook dedupe / audit: every inbound event recorded once.
  pgm.sql(`
    CREATE TABLE webhook_events (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shopify_webhook_id  TEXT UNIQUE NOT NULL,    -- X-Shopify-Webhook-Id: idempotency anchor
        topic               TEXT NOT NULL,
        payload_hash        TEXT NOT NULL,
        received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at        TIMESTAMPTZ,
        status              TEXT NOT NULL DEFAULT 'received' -- received | processed | failed
    );
  `);

  // Referrals: track invite -> signup -> first purchase for staged rewards + fraud guard.
  pgm.sql(`
    CREATE TABLE referrals (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id         UUID NOT NULL REFERENCES customers(id),
        referred_id         UUID REFERENCES customers(id),
        referred_email      CITEXT,
        signup_rewarded     BOOLEAN NOT NULL DEFAULT false,
        purchase_rewarded   BOOLEAN NOT NULL DEFAULT false,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (referrer_id <> referred_id)           -- no self-referral
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop in reverse dependency order. Remove the circular FK first so the two
  // mutually-referencing tables can be dropped cleanly.
  pgm.sql("ALTER TABLE IF EXISTS redemptions DROP CONSTRAINT IF EXISTS redemptions_discount_code_id_fkey;");
  pgm.sql("DROP TABLE IF EXISTS referrals;");
  pgm.sql("DROP TABLE IF EXISTS webhook_events;");
  pgm.sql("DROP TABLE IF EXISTS discount_codes;");
  pgm.sql("DROP TABLE IF EXISTS redemptions;");
  pgm.sql("DROP TABLE IF EXISTS point_lots;");
  pgm.sql("DROP TABLE IF EXISTS ledger_entries;");
  pgm.sql("DROP TABLE IF EXISTS customers;");
  // Extensions are intentionally left installed; they are cluster-wide and may
  // be relied on by other schemas.
}
