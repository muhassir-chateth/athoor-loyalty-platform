/**
 * The ONE canonical `POST /v1/profile/wishlist/reconcile` contract, shared
 * across the client/server boundary (spec tasks 1.4/1.6, design §8.1, §T.1
 * "API contract" layer).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Defect W2: the storefront posted `{ productIds }` while the server schema
 * accepted `{ deviceLocal }` with `.strip()`. The unknown key was dropped,
 * `deviceLocal` was then absent, `safeParse` failed, the handler answered
 * `400 invalid_request`, and the client swallowed it with `.catch(noop)`. Two
 * sides, two contracts, and no test that spanned them — so CI stayed green
 * while wishlist convergence was dead in production.
 *
 * The schema and the request/response types now live in exactly one place. The
 * boundary test (`wishlistReconcileContract.boundary.test.ts`) types the body
 * the REAL client serialises as {@link WishlistReconcileRequest} and feeds it to
 * the REAL schema, so the next divergence is a compile error or a red test
 * rather than a silent `400`.
 *
 * WHICH SIDE WAS WRONG, AND WHY THE CLIENT IS THE ONE THAT MOVED
 * --------------------------------------------------------------
 * `deviceLocal` is KEPT, and the client was changed to match it. This is not an
 * arbitrary coin-toss between two equal names — `deviceLocal` is an existing,
 * shipped, production-verified `/v1` field:
 *
 *   - it is the published contract in the shipped platform design's route table
 *     (`docs/specs/athoor-loyalty-platform/design.md`:
 *     `POST /v1/profile/wishlist/reconcile: (ctx, deviceLocal: string[])`);
 *   - it was verified against PRODUCTION (`docs/specs/athoor-loyalty-platform/tasks.md`
 *     records that live `deviceLocal: ["athoor-oud"]` is refused `400`, which is
 *     only observable if production reads the field);
 *   - it is exercised by the shipped server suites (`routes/profileWrites.test.ts`,
 *     `profileWrites.integration.test.ts`) and by the domain function's own
 *     parameter name (`reconcileWishlist(db, customerId, deviceLocalProductIds)`).
 *
 * Requirement 20.6 states that no existing `/v1` endpoint, field or response
 * shape may be removed or renamed. Renaming `deviceLocal` would breach it. By
 * contrast `{ productIds }` existed ONLY inside the theme script and inside a
 * client test that stubbed `fetch`, so it had no production dependency at all —
 * it is the side that is free to move, so it moved.
 *
 * The name is also semantically correct rather than merely tolerated: it names
 * the PROVENANCE of the list ("the entries this device held locally"), not its
 * element type. The client resolves each device-local handle to a numeric
 * Shopify product id via `/products/{handle}.js` BEFORE sending, so the array
 * carries product ids, exactly as the server's `deviceLocalProductIds`
 * parameter and the `BIGINT` column require.
 *
 * SAFETY: types and a schema only. Importing this module performs no I/O.
 */
import { z } from "zod";

/**
 * Upper bound on the device-local array. Matches the 500-item per-customer
 * wishlist cap so a caller cannot use reconciliation to exceed it in one shot.
 */
export const WISHLIST_RECONCILE_MAX_ITEMS = 500;

/**
 * Upper bound on a single identifier. A Shopify product id is a `BIGINT`, so 20
 * digits is already generous; bounding it stops an unbounded string reaching the
 * domain validator or the logs.
 */
export const WISHLIST_RECONCILE_MAX_ID_LENGTH = 32;

/**
 * Body of `POST /v1/profile/wishlist/reconcile` — the canonical request shape.
 *
 * STAYS STRICT. `.strip()` is retained deliberately: the endpoint accepts this
 * shape and nothing else. There is no compatibility shim accepting the old
 * `{ productIds }` key, and none is wanted — a shim would have hidden W2
 * permanently instead of failing loudly once.
 */
export const WISHLIST_RECONCILE_SCHEMA = z
  .object({
    deviceLocal: z
      .array(z.string().min(1).max(WISHLIST_RECONCILE_MAX_ID_LENGTH))
      .max(WISHLIST_RECONCILE_MAX_ITEMS),
  })
  .strip();

/**
 * The request body both sides agree on. The storefront serialises exactly this;
 * the route parses exactly this. A future mismatch is a `tsc` failure in the
 * boundary test rather than a runtime `400` no one sees.
 */
export type WishlistReconcileRequest = z.infer<typeof WISHLIST_RECONCILE_SCHEMA>;

/** The `200` response: the merged, authoritative account-level wishlist (A14). */
export interface WishlistReconcileResponse {
  /** Product-id strings, ascending — the union of the account set and the device-local set. */
  wishlist: string[];
}

/** The `400` body when the request does not match {@link WISHLIST_RECONCILE_SCHEMA}. */
export const WISHLIST_RECONCILE_INVALID_REQUEST_MESSAGE =
  `A body of { deviceLocal: string[] } with at most ${WISHLIST_RECONCILE_MAX_ITEMS} ids is required.`;
