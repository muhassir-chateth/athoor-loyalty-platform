// Feature: customer-experience-portal, task 16.5: no existence oracle and error shape
/**
 * TASK 16.5 — the no-existence-oracle and error-shape contracts.
 * Validates Requirements 2.2 and 2.7, design E.1 rules 1/2/6 and the E.2 taxonomy.
 *
 * Two obligations, both cross-endpoint:
 *
 *   1. NO EXISTENCE ORACLE. A foreign-but-real identifier and a random identifier
 *      produce byte-identical bodies. If they differ, the difference IS the answer
 *      to "does this resource exist?" — and an attacker who can ask that question
 *      about `customer_id` values can enumerate the customer base without ever
 *      reading a single record. §4.5 case 14 covers one instance of this; here it is
 *      a property over every customer-scoped identifier the API accepts.
 *
 *   2. THE ERROR ENVELOPE IS CLOSED. Every error body is `{ error, message }` with
 *      an identifier from the E.2 taxonomy, and carries no stack trace, SQL text,
 *      table name or connection detail.
 *
 * ── WHAT THIS TEST FOUND WHEN IT WAS FIRST RUN ──────────────────────────────
 * Obligation 2 was NOT met, in two ways, and both are fixed in
 * `auth/customerScope.ts` rather than accommodated here:
 *
 *   (a) A 500 forwarded `err.message` to the customer. With a realistic Postgres
 *       failure the response body contained the SQL statement, the table name and
 *       an absolute server path from the stack — a direct breach of Req 2.7 and of
 *       E.1 rule 2, reachable from every endpoint whose dependency throws.
 *
 *   (b) Four framework-level paths answered in Fastify's default envelope
 *       (`{statusCode, code: "FST_ERR_CTP_…", error: "Bad Request"}`) instead of the
 *       portal's: `content-type: application/json` with an empty body, malformed
 *       JSON, an unsupported media type, and an over-size body. `error` was then a
 *       string no client copy map contains, and the body named the framework and
 *       its internal error code — pre-authentication.
 *
 * The regression guards for both are `no 500 body carries internals` and
 * `the framework's own error paths answer in the portal envelope` below.
 *
 * SAFETY: in-memory only. No network, no database, no production.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import { BenefitNotQualifiedError } from "../benefits/entitlementResolver.js";
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
  type HarnessRoute,
} from "../testing/portalHarness.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/* ========================================================================== *
 * The closed identifier set
 * ========================================================================== */

/**
 * Design E.2's taxonomy, transcribed. This is the set task 16.5 names as "the
 * closed identifier set of `## Error Handling`" — deliberately the DESIGN's set and
 * not `PortalErrorCode`, which types.ts documents as the narrower N1–N16 subset.
 */
const E2_TAXONOMY: ReadonlySet<string> = new Set([
  "app_proxy_signature_invalid",
  "identity_resolution_failed",
  "app_proxy_verification_unavailable",
  "invalid_request",
  "invalid_idempotency_key",
  "invalid_pagination",
  "invalid_order_reference",
  "not_found",
  "order_not_found",
  "birthday_not_set",
  "address_not_found",
  "unknown_referral_code",
  "reward_channel_not_allowed",
  "conflict",
  "insufficient_points",
  "self_referral_rejected",
  "referral_already_claimed",
  "referral_not_eligible",
  "birthday_change_locked",
  "wishlist_limit_reached",
  "rate_limit_exceeded",
  "upstream_unavailable",
  "lock_timeout",
  "service_unavailable",
  "internal_error",
  "section_render_failed",
]);

/**
 * Identifiers the portal endpoints emit that E.2's table does not list, each with
 * the reason it stays.
 *
 * WHY THIS LIST EXISTS RATHER THAN A RENAME. E.1 rule 1 makes identifiers "stable
 * across releases" — a client maps each one to a designed state, so renaming a
 * shipped identifier is a breaking change to a contract this task is meant to
 * VERIFY, not revise. These predate the portal design's taxonomy table.
 *
 * WHY IT IS A DECLARED MAP RATHER THAN A LOOSER ASSERTION. The check below is
 * `observed ⊆ E2 ∪ these`. A newly invented identifier is therefore a test
 * failure, which is the property worth having: the set stays closed, and widening
 * it is a deliberate, reviewed edit with a stated reason.
 */
