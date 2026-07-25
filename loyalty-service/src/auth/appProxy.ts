import crypto from "node:crypto";

/**
 * App Proxy signature verification (task 6.2, Requirement 11.3/11.4).
 *
 * Shopify's App Proxy forwards a signed storefront/web request to this backend
 * and appends a `signature` query parameter: the hex HMAC-SHA256 of the
 * remaining query parameters, sorted by key and concatenated as `key=value`
 * with no separator, keyed by the app's shared secret (design.md → "App Proxy
 * (web dashboard, today)"). Only after this signature verifies may the service
 * trust the `logged_in_customer_id` Shopify injects (Requirement 11.3); a
 * failed verification means that value is ignored and the request rejected
 * (Requirement 11.4).
 *
 * SAFETY: this module performs pure, local crypto only — it makes no network
 * call and touches no live system.
 */

/** The query parameter carrying Shopify's App Proxy HMAC (hex-encoded). */
export const APP_PROXY_SIGNATURE_PARAM = "signature" as const;

/** A parsed query object as Fastify exposes it (values may repeat → arrays). */
export type QueryParams = Record<string, string | string[] | undefined>;

/** First value of a (possibly repeated) query parameter, or undefined. */
export function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Canonical string form of a query value for signing: a repeated parameter is
 * joined with `,` (Shopify's App Proxy convention); a scalar is used as-is; a
 * missing value contributes the empty string.
 */
function canonicalValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return value ?? "";
}

/**
 * Build the exact message Shopify signs: every query parameter EXCEPT
 * `signature`, sorted by key, rendered as `key=value` and concatenated with no
 * separator.
 */
function canonicalMessage(query: QueryParams): string {
  return Object.keys(query)
    .filter((key) => key !== APP_PROXY_SIGNATURE_PARAM)
    .sort()
    .map((key) => `${key}=${canonicalValue(query[key])}`)
    .join("");
}

/**
 * Compute the App Proxy signature for a set of query parameters. Exposed so the
 * verifier and tests derive the signature identically (a test signs the same
 * way production verifies), rather than duplicating the canonicalisation.
 */
export function computeAppProxySignature(query: QueryParams, secret: string): string {
  return crypto.createHmac("sha256", secret).update(canonicalMessage(query)).digest("hex");
}

/**
 * Verify Shopify's App Proxy signature over the request's query parameters
 * using a constant-time comparison (Requirement 11.3).
 *
 * Returns `true` only when a `signature` parameter is present and its bytes
 * exactly match the HMAC computed over the remaining parameters. A missing
 * signature, a length mismatch, or any difference returns `false`, and the
 * caller then rejects the request and ignores `logged_in_customer_id`
 * (Requirement 11.4).
 *
 * `crypto.timingSafeEqual` throws on a length mismatch, so length is checked
 * first (a length difference is itself a definitive mismatch and leaks no
 * timing information about the secret) — mirroring the webhook HMAC verifier.
 */
export function verifyAppProxySignature(query: QueryParams, secret: string): boolean {
  const provided = firstQueryValue(query[APP_PROXY_SIGNATURE_PARAM]);
  if (!provided) {
    return false;
  }

  const expected = Buffer.from(computeAppProxySignature(query, secret), "utf8");
  const providedBuf = Buffer.from(provided, "utf8");

  if (expected.length !== providedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, providedBuf);
}
