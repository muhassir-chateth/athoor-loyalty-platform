// Feature: customer-experience-portal, Property 1: No response ever contains another customer's data
/**
 * PROPERTY 1 — spec task 16.1. Validates Requirements 2.1, 2.2, 2.4, 2.6.
 *
 * The property: no response to customer A contains any stored attribute of customer
 * B — email, name, address, order number, wishlist product id, points value,
 * referral code, redemption id, or internal customer id.
 *
 * ── THIS IS THE HTTP COUNTERPART OF behaviouralIsolation.property.test.ts ────
 * That file proves the property at the SQL layer: A's operations never alter B's
 * rows. It builds no Fastify app, by design — its header says so. This file proves
 * the same property one layer up, over real responses, because the two can fail
 * independently: correctly-scoped SQL can still be composed into a response that
 * names another customer, and a route that forgot its scope would pass every
 * data-layer property while leaking over HTTP.
 *
 * ── THE SWEEP IS ENUMERATED, NOT LISTED ─────────────────────────────────────
 * The routes come from Fastify's own registry via the harness, so an endpoint added
 * next month is covered by this property without anyone remembering to add it. That
 * is the mechanism §4.6 asks for — "contract tests, not per-endpoint spot checks, so
 * they cover endpoints added later".
 *
 * ── WHY THE FAKES CARRY DISTINCT MARKERS ────────────────────────────────────
 * Both customers are populated with recognisable, DISJOINT marker values, so a leak
 * is observable as a substring. A harness whose fakes returned the same data to
 * everyone would make this property pass by construction — `harnessBoundary.test.ts`
 * asserts it does not.
 *
 * SAFETY: in-memory only. No network, no database, no production.
 */
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import {
  A,
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
  type HarnessRoute,
} from "../testing/portalHarness.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** Sends one request as `customer` to `route`, with an appropriate body and key. */
async function call(
  instance: FastifyInstance,
  route: HarnessRoute,
  customer: typeof A | typeof B,
  opts: { viaProxy?: boolean } = {},
) {
  const path = concretise(route.url, customer);
  const hasBody = BODY_METHODS.has(route.method);
  return instance.inject({
    method: route.method as "GET",
    url: opts.viaProxy === true ? signedUrl(path, customer.shopifyId) : path,
    headers: {
      ...(opts.viaProxy === true ? {} : bearer(customer)),
      ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
    },
    ...(hasBody ? { payload: bodyFor(route.url) } : {}),
  });
}

/** Every one of B's secrets that appears in `body`. */
function leaks(body: string): string[] {
  return B_SECRETS.filter((secret) => body.includes(secret));
}

