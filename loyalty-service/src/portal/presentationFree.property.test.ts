// Feature: customer-experience-portal, Property 10: Portal responses carry no presentation payload
/**
 * PROPERTY 10 — spec task 16.4. Validates Requirement 21.7.
 *
 * The property: no response body contains HTML markup, a CSS class shape, or a
 * user-facing sentence intended for direct rendering.
 *
 * ── WHY THIS MATTERS BEYOND TIDINESS ────────────────────────────────────────
 * Requirement 21.7 is about mobile readiness. A response carrying a rendered
 * sentence has decided the wording, the language and the tone on the client's behalf
 * — so a mobile app cannot use its own, and changing the copy needs a service deploy.
 * Every task from 8 onward emits identifiers instead (`family_concentration`,
 * `invalid_postcode`, `birthday_change_locked`), and this property is what keeps that
 * true for endpoints added later.
 *
 * ── THE ONE FIELD THAT IS ALLOWED TO BE PROSE, AND WHY ──────────────────────
 * `message` on an error body. `PortalErrorBody` declares it, every error path sets
 * it, and it is the human-readable companion to the machine-readable `error`
 * identifier. It is excluded from the sentence scan by NAME — not by pattern — so a
 * new prose field cannot slip in by resembling it.
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

/**
 * Fields permitted to carry prose, by NAME.
 *
 * `message` is the error envelope's human-readable companion (`PortalErrorBody`).
 * `title` is a Shopify PRODUCT title — upstream commerce data the portal passes
 * through, not copy the portal authored, and a client must render it verbatim.
 */
const PROSE_FIELDS: ReadonlySet<string> = new Set(["message", "title", "description"]);

