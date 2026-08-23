/**
 * Tests for the aggregate auth-chain stop-point counters.
 *
 * WHY THIS EXISTS. The counters are the mechanism by which a production 401 gets
 * attributed to a step WITHOUT dashboard log access. If they misclassify, the
 * conclusion drawn from them is wrong — and it will be drawn confidently,
 * because a number on /health looks authoritative. So each label is pinned to
 * the exact chain state that must produce it.
 *
 * The classification of `logged_in_customer_id=0` gets its own test because
 * getting it wrong is the single most consequential error available here: it
 * would report an anonymous browse as "Shopify supplied no identity" and send
 * the investigation after a Shopify platform bug that does not exist.
 */
import { describe, expect, it } from "vitest";
import {
  AUTH_STOP_POINTS,
  AuthChainCounters,
  classifyStopPoint,
  type AuthChainOutcomeFacts,
} from "./authChainCounters.js";

/** A chain that got nowhere; each test overrides only the fields it is about. */
function facts(over: Partial<AuthChainOutcomeFacts> = {}): AuthChainOutcomeFacts {
  return {
    path: "none",
    signatureVerified: false,
    loggedInCustomerIdPresent: false,
    loggedInCustomerIdAnonymous: false,
    existingCustomerFound: false,
    enrollmentAttempted: false,
    enrollmentSucceeded: false,
    outcome: "identity_resolution_failed",
    ...over,
  };
}

describe("classifyStopPoint names the step that decided the request", () => {
  it("no signature and no bearer token", () => {
    expect(classifyStopPoint(facts({ path: "none" }))).toBe("no_credentials_presented");
  });

  it("an App Proxy request with no configured secret", () => {
    expect(
      classifyStopPoint(facts({ path: "app_proxy", outcome: "app_proxy_verification_unavailable" })),
    ).toBe("app_proxy_verification_unavailable");
  });

  it("an App Proxy signature that did not verify", () => {
    expect(
      classifyStopPoint(facts({ path: "app_proxy", outcome: "app_proxy_signature_invalid" })),
    ).toBe("app_proxy_signature_invalid");
  });

  it("verified, but Shopify supplied NO logged_in_customer_id", () => {
    // Branch B of the production diagnosis.
    expect(
      classifyStopPoint(
        facts({ path: "app_proxy", signatureVerified: true, loggedInCustomerIdPresent: false }),
      ),
    ).toBe("verified_but_no_customer_id");
  });

  it("distinguishes anonymous id=0 from an absent id", () => {
    // `0` is PRESENT. Reporting it as absent would invent a Shopify platform
    // fault out of an ordinary not-logged-in page view.
    expect(
      classifyStopPoint(
        facts({
          path: "app_proxy",
          signatureVerified: true,
          loggedInCustomerIdPresent: true,
          loggedInCustomerIdAnonymous: true,
        }),
      ),
    ).toBe("verified_but_anonymous_customer_id");
  });

  it("identity supplied, no local row, fallback not wired", () => {
    // Branch A of the production diagnosis.
    expect(
      classifyStopPoint(
        facts({
          path: "app_proxy",
          signatureVerified: true,
          loggedInCustomerIdPresent: true,
          existingCustomerFound: false,
          enrollmentAttempted: false,
        }),
      ),
    ).toBe("no_local_row_fallback_not_wired");
  });

  it("identity supplied, no local row, fallback ran and failed", () => {
    expect(
      classifyStopPoint(
        facts({
          path: "app_proxy",
          signatureVerified: true,
          loggedInCustomerIdPresent: true,
          enrollmentAttempted: true,
          enrollmentSucceeded: false,
        }),
      ),
    ).toBe("no_local_row_enrollment_failed");
  });

  it("a rejected bearer token", () => {
    expect(
      classifyStopPoint(facts({ path: "bearer_token", loggedInCustomerIdPresent: false })),
    ).toBe("bearer_token_rejected");
  });

  it("resolved against an existing row", () => {
    expect(
      classifyStopPoint(
        facts({
          path: "app_proxy",
          signatureVerified: true,
          loggedInCustomerIdPresent: true,
          existingCustomerFound: true,
          outcome: "resolved",
        }),
      ),
    ).toBe("resolved_existing_row");
  });

  it("resolved by the lazy fallback creating the row", () => {
    expect(
      classifyStopPoint(
        facts({
          path: "app_proxy",
          signatureVerified: true,
          loggedInCustomerIdPresent: true,
          enrollmentAttempted: true,
          enrollmentSucceeded: true,
          outcome: "resolved",
        }),
      ),
    ).toBe("resolved_via_enrollment");
  });
});

describe("the tally is readable and leaks nothing", () => {
  it("counts per stop point and totals every classified request", () => {
    const counters = new AuthChainCounters(() => new Date("2026-08-23T12:00:00.000Z"));

    counters.record(facts({ path: "app_proxy", signatureVerified: true }));
    counters.record(facts({ path: "app_proxy", signatureVerified: true }));
    counters.record(facts({ path: "none" }));

    const snap = counters.snapshot();
    expect(snap.since).toBe("2026-08-23T12:00:00.000Z");
    expect(snap.gatedRequests).toBe(3);
    expect(snap.stopPoints).toEqual({
      no_credentials_presented: 1,
      verified_but_no_customer_id: 2,
    });
  });

  it("omits zero counts so the common case stays short", () => {
    const counters = new AuthChainCounters();
    counters.record(facts({ path: "none" }));

    const snap = counters.snapshot();
    expect(Object.keys(snap.stopPoints)).toEqual(["no_credentials_presented"]);
  });

  it("starts empty rather than fabricating a baseline", () => {
    const snap = new AuthChainCounters().snapshot();
    expect(snap.gatedRequests).toBe(0);
    expect(snap.stopPoints).toEqual({});
  });

  it("emits stop points in chain order, so the snapshot reads as a funnel", () => {
    const counters = new AuthChainCounters();
    // Recorded deliberately out of order.
    counters.record(
      facts({
        path: "app_proxy",
        signatureVerified: true,
        loggedInCustomerIdPresent: true,
        existingCustomerFound: true,
        outcome: "resolved",
      }),
    );
    counters.record(facts({ path: "none" }));

    expect(Object.keys(counters.snapshot().stopPoints)).toEqual([
      "no_credentials_presented",
      "resolved_existing_row",
    ]);
  });

  it("retains no identifier, even when the trace carried one", () => {
    const counters = new AuthChainCounters();
    // A REAL trace also carries `route` and `maskedCustomerSuffix`. The narrow
    // input type is what keeps them out; this proves the extra fields cannot
    // survive into the snapshot even when a caller passes them.
    counters.record({
      ...facts({ path: "app_proxy", signatureVerified: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ route: "/v1/balance", maskedCustomerSuffix: "…6563" } as any),
    });

    const serialised = JSON.stringify(counters.snapshot());
    expect(serialised).not.toContain("6563");
    expect(serialised).not.toContain("/v1/balance");
    expect(serialised).not.toContain("maskedCustomerSuffix");
    // Only labels from the declared closed set may appear.
    for (const key of Object.keys(counters.snapshot().stopPoints)) {
      expect(AUTH_STOP_POINTS).toContain(key);
    }
  });
});