describe("Property 1: no response ever contains another customer's data", () => {
  it("holds for EVERY portal route and method, over a bearer token", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const failures: string[] = [];

    for (const route of portalRoutes(harness.routes)) {
      const res = await call(harness.app, route, A);
      const found = leaks(res.body);
      if (found.length > 0) {
        failures.push(`${route.method} ${route.url} (${res.statusCode}) leaked: ${found.join(", ")}`);
      }
    }
    // Accumulate then assert once, so a single run names every offending route
    // rather than stopping at the first.
    expect(failures, `B's data appeared in a response to A:\n${failures.join("\n")}`).toEqual([]);
  });

  it("holds for EVERY portal route over the App Proxy path too", async () => {
    // The two authentication routes resolve identity differently, so a leak could
    // exist on one and not the other.
    const harness = await buildHarness();
    app = harness.app;
    const failures: string[] = [];

    for (const route of portalRoutes(harness.routes)) {
      const res = await call(harness.app, route, A, { viaProxy: true });
      const found = leaks(res.body);
      if (found.length > 0) {
        failures.push(`${route.method} ${route.url} (${res.statusCode}) leaked: ${found.join(", ")}`);
      }
    }
    expect(failures, `B's data appeared in a proxy response to A:\n${failures.join("\n")}`).toEqual(
      [],
    );
  });

  it("is SYMMETRIC: A's data never appears in a response to B", async () => {
    // Asserted in both directions, because a harness or a handler that happened to
    // hard-code A would pass the A-facing sweep and fail this one.
    const harness = await buildHarness();
    app = harness.app;
    const aSecrets = [A.localId, A.shopifyId, A.marker, "1001", "1002", `AREF-${A.marker}`, "AA-DISCOUNT", "7770001"];
    const failures: string[] = [];

    for (const route of portalRoutes(harness.routes)) {
      const res = await call(harness.app, route, B);
      const found = aSecrets.filter((secret) => res.body.includes(secret));
      if (found.length > 0) {
        failures.push(`${route.method} ${route.url} (${res.statusCode}) leaked: ${found.join(", ")}`);
      }
    }
    expect(failures, `A's data appeared in a response to B:\n${failures.join("\n")}`).toEqual([]);
  });

  it("Property: holds under any INTERLEAVING of the two customers' requests", async () => {
    // The sequential sweeps above would miss state that one customer's request left
    // behind for the next — a cache keyed on the wrong thing, a module-level
    // variable, a store written under one identity and read under another.
    const harness = await buildHarness();
    app = harness.app;
    const targets = portalRoutes(harness.routes);
    expect(targets.length).toBeGreaterThan(0);

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            actor: fc.constantFrom("A" as const, "B" as const),
            routeIndex: fc.nat({ max: targets.length - 1 }),
            viaProxy: fc.boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (steps) => {
          for (const step of steps) {
            const route = targets[step.routeIndex] as HarnessRoute;
            const caller = step.actor === "A" ? A : B;
            const other = step.actor === "A" ? B_SECRETS : [A.localId, A.marker, `AREF-${A.marker}`];
            const res = await call(harness.app, route, caller, { viaProxy: step.viaProxy });
            const found = other.filter((secret) => res.body.includes(secret));
            // Checked after EVERY step. Checking only at the end would let a leak
            // followed by a coincidental repair pass — the discipline
            // `behaviouralIsolation.property.test.ts` established at the SQL layer.
            expect(
              found,
              `${route.method} ${route.url} as ${step.actor} leaked ${found.join(", ")}`,
            ).toEqual([]);
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  it("never exposes ANOTHER customer's internal database key (Req 2.6)", async () => {
    // ── WHAT THIS DOES AND DOES NOT ASSERT, AND WHY ─────────────────────────
    // Requirement 2.6 is specific: exclude the internal primary key of any OTHER
    // customer. It does NOT forbid returning the caller's own.
    //
    // I first wrote the stronger form — no local UUID in any response at all — and
    // it FAILED on `GET /v1/profile`, which returns `customerId` as its first field.
    // That field is shipped, is documented as "the requesting customer's local id",
    // and is the caller's own; Requirement 20.6 forbids removing a shipped field, so
    // the stronger form is not available without a breaking change and is not what
    // the requirement asks for.
    //
    // So the assertion is the requirement: any UUID in a response must be the
    // caller's own. That still catches the failure that matters — B's key appearing
    // in a response to A — and it catches a THIRD party's key too, which the
    // marker-based sweeps above would not.
    const harness = await buildHarness();
    app = harness.app;
    const uuids = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
    const failures: string[] = [];

    for (const route of portalRoutes(harness.routes)) {
      const res = await call(harness.app, route, A);
      for (const match of res.body.matchAll(uuids)) {
        const found = match[0].toLowerCase();
        // The caller's own id is permitted. The erasure reference is derived from a
        // REQUEST uuid, which identifies a request rather than a customer.
        if (found === A.localId) continue;
        if (route.url.includes("/erasure-request")) continue;
        failures.push(`${route.method} ${route.url} carried a foreign UUID: ${found}`);
      }
    }
    expect(failures, `a foreign internal key appeared in a response:\n${failures.join("\n")}`).toEqual(
      [],
    );
  });

  it("is NON-VACUOUS: the sweep really does see populated responses", async () => {
    // The guard against the whole file passing over 401s or empty bodies. If this
    // fails, every assertion above is weaker than it looks.
    const harness = await buildHarness();
    app = harness.app;
    let sawOwnMarker = 0;
    let sawTwoHundred = 0;

    for (const route of portalRoutes(harness.routes)) {
      const res = await call(harness.app, route, A);
      if (res.statusCode >= 200 && res.statusCode < 300) sawTwoHundred += 1;
      if (res.body.includes(A.marker)) sawOwnMarker += 1;
    }
    expect(sawTwoHundred).toBeGreaterThanOrEqual(20);
    // A's own markers DO come back, so the substring search is capable of finding a
    // marker when one is present.
    expect(sawOwnMarker).toBeGreaterThanOrEqual(4);
  });
});
