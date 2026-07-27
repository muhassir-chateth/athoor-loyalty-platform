/**
 * Migration: enforce ONE accepted referral per customer (task 40).
 *
 *   CREATE UNIQUE INDEX referrals_one_accepted_per_referred_idx
 *       ON referrals (referred_id) WHERE referred_id IS NOT NULL;
 *
 *   ALTER TABLE referrals
 *     ADD CONSTRAINT referrals_referrer_referred_uniq UNIQUE (referrer_id, referred_id);
 *
 * WHY: two payout holes were CONFIRMED live on staging under task 39, both
 * because the only dedupe was an application read-then-write on the
 * `(referrer_id, referred_id)` PAIR.
 *
 *  1. **Multi-claim fan-out.** One brand-new account claimed three *different*
 *     referral codes and every one returned `rewarded`: three `referrals` rows
 *     sharing a `referred_id`, three referrers credited +150 each, no purchase
 *     made by anyone. The pair read cannot see a *different* referrer, so it
 *     never fired. Yield is unbounded in the number of accomplices.
 *  2. **Concurrent duplicate pair.** Two parallel claims of the SAME code with
 *     different `Idempotency-Key` values both returned `rewarded`, writing two
 *     rows for the identical pair 9 ms apart and paying the referrer twice.
 *     Reproduced on the first attempt: READ COMMITTED plus a bare `BEGIN` means
 *     neither transaction sees the other's uncommitted row.
 *
 * The partial unique index closes BOTH. Fan-out is closed directly — a customer
 * can be the referred party at most once. The concurrency duplicate is closed as
 * a consequence, because two rows for one pair necessarily share a
 * `referred_id`; the second inserter blocks on the index tuple until the first
 * commits and then sees the conflict, which is the serialisation the code never
 * had.
 *
 * WHY THE PREDICATE: `referred_id` is NULLABLE (an invite recorded before the
 * friend has an account). A plain unique index would be satisfied by many NULLs
 * anyway under the default `NULLS DISTINCT`, but the predicate states the intent
 * and keeps the index out of the NULL rows entirely.
 *
 * WHY THE SECOND CONSTRAINT: `UNIQUE (referrer_id, referred_id)` is defence in
 * depth and is LARGELY SUBSUMED by the partial index for every row the code
 * writes today — any two rows for the same pair already collide on
 * `referred_id`. It earns its place only if invite rows with a NULL
 * `referred_id` are ever introduced, and at that point `NULLS NOT DISTINCT`
 * becomes a deliberate decision rather than a default. It is recorded here so a
 * future reader does not credit it with closing something it does not.
 *
 * WHY NO BACKFILL: measured immediately before writing this, staging holds 1
 * referral row, 0 duplicate pairs and 0 multi-claim customers, and there is no
 * production referral data at all because the cutover has not run. So both
 * objects can be created directly and no member loses points they had already
 * seen. `up()` therefore FAILS LOUDLY on pre-existing violations rather than
 * deleting rows to make itself pass — a duplicate row means someone was paid,
 * and choosing which payment to erase is an operator decision, never a
 * migration's. Run the detection queries in
 * `docs/ops/referral-cycle-analysis.md` first if that assumption has aged.
 *
 * LEDGER SAFETY: additive constraints on `referrals` only. No ledger entry, no
 * point lot and no balance is read or written, and no existing row is modified,
 * so no ledger correctness property can be affected. The `earn_referral` entries
 * already paid out stay exactly as they are.
 *
 * SAFETY: a local migration DEFINITION only. Creating this file executes nothing;
 * application happens via `npm run migrate:up`.
 *
 * Requirements: 2.9, 2.9a, 11.8, 11.9 (Property 12 — a referral is rewarded at
 * most once, and now: a customer accepts at most one referral).
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Name shared with the application so a conflict can be explained precisely. */
export const ONE_ACCEPTED_REFERRAL_INDEX = "referrals_one_accepted_per_referred_idx";

/** Table-level pair constraint (defence in depth; see the header note). */
export const REFERRER_REFERRED_UNIQUE = "referrals_referrer_referred_uniq";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Fail loudly rather than silently enforcing a rule the data already breaks.
  // CREATE UNIQUE INDEX would raise SQLSTATE 23505 by itself, but that error
  // names an index, not the problem; this states what an operator must decide.
  pgm.sql(`
    DO $$
    DECLARE
      offending int;
    BEGIN
      SELECT count(*) INTO offending
        FROM (
          SELECT referred_id
            FROM referrals
           WHERE referred_id IS NOT NULL
           GROUP BY referred_id
          HAVING count(*) > 1
        ) dupes;
      IF offending > 0 THEN
        RAISE EXCEPTION
          'Cannot enforce one accepted referral per customer: % customer(s) are the referred party of more than one referral. Each extra row was already PAID (earn_referral +150), so removing one is an operator decision about a real payment, not a migration''s. Resolve with an admin adjustment (Req 10.2) first, then re-run.',
          offending;
      END IF;
    END $$;
  `);

  // THE constraint that closes the fan-out. A customer is the referred party of
  // at most one referral, so at most one referrer can ever be paid for them.
  pgm.sql(`
    CREATE UNIQUE INDEX ${ONE_ACCEPTED_REFERRAL_INDEX}
        ON referrals (referred_id)
     WHERE referred_id IS NOT NULL;
  `);

  // Defence in depth on the pair. Redundant today (see header), cheap, and the
  // thing that keeps holding if NULL `referred_id` invite rows ever appear.
  pgm.sql(`
    ALTER TABLE referrals
      ADD CONSTRAINT ${REFERRER_REFERRED_UNIQUE} UNIQUE (referrer_id, referred_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverting REOPENS both confirmed payout holes. It exists for migration
  // hygiene, not as an operational option.
  pgm.sql(`ALTER TABLE referrals DROP CONSTRAINT IF EXISTS ${REFERRER_REFERRED_UNIQUE};`);
  pgm.sql(`DROP INDEX IF EXISTS ${ONE_ACCEPTED_REFERRAL_INDEX};`);
}
