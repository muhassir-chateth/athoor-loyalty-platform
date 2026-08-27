/**
 * The declared-preference repository (spec task 13.1, design §12.2/§12.8,
 * Req 12.1, 12.2, 13.1, 13.2).
 *
 * Every function takes a {@link CustomerScope}. There is no overload and no
 * `string` fallback, so a handler cannot pass a customer id it read from a
 * request.
 *
 * ── A WRITE IS A SET-REPLACEMENT PER DIMENSION, INSIDE ONE TRANSACTION ──────
 * §12.8 is explicit, and the reason is a half-applied save: replacing a dimension
 * is a delete plus one insert per value, and a failure between them would leave
 * the customer with neither their old set nor their new one. One transaction makes
 * the dimension move atomically.
 *
 * ── DELETE STRICTLY BEFORE INSERT, AND NOT ONLY FOR TIDINESS ────────────────
 * `intensity` carries a PARTIAL UNIQUE INDEX on `(customer_id) WHERE dimension =
 * 'intensity'`, so a customer changing `subtle` to `bold` has two rows in flight.
 * Postgres checks a unique index per statement, not at commit, so inserting first
 * raises a unique violation even inside a transaction. Deleting first cannot.
 * `preferences.repository.test.ts` asserts the order, because reversing it would
 * pass every test that only ever sets an intensity for the first time.
 *
 * ── WHY THE DELETE SPARES THE ROWS THAT SURVIVE ─────────────────────────────
 * `value <> ALL($3)` deletes only the values leaving the set, rather than clearing
 * the dimension and rewriting it. Two reasons. `created_at` on a value the
 * customer keeps is preserved, so "when did I first say this" stays true. And a
 * save that changes nothing writes nothing at all — the repeated-write case is
 * genuinely idempotent in the database rather than merely idempotent in the
 * response.
 *
 * When the new set is empty, `<> ALL('{}')` is true for every row, so the
 * dimension clears. That is the same statement, not a special case.
 *
 * ── NO SECOND SOURCE OF DEFAULTS ────────────────────────────────────────────
 * The communication write creates the row with `INSERT (customer_id) VALUES ($1)`
 * and lets the TABLE's own `DEFAULT`s populate it, then updates only the columns
 * the caller supplied. So the column defaults are stated once, in the migration,
 * and this file cannot drift from them.
 *
 * SAFETY: no DDL, no migration. Writes only `customer_fragrance_preferences` and
 * `customer_communication_preferences` — never the ledger, so no path through this
 * file can move a balance.
 */
import type { CustomerScope } from "../../auth/customerScope.js";
import type { Queryable } from "../../ledger/repository.js";
import { scopedMutate, scopedSelect } from "./scopedQuery.js";
import type {
  CommunicationKey,
  StoredCommunicationRow,
  StoredPreferenceRow,
} from "../../profile/preferences.js";
import type { PortalPreferenceDimension } from "../types.js";

/**
 * The parameter order of {@link updateCommunicationPreferences}'s statement.
 *
 * ── WHY THIS IS LOCAL AND NOT IMPORTED FROM THE DOMAIN ──────────────────────
 * The domain has a list of the same four keys, and importing it would be the
 * obvious move. It is the wrong one twice over.
 *
 * Structurally: a VALUE import from this directory into `profile/**` declares an
 * SQL delegation, and `ownership.gate.test.ts` then requires the target to appear
 * in `DELEGATION_TARGETS` so its statements are verified rather than trusted.
 * `profile/preferences.ts` holds no SQL at all, so listing it would fail that
 * list's own staleness check — the gate is drawing a real distinction, not being
 * awkward.
 *
 * And on the merits: what has to agree here is the parameter order and the column
 * order of the `UPDATE` a few lines below. Those two live in this file, so the
 * thing they must match lives here too. The domain's list answers a different
 * question — which wire keys are accepted — and `preferences.test.ts` asserts the
 * two cover exactly the same keys, so adding a fifth cannot land in one only.
 */
const COMMUNICATION_PARAM_ORDER: readonly CommunicationKey[] = [
  "productLaunches", // $2 → product_launches
  "restockAlerts", // $3 → restock_alerts
  "birthdayMessages", // $4 → birthday_messages
  "referralUpdates", // $5 → referral_updates
];

/** Exported so the domain test can prove the two key lists have not diverged. */
export const COMMUNICATION_PARAM_KEYS = COMMUNICATION_PARAM_ORDER;

/** Reads every declared `(dimension, value)` pair the caller owns. */
export async function readDeclaredPreferences(
  executor: Queryable,
  scope: CustomerScope,
): Promise<readonly StoredPreferenceRow[]> {
  // No ORDER BY: the projection sorts by the server-owned vocabulary, which is a
  // stronger guarantee than any column order could give and does not depend on the
  // planner. See `projectDeclared`.
  const rows = await scopedSelect<{ dimension: string; value: string }>(executor, scope, {
    sql: `SELECT dimension, value
            FROM customer_fragrance_preferences
           WHERE customer_id = $1`,
  });
  return rows;
}

