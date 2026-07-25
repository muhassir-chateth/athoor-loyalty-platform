import crypto from "node:crypto";

/**
 * Shopify sends the webhook HMAC as a base64-encoded SHA-256 digest in this
 * header. Fastify normalises header names to lower-case.
 */
export const SHOPIFY_HMAC_HEADER = "x-shopify-hmac-sha256";

/**
 * Compute the Shopify webhook signature: an HMAC-SHA256 of the RAW request
 * body bytes, keyed by the webhook shared secret, encoded as base64.
 *
 * The digest MUST be computed over the exact bytes Shopify sent — never over a
 * re-serialized JSON object, whose key order / whitespace would differ and
 * break verification (Requirement 11.1, design: "Shopify Integration Contracts").
 */
export function computeShopifyHmac(rawBody: Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

/**
 * Verify an inbound Shopify webhook's HMAC-SHA256 signature over the raw body
 * using a constant-time comparison (Requirement 11.1).
 *
 * Returns `true` only when the header is present and its bytes exactly match
 * the computed digest. A missing header, a length mismatch, or any difference
 * returns `false` — the caller then rejects with HTTP 401 (Requirement 11.2).
 *
 * `crypto.timingSafeEqual` throws if the two buffers differ in length, so the
 * length is checked first (a length difference is itself a definitive
 * mismatch and leaks no timing information about the secret).
 */
export function verifyShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string | undefined,
  secret: string,
): boolean {
  if (!hmacHeader) {
    return false;
  }

  const expected = Buffer.from(computeShopifyHmac(rawBody, secret), "utf8");
  const provided = Buffer.from(hmacHeader, "utf8");

  if (expected.length !== provided.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, provided);
}