const DOCUMENTED_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [
    "invalid_device_registration",
    "N16 device registration, shipped before E.2 was written; the body carries no token.",
  ],
  ["invalid_device_token", "N16 device de-registration; the counterpart of the above."],
  ["invalid_reward", "POST /v1/redeem, Req 3.10 — predates the portal taxonomy."],
  ["customer_not_found", "POST /v1/redeem — the redemption engine's own typed error."],
  ["entitlement_not_qualified", "Benefits entitlement, Req 18.x — a designed 403 state."],
  ["entitlement_channel_not_allowed", "Benefits entitlement — the channel-restricted case."],
  ["membership_service_unavailable", "Membership card signing key absent; fails closed."],
  ["app_proxy_request_expired", "The App Proxy freshness window; a sibling of signature_invalid."],
  ["idempotency_scope_unavailable", "The /v1 idempotency plugin, when identity is unresolved."],
]);

/**
 * Keys permitted in an error body.
 *
 * E.2's preamble allows "`{ error, message }` plus endpoint-specific fields", so the
 * check cannot be "exactly two keys". Each addition below is a DESIGNED field with
 * the requirement that asks for it, which keeps the envelope closed while allowing
 * the ones the design actually specifies:
 *
 *   `fields`             400 field-level rejections (E.1 rule 4)
 *   `retryAfterSeconds`  429, drives the client's countdown (E.2)
 *   `allowedFrom`        409 `birthday_change_locked`, the date a change reopens
 *   `retryable`          502/503, E.2's "Retry offered" column made machine-readable
 *   `requiredTier`       403 `entitlement_not_qualified`, Req 18.6 — tells the member
 *   `currentTier`        403, the member's own tier, alongside the above
 *   `requiredChannel`    403 `entitlement_channel_not_allowed`, Req 19.4
 *   `apiVersion`         injected into every payload by the versioning plugin
 */
const PERMITTED_ERROR_KEYS: ReadonlySet<string> = new Set([
  "error",
  "message",
  "fields",
  "retryAfterSeconds",
  "allowedFrom",
  "retryable",
  "requiredTier",
  "currentTier",
  "requiredChannel",
  "apiVersion",
]);

/* ========================================================================== *
 * The internals scanner
 * ========================================================================== */

/**
 * Every table in the schema, read from the migrations rather than hand-listed, so
 * a table added by a later migration is covered without anyone remembering to.
 */
function schemaTableNames(): readonly string[] {
  const dir = join(process.cwd(), "migrations");
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      const name = (match[1] ?? "").toLowerCase();
      // `CREATE TABLE … AS SELECT` yields the keyword, not a name.
      if (name.length >= 4 && name !== "as") names.add(name);
    }
  }
  return [...names];
}

const TABLE_NAMES = schemaTableNames();

/**
 * Shapes that must never appear in a response body.
 *
 * WHY SQL *SHAPES* AND NOT THE DESIGN'S BARE-WORD REGEX. Design §"Information
 * leakage in responses" suggests `/(select|from|pg_|relation|ECONNREFUSED|at
 * .*\.ts:)/i`. Its `select` and `from` alternatives match ordinary English — a
 * message containing "the date from which a change is permitted" would trip it —
 * so the same intent is expressed here as statement shapes, which cannot occur in
 * prose. `pg_`, `relation "`, `ECONNREFUSED` and the stack-frame form are kept
 * verbatim because those DO only occur in leaked internals.
 */
