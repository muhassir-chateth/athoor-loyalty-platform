/**
 * NB-13 — the App Proxy timestamp freshness window (task 5.5, Req 1.3/1.1).
 *
 * WHY A WINDOW IS NEEDED. A valid signature proves Shopify produced the request;
 * it does NOT prove the request is recent. Without a bound, a captured proxied URL
 * — from a shared link, a history entry, a proxy log, a screenshot — stays
 * replayable for as long as the shared secret lives. These tests use a FAKE CLOCK
 * so staleness is exercised deterministically rather than by sleeping.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { InMemoryCustomerResolver } from "../auth/identity.js";

const SECRET = "app-proxy-shared-secret";
const SHOPIFY_ID = "9395357876563";
const LOCAL_ID = "11111111-1111-4111-8111-111111111111";

/** Fixed base instant, so "t" and "t + 6 min" are exact. */
const T0_MS = Date.UTC(2026, 7, 23, 12, 0, 0);

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Signs exactly the params given — no timestamp is injected here on purpose. */
function sign(params: QueryParams): string {
  const withSig = { ...params, signature: computeAppProxySignature(params, SECRET) };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(withSig)) if (typeof v === "string") search.set(k, v);
  return search.toString();
}

function build(nowMs: () => number): FastifyInstance {
  const instance = Fastify({ logger: false });
  instance.register(async (scope) => {
    registerAuth(scope, {
      resolver: new InMemoryCustomerResolver({ [SHOPIFY_ID]: LOCAL_ID }),
      appProxySecret: SECRET,
      now: nowMs,
    });
    scope.get("/secure", async (req) => ({ customerId: req.authCtx?.customerId }));
  });
  return instance;
}

function queryAt(signedSeconds: number): string {
  return sign({
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: SHOPIFY_ID,
    path_prefix: "/apps/loyalty",
    timestamp: String(signedSeconds),
  });
}

describe("NB-13 freshness window", () => {
  it("ACCEPTS a request signed at t when the clock reads t", async () => {
    app = build(() => T0_MS);
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/secure?${queryAt(T0_MS / 1000)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ customerId: LOCAL_ID });
  });

  it("REJECTS the same request once the clock reads t + 6 minutes", async () => {
    // Identical bytes, identical valid signature — only time moved. That is the
    // replay this window exists to stop.
    const qs = queryAt(T0_MS / 1000);
    app = build(() => T0_MS + 6 * 60 * 1000);
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_request_expired" });
  });

  it("accepts the boundary at exactly 5 minutes and rejects just past it", async () => {
    const qs = queryAt(T0_MS / 1000);

    app = build(() => T0_MS + 300 * 1000);
    await app.ready();
    expect((await app.inject({ method: "GET", url: `/secure?${qs}` })).statusCode).toBe(200);
    await app.close();

    app = build(() => T0_MS + 301 * 1000);
    await app.ready();
    expect((await app.inject({ method: "GET", url: `/secure?${qs}` })).statusCode).toBe(401);
  });

  it("rejects a FUTURE-dated request just as firmly as a stale one", async () => {
    // Asymmetry would let a skewed or forged forward-dated value through for ever.
    app = build(() => T0_MS);
    await app.ready();
    const future = queryAt(T0_MS / 1000 + 600);
    const res = await app.inject({ method: "GET", url: `/secure?${future}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_request_expired" });
  });

  it("FAILS CLOSED when no timestamp is signed at all", async () => {
    // Shopify always signs one, so its absence means a malformed or hand-built
    // request. Treating "absent" as "fresh" would make the window opt-out by
    // omission — the same class of mistake as a security flag defaulting to off.
    app = build(() => T0_MS);
    await app.ready();
    const noTs = sign({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: SHOPIFY_ID,
      path_prefix: "/apps/loyalty",
    });
    const res = await app.inject({ method: "GET", url: `/secure?${noTs}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_request_expired" });
  });

  it.each([
    ["non-numeric", "not-a-number"],
    ["empty", ""],
    ["negative", "-1700000000"],
    ["absurdly long", "1".repeat(20)],
  ])("fails closed on a %s timestamp", async (_label, value) => {
    app = build(() => T0_MS);
    await app.ready();
    const qs = sign({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: SHOPIFY_ID,
      timestamp: value,
    });
    const res = await app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_request_expired" });
  });

  it("is checked only AFTER the signature, so a tampered timestamp is a signature failure", async () => {
    // ORDER MATTERS. The timestamp is one of the SIGNED parameters, so reading it
    // before verification would mean acting on an attacker-controlled value. A
    // request whose timestamp was edited after signing must therefore be reported
    // as a signature failure, not as an expiry — otherwise the error would imply
    // the value had been trusted.
    app = build(() => T0_MS);
    await app.ready();
    const qs = queryAt(T0_MS / 1000).replace(
      `timestamp=${T0_MS / 1000}`,
      `timestamp=${T0_MS / 1000 - 99999}`,
    );
    const res = await app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_signature_invalid" });
  });

  it("rejects a length-mismatched signature without throwing (§5.1 negative case)", async () => {
    // `crypto.timingSafeEqual` throws on a length mismatch, so `verifyAppProxySignature`
    // compares lengths first. Unit-covered in auth/appProxy.test.ts; asserted here
    // end to end through the auth layer, where a throw would surface as a 500
    // rather than a clean 401.
    app = build(() => T0_MS);
    await app.ready();
    const qs = `${queryAt(T0_MS / 1000)}`.replace(/signature=[0-9a-f]+/, "signature=abc123");
    const res = await app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_signature_invalid" });
  });

  it("changes no stored data when it rejects", async () => {
    // The expiry is raised before identity resolution, so the resolver is never
    // consulted — a stricter claim than "no writes happened".
    let resolverCalls = 0;
    const instance = Fastify({ logger: false });
    instance.register(async (scope) => {
      registerAuth(scope, {
        resolver: {
          async resolveByShopifyCustomerId() {
            resolverCalls += 1;
            return LOCAL_ID;
          },
        },
        appProxySecret: SECRET,
        now: () => T0_MS + 60 * 60 * 1000,
      });
      scope.get("/secure", async () => ({ ok: true }));
    });
    app = instance;
    await app.ready();

    const res = await app.inject({ method: "GET", url: `/secure?${queryAt(T0_MS / 1000)}` });
    expect(res.statusCode).toBe(401);
    expect(resolverCalls).toBe(0);
  });
});
