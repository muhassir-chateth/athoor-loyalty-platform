// Feature: customer-experience-portal, Property 7: Identity resolution ignores client-supplied identity
/**
 * PROPERTY 7 — spec task 16.3. Validates Requirements 1.2, 1.4.
 *
 * The property: substituting arbitrary customer identifiers, emails and Shopify ids
 * across body, query, headers and cookies — while leaving the verified bearer token
 * or signature UNCHANGED — produces a BYTE-IDENTICAL response.
 *
 * ── BYTE-IDENTICAL IS THE RIGHT ORACLE, AND IT IS STRICTER THAN IT LOOKS ────
 * A weaker assertion — "the response still contains A's data" — would pass a handler
 * that read the supplied id, noticed it was foreign, and adjusted its output in ANY
 * way: a different field order, an extra `warning`, a changed count. Each of those is
 * an oracle: an attacker learns something from the difference. Requiring the bytes to
 * match means the supplied value had no effect whatsoever, which is what Requirement
 * 1.2 actually asks for.
 *
 * ── WHY THE SIGNATURE PATH NEEDS THE PARAM INSIDE THE PAYLOAD ───────────────
 * On the App Proxy path a param appended AFTER signing invalidates the signature, so
 * that case is a `401` rather than an identical `200` — which §4.5 row 2 records and
 * `foreignIdentifier.property.test.ts` asserts. To test THIS property over the proxy,
 * the substituted param has to be inside the signed payload, which is the shape a
 * malicious-but-correctly-signed client would actually send.
 *
 * SAFETY: in-memory only. No network, no database, no production.
 */
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import {
  A,
  B,
  bearer,
  bodyFor,
  BODY_METHODS,
  buildHarness,
  concretise,
  idempotencyKey,
  portalRoutes,
  signedUrl,
  type HarnessRoute,
} from "../testing/portalHarness.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** Identity values a client might try to pass off as its own. */
const IDENTITY_KEYS = [
  "customerId",
  "customer_id",
  "customerID",
  "shopifyCustomerId",
  "shopify_customer_id",
  "logged_in_customer_id",
  "email",
  "userId",
  "id",
] as const;

const IDENTITY_VALUES = [
  B.localId,
  B.shopifyId,
  `${B.marker}@victim.invalid`,
  "0",
  "1",
  "admin",
  "*",
  "00000000-0000-4000-8000-000000000000",
] as const;

/**
 * Strips values that legitimately vary between two identical requests.
 *
 * `Idempotency-Key` differs per request by construction, and an erasure reference is
 * derived from a freshly-generated request uuid — so a byte comparison has to
 * normalise them or it would fail on every state-changing route for a reason that has
 * nothing to do with identity. Everything else is compared exactly.
 */
function normalise(body: string): string {
  return body
    .replace(/"reference":"ERASE-[0-9A-F]+"/g, '"reference":"ERASE-X"')
    .replace(/"requestedAt":"[^"]+"/g, '"requestedAt":"X"')
    .replace(/"generatedAt":"[^"]+"/g, '"generatedAt":"X"');
}