const INTERNALS_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "a SELECT statement", pattern: /\bselect\b[\s\S]{0,120}?\bfrom\b/i },
  { label: "an INSERT statement", pattern: /\binsert\s+into\b/i },
  { label: "an UPDATE statement", pattern: /\bupdate\b[\s\S]{0,60}?\bset\b/i },
  { label: "a DELETE statement", pattern: /\bdelete\s+from\b/i },
  { label: "a Postgres relation error", pattern: /\brelation\s+\\?"/i },
  { label: "a pg_ catalogue reference", pattern: /\bpg_[a-z_]+/i },
  { label: "a named constraint", pattern: /\bconstraint\s+\\?"/i },
  { label: "an ON CONFLICT clause", pattern: /\bon\s+conflict\b/i },
  { label: "a connection string", pattern: /postgres(?:ql)?:\/\//i },
  { label: "a socket error code", pattern: /\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT|NOTFOUND|HOSTUNREACH)\b/ },
  { label: "a stack frame", pattern: /\bat\s+[^\n]{0,80}\.(?:ts|js|mjs|cjs):\d+/i },
  { label: "an absolute server path", pattern: /(?:^|[\s"'(])\/(?:app|Users|home|usr|var|opt)\// },
  { label: "a node_modules path", pattern: /node_modules/ },
  { label: "a SQL parameter placeholder", pattern: /\$\d+\b/ },
];

/** Every internals violation in a response body. */
function internalsIn(body: string): string[] {
  const found: string[] = [];
  for (const { label, pattern } of INTERNALS_PATTERNS) {
    if (pattern.test(body)) found.push(`${label}: ${body.slice(0, 120)}`);
  }
  for (const table of TABLE_NAMES) {
    if (new RegExp(`\\b${table}\\b`).test(body)) {
      found.push(`table name "${table}": ${body.slice(0, 120)}`);
    }
  }
  return found;
}

/* ========================================================================== *
 * Request batteries
 * ========================================================================== */

/**
 * The customer-scoped path parameters — the ones where "does it exist?" is a
 * question about ANOTHER CUSTOMER's data.
 *
 * `:productId`, `:id` (a product id) and `:key` (a benefit key) are deliberately
 * excluded: products and benefits are GLOBAL catalogue data, so a difference
 * between a real and an unknown product discloses nothing private — the catalogue
 * is public. Including them would assert something false and pressure a correct
 * handler into hiding public information. Same reasoning that kept product ids out
 * of the harness's `B_SECRETS`.
 */
const SCOPED_PARAMS = [":orderId", ":addressId", ":token", ":customerId"] as const;

function isScoped(url: string): boolean {
  return SCOPED_PARAMS.some((p) => url.includes(p));
}

/** A syntactically valid UUID that belongs to no customer in the fixture. */
const UNKNOWN_CUSTOMER_ID = "3f2a9c14-7b6d-4e58-9a01-2c5d8e7f0b43";

/**
 * The concrete value `concretise` substitutes for one parameter, for one customer.
 *
 * Derived from the harness rather than restated, so changing a fixture id cannot
 * leave this test comparing against a value the API no longer uses.
 */
function paramValue(param: string, customer: typeof A | typeof B): string {
  return concretise(`/${param}`, customer).slice(1);
}

/** Substitutes a well-formed but nonexistent value for each scoped parameter. */
function concretiseUnknown(url: string, orderId: string, addressId: string, token: string): string {
  const values: Record<string, string> = {
    ":orderId": orderId,
    ":addressId": addressId,
    ":token": token,
    ":customerId": UNKNOWN_CUSTOMER_ID,
    ":productId": "1001",
    ":id": "1001",
    ":key": "perk",
  };
  return url
    .split("/")
    .map((seg) => (seg.startsWith(":") ? (values[seg] ?? "x") : seg))
    .join("/");
}

/**
 * Removes what legitimately differs between two otherwise identical responses:
 * the identifier the CALLER supplied (echoing input discloses nothing the caller
 * did not already know), a timestamp, and the idempotency key.
 */
function normalise(body: string, supplied: readonly string[]): string {
  let out = body;
  for (const value of supplied) {
    if (value.length > 0) out = out.split(value).join("<SUPPLIED>");
  }
  return out
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<TS>")
    .replace(/harness-\d+-[a-z0-9]+/g, "<KEY>");
}

/** The malformed/hostile request battery, applied to every route. */
function battery(route: HarnessRoute): { label: string; headers: Record<string, string>; url: string; payload?: unknown }[] {
  const own = concretise(route.url, A);
  return [
    { label: "unauthenticated", headers: {}, url: own },
    { label: "unparseable bearer", headers: { authorization: "Bearer nope" }, url: own },
    { label: "empty bearer", headers: { authorization: "Bearer " }, url: own },
    { label: "foreign identifier", headers: bearer(A), url: concretise(route.url, B) },
    { label: "unknown identifier", headers: bearer(A), url: own.replace(/\d{4,}/, "424242424") },
    { label: "wrong-type body", headers: bearer(A), url: own, payload: "a bare string" },
    { label: "array body", headers: bearer(A), url: own, payload: [1, 2, 3] },
    { label: "nonsense keys", headers: bearer(A), url: own, payload: { nonsense: true, x: null } },
    { label: "out-of-range values", headers: bearer(A), url: own, payload: { month: 99, day: -1 } },
    { label: "bad idempotency key", headers: { ...bearer(A), "idempotency-key": "" }, url: own },
  ];
}

async function sweep(
  harness: Awaited<ReturnType<typeof buildHarness>>,
  onResponse: (route: HarnessRoute, label: string, status: number, body: string) => void,
): Promise<void> {
  for (const route of portalRoutes(harness.routes)) {
    const hasBody = BODY_METHODS.has(route.method);
    for (const variant of battery(route)) {
      const res = await harness.app.inject({
        method: route.method as "GET",
        url: variant.url,
        headers: {
          ...variant.headers,
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...(hasBody && !("idempotency-key" in variant.headers)
            ? { "idempotency-key": idempotencyKey() }
            : {}),
        },
        ...(hasBody ? { payload: JSON.stringify(variant.payload ?? bodyFor(route.url)) } : {}),
      });
      onResponse(route, variant.label, res.statusCode, res.body);
    }
  }
}

/* ========================================================================== *
 * 1. No existence oracle (Req 2.2, E.1 rule 6)
 * ========================================================================== */

describe("no existence oracle", () => {
  it("Property: a foreign-but-real identifier and a random one are byte-identical", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const targets = portalRoutes(harness.routes).filter((r) => isScoped(r.url));
    // If this is 0 the property is vacuous, and a refactor that renames a path
    // parameter would silence it without anyone noticing.
    expect(targets.length, "no customer-scoped parameterised routes found").toBeGreaterThan(0);

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: targets.length - 1 }),
        // Well-formed, SAME SHAPE as a real one, and belonging to nobody.
        //
        // The width and the range both matter. A first draft generated any 1–4 digit
        // address id and failed on `1` — which is A's OWN address, so the "unknown"
        // request was really a request for the caller's own record and the two bodies
        // differed for a legitimate reason. Same trap as a marker that is a substring
        // of another marker: the generator has to be disjoint from the fixtures by
        // construction, not by luck.
        fc.integer({ min: 100_000, max: 999_999 }).map((n) => `6${n}`),
        fc.integer({ min: 2_000, max: 8_999 }).map((n) => `${n}`),
        // Hex cannot spell either marker (`AAMARKERAA`, `ZZVICTIMZZ`).
        fc.hexaString({ minLength: 10, maxLength: 10 }).map((s) => `device-token-${s}`),
        async (routeIndex, orderId, addressId, token) => {
          const route = targets[routeIndex] as HarnessRoute;
          const hasBody = BODY_METHODS.has(route.method);
          const send = async (url: string) =>
            harness.app.inject({
              method: route.method as "GET",
              url,
              headers: {
                ...bearer(A),
                ...(hasBody ? { "content-type": "application/json" } : {}),
                ...(hasBody ? { "idempotency-key": idempotencyKey() } : {}),
              },
              ...(hasBody ? { payload: JSON.stringify(bodyFor(route.url)) } : {}),
            });

          const foreignUrl = concretise(route.url, B);
          const unknownUrl = concretiseUnknown(route.url, orderId, addressId, token);
          const foreign = await send(foreignUrl);
          const unknown = await send(unknownUrl);

          // Only the identifiers the CALLER supplied are neutralised. Echoing an
          // input back discloses nothing the caller did not already know, and
          // narrowing this to the parameter values (rather than every path segment)
          // keeps the comparison sensitive to everything else.
          const supplied = [
            ...SCOPED_PARAMS.map((param) => paramValue(param, B)),
            orderId,
            addressId,
            token,
            UNKNOWN_CUSTOMER_ID,
          ];

          expect(
            unknown.statusCode,
            `${route.method} ${route.url}: status differs between a real foreign id and an unknown one`,
          ).toBe(foreign.statusCode);
          expect(
            normalise(unknown.body, supplied),
            `${route.method} ${route.url}: body differs between a real foreign id and an unknown one`,
          ).toBe(normalise(foreign.body, supplied));
        },
      ),
      { numRuns: 120 },
    );
  });

  it("is NON-VACUOUS: the comparison really does distinguish different bodies", async () => {
    // Proves `normalise` has not been written so loosely that everything matches.
    const a = normalise('{"order":{"number":"7770001"},"total":"25.00"}', []);
    const b = normalise('{"error":"order_not_found","message":"x"}', []);
    expect(a).not.toBe(b);
    // And that it DOES neutralise the two things it is supposed to.
    expect(normalise('{"at":"2024-01-01T00:00:00Z"}', [])).toBe(normalise('{"at":"2025-06-06T12:30:00Z"}', []));
    expect(normalise('{"id":"abc"}', ["abc"])).toBe(normalise('{"id":"xyz"}', ["xyz"]));
  });
});

