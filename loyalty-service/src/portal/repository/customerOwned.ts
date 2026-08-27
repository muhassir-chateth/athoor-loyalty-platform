/**
 * The portal's customer-owned Postgres repository (spec task 5.4).
 *
 * Every function here takes a {@link CustomerScope} and nothing that could stand
 * in for one. There is no overload, no optional parameter, no `string` fallback,
 * and no exported helper that accepts a bare customer id — so
 * `readWishlist(db, req.body.customerId)` is not a review finding, it is a
 * compile error.
 *
 * ── TWO KINDS OF FUNCTION, AND WHY BOTH BELONG ──────────────────────────────
 *
 * (a) DELEGATING WRAPPERS over shipped engine functions.
 *
 *     design §4.2(b) prescribes exactly this shape:
 *
 *         export async function readWishlist(db, scope) {
 *           return getWishlist(db, scope.customerId);   // the single unwrap
 *         }
 *
 *     It is the right shape for a reason worth stating, because the instinct runs
 *     the other way. The tempting move is to write fresh scoped SQL for the
 *     wishlist read so it flows through this layer's own primitive. That would
 *     produce a SECOND implementation of a read that already exists — and design
 *     §8.2 and Self-Review Check 5 forbid a second wishlist precisely because two
 *     readers of one table drift, and the drift shows up as a customer's saved
 *     items appearing in one surface and not another. So the wrapper adds the
 *     type-level guarantee and adds no SQL.
 *
 *     The obvious objection: if the SQL lives in the shipped module, what
 *     guarantees ITS ownership predicate? Not trust —
 *     `ownership.gate.test.ts` runs {@link validateScopedStatement} over every
 *     statement in each delegation target listed in {@link DELEGATION_TARGETS}.
 *     A future edit that weakened `WHERE customer_id = $1` in
 *     `profile/favouritesWishlist.ts` would fail a test in THIS directory.
 *
 * (b) NEW SCOPED STATEMENTS for portal-only work with no shipped equivalent.
 *
 *     {@link setWishlistItem} is the whole reason the wishlist cannot converge
 *     today: `POST /v1/profile/wishlist/reconcile` only ever ADDS (by design),
 *     so removal has no data path at all (§6.3 N5, §8). {@link countWishlistItems}
 *     is likewise new — nothing shipped needs a count, and N5's 500-item cap
 *     does. Both go through {@link scopedSelectOne} / {@link scopedMutate}, so
 *     their `$1` is bound from the scope and their SQL is proven scoped before it
 *     runs.
 *
 * ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────
 * No projection into an N-series response DTO. The wire shapes exist (task 5.6)
 * and the endpoints that own the projection decisions do not: N5's response
 * assembly is task 9.1, N16's status and money projection is task 10.2. Guessing
 * those here would settle contract questions in the wrong task and be invisible
 * when the right one disagreed. This module returns storage-shaped values —
 * product ids, counts, booleans — and stops.
 *
 * ── OFF-LEDGER, LIKE THE MODULE IT DELEGATES TO ─────────────────────────────
 * Every statement here targets `customer_wishlist` or `customer_favourites`
 * only. Nothing in this file reads or writes `ledger_entries`, `point_lots`,
 * `redemptions`, `discount_codes` or `referrals`, so no path through it can move
 * a balance (Requirement 23.6, design §9.5, §14.1).
 *
 * SAFETY: pure to import; SQL is issued only when a caller passes a real
 * Pool/PoolClient at runtime. No DDL, no migration, no production access.
 */
import type { CustomerScope } from "../../auth/customerScope.js";
import type { Queryable } from "../../ledger/repository.js";
import {
  getWishlist as engineGetWishlist,
  listFavourites as engineListFavourites,
  listWishlistRemovals as engineListWishlistRemovals,
  setFavourite as engineSetFavourite,
  normaliseProductId,
} from "../../profile/favouritesWishlist.js";
import { scopedMutate, scopedSelectOne } from "./scopedQuery.js";

/**
 * Modules whose SQL this layer delegates to, relative to `src/`.
 *
 * NOT DOCUMENTATION — `ownership.gate.test.ts` reads this array and validates
 * every statement in each file listed. Adding a delegation without adding it here
 * is caught too: the gate also asserts that every non-relative import this
 * directory makes into `src/profile/**` or `src/ledger/**` appears in the list,
 * so the list cannot silently fall behind the imports.
 */
export const DELEGATION_TARGETS: readonly string[] = ["profile/favouritesWishlist.ts"];

