/**
 * The portal's view of the `/v1` wire contract — a pure re-export of the
 * canonical definitions in the service (spec task 7.1, design §16.7).
 *
 * WHY THIS FILE IS THE POINT OF THE BUILD STEP
 * --------------------------------------------
 * Design §16.7's strongest argument for compiling TypeScript into theme assets is
 * evidence, not taste: defects W1 and W2 were one defect twice, where the theme
 * posted `{ productIds }` and the server's schema accepted `{ deviceLocal }`, and
 * neither test suite could see the other side (design §8.1). Shared types across
 * the request boundary make that class of defect a compile error.
 *
 * "Shared" only counts if there is ONE definition. This module is therefore a
 * re-export and never a copy. A parallel declaration here would reproduce exactly
 * the failure it is meant to prevent — two private ideas of one contract, drifting
 * silently — which is why nothing below is redeclared.
 *
 * `loyalty-service/src/portal/types.ts` states the same arrangement from the other
 * end: it is deliberately NOT in `theme-src/` so that it stays inside the
 * service's `rootDir: "src"` and is checked by `tsc -p tsconfig.json` and
 * reachable from vitest. The theme imports from there; nothing is duplicated.
 *
 * WHY THIS COSTS ZERO BYTES
 * -------------------------
 * `export type { … }` is erased before emit, so esbuild never resolves the path
 * and never walks into the service's module graph — which matters, because that
 * graph reaches `zod` and `zod` must not appear in a theme asset. The relative
 * path crosses out of `theme-src/` at TYPE level only. Verified by the smoke
 * test, which asserts no bundle mentions `zod`.
 *
 * WHAT IS RE-EXPORTED, AND WHAT IS NOT
 * ------------------------------------
 * Types only. The canonical module also exports three numeric constants
 * (`PORTAL_ORDERS_MAX_PAGE_SIZE`, `PORTAL_CATALOG_MAX_IDS`,
 * `PORTAL_WISHLIST_MAX_ITEMS`), two regular expressions and the `isMoneyGBP`
 * guard — all VALUES. Re-exporting a value here would pull the service's runtime
 * graph into a theme asset, so a portal module that needs a bound imports it
 * where task 18.1 decides, with that decision reviewed on its merits.
 *
 * The DTO surface is re-exported whole rather than a chosen subset. A subset would
 * mean editing this file every time a section needs one more type, and a file that
 * must be edited to permit correct code eventually gets bypassed.
 */
export type {
  // Money.
  MoneyGBP,

  // Errors — the closed identifier set, field errors and the body shape (design E.2).
  PortalErrorCode,
  PortalFieldError,
  PortalErrorBody,

  // Shared primitives.
  PortalPageInfo,
  PortalImage,
  ShopifyStatusIdentifier,

  // N1/N2 — orders and order detail.
  PortalOrdersQuery,
  PortalOrderCore,
  PortalOrderPreviewLineItem,
  PortalOrderSummary,
  PortalOrdersResponse,
  PortalOrderLineItem,
  PortalAddress,
  PortalFulfilment,
  PortalOrderDetail,

  // N3 — the reorder plan.
  PortalReorderUnavailableReason,
  PortalReorderPlanRequest,
  PortalReorderAddableLine,
  PortalReorderUnavailableLine,
  PortalReorderPlanResponse,

  // N4 — the catalogue read.
  PortalCatalogQuery,
  PortalCatalogProduct,
  PortalCatalogResponse,

  // N5 — the wishlist as the single source of truth.
  PortalWishlistSetRequest,
  PortalWishlistSetResponse,

  // N6/N7/N8 — identity, addresses and consent.
  PortalIdentityResponse,
  PortalIdentityUpdateRequest,
  PortalSavedAddress,
  PortalAddressesResponse,
  PortalAddressInput,
  PortalConsentUpdateRequest,
  PortalConsentResponse,

  // N11 — the birthday.
  PortalBirthdayEligibilityState,
  PortalBirthday,
  PortalBirthdayResponse,
  PortalBirthdayUpdateRequest,

  // N12/N13 — fragrance and communication preferences.
  PortalPreferenceDimension,
  PortalPreferenceVocabulary,
  PortalDeclaredPreferences,
  PortalCommunicationPreferences,
  PortalPreferenceLimits,
  PortalPreferencesResponse,
  PortalPreferencesUpdateRequest,

  // N15 — the erasure request.
  PortalErasureRequestResponse,

  // N16 — redemptions.
  PortalRedemptionStatus,
  PortalRedemption,
  PortalRedemptionsResponse,
} from "../../../loyalty-service/src/portal/types.js";
