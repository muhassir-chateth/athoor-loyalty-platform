/**
 * Mapping Shopify `userErrors[]` onto a CLOSED code set (spec task 14.1,
 * design §13.4, Req 2.7, 5.4, 20.7, 20.8).
 *
 * ── SHOPIFY'S MESSAGE TEXT IS NEVER FORWARDED ───────────────────────────────
 * §5.5 forbids upstream text in a response body, and §13.4 says so directly:
 * "Shopify's own message text is never forwarded — it is upstream text". Three
 * reasons, and the third is the one that actually bites. It is written for
 * merchants, not customers. It is localised to the SHOP's language, not the
 * customer's. And it is not a contract: Shopify may reword it in any release, so a
 * client that parsed or displayed it would break silently and at a time of
 * Shopify's choosing.
 *
 * ── THE MAPPING IS FIELD-DRIVEN, NOT MESSAGE-DRIVEN ─────────────────────────
 * Introspection of the live `2024-10` schema (OQ-8) shows the error shape is NOT
 * uniform across the six mutations:
 *
 *   • `customerUpdate`, `customerAddress*` and `customerUpdateDefaultAddress`
 *     return the base `UserError`, which has `field` and `message` and NO `code`;
 *   • `customerEmailMarketingConsentUpdate` returns
 *     `CustomerEmailMarketingConsentUpdateUserError`, which DOES carry `code`
 *     (`INVALID`, `INCLUSION`, `INTERNAL_ERROR`, `MISSING_ARGUMENT`).
 *
 * So a mapping that relied on `code` would work for one mutation in six. Matching
 * on `message` was rejected outright: it is the localised, non-contractual string
 * above, and a guard keyed to English prose fails the moment the shop language
 * changes. `field` is the stable, machine-oriented part of the error — it names
 * the input path — so the mapping keys on `field`, uses `code` as a refinement
 * where Shopify supplies one, and falls back to `rejected`.
 *
 * ── AN UNMAPPED ERROR IS `rejected`, WHICH IS A REAL ANSWER ─────────────────
 * §13.4: "An unmapped `userError` becomes `code: "rejected"` and the client's
 * neutral wording." That is a deliberate closed set, not a gap. Adding a code per
 * Shopify validation rule would put this file in permanent pursuit of an API we do
 * not control, and every new code would be one the client had no copy for.
 *
 * SAFETY: pure functions. No I/O, no network, no clock, no randomness. Nothing
 * here can log — a log line carrying `message` would reintroduce upstream text
 * through the back door (Req 2.8).
 */

/**
 * The closed set of field codes a portal write may return (§13.4).
 *
 * Ordered as design §13.4 lists them, so the two can be compared by eye.
 */
export const PORTAL_WRITE_FIELD_CODES = [
  "invalid_phone",
  "invalid_postcode",
  "invalid_country",
  "required",
  "too_long",
  "rejected",
] as const;

export type PortalWriteFieldCode = (typeof PORTAL_WRITE_FIELD_CODES)[number];

/** One rejected field, as a CODE and a field name — never a sentence. */
export interface PortalWriteFieldError {
  /** The input field Shopify named, normalised; `null` when it named none. */
  readonly field: string | null;
  readonly code: PortalWriteFieldCode;
}

/** The subset of a Shopify `userError` this mapping reads. `message` is ignored. */
export interface ShopifyUserErrorLike {
  readonly field?: readonly string[] | null;
  readonly message?: string | null;
  readonly code?: string | null;
}

/**
 * Shopify field paths → our codes.
 *
 * Keys are the LAST segment of the `field` path lowercased, because Shopify
 * prefixes paths with the input argument — `["input", "phone"]` on
 * `customerUpdate` but `["address", "phone"]` on `customerAddressUpdate`. Keying
 * on the leaf makes one table serve every mutation instead of one table per
 * mutation drifting apart.
 */
const FIELD_LEAF_TO_CODE: Readonly<Record<string, PortalWriteFieldCode>> = Object.freeze({
  phone: "invalid_phone",
  zip: "invalid_postcode",
  postcode: "invalid_postcode",
  postalcode: "invalid_postcode",
  country: "invalid_country",
  countrycode: "invalid_country",
  countrycodev2: "invalid_country",
});

