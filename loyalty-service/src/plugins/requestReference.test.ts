/**
 * The request reference — design §24.2, §22.9.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * §24.2 asks the service to return `x-request-id` on every response so "a customer
 * can quote eight characters and support can find the exact request in the log
 * stream". Two things stood in the way:
 *
 *   1. The header was set on the 500 path only, so a customer degraded by a 502, a
 *      429, a 404 or a timeout got no reference. The client hides the slot when the id
 *      is absent, so the feature was dark rather than visibly broken.
 *
 *   2. Fastify's default `req.id` is a per-process counter — `req-1`, `req-2`. The
 *      client's `shortReference` turns that into `req1`: four characters, restarting
 *      from 1 on every boot. Returning it would have made §24.2's promise FALSE.
 *
 * The second is why the header alone was never the fix, and it also affected something
 * already live: `routes/privacy.ts` derives the customer-facing GDPR erasure reference
 * from the same id, so it was issuing `ERASE-REQ1`.
 *
 * SAFETY: `app.inject` only. No network, no database, no Shopify call.
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_LENGTH,
  generateRequestId,
  registerRequestReference,
} from "./requestReference.js";
import { erasureReference } from "../routes/privacy.js";

/* ========================================================================== *
 * The generated id
 * ========================================================================== */

describe("the generated request id can actually identify a request", () => {
  it("is 12 lowercase letters", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateRequestId()).toMatch(/^[a-z]{12}$/);
    }
    expect(REQUEST_ID_LENGTH).toBe(12);
  });

  it("does not repeat across many generations, unlike a per-process counter", () => {
    // The property the counter lacked is not uniqueness within one boot — a counter
    // has that — but uniqueness ACROSS boots. A random id has both, and a collision
    // here would mean the generator is not random at all.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(generateRequestId());
    expect(seen.size).toBe(20_000);
  });

  it("survives the client's shortening as eight usable characters", () => {
    // `render/states.ts`: `requestId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)`.
    const shorten = (id: string): string => id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
    const shortened = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) shortened.add(shorten(generateRequestId()));
    // Eight letters of entropy is 26^8 ~ 2.1e11, so 5,000 draws should not collide.
    expect(shortened.size).toBe(5_000);
    for (const short of shortened) expect(short).toHaveLength(8);
  });

  it("is NON-VACUOUS: Fastify's default id fails both of those properties", () => {
    // Reproduces the default so this file demonstrably asserts a change. A counter
    // shortens to four characters and restarts from 1 on the next boot, which is what
    // made §24.2's "find the exact request" undeliverable.
    const shorten = (id: string): string => id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
    let counter = 0;
    const defaultId = (): string => `req-${String((counter += 1))}`;

    expect(shorten(defaultId())).toBe("req1");
    expect(shorten(defaultId())).toBe("req2");
    // A restart: the same references are handed out again.
    counter = 0;
    expect(shorten(defaultId())).toBe("req1");

    // Four characters, not eight.
    expect(shorten("req-1")).toHaveLength(4);
    expect(shorten(generateRequestId())).toHaveLength(8);
  });
});

/* ========================================================================== *
 * The log-capture gate's forbidden shapes
 * ========================================================================== */

