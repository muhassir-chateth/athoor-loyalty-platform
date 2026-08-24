/**
 * Tests for the log-field allowlist (task 5.7, Requirements 2.8 and 23.7,
 * design §24.3).
 *
 * The shape of this file follows the gate it protects. The point of an allowlist
 * is that it is total — every key not on the list is dropped — so the load-bearing
 * tests are the STRUCTURAL ones, not a list of examples:
 *
 *   - a property test over arbitrary payloads, asserting the output can only ever
 *     contain emittable keys, at every depth;
 *   - an equality assertion against §24.3, so widening the allowlist breaks a test
 *     that cites the design;
 *   - a runtime gate on the `authChain` exemption, complementing the compile-time
 *     one in `logRedaction.ts`.
 *
 * The example-based tests exist for the cases where the RULE is subtle rather than
 * total: what happens to an exception's message, and what happens to Fastify's own
 * request log.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { InMemoryCustomerResolver } from "../auth/identity.js";
import { createAuthChainTrace } from "../plugins/auth.js";
import {
  AUTH_CHAIN_TRACE_LOG_KEYS,
  PERMITTED_LOG_KEYS,
  REDACTED_ERROR_MESSAGE,
  emittableLogKeys,
  redactLogPayload,
  sanitiseLogArguments,
} from "./logRedaction.js";

/**
 * §24.3, transcribed. Kept as its own literal rather than derived from the
 * implementation, because a test that reads the value under test proves nothing.
 */
const DESIGN_24_3_ALLOWED_KEYS = [
  "requestId",
  "sessionRef",
  "customerId",
  "channel",
  "source",
  "route",
  "method",
  "statusCode",
  "durationMs",
  "errorCode",
  "upstream",
  "upstreamStatus",
  "cacheHit",
  "rateLimited",
  "idempotencyOutcome",
  "coldStartMs",
  "rowCount",
  "pageSize",
  "webhookId",
  "jobName",
  "attempt",
];

/** One field name per row of §24.3's never-logged table. */
const NEVER_LOGGED_FIELDS = [
  "email",
  "firstName",
  "lastName",
  "phone",
  "address",
  "postcode",
  "birthday",
  "birthMonth",
  "birthDay",
  "discountCode",
  "code",
  "referralCode",
  "idempotencyKey",
  "signature",
  "query",
  "accessToken",
  "token",
  "authorization",
  "body",
  "productTitle",
  "orderNumber",
  "orderTotal",
  "points",
  "message",
  "customer",
];

describe("the allowlist mirrors design §24.3", () => {
  it("permits exactly the keys §24.3 lists, in the design's order", () => {
    expect([...PERMITTED_LOG_KEYS]).toEqual(DESIGN_24_3_ALLOWED_KEYS);
  });

  it("can emit nothing beyond the allowlist and the two documented exemptions", () => {
    expect([...emittableLogKeys()]).toEqual([...DESIGN_24_3_ALLOWED_KEYS, "authChain", "err"]);
  });
});

describe("an unknown key is dropped", () => {
  it("drops every field on the never-logged list", () => {
    const payload = Object.fromEntries(NEVER_LOGGED_FIELDS.map((k) => [k, `value-of-${k}`]));
    expect(redactLogPayload(payload)).toEqual({});
  });

  it("drops a key nobody thought of, which is the whole point", () => {
    expect(redactLogPayload({ someFieldInventedNextYear: "secret" })).toEqual({});
  });

  it("drops the object a future `req.log.info({ customer })` would pass", () => {
    const customer = { id: "c-1", email: "bob@example.com", firstName: "Bob" };
    expect(redactLogPayload({ customer })).toEqual({});
  });

  it("keeps the allowlisted fields alongside the dropped ones", () => {
    const out = redactLogPayload({
      customerId: "11111111-1111-4111-8111-111111111111",
      route: "/v1/orders",
      statusCode: 200,
      cacheHit: true,
      email: "bob@example.com",
    });
    expect(out).toEqual({
      customerId: "11111111-1111-4111-8111-111111111111",
      route: "/v1/orders",
      statusCode: 200,
      cacheHit: true,
    });
  });
});