/**
 * Shopify `code` values → our codes, where Shopify supplies one.
 *
 * Deliberately small. Only values whose meaning is unambiguous across mutations
 * are mapped; anything else defers to the field table and then to `rejected`.
 * `INVALID` and `INCLUSION` are NOT here on purpose — they say "this value is
 * wrong" without saying how, so the field is the more informative signal and
 * mapping them centrally would override it.
 */
const SHOPIFY_CODE_TO_CODE: Readonly<Record<string, PortalWriteFieldCode>> = Object.freeze({
  MISSING_ARGUMENT: "required",
  PRESENCE: "required",
  BLANK: "required",
  TOO_LONG: "too_long",
  TOO_BIG: "too_long",
});

/** Normalises a Shopify `field` path to its leaf, lowercased and de-punctuated. */
function fieldLeaf(field: readonly string[] | null | undefined): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const last = field[field.length - 1];
  if (typeof last !== "string" || last.trim() === "") return null;
  return last.trim();
}

/**
 * Maps one Shopify `userError` to a field code.
 *
 * Precedence: Shopify's `code` when it is one we map, then the field leaf, then
 * `rejected`. `code` wins because "you did not supply this" is a stronger
 * statement than "something about phone is wrong" — a missing phone should read as
 * `required`, not `invalid_phone`.
 */
export function mapUserError(error: ShopifyUserErrorLike): PortalWriteFieldError {
  const leaf = fieldLeaf(error.field);
  const shopifyCode = typeof error.code === "string" ? error.code.toUpperCase() : null;

  const fromCode = shopifyCode === null ? undefined : SHOPIFY_CODE_TO_CODE[shopifyCode];
  if (fromCode !== undefined) return { field: leaf, code: fromCode };

  const fromField = leaf === null ? undefined : FIELD_LEAF_TO_CODE[leaf.toLowerCase()];
  if (fromField !== undefined) return { field: leaf, code: fromField };

  // The closed set's escape hatch, and the client's neutral wording (§13.4).
  return { field: leaf, code: "rejected" };
}

/**
 * Maps a whole `userErrors[]` array, preserving order and dropping nothing.
 *
 * Order is preserved because Shopify reports the fields in input order and a
 * client rendering field-level messages wants the same order the customer sees on
 * screen. Nothing is deduplicated: two errors on one field are two things to fix.
 */
export function mapUserErrors(
  errors: readonly ShopifyUserErrorLike[] | null | undefined,
): readonly PortalWriteFieldError[] {
  if (!Array.isArray(errors)) return [];
  return errors.map(mapUserError);
}

/**
 * Raised when Shopify refused a write on business-rule grounds.
 *
 * DISTINCT FROM AN UPSTREAM FAULT, and that distinction is the whole point. A
 * `userError` means Shopify was reached, understood the request and declined it —
 * so the customer can fix it and retry, which is a `400`. A transport failure
 * means we do not know whether anything happened, which is a `502` and a retry of
 * the same request. Collapsing the two (as `assertNoUserErrors` does, correctly,
 * for the internal discount path) would tell a customer with a bad postcode that
 * the service is unavailable.
 */
export class PortalWriteRejectedError extends Error {
  readonly code = "invalid_request" as const;
  readonly fields: readonly PortalWriteFieldError[];

  constructor(fields: readonly PortalWriteFieldError[]) {
    // No upstream text, and no field values — the message is a constant.
    super("Shopify refused the write.");
    this.name = "PortalWriteRejectedError";
    this.fields = fields.length > 0 ? fields : [{ field: null, code: "rejected" }];
  }
}

/**
 * Throws {@link PortalWriteRejectedError} if `userErrors` is non-empty.
 *
 * The one place a portal write decides that Shopify said no. Called after EVERY
 * allowlisted mutation, which is why `assertCustomerMutationDocument` requires the
 * `userErrors` selection: without it this function would be handed an empty array
 * for a write that had in fact been refused.
 */
export function assertNoPortalWriteErrors(
  errors: readonly ShopifyUserErrorLike[] | null | undefined,
): void {
  const mapped = mapUserErrors(errors);
  if (mapped.length > 0) {
    throw new PortalWriteRejectedError(mapped);
  }
}