/* ========================================================================== *
 * Wishlist — the account-level set (§8, Requirement 7.1)
 * ========================================================================== */

/**
 * The customer's account-level wishlist as product-id strings.
 *
 * Delegates to the shipped reader rather than restating its SQL — see (a) in the
 * module header. The shipped statement is
 * `SELECT shopify_product_id FROM customer_wishlist WHERE customer_id = $1
 *  ORDER BY shopify_product_id`, whose predicate the gate verifies.
 */
export async function readWishlist(
  executor: Queryable,
  scope: CustomerScope,
): Promise<string[]> {
  return engineGetWishlist(executor, scope.customerId);
}

/**
 * How many products the customer has saved.
 *
 * EXISTS FOR N5's 500-ITEM CAP, which must be checked against the customer's own
 * set and nobody else's. Counting in SQL rather than by reading the set and
 * taking `.length` is not an optimisation: a read-then-count would ship every
 * product id across the wire to answer a question about a number, and a paginated
 * read later would silently make the count wrong.
 *
 * `COUNT(*)` always returns exactly one row, so {@link scopedSelectOne} cannot
 * raise its `404` here — that path is genuinely unreachable for this statement,
 * which is why it is safe to use the throwing variant for a value that always
 * exists.
 */
export async function countWishlistItems(
  executor: Queryable,
  scope: CustomerScope,
): Promise<number> {
  const row = await scopedSelectOne<{ item_count: string }>(executor, scope, {
    sql: `SELECT count(*)::text AS item_count
            FROM customer_wishlist
           WHERE customer_id = $1`,
  });
  // `count(*)` is BIGINT, which the driver returns as a string; cast in SQL so
  // the conversion is explicit rather than dependent on driver type parsing.
  return Number.parseInt(row.item_count, 10);
}

/**
 * Adds or removes ONE product from the customer's wishlist. The data path N5
 * needs and the storefront reconcile never had.
 *
 * Returns whether the stored set actually changed, so N5 can answer `200` for a
 * repeat add — which is correct, and idempotent — without that no-op being
 * mistaken for `404`. This is why {@link scopedMutate} is used rather than
 * {@link scopedMutateExpectingRow}: removing a product the customer does not have
 * saved is a legitimate success, not a missing resource. Mirrors the shipped
 * `PUT /v1/profile/favourites/:id` exactly, per §6.3 N5, so neither preference
 * endpoint becomes the odd one out.
 *
 * OWNERSHIP:
 *   add    — `INSERT INTO customer_wishlist (customer_id, …) VALUES ($1, $2)`,
 *            ownership as the leading column, so a row can only ever be created
 *            for the caller.
 *   remove — `DELETE … WHERE customer_id = $1 AND shopify_product_id = $2`,
 *            so a product id belonging to another customer matches zero rows and
 *            their row is untouched (§4.5 row 8).
 *
 * @throws {InvalidPreferenceInputError} the product id is not a positive integer
 */
export async function setWishlistItem(
  executor: Queryable,
  scope: CustomerScope,
  productId: string,
  on: boolean,
): Promise<boolean> {
  // Validated with the SAME normaliser the shipped reconcile path uses, so the
  // two agree about leading zeros — the one disagreement that would decide
  // whether `"007"` and `"7"` collapse to a single row.
  const normalisedProductId = normaliseProductId(productId);

  // ── THE TOMBSTONE, AND WHY THE ORDER OF THE TWO WRITES IS LOAD-BEARING ─────
  // These are two statements, not one transaction: `Queryable` is `Pool |
  // PoolClient`, so this layer cannot assume it holds a client it may BEGIN on.
  // The order is therefore chosen so that EITHER statement failing alone leaves a
  // safe state rather than a resurrection.
  //
  // REMOVE — tombstone FIRST, then delete the row. If the delete fails, the
  // customer still sees the product saved and the tombstone is already recorded, so
  // a reconcile cannot re-add a duplicate and the next attempt completes the
  // removal. Doing it the other way round would leave a window where the row is
  // gone and NOTHING records why — and the next reconcile, reading a device-local
  // list that is never cleared, would put it straight back.
  //
  // ADD — clear the tombstone FIRST, then insert the row. If the insert fails,
  // neither the row nor a suppression exists, so the device-local list is free to
  // restore exactly what the customer asked for. Inserting first would risk a row
  // that is present but still suppressed from future merges.
  // THROUGH THE PRIMITIVE, not through the engine helper. Both statements are
  // provable shapes — ownership as the leading INSERT column, `WHERE customer_id =
  // $1` on the DELETE — so `scopedMutate` gives them the same two guarantees every
  // other statement in this layer has: `$1` bound from the scope, and a driver fault
  // wrapped as `PortalRepositoryFaultError`. Calling the engine helper directly
  // would skip the fault wrapping, so an ECONNREFUSED on the tombstone would escape
  // this layer raw while the identical failure on the row write did not.
  if (on) {
    await scopedMutate(executor, scope, {
      sql: `DELETE FROM customer_wishlist_removals
             WHERE customer_id = $1
               AND shopify_product_id = $2`,
      params: [normalisedProductId],
    });
  } else {
    await scopedMutate(executor, scope, {
      sql: `INSERT INTO customer_wishlist_removals (customer_id, shopify_product_id)
                 VALUES ($1, $2)
            ON CONFLICT (customer_id, shopify_product_id) DO NOTHING`,
      params: [normalisedProductId],
    });
  }

  const affected = on
    ? await scopedMutate(executor, scope, {
        sql: `INSERT INTO customer_wishlist (customer_id, shopify_product_id)
                   VALUES ($1, $2)
              ON CONFLICT (customer_id, shopify_product_id) DO NOTHING`,
        params: [normalisedProductId],
      })
    : await scopedMutate(executor, scope, {
        sql: `DELETE FROM customer_wishlist
               WHERE customer_id = $1
                 AND shopify_product_id = $2`,
        params: [normalisedProductId],
      });

  return affected > 0;
}

