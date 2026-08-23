/**
 * Tests for the identity-resolution CHAIN diagnostic.
 *
 * WHY THIS EXISTS. `identity_resolution_failed` is returned for several
 * genuinely different situations: Shopify supplied no `logged_in_customer_id`,
 * the customer has no local row, the fallback is disabled, or the fallback ran
 * and failed. From outside they are one indistinguishable 401. A production 401
 * could therefore not be attributed to a step, and diagnosis stalled on that
 * ambiguity rather than on a hard problem.
 *
 * These tests prove the trace reports the RIGHT step for each cause, and — just
 * as importantly — that it leaks nothing. Instrumentation that is shipped
 * unverified is how a log becomes the thing that leaks.
 *
 * No live Shopify endpoint and no live database: a real Fastify instance, the
 * real signing helper, and in-memory fakes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { InMemoryCustomerResolver } from "../auth/identity.js";
import type { VerifiedCustomerEnroller } from "../enrollment/ensureCustomerEnrollment.js";

const SECRET = "app-proxy-shared-secret";
const CUSTOMER_A = "9395357876563"; // shape of the real Branch B customer

/**
 * An opaque, high-entropy cookie value used to prove the trace never copies
 * cookie material into a log line.
 *
 * DELIBERATELY NOT shaped like a real provider credential — it carries no
 * vendor token prefix. Secret scanners match the SHAPE, not the value, so a
 * fake Shopify token is blocked by push protection exactly as a real one would
 * be; this commit was rejected on a first attempt for precisely that reason.
 * Do not "improve" this fixture back into a vendor-prefixed form: the assertion
 * only needs a value long and unique enough that its presence in a log line
 * would be unambiguous.
 */
const SECRET_LOOKING_VALUE = "fake-not-a-real-token-8f2c1d4b9e0a7c635d18";

/** Captures every log line the auth hook emits, with its bindings. */
interface Captured {
  level: "debug" | "info" | "warn";
  obj: Record<string, unknown>;
  msg: string;
}

function buildHarness(opts: {
  enroller?: VerifiedCustomerEnroller;
  knownCustomers?: Record<string, string>;
  withSecret?: boolean;
}) {
  const logs: Captured[] = [];
  const app: FastifyInstance = Fastify({ logger: false });

  // Fastify's `req.log` is derived from the instance logger; replace the three
  // levels the hook uses so the emitted object can be inspected directly.
  const record = (level: Captured["level"]) => (obj: unknown, msg?: unknown) => {
    logs.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: String(msg ?? "") });
  };

  app.addHook("onRequest", async (req) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).log = { debug: record("debug"), info: record("info"), warn: record("warn") };
  });

  app.register(async (scope) => {
    registerAuth(scope, {
      resolver: new InMemoryCustomerResolver(opts.knownCustomers ?? {}),
      appProxySecret: opts.withSecret === false ? undefined : SECRET,
      lazyEnroller: opts.enroller,
      publicRoutes: ["/public"],
    });
    scope.get("/secure", async (req) => ({ authCtx: req.authCtx }));
    // Must actually EXIST, or Fastify 404s and its own error logging lands in
    // the capture buffer as a bare string rather than an object.
    scope.get("/public", async () => ({ ok: true }));
  });

  return { app, logs };
}

/** Only object-shaped log lines can carry a chain; Fastify logs plain strings too. */
function chainLines(logs: Captured[]): Captured[] {
  return logs.filter((l) => typeof l.obj === "object" && l.obj !== null && "authChain" in l.obj);
}

function signedQuery(params: QueryParams): string {
  const withSignature = { ...params, signature: computeAppProxySignature(params, SECRET) };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(withSignature)) {
    if (typeof v === "string") search.set(k, v);
  }
  return search.toString();
}

/** Pulls the single authChain object out of the captured logs. */
function chainOf(logs: Captured[]): Record<string, unknown> {
  const line = chainLines(logs)[0];
  expect(line, "no authChain line was logged").toBeDefined();
  return line!.obj.authChain as Record<string, unknown>;
}

let harness: ReturnType<typeof buildHarness>;
afterEach(async () => {
  await harness?.app.close();
});

