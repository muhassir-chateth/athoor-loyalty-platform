/**
 * HTTP-boundary tests for lazy enrollment: the two guarantees that are
 * properties of the request path rather than of the enrollment service, and so
 * can only be proved through a real Fastify instance.
 *
 *   Scenario 8 — an UNVERIFIED App Proxy request cannot enrol. Nothing that
 *     fails signature verification, lacks a signature, arrives with no
 *     configured secret, or carries the anonymous `logged_in_customer_id=0` may
 *     create any loyalty state.
 *   Scenario 9 — a browser-supplied FOREIGN customer id cannot enrol or act on
 *     another customer. A request validly signed for customer A that also
 *     carries B's id in the body, in an unsigned query parameter, in a header, or
 *     as an email must resolve to A and leave B non-existent.
 *
 * The enroller here is a RECORDING FAKE, not the real service: what matters at
 * this layer is precisely WHICH identity — if any — reaches enrollment. The
 * service's own behaviour is covered in `ensureCustomerEnrollment.test.ts`.
 *
 * No live Shopify endpoint and no live database are touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../plugins/auth.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { InMemoryCustomerResolver } from "../auth/identity.js";
import type { VerifiedCustomerEnroller } from "./ensureCustomerEnrollment.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";

/** The victim: a real, logged-in customer who has no local row yet. */
const CUSTOMER_A_SHOPIFY_ID = "4995";
/** The customer an attacker would like to reach. */
const CUSTOMER_B_SHOPIFY_ID = "8888888";

/**
 * Records every id handed to enrollment and mints a local id for it.
 *
 * Its signature is the point: one already-verified id string, no request. There
 * is no parameter through which a body field, query parameter, header, or email
 * could arrive, so the assertions below are checking a structural property.
 */
class RecordingEnroller implements VerifiedCustomerEnroller {
  readonly enrolled: string[] = [];

  async enrollVerifiedCustomer(verifiedShopifyCustomerId: string): Promise<string | null> {
    this.enrolled.push(verifiedShopifyCustomerId);
    return `local-for-${verifiedShopifyCustomerId}`;
  }
}

interface TestHarness {
  app: FastifyInstance;
  enroller: RecordingEnroller;
  getSecureHits: () => number;
}

/**
 * Builds an app whose GET/POST /secure is a protected customer endpoint echoing
 * the resolved AuthCtx. The resolver is EMPTY — nobody has a local row — which
 * is exactly the production state that makes lazy enrollment the only way any
 * request can succeed.
 */
function buildHarness(opts: { withSecret?: boolean; withEnroller?: boolean } = {}): TestHarness {
  const app = Fastify({ logger: false });
  const enroller = new RecordingEnroller();
  let secureHits = 0;

  app.register(async (scope) => {
    registerAuth(scope, {
      resolver: new InMemoryCustomerResolver(),
      appProxySecret: opts.withSecret === false ? undefined : APP_PROXY_SECRET,
      lazyEnroller: opts.withEnroller === false ? undefined : enroller,
      publicRoutes: ["/public"],
    });

    scope.get("/secure", async (req) => {
      secureHits += 1;
      return { authCtx: req.authCtx };
    });

    scope.post("/secure", async (req) => {
      secureHits += 1;
      return { authCtx: req.authCtx };
    });
  });

  return { app, enroller, getSecureHits: () => secureHits };
}

/** Builds the query string for a VALIDLY signed App Proxy request. */
function signedQuery(params: QueryParams): string {
  // NB-13: every App Proxy request Shopify signs carries a `timestamp`, and the
  // auth layer now enforces a +/-5 minute freshness window and FAILS CLOSED when it
  // is absent. Defaulting it here keeps fixtures realistic; an explicit timestamp in
  // `params` still wins, so a staleness test can override it.
  const withTimestamp = { timestamp: String(Math.floor(Date.now() / 1000)), ...params };
  const withSignature = { ...withTimestamp, signature: computeAppProxySignature(withTimestamp, APP_PROXY_SECRET),
  };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withSignature)) {
    if (typeof value === "string") {
      search.set(key, value);
    }
  }
  return search.toString();
}