describe("nesting cannot inherit permission from its parent", () => {
  it("drops a forbidden field nested inside a permitted key", () => {
    expect(redactLogPayload({ upstream: { name: "shopify", email: "bob@example.com" } })).toEqual({});
  });

  it("keeps allowlisted names at depth while dropping their siblings", () => {
    const out = redactLogPayload({ upstream: { statusCode: 502, email: "bob@example.com" } });
    expect(out).toEqual({ upstream: { statusCode: 502 } });
  });

  it("drops a forbidden field nested inside the authChain exemption", () => {
    const out = redactLogPayload({
      authChain: { outcome: "identity_resolution_failed", email: "bob@example.com" },
    });
    expect(out).toEqual({ authChain: { outcome: "identity_resolution_failed" } });
  });

  it("filters inside arrays too", () => {
    const out = redactLogPayload({ rowCount: [{ email: "bob@example.com" }, { rowCount: 2 }] });
    expect(JSON.stringify(out)).not.toContain("bob@example.com");
  });
});

describe("the authChain trace survives, filtered against its own fields", () => {
  it("keeps every field the trace declares", () => {
    const trace = createAuthChainTrace("/v1/balance", true);
    const out = redactLogPayload({ authChain: trace });
    expect(out["authChain"]).toEqual({ ...trace });
  });

  /**
   * The runtime half of the exemption gate. `logRedaction.ts` asserts at COMPILE
   * time that the permitted set covers `keyof AuthChainTrace`; this catches a field
   * added to the object literal, so a future `email` on the trace fails an existing
   * test instead of quietly vanishing from the log.
   */
  it("declares no field the allowlist has not reviewed", () => {
    expect(Object.keys(createAuthChainTrace("/v1/x", false)).sort()).toEqual(
      [...AUTH_CHAIN_TRACE_LOG_KEYS].sort(),
    );
  });
});

describe("Fastify's request envelope is projected, not passed through", () => {
  it("strips the query string, which is where the App Proxy signature lives", () => {
    const out = redactLogPayload({
      req: { method: "GET", url: "/v1/balance?signature=SECRET_SIG&logged_in_customer_id=99" },
    });
    expect(out).toEqual({ method: "GET", route: "/v1/balance" });
    expect(JSON.stringify(out)).not.toContain("SECRET_SIG");
    expect(JSON.stringify(out)).not.toContain("logged_in_customer_id");
  });

  it("prefers the matched route pattern over the concrete path", () => {
    const out = redactLogPayload({
      req: { method: "GET", url: "/v1/orders/6001234567", routeOptions: { url: "/v1/orders/:orderId" } },
    });
    expect(out["route"]).toBe("/v1/orders/:orderId");
  });

  it("masks an identifier-shaped segment when no route pattern is available", () => {
    // §24.3 forbids logging an order number, and an unmatched path contains one.
    const out = redactLogPayload({ req: { method: "GET", url: "/v1/orders/6001234567" } });
    expect(out["route"]).toBe("/v1/orders/:id");
  });

  it("maps res.statusCode and responseTime onto the allowlisted names", () => {
    const out = redactLogPayload({ res: { statusCode: 401 }, responseTime: 12.3456789 });
    expect(out).toEqual({ statusCode: 401, durationMs: 12.346 });
  });

  it("never overwrites a field the caller supplied explicitly", () => {
    const out = redactLogPayload({ route: "/explicit", req: { url: "/derived" } });
    expect(out["route"]).toBe("/explicit");
  });

  it("drops a header bag even though it arrives inside the request object", () => {
    const out = redactLogPayload({
      req: { method: "GET", url: "/v1/balance", headers: { authorization: "Bearer tok" } },
    });
    expect(JSON.stringify(out)).not.toContain("Bearer");
  });
});

describe("an error stays diagnosable without carrying its message", () => {
  it("keeps type, code and stack frames; drops the message and the stack header", () => {
    const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      detail: "Key (email)=(bob@example.com) already exists.",
      table: "customers",
      constraint: "customers_email_key",
    });
    const out = redactLogPayload({ err });
    const serialised = JSON.stringify(out);

    expect(out["errorCode"]).toBe("23505");
    expect((out["err"] as Record<string, unknown>)["type"]).toBe("Error");
    expect((out["err"] as Record<string, unknown>)["code"]).toBe("23505");
    expect(String((out["err"] as Record<string, unknown>)["stack"])).toMatch(/^\s+at\s/);

    // The message, and every field a `pg` error uses to quote the offending value.
    expect(serialised).not.toContain("bob@example.com");
    expect(serialised).not.toContain("duplicate key");
    expect(serialised).not.toContain("customers_email_key");
    expect(serialised).not.toContain("customers");
  });

  it("keeps the error class, which is what separates a 500 from an expected 401", () => {
    class ScopeUnavailableError extends Error {
      override readonly name = "ScopeUnavailableError";
      readonly code = "identity_resolution_failed";
    }
    const out = redactLogPayload({ err: new ScopeUnavailableError("no scope for customer bob") });
    expect((out["err"] as Record<string, unknown>)["type"]).toBe("ScopeUnavailableError");
    expect(out["errorCode"]).toBe("identity_resolution_failed");
    expect(JSON.stringify(out)).not.toContain("bob");
  });

  it("refuses a code that is a sentence rather than an identifier", () => {
    const err = Object.assign(new Error("x"), { code: "failed for bob@example.com while saving" });
    const out = redactLogPayload({ err });
    expect(out["errorCode"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("bob@example.com");
  });

  it("is idempotent, because it runs at two choke points", () => {
    const once = redactLogPayload({ err: new Error("secret bob@example.com"), statusCode: 500 });
    expect(redactLogPayload(once)).toEqual(once);
  });
});