/* ========================================================================== *
 * 2. The error envelope (Req 2.7, E.1 rules 1/2)
 * ========================================================================== */

describe("the error envelope is closed", () => {
  it("every error body is { error, message } with an identifier from the closed set", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const failures: string[] = [];
    const seen = new Set<string>();

    await sweep(harness, (route, label, status, body) => {
      if (status < 400) return;
      const where = `${route.method} ${route.url} [${label}] ${status}`;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        failures.push(`${where}: body is not JSON: ${body.slice(0, 80)}`);
        return;
      }
      for (const key of Object.keys(parsed)) {
        // The not-found handler adds `statusCode` deliberately (app.ts, task 5.8):
        // it names the status without echoing what was asked for.
        if (key === "statusCode" && status === 404) continue;
        if (!PERMITTED_ERROR_KEYS.has(key)) failures.push(`${where}: undeclared key "${key}"`);
      }
      const code = parsed.error;
      if (typeof code !== "string") {
        failures.push(`${where}: "error" is not a string`);
      } else {
        seen.add(code);
        if (!E2_TAXONOMY.has(code) && !DOCUMENTED_EXTENSIONS.has(code)) {
          failures.push(`${where}: identifier "${code}" is outside the closed set`);
        }
      }
      if (typeof parsed.message !== "string" || parsed.message.length === 0) {
        failures.push(`${where}: "message" is missing or empty`);
      }
    });

    expect(failures, `error envelope violations:\n${failures.join("\n")}`).toEqual([]);
    // Non-vacuity: the sweep must actually have produced errors to inspect.
    expect(seen.size, "the sweep produced no error bodies at all").toBeGreaterThan(2);
  });

  it("no error body carries a stack trace, SQL, a table name or a connection detail", async () => {
    const harness = await buildHarness();
    app = harness.app;
    const failures: string[] = [];
    await sweep(harness, (route, label, status, body) => {
      if (status < 400) return;
      for (const violation of internalsIn(body)) {
        failures.push(`${route.method} ${route.url} [${label}] ${status}: ${violation}`);
      }
    });
    expect(failures, `internals leaked in an error body:\n${failures.join("\n")}`).toEqual([]);
  });

  it("no 500 body carries internals, even when the failure is a raw Postgres error", async () => {
    // THE REGRESSION GUARD for finding (a). Before the fix in
    // `auth/customerScope.ts`, this body was the exception's own message and
    // contained every one of the four things Req 2.7 forbids.
    const pgFailure = new Error(
      'relation "ledger_entries" does not exist\n' +
        "    at Parser.parseErrorMessage (/app/node_modules/pg-protocol/dist/parser.js:369:69)\n" +
        "QUERY: SELECT points, customer_id FROM ledger_entries WHERE customer_id = $1",
    );
    const harness = await buildHarness({
      balanceSource: {
        load: () => Promise.reject(pgFailure),
      } as never,
    });
    app = harness.app;

    const res = await harness.app.inject({ method: "GET", url: "/v1/balance", headers: bearer(A) });
    expect(res.statusCode).toBe(500);
    expect(internalsIn(res.body), `500 body leaked internals: ${res.body}`).toEqual([]);
    expect(res.json()).toMatchObject({ error: "internal_error" });
    // E.2 requires the 500 class to carry the request reference (§22.9, §24.2).
    expect(res.headers["x-request-id"], "no request reference on the 500").toBeDefined();
    // And the scanner must be able to see the leak it is guarding against, or the
    // assertion above proves nothing.
    expect(internalsIn(pgFailure.message).length).toBeGreaterThan(3);
  });

  it("the framework's own error paths answer in the portal envelope", async () => {
    // THE REGRESSION GUARD for finding (b). Each of these is raised by Fastify
    // before any handler runs, and each previously escaped as
    // `{statusCode, code: "FST_ERR_CTP_…", error: "Bad Request"}`.
    const harness = await buildHarness();
    app = harness.app;
    const cases: readonly [string, Record<string, string>, string | undefined][] = [
      ["empty body with a JSON content-type", { "content-type": "application/json" }, undefined],
      ["malformed JSON", { "content-type": "application/json" }, "{not json"],
      ["a form-encoded write", { "content-type": "application/x-www-form-urlencoded" }, "month=6"],
      ["a multipart write", { "content-type": "multipart/form-data; boundary=x" }, "--x--"],
      ["no content-type at all", {}, '{"month":6,"day":10}'],
    ];
    for (const [label, headers, payload] of cases) {
      const res = await harness.app.inject({
        method: "PUT",
        url: "/v1/profile/birthday",
        headers: { ...bearer(A), ...headers, "idempotency-key": idempotencyKey() },
        ...(payload === undefined ? {} : { payload }),
      });
      // Task 16.6 requires 400 specifically for the form-encoded case; the whole
      // family is one fact — the request was not readable — so all five answer 400.
      expect(res.statusCode, label).toBe(400);
      const body = res.json() as Record<string, unknown>;
      expect(body.error, label).toBe("invalid_request");
      expect(typeof body.message, label).toBe("string");
      expect(Object.keys(body).sort(), label).toEqual(["apiVersion", "error", "message"]);
      expect(res.body, label).not.toContain("FST_ERR");
      expect(res.body, label).not.toContain("statusCode");
    }
  });

  it("an unauthenticated request to any route returns the SAME body", async () => {
    // A per-route difference in the 401 would itself be an oracle: it tells an
    // anonymous caller which routes exist and which of them recognised the target.
    const harness = await buildHarness();
    app = harness.app;
    const bodies = new Map<string, string[]>();
    for (const route of portalRoutes(harness.routes)) {
      const res = await harness.app.inject({
        method: route.method as "GET",
        url: concretise(route.url, A),
      });
      const key = `${res.statusCode} ${res.body}`;
      bodies.set(key, [...(bodies.get(key) ?? []), `${route.method} ${route.url}`]);
    }
    expect(
      [...bodies.keys()],
      `unauthenticated responses differ by route:\n${[...bodies.entries()]
        .map(([k, v]) => `${k} <- ${v.join(", ")}`)
        .join("\n")}`,
    ).toHaveLength(1);
  });
});

