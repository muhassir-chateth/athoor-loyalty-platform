// Feature: customer-experience-portal, Property 2: A foreign identifier never returns foreign data with HTTP 200
/**
 * PROPERTY 2 — spec task 16.2. Validates Requirements 2.2, 2.3.
 *
 * The property: every response to a request naming a foreign identifier is either
 * `404`, or `200` carrying ONLY the caller's own data. There is no third outcome —
 * in particular there is no `403`, because a `403` would confirm the resource exists
 * and belongs to someone else, which is an existence oracle (§4.5 row 14).
 *
 * ── AND THE FIFTEEN CASES OF §4.5, TABLE-DRIVEN ─────────────────────────────
 * §4.6 item 3 asks for exactly that: "Table-drive every row of §4.5 and assert the
 * exact status and that the response body contains no attribute of the foreign
 * resource." All fifteen are below, each naming its row.
 *
 * ── WHY B'S ROW COUNT IS AN INVARIANT, NOT AN AFTERTHOUGHT ──────────────────
 * A foreign identifier could be refused with a clean `404` while still having
 * changed something — a `DELETE` whose predicate matched, a counter incremented, a
 * tombstone written. So every write case asserts B's state is unchanged as well as
 * asserting the status.
 *
 * SAFETY: in-memory only. No network, no database, no production.
 */
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import {
  A,
  APP_PROXY_SECRET,
  B,
  B_SECRETS,
  bearer,
  bodyFor,
  BODY_METHODS,
  buildHarness,
  concretise,
  idempotencyKey,
  portalRoutes,
  signedUrl,
  tamperedUrl,
  anonymousSignedUrl,
  type HarnessDb,
  type HarnessRoute,
} from "../testing/portalHarness.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** A snapshot of everything B owns, for the invariance assertions. */
function snapshotB(db: HarnessDb): string {
  return JSON.stringify({
    preferences: db.preferences.get(B.localId),
    communication: db.communication.get(B.localId),
    birthday: db.birthdays.get(B.localId),
    wishlist: db.wishlist.get(B.localId),
    favourites: db.favourites.get(B.localId),
    recentlyViewed: db.recentlyViewed.get(B.localId),
    erasure: db.erasure.get(B.localId),
    referral: db.referral.get(B.localId),
  });
}

/**
 * Every one of B's secrets present in a body, EXCLUDING anything the request itself
 * supplied.
 *
 * ── WHY THE EXCLUSION IS CORRECT AND NOT A WEAKENING ────────────────────────
 * The first version of this had no exclusion, and Property 2 duly "found a leak":
 * probing `PUT /v1/profile/wishlist/<B's order number>` came back with that number
 * in the body, because the route echoes the product id it was asked to set.
 *
 * Echoing request input is not a leak. The caller already knew the value — they sent
 * it. A response that repeats it discloses nothing, and asserting otherwise would
 * pressure a correct handler into hiding its own input, which is worse: a client
 * could no longer tell which item a response referred to.
 *
 * What the property is actually about is data the caller did NOT supply — B's email
 * arriving in a response to a request that merely named B's order id. That is still
 * fully asserted, because only the probe value is excluded.
 */
function leaks(body: string, supplied: readonly string[] = []): string[] {
  return B_SECRETS.filter((secret) => body.includes(secret) && !supplied.includes(secret));
}

