/**
 * Migration: create the Profile / Preferences (behavioural) store (task 14.1).
 *
 * Creates the additive, off-ledger behavioural/preference tables EXACTLY as
 * specified in design.md "Additive Data Models":
 *   customer_favourites, customer_wishlist, customer_recently_viewed,
 *   tier_change_history, portal_visits
 * — including all columns, defaults, primary keys and the two named indexes
 * (idx_recently_viewed_retention, idx_tier_history_customer).
 *
 * ADDITIVE-ONLY / OFF-LEDGER: these tables live ALONGSIDE the immutable ledger.
 * They reference `customers(id)` (created by the ledger-core migration) but are
 * entirely separate from `ledger_entries`: behavioural/preference data is never
 * written to the ledger and never affects any customer's Balance or
 * Spendable_Balance. This migration does NOT touch, alter, or depend on the
 * ledger-core migration file.
 *
 * Requirements: 17.3 (Profile/Preferences tables kept separate from the ledger).
 *
 * SAFETY: this file is a local migration definition only. Creating it does NOT
 * execute anything against any live/production database. Application happens at
 * deploy time via `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Behavioural / preference store (Requirement 17). SEPARATE from the ledger —
  // never affects balances. `gen_random_uuid()` (used by tier_change_history)
  // and `citext` are already provided by the ledger-core migration's
  // `CREATE EXTENSION` statements; this migration runs after it.

  // Favourites: fragrances a customer has explicitly marked. One row per customer+product.
  pgm.sql(`
    CREATE TABLE customer_favourites (
        customer_id         UUID NOT NULL REFERENCES customers(id),
        shopify_product_id  BIGINT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (customer_id, shopify_product_id)   -- unique per customer+product
    );
  `);

  // Account-level wishlist (Requirement 17.4, A14). Reconciled as a UNION with the device-local
  // `shopify-wishlist` localStorage entry on authentication; authoritative thereafter.
  pgm.sql(`
    CREATE TABLE customer_wishlist (
        customer_id         UUID NOT NULL REFERENCES customers(id),
        shopify_product_id  BIGINT NOT NULL,
        added_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (customer_id, shopify_product_id)
    );
  `);

  // Recently viewed (A10: 90-day retention). HIGH WRITE VOLUME — deliberately kept OFF the ledger.
  // Ingestion is rate-limited/sampled; entries older than the retention window are excluded from the profile.
  pgm.sql(`
    CREATE TABLE customer_recently_viewed (
        customer_id         UUID NOT NULL REFERENCES customers(id),
        shopify_product_id  BIGINT NOT NULL,
        viewed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (customer_id, shopify_product_id)   -- upsert viewed_at on repeat view
    );
  `);
  pgm.sql(
    "CREATE INDEX idx_recently_viewed_retention ON customer_recently_viewed(customer_id, viewed_at);",
  );

  // Tier change history: powers the Fragrance_Journey_Timeline and Royal_VIP-growth analytics.
  pgm.sql(`
    CREATE TABLE tier_change_history (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id         UUID NOT NULL REFERENCES customers(id),
        from_tier           TEXT,
        to_tier             TEXT NOT NULL,
        reason              TEXT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(
    "CREATE INDEX idx_tier_history_customer ON tier_change_history(customer_id, created_at);",
  );

  // Portal visit tracking (Requirement 16): drives first-visit vs returning-member experience.
  pgm.sql(`
    CREATE TABLE portal_visits (
        customer_id         UUID PRIMARY KEY REFERENCES customers(id),
        first_visited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_visited_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop in reverse creation order. None of these tables are referenced by any
  // other table, so a straightforward teardown is sufficient. The `customers`
  // table (owned by the ledger-core migration) is intentionally left untouched.
  pgm.sql("DROP TABLE IF EXISTS portal_visits;");
  pgm.sql("DROP TABLE IF EXISTS tier_change_history;");
  pgm.sql("DROP TABLE IF EXISTS customer_recently_viewed;");
  pgm.sql("DROP TABLE IF EXISTS customer_wishlist;");
  pgm.sql("DROP TABLE IF EXISTS customer_favourites;");
}