describe("the log message cannot carry an exception's text", () => {
  it("substitutes when the message IS the error message (Fastify's 5xx log)", () => {
    const err = new Error("connect ECONNREFUSED bob@example.com:5432");
    const [, message] = sanitiseLogArguments([{ err }, err.message]);
    expect(message).toBe(REDACTED_ERROR_MESSAGE);
  });

  it("substitutes when the message merely interpolates it", () => {
    const err = new Error("bob@example.com not found");
    const [, message] = sanitiseLogArguments([{ err }, `profile write failed: ${err.message}`]);
    expect(message).toBe(REDACTED_ERROR_MESSAGE);
  });

  it("substitutes for `log.error(err)`, where pino would derive the message itself", () => {
    const [payload, message] = sanitiseLogArguments([new Error("boot failed for bob@example.com")]);
    expect(message).toBe(REDACTED_ERROR_MESSAGE);
    expect(JSON.stringify(payload)).not.toContain("bob@example.com");
  });

  it("leaves an authored static message alone", () => {
    const err = new Error("ECONNREFUSED");
    const [, message] = sanitiseLogArguments([{ err }, "lazy enrollment failed; request degraded to 401"]);
    expect(message).toBe("lazy enrollment failed; request degraded to 401");
  });

  it("drops printf-style interpolation arguments, which the allowlist cannot filter", () => {
    expect(sanitiseLogArguments(["customer %s", "bob@example.com"])).toEqual(["customer %s"]);
    expect(sanitiseLogArguments([{ statusCode: 200 }, "saw %s", "bob@example.com"])).toEqual([
      { statusCode: 200 },
      "saw %s",
    ]);
  });
});

/**
 * WHAT THE GATE COSTS THE EXISTING CALL SITES.
 *
 * An allowlist applied to a logger that predates it necessarily drops fields
 * somebody found useful. Recording that here rather than only in a commit message
 * makes the collateral reviewable and stops it being rediscovered as a mystery:
 * these are the payload shapes `index.ts` and `plugins/auth.ts` actually pass
 * today, and this is what now reaches the stream.
 *
 * The pattern is consistent with §24.3's own instruction — "Ledger point amounts
 * alongside `customerId` … no operational value; use counts" — but §24.3's
 * vocabulary for a count is `rowCount`, and these call sites predate it. Each
 * line keeps its level and its authored message, so no alarm is silenced; the
 * numbers are what is lost.
 */
describe("effect on the log call sites that already exist", () => {
  it("keeps customerId and the error class for a degraded-read warning", () => {
    const out = redactLogPayload({ err: new Error("Shopify timeout"), customerId: "c-uuid" });
    expect(out["customerId"]).toBe("c-uuid");
    expect(out["err"]).toBeDefined();
  });

  it("drops shopifyCustomerId, which is not the allowlisted identifier", () => {
    // `customerId` (our internal UUID) is allowlisted; the Shopify-side id is not.
    const out = redactLogPayload({ err: new Error("x"), shopifyCustomerId: "9395357876563" });
    expect(out).not.toHaveProperty("shopifyCustomerId");
    expect(JSON.stringify(out)).not.toContain("9395357876563");
  });

  it("drops the Property 17 watchdog's counts and per-entry ids", () => {
    // Known, deliberate collateral. The ERROR line and its instruction to run
    // scripts/backfill-missing-point-lots.mjs survive; the figures do not, and
    // the script is what names the affected rows anyway. Renaming `count` to the
    // allowlisted `rowCount` at the call site would retain the aggregate — left
    // for the owner, since it is a change to shipped engine boot glue.
    const out = redactLogPayload({
      count: 3,
      pointsAffected: 450,
      entries: [{ ledgerEntryId: "l-1", shopifyCustomerId: "939535", entryType: "earn", points: 150 }],
    });
    expect(out).toEqual({});
  });

  it("would keep the same aggregate under the allowlisted name", () => {
    expect(redactLogPayload({ rowCount: 3 })).toEqual({ rowCount: 3 });
  });

  it("drops the operational one-offs, leaving their authored messages", () => {
    expect(redactLogPayload({ signal: "SIGTERM" })).toEqual({});
    expect(redactLogPayload({ enqueued: 4 })).toEqual({});
  });
});