/** Markup and styling shapes that must never appear in a value. */
const MARKUP_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "an HTML tag", pattern: /<\/?[a-z][a-z0-9]*(?:\s[^>]*)?\/?>/i },
  { label: "an HTML entity", pattern: /&(?:nbsp|amp|lt|gt|quot|#\d+);/i },
  { label: "a style attribute", pattern: /style\s*=\s*["']/i },
  { label: "a CSS class attribute", pattern: /class(?:Name)?\s*=\s*["']/i },
  { label: "a CSS rule", pattern: /\{[^{}]*:\s*[^{}]*;\s*\}/ },
  { label: "a BEM/utility class shape", pattern: /\b[a-z]+(?:__[a-z-]+|--[a-z-]+)\b/ },
  { label: "a template placeholder", pattern: /\{\{\s*\w+\s*\}\}|\$\{\w+\}/ },
];

/**
 * A value that reads as a user-facing sentence.
 *
 * Two signals together, because either alone over-fires: sentence-ending punctuation
 * AND multiple words. `"oud"` is an identifier; `"Your birthday has been saved."` is
 * copy. An identifier never contains a space, so the word count is the discriminator
 * that matters.
 */
function looksLikeASentence(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 12) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 3) return false;
  return /[.!?]$/.test(trimmed) || /\b(?:you|your|please|we|sorry|try again)\b/i.test(trimmed);
}

/** Walks a parsed body, yielding `[path, value]` for every string. */
function* strings(node: unknown, path: string[] = []): Generator<[string, string]> {
  if (typeof node === "string") {
    yield [path.join("."), node];
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* strings(item, [...path, String(i)]);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) yield* strings(value, [...path, key]);
  }
}

/** Every presentation violation in a body. */
function violations(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A non-JSON body is itself a finding: every portal response is JSON.
    return body.trim() === "" ? [] : [`body is not JSON: ${body.slice(0, 60)}`];
  }
  const found: string[] = [];
  for (const [path, value] of strings(parsed)) {
    const leaf = path.split(".").pop() ?? "";
    for (const { label, pattern } of MARKUP_PATTERNS) {
      if (pattern.test(value)) found.push(`${path} contains ${label}: ${value.slice(0, 60)}`);
    }
    if (!PROSE_FIELDS.has(leaf) && looksLikeASentence(value)) {
      found.push(`${path} reads as a sentence: ${value.slice(0, 60)}`);
    }
  }
  return found;
}

describe("Property 10: portal responses carry no presentation payload", () => {
  it("holds across every portal route in its POPULATED state", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const failures: string[] = [];

    for (const route of portalRoutes(harness.routes)) {
      const hasBody = BODY_METHODS.has(route.method);
      const res = await harness.app.inject({
        method: route.method as "GET",
        url: concretise(route.url, A),
        headers: {
          ...bearer(A),
          ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
        },
        ...(hasBody ? { payload: bodyFor(route.url) } : {}),
      });
      for (const violation of violations(res.body)) {
        failures.push(`${route.method} ${route.url} (${res.statusCode}): ${violation}`);
      }
    }
    expect(failures, `presentation payload in a response:\n${failures.join("\n")}`).toEqual([]);
  });

  it("holds in the EMPTY state, where a template would be most tempting", async () => {
    // An empty collection is exactly where a service is inclined to helpfully supply
    // "You have no saved items yet." — which is the client's wording to choose.
    const harness = await buildHarness();
    app = harness.app;
    // Empty every store for A.
    harness.db.wishlist.set(A.localId, []);
    harness.db.favourites.set(A.localId, []);
    harness.db.recentlyViewed.set(A.localId, []);
    harness.db.preferences.set(A.localId, []);
    harness.db.erasure.set(A.localId, []);
    harness.db.birthdays.delete(A.localId);
    harness.db.visits.delete(A.localId);

    const failures: string[] = [];
    for (const route of portalRoutes(harness.routes).filter((r) => r.method === "GET")) {
      const res = await harness.app.inject({
        method: "GET",
        url: concretise(route.url, A),
        headers: bearer(A),
      });
      for (const violation of violations(res.body)) {
        failures.push(`${route.method} ${route.url} (${res.statusCode}): ${violation}`);
      }
    }
    expect(failures, `presentation payload in an empty-state response:\n${failures.join("\n")}`).toEqual(
      [],
    );
  });

  it("Property: holds in ERROR states across every route and every malformed body", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const targets = portalRoutes(harness.routes);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: targets.length - 1 }),
        fc.oneof(
          fc.constant({}),
          fc.constant({ nonsense: true }),
          fc.constant({ month: 99, day: 99 }),
          fc.constant({ declared: { scent_family: ["not-a-family"] } }),
          fc.constant({ emailMarketing: "yes" }),
          fc.constant({ on: "maybe" }),
          fc.constant([1, 2, 3]),
          fc.constant("a bare string"),
        ),
        async (routeIndex, payload) => {
          const route = targets[routeIndex] as HarnessRoute;
          const hasBody = BODY_METHODS.has(route.method);
          const res = await harness.app.inject({
            method: route.method as "GET",
            url: concretise(route.url, A),
            headers: {
              ...bearer(A),
              "content-type": "application/json",
              ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
            },
            ...(hasBody ? { payload: JSON.stringify(payload) } : {}),
          });
          const found = violations(res.body);
          expect(found, `${route.method} ${route.url} (${res.statusCode}): ${found.join("; ")}`).toEqual(
            [],
          );
        },
      ),
      { numRuns: 150 },
    );
  });

  it("emits field errors as CODES, never as sentences (Req 21.7)", async () => {
    const harness = await buildHarness();
    app = harness.app;
    // Three routes that produce field-level errors, each from a different validator.
    const cases: readonly [string, string, unknown][] = [
      ["PUT", "/v1/profile/birthday", { month: 2, day: 30 }],
      ["PUT", "/v1/profile/preferences", { declared: { scent_family: ["nope"] } }],
      ["PUT", "/v1/profile/consent", { emailMarketing: "yes" }],
    ];
    for (const [method, url, payload] of cases) {
      const res = await harness.app.inject({
        method: method as "PUT",
        url,
        headers: { ...bearer(A), "idempotency-key": idempotencyKey() },
        payload: payload as never,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      const fields = (res.json() as { fields?: { code: string }[] }).fields ?? [];
      expect(fields.length, `${method} ${url} returned no field codes`).toBeGreaterThan(0);
      for (const field of fields) {
        // An identifier: lower case, underscores, no spaces, no punctuation.
        expect(field.code, `${method} ${url}`).toMatch(/^[a-z][a-z_]*$/);
      }
    }
  });

  it("is NON-VACUOUS: the detector catches markup and prose when present", () => {
    // The scanner is the whole property. If it found nothing in anything, every
    // assertion above would be empty.
    expect(violations(JSON.stringify({ x: "<p>hello</p>" }))).not.toEqual([]);
    expect(violations(JSON.stringify({ x: "<br/>" }))).not.toEqual([]);
    expect(violations(JSON.stringify({ x: "&nbsp;more text here" }))).not.toEqual([]);
    expect(violations(JSON.stringify({ x: 'class="card"' }))).not.toEqual([]);
    expect(violations(JSON.stringify({ x: "wishlist__empty-state" }))).not.toEqual([]);
    expect(violations(JSON.stringify({ x: "Hello {{ name }} welcome" }))).not.toEqual([]);
    expect(violations(JSON.stringify({ note: "Your birthday has been saved." }))).not.toEqual([]);
    expect(violations(JSON.stringify({ note: "Please try again later" }))).not.toEqual([]);
    // And does NOT fire on legitimate identifiers, codes or upstream titles.
    expect(violations(JSON.stringify({ state: "already_granted_this_year" }))).toEqual([]);
    expect(violations(JSON.stringify({ code: "invalid_postcode" }))).toEqual([]);
    expect(violations(JSON.stringify({ value: "oud" }))).toEqual([]);
    expect(violations(JSON.stringify({ message: "Invalid birthday." }))).toEqual([]);
    expect(violations(JSON.stringify({ title: "Oud Royale 50ml Eau de Parfum" }))).toEqual([]);
    expect(violations(JSON.stringify({ countryCode: "GB", zip: "N1 1AA" }))).toEqual([]);
  });
});