/* ========================================================================== *
 * 3. Every status class the portal can emit (Req 26.5)
 * ========================================================================== */

/**
 * Req 26.5 requires the suite to cover 400, 401, 403, 404, 429 and 500. The sweep
 * above reaches 400/401/404 naturally and the Postgres case reaches 500; 403, 429
 * and 502 need a condition the happy-path harness never produces, so they are
 * constructed here. Each is checked for the SAME two things as the sweep — a closed
 * identifier, and no internals — because the classes that are hardest to reach are
 * exactly the ones most likely to carry an unmapped upstream string.
 */
describe("every status class answers in the portal envelope", () => {
  const assertEnvelope = (label: string, status: number, body: string): void => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const code = parsed.error;
    expect(typeof code, `${label}: no identifier`).toBe("string");
    expect(
      E2_TAXONOMY.has(code as string) || DOCUMENTED_EXTENSIONS.has(code as string),
      `${label}: identifier "${String(code)}" is outside the closed set`,
    ).toBe(true);
    expect(typeof parsed.message, `${label}: no message`).toBe("string");
    for (const key of Object.keys(parsed)) {
      if (key === "statusCode" && status === 404) continue;
      expect(PERMITTED_ERROR_KEYS.has(key), `${label}: undeclared key "${key}"`).toBe(true);
    }
    expect(internalsIn(body), `${label}: leaked internals`).toEqual([]);
  };

  it("403 — a benefit the member does not qualify for", async () => {
    const harness = await buildHarness({
      entitlementResolver: {
        resolveBenefits: () => Promise.resolve([]),
        qualifies: () => Promise.resolve(false),
        requestBenefit: () =>
          Promise.reject(new BenefitNotQualifiedError("perk", "gold" as never, "silver" as never)),
      } as never,
    });
    app = harness.app;
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/benefits/perk/request",
      headers: { ...bearer(A), "idempotency-key": idempotencyKey() },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    assertEnvelope("403 benefit", res.statusCode, res.body);
    // Req 18.6: the member is told what WOULD qualify them.
    expect(res.json()).toMatchObject({ requiredTier: "gold", currentTier: "silver" });
  });

  it("429 — the route limiter, with a countdown and no limiter internals", async () => {
    const harness = await buildHarness({}, { rateLimit: { maxRequests: 1 } });
    app = harness.app;
    const send = async () =>
      harness.app.inject({
        method: "PUT",
        url: "/v1/profile/birthday",
        headers: { ...bearer(A), "idempotency-key": idempotencyKey() },
        payload: { month: 6, day: 10 },
      });
    await send();
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    assertEnvelope("429 birthday", limited.statusCode, limited.body);
    expect(limited.json()).toMatchObject({ error: "rate_limit_exceeded" });
    expect(typeof (limited.json() as { retryAfterSeconds?: unknown }).retryAfterSeconds).toBe(
      "number",
    );
    // E.2: the body must not carry "the word rate limit, limiter internals".
    // This assertion FOUND a deviation: the message published the configured
    // ceiling and the window length ("at most 1 are permitted per 3600-second
    // window"), which is the pair an attacker needs to pace requests under the
    // limit. Fixed in `plugins/rateLimit.ts`; this is its regression guard.
    expect(limited.body).not.toMatch(/at most|per \d+-second|window|bucket|maxRequests|limiter/i);
    expect(limited.body).not.toMatch(/rate limit/i);
  });

  it("502 — an upstream failure never forwards Shopify's own text", async () => {
    // The harness's failure message deliberately contains an email address, which is
    // what a forwarded upstream string would leak.
    const harness = await buildHarness({}, { failUpstream: true });
    app = harness.app;
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/profile/identity",
      headers: bearer(A),
    });
    expect(res.statusCode).toBe(502);
    assertEnvelope("502 identity", res.statusCode, res.body);
    expect(res.json()).toMatchObject({ error: "upstream_unavailable" });
    expect(res.body, "forwarded upstream text").not.toContain("bob@example.com");
    expect(res.body, "forwarded upstream text").not.toContain("Shopify said");
  });
});

