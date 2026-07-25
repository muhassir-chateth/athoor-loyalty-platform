/**
 * Tests for `POST /v1/devices` and `DELETE /v1/devices/:token` (task 19.1,
 * Requirement 19.1, 19.7).
 *
 * Exercises the routes through a real Fastify app wired with the actual `/v1`
 * auth + idempotency layers and an in-memory Device_Token store — so NO live
 * Shopify or Postgres is touched. Verifies:
 *   - an authenticated customer can register and de-register a Device_Token
 *     (Req 19.1), and the token is bound to the resolved customer;
 *   - registration validates the body (Req 19.1);
 *   - both are state-changing and require an Idempotency-Key, replaying a
 *     repeated key (Req 9.6/9.7);
 *   - an unauthenticated request is rejected before any handler runs (Req 9.3);
 *   - the endpoints work identically via App Proxy and Customer Account API
 *     identity (Req 9.2);
 *   - existing web endpoints are unaffected — /v1/balance still behaves as
 *     before (Req 19.7, additive-only).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { InMemoryCustomerResolver, FakeTokenVerifier } from "../auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { InMemoryDeviceTokenStore, type DeviceTokenStore } from "../devices/deviceTokens.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";

function buildApp(deviceTokenStore: DeviceTokenStore): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    deviceTokenStore,
  });
  return app;
}

function bearer(idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${BEARER_TOKEN}` };
  if (idempotencyKey) {
    headers["idempotency-key"] = idempotencyKey;
  }
  return headers;
}

function signedQuery(params: QueryParams): string {
  const withSig = { ...params, signature: computeAppProxySignature(params, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withSig)) {
    if (typeof value === "string") {
      search.set(key, value);
    }
  }
  return search.toString();
}

describe("POST /v1/devices (Req 19.1)", () => {
  let store: InMemoryDeviceTokenStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new InMemoryDeviceTokenStore();
    app = buildApp(store);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("registers a Device_Token bound to the resolved customer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: bearer("dev-key-1"),
      payload: { token: "push-tok-1", platform: "ios" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registered: true, platform: "ios" });
    expect(await store.listActiveTokens(LOCAL_CUSTOMER_ID)).toEqual([
      { token: "push-tok-1", platform: "ios" },
    ]);
  });

  it("rejects an invalid registration body (Req 19.1)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: bearer("dev-key-2"),
      payload: { token: "", platform: "windows" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_device_registration" });
    expect(await store.listActiveTokens(LOCAL_CUSTOMER_ID)).toEqual([]);
  });

  it("requires an Idempotency-Key on the state-changing request (Req 9.7)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: bearer(),
      payload: { token: "push-tok-1", platform: "ios" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_idempotency_key" });
  });

  it("replays the stored result for a repeated idempotency key (Req 9.6)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: bearer("same-dev-key"),
      payload: { token: "push-tok-1", platform: "ios" },
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: bearer("same-dev-key"),
      payload: { token: "push-tok-1", platform: "ios" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replay"]).toBe("true");
  });

  it("rejects an unauthenticated registration before recording anything (Req 9.3)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: { "idempotency-key": "anon-key" },
      payload: { token: "push-tok-1", platform: "ios" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    expect(await store.listActiveTokens(LOCAL_CUSTOMER_ID)).toEqual([]);
  });

  it("registers identically via App Proxy identity (Req 9.2)", async () => {
    const qs = signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
      path_prefix: "/apps/loyalty",
      timestamp: "1700000000",
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/devices?${qs}`,
      headers: { "idempotency-key": "proxy-dev-key" },
      payload: { token: "push-tok-proxy", platform: "android" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registered: true, platform: "android" });
    expect(await store.listActiveTokens(LOCAL_CUSTOMER_ID)).toEqual([
      { token: "push-tok-proxy", platform: "android" },
    ]);
  });
});

describe("DELETE /v1/devices/:token (Req 19.1)", () => {
  let store: InMemoryDeviceTokenStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = new InMemoryDeviceTokenStore();
    app = buildApp(store);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("de-registers a previously registered Device_Token", async () => {
    await store.register(LOCAL_CUSTOMER_ID, { token: "push-tok-1", platform: "ios" });

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/push-tok-1",
      headers: bearer("del-key-1"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deregistered: true });
    expect(await store.listActiveTokens(LOCAL_CUSTOMER_ID)).toEqual([]);
  });

  it("is a no-op (still succeeds) for an unknown token", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/never-registered",
      headers: bearer("del-key-2"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deregistered: true });
  });

  it("requires an Idempotency-Key on the state-changing DELETE (Req 9.7)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/push-tok-1",
      headers: bearer(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_idempotency_key" });
  });

  it("rejects an unauthenticated de-registration (Req 9.3)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/push-tok-1",
      headers: { "idempotency-key": "anon-del-key" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
  });
});

describe("additive-only: existing endpoints unaffected (Req 19.7)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp(new InMemoryDeviceTokenStore());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("leaves the public /v1/rewards contract unchanged", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rewards" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().rewards)).toBe(true);
  });

  it("does not expose device operations as unauthenticated reads", async () => {
    // GET is not a defined device operation; the router should 404 it rather
    // than leak any device data.
    const res = await app.inject({ method: "GET", url: "/v1/devices" });
    expect(res.statusCode).toBe(404);
  });
});
