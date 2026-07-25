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