describe("Property 2: a foreign identifier never returns foreign data with HTTP 200", () => {
  it("Property: any foreign identifier in the PATH yields 404, or 200 with only A's data", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const parameterised = portalRoutes(harness.routes).filter((r) => r.url.includes("/:"));
    expect(parameterised.length).toBeGreaterThan(0);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: parameterised.length - 1 }),
        // Foreign identifier shapes an attacker would actually try: B's real ids,
        // valid-but-foreign uuids, foreign Shopify ids, sequential neighbours of A's
        // own ids, and collision candidates.
        fc.oneof(
          fc.constant(B.localId),
          fc.constant(B.shopifyId),
          fc.constant("9990001"),
          fc.constant("8880001"),
          fc.constant("cccccccc-3333-4333-8333-cccccccccccc"),
          fc.integer({ min: 1, max: 9_999_999 }).map(String),
          fc.constant("0"),
          fc.constant("1"),
        ),
        async (routeIndex, foreignId) => {
          const route = parameterised[routeIndex] as HarnessRoute;
          const before = snapshotB(harness.db);
          const path = concretise(route.url, A).replace(
            /\/[^/]+(?=(\/default)?$)/,
            `/${encodeURIComponent(foreignId)}`,
          );
          const hasBody = BODY_METHODS.has(route.method);
          const res = await harness.app.inject({
            method: route.method as "GET",
            url: path,
            headers: {
              ...bearer(A),
              ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
            },
            ...(hasBody ? { payload: bodyFor(route.url) } : {}),
          });

          // No 403, no 500, and never a body carrying B's data.
          expect(res.statusCode, `${route.method} ${path}`).not.toBe(403);
          expect(res.statusCode, `${route.method} ${path}`).toBeLessThan(500);
          expect(leaks(res.body, [foreignId]), `${route.method} ${path} leaked`).toEqual([]);
          // B's rows are invariant under any of A's operations.
          expect(snapshotB(harness.db), `${route.method} ${path} changed B's rows`).toBe(before);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("Property: a foreign identifier in QUERY, HEADER, COOKIE or BODY changes nothing", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const targets = portalRoutes(harness.routes);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: targets.length - 1 }),
        fc.constantFrom("query", "header", "cookie", "body"),
        fc.constantFrom(B.localId, B.shopifyId, `${B.marker}@victim.invalid`, "9990001"),
        async (routeIndex, channel, foreignId) => {
          const route = targets[routeIndex] as HarnessRoute;
          const before = snapshotB(harness.db);
          const path = concretise(route.url, A);
          const hasBody = BODY_METHODS.has(route.method);

          const res = await harness.app.inject({
            method: route.method as "GET",
            url: channel === "query" ? `${path}?customerId=${encodeURIComponent(foreignId)}` : path,
            headers: {
              ...bearer(A),
              ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
              ...(channel === "header" ? { "x-customer-id": foreignId } : {}),
              ...(channel === "cookie" ? { cookie: `customerId=${foreignId}` } : {}),
            },
            ...(hasBody
              ? {
                  payload:
                    channel === "body"
                      ? { ...bodyFor(route.url), customerId: foreignId, email: foreignId }
                      : bodyFor(route.url),
                }
              : {}),
          });

          expect(res.statusCode).toBeLessThan(500);
          expect(leaks(res.body, [foreignId]), `${route.method} ${route.url} via ${channel}`).toEqual([]);
          expect(snapshotB(harness.db), `${route.method} ${route.url} via ${channel}`).toBe(before);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("Property: B's row count is invariant under ANY sequence of A's operations", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const targets = portalRoutes(harness.routes);

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            routeIndex: fc.nat({ max: targets.length - 1 }),
            foreign: fc.boolean(),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        async (steps) => {
          const before = snapshotB(harness.db);
          for (const step of steps) {
            const route = targets[step.routeIndex] as HarnessRoute;
            const path = step.foreign
              ? concretise(route.url, B) // B's own ids, submitted by A
              : concretise(route.url, A);
            const hasBody = BODY_METHODS.has(route.method);
            await harness.app.inject({
              method: route.method as "GET",
              url: path,
              headers: {
                ...bearer(A),
                ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
              },
              ...(hasBody ? { payload: bodyFor(route.url) } : {}),
            });
            // Checked after every step, not only at the end — a change followed by a
            // coincidental repair would otherwise pass.
            expect(snapshotB(harness.db), "an operation by A changed B's rows").toBe(before);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/* ========================================================================== *
 * §4.5 — all fifteen concrete malicious requests, table-driven (§4.6 item 3)
 * ========================================================================== */

describe("§4.5 the fifteen concrete malicious requests", () => {
  it("row 1 — naming B in the BODY of GET /v1/balance returns A's balance", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/balance",
      headers: { ...bearer(A), "content-type": "application/json" },
      payload: JSON.stringify({ customerId: B.localId }),
    });
    expect(res.statusCode).toBe(200);
    // A's balance, not B's 99999. The body is not read by the handler.
    expect(res.json().spendableBalance).toBe(275);
    expect(leaks(res.body)).toEqual([]);
  });

  it("row 2 — a query param added AFTER signing breaks the signature", async () => {
    const harness = await buildHarness();
    app = harness.app;
    // Added inside the signed payload: legitimate, ignored, 200 with A's data.
    const signedIn = await harness.app.inject({
      method: "GET",
      url: signedUrl("/v1/balance", A.shopifyId, { extraSigned: { customerId: B.localId } }),
    });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().spendableBalance).toBe(275);

    // Appended after signing: the signature no longer covers the query.
    const appended = await harness.app.inject({
      method: "GET",
      url: signedUrl("/v1/balance", A.shopifyId, { extraUnsigned: { customerId: B.localId } }),
    });
    expect(appended.statusCode).toBe(401);
    expect(appended.json().error).toBe("app_proxy_signature_invalid");
  });

  it("row 3 — a forged proxy identity is refused and nothing is written", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const before = snapshotB(harness.db);
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/balance?logged_in_customer_id=999&signature=deadbeef",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("app_proxy_signature_invalid");
    expect(snapshotB(harness.db)).toBe(before);
  });

  it("row 4 — replaying A's signed URL with B's id swapped in is refused", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: tamperedUrl("/v1/balance", A.shopifyId, B.shopifyId),
    });
    // The id is INSIDE the signed message, so swapping it invalidates the signature.
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("app_proxy_signature_invalid");
    expect(leaks(res.body)).toEqual([]);
  });

  it("row 5 — calling the origin directly with no signature and no bearer is refused", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({ method: "GET", url: "/v1/balance" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("identity_resolution_failed");
  });

  it("row 6 — reading B's order is 404 with no order field", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/orders/8880001",
      headers: bearer(A),
    });
    // Unreachable rather than merely rejected: the order is outside A's connection.
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty("orderNumber");
    expect(res.json()).not.toHaveProperty("lineItems");
    expect(leaks(res.body)).toEqual([]);
  });

  it("row 7 — an order GID in the path is refused by the schema", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/orders/${encodeURIComponent("gid://shopify/Order/123")}`,
      headers: bearer(A),
    });
    // The path accepts digits only, so this never reaches the Shopify traversal.
    expect([400, 404]).toContain(res.statusCode);
    expect(leaks(res.body)).toEqual([]);
  });

  it("row 8 — removing B's wishlist item leaves B's wishlist untouched", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const before = snapshotB(harness.db);
    const res = await harness.app.inject({
      method: "PUT",
      url: "/v1/profile/wishlist/9990001",
      headers: { ...bearer(A), "idempotency-key": idempotencyKey() },
      payload: { on: false },
    });
    // `DELETE ... WHERE customer_id = A AND shopify_product_id = 9990001` affects
    // zero rows, so this succeeds and changes nothing of B's.
    expect(res.statusCode).toBeLessThan(500);
    expect(snapshotB(harness.db)).toBe(before);
    expect(leaks(res.body, ["9990001"])).toEqual([]);
  });

  it("row 9 — a customerId query param on /v1/history returns A's page", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/history?page=1&customerId=${B.localId}`,
      headers: bearer(A),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(A.marker);
    expect(leaks(res.body)).toEqual([]);
  });

  it("row 10 — no portal route accepts a benefit_requests id", async () => {
    const harness = await buildHarness();
    app = harness.app;
    // Transitions are admin-only under `/v1/admin` with separate auth, so the
    // property is about the ROUTE SURFACE rather than a runtime check.
    const benefitRoutes = portalRoutes(harness.routes).filter((r) => r.url.includes("benefit"));
    for (const route of benefitRoutes) {
      expect(route.url, `${route.method} ${route.url} takes a request id`).not.toMatch(
        /:requestId|:benefitRequestId/,
      );
    }
  });

  it("row 11 — an idempotency key used by B does not suppress A's request", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const shared = "shared-key-across-customers";
    const asB = await harness.app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: { ...bearer(B), "idempotency-key": shared },
      payload: { month: 12, day: 25 },
    });
    const asA = await harness.app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: { ...bearer(A), "idempotency-key": shared },
      payload: { month: 6, day: 10 },
    });
    // Storage keys are `{customer}|METHOD path:key`, so the two namespaces are
    // disjoint and A's request RAN rather than replaying B's response.
    expect(asA.statusCode).toBeLessThan(500);
    expect(asA.body).not.toBe(asB.body);
    expect(leaks(asA.body)).toEqual([]);
  });

  it("row 12 — a customerId param on the birthday read returns A's birthday", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/profile/birthday?customerId=${B.localId}`,
      headers: bearer(A),
    });
    expect(res.statusCode).toBe(200);
    // A's birthday is 10 June; B's is 25 December.
    expect(res.json().birthday).toEqual({ month: 6, day: 10 });
  });

  it("row 13 — a referral claim naming B applies to A only, and names no referrer", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const before = snapshotB(harness.db);
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/referral",
      headers: { ...bearer(A), "idempotency-key": idempotencyKey() },
      payload: { referralCode: `BREF-${B.marker}`, customerId: B.localId },
    });
    expect(res.statusCode).toBeLessThan(500);
    // Whatever the outcome, an existing referrer is never named in the body. B's own
    // code was supplied by the request, so it is excluded; B's email, id and order
    // number are not, and must not appear.
    expect(leaks(res.body, [`BREF-${B.marker}`, B.localId])).toEqual([]);
    expect(snapshotB(harness.db)).toBe(before);
  });

  it("row 14 — NO EXISTENCE ORACLE: a real foreign id and a random id are byte-identical", async () => {
    const harness = await buildHarness();
    app = harness.app;
    // B's order genuinely exists; the other id does not exist at all. If the two
    // responses differed in any byte, sequential probing would enumerate customers.
    const real = await harness.app.inject({
      method: "GET",
      url: "/v1/orders/8880001",
      headers: bearer(A),
    });
    const absent = await harness.app.inject({
      method: "GET",
      url: "/v1/orders/6000001",
      headers: bearer(A),
    });
    expect(real.statusCode).toBe(absent.statusCode);
    expect(real.body).toBe(absent.body);
  });

  it("row 15 — an export cannot be requested for another customer", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/profile/export?customerId=${B.localId}`,
      headers: bearer(A),
    });
    expect(res.statusCode).toBe(200);
    // Built from the scope alone.
    expect(res.body).toContain(A.marker);
    expect(leaks(res.body)).toEqual([]);
  });

  it("uses the configured proxy secret, so the signature cases are real", () => {
    // A guard against the four signature rows passing because signing was a no-op.
    expect(APP_PROXY_SECRET.length).toBeGreaterThan(10);
  });

  it("a signed-but-anonymous request is refused on every portal route", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const failures: string[] = [];
    for (const route of portalRoutes(harness.routes)) {
      const res = await harness.app.inject({
        method: route.method as "GET",
        url: anonymousSignedUrl(concretise(route.url, A)),
        ...(BODY_METHODS.has(route.method)
          ? { payload: {}, headers: { "content-type": "application/json" } }
          : {}),
      });
      if (res.statusCode !== 401) failures.push(`${route.method} ${route.url} -> ${res.statusCode}`);
    }
    expect(failures, `anonymous signed requests were not refused:\n${failures.join("\n")}`).toEqual(
      [],
    );
  });
});
