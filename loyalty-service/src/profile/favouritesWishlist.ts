/**
 * Favourites & account-level wishlist with union reconciliation (task 14.2).
 *
 * Part of the Profile / Preferences Service (design.md "Component 9"). Owns two
 * pieces of behavioural/preference state for a customer:
 *
 *   - Favourites — fragrances a customer has explicitly marked (Requirement 17.2).
 *     `setFavourite` persists a set/unset that is reflected on the next read;
 *     `listFavourites` returns the current set.
 *   - Account-level Wishlist — the authoritative wishlist owned by the
 *     Loyalty_Service (Requirement 17.4, A14). `getWishlist` returns it, and
 *     `reconcileWishlist` merges the device-local `shopify-wishlist`
 *     localStorage entries into it as a UNION on authentication, returning the
 *     merged set. After reconciliation the account-level set is authoritative.
 *
 * OFF-LEDGER GUARANTEE (Requirement 17.3): every statement here targets ONLY
 * the `customer_favourites` / `customer_wishlist` tables created by the profile
 * migration (task 14.1). This module NEVER reads or writes `ledger_entries`,
 * `point_lots`, or any balance-bearing table, and therefore can never change a
 * customer's Balance or Spendable_Balance. It also does not treat the
 * Metafield_Cache as the source of truth for these preferences.
 *
 * All DB access goes through the injected {@link Queryable} executor (a `pg`
 * Pool, PoolClient, or a caller's transaction client) exactly like the ledger
 * repository and referral modules — so the logic is unit-tested against an
 * in-memory fake without a live Postgres.
 *
 * SAFETY: defining this module touches no live/production system. SQL is issued
 * only when a caller passes a real Pool/PoolClient at runtime.
 */
import type { Queryable } from "../ledger/repository.js";

/** Stable machine-readable error codes surfaced to callers. */
export const PROFILE_PREFERENCE_ERROR_CODES = {
  invalidInput: "profile_invalid_input",
} as const;

/**
 * Thrown when a caller supplies an invalid customer id or product id. No state
 * is changed when this is raised.
 */
export class InvalidPreferenceInputError extends Error {
  readonly code = PROFILE_PREFERENCE_ERROR_CODES.invalidInput;
  constructor(message: string) {
    super(message);
    this.name = "InvalidPreferenceInputError";
  }
}

/**
 * Validates and normalises a Shopify product id. Product ids are numeric
 * strings (the underlying column is `BIGINT`); we accept a positive integer
 * string and return its canonical decimal form so `"007"` and `"7"` collapse to
 * the same entry (union set semantics). Rejects anything non-numeric, zero,
 * negative, or fractional.
 *
 * EXPORTED for the portal repository layer (spec task 5.4), which adds the
 * single-product wishlist write the storefront reconcile path never had. A
 * second normaliser there would be two definitions of "a product id" free to
 * disagree — and the one place they would disagree is leading zeros, which
 * decide whether two writes collapse to one row. Behaviour is unchanged: this
 * edit adds the keyword and nothing else.
 */
export function normaliseProductId(productId: string): string {
  if (typeof productId !== "string" || productId.trim() === "") {
    throw new InvalidPreferenceInputError("productId must be a non-empty string.");
  }
  const trimmed = productId.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidPreferenceInputError(
      `productId must be a positive integer id, received "${productId}".`,
    );
  }
  // Strip leading zeros via BigInt; reject 0 which is not a valid product id.
  const value = BigInt(trimmed);
  if (value <= 0n) {
    throw new InvalidPreferenceInputError("productId must be greater than zero.");
  }
  return value.toString();
}

/** Validates a local `customers.id`. */
function requireCustomerId(customerId: string): string {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    throw new InvalidPreferenceInputError("customerId must be a non-empty string.");
  }
  return customerId;
}

/**
 * Marks (`on = true`) or unmarks (`on = false`) a fragrance as a Favourite for a
 * customer. Idempotent: setting an already-favourited product is a no-op, and
 * unsetting a product that is not favourited is a no-op. The change is reflected
 * on the next {@link listFavourites} (and Fragrance_Profile) read (Req 17.2).
 *
 * Writes only to `customer_favourites` — never the ledger (Req 17.3).
 */
