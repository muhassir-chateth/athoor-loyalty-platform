/**
 * Migration: rename the one-accepted-referral index to the approved name
 * (task 40 follow-up).
 *
 *   ALTER INDEX referrals_one_accepted_per_referred_idx
 *     RENAME TO referrals_one_referrer_per_referred;
 *
 * WHY A SECOND MIGRATION: `1785700000000_referrals-one-accepted-per-customer`
 * created the index as `referrals_one_accepted_per_referred_idx` and has ALREADY
 * BEEN APPLIED to staging. The approved specification names it
 * `referrals_one_referrer_per_referred`. Editing the applied migration in place
 * would leave staging on the old name while a freshly-migrated database got the
 * new one — the two would silently disagree, and `pgmigrations` would show no
 * trace of the change. Renaming forward keeps every environment identical and
 * the history honest.
 *
 * NAME ONLY. The index definition is untouched: same table, same column, same
 * `WHERE referred_id IS NOT NULL` predicate, same uniqueness. `ALTER INDEX …
 * RENAME` does not rebuild the index and does not revalidate data, so the
 * constraint is never off — there is no window in which a duplicate could slip
 * through. `UNIQUE (referrer_id, referred_id)` is unaffected.
 *
 * The rename is guarded both ways so the migration is safe on a database created
 * before the original migration existed, on one already carrying the new name,
 * and on a fresh database where the original migration runs first.
 *
 * LEDGER SAFETY: renames one index on `referrals`. No row is read or written, no
 * ledger entry, lot or balance is involved.
 *
 * Requirements: 2.9, 2.9a, 11.8, 11.9.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/** The approved name. */
export const ONE_REFERRER_PER_REFERRED_INDEX = "referrals_one_referrer_per_referred";

/** The name the original migration created. */
const LEGACY_INDEX_NAME = "referrals_one_accepted_per_referred_idx";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname = '${LEGACY_INDEX_NAME}') THEN
        ALTER INDEX ${LEGACY_INDEX_NAME} RENAME TO ${ONE_REFERRER_PER_REFERRED_INDEX};
      ELSIF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = '${ONE_REFERRER_PER_REFERRED_INDEX}'
      ) THEN
        -- Neither name exists: the uniqueness rule is NOT in force, which is the
        -- one state this must not pass over quietly.
        RAISE EXCEPTION
          'Neither % nor % exists on referrals, so one-accepted-referral-per-customer is not enforced. Apply 1785700000000_referrals-one-accepted-per-customer first.',
          '${LEGACY_INDEX_NAME}', '${ONE_REFERRER_PER_REFERRED_INDEX}';
      END IF;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname = '${ONE_REFERRER_PER_REFERRED_INDEX}') THEN
        ALTER INDEX ${ONE_REFERRER_PER_REFERRED_INDEX} RENAME TO ${LEGACY_INDEX_NAME};
      END IF;
    END $$;
  `);
}
