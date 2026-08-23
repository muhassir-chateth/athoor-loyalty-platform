/**
 * Tests for boot-time wiring conditions.
 *
 * WHY THIS EXISTS. `index.ts` cannot be unit tested — it needs a live Postgres,
 * pg-boss and Shopify — so a wrong CONDITION there is invisible to the suite.
 * One was: the lazy-enrollment gate was constructed inside
 * `if (adminApiToken)`, which made `ENROLLMENT_LAZY_FALLBACK_ENABLED=true`
 * silently inert whenever no Admin token was configured. The flag parsed, the
 * config reported it enabled, and no enroller existed — and the resulting
 * symptom (a verified customer still receiving 401) is identical to the bug the
 * flag was added to fix, so the fix looked like it had failed.
 *
 * These tests pin the invariant that the condition depends on the enrollment
 * flag and on nothing else.
 */
import { describe, expect, it } from "vitest";
import { shouldWireLazyEnrollment } from "./bootWiring.js";
import { loadConfig } from "./config.js";

/** A minimal valid environment; each test varies only what it is about. */
function configWith(over: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "development",
    SHOPIFY_SHOP_DOMAIN: "myathoorlondon.myshopify.com",
    ...over,
  } as NodeJS.ProcessEnv);
}

describe("shouldWireLazyEnrollment", () => {
  it("is false by default, so merging the fallback changes nothing at runtime", () => {
    expect(shouldWireLazyEnrollment(configWith())).toBe(false);
  });

  it("is true when the flag is set", () => {
    expect(
      shouldWireLazyEnrollment(configWith({ ENROLLMENT_LAZY_FALLBACK_ENABLED: "true" })),
    ).toBe(true);
  });

  it("is TRUE WITH NO ADMIN TOKEN — the defect this function exists to prevent", () => {
    // THE REGRESSION TEST. Lazy enrollment needs a ledger repository and a
    // transactor; it makes no Shopify Admin call. Gating it on an Admin token
    // made the flag a no-op on any boot without one.
    const config = configWith({ ENROLLMENT_LAZY_FALLBACK_ENABLED: "true" });
    expect(config.shopify.adminApiToken).toBeUndefined();
    expect(shouldWireLazyEnrollment(config)).toBe(true);
  });

  it("is unaffected by the Admin token in either direction", () => {
    const withToken = configWith({
      ENROLLMENT_LAZY_FALLBACK_ENABLED: "true",
      SHOPIFY_ADMIN_API_TOKEN: "placeholder-admin-token-value",
    });
    const withoutToken = configWith({ ENROLLMENT_LAZY_FALLBACK_ENABLED: "true" });
    expect(shouldWireLazyEnrollment(withToken)).toBe(shouldWireLazyEnrollment(withoutToken));

    const offWithToken = configWith({
      SHOPIFY_ADMIN_API_TOKEN: "placeholder-admin-token-value",
    });
    expect(shouldWireLazyEnrollment(offWithToken)).toBe(false);
  });

  it("tolerates surrounding whitespace, which a dashboard paste hides", () => {
    // A trailing space in a hosting dashboard is invisible and survives the
    // save. Treating `"true "` as false makes a correctly-set flag look like the
    // bug it was set to fix.
    for (const value of ["true ", " true", "  TRUE  ", "\ttrue\n", " 1 ", " on "]) {
      expect(
        shouldWireLazyEnrollment(configWith({ ENROLLMENT_LAZY_FALLBACK_ENABLED: value })),
        `expected ${JSON.stringify(value)} to enable the fallback`,
      ).toBe(true);
    }
    // Whitespace-only stays false: it expresses no intent, so fail closed.
    for (const value of ["   ", "\t"]) {
      expect(
        shouldWireLazyEnrollment(configWith({ ENROLLMENT_LAZY_FALLBACK_ENABLED: value })),
        `expected ${JSON.stringify(value)} to leave the fallback off`,
      ).toBe(false);
    }
  });

  it("accepts the documented truthy spellings an operator might type", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      expect(
        shouldWireLazyEnrollment(configWith({ ENROLLMENT_LAZY_FALLBACK_ENABLED: value })),
        `expected ${value} to enable the fallback`,
      ).toBe(true);
    }
    for (const value of ["false", "0", "no", "off", ""]) {
      expect(
        shouldWireLazyEnrollment(configWith({ ENROLLMENT_LAZY_FALLBACK_ENABLED: value })),
        `expected ${value} to leave the fallback off`,
      ).toBe(false);
    }
  });
});