/**
 * The products this customer has explicitly removed (task 9.1, §8.4 rule 3).
 *
 * Scope-typed like everything else here, so a caller cannot ask which products
 * SOMEONE ELSE removed. Exists for the convergence property test and for operator
 * diagnosis of "why did this product not come back after a reconcile".
 */
export async function readWishlistRemovals(
  executor: Queryable,
  scope: CustomerScope,
): Promise<string[]> {
  return engineListWishlistRemovals(executor, scope.customerId);
}

/* ========================================================================== *
 * Favourites — the shipped preference set (Requirement 17.2)
 * ========================================================================== */

/**
 * The customer's favourites as product-id strings. Delegating wrapper; the
 * shipped statement carries `WHERE customer_id = $1`.
 */
export async function readFavourites(
  executor: Queryable,
  scope: CustomerScope,
): Promise<string[]> {
  return engineListFavourites(executor, scope.customerId);
}

/**
 * Marks or unmarks one product as a favourite. Delegating wrapper; the shipped
 * writes are `INSERT … (customer_id, shopify_product_id) VALUES ($1, $2)
 * ON CONFLICT DO NOTHING` and `DELETE … WHERE customer_id = $1 AND
 * shopify_product_id = $2`.
 *
 * Wrapped rather than left to be called directly so that a portal handler has a
 * scope-typed option for every preference write it needs. Leaving one write
 * unwrapped would leave a `customerId: string` call site in portal code, and one
 * such call site is all it takes for the next one to look normal.
 */
export async function setFavourite(
  executor: Queryable,
  scope: CustomerScope,
  productId: string,
  on: boolean,
): Promise<void> {
  await engineSetFavourite(executor, scope.customerId, productId, on);
}

/* ========================================================================== *
 * Compile-time assertions (test files are excluded from `tsc`; see
 * `scopedQuery.ts` for the full reasoning).
 * ========================================================================== */

type Expect<T extends true> = T;

/**
 * No exported function in this module accepts a `string` where the scope goes.
 *
 * Asserted per function rather than once, because the failure mode is per
 * function: someone adds a convenience overload to the one they are working on,
 * and the others stay safe while that one is not. Each of these stops compiling
 * if its own signature is widened.
 */
export type WishlistReadRejectsAString = Expect<
  string extends Parameters<typeof readWishlist>[1] ? false : true
>;
export type WishlistCountRejectsAString = Expect<
  string extends Parameters<typeof countWishlistItems>[1] ? false : true
>;
export type WishlistWriteRejectsAString = Expect<
  string extends Parameters<typeof setWishlistItem>[1] ? false : true
>;
export type WishlistRemovalsReadRejectsAString = Expect<
  string extends Parameters<typeof readWishlistRemovals>[1] ? false : true
>;
export type FavouritesReadRejectsAString = Expect<
  string extends Parameters<typeof readFavourites>[1] ? false : true
>;
export type FavouritesWriteRejectsAString = Expect<
  string extends Parameters<typeof setFavourite>[1] ? false : true
>;
