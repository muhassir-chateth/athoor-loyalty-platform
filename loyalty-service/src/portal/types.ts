/**
 * THE ONE canonical wire contract for the portal's additive endpoints N1–N16
 * (spec task 5.6, design §6.2 and §6.3), shared across the client/server
 * boundary.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Defects W1 and W2 were the same defect twice: the storefront and the server
 * each held their own private idea of one contract, nothing typed both sides,
 * and the mismatch surfaced as a silent `400` in production while CI stayed
 * green (design §8.1). `profile/wishlistReconcileContract.ts` closed that hole
 * for one endpoint. This module does the same job for the sixteen additive
 * portal endpoints, BEFORE any of them is implemented — so the failure mode is
 * a `tsc` error at build time rather than a `400` no one is watching.
 *
 * That is the whole point: `theme-src/portal/data/**` (task 7.1) imports these
 * types, the route handlers of tasks 8–15 satisfy them, and a field renamed on
 * one side stops compiling on the other.
 *
 * WHERE THIS FILE LIVES, AND WHY IT IS NOT IN `theme-src/`
 * -------------------------------------------------------
 * The canonical copy lives in the service, under `rootDir: "src"`, so it is
 * type-checked by `tsc -p tsconfig.json` and reachable from vitest. `theme-src/`
 * is a build INPUT compiled into theme assets by esbuild (task 7.1) and is not
 * covered by the service's tsconfig, so a contract living there would be checked
 * by neither side — the exact gap W2 exploited. The theme imports from here;
 * nothing is duplicated. This mirrors the precedent already set by
 * `profile/wishlistReconcileContract.ts`, whose boundary test imports the shared
 * schema from `src/` while exercising the real shipped theme script.
 *
 * SCOPE — WHAT THIS FILE IS AND IS NOT
 * ------------------------------------
 * It is the N1–N16 request/response SHAPES and nothing else. It contains no
 * handler, no `zod` schema, no SQL, no Shopify query, and no business rule.
 * Per-endpoint validation schemas belong with their routes (tasks 8–15), where
 * the runtime bounds and the error mapping live. Additive fields on EXISTING
 * endpoints — the `/v1/balance` reward eligibility block (task 10.1), the
 * `/v1/referral` stage model (task 11.1), the `/v1/profile` `inferred` block
 * (task 13.3) — are deliberately absent: they are additions to shipped
 * contracts, not new ones, and Requirement 20.6 governs them separately.
 *
 * THREE RULES THAT SHAPE EVERY TYPE BELOW
 * ---------------------------------------
 * 1. NO CUSTOMER IDENTIFIER, ANYWHERE. Not one type here carries a
 *    `customerId`. Every portal endpoint derives the customer from the branded
 *    `CustomerScope` (`auth/customerScope.ts`), which can only be constructed
 *    from an already-verified identity. A DTO carrying a customer id would hand
 *    the client a field with which to NOMINATE a customer, reopening by data
 *    exactly the IDOR hole the brand closes by type. The absence is structural,
 *    not an oversight.
 *
 * 2. IDENTIFIERS AND VALUES, NEVER PRESENTATION (Requirement 21.7). No field
 *    here holds a sentence written for a customer to read, HTML, or a CSS class
 *    name. Statuses, states, reasons and error codes are stable identifiers that
 *    the client resolves to wording through its own copy map (`ui/copy.ts`, task
 *    18.6). That is what lets the wording change without a service deploy, and a
 *    future mobile client use its own — and it is what Property 10 asserts.
 *    Product and line-item `title` fields are the deliberate exception and are
 *    not a breach: they are Shopify catalogue DATA, recorded on the order, not
 *    copy this service authored.
 *
 * 3. MONEY IS A DECIMAL STRING (design §6.2). See {@link MoneyGBP}.
 *
 * A NOTE ON `readonly`. Every response field is `readonly`. A response describes
 * bytes that already arrived; mutating the parsed object cannot change what the
 * server said, so a mutation is always either a mistake or a local cache being
 * smuggled through a wire type. Request types are mutable, because a client
 * legitimately assembles one field by field.
 *
 * SAFETY: types, three numeric constants and one pure regex guard. Importing
 * this module performs no I/O, issues no SQL, and calls no Shopify endpoint.
 *
 * _Requirements: 20.6, 21.1, 21.7_
 */
import { WISHLIST_RECONCILE_MAX_ITEMS } from "../profile/wishlistReconcileContract.js";
import type { WishlistReconcileResponse } from "../profile/wishlistReconcileContract.js";

/* ========================================================================== *
 * Money
 * ========================================================================== */