describe("the id can never form a shape the log-capture gate forbids", () => {
  /**
   * Transcribed from `observability/logCapture.gate.test.ts`. `requestId` appears on
   * every log line, so an id that accidentally formed one of these would fail the
   * build on a particular request rather than on a code change — the worst kind of
   * flake to diagnose. Each is ruled out structurally, and this asserts that.
   */
  const FORBIDDEN = [
    { kind: "long_digit_run", pattern: /\d{9,}/ },
    { kind: "hex_digest", pattern: /\b[0-9a-f]{32,}\b/i },
    {
      kind: "uuid",
      pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    },
    { kind: "uk_postcode", pattern: /\b[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}\b/ },
    { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
    { kind: "database_uri", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i },
  ] as const;

  it("matches none of them, over many ids", () => {
    for (let i = 0; i < 5_000; i += 1) {
      const id = generateRequestId();
      for (const { kind, pattern } of FORBIDDEN) {
        expect(pattern.test(id), `id "${id}" matched ${kind}`).toBe(false);
      }
    }
  });

  it("rules them out STRUCTURALLY, not by luck", () => {
    // The reasoning, asserted rather than left in a comment. If the charset ever gains
    // a digit these become false and this test says so.
    const id = generateRequestId();
    expect(/\d/.test(id), "the alphabet contains a digit — the digit-run risk returns").toBe(false);
    expect(id).toHaveLength(12);
    // A hex digest needs 32 characters; the id is 12, so length alone forbids it.
    expect(id.length).toBeLessThan(32);
    // A UUID needs hyphens and digits.
    expect(id).not.toContain("-");
    // The postcode pattern is uppercase-only and needs digits.
    expect(id).toBe(id.toLowerCase());
  });

  it("is NON-VACUOUS: the forbidden patterns really do match what they describe", () => {
    // Otherwise the loop above would pass over any id at all.
    const probes: Record<string, string> = {
      long_digit_run: "1234567890",
      hex_digest: "a".repeat(32),
      uuid: "0b3f4c2e-1111-4222-8333-444455556666",
      uk_postcode: "SW1A 1AA",
      email: "someone@example.invalid",
      database_uri: "postgres://host/db",
    };
    for (const { kind, pattern } of FORBIDDEN) {
      expect(pattern.test(probes[kind] as string), `${kind} pattern is unsatisfiable`).toBe(true);
    }
    // And a mixed alphanumeric id of this length COULD form a digit run, which is the
    // reason the charset excludes digits.
    expect(/\d{9,}/.test("a123456789bc")).toBe(true);
  });
});

/* ========================================================================== *
 * The header, on every response
 * ========================================================================== */

describe("x-request-id is returned on EVERY response, not only a 500", () => {
  /** A minimal app wired the way `app.ts` wires the real one. */
  function buildApp() {
    const app = Fastify({ logger: false, genReqId: generateRequestId });
    registerRequestReference(app);
    app.get("/ok", async () => ({ ok: true }));
    app.get("/created", async (_req, reply) => reply.code(201).send({ created: true }));
    app.get("/bad", async (_req, reply) => reply.code(400).send({ error: "invalid_request" }));
    app.get("/denied", async (_req, reply) => reply.code(401).send({ error: "unauthorised" }));
    app.get("/missing", async (_req, reply) => reply.code(404).send({ error: "not_found" }));
    app.get("/limited", async (_req, reply) => reply.code(429).send({ error: "rate_limited" }));
    app.get("/upstream", async (_req, reply) => reply.code(502).send({ error: "upstream" }));
    app.get("/boom", async () => {
      throw new Error("boom");
    });
    return app;
  }

  it.each([
    ["/ok", 200],
    ["/created", 201],
    ["/bad", 400],
    ["/denied", 401],
    ["/missing", 404],
    ["/limited", 429],
    ["/upstream", 502],
    ["/boom", 500],
  ])("%s -> %i carries a usable reference", async (url, expected) => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url });
    await app.close();

    expect(res.statusCode).toBe(expected);
    const header = res.headers[REQUEST_ID_HEADER];
    expect(header, `${url} returned no ${REQUEST_ID_HEADER}`).toBeDefined();
    expect(String(header)).toMatch(/^[a-z]{12}$/);
  });

  it("an unrouted path — Fastify's own 404 — still carries one", async () => {
    // The reason the hook is `onRequest` rather than `onSend`: a header set at the
    // start of the request survives every completion path, including the ones no
    // handler of ours runs on.
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/no-such-route" });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(String(res.headers[REQUEST_ID_HEADER])).toMatch(/^[a-z]{12}$/);
  });

  it("the header matches the id the logger records, or correlation is broken", async () => {
    const lines: string[] = [];
    const app = Fastify({
      genReqId: generateRequestId,
      logger: {
        level: "info",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stream: { write: (line: string) => lines.push(line) } as any,
      },
    });
    registerRequestReference(app);
    app.get("/ok", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/ok" });
    await app.close();

    const header = String(res.headers[REQUEST_ID_HEADER]);
    const logged = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((record) => record["reqId"] ?? record["requestId"])
      .filter((value): value is string => typeof value === "string");
    expect(logged.length, "nothing was logged").toBeGreaterThan(0);
    // The whole point of §24.2: what the customer quotes is what support greps for.
    expect(logged).toContain(header);
  });

  it("two requests receive different references", async () => {
    const app = buildApp();
    const a = await app.inject({ method: "GET", url: "/ok" });
    const b = await app.inject({ method: "GET", url: "/ok" });
    await app.close();
    expect(a.headers[REQUEST_ID_HEADER]).not.toBe(b.headers[REQUEST_ID_HEADER]);
  });

  it("is NON-VACUOUS: without the hook the header is absent on every non-500", async () => {
    // The pre-fix state, reproduced. Only the explicit 500-path write existed.
    const app = Fastify({ logger: false, genReqId: generateRequestId });
    app.get("/ok", async () => ({ ok: true }));
    app.get("/missing", async (_req, reply) => reply.code(404).send({ error: "not_found" }));
    const ok = await app.inject({ method: "GET", url: "/ok" });
    const missing = await app.inject({ method: "GET", url: "/missing" });
    await app.close();
    expect(ok.headers[REQUEST_ID_HEADER]).toBeUndefined();
    expect(missing.headers[REQUEST_ID_HEADER]).toBeUndefined();
  });
});

/* ========================================================================== *
 * The GDPR erasure reference, which derives from the same id
 * ========================================================================== */

