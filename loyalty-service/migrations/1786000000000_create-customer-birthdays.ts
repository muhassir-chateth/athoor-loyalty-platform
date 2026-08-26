/**
 * Migration: create the birthday store and its once-per-year grant guard
 * (task 6.1) — Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6.
 *
 * Creates two tables EXACTLY as specified in design.md §14.2 (Tables 1 and 2):
 *   customer_birthdays   — one row per customer: month + day, and NO YEAR
 *   birthday_grants      — one row per customer per Europe/London year
 *
 * NO BIRTH YEAR, DELIBERATELY (Req 11.2, §11.1). A `DATE` column would force an
 * invented year — typically 1900 or 2000 — and an invented year is a lie a later
 * reader will treat as data: a query computing age from it returns a plausible,
 * wrong number. Two SMALLINTs cannot be misread that way, so age data is never
 * collected and cannot be inferred.
 *
 * THE TABLE-LEVEL CHECK is the third validation layer of §11.3, after `zod` and
 * the application calendar check. It exists so a future code path that forgets
 * the calendar check still cannot store 30 February. It rejects 30 and 31
 * February and 31 April/June/September/November, and PERMITS 29 FEBRUARY (§11.5:
 * refusing it would tell roughly one person in 1,461 that their birthday is
 * invalid; eligibility opens on 28 February in a non-leap year, which is a read
 * -time decision and not a storage one).
 *
 * `birthday_grants` HOLDS NO BIRTHDAY VALUE, deliberately (§11.11) — so the
 * once-per-365-days abuse guard survives erasure. Erasure DELETEs the
 * `customer_birthdays` row and RETAINS the grant row, which carries no personal
 * data (§14.5, §15.5). Its `PRIMARY KEY (customer_id, grant_year)` IS the
 * Requirement 11.6 guarantee — referred to elsewhere in the design as
 * `UNIQUE (customer_id, grant_year)`, which is the same guarantee and the same
 * single index: N concurrent grant attempts produce one row and N−1 constraint
 * violations mapped to "already granted". It is a database constraint, not
 * application logic.
 *
 * NOT STORED ON `customers` (§14.3). `customers` is a ledger-core table written
 * on the earning path; putting personal data on it would widen the blast radius
 * of every query that selects from it and turn erasure into an `UPDATE` on a
 * table the engine writes concurrently. Separate tables make erasure a `DELETE`
 * on tables nothing else reads.
 *
 * ADDITIVE / OFF-LEDGER: `CREATE TABLE` only. No existing table is altered. The
 * only reference to existing schema is the `customers(id)` foreign key. Nothing
 * here touches `ledger_entries`, `point_lots`, `redemptions`, `discount_codes`
 * or `referrals`, so no balance and no ledger correctness property can be
 * affected. `gen_random_uuid()` and `citext` are already provided by the
 * ledger-core migration's `CREATE EXTENSION`; no extension is added.
 *
 * ROLLBACK IS DESTRUCTIVE (§14.6). `down` drops customer-entered data that
 * cannot be re-derived, and dropping `birthday_grants` would lose the record of
 * grants already made — permitting a second grant in the same year after a
 * re-apply. Rolling back the FEATURE is a feature-flag flip, never a migration;
 * `migrate:down` is permitted only once `SELECT count(*)` on both tables returns
 * zero (the precondition of task 6.5).
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it executes
 * NOTHING against any live/production database. Application is a separate,
 * deploy-time action: `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // The birthday itself. PK on `customer_id`: one birthday per customer, and
  // every access path is `WHERE customer_id = $1`, which the PK already serves —
  // so no further index is added (§14.4).
  //
  // `changed_at` is NULLABLE and NULL means never changed. It drives the
  // one-change-per-365-days lock (§11.4), which is a single conditional UPDATE
  // rather than a read-then-write, so two concurrent changes cannot both win.
  //
  // The named table-level CHECK rejects impossible (month, day) pairs. The three
  // branches are exhaustive over months 1–12, so exactly one applies:
  //   February            → day <= 29  (29 Feb PERMITTED; 30 and 31 Feb rejected)
  //   Apr/Jun/Sep/Nov     → day <= 30  (31st rejected)
  //   31-day months       → the column CHECK's 1–31 range is already correct
  pgm.sql(`
    CREATE TABLE customer_birthdays (
        customer_id     UUID PRIMARY KEY REFERENCES customers(id),
        birth_month     SMALLINT NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
        birth_day       SMALLINT NOT NULL CHECK (birth_day BETWEEN 1 AND 31),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        changed_at      TIMESTAMPTZ,                      -- NULL = never changed
        CONSTRAINT customer_birthdays_valid_day_for_month CHECK (
            (birth_month = 2 AND birth_day <= 29)                 -- 29 Feb allowed
            OR (birth_month IN (4, 6, 9, 11) AND birth_day <= 30) -- no 31st
            OR (birth_month IN (1, 3, 5, 7, 8, 10, 12))           -- 31-day months
        )
    );
  `);

  // The once-per-365-days guarantee. `grant_year` is the Europe/London calendar
  // year at grant time (§11.8), keyed on the calendar rather than on the birthday
  // value so that changing a birthday cannot retroactively unlock a year already
  // granted (Req 11.7). No birthday value is stored here — see the header.
  pgm.sql(`
    CREATE TABLE birthday_grants (
        customer_id     UUID NOT NULL REFERENCES customers(id),
        grant_year      SMALLINT NOT NULL,                -- Europe/London calendar year
        granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (customer_id, grant_year)             -- the guarantee itself
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse creation order. Neither table is referenced by any other table, so
  // dropping them is sufficient; each table's PK index goes with it. The shared
  // `customers` table (owned by the ledger-core migration) is left untouched.
  pgm.sql("DROP TABLE IF EXISTS birthday_grants;");
  pgm.sql("DROP TABLE IF EXISTS customer_birthdays;");
}
