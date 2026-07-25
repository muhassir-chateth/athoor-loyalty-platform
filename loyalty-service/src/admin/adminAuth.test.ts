/**
 * Unit tests for admin authentication (task 17.1, Requirement 10.1).
 *
 * No live/production system is touched: verifiers hold only in-memory config.
 * These tests exercise the injectable authenticators and the Fastify preHandler
 * gate in isolation, asserting that access is denied without an authenticated
 * admin role and that a rejected request never reaches a handler.
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  AUTHORIZATION_REQUIRED_BODY,
  InMemoryAdminAuthenticator,
  SharedSecretAdminAuthenticator,
  UnconfiguredAdminAuthenticator,
  registerAdminAuth,
} from "./adminAuth.js";

describe("UnconfiguredAdminAuthenticator (fails closed, Req 10.1)", () => {
  it("authenticates no one", async () => {
    const auth = new UnconfiguredAdminAuthenticator();
    expect(await auth.verify("anything")).toBeNull();
    expect(await auth.verify("")).toBeNull();
  });
});

describe("SharedSecretAdminAuthenticator", () => {
  it("authenticates a matching secret as the admin role", async () => {
    const auth = new SharedSecretAdminAuthenticator("s3cret", "ops-1");
    expect(await auth.verify("s3cret")).toEqual({ adminUserId: "ops-1", role: "admin" });
  });

  it("rejects a non-matching secret", async () => {
    const auth = new SharedSecretAdminAuthenticator("s3cret");
    expect(await auth.verify("wrong")).toBeNull();
  });

  it("rejects a same-prefix but different-length token (constant-time compare)", async () => {
    const auth = new SharedSecretAdminAuthenticator("s3cret");
    expect(await auth.verify("s3cretX")).toBeNull();
    expect(await auth.verify("s3cre")).toBeNull();
  });

  it("fails closed when no secret is configured", async () => {
    expect(await new SharedSecretAdminAuthenticator(undefined).verify("")).toBeNull();
    expect(await new SharedSecretAdminAuthenticator("   ").verify("   ")).toBeNull();
  });

  it("defaults the admin user id to 'admin'", async () => {
    const auth = new SharedSecretAdminAuthenticator("k");
    expect(await auth.verify("k")).toEqual({ adminUserId: "admin", role: "admin" });
  });
});

describe("InMemoryAdminAuthenticator", () => {
  it("maps a known token to its admin user id", async () => {
    const auth = new InMemoryAdminAuthenticator({ "tok-1": "alice" });
    expect(await auth.verify("tok-1")).toEqual({ adminUserId: "alice", role: "admin" });
  });

  it("returns null for an unknown token", async () => {
    const auth = new InMemoryAdminAuthenticator();
    expect(await auth.verify("nope")).toBeNull();
  });
});

/** Build a tiny app whose single route is gated by the admin-auth preHandler. */
function buildGuardedApp(authenticator?: InMemoryAdminAuthenticator) {
  const app = Fastify();
  app.register(async (scope) => {
    registerAdminAuth(scope, { authenticator });
    scope.post("/thing", async (req) => {
      return { ok: true, adminUserId: req.adminCtx?.adminUserId };
    });
  });
  return app;
}

describe("registerAdminAuth preHandler (Req 10.1)", () => {
  it("denies with 401 authorization_required when no token is presented", async () => {
    const app = buildGuardedApp(new InMemoryAdminAuthenticator({ "tok-1": "alice" }));
    const res = await app.inject({ method: "POST", url: "/thing", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject(AUTHORIZATION_REQUIRED_BODY);
    await app.close();
  });

  it("denies with 401 when the token is invalid", async () => {
    const app = buildGuardedApp(new InMemoryAdminAuthenticator({ "tok-1": "alice" }));
    const res = await app.inject({
      method: "POST",
      url: "/thing",
      headers: { authorization: "Bearer wrong" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject(AUTHORIZATION_REQUIRED_BODY);
    await app.close();
  });

  it("denies by default (no authenticator configured → fail closed)", async () => {
    const app = buildGuardedApp(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/thing",
      headers: { authorization: "Bearer anything" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("allows and attaches adminCtx for a valid admin token", async () => {
    const app = buildGuardedApp(new InMemoryAdminAuthenticator({ "tok-1": "alice" }));
    const res = await app.inject({
      method: "POST",
      url: "/thing",
      headers: { authorization: "Bearer tok-1" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, adminUserId: "alice" });
    await app.close();
  });
});