describe("Property 7: identity resolution ignores client-supplied identity", () => {
  it("Property: a substituted identity in ANY channel leaves the response byte-identical", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const targets = portalRoutes(harness.routes);
    expect(targets.length).toBeGreaterThan(0);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: targets.length - 1 }),
        fc.constantFrom("query", "header", "cookie", "body", "all"),
        fc.constantFrom(...IDENTITY_KEYS),
        fc.constantFrom(...IDENTITY_VALUES),
        async (routeIndex, channel, key, value) => {
          const route = targets[routeIndex] as HarnessRoute;
          const path = concretise(route.url, A);
          const hasBody = BODY_METHODS.has(route.method);

          const baseline = await harness.app.inject({
            method: route.method as "GET",
            url: path,
            headers: {
              ...bearer(A),
              ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
            },
            ...(hasBody ? { payload: bodyFor(route.url) } : {}),
          });

          const inQuery = channel === "query" || channel === "all";
          const inHeader = channel === "header" || channel === "all";
          const inCookie = channel === "cookie" || channel === "all";
          const inBody = channel === "body" || channel === "all";

          const spoofed = await harness.app.inject({
            method: route.method as "GET",
            url: inQuery ? `${path}?${key}=${encodeURIComponent(value)}` : path,
            headers: {
              ...bearer(A),
              ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
              ...(inHeader ? { [`x-${key}`]: value } : {}),
              ...(inCookie ? { cookie: `${key}=${value}` } : {}),
            },
            ...(hasBody
              ? { payload: inBody ? { ...bodyFor(route.url), [key]: value } : bodyFor(route.url) }
              : {}),
          });

          // ── WHAT "IDENTICAL" MEANS, AND THE ONE HONEST EXCEPTION ─────────
          //
          // For query, header and cookie the response must be byte-identical: those
          // channels cannot make a request malformed, so any difference means the
          // supplied value was read.
          //
          // A BODY is different, and the difference is a deliberate design decision
          // rather than a gap. Task 13's preferences validator REJECTS an unknown
          // top-level key by name instead of stripping it, precisely so a client is
          // never told "saved" when its key was silently dropped. Adding
          // `customerId` to that body therefore yields a `400` — a different response
          // from the baseline `200`.
          //
          // That is not a Property 7 violation. Requirement 1.2 says a supplied
          // identifier must be IGNORED WHEN DETERMINING THE VERIFIED IDENTITY, and a
          // route that refuses the whole request has not served the wrong customer.
          // So the body case asserts the weaker-but-correct disjunction: identical,
          // or a 4xx that served no data at all. The failure this property exists to
          // catch — B's data coming back — is still fully asserted, because a 4xx
          // carrying B's marker fails the second branch.
          const bodyChannel = inBody && hasBody;
          if (!bodyChannel) {
            expect(
              spoofed.statusCode,
              `${route.method} ${route.url} status changed with ${key} in ${channel}`,
            ).toBe(baseline.statusCode);
            expect(
              normalise(spoofed.body),
              `${route.method} ${route.url} body changed with ${key} in ${channel}`,
            ).toBe(normalise(baseline.body));
          } else {
            const identical =
              spoofed.statusCode === baseline.statusCode &&
              normalise(spoofed.body) === normalise(baseline.body);
            const refused = spoofed.statusCode >= 400 && spoofed.statusCode < 500;
            expect(
              identical || refused,
              `${route.method} ${route.url} with ${key} in the body: ${baseline.statusCode} -> ${spoofed.statusCode}, neither identical nor refused`,
            ).toBe(true);
            // Either way, never another customer's data.
            expect(spoofed.body, `${route.method} ${route.url} leaked B`).not.toContain(B.marker);
            expect(spoofed.body).not.toContain(B.localId);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("holds over the App Proxy path when the param is INSIDE the signed payload", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const failures: string[] = [];

    for (const route of portalRoutes(harness.routes).filter((r) => r.method === "GET")) {
      const path = concretise(route.url, A);
      const plain = await harness.app.inject({
        method: "GET",
        url: signedUrl(path, A.shopifyId),
      });
      const spoofed = await harness.app.inject({
        method: "GET",
        // Signed, so the request is legitimate — and the extra param still has no
        // effect. This is the case a merely-signature-based defence would miss.
        url: signedUrl(path, A.shopifyId, { extraSigned: { customerId: B.localId } }),
      });
      if (normalise(spoofed.body) !== normalise(plain.body) || spoofed.statusCode !== plain.statusCode) {
        failures.push(`${route.method} ${route.url}: ${plain.statusCode} -> ${spoofed.statusCode}`);
      }
    }
    expect(failures, `a signed extra param changed the response:\n${failures.join("\n")}`).toEqual([]);
  });

  it("resolves identity from the TOKEN, not from a matching body value", async () => {
    // The decisive case: A's token with B's id everywhere. If any handler preferred
    // the supplied value, this would return B's data.
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/profile/identity?customerId=${B.localId}&logged_in_customer_id=${B.shopifyId}`,
      headers: { ...bearer(A), "x-customer-id": B.localId, cookie: `customerId=${B.localId}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(A.marker);
    expect(res.body).not.toContain(B.marker);
  });

  it("is NON-VACUOUS: swapping the TOKEN does change the response", async () => {
    // The guard. If responses were identical no matter what, the property above would
    // be meaningless — so changing the one thing that SHOULD matter must change the
    // output.
    const harness = await buildHarness();
    app = harness.app;
    const asA = await harness.app.inject({
      method: "GET",
      url: "/v1/profile/identity",
      headers: bearer(A),
    });
    const asB = await harness.app.inject({
      method: "GET",
      url: "/v1/profile/identity",
      headers: bearer(B),
    });
    expect(asA.statusCode).toBe(200);
    expect(asB.statusCode).toBe(200);
    expect(normalise(asA.body)).not.toBe(normalise(asB.body));
  });

  it("ignores a spoofed identity on the UNAUTHENTICATED path too (Req 1.4)", async () => {
    // With no verified identity at all, a supplied one must not become one.
    const harness = await buildHarness();
    app = harness.app;
    const failures: string[] = [];
    for (const route of portalRoutes(harness.routes)) {
      const res = await harness.app.inject({
        method: route.method as "GET",
        url: `${concretise(route.url, A)}?customerId=${A.localId}&logged_in_customer_id=${A.shopifyId}`,
        headers: {
          "x-customer-id": A.localId,
          cookie: `customerId=${A.localId}`,
          ...(BODY_METHODS.has(route.method) ? { "idempotency-key": idempotencyKey() } : {}),
        },
        ...(BODY_METHODS.has(route.method) ? { payload: { customerId: A.localId } } : {}),
      });
      if (res.statusCode !== 401) failures.push(`${route.method} ${route.url} -> ${res.statusCode}`);
    }
    expect(failures, `a supplied identity was accepted as authentication:\n${failures.join("\n")}`).toEqual(
      [],
    );
  });
});