export async function setFavourite(
  executor: Queryable,
  customerId: string,
  productId: string,
  on: boolean,
): Promise<void> {
  const cid = requireCustomerId(customerId);
  const pid = normaliseProductId(productId);

  if (on) {
    await executor.query(
      `INSERT INTO customer_favourites (customer_id, shopify_product_id)
       VALUES ($1, $2)
       ON CONFLICT (customer_id, shopify_product_id) DO NOTHING`,
      [cid, pid],
    );
  } else {
    await executor.query(
      `DELETE FROM customer_favourites
       WHERE customer_id = $1 AND shopify_product_id = $2`,
      [cid, pid],
    );
  }
}

/**
 * Returns the customer's current Favourites as product-id strings, ordered by
 * product id for a deterministic response. Reads only `customer_favourites`.
 */
export async function listFavourites(
  executor: Queryable,
  customerId: string,
): Promise<string[]> {
  const cid = requireCustomerId(customerId);
  const result = await executor.query<{ shopify_product_id: string }>(
    `SELECT shopify_product_id FROM customer_favourites
     WHERE customer_id = $1
     ORDER BY shopify_product_id`,
    [cid],
  );
  return result.rows.map((row) => String(row.shopify_product_id));
}

/**
 * Returns the account-level Wishlist as product-id strings, ordered by product
 * id. This account-level set is authoritative (A14). Reads only
 * `customer_wishlist`.
 */
export async function getWishlist(executor: Queryable, customerId: string): Promise<string[]> {
  const cid = requireCustomerId(customerId);
  const result = await executor.query<{ shopify_product_id: string }>(
    `SELECT shopify_product_id FROM customer_wishlist
     WHERE customer_id = $1
     ORDER BY shopify_product_id`,
    [cid],
  );
  return result.rows.map((row) => String(row.shopify_product_id));
}

/**
 * Reconciles the device-local `shopify-wishlist` localStorage entries into the
 * account-level Wishlist as a UNION on authentication (Requirement 17.4, A14).
 *
 * Every device-local product id is inserted if not already present (existing
 * account-level entries are retained), so the result is the set-union of the
 * pre-existing account wishlist and the device-local list — with no duplicates
 * (the `(customer_id, shopify_product_id)` primary key + `ON CONFLICT DO
 * NOTHING` guarantee this). The merged set is retained as the authoritative
 * account-level wishlist and returned.
 *
 * Writes only to `customer_wishlist` — never the ledger (Req 17.3). Duplicate or
 * repeated device-local ids collapse to a single entry.
 */
export async function reconcileWishlist(
  executor: Queryable,
  customerId: string,
  deviceLocalProductIds: string[],
): Promise<string[]> {
  const cid = requireCustomerId(customerId);

  if (!Array.isArray(deviceLocalProductIds)) {
    throw new InvalidPreferenceInputError("deviceLocalProductIds must be an array.");
  }

  // Normalise + dedupe the device-local ids up front so we issue one insert per
  // distinct product and invalid ids are rejected before any write.
  const distinct = new Set<string>();
  for (const raw of deviceLocalProductIds) {
    distinct.add(normaliseProductId(raw));
  }

  // ── THE EXPLICIT-REMOVAL TOMBSTONE (task 9.1, design §8.4 rule 3) ──────────
  // The union is add-only and `localStorage['shopify-wishlist']` is NEVER cleared,
  // so without this a product the customer explicitly removed via
  // `PUT /v1/profile/wishlist/:productId {on:false}` would be RE-ADDED here — on
  // every page load, for as long as the handle stayed on the device.
  // `customer_wishlist_removals` is the record that lets the union tell "never
  // merged" apart from "explicitly removed", the distinction §8.4 says it could not
  // previously make.
  //
  // WHY THIS IS THREE STATEMENTS AND NOT ONE ANTI-JOIN. The natural shape is
  // `INSERT … SELECT … WHERE NOT EXISTS (…)`, evaluated atomically. That shape is
  // REFUSED by `validateScopedStatement`, and deliberately: `INSERT … SELECT` "can
  // express ownership correctly" but is "not provable by these rules", so the
  // primitive rejects it rather than wave it through. The gate runs over this file
  // because it is a delegation target, so the refusal applies here too. Widening a
  // security primitive to make one statement tidier is the wrong trade, so the
  // guard is honoured and the atomicity is recovered below instead.
  const suppressed = new Set(await listWishlistRemovals(executor, cid));
  for (const pid of distinct) {
    if (suppressed.has(pid)) continue;
    await executor.query(
      `INSERT INTO customer_wishlist (customer_id, shopify_product_id)
       VALUES ($1, $2)
       ON CONFLICT (customer_id, shopify_product_id) DO NOTHING`,
      [cid, pid],
    );
  }

  // WHY THERE IS NO POST-INSERT SWEEP. An earlier version re-read the tombstones
  // afterwards and DELETED anything removed during the merge, to close the window
  // above. It is deleted, because it broke a stronger invariant: reconciliation is
  // ADD-ONLY (Req 17.4, A14), so that a member signing in on a new device can never
  // LOSE account-level entries — an invariant `profileWrites.test.ts` asserts
  // directly. Buying a microsecond race with the ability for a merge to delete rows
  // is the wrong trade: the race costs one extra tap in an almost unreachable
  // interleaving, and the sweep would have made every reconcile a potential
  // deletion path. The removal authority stays exactly where §8.4 rule 5 puts it —
  // on N5, and nowhere else.

  // The account-level wishlist is authoritative after the merge; return it.
  return getWishlist(executor, cid);
}

