/**
 * Migration: create the declared fragrance-preference store (task 6.2) —
 * Requirements 12.1, 12.2.
 *
 * Creates one table EXACTLY as specified in design.md §14.2 (Table 3):
 *   customer_fragrance_preferences  — one row per (customer, dimension, value)
 * plus the partial unique index `idx_fragrance_pref_single_intensity`.
 *
 * SET SEMANTICS. `PRIMARY KEY (customer_id, dimension, value)` makes the store a
 * set rather than a list, so a repeated write is naturally idempotent via
 * `ON CONFLICT DO NOTHING` instead of needing a de-duplicating read first. Its
 * leading column is `customer_id`, so a per-customer read is an index scan and no
 * further index is required (§14.4).
 *
 * THE `dimension` SET IS CLOSED; THE `value` SET IS NOT. This is a deliberate
 * trade-off (§14.2). Constraining `value` would mean a migration every time a
 * scent note is added to the catalogue, so the vocabulary is enforced by `zod`
 * against the server-owned list at write time. The database therefore permits a
 * value the application would never write — acceptable because the application is
 * the only writer, and an unrecognised value renders through the neutral fallback
 * of §18.9 rather than breaking. The 1–64 character check is the guard that
 * remains at the database: it stops an empty string and a runaway blob, which are
 * the two failures no vocabulary list would catch.
 *
 * `idx_fragrance_pref_single_intensity` MAKES INTENSITY SINGLE-VALUED AT THE
 * DATABASE. `intensity` is a scalar preference ("preferred strength", Req 12.1)
 * while the other four dimensions are genuinely multi-valued. A partial UNIQUE
 * index on `(customer_id) WHERE dimension = 'intensity'` permits at most one
 * intensity row per customer while leaving the other dimensions unconstrained —
 * so single-valuedness is a constraint rather than a rule the application has to
 * remember. Note it is a cardinality of one, not a cap of one: `intensity` has no
 * entry in the §12.8 `limits` block for exactly this reason.
 *
 * REJECTED ALTERNATIVE — one row per customer with JSONB arrays (§14.2). One round
 * trip instead of N rows, but it loses `ON CONFLICT DO NOTHING` idempotence,
 * needs array-length checks in application code, and would make this the one
 * preference store shaped differently from `customer_wishlist` and
 * `customer_favourites`.
 *
 * ADDITIVE / OFF-LEDGER: `CREATE TABLE` and `CREATE UNIQUE INDEX` only. No
 * existing table is altered. The only reference to existing schema is the
 * `customers(id)` foreign key. Nothing here touches `ledger_entries`,
 * `point_lots`, `redemptions`, `discount_codes` or `referrals`, so no balance can
 * be affected. Personalisation computed from these rows is deterministic and
 * local — no customer data leaves the service (Req 12.4, 12.5).
 *
 * ROLLBACK IS DESTRUCTIVE (§14.6): these are values the customer typed and that
 * cannot be re-derived. Rolling back the FEATURE is a feature-flag flip, never a
 * migration; `migrate:down` is permitted only once `SELECT count(*)` returns zero
 * (the precondition of task 6.5).
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it executes
 * NOTHING against any live/production database. Application is a separate,
 * deploy-time action: `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Declared taste — the editable half of the Fragrance Profile (§12.1). Derived
  // interests are recomputed per request and stored NOWHERE (§14.2), so this
  // table holds only what the customer typed.
  pgm.sql(`
    CREATE TABLE customer_fragrance_preferences (
        customer_id     UUID NOT NULL REFERENCES customers(id),
        dimension       TEXT NOT NULL CHECK (dimension IN ('scent_family', 'note', 'intensity', 'occasion', 'season')),
        value           TEXT NOT NULL CHECK (char_length(value) BETWEEN 1 AND 64),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (customer_id, dimension, value)       -- set semantics, natural dedupe
    );
  `);

  // At most one intensity per customer. Partial, so the other four dimensions
  // stay multi-valued.
  pgm.sql(`
    CREATE UNIQUE INDEX idx_fragrance_pref_single_intensity
        ON customer_fragrance_preferences(customer_id)
        WHERE dimension = 'intensity';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // The table is referenced by nothing, and its PK and the partial unique index
  // are dropped with it, so one statement is the whole teardown. The shared
  // `customers` table (owned by the ledger-core migration) is left untouched.
  pgm.sql("DROP TABLE IF EXISTS customer_fragrance_preferences;");
}