/**
 * A GBP amount as a decimal string with exactly two fractional digits — `"0.00"`,
 * `"184.00"`, `"-5.50"`.
 *
 * WHY A STRING AND NOT A NUMBER. Design §6.2 requires it, and the reason is
 * float drift: IEEE-754 cannot represent `0.1` exactly, so money that survives a
 * few arithmetic hops in JavaScript stops matching the ledger. The database
 * already agrees — `redemptions.value_gbp` and `discount_codes.amount_off_gbp`
 * are `NUMERIC(8,2)`, and `pg` returns `NUMERIC` as a STRING precisely so the
 * driver never rounds. Emitting that string unchanged is the zero-conversion,
 * zero-loss path.
 *
 * A DISCREPANCY WORTH STATING PLAINLY. Design §6.2 justifies decimal strings as
 * "matching the existing `lifetimeSpendGBP` 2-dp convention". The existing
 * convention is NOT a string: `routes/balance.ts` declares
 * `lifetimeSpendGBP: number` and `PgCustomerBalanceSource` explicitly parses the
 * `NUMERIC` column to a number, and `rewards/catalog.ts` declares
 * `valueGBP: number`. So the design's stated precedent does not exist, though
 * its instruction is unambiguous. Both survive: the NEW N1–N16 fields are
 * decimal strings, and the SHIPPED numeric fields on `/v1/balance` and
 * `/v1/rewards` are left exactly as they are, because Requirement 20.6 forbids
 * changing an existing field's shape. The consequence to know about is that
 * `Reward.valueGBP` (number) and {@link PortalRedemption.valueGBP} (string) are
 * the same quantity in two representations on two different endpoints. That is
 * the cost of an additive-only rule, and it is a smaller cost than either
 * breaking a shipped contract or letting new money fields drift as floats.
 *
 * WHY THIS IS AN ALIAS AND NOT A BRANDED TYPE. `CustomerScope` is branded
 * because a bare string there is a security hole and every construction site
 * must be forced through one checked constructor. Money is different: these
 * values arrive from `JSON.parse`, so a brand would put a cast at every parse
 * boundary — and casts are the one escape hatch the brand pattern cannot close
 * (see `auth/customerScope.ts`). An alias that documents the format, plus
 * {@link isMoneyGBP} for the boundary tests to assert with, buys the honesty
 * without manufacturing cast pressure.
 */
export type MoneyGBP = string;

/**
 * The exact accepted form of a {@link MoneyGBP}: optional leading `-`, at least
 * one integer digit, then a `.` and exactly two fractional digits. No thousands
 * separators, no currency symbol, no exponent, no bare integer — `"184"` is
 * rejected on purpose, because a two-decimal-place contract that silently
 * tolerates a missing `.00` is not a contract.
 *
 * Anchored, and with no unbounded quantifier over a character class that could
 * backtrack, so it is safe to run on untrusted input.
 */
export const MONEY_GBP_PATTERN = /^-?\d+\.\d{2}$/;

/**
 * True iff `value` is a {@link MoneyGBP}.
 *
 * Exists so the contract is checkable rather than merely described: the boundary
 * tests for tasks 8–15 assert every money field on a real response body against
 * this, which is how "GBP values are 2-dp decimal strings" becomes a test
 * failure instead of a comment. Pure; allocates nothing beyond the match.
 */
export function isMoneyGBP(value: unknown): value is MoneyGBP {
  return typeof value === "string" && MONEY_GBP_PATTERN.test(value);
}

/* ========================================================================== *
 * The error envelope, shared by every portal endpoint
 * ========================================================================== */

/**
 * The error identifiers the N1–N16 endpoints may return, as §6.3 lists them:
 * the common set every portal endpoint shares, plus the endpoint-specific ones
 * §6.3 names for N2, N5 and N11.
 *
 * CLOSED ON PURPOSE. The client maps each identifier to wording and to a
 * designed state; a code outside this union has no mapping and would render as
 * the neutral error state (design E.1 rule 5). Closing the union means adding an
 * endpoint that invents a code fails to compile against the client's map rather
 * than silently degrading in front of a customer.
 *
 * This is the N1–N16 subset, NOT the whole service taxonomy — design E.2 lists
 * the full set including the redemption, referral and rate-limit codes owned by
 * endpoints outside this module's scope.
 */
export type PortalErrorCode =
  // Common to every portal endpoint (§6.3 preamble).
  | "app_proxy_signature_invalid"
  | "identity_resolution_failed"
  | "invalid_request"
  | "invalid_idempotency_key"
  | "not_found"
  | "rate_limit_exceeded"
  | "upstream_unavailable"
  | "conflict"
  // N2 (§6.3).
  | "invalid_order_reference"
  | "order_not_found"
  // N5 (§6.3).
  | "wishlist_limit_reached"
  // N11 (§11.10).
  | "birthday_change_locked";

/**
 * One rejected field, as `{ field, code }` — a CODE, never a sentence (§6.3
 * N6/N7, design E.1 rule 4).
 *
 * The client owns the wording because the wording is presentation: the same
 * `too_long` on the same field reads differently in a web form and in a native
 * app, and neither should require a service deploy to change. Shopify's own
 * `userErrors` text is mapped to one of these codes and never forwarded
 * (design E.1 rule 2), which is what keeps upstream message text structurally
 * out of the response body.
 */
export interface PortalFieldError {
  /** The rejected field's name as the request supplied it. */
  readonly field: string;
  /** A stable identifier for why it was rejected, e.g. `required`, `too_long`. */
  readonly code: string;
}

/**
 * Every portal error body: `{ error, message }` plus endpoint-specific fields
 * (§6.3 preamble).
 *
 * `message` is a customer-SAFE fallback, not the rendered sentence — the client
 * renders from `error` via its copy map (design E.1 rule 3). It is typed here so
 * that what may appear in an error body is enumerated rather than open, which is
 * what makes "no stack trace, no SQL, no table name, no upstream text" (Req 2.7)
 * checkable at the type level as well as in the log-capture test.
 */
export interface PortalErrorBody {
  readonly error: PortalErrorCode;
  readonly message: string;
  /** Present only on a `400 invalid_request` that failed field-level validation. */
  readonly fields?: readonly PortalFieldError[];
  /** Present only on `429 rate_limit_exceeded` — drives the client's countdown. */
  readonly retryAfterSeconds?: number;
  /** Present only on `409 birthday_change_locked` — the ISO date a change reopens. */
  readonly allowedFrom?: string;
}

/* ========================================================================== *
 * Shared primitives
 * ========================================================================== */