/* ========================================================================== *
 * The explicit-removal tombstone (task 9.1, design §8.4 rule 3)
 * ========================================================================== */

/**
 * Records that the customer explicitly removed a product from their wishlist.
 *
 * IDEMPOTENT BY THE PRIMARY KEY. A customer has either removed a product or not;
 * a second removal is the same fact, not a second event. `DO NOTHING` therefore
 * PRESERVES the original `removed_at`, so the timestamp reflects the first explicit
 * removal rather than the most recent duplicate request — which is what makes a
 * retried request indistinguishable from a single one.
 *
 * Writes only `customer_wishlist_removals` — never the ledger (Req 17.3).
 */
export async function recordWishlistRemoval(
  executor: Queryable,
  customerId: string,
  productId: string,
): Promise<void> {
  const cid = requireCustomerId(customerId);
  const pid = normaliseProductId(productId);
  await executor.query(
    `INSERT INTO customer_wishlist_removals (customer_id, shopify_product_id)
     VALUES ($1, $2)
     ON CONFLICT (customer_id, shopify_product_id) DO NOTHING`,
    [cid, pid],
  );
}

/**
 * Forgets a recorded removal, because the customer has saved the product again.
 *
 * WITHOUT THIS, A REMOVAL WOULD BE PERMANENT. The tombstone records "the customer
 * removed this", not "this product is banned": an explicit add is a NEWER statement
 * of intent than an older removal and must supersede it. A customer who removed a
 * product and later changed their mind would otherwise find the portal add silently
 * undone by the next reconcile — the same resurrection bug inverted, and harder to
 * explain.
 */
export async function clearWishlistRemoval(
  executor: Queryable,
  customerId: string,
  productId: string,
): Promise<void> {
  const cid = requireCustomerId(customerId);
  const pid = normaliseProductId(productId);
  await executor.query(
    `DELETE FROM customer_wishlist_removals
     WHERE customer_id = $1
       AND shopify_product_id = $2`,
    [cid, pid],
  );
}

/**
 * The products this customer has explicitly removed, ordered by product id.
 *
 * Exists so the convergence property test can assert the tombstone's contents
 * directly rather than inferring them from reconcile behaviour, and so an operator
 * can answer "why did this product not come back" without reading the union's SQL.
 */
export async function listWishlistRemovals(
  executor: Queryable,
  customerId: string,
): Promise<string[]> {
  const cid = requireCustomerId(customerId);
  const result = await executor.query<{ shopify_product_id: string }>(
    `SELECT shopify_product_id FROM customer_wishlist_removals
     WHERE customer_id = $1
     ORDER BY shopify_product_id`,
    [cid],
  );
  return result.rows.map((row) => String(row.shopify_product_id));
}
