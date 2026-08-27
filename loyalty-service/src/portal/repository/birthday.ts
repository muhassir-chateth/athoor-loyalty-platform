/**
 * The birthday repository (spec task 12.1, design §11.4/§11.6, Req 11.3–11.8).
 *
 * Every function takes a {@link CustomerScope}. There is no overload and no `string`
 * fallback, so a handler cannot pass a customer id it read from a request.
 *
 * ── THE 365-DAY LOCK IS ONE STATEMENT, NOT READ-THEN-WRITE ──────────────────
 * §11.4 is explicit and the reason is a race: reading `changed_at`, deciding, then
 * writing lets two concurrent requests both read an unlocked row and both write. A
 * single conditional `UPDATE` cannot do that — Postgres serialises the row, the second
 * statement's predicate no longer holds, and it reports zero rows affected. Zero rows
 * IS the lock, and it maps to `409 birthday_change_locked`.
 *
 * ── WHY `coalesce(...)` AND NOT THE DESIGN'S LITERAL `OR` ───────────────────
 * §11.4 writes the predicate as `changed_at IS NULL OR changed_at <= now() -
 * interval '365 days'`. `validateScopedStatement` REFUSES a disjunction in a WHERE
 * clause (`disjunction_in_where`) — deliberately, because an `OR` is how an ownership
 * predicate gets widened into uselessness (`customer_id = $1 OR true`).
 *
 * So the predicate is written `coalesce(changed_at, 'epoch'::timestamptz) <= now() -
 * interval '365 days'`, which is SEMANTICALLY IDENTICAL: a NULL `changed_at` becomes
 * 1970, which is always more than 365 days ago, so a never-changed birthday is
 * changeable — exactly what the `IS NULL` branch expresses. One statement, one
 * predicate, no disjunction, and the portal's guard is honoured rather than widened
 * to admit the design's convenience form.
 *
 * ── THE ONCE-PER-YEAR GUARANTEE IS A CONSTRAINT, NOT A CHECK ────────────────
 * `birthday_grants UNIQUE (customer_id, grant_year)` is the guarantee (§11.6, Req
 * 11.6). The grant is an `INSERT … ON CONFLICT DO NOTHING`, so N concurrent attempts
 * produce ONE row and N−1 no-ops. Nothing here reads-then-decides, and there is no
 * application lock behind it — which is exactly why task 6.5's migrate-down guard
 * refuses to drop this table while it holds rows.
 *
 * `grant_year` is the EUROPE/LONDON calendar year, bound as a parameter, and is keyed
 * on the year rather than on the birthday value. That is what stops a changed
 * birthday retroactively granting in a year already granted (Req 11.7).
 *
 * SAFETY: no DDL, no migration. Writes only `customer_birthdays` and
 * `birthday_grants` — never the ledger, so no path through this file can move a
 * balance (Req 23.6, §9.5).
 */
import type { CustomerScope } from "../../auth/customerScope.js";
import type { Queryable } from "../../ledger/repository.js";
import { scopedMutate, scopedSelect } from "./scopedQuery.js";
import type { BirthdayValue } from "../../profile/birthday.js";

/** The stored row, as the read projects it. */
export interface StoredBirthday {
  readonly birthday: BirthdayValue;
  /** `null` means never changed — the row is changeable immediately. */
  readonly changedAt: Date | null;
}

/** Reads the caller's stored birthday, or `null` when none is set. */
export async function readBirthday(
  executor: Queryable,
  scope: CustomerScope,
): Promise<StoredBirthday | null> {
  const rows = await scopedSelect<{
    birth_month: number;
    birth_day: number;
    changed_at: Date | string | null;
  }>(executor, scope, {
    sql: `SELECT birth_month, birth_day, changed_at
            FROM customer_birthdays
           WHERE customer_id = $1`,
  });
  const row = rows[0];
  if (!row) return null;
  const changedAt =
    row.changed_at === null
      ? null
      : row.changed_at instanceof Date
        ? row.changed_at
        : new Date(row.changed_at);
  return {
    birthday: { month: Number(row.birth_month), day: Number(row.birth_day) },
    changedAt: changedAt !== null && Number.isNaN(changedAt.getTime()) ? null : changedAt,
  };
}

/**
 * Creates the caller's birthday if they have none.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert, and separate from the change path,
 * because the two are different operations with different rules: a first-time set is
 * always permitted, whereas a change is gated by 365 days. An upsert would let a
 * change slip through the creation path and bypass the lock entirely.
 *
 * @returns true iff a row was created.
 */
export async function createBirthdayIfAbsent(
  executor: Queryable,
  scope: CustomerScope,
  birthday: BirthdayValue,
): Promise<boolean> {
  const affected = await scopedMutate(executor, scope, {
    sql: `INSERT INTO customer_birthdays (customer_id, birth_month, birth_day)
               VALUES ($1, $2, $3)
          ON CONFLICT (customer_id) DO NOTHING`,
    params: [birthday.month, birthday.day],
  });
  return affected > 0;
}

/**
 * Changes the caller's birthday IF the 365-day lock has expired.
 *
 * ONE STATEMENT. See the module header: zero rows affected means the lock held, and
 * two concurrent callers cannot both succeed because the predicate is evaluated
 * against the serialised row rather than against a value read earlier.
 *
 * @returns true iff the change was applied.
 */
export async function changeBirthdayIfUnlocked(
  executor: Queryable,
  scope: CustomerScope,
  birthday: BirthdayValue,
  lockDays: number,
): Promise<boolean> {
  const affected = await scopedMutate(executor, scope, {
    sql: `UPDATE customer_birthdays
             SET birth_month = $2,
                 birth_day   = $3,
                 changed_at  = now()
           WHERE customer_id = $1
             AND coalesce(changed_at, 'epoch'::timestamptz) <= now() - ($4 || ' days')::interval`,
    params: [birthday.month, birthday.day, String(lockDays)],
  });
  return affected > 0;
}

/** True iff the caller already has a grant for `grantYear` (Europe/London year). */
export async function hasGrantForYear(
  executor: Queryable,
  scope: CustomerScope,
  grantYear: number,
): Promise<boolean> {
  const rows = await scopedSelect<{ one: number }>(executor, scope, {
    sql: `SELECT 1 AS one
            FROM birthday_grants
           WHERE customer_id = $1
             AND grant_year = $2`,
    params: [grantYear],
  });
  return rows.length > 0;
}

/**
 * Claims the caller's grant for `grantYear`.
 *
 * THE UNIQUE CONSTRAINT IS THE DECISION. `ON CONFLICT DO NOTHING` means N concurrent
 * attempts produce exactly one row, and the loser learns it lost by being told zero
 * rows were affected — not by reading first and hoping nothing changed in between.
 *
 * @returns true iff THIS call created the grant. Only a `true` may lead to an award.
 */
export async function claimGrantForYear(
  executor: Queryable,
  scope: CustomerScope,
  grantYear: number,
): Promise<boolean> {
  const affected = await scopedMutate(executor, scope, {
    sql: `INSERT INTO birthday_grants (customer_id, grant_year)
               VALUES ($1, $2)
          ON CONFLICT (customer_id, grant_year) DO NOTHING`,
    params: [grantYear],
  });
  return affected > 0;
}