describe("the chain identifies WHERE the request stopped", () => {
  it("signature verified, but Shopify supplied NO logged_in_customer_id", async () => {
    // The condition the production 401 was suspected to be: a verified envelope
    // carrying no identity. Documented behaviour with new customer accounts.
    harness = buildHarness({ enroller: { async enrollVerifiedCustomer() { return "local-1"; } } });
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", path_prefix: "/apps/loyalty" });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(401);
    expect(chainOf(harness.logs)).toMatchObject({
      path: "app_proxy",
      signatureVerified: true,
      loggedInCustomerIdPresent: false,
      loggedInCustomerIdAnonymous: false,
      maskedCustomerSuffix: null,
      // Enrollment must NOT have been reached: there is no verified identity to
      // enroll, and inventing one is exactly what must never happen.
      enrollmentAttempted: false,
      outcome: "identity_resolution_failed",
    });
  });

  it("distinguishes the ANONYMOUS id=0 case from an absent one", async () => {
    harness = buildHarness({});
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: "0" });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(401);
    expect(chainOf(harness.logs)).toMatchObject({
      signatureVerified: true,
      loggedInCustomerIdPresent: true,
      loggedInCustomerIdAnonymous: true,
      enrollmentAttempted: false,
    });
  });

  it("identity present, no local row, fallback NOT wired -> stops at the fallback", async () => {
    // Branch B with the flag off: exactly the state production was in.
    harness = buildHarness({});
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(401);
    expect(chainOf(harness.logs)).toMatchObject({
      signatureVerified: true,
      loggedInCustomerIdPresent: true,
      maskedCustomerSuffix: "…6563",
      existingCustomerFound: false,
      lazyFallbackWired: false,
      enrollmentAttempted: false,
      outcome: "identity_resolution_failed",
    });
  });

  it("identity present, no local row, fallback WIRED -> enrollment attempted and succeeds", async () => {
    harness = buildHarness({
      enroller: { async enrollVerifiedCustomer() { return "local-new"; } },
    });
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(200);
    expect(chainOf(harness.logs)).toMatchObject({
      existingCustomerFound: false,
      lazyFallbackWired: true,
      enrollmentAttempted: true,
      enrollmentSucceeded: true,
      outcome: "resolved",
    });
  });

  it("enrollment wired but FAILING -> attempted, not succeeded, still a 401", async () => {
    harness = buildHarness({
      enroller: { async enrollVerifiedCustomer() { return null; } },
    });
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(401);
    expect(chainOf(harness.logs)).toMatchObject({
      enrollmentAttempted: true,
      enrollmentSucceeded: false,
      outcome: "identity_resolution_failed",
    });
  });

  it("an already-enrolled customer resolves without attempting enrollment", async () => {
    harness = buildHarness({
      knownCustomers: { [CUSTOMER_A]: "local-existing" },
      enroller: { async enrollVerifiedCustomer() { throw new Error("must not be called"); } },
    });
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(200);
    expect(chainOf(harness.logs)).toMatchObject({
      existingCustomerFound: true,
      enrollmentAttempted: false,
      outcome: "resolved",
    });
  });

  it("reports a signature failure as its own outcome, not as a missing identity", async () => {
    harness = buildHarness({});
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A }).replace(
      CUSTOMER_A,
      "8888888",
    );
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(401);
    expect(chainOf(harness.logs)).toMatchObject({
      signatureVerified: false,
      outcome: "app_proxy_signature_invalid",
      // A tampered request must never have its injected id trusted or recorded.
      enrollmentAttempted: false,
    });
  });

  it("reports an unverifiable request when no secret is configured", async () => {
    harness = buildHarness({ withSecret: false });
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(res.statusCode).toBe(401);
    expect(chainOf(harness.logs)).toMatchObject({
      signatureVerified: false,
      outcome: "app_proxy_verification_unavailable",
    });
  });
});

describe("the diagnostic leaks nothing", () => {
  it("records no signature, no cookie, no email, and no full customer id", async () => {
    harness = buildHarness({});
    await harness.app.ready();

    const params = {
      shop: "athoor",
      logged_in_customer_id: CUSTOMER_A,
      path_prefix: "/apps/loyalty",
    };
    // The actual signature VALUE, so the assertion below tests that the secret
    // material is absent rather than that the word "signature" is absent — the
    // trace legitimately has a `signatureVerified` boolean.
    const signatureValue = computeAppProxySignature(params, SECRET);
    const qs = signedQuery(params);
    await harness.app.inject({
      method: "GET",
      url: `/secure?${qs}`,
      headers: {
        // Deliberately NO Authorization header: a bearer token takes precedence
        // over the App Proxy path, and this test is about the proxy path. The
        // bearer path's own privacy is covered by the shared masking helper.
        cookie: `_shopify_essential=${SECRET_LOOKING_VALUE}; secure_customer_sig=abc123`,
        "x-customer-email": "victim@example.com",
      },
    });

    const serialised = JSON.stringify(harness.logs);

    // The full id never appears — only its last four characters.
    expect(serialised).not.toContain(CUSTOMER_A);
    expect(serialised).toContain("…6563");
    // The signature VALUE never appears. (`signatureVerified` is a boolean field
    // name and is expected — what must never be logged is the signature itself.)
    expect(signatureValue.length).toBeGreaterThan(20);
    expect(serialised).not.toContain(signatureValue);
    // No cookie value, no email, no secret-shaped material.
    expect(serialised).not.toContain(SECRET_LOOKING_VALUE);
    expect(serialised).not.toContain("secure_customer_sig");
    expect(serialised).not.toContain("_shopify_essential");
    expect(serialised).not.toContain("victim@example.com");
    expect(serialised).not.toMatch(/@example\.com/);
    // And the only customer-identifying token present is the 4-char mask.
    expect(serialised).not.toContain(CUSTOMER_A.slice(0, -4));
  });

  it("masks a short id wholly rather than exposing part of it", async () => {
    harness = buildHarness({});
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: "12" });
    await harness.app.inject({ method: "GET", url: `/secure?${qs}` });

    expect(chainOf(harness.logs).maskedCustomerSuffix).toBe("…****");
  });

  it("emits exactly one chain line per gated request, and none for a public route", async () => {
    harness = buildHarness({ knownCustomers: { [CUSTOMER_A]: "local-existing" } });
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A });
    await harness.app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(chainLines(harness.logs)).toHaveLength(1);

    harness.logs.length = 0;
    const publicRes = await harness.app.inject({ method: "GET", url: "/public" });
    expect(publicRes.statusCode).toBe(200);
    // A public route is served without auth, so there is no chain to report.
    expect(chainLines(harness.logs)).toHaveLength(0);
  });

  it("logs a 401 at warn and a lazy enrollment at info", async () => {
    harness = buildHarness({
      enroller: { async enrollVerifiedCustomer() { return "local-new"; } },
    });
    await harness.app.ready();

    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A });
    await harness.app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(chainLines(harness.logs)[0]!.level).toBe("info");

    harness.logs.length = 0;
    await harness.app.inject({ method: "GET", url: `/secure?${signedQuery({ shop: "athoor" })}` });
    expect(chainLines(harness.logs)[0]!.level).toBe("warn");
  });
});