describe("scenario 8: an unverified App Proxy request cannot enrol", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = buildHarness();
    await harness.app.ready();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("rejects a TAMPERED signature and enrols nobody", async () => {
    // Sign for A, then swap in B's id: the signature no longer matches.
    const qs = signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: CUSTOMER_A_SHOPIFY_ID,
    });
    const tampered = qs.replace(
      `logged_in_customer_id=${CUSTOMER_A_SHOPIFY_ID}`,
      `logged_in_customer_id=${CUSTOMER_B_SHOPIFY_ID}`,
    );

    const res = await harness.app.inject({ method: "GET", url: `/secure?${tampered}` });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_signature_invalid" });
    // Nothing was enrolled and no handler ran, so no state changed.
    expect(harness.enroller.enrolled).toEqual([]);
    expect(harness.getSecureHits()).toBe(0);
  });

  it("rejects a MISSING signature and enrols nobody", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/secure?logged_in_customer_id=${CUSTOMER_A_SHOPIFY_ID}`,
    });

    expect(res.statusCode).toBe(401);
    expect(harness.enroller.enrolled).toEqual([]);
    expect(harness.getSecureHits()).toBe(0);
  });

  it("rejects a FORGED signature computed under the wrong secret", async () => {
    const params = { shop: "athoor", logged_in_customer_id: CUSTOMER_A_SHOPIFY_ID };
    const forged = computeAppProxySignature(params, "attacker-guessed-secret");
    const search = new URLSearchParams({ ...params, signature: forged });

    const res = await harness.app.inject({ method: "GET", url: `/secure?${search.toString()}` });

    expect(res.statusCode).toBe(401);
    expect(harness.enroller.enrolled).toEqual([]);
  });

  it("does not enrol an ANONYMOUS session, even on a validly signed request", async () => {
    // Shopify sends logged_in_customer_id=0 when nobody is logged in. A verified
    // envelope is not a verified customer, so enrollment must not be reached.
    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: "0" });

    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    expect(harness.enroller.enrolled).toEqual([]);
  });

  it("does not enrol when Shopify supplied NO logged_in_customer_id", async () => {
    const qs = signedQuery({ shop: "athoor", path_prefix: "/apps/loyalty" });

    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(401);
    expect(harness.enroller.enrolled).toEqual([]);
  });

  it("does not enrol when the request carries no proxy signature and no token at all", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/secure" });

    expect(res.statusCode).toBe(401);
    expect(harness.enroller.enrolled).toEqual([]);
  });

  it("does not enrol when verification is IMPOSSIBLE because no secret is configured", async () => {
    const unverifiable = buildHarness({ withSecret: false });
    await unverifiable.app.ready();
    try {
      // Signed with the real secret, but the service cannot check it → fail closed.
      const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A_SHOPIFY_ID });
      const res = await unverifiable.app.inject({ method: "GET", url: `/secure?${qs}` });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "app_proxy_verification_unavailable" });
      expect(unverifiable.enroller.enrolled).toEqual([]);
    } finally {
      await unverifiable.app.close();
    }
  });

  it("enrols ONLY on a fully verified request carrying a real logged-in customer", async () => {
    // The positive control: this is the one shape that may enrol, and it proves
    // the rejections above are not just a broken wiring that never enrols at all.
    const qs = signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: CUSTOMER_A_SHOPIFY_ID,
      path_prefix: "/apps/loyalty",
    });

    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authCtx: {
        customerId: `local-for-${CUSTOMER_A_SHOPIFY_ID}`,
        source: "app_proxy",
        channel: "web",
      },
    });
    expect(harness.enroller.enrolled).toEqual([CUSTOMER_A_SHOPIFY_ID]);
  });

  it("keeps 401ing when no enroller is wired, which is the default", async () => {
    const noEnroller = buildHarness({ withEnroller: false });
    await noEnroller.app.ready();
    try {
      const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A_SHOPIFY_ID });
      const res = await noEnroller.app.inject({ method: "GET", url: `/secure?${qs}` });

      // Unchanged behaviour: without the fallback wired, a missing local row is
      // still an unresolvable identity.
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    } finally {
      await noEnroller.app.close();
    }
  });
});

describe("scenario 9: a browser-supplied foreign customer id cannot enrol or act on another customer", () => {
  let harness: TestHarness;

  /** A request validly signed for customer A — the only trustworthy identity. */
  function signedForCustomerA(extraSignedParams: QueryParams = {}): string {
    return signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: CUSTOMER_A_SHOPIFY_ID,
      ...extraSignedParams,
    });
  }

  beforeEach(async () => {
    harness = buildHarness();
    await harness.app.ready();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("ignores a foreign customer id in the request BODY", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: `/secure?${signedForCustomerA()}`,
      payload: {
        customerId: CUSTOMER_B_SHOPIFY_ID,
        shopifyCustomerId: CUSTOMER_B_SHOPIFY_ID,
        logged_in_customer_id: CUSTOMER_B_SHOPIFY_ID,
        email: "victim@example.com",
      },
    });

    expect(res.statusCode).toBe(200);
    // Acts as A, not B.
    expect(res.json()).toMatchObject({
      authCtx: { customerId: `local-for-${CUSTOMER_A_SHOPIFY_ID}` },
    });
    // B never reached enrollment, so B has no loyalty state to act on.
    expect(harness.enroller.enrolled).toEqual([CUSTOMER_A_SHOPIFY_ID]);
    expect(harness.enroller.enrolled).not.toContain(CUSTOMER_B_SHOPIFY_ID);
  });

  it("REJECTS a request with a foreign customer id appended as an unsigned query parameter", async () => {
    // Stronger than "ignored": Shopify's signature covers EVERY query parameter,
    // so appending one to a signed URL breaks the canonical message and the whole
    // request is refused. A foreign id cannot even be smuggled in as inert data.
    const res = await harness.app.inject({
      method: "GET",
      url: `/secure?${signedForCustomerA()}&customer_id=${CUSTOMER_B_SHOPIFY_ID}&shopify_customer_id=${CUSTOMER_B_SHOPIFY_ID}`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_signature_invalid" });
    expect(harness.enroller.enrolled).toEqual([]);
    expect(harness.getSecureHits()).toBe(0);
  });

  it("ignores foreign customer ids in browser-set HEADERS", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/secure?${signedForCustomerA()}`,
      headers: {
        "x-customer-id": CUSTOMER_B_SHOPIFY_ID,
        "x-shopify-customer-id": CUSTOMER_B_SHOPIFY_ID,
        "x-logged-in-customer-id": CUSTOMER_B_SHOPIFY_ID,
        "x-customer-email": "victim@example.com",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authCtx: { customerId: `local-for-${CUSTOMER_A_SHOPIFY_ID}` },
    });
    expect(harness.enroller.enrolled).toEqual([CUSTOMER_A_SHOPIFY_ID]);
  });

  it("rejects a SECOND logged_in_customer_id appended after signing", async () => {
    // Appending a repeated parameter changes the canonical message, so the
    // signature no longer verifies and the whole request is refused.
    const res = await harness.app.inject({
      method: "GET",
      url: `/secure?${signedForCustomerA()}&logged_in_customer_id=${CUSTOMER_B_SHOPIFY_ID}`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_signature_invalid" });
    expect(harness.enroller.enrolled).toEqual([]);
  });

  it("cannot be tricked by signing a request that names B in a decorative parameter", async () => {
    // Even a VALIDLY signed request can only ever authenticate the id Shopify put
    // in logged_in_customer_id; any other parameter is data, never identity.
    const res = await harness.app.inject({
      method: "GET",
      url: `/secure?${signedForCustomerA({ customer_id: CUSTOMER_B_SHOPIFY_ID })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authCtx: { customerId: `local-for-${CUSTOMER_A_SHOPIFY_ID}` },
    });
    expect(harness.enroller.enrolled).toEqual([CUSTOMER_A_SHOPIFY_ID]);
  });

  it("enrols exactly one identity per verified request, never a second one", async () => {
    // Body and headers are outside the signed message, so this request IS valid —
    // and still only ever enrols the one identity Shopify vouched for.
    const res = await harness.app.inject({
      method: "POST",
      url: `/secure?${signedForCustomerA()}`,
      payload: { customerId: CUSTOMER_B_SHOPIFY_ID, email: "victim@example.com" },
      headers: { "x-customer-id": CUSTOMER_B_SHOPIFY_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(harness.enroller.enrolled).toHaveLength(1);
    expect(harness.enroller.enrolled[0]).toBe(CUSTOMER_A_SHOPIFY_ID);
  });
});