/* ========================================================================== *
 * 4. The scanner and the declared sets
 * ========================================================================== */

describe("the contract's own inputs are sound", () => {
  it("read the real schema, so the table-name scan is not empty", () => {
    expect(TABLE_NAMES.length).toBeGreaterThan(20);
    expect(TABLE_NAMES).toContain("ledger_entries");
    expect(TABLE_NAMES).toContain("customer_erasure_requests");
  });

  it("the documented extensions do not overlap or duplicate E.2", () => {
    for (const code of DOCUMENTED_EXTENSIONS.keys()) {
      expect(E2_TAXONOMY.has(code), `"${code}" is already in E.2 — remove the extension`).toBe(false);
      expect((DOCUMENTED_EXTENSIONS.get(code) ?? "").length, `"${code}" has no reason`).toBeGreaterThan(20);
    }
  });

  it("is NON-VACUOUS: the internals scanner catches each class of leak", () => {
    expect(internalsIn('{"m":"SELECT points FROM ledger_entries WHERE id = 1"}')).not.toEqual([]);
    expect(internalsIn('{"m":"INSERT INTO customers (email) VALUES ($1)"}')).not.toEqual([]);
    expect(internalsIn('{"m":"UPDATE customers SET email = $1"}')).not.toEqual([]);
    expect(internalsIn('{"m":"DELETE FROM referrals"}')).not.toEqual([]);
    expect(internalsIn('{"m":"relation \\"customers\\" does not exist"}')).not.toEqual([]);
    expect(internalsIn('{"m":"permission denied for pg_catalog"}')).not.toEqual([]);
    expect(internalsIn('{"m":"violates constraint \\"x_pkey\\""}')).not.toEqual([]);
    expect(internalsIn('{"m":"connect ECONNREFUSED 10.0.0.1:5432"}')).not.toEqual([]);
    expect(internalsIn('{"m":"    at Foo.bar (/app/src/db/pool.ts:12:9)"}')).not.toEqual([]);
    expect(internalsIn('{"m":"postgres://user:pw@host:5432/db"}')).not.toEqual([]);
    expect(internalsIn('{"m":"/app/node_modules/pg/lib/client.js"}')).not.toEqual([]);
    expect(internalsIn('{"m":"idempotency_keys row missing"}')).not.toEqual([]);
    // And does NOT fire on a legitimate portal error body.
    expect(
      internalsIn('{"error":"order_not_found","message":"That order is not available on this account."}'),
    ).toEqual([]);
    expect(
      internalsIn('{"error":"invalid_request","message":"The request could not be read.","apiVersion":"v1"}'),
    ).toEqual([]);
    expect(
      internalsIn('{"error":"internal_error","message":"The request could not be completed."}'),
    ).toEqual([]);
  });
});