describe("the GDPR erasure reference is now unique per request", () => {
  it("is ERASE- plus twelve uppercase letters", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(erasureReference(generateRequestId())).toMatch(/^ERASE-[A-Z]{12}$/);
    }
  });

  it("does not collide across many requests", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(erasureReference(generateRequestId()));
    expect(seen.size).toBe(20_000);
  });

  it("is NON-VACUOUS: with the default counter it was ERASE-REQ1, reissued every boot", () => {
    // The more serious half of this defect, and the half that was already live: a
    // legally significant handle for a GDPR erasure request, colliding on restart.
    expect(erasureReference("req-1")).toBe("ERASE-REQ1");
    expect(erasureReference("req-2")).toBe("ERASE-REQ2");
    // Ten boots, ten identical references for ten different customers' requests.
    const counterRefs = new Set(
      Array.from({ length: 10 }, () => erasureReference("req-1")),
    );
    expect(counterRefs.size).toBe(1);
    // The generated id gives ten distinct ones.
    const randomRefs = new Set(
      Array.from({ length: 10 }, () => erasureReference(generateRequestId())),
    );
    expect(randomRefs.size).toBe(10);
  });

  it("contains no digits, so it cannot trip the log gate either", () => {
    // The erasure reference is uppercased. A postcode shape needs a digit, and the id
    // has none — so `ERASE-XXXXXXXXXXXX` is safe to log and safe to print.
    for (let i = 0; i < 500; i += 1) {
      const reference = erasureReference(generateRequestId());
      expect(/\d/.test(reference)).toBe(false);
      expect(/\b[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}\b/.test(reference)).toBe(false);
    }
  });
});

/* ========================================================================== *
 * THE REAL APP — the assertions above are not enough on their own
 * ========================================================================== */

/**
 * Why this block exists, found by breaking the fix on purpose.
 *
 * Every test above builds its own minimal Fastify instance and calls
 * `registerRequestReference` directly. That is the right shape for testing the hook's
 * behaviour — but it means all 23 of them still pass when the hook is deleted from
 * `app.ts`. The header vanishes from every real response and the suite stays green.
 *
 * The proof run made that concrete: with `registerRequestReference(app)` commented out
 * of `app.ts`, the plugin's own tests reported 23 passed while `/health`, `/v1/balance`
 * and an unrouted path all returned `x-request-id=undefined`.
 *
 * So the wiring is asserted here, against the app the service actually builds. Same
 * principle as the `fetch-depth: 0` coupling test in the dependency gate: a fix that
 * lives in one file and is activated in another needs an assertion in both places, or
 * the activation can be removed without anything noticing.
 */
describe("the real app is wired for the reference, not just the plugin", () => {
  it("buildApp returns x-request-id on success, auth failure and an unrouted path", async () => {
    const { buildApp } = await import("../app.js");
    const { loadConfig } = await import("../config.js");
    const app = buildApp(loadConfig({ NODE_ENV: "test" }));
    await app.ready();

    try {
      // Three different completion paths: a public route, the auth preHandler's
      // rejection, and Fastify's not-found handler. None of them is the 500 path that
      // used to be the only one carrying a reference.
      for (const [url, expectedStatus] of [
        ["/health", 200],
        ["/v1/version", 200],
        ["/v1/balance", 401],
        ["/no-such-route", 404],
      ] as const) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, `${url} status`).toBe(expectedStatus);
        expect(
          res.headers[REQUEST_ID_HEADER],
          `${url} returned no ${REQUEST_ID_HEADER} — is registerRequestReference still wired into app.ts?`,
        ).toMatch(/^[a-z]{12}$/);
      }
    } finally {
      await app.close();
    }
  });

  it("buildApp uses the generator, not Fastify's per-process counter", async () => {
    // If `genReqId` were dropped from the Fastify options the header would still be
    // present — it would just carry `req-1`, which is the misleading reference this
    // change exists to avoid. Asserted on the shape, and on two requests differing.
    const { buildApp } = await import("../app.js");
    const { loadConfig } = await import("../config.js");
    const app = buildApp(loadConfig({ NODE_ENV: "test" }));
    await app.ready();

    try {
      const first = await app.inject({ method: "GET", url: "/health" });
      const second = await app.inject({ method: "GET", url: "/health" });
      const a = String(first.headers[REQUEST_ID_HEADER]);
      const b = String(second.headers[REQUEST_ID_HEADER]);

      expect(a, "genReqId is not wired into buildApp — this looks like Fastify's default").toMatch(
        /^[a-z]{12}$/,
      );
      expect(a).not.toMatch(/^req-\d+$/);
      expect(a).not.toBe(b);
    } finally {
      await app.close();
    }
  });

  it("app.ts wires both halves, stated so a refactor cannot drop one silently", async () => {
    // A source assertion as well as a behavioural one. The behavioural tests above
    // would catch a removal, but this names the two call sites so a failure says which
    // half went missing rather than only that a header was absent.
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const appSource = readFileSync(join(here, "..", "app.ts"), "utf8");

    expect(appSource, "app.ts no longer registers the reference hook").toMatch(
      /registerRequestReference\(app\)/,
    );
    expect(appSource, "app.ts no longer supplies genReqId").toMatch(/genReqId:\s*generateRequestId/);
  });
});