/** Reads the caller's communication row, or `null` when they have never written one. */
export async function readCommunicationPreferences(
  executor: Queryable,
  scope: CustomerScope,
): Promise<StoredCommunicationRow | null> {
  const rows = await scopedSelect<StoredCommunicationRow>(executor, scope, {
    sql: `SELECT product_launches, restock_alerts, birthday_messages, referral_updates
            FROM customer_communication_preferences
           WHERE customer_id = $1`,
  });
  // Absent is the NORMAL state, not a 404: a customer who has never opened
  // Settings has no row, and defaults apply (§14.2). `scopedSelectOne` would map
  // that to a 404 and turn "you have not changed these" into "you do not exist".
  return rows[0] ?? null;
}

/**
 * Replaces one dimension's set with `values`, atomically with respect to the
 * caller's other dimensions when `executor` is a transaction client.
 *
 * MUST be called with a transaction client for the guarantees in the module
 * header to hold. It does not open one itself: `Queryable` is `Pool | PoolClient`,
 * so this layer cannot assume it holds a client it may `BEGIN` on — the same
 * constraint `setWishlistItem` documents.
 *
 * @returns the number of rows deleted and inserted, for tests and for deciding
 *   whether anything actually changed.
 */
export async function replaceDeclaredDimension(
  executor: Queryable,
  scope: CustomerScope,
  dimension: PortalPreferenceDimension,
  values: readonly string[],
): Promise<{ deleted: number; inserted: number }> {
  // ── 1. Remove only what is leaving ────────────────────────────────────────
  const deleted = await scopedMutate(executor, scope, {
    sql: `DELETE FROM customer_fragrance_preferences
                WHERE customer_id = $1
                  AND dimension = $2
                  AND value <> ALL($3)`,
    params: [dimension, [...values]],
  });

  // ── 2. Add what is new ────────────────────────────────────────────────────
  //
  // One statement per value rather than a single multi-row insert, because
  // `INSERT … SELECT unnest(...)` is refused by `validateScopedStatement`
  // (`unsupported_statement_kind`) — deliberately, since neither a CTE nor an
  // INSERT…SELECT is provable by its rules. The caps are 20 at the largest, so
  // this is at most twenty single-row inserts inside a transaction that is
  // already open.
  //
  // `ON CONFLICT DO NOTHING` makes re-adding a value the customer already has a
  // no-op, which is what makes a repeated identical save write nothing.
  let inserted = 0;
  for (const value of values) {
    inserted += await scopedMutate(executor, scope, {
      sql: `INSERT INTO customer_fragrance_preferences (customer_id, dimension, value)
                 VALUES ($1, $2, $3)
            ON CONFLICT (customer_id, dimension, value) DO NOTHING`,
      params: [dimension, value],
    });
  }

  return { deleted, inserted };
}

/**
 * Creates the caller's communication row if absent, using the TABLE's defaults.
 *
 * Separate from the update so the defaults are never restated here (module
 * header). `ON CONFLICT DO NOTHING` means a customer who already has a row is not
 * reset to defaults by a partial save — which is the bug this two-step shape
 * exists to make impossible.
 */
export async function ensureCommunicationRow(
  executor: Queryable,
  scope: CustomerScope,
): Promise<boolean> {
  const affected = await scopedMutate(executor, scope, {
    sql: `INSERT INTO customer_communication_preferences (customer_id)
               VALUES ($1)
          ON CONFLICT (customer_id) DO NOTHING`,
  });
  return affected > 0;
}

/**
 * Applies a PARTIAL communication update.
 *
 * `coalesce($n, column)` per column, with `null` meaning "not supplied", so one
 * static statement expresses any subset of the four keys. The alternative —
 * assembling a `SET` list from the supplied keys — would mean building SQL from
 * data, which is the shape `validateScopedStatement` exists to refuse, and would
 * make the parameter count vary per request.
 *
 * Read-modify-write was rejected: two concurrent saves of different keys would
 * each read the other's pre-state and the second would undo the first. Here each
 * column is written from its own parameter or left as it stands, so concurrent
 * saves of different keys both survive.
 *
 * @returns true iff a row was updated (false only when no row exists, which
 *   {@link ensureCommunicationRow} prevents).
 */
export async function updateCommunicationPreferences(
  executor: Queryable,
  scope: CustomerScope,
  patch: ReadonlyMap<CommunicationKey, boolean>,
): Promise<boolean> {
  // Fixed parameter ORDER, declared beside the statement it must match, so the two
  // cannot disagree about which flag is which. `?? null` is what makes an
  // unsupplied key a no-op via `coalesce`.
  const params = COMMUNICATION_PARAM_ORDER.map((key) => patch.get(key) ?? null);
  const affected = await scopedMutate(executor, scope, {
    sql: `UPDATE customer_communication_preferences
             SET product_launches  = coalesce($2, product_launches),
                 restock_alerts    = coalesce($3, restock_alerts),
                 birthday_messages = coalesce($4, birthday_messages),
                 referral_updates  = coalesce($5, referral_updates),
                 updated_at        = now()
           WHERE customer_id = $1`,
    params,
  });
  return affected > 0;
}
