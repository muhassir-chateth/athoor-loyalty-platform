import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeShopifyHmac, verifyShopifyHmac } from "./hmac.js";

const SECRET = "shpss_test_webhook_secret";

/** Sign a body exactly the way Shopify does: base64 HMAC-SHA256 over raw bytes. */
function sign(body: Buffer | string, secret = SECRET): string {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return crypto.createHmac("sha256", secret).update(raw).digest("base64");
}

describe("computeShopifyHmac", () => {
  it("produces a base64 SHA-256 digest over the raw bytes", () => {
    const raw = Buffer.from('{"id":123,"email":"a@b.com"}', "utf8");
    const digest = computeShopifyHmac(raw, SECRET);
    expect(digest).toBe(sign(raw));
    // base64 of a 32-byte SHA-256 digest is 44 chars.
    expect(digest).toHaveLength(44);
  });

  it("is sensitive to the raw bytes, not the parsed JSON shape", () => {
    // Same logical JSON, different byte serialization (key order / whitespace)
    // must yield different signatures — proving we sign raw bytes, not objects.
    const a = Buffer.from('{"a":1,"b":2}', "utf8");
    const b = Buffer.from('{"b":2,"a":1}', "utf8");
    expect(computeShopifyHmac(a, SECRET)).not.toBe(computeShopifyHmac(b, SECRET));
  });
});

describe("verifyShopifyHmac", () => {
  it("accepts a valid signature computed over the raw body", () => {
    const raw = Buffer.from('{"order_id":1001,"total":"49.00"}', "utf8");
    expect(verifyShopifyHmac(raw, sign(raw), SECRET)).toBe(true);
  });

  it("rejects a signature for a tampered body", () => {
    const original = Buffer.from('{"total":"49.00"}', "utf8");
    const signature = sign(original);
    const tampered = Buffer.from('{"total":"4900.00"}', "utf8");
    expect(verifyShopifyHmac(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const raw = Buffer.from('{"x":1}', "utf8");
    expect(verifyShopifyHmac(raw, sign(raw, "attacker_secret"), SECRET)).toBe(false);
  });

  it("rejects a syntactically invalid signature string", () => {
    const raw = Buffer.from('{"x":1}', "utf8");
    expect(verifyShopifyHmac(raw, "not-a-real-signature", SECRET)).toBe(false);
  });

  it("rejects a missing (undefined) header without throwing", () => {
    const raw = Buffer.from('{"x":1}', "utf8");
    expect(verifyShopifyHmac(raw, undefined, SECRET)).toBe(false);
  });

  it("rejects an empty header value", () => {
    const raw = Buffer.from('{"x":1}', "utf8");
    expect(verifyShopifyHmac(raw, "", SECRET)).toBe(false);
  });

  it("does not throw on a length-mismatched header (timingSafeEqual guard)", () => {
    const raw = Buffer.from('{"x":1}', "utf8");
    expect(() => verifyShopifyHmac(raw, "AAAA", SECRET)).not.toThrow();
    expect(verifyShopifyHmac(raw, "AAAA", SECRET)).toBe(false);
  });

  it("verifies an empty body when signed", () => {
    const raw = Buffer.alloc(0);
    expect(verifyShopifyHmac(raw, sign(raw), SECRET)).toBe(true);
  });
});
