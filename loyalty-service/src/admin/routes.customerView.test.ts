/**
 * Integration tests for the task-17.2 admin routes: customer ledger view
 * (Req 10.5), fraud review (Req 10.6), and migration/reconciliation operations
 * (Req 10.7). Driven through the full app so the admin-auth gate (Req 10.1) and
 * versioning hooks apply to every new endpoint too.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { API_VERSION_FIELD } from "../version.js";
import { InMemoryAdminAuthenticator } from "./adminAuth.js";
import { InMemoryAdminCustomerLedgerSource, type AdminRawLedgerEntry } from "./customerView.js";
import { InMemoryFraudReviewSource } from "./fraudReview.js";
import { InMemoryAdminOperationsService } from "./operations.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const AUTH = { authorization: "Bearer admin-tok" };

function buildWith(deps: {
  adminCustomerLedgerSource?: InMemoryAdminCustomerLedgerSource;
  fraudReviewSource?: InMemoryFraudReviewSource;
  adminOperationsService?: InMemoryAdminOperationsService;
}) {
  const config = loadConfig({ NODE_ENV: "test" });
  return buildApp(config, {
    adminAuthenticator: new InMemoryAdminAuthenticator({ "admin-tok": "ops-alice" }),
    ...deps,
  });
}

function led(o: Partial<AdminRawLedgerEntry> & Pick<AdminRawLedgerEntry, "id" | "createdAt">): AdminRawLedgerEntry {
  return {
    entryType: "earn_order",
    points: 10,
    reason: "order",
    orderReference: null,
    sourceEventId: null,
    ...o,
  };
}

describe("GET /v1/admin/customers/:customerId/ledger (Req 10.5)", () => {
  it("denies without an admin token (Req 10.1)", async () => {
    app = buildWith({});
    const res = await app.inject({ method: "GET", url: "/v1/admin/customers/c1/ledger" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the complete ledger most-recent-first with acting party and version id", async () => {
    const source = new InMemoryAdminCustomerLedgerSource();
    source.set("c1", [
      led({ id: "e1", createdAt: new Date("2024-01-01T00:00:00.000Z"), reason: "signup", entryType: "earn_signup", points: 50 }),
      led({
        id: "e2",
        createdAt: new Date("2024-02-01T00:00:00.000Z"),
        entryType: "adjust",
        points: -20,
        reason: "goodwill",
        sourceEventId: "admin:ops-bob",
      }),
    ]);
    app = buildWith({ adminCustomerLedgerSource: source });

    const res = await app.inject({ method: "GET", url: "/v1/admin/customers/c1/ledger", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty(API_VERSION_FIELD);
    expect(body.customerId).toBe("c1");
    expect(body.totalCount).toBe(2);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["e2", "e1"]);
    expect(body.entries[0]).toMatchObject({
      type: "adjust",
      points: -20,
      reason: "goodwill",
      actingParty: { kind: "admin", id: "ops-bob" },
    });
    expect(body.entries[1].actingParty).toEqual({ kind: "system", id: "system" });
  });

  it("returns an empty ledger for an unknown customer", async () => {
    app = buildWith({});
    const res = await app.inject({ method: "GET", url: "/v1/admin/customers/unknown/ledger", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ customerId: "unknown", entries: [], totalCount: 0 });
  });
});

describe("GET /v1/admin/fraud-review (Req 10.6)", () => {
  it("denies without an admin token (Req 10.1)", async () => {
    app = buildWith({});
    const res = await app.inject({ method: "GET", url: "/v1/admin/fraud-review" });
    expect(res.statusCode).toBe(401);
  });

  it("lists referrals and redemptions with status/customer/amount/timestamp", async () => {
    const source = new InMemoryFraudReviewSource({
      referrals: [
        {
          id: "r1",
          referrerId: "ref-1",
          referredId: "friend-1",
          signupRewarded: true,
          purchaseRewarded: false,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
        },
      ],
      redemptions: [
        {
          id: "d1",
          customerId: "cust-9",
          rewardId: "reward_5",
          pointsSpent: 100,
          status: "issued",
          createdAt: new Date("2024-02-01T00:00:00.000Z"),
        },
      ],
    });
    app = buildWith({ fraudReviewSource: source });

    const res = await app.inject({ method: "GET", url: "/v1/admin/fraud-review", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.referrals[0]).toMatchObject({
      status: "signup_rewarded",
      customerId: "ref-1",
      amount: 150,
    });
    expect(body.redemptions[0]).toMatchObject({
      status: "issued",
      customerId: "cust-9",
      amount: 100,
    });
  });
});

describe("POST /v1/admin/operations/* (Req 10.7/10.9)", () => {
  it("denies without an admin token and runs nothing (Req 10.1)", async () => {
    const service = new InMemoryAdminOperationsService();
    app = buildWith({ adminOperationsService: service });
    const res = await app.inject({ method: "POST", url: "/v1/admin/operations/migration" });
    expect(res.statusCode).toBe(401);
    expect(service.auditRecorder.all()).toHaveLength(0);
  });

  it("runs migration and returns processed/failed counts + audit", async () => {
    const service = new InMemoryAdminOperationsService({
      migrationCounts: { processed: 8, failed: 0 },
    });
    app = buildWith({ adminOperationsService: service });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/operations/migration",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ operation: "migration", processed: 8, failed: 0 });
    expect(body.audit).toMatchObject({ operationType: "migration", adminUserId: "ops-alice" });
    expect(service.auditRecorder.all()).toHaveLength(1);
  });

  it("runs reconciliation and returns processed/failed counts", async () => {
    const service = new InMemoryAdminOperationsService({
      reconciliationCounts: { processed: 5, failed: 1 },
    });
    app = buildWith({ adminOperationsService: service });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/operations/reconciliation",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ operation: "reconciliation", processed: 5, failed: 1 });
  });
});
