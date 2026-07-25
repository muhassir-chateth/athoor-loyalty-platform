/**
 * Integration tests for the admin management router (task 17.1,
 * Requirements 10.1, 10.2, 10.3, 10.4, 10.9).
 *
 * Builds the full app via {@link buildApp} and drives it with `app.inject`, so
 * the admin-auth gate, the encapsulation from the consumer `/v1` auth, and the
 * versioning hooks are all exercised together. No live infra is used: a fake
 * in-memory authenticator and the default functional in-memory adjustment
 * service back the surface.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { API_VERSION_FIELD } from "../version.js";
import { InMemoryAdminAuthenticator } from "./adminAuth.js";
import { InMemoryAdminAdjustmentService } from "./adjustmentService.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(service?: InMemoryAdminAdjustmentService) {
  const config = loadConfig({ NODE_ENV: "test" });
  return buildApp(config, {
    adminAuthenticator: new InMemoryAdminAuthenticator({ "admin-tok": "ops-alice" }),
    adminAdjustmentService: service,
  });
}

const AUTH = { authorization: "Bearer admin-tok" };

describe("POST /v1/admin/adjustments — auth gate (Req 10.1)", () => {
  it("denies without a token and changes nothing", async () => {
    const service = new InMemoryAdminAdjustmentService();
    app = build(service);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/adjustments",
      payload: { customerId: "c1", points: 10, reason: "x" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "authorization_required" });
    expect(service.entries()).toHaveLength(0);
    expect(service.auditRecorder.all()).toHaveLength(0);
  });

  it("denies with an invalid token", async () => {
    app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/adjustments",
      headers: { authorization: "Bearer nope" },
      payload: { customerId: "c1", points: 10, reason: "x" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/admin/adjustments — happy path (Req 10.2/10.9)", () => {
  it("creates a ledger entry + audit record and echoes the version id", async () => {
    const service = new InMemoryAdminAdjustmentService();
    app = build(service);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/adjustments",
      headers: AUTH,
      payload: { customerId: "c1", points: -20, reason: "goodwill reversal" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty(API_VERSION_FIELD);
    expect(body.entry).toMatchObject({
      customerId: "c1",
      entryType: "adjust",
      points: -20,
      reason: "goodwill reversal",
      actingAdminUserId: "ops-alice",
    });
    expect(body.audit).toMatchObject({
      adminUserId: "ops-alice",
      operationType: "adjustment",
      affectedCustomerId: "c1",
    });
    expect(service.entries()).toHaveLength(1);
    expect(service.auditRecorder.all()).toHaveLength(1);
  });
});

describe("POST /v1/admin/adjustments — reason validation (Req 10.3)", () => {
  it("rejects an empty reason with 400 and writes nothing", async () => {
    const service = new InMemoryAdminAdjustmentService();
    app = build(service);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/adjustments",
      headers: AUTH,
      payload: { customerId: "c1", points: 10, reason: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "adjustment_invalid_reason" });
    expect(service.entries()).toHaveLength(0);
  });

  it("rejects an over-length reason with 400", async () => {
    const service = new InMemoryAdminAdjustmentService();
    app = build(service);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/adjustments",
      headers: AUTH,
      payload: { customerId: "c1", points: 10, reason: "a".repeat(501) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "adjustment_invalid_reason" });
  });

  it("rejects a zero points delta with 400", async () => {
    app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/adjustments",
      headers: AUTH,
      payload: { customerId: "c1", points: 0, reason: "x" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/admin/credits — manual credit (Req 10.4)", () => {
  it("creates a positive credit + manual_credit audit record", async () => {
    const service = new InMemoryAdminAdjustmentService();
    app = build(service);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/credits",
      headers: AUTH,
      payload: {
        customerId: "c1",
        points: 25,
        action: "instagram_follow",
        reason: "Followed @athoorlondon",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.entry).toMatchObject({ entryType: "adjust", points: 25 });
    expect(body.audit).toMatchObject({ operationType: "manual_credit", affectedCustomerId: "c1" });
    expect(service.entries()).toHaveLength(1);
  });

  it("rejects a non-positive credit with 400", async () => {
    app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/credits",
      headers: AUTH,
      payload: { customerId: "c1", points: -5, action: "instagram_follow", reason: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires the auth gate too (Req 10.1)", async () => {
    const service = new InMemoryAdminAdjustmentService();
    app = build(service);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/credits",
      payload: { customerId: "c1", points: 5, action: "instagram_follow", reason: "x" },
    });
    expect(res.statusCode).toBe(401);
    expect(service.entries()).toHaveLength(0);
  });
});
