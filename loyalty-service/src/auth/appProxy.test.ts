/**
 * Unit tests for App Proxy signature verification (task 6.2, Req 11.3/11.4).
 *
 * The verifier and the test both derive the signature via
 * {@link computeAppProxySignature}, so a valid signature is produced exactly as
 * production computes it — no hand-rolled digest that could drift from the
 * implementation.
 */
import { describe, expect, it } from "vitest";
import {
  computeAppProxySignature,
  verifyAppProxySignature,
  type QueryParams,
} from "./appProxy.js";

const SECRET = "app-proxy-shared-secret";

/** Sign a param set and return the full query (params + valid signature). */
function signed(params: QueryParams): QueryParams {
  return { ...params, signature: computeAppProxySignature(params, SECRET) };
}

describe("verifyAppProxySignature (Req 11.3/11.4)", () => {
  it("accepts a correctly signed set of query params", () => {
    const query = signed({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: "123456789",
      path_prefix: "/apps/loyalty",
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    expect(verifyAppProxySignature(query, SECRET)).toBe(true);
  });

  it("is order-independent: params sorted by key before signing", () => {
    // Same params, declared in a different insertion order, verify the same.
    const a = signed({ b: "2", a: "1", c: "3" });
    const reordered: QueryParams = { c: a.c, a: a.a, b: a.b, signature: a.signature };
    expect(verifyAppProxySignature(reordered, SECRET)).toBe(true);
  });

  it("rejects when a signed param is tampered with", () => {
    const query = signed({ logged_in_customer_id: "123456789", shop: "athoor" });
    // Attacker swaps in a different customer id but keeps the old signature.
    const tampered: QueryParams = { ...query, logged_in_customer_id: "999999999" };
    expect(verifyAppProxySignature(tampered, SECRET)).toBe(false);
  });

  it("rejects when the signature itself is altered (same length)", () => {
    const query = signed({ logged_in_customer_id: "123456789" });
    const sig = query.signature as string;
    // Flip the first hex char to a different value, preserving length.
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(verifyAppProxySignature({ ...query, signature: flipped }, SECRET)).toBe(false);
  });

  it("rejects when the signature is missing entirely", () => {
    expect(verifyAppProxySignature({ logged_in_customer_id: "123456789" }, SECRET)).toBe(false);
  });

  it("rejects a signature of a different length (no timingSafeEqual throw)", () => {
    const query = signed({ logged_in_customer_id: "123456789" });
    expect(verifyAppProxySignature({ ...query, signature: "deadbeef" }, SECRET)).toBe(false);
  });

  it("rejects when signed with a different secret", () => {
    const query: QueryParams = {
      logged_in_customer_id: "123456789",
      signature: computeAppProxySignature({ logged_in_customer_id: "123456789" }, "other-secret"),
    };
    expect(verifyAppProxySignature(query, SECRET)).toBe(false);
  });
});