/* ------------------------------------------------------------------------- */
/* Structural gate: the allowlist is total                                    */
/* ------------------------------------------------------------------------- */

const EMITTABLE = new Set(emittableLogKeys());
const PERMITTED = new Set<string>(PERMITTED_LOG_KEYS);
const AUTH_CHAIN = new Set<string>(AUTH_CHAIN_TRACE_LOG_KEYS);
const ERROR_SHAPE = new Set(["type", "code", "stack"]);

/** Assert every key at every depth of a redacted payload is one the design permits. */
function assertKeysPermitted(value: unknown, allowed: Set<string>): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertKeysPermitted(item, allowed);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    expect(allowed, `unexpected log key "${key}"`).toContain(key);
    if (key === "authChain") {
      assertKeysPermitted(child, AUTH_CHAIN);
    } else if (key === "err") {
      assertKeysPermitted(child, ERROR_SHAPE);
    } else {
      assertKeysPermitted(child, PERMITTED);
    }
  }
}

/**
 * Keys are drawn from a pool rather than free strings so the generator actually
 * reaches the interesting space: the never-logged names, the allowlisted names,
 * and the Fastify envelope names that get projected.
 */
const keyArb = fc.oneof(
  fc.constantFrom(...NEVER_LOGGED_FIELDS),
  fc.constantFrom(...PERMITTED_LOG_KEYS),
  fc.constantFrom("authChain", "err", "req", "res", "responseTime", "reqId", "__proto__", "constructor"),
  fc.string({ minLength: 1, maxLength: 10 }),
);

const leafArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
);

const { node } = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    leafArb,
    fc.array(tie("node"), { maxLength: 3 }),
    fc.dictionary(keyArb, tie("node"), { maxKeys: 4 }),
  ),
}));

const payloadArb = fc.dictionary(keyArb, node, { maxKeys: 8 });

