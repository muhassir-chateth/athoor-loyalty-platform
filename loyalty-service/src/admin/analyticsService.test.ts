/**
 * Tests for the Admin Analytics service + cached-aggregate data source
 * (task 17.3, Requirement 20), and the `GET /v1/admin/analytics` route wiring
 * (admin auth Req 20.1, default range Req 20.5, invalid range Req 20.4,
 * `computedAt` Req 20.6).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { API_VERSION_FIELD } from "../version.js";
import { InMemoryAdminAuthenticator } from "./adminAuth.js";
import {
  CachedAggregateAnalyticsService,
  InMemoryAnalyticsDataSource,
  createInMemoryAnalyticsService,
} from "./analyticsService.js";
import type { AnalyticsSource } from "./analytics.js";

const REFRESHED_AT = "2025-02-01T00:00:00.000Z";

function iso(day: number): string {
  return new Date(Date.UTC(2025, 0, day, 12, 0, 0)).toISOString();
}

function fixture(): AnalyticsSource {
  return {
    customers: [
      { customerId: "c1", enrolledAt: iso(1) },
      { customerId: "c2", enrolledAt: null },
    ],
    orders: [{ customerId: "c1", eligibleTotalGBP: 100, createdAt: iso(3) }],
    ledger: [{ customerId: "c1", entryType: "earn_order", points: 100, createdAt: iso(3) }],
    redemptions: [{ customerId: "c1", rewardId: "reward_5", createdAt: iso(4) }],
  };
}

const RANGE = { start: "2025-01-01T00:00:00.000Z", end: "2025-01-31T23:59:59.999Z" };

describe("CachedAggregateAnalyticsService (Req 20.2–20.6)", () => {
  it("stamps computedAt with the aggregate refresh instant (Req 20.6)", async () => {
    const ds = new InMemoryAnalyticsDataSource(fixture(), REFRESHED_AT);
    const service = new CachedAggregateAnalyticsService(ds);
    const result = await service.getOverview(RANGE);
    expect(result.computedAt).toBe(REFRESHED_AT);
    expect(result.clv).toBe(100);
  });

  it("applies + reports the default range when none is given (Req 20.5)", async () => {
    const now = new Date("2025-03-31T00:00:00.000Z");
    const ds = new InMemoryAnalyticsDataSource(fixture(), REFRESHED_AT);
    const service = new CachedAggregateAnalyticsService(ds, { now: () => now });
    const result = await service.getOverview();
    expect(result.range.end).toBe(now.toISOString());
    expect(result.range.start).toBe(new Date("2025-03-01T00:00:00.000Z").toISOString());
  });

  it("rejects an end-before-start range before reading the data source (Req 20.4)", async () => {
    let read = false;
    const ds = {
      async snapshot() {
        read = true;
        return { source: fixture(), refreshedAt: REFRESHED_AT };
      },
    };
    const service = new CachedAggregateAnalyticsService(ds);
    await expect(service.getOverview({ start: RANGE.end, end: RANGE.start })).rejects.toMatchObject({
      code: "analytics_invalid_date_range",
    });
    expect(read).toBe(false);
  });
});

/* ---------------------------- route integration --------------------------- */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(source?: AnalyticsSource) {
  const config = loadConfig({ NODE_ENV: "test" });
  return buildApp(config, {
    adminAuthenticator: new InMemoryAdminAuthenticator({ "admin-tok": "ops-alice" }),
    analyticsService: createInMemoryAnalyticsService(source ?? fixture(), {
      now: () => new Date("2025-02-15T00:00:00.000Z"),
    }),
  });
}

const AUTH = { authorization: "Bearer admin-tok" };

describe("GET /v1/admin/analytics — route (Req 20.1, 20.4, 20.5, 20.6)", () => {
  it("denies without an admin token and returns no analytics (Req 20.1)", async () => {
    app = build();
    const res = await app.inject({ method: "GET", url: "/v1/admin/analytics" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "authorization_required" });
    expect(res.json()).not.toHaveProperty("clv");
  });

  it("returns analytics for an explicit range with the version id", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/analytics?start=${encodeURIComponent(RANGE.start)}&end=${encodeURIComponent(RANGE.end)}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty(API_VERSION_FIELD);
    expect(body.clv).toBe(100);
    expect(body.range).toEqual(RANGE);
    expect(body).toHaveProperty("computedAt");
  });

  it("applies the default range when none is given (Req 20.5)", async () => {
    app = build();
    const res = await app.inject({ method: "GET", url: "/v1/admin/analytics", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // default = trailing 30 days ending at the fixed clock.
    expect(body.range.end).toBe(new Date("2025-02-15T00:00:00.000Z").toISOString());
    expect(body.range.start).toBe(new Date("2025-01-16T00:00:00.000Z").toISOString());
  });

  it("rejects an end-before-start range with 400 (Req 20.4)", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/analytics?start=${encodeURIComponent(RANGE.end)}&end=${encodeURIComponent(RANGE.start)}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "analytics_invalid_date_range" });
  });

  it("rejects a lone bound with 400", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/analytics?start=${encodeURIComponent(RANGE.start)}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });
});
