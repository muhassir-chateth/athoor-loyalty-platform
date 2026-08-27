import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { API_VERSION, API_VERSION_FIELD, API_VERSION_HEADER } from "./version.js";

describe("app boot + /v1 versioning", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    app = buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("boots and serves the health endpoint", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", version: API_VERSION });
  });

  it("exposes the /v1 version endpoint with the version identifier", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: API_VERSION });
  });

  it("emits the version identifier on every JSON response (Req 9.8)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/version" });
    // Header mechanism
    expect(res.headers[API_VERSION_HEADER]).toBe(API_VERSION);
    // In-payload mechanism
    expect(res.json()).toHaveProperty(API_VERSION_FIELD, API_VERSION);
  });

  it("emits the version header even on 404 responses", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.headers[API_VERSION_HEADER]).toBe(API_VERSION);
  });

  it("returns the four-reward catalog on GET /v1/rewards (Req 3.1, task 5.1)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rewards" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rewards: Array<{ id: string; cost: number; valueGBP: number }> };
    expect(body.rewards).toHaveLength(4);
    expect(body.rewards).toEqual([
      { id: "reward_5", cost: 100, valueGBP: 5 },
      { id: "reward_15", cost: 250, valueGBP: 15 },
      { id: "reward_35", cost: 500, valueGBP: 35 },
      { id: "reward_75", cost: 1000, valueGBP: 75 },
    ]);
    // The versioning plugin still injects the version identifier (Req 9.8).
    expect(res.json()).toHaveProperty(API_VERSION_FIELD, API_VERSION);
  });

  it("does not expose loyalty operations outside the /v1 prefix (Req 9.1)", async () => {
    // The same operation without the /v1 prefix must not be routable.
    const res = await app.inject({ method: "GET", url: "/rewards" });
    expect(res.statusCode).toBe(404);
    // And it is available under /v1.
    const ok = await app.inject({ method: "GET", url: "/v1/rewards" });
    expect(ok.statusCode).toBe(200);
  });

  it("keeps handling stateless — sets no session cookie on any response (Req 9.8)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rewards" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

/* ========================================================================== *
 * Portal dependencies actually REACH their routes (task 9.1 regression)
 * ========================================================================== */

describe("buildApp forwards every portal dependency into /v1", () => {
  /**
   * WHY THIS EXISTS. Task 8.4 built `portalCatalogSource`, index.ts constructed it
   * and handed it to `buildApp` — but `AppDependencies` never declared it and
   * `app.ts` never forwarded it, so `GET /v1/catalog/products` ran on its refusing
   * default in production and answered `502` for every request.
   *
   * It typechecked because index.ts passes it through a SPREAD:
   * `...(x ? { x } : {})`. TypeScript applies excess-property checking to object
   * LITERALS only, so a dependency no type declared travelled silently all the way
   * to being dropped.
   *
   * Declaring the field fixed that instance. These tests close the CLASS by
   * observing BEHAVIOUR at the route, so the next portal dependency that is added
   * and not forwarded fails here rather than in production.
   */
  it("forwards portalCatalogSource — a wired source must not answer 502", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      portalCatalogSource: {
        async listProducts(ids: readonly string[]) {
          return {
            products: ids.map((id) => ({
              productId: id,
              title: "T",
              handle: "t",
              published: true,
              availableForSale: true,
              priceGBP: "1.00",
              compareAtPriceGBP: null,
              imageUrl: null,
              imageWidth: 0,
              imageHeight: 0,
              defaultVariantId: null,
            })),
            missing: [],
          };
        },
      },
    });
    try {
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/v1/catalog/products?ids=1001" });
      // 401 is fine here (no identity wired). 502 is NOT — that would mean the
      // source never arrived at the route.
      expect(res.statusCode).not.toBe(502);
    } finally {
      await app.close();
    }
  });

  it("forwards wishlistStore — a wired store must not answer 404", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      wishlistStore: {
        async read() {
          return [];
        },
        async count() {
          return 0;
        },
        async set() {
          return true;
        },
      },
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "PUT",
        url: "/v1/profile/wishlist/1001",
        payload: { on: true },
      });
      // A 404 would mean the route never registered, which a client reads as
      // "that product is not on your wishlist".
      expect(res.statusCode).not.toBe(404);
    } finally {
      await app.close();
    }
  });
});