describe("Property: a redacted payload can only contain permitted keys", () => {
  it("holds for arbitrary payloads at arbitrary depth", () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        assertKeysPermitted(redactLogPayload(payload), EMITTABLE);
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent for arbitrary payloads", () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        const once = redactLogPayload(payload);
        expect(redactLogPayload(once)).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * The two alphabets are disjoint on purpose. An earlier version generated both
   * halves from `fc.string()` and failed on `path=" "`, `query=" "` — the route
   * "contained the query" only because the two were the same character. Drawing
   * the query from an alphabet the path cannot produce makes the assertion mean
   * what it says: no query material reaches `route`.
   */
  it("never lets a query string reach the derived route", () => {
    const pathArb = fc
      .array(fc.constantFrom("v1", "orders", "profile", "a", "b"), { minLength: 1, maxLength: 4 })
      .map((segments) => segments.join("/"));
    const queryArb = fc
      .array(fc.constantFrom("Q", "W", "Z", "7", "="), { minLength: 1, maxLength: 20 })
      .map((chars) => `signature=${chars.join("")}`);

    fc.assert(
      fc.property(pathArb, queryArb, (path, query) => {
        const out = redactLogPayload({ req: { method: "GET", url: `/${path}?${query}` } });
        const route = out["route"];
        expect(typeof route).toBe("string");
        expect(route).not.toContain("?");
        expect(route).not.toContain("signature");
        for (const char of new Set(query.replace("signature=", ""))) {
          expect(route).not.toContain(char);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never emits a value that was not reachable through a permitted key", () => {
    const secret = "bob@example.com";
    fc.assert(
      fc.property(fc.constantFrom(...NEVER_LOGGED_FIELDS), node, (key, value) => {
        const out = redactLogPayload({ [key]: value, nested: { [key]: secret }, err: new Error(secret) });
        expect(JSON.stringify(out)).not.toContain(secret);
      }),
      { numRuns: 300 },
    );
  });
});

/* ------------------------------------------------------------------------- */
/* End to end, through the app's real logger                                  */
/* ------------------------------------------------------------------------- */

const APP_PROXY_SECRET = "app-proxy-shared-secret";

function buildLoggingApp(lines: string[]) {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "debug",
    SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET,
  } as NodeJS.ProcessEnv);
  return buildApp(config, {
    customerResolver: new InMemoryCustomerResolver({}),
    logDestination: { write: (line) => lines.push(line.trim()) },
  });
}

function signed(query: QueryParams): string {
  const signature = computeAppProxySignature(query, APP_PROXY_SECRET);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") params.set(key, value);
  }
  params.set("signature", signature);
  return params.toString();
}

describe("the real logger is governed by the allowlist", () => {
  it("writes no App Proxy signature and no logged_in_customer_id for a signed request", async () => {
    const lines: string[] = [];
    const app = buildLoggingApp(lines);
    const query: QueryParams = {
      logged_in_customer_id: "9395357876563",
      timestamp: String(Math.floor(Date.now() / 1000)),
      shop: "myathoorlondon.myshopify.com",
    };
    const signature = computeAppProxySignature(query, APP_PROXY_SECRET);

    const response = await app.inject({ method: "GET", url: `/v1/balance?${signed(query)}` });
    await app.close();

    const output = lines.join("\n");
    expect(response.statusCode).toBe(401);
    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toContain(signature);
    expect(output).not.toContain("9395357876563");
    expect(output).not.toContain("logged_in_customer_id");
    expect(output).not.toContain("myathoorlondon");
  });

  it("still records the request in §24.3's vocabulary", async () => {
    const lines: string[] = [];
    const app = buildLoggingApp(lines);
    await app.inject({ method: "GET", url: "/v1/version" });
    await app.close();

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const incoming = records.find((r) => r["msg"] === "incoming request");
    const completed = records.find((r) => r["msg"] === "request completed");

    expect(incoming).toMatchObject({ requestId: "req-1", method: "GET", route: "/v1/version" });
    expect(completed).toMatchObject({ requestId: "req-1", statusCode: 200 });
    expect(typeof completed?.["durationMs"]).toBe("number");
    // The envelope keys Fastify would otherwise have written.
    expect(incoming).not.toHaveProperty("req");
    expect(completed).not.toHaveProperty("res");
    expect(completed).not.toHaveProperty("responseTime");
    expect(records.every((r) => !("reqId" in r))).toBe(true);
  });

  it("keeps the authChain trace intact, so a 401 stays attributable", async () => {
    const lines: string[] = [];
    const app = buildLoggingApp(lines);
    await app.inject({ method: "GET", url: "/v1/balance" });
    await app.close();

    const trace = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((record) => record["authChain"])
      .find((value): value is Record<string, unknown> => value !== undefined);

    expect(trace).toBeDefined();
    expect(trace).toMatchObject({
      route: "/v1/balance",
      path: "none",
      signatureVerified: false,
      outcome: "identity_resolution_failed",
    });
    expect(Object.keys(trace ?? {}).every((key) => AUTH_CHAIN.has(key))).toBe(true);
  });

  it("keeps a genuine 500 distinguishable from an expected 401", async () => {
    const lines: string[] = [];
    const app = buildLoggingApp(lines);
    app.get("/__boom", async () => {
      throw Object.assign(new Error("upstream said bob@example.com is invalid"), {
        code: "UPSTREAM_REJECTED",
      });
    });

    await app.inject({ method: "GET", url: "/__boom" });
    await app.close();

    const output = lines.join("\n");
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const errorLine = records.find((r) => r["level"] === 50);

    // Diagnosable: the class and code identify it as a real fault, not an auth stop.
    expect(errorLine?.["errorCode"]).toBe("UPSTREAM_REJECTED");
    expect((errorLine?.["err"] as Record<string, unknown>)["type"]).toBe("Error");
    expect(records.some((r) => r["statusCode"] === 500)).toBe(true);
    // …and it carries none of the message.
    expect(output).not.toContain("bob@example.com");
    expect(output).not.toContain("upstream said");
  });

  it("drops a forbidden field a handler logs by mistake", async () => {
    const lines: string[] = [];
    const app = buildLoggingApp(lines);
    app.get("/__leak", async (req) => {
      req.log.info(
        { customer: { email: "bob@example.com", firstName: "Bob" }, statusCode: 200 },
        "handler log",
      );
      return { ok: true };
    });

    await app.inject({ method: "GET", url: "/__leak" });
    await app.close();

    const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r["msg"] === "handler log");
    expect(line).toBeDefined();
    expect(line).not.toHaveProperty("customer");
    expect(line?.["statusCode"]).toBe(200);
    expect(lines.join("\n")).not.toContain("bob@example.com");
  });
});