/**
 * Cursor pagination, mirroring Shopify's own `pageInfo` (§6.3 N1).
 *
 * `endCursor` is nullable: Shopify returns no cursor for an empty connection.
 * §6.3's example shows a populated page, so it shows a string; typing it
 * non-null would make the client trust a value that is absent for exactly the
 * customer with no orders — the empty-state case the portal must render
 * correctly (Req 16.2).
 */
export interface PortalPageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

/**
 * An image with its INTRINSIC dimensions.
 *
 * The dimensions are non-optional because the client must never guess an aspect
 * ratio (Req 18.5): a guess is either a layout shift when the real image lands
 * or a hardcoded ratio that crops. `imageUrl` is nullable — a product may have
 * no image — and when it is null the dimensions describe nothing, so the client
 * renders its designed no-image box rather than a broken `<img>`.
 */
export interface PortalImage {
  readonly imageUrl: string | null;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

/**
 * A Shopify enum identifier, passed through verbatim (e.g. `PAID`,
 * `FULFILLED`, `UNFULFILLED`).
 *
 * DELIBERATELY OPEN, and this is a considered choice rather than laziness.
 * Design §6.3 gives examples but never enumerates these vocabularies, and
 * Shopify's are long and version-dependent (`PARTIALLY_PAID`, `ON_HOLD`,
 * `RESTOCKED`, …). Inventing a closed union would mean inventing a vocabulary
 * the design does not specify — and the moment Shopify returned a value outside
 * it, the service would either have to lie or fail. §18.9 already requires the
 * client's copy map to be TOTAL with a neutral fallback for an unmapped
 * identifier, which presupposes that unmapped values can occur. This type says
 * so honestly instead of pretending otherwise.
 */
export type ShopifyStatusIdentifier = string;

/* ========================================================================== *
 * N1 — GET /v1/orders
 * ========================================================================== */

/**
 * The largest page `GET /v1/orders` will serve (Req 6.12).
 *
 * A LARGER REQUEST IS CAPPED, NOT REJECTED (task 8.1): asking for 100 orders is
 * not a customer error, and a `400` there would turn a client's optimism into a
 * broken page. The server returns 20 and says so through `pageInfo`.
 */
export const PORTAL_ORDERS_MAX_PAGE_SIZE = 20;

/** Query parameters accepted by `GET /v1/orders` (N1). */
export interface PortalOrdersQuery {
  /** 1–{@link PORTAL_ORDERS_MAX_PAGE_SIZE}, default {@link PORTAL_ORDERS_MAX_PAGE_SIZE}. */
  pageSize?: number;
  /** Opaque forward cursor from a previous `pageInfo.endCursor`. */
  cursor?: string;
}

/**
 * The fields an order carries in BOTH the list (N1) and the detail (N2) view.
 *
 * Factored out because §6.3 describes N2 as "adds" to N1 — so the overlap is
 * one contract, stated once. Two hand-maintained copies of these seven fields
 * is precisely how a summary and a detail view drift into disagreeing about the
 * same order, which the customer sees as a total that changes when they tap
 * through.
 */
export interface PortalOrderCore {
  /** The numeric Shopify order id as a string — portal-facing, matches `^\d{1,20}$`. */
  readonly id: string;
  /** The customer-facing order number, e.g. `#1042`. Shopify's own value. */
  readonly name: string;
  /** ISO-8601 instant the order was processed. */
  readonly processedAt: string;
  readonly financialStatus: ShopifyStatusIdentifier;
  /**
   * DERIVED AND NEVER NULL (§6.3 N1): `UNFULFILLED` when Shopify reports none.
   * The derivation is server-side so the client never has to decide what a null
   * fulfilment state means — two clients would decide differently.
   */
  readonly fulfilmentStatus: ShopifyStatusIdentifier;
  readonly totalGBP: MoneyGBP;
  /** ISO-4217, `GBP` at MVP. Present so a future market cannot be assumed away. */
  readonly currencyCode: string;
}

/**
 * A line item as it appears in an N1 preview row — enough to render a thumbnail
 * strip, and nothing more.
 *
 * Carries no price and no product reference on purpose: the list view shows the
 * ORDER's total, and a preview thumbnail that linked somewhere would invite the
 * client to build a second, poorer order-detail view out of list data.
 */
export interface PortalOrderPreviewLineItem extends PortalImage {
  /** Shopify's recorded line title. Catalogue data, not authored copy. */
  readonly title: string;
  readonly quantity: number;
}

/** One row of `GET /v1/orders` (N1). */
export interface PortalOrderSummary extends PortalOrderCore {
  readonly lineItemCount: number;
  readonly previewLineItems: readonly PortalOrderPreviewLineItem[];
}

/** `200` body of `GET /v1/orders` (N1). */
export interface PortalOrdersResponse {
  readonly orders: readonly PortalOrderSummary[];
  readonly pageInfo: PortalPageInfo;
}

/* ========================================================================== *
 * N2 — GET /v1/orders/:orderId
 * ========================================================================== */

/** The path form `:orderId` must take, or the endpoint answers `400 invalid_order_reference`. */
export const PORTAL_ORDER_ID_PATTERN = /^\d{1,20}$/;

/**
 * A line item in the detail view (N2).
 *
 * THE FOUR-STATE TABLE OF §7.5 IS EXPRESSED IN THESE FIELDS, not in a status
 * string, which is why they are individually nullable:
 *
 *   published + in stock  → `productId` set, `productHandle` set, `available` true
 *   published + no stock  → `productId` set, `productHandle` set, `available` false
 *   unpublished           → `productId` set, `productHandle` null,  `available` false
 *   deleted               → `productId` null, `productHandle` null, `available` false
 *
 * `title` and both prices survive all four, because Shopify records them ON the
 * order. That is what lets a two-year-old order still render correctly after the
 * product is gone (Req 6.9) — and `productHandle: null` is the client's signal
 * to emit no link, since there is no handle to link to.
 */
export interface PortalOrderLineItem extends PortalImage {
  /** Shopify's recorded line title, preserved even once the product is deleted. */
  readonly title: string;
  readonly quantity: number;
  readonly originalUnitPriceGBP: MoneyGBP;
  readonly discountedTotalGBP: MoneyGBP;
  /** `null` once the product is deleted from the catalogue. */
  readonly productId: string | null;
  /** `null` once the variant no longer exists. */
  readonly variantId: string | null;
  /** `null` when unpublished or deleted — the client's cue to render no link. */
  readonly productHandle: string | null;
  /** Currently purchasable. `false` for out-of-stock, unpublished and deleted alike. */
  readonly available: boolean;
}

/**
 * A postal address on an order or in the customer's address book (N2, N8).
 *
 * EVERY COMPONENT IS NULLABLE, and that is a deliberate divergence from a
 * literal reading of §6.3, which lists the fields flat without null markers.
 * Shopify's `MailingAddress` declares all of them nullable, and real addresses
 * exercise it: a UK address routinely has no `province`, plenty have no
 * `address2`, and a customer need not have supplied a phone. Typing those as
 * `string` would have the client trust a value that is absent — the W1/W2 class
 * of defect inverted, and one that surfaces as `undefined` rendered to a
 * customer, which Req 16.8 forbids outright.
 *
 * CONFIRMED AGAINST THE LIVE `2024-10` SCHEMA (task 14.3, by introspection): every
 * field of `MailingAddress` and `MailingAddressInput` is indeed nullable/optional,
 * so the divergence above was correct and stands. Two notes from that reading:
 * `MailingAddressInput` also accepts `company`, which this contract deliberately
 * omits — §6.3 does not list it and the portal offers no control for it, so adding
 * it here would create a field no surface can set; and Shopify names the country
 * enum `countryCodeV2` on output while the input takes `countryCode`, which is why
 * the projection maps one to the other rather than passing it through.
 */
export interface PortalAddress {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly zip: string | null;
  /** ISO-3166-1 alpha-2, e.g. `GB`. An identifier — the client renders the name. */
  readonly countryCode: string | null;
  readonly phone: string | null;
}

/**
 * One fulfilment of an order (N2).
 *
 * All three tracking fields are nullable together: tracking is PASSED THROUGH
 * ONLY WHEN SHOPIFY SUPPLIES IT (task 8.2/20.3). The portal never synthesises a
 * carrier URL from a bare reference — a guessed link that 404s is worse than no
 * link, because the customer reads it as their parcel being lost.
 */
export interface PortalFulfilment {
  readonly status: ShopifyStatusIdentifier;
  readonly trackingCompany: string | null;
  readonly trackingNumber: string | null;
  readonly trackingUrl: string | null;
}

/** `200` body of `GET /v1/orders/:orderId` (N2). */
export interface PortalOrderDetail extends PortalOrderCore {
  readonly lineItems: readonly PortalOrderLineItem[];
  /** `null` for an order with no shipping address, e.g. a digital-only order. */
  readonly shippingAddress: PortalAddress | null;
  readonly fulfilments: readonly PortalFulfilment[];
  readonly subtotalGBP: MoneyGBP;
  readonly shippingGBP: MoneyGBP;
  readonly taxGBP: MoneyGBP;
}

/* ========================================================================== *
 * N3 — POST /v1/orders/:orderId/reorder-plan
 * ========================================================================== */

/** Why a line cannot be reordered. Identifiers; the client owns the wording. */
export type PortalReorderUnavailableReason = "out_of_stock" | "discontinued";

/**
 * Body of `POST /v1/orders/:orderId/reorder-plan` (N3). An absent or omitted
 * `lineItemIds` means the WHOLE order — the Reorder case, as against Buy Again
 * on a single line.
 */
export interface PortalReorderPlanRequest {
  lineItemIds?: string[];
}

/** A line the customer can add to their cart right now. */
export interface PortalReorderAddableLine {
  /** The variant resolved server-side AT REQUEST TIME, not the one on the old order. */
  readonly variantId: string;
  readonly quantity: number;
  readonly title: string;
}

/** A line that cannot be added, with the reason as an identifier. */
export interface PortalReorderUnavailableLine {
  readonly title: string;
  readonly reason: PortalReorderUnavailableReason;
}

/**
 * `200` body of N3 — a PLAN, not a cart.
 *
 * The client posts `addable` to Shopify's own `/cart/add.js`. The service
 * deliberately does not write the cart: the cart is a storefront-session concept
 * the Admin API has no business touching, and routing it through Render would
 * put a cold start between a tap and a cart update (§6.3 N3). What stays on the
 * server is the only part that needs authoritative data — deciding what is
 * purchasable — which is why `unavailable` is returned rather than silently
 * dropped (Req 6.7).
 */
export interface PortalReorderPlanResponse {
  readonly addable: readonly PortalReorderAddableLine[];
  readonly unavailable: readonly PortalReorderUnavailableLine[];
}

/* ========================================================================== *
 * N4 — GET /v1/catalog/products
 * ========================================================================== */

/** Most product ids one `GET /v1/catalog/products` call will accept (§6.3 N4). */
export const PORTAL_CATALOG_MAX_IDS = 50;

/** Query parameters for `GET /v1/catalog/products` (N4). */
export interface PortalCatalogQuery {
  /** At most {@link PORTAL_CATALOG_MAX_IDS} Shopify product ids. */
  ids: string[];
}

/**
 * Current catalogue facts for one product (N4).
 *
 * `published` and `availableForSale` are SEPARATE booleans because they are
 * separate facts with different consequences: an unpublished product cannot be
 * linked to, whereas an out-of-stock published one can be linked to but not
 * bought. Collapsing them into one flag would force the client to guess which
 * of the two designed states to render (§7.5).
 */
export interface PortalCatalogProduct extends PortalImage {
  readonly productId: string;
  readonly title: string;
  /** `null` when unpublished — the client renders no link. */
  readonly handle: string | null;
  readonly published: boolean;
  readonly availableForSale: boolean;
  readonly priceGBP: MoneyGBP;
  /** `null` when the product is not discounted. */
  readonly compareAtPriceGBP: MoneyGBP | null;
  /** `null` when no purchasable variant exists; without it, no add-to-bag. */
  readonly defaultVariantId: string | null;
}

/**
 * `200` body of N4. Non-authoritative and cached 60 s in process.
 *
 * `missing` NAMES THE IDS SHOPIFY WOULD NOT RETURN, and that array is the whole
 * reason this endpoint reports absence explicitly instead of just returning
 * fewer products. A wishlist row for a deleted product must still render, with a
 * working remove control (Req 7.6) — silently dropping it would strand the entry
 * in the customer's list with no way to clear it. An id the client can no longer
 * see is an id it can no longer remove.
 */
export interface PortalCatalogResponse {
  readonly products: readonly PortalCatalogProduct[];
  readonly missing: readonly string[];
}

/* ========================================================================== *
 * N5 — PUT /v1/profile/wishlist/:productId
 * ========================================================================== */

/**
 * The per-customer wishlist cap. `409 wishlist_limit_reached` at this many
 * items (§6.3 N5).
 *
 * RE-EXPORTED, NOT RE-DECLARED. This is the same 500 that already bounds
 * `POST /v1/profile/wishlist/reconcile`, and it has to be: a cap that reconcile
 * enforced at one number while N5 enforced at another would let a customer
 * exceed either bound by alternating between the two endpoints. One constant,
 * one cap, no arithmetic to keep in step.
 */
export const PORTAL_WISHLIST_MAX_ITEMS = WISHLIST_RECONCILE_MAX_ITEMS;

/** Body of `PUT /v1/profile/wishlist/:productId` (N5). */
export interface PortalWishlistSetRequest {
  on: boolean;
}

/**
 * `200` body of N5, echoing the resulting set so the client needs no follow-up
 * read.
 *
 * `wishlist` is typed FROM the shipped reconcile response rather than restated
 * as `string[]`. Both endpoints return the same authoritative set, so tying them
 * together makes a future change to one a compile error in the other — which is
 * the discipline whose absence let the wishlist contract drift in the first
 * place (design §8.1). This shape also mirrors the shipped
 * `PUT /v1/profile/favourites/:id` response (`{ productId, on, favourites }`)
 * exactly, per §6.3 N5, so neither preference endpoint becomes the odd one out.
 */
export interface PortalWishlistSetResponse {
  readonly productId: string;
  readonly on: boolean;
  readonly wishlist: WishlistReconcileResponse["wishlist"];
}

/* ========================================================================== *
 * N6 / N7 — /v1/profile/identity
 * ========================================================================== */

/**
 * `200` body of `GET /v1/profile/identity` (N6).
 *
 * `emailEditable` is `false` — the literal type, not `boolean`. Email is
 * authentication-owned and is changed through Shopify's own account experience
 * (Req 5.8), so this endpoint can never report otherwise, and a client that
 * branches on it can be compiled against that certainty rather than trusting a
 * runtime value.
 */
export interface PortalIdentityResponse {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly emailEditable: false;
}

/**
 * Body of `PUT /v1/profile/identity` (N7).
 *
 * `email` IS ABSENT, AND ITS ABSENCE IS THE ENFORCEMENT. Requirement 5.8 says
 * email is not editable here; §6.3 N7 makes that true by leaving the field out
 * of the schema rather than by checking for it in a handler. A client that tries
 * to send one does not compile, and the route's `.strip()` drops it before the
 * handler can see it (task 14.2). A check can be forgotten on a new code path;
 * a field that does not exist cannot be.
 */
export interface PortalIdentityUpdateRequest {
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/* ========================================================================== *
 * N8 — /v1/profile/addresses
 * ========================================================================== */

/** One saved address, as `GET /v1/profile/addresses` returns it (N8). */
export interface PortalSavedAddress extends PortalAddress {
  /** The Shopify address id. Foreign values are rejected upstream → `404`. */
  readonly id: string;
  readonly isDefault: boolean;
}

/** `200` body of `GET /v1/profile/addresses` (N8). */
export interface PortalAddressesResponse {
  readonly addresses: readonly PortalSavedAddress[];
}

/**
 * Body of `POST /v1/profile/addresses` and `PUT /v1/profile/addresses/:addressId`
 * (N8).
 *
 * STRUCTURALLY CANNOT CARRY `id` OR `isDefault`. `id` is the path's to state, so
 * accepting it in a body would create two disagreeing answers to "which address
 * is this?" — and the body's is client-supplied. `isDefault` has its own
 * endpoint (`PUT /:addressId/default`), because making an address default is a
 * change to the SET, not to that one address; accepting it here would let one
 * request silently demote another address the caller never mentioned.
 *
 * Every field is optional at the TYPE level and required-ness is settled by the
 * route's schema (task 14.3). A single type cannot say "required on create,
 * optional on update" without two types §6.3 does not specify, so the type
 * states what is universally true and validation states the rest.
 *
 * `-readonly` because this is a REQUEST: a client assembles it field by field,
 * so inheriting the response type's immutability would be the wrong default in
 * the one direction where mutation is legitimate.
 */
export type PortalAddressInput = {
  -readonly [K in keyof Omit<PortalSavedAddress, "id" | "isDefault">]?: PortalSavedAddress[K];
};

/* ========================================================================== *
 * N9 — PUT /v1/profile/consent
 * ========================================================================== */

/** Body of `PUT /v1/profile/consent` (N9). */
export interface PortalConsentUpdateRequest {
  emailMarketing: boolean;
}

/**
 * `200` body of N9.
 *
 * `updatedAt` COMES FROM SHOPIFY, which is the point. Requirement 13.3 wants the
 * date consent last changed; taking it from the mutation's own response means
 * this service never stores a second copy of a consent timestamp that could
 * disagree with the authoritative one (§6.3 N9). Two records of when someone
 * withdrew consent is a compliance problem, not a caching convenience.
 */
export interface PortalConsentResponse {
  readonly emailMarketing: boolean;
  /** ISO-8601 instant, as Shopify reports it. */
  readonly updatedAt: string;
}

/* ========================================================================== *
 * N10 / N11 — /v1/profile/birthday
 * ========================================================================== */

/**
 * Where the customer stands relative to their birthday reward window (§11.10).
 * Identifiers; §18.9 maps each to wording.
 */
export type PortalBirthdayEligibilityState =
  | "not_set"
  | "outside_window"
  | "eligible"
  | "already_granted_this_year";

/**
 * A stored birthday: month and day, and NO YEAR.
 *
 * The omission is the design decision, not an oversight (§11.1). A birth year is
 * age data the portal has no use for, so it is never collected — which means it
 * can never leak, never be inferred from, and never need erasing. Requirement
 * 11.10 also forbids a birth-year field in the UI; a DTO without the field makes
 * that impossible to breach by accident.
 */
export interface PortalBirthday {
  /** 1–12. */
  readonly month: number;
  /** 1–31, valid for the month. 29 February is accepted; 30 February is not. */
  readonly day: number;
}

/** `200` body of `GET` and `PUT /v1/profile/birthday` (N10, N11) — one shape for both. */
export interface PortalBirthdayResponse {
  /** `null` until the customer sets one. */
  readonly birthday: PortalBirthday | null;
  readonly eligibility: {
    readonly state: PortalBirthdayEligibilityState;
    /**
     * Europe/London calendar date (`YYYY-MM-DD`) the window opens, with the
     * 28 February substitution already applied in a non-leap year. `null` when
     * no birthday is set. Computed server-side: a client computing it would
     * need the timezone rule and the leap-year substitution, and two clients
     * would eventually disagree about when a customer's window opens.
     */
    readonly windowOpensOn: string | null;
    readonly windowDays: number;
  };
  /**
   * The 365-day change lock (§11.4). `allowedFrom` is `null` while a change IS
   * allowed — there is no future date to name.
   */
  readonly changeable: {
    readonly allowed: boolean;
    readonly allowedFrom: string | null;
  };
}

/**
 * Body of `PUT /v1/profile/birthday` (N11) — two integers, nothing else.
 *
 * The future mobile app posts exactly these two integers (§11.10), which is what
 * "the same endpoint serves both clients" means concretely (Req 21.1).
 */
export interface PortalBirthdayUpdateRequest {
  month: number;
  day: number;
}

/* ========================================================================== *
 * N12 / N13 — /v1/profile/preferences
 * ========================================================================== */

/**
 * The five declared-preference dimensions (§12.2). Closed: the set of dimensions
 * is a schema fact, fixed by a `CHECK` constraint and a primary key, so a
 * dimension outside this union has nowhere to be stored.
 */
export type PortalPreferenceDimension =
  | "scent_family"
  | "note"
  | "intensity"
  | "occasion"
  | "season";

/**
 * The values the server will accept per dimension.
 *
 * `string[]`, NOT closed unions, and deliberately so: §12.2 makes the
 * vocabularies server-owned precisely so they can grow WITHOUT A THEME DEPLOY —
 * the client renders the options the API supplies. Baking them into a union here
 * would put the vocabulary back in the theme bundle and defeat the reason it
 * lives on the server.
 */
export type PortalPreferenceVocabulary = {
  readonly [D in PortalPreferenceDimension]: readonly string[];
};

/**
 * What the customer has declared.
 *
 * `intensity` IS A SINGLE VALUE OR NULL while every other dimension is a set —
 * matching the cardinality table in §12.2 and the partial unique index that
 * enforces it in the database. The asymmetry is in the type because it is real:
 * "I like bold fragrances AND subtle fragrances" is not a preference, it is the
 * absence of one.
 */
export interface PortalDeclaredPreferences {
  readonly scent_family: readonly string[];
  readonly note: readonly string[];
  readonly intensity: string | null;
  readonly occasion: readonly string[];
  readonly season: readonly string[];
}

/**
 * Communication preferences (§12.8).
 *
 * MARKETING CONSENT IS NOT HERE, and must never be added. Consent is Shopify's
 * to store and is read and written through N9; a second copy in this block would
 * be two sources of truth for the one field where disagreement is a compliance
 * failure rather than a bug (§13.1, Req 3.2).
 *
 * `push_enabled` is likewise absent. It exists as a reserved column for the
 * future app (§14.2) but appears in no contract in §6.3 or §12.8, and inventing
 * a wire field for it now would be inventing a name the design does not specify.
 * It is additive when the app needs it (Req 20.6).
 */
export interface PortalCommunicationPreferences {
  readonly productLaunches: boolean;
  readonly restockAlerts: boolean;
  readonly birthdayMessages: boolean;
  readonly referralUpdates: boolean;
}

/**
 * Per-dimension caps, supplied by the server so the client can disable a control
 * at the limit instead of discovering the cap through a rejection.
 *
 * `intensity` HAS NO ENTRY, because it is single-valued rather than capped —
 * a cap of one and a cardinality of one are different statements, and §12.8's
 * `limits` block lists exactly these four keys. The VALUES live with the write
 * transaction that enforces them (task 13.1); duplicating them here would create
 * a second cap to keep in step.
 */
export interface PortalPreferenceLimits {
  readonly scent_family: number;
  readonly note: number;
  readonly occasion: number;
  readonly season: number;
}

/** `200` body of `GET /v1/profile/preferences` (N12). */
export interface PortalPreferencesResponse {
  readonly vocabulary: PortalPreferenceVocabulary;
  readonly declared: PortalDeclaredPreferences;
  readonly communication: PortalCommunicationPreferences;
  readonly limits: PortalPreferenceLimits;
}

/**
 * Body of `PUT /v1/profile/preferences` (N13) — ANY SUBSET of `declared` and
 * `communication` (§12.8).
 *
 * A partial body is the right shape because the two blocks are edited from
 * different places in the UI: sending a whole `declared` object to change one
 * toggle would make every save a chance to clobber a dimension the customer was
 * not editing. Within a dimension the write IS a set-replacement, applied inside
 * one transaction so a partial failure cannot half-apply (task 13.1).
 */
export interface PortalPreferencesUpdateRequest {
  declared?: Partial<{
    scent_family: string[];
    note: string[];
    intensity: string | null;
    occasion: string[];
    season: string[];
  }>;
  communication?: Partial<{
    productLaunches: boolean;
    restockAlerts: boolean;
    birthdayMessages: boolean;
    referralUpdates: boolean;
  }>;
}

/* ========================================================================== *
 * N14 — GET /v1/profile/export
 * ========================================================================== */

/**
 * `GET /v1/profile/export` (N14) returns a JSON document as an attachment.
 *
 * ITS SHAPE IS DELIBERATELY NOT TYPED HERE. The export is the union of nine
 * stores' worth of the customer's own records (§15.4), assembled by task 15.1,
 * and no client renders it — the browser saves it to disk. A type would be a
 * second, silently-drifting description of every other store's shape, which is
 * cost without a benefit: nothing would compile against it.
 *
 * The two facts that DO belong to the contract are the response headers, because
 * `Content-Disposition: attachment` is what makes the browser download rather
 * than navigate, and getting it wrong renders a customer's personal data into a
 * tab instead of a file.
 */
export const PORTAL_EXPORT_CONTENT_TYPE = "application/json";

/* ========================================================================== *
 * N15 — POST /v1/profile/erasure-request
 * ========================================================================== */

/**
 * `200` body of `POST /v1/profile/erasure-request` (N15).
 *
 * RECORDS INTENT; DELETES NOTHING. Erasure spans nine tables, is irreversible,
 * must be coordinated with Shopify's own erasure and requires unredeemed
 * discount codes to be voided — so it is operator-run and audited (§15.5). This
 * response is therefore an ACKNOWLEDGEMENT with a reference, and the client must
 * not imply instant deletion (task 26.3). A self-service button that
 * irreversibly deleted on click would be the wrong design for a right this
 * important.
 *
 * `reference` is a request handle for the customer to quote. It carries no
 * customer identifier — see rule 1 in this module's header.
 */
export interface PortalErasureRequestResponse {
  /** ISO-8601 instant the request was recorded. */
  readonly requestedAt: string;
  readonly reference: string;
}

/* ========================================================================== *
 * N16 — GET /v1/redemptions
 * ========================================================================== */

/**
 * A redemption's lifecycle status.
 *
 * Closed, and taken from the `redemptions.status` column's own comment
 * (`pending_code | issued | failed | voided`) rather than invented here — the
 * database is the authority on what statuses can exist, and this union is
 * checked against it by the migration's `CHECK`-free but documented vocabulary.
 */
export type PortalRedemptionStatus = "pending_code" | "issued" | "failed" | "voided";

/**
 * One redemption, as `GET /v1/redemptions` returns it (N16).
 *
 * NO `customerId`, unlike the internal `Redemption` row type in
 * `redemption/redeem.ts` — see rule 1 in this module's header. This is the
 * customer-facing projection of that row, not the row.
 *
 * `code` IS NULL IN TWO STATES, and both matter to the client: while `status` is
 * `pending_code` the code does not exist yet (the mint is asynchronous), and
 * after `voided` it exists but must not be shown. A null `code` therefore means
 * "no code to show", never "an error" — which is what lets the client present a
 * pending redemption as the confirmed state it is, rather than inventing a
 * failure (task 22.3).
 *
 * `rewardId` is `string`, not the closed `RewardId` union from
 * `rewards/catalog.ts`. That matches the shipped `Redemption.rewardId: string`
 * and the `TEXT` column, and it is correct rather than merely consistent: that
 * module records that the reward map is destined to become config-driven, so a
 * historical redemption may name a reward the current catalogue no longer lists.
 * A closed union would make a customer's own past redemption untypeable.
 */
export interface PortalRedemption {
  readonly id: string;
  readonly rewardId: string;
  readonly pointsSpent: number;
  readonly valueGBP: MoneyGBP;
  readonly status: PortalRedemptionStatus;
  /** `null` while `pending_code`, and after `voided`. */
  readonly code: string | null;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/**
 * `200` body of `GET /v1/redemptions` (N16), newest first, paged at
 * {@link PORTAL_REDEMPTIONS_PAGE_SIZE}.
 *
 * No `pageInfo`: §6.3 specifies this body as `{ redemptions }` and states the
 * page size without naming a paging mechanism. Adding a cursor field here would
 * be inventing contract the design does not specify; task 10.2 settles how the
 * client reaches page two, and whatever it chooses is additive (Req 20.6).
 */
export interface PortalRedemptionsResponse {
  readonly redemptions: readonly PortalRedemption[];
}

/** Redemptions returned per page (§6.3 N16). */
export const PORTAL_REDEMPTIONS_PAGE_SIZE = 20;

/* ========================================================================== *
 * Compile-time assertions
 * ========================================================================== */

/*
 * WHY THESE LIVE IN THIS FILE AND NOT IN `types.test.ts`.
 *
 * `tsconfig.json` EXCLUDES `src/**\/*.test.ts`, and vitest transpiles without
 * type-checking, so a type-level assertion written in a test file is checked by
 * nothing — it would look like a guarantee and be decoration. Declared here, in
 * a file `tsc -p tsconfig.json --noEmit` compiles, they are enforced by the same
 * command CI already runs.
 *
 * They emit no JavaScript: every declaration below is a type, so the built
 * bundle is byte-identical with or without this section.
 *
 * They encode the invariants that would otherwise be prose in a comment — the
 * ones whose breach is a security or correctness regression rather than a style
 * drift. A future edit that reintroduces `email` on the identity write, or a
 * `customerId` on any response, stops compiling.
 */

/** True iff `X` and `Y` are the same type — the standard invariant-position trick. */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

/** Compiles only when `T` is `true`. */
type Expect<T extends true> = T;

/** Every response body this module defines, as one union. */
type AllPortalResponses =
  | PortalOrdersResponse
  | PortalOrderSummary
  | PortalOrderDetail
  | PortalOrderLineItem
  | PortalOrderPreviewLineItem
  | PortalReorderPlanResponse
  | PortalCatalogResponse
  | PortalCatalogProduct
  | PortalWishlistSetResponse
  | PortalIdentityResponse
  | PortalAddressesResponse
  | PortalSavedAddress
  | PortalConsentResponse
  | PortalBirthdayResponse
  | PortalPreferencesResponse
  | PortalErasureRequestResponse
  | PortalRedemptionsResponse
  | PortalRedemption
  | PortalErrorBody;

/** Distributes over a union so ONE offending member is enough to fail the check. */
type HasKey<T, K extends string> = T extends unknown ? (K extends keyof T ? true : false) : never;

/**
 * RULE 1, ENFORCED. No portal response carries a customer identifier, so no
 * response can become a way for a client to nominate a customer. If any member
 * of {@link AllPortalResponses} gained a `customerId`, this resolves to
 * `boolean` and fails.
 */
type _NoCustomerIdOnAnyResponse = Expect<Equal<HasKey<AllPortalResponses, "customerId">, false>>;

/**
 * REQUIREMENT 5.8, ENFORCED BY THE CONTRACT. `email` is not writable through
 * N7 — not "is checked for and rejected", but has no field to arrive in.
 */
type _IdentityUpdateCannotCarryEmail = Expect<
  Equal<HasKey<PortalIdentityUpdateRequest, "email">, false>
>;

/** N8: neither the address id nor the default flag is client-supplied in a body. */
type _AddressInputCannotCarryId = Expect<Equal<HasKey<PortalAddressInput, "id">, false>>;
type _AddressInputCannotCarryDefault = Expect<
  Equal<HasKey<PortalAddressInput, "isDefault">, false>
>;

/** N6: `emailEditable` is the literal `false`, never a mutable `boolean`. */
type _EmailIsNeverEditable = Expect<Equal<PortalIdentityResponse["emailEditable"], false>>;

/**
 * THE CONSOLIDATION, ENFORCED. N5's wishlist field and the shipped reconcile
 * response's wishlist field are one type. Redeclaring either independently
 * breaks this.
 */
type _WishlistSetEchoesTheReconcileSet = Expect<
  Equal<PortalWishlistSetResponse["wishlist"], WishlistReconcileResponse["wishlist"]>
>;

/**
 * MONEY IS A DECIMAL STRING, ENFORCED at every field §6.3 names as GBP. A future
 * edit that types one of these as `number` — the representation the shipped
 * `/v1/balance` uses, and therefore the easy mistake to make — fails here.
 */
type _OrderTotalIsMoney = Expect<Equal<PortalOrderCore["totalGBP"], MoneyGBP>>;
type _OrderSubtotalIsMoney = Expect<Equal<PortalOrderDetail["subtotalGBP"], MoneyGBP>>;
type _OrderShippingIsMoney = Expect<Equal<PortalOrderDetail["shippingGBP"], MoneyGBP>>;
type _OrderTaxIsMoney = Expect<Equal<PortalOrderDetail["taxGBP"], MoneyGBP>>;
type _LineUnitPriceIsMoney = Expect<Equal<PortalOrderLineItem["originalUnitPriceGBP"], MoneyGBP>>;
type _LineDiscountedTotalIsMoney = Expect<
  Equal<PortalOrderLineItem["discountedTotalGBP"], MoneyGBP>
>;
type _CatalogPriceIsMoney = Expect<Equal<PortalCatalogProduct["priceGBP"], MoneyGBP>>;
type _CatalogCompareAtIsMoney = Expect<
  Equal<PortalCatalogProduct["compareAtPriceGBP"], MoneyGBP | null>
>;
type _RedemptionValueIsMoney = Expect<Equal<PortalRedemption["valueGBP"], MoneyGBP>>;
