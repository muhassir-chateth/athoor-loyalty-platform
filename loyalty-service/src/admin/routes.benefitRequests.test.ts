/**
 * Admin benefit-request endpoints — RUNTIME PATH tests (task 41).
 *
 * Builds the FULL app via `buildApp` and drives it with `app.inject`, so the
 * admin-auth gate, the encapsulation from the consumer `/v1` auth, the
 * versioning hook and the forwarding through `buildApp` are all exercised
 * together — the last of those being the link that has repeatedly been the
 * missing one in this codebase.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { InMemoryAdminAuthenticator } from "./adminAuth.js";
import { InMemoryAuditTrailRecorder } from "./auditTrail.js";
import {
  BenefitRequestService,
  InMemoryBenefitRequestStore,
  type AdminBenefitRequest,
} from "./benefitRequests.js";
import type { Queryable } from "../ledger/repository.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const AUTH = { authorization: "Bearer admin-tok" };
const REQUEST_ID = "req-1";

function req(over: Partial<AdminBenefitRequest> = {}): AdminBenefitRequest {
  return {
    id: REQUEST_ID,
    status: "requested",
    customerId: "cust-1",
    benefitKey: "private_consultation",
    benefitName: "Private Consultation Booking",
    requestedAt: "2026-07-01T00:00:00.000Z",
    statusChangedAt: null,
    ...over,
  };
}

function build(seed: AdminBenefitRequest[] = [req()], wired = true) {
  const config = loadConfig({ NODE_ENV: "test" });
  const audit = new InMemoryAuditTrailRecorder();
  const store = new InMemoryBenefitRequestStore(seed);
  const service = new BenefitRequestService({
    store,
    audit,
    transactor: async (work) => work({} as Queryable),
  });
  const built = buildApp(config, {
    adminAuthenticator: new InMemoryAdminAuthenticator({ "admin-tok": "ops-alice" }),
    ...(wired ? { adminBenefitRequestService: service } : {}),
  });
  return { built, audit, store };
}

describe("GET /v1/admin/benefit-requests (Req 10.5)", () => {
  it("denies without an admin token", async () => {
    const { built } = build();
    app = built;

    const res = await app.inject({ method: "GET", url: "/v1/admin/benefit-requests" });

    expect(res.statusCode).toBe(401);
  });

  it("returns the open queue oldest-first and the closed record", async () => {
    const { built } = build([
      req({ id: "b", requestedAt: "2026-07-02T00:00:00.000Z" }),
      req({ id: "a", status: "confirmed", requestedAt: "2026-07-01T00:00:00.000Z" }),
      req({ id: "c", status: "fulfilled", requestedAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    app = built;

    const res = await app.inject({ method: "GET", url: "/v1/admin/benefit-requests", headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json().open.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
    expect(res.json().closed.map((r: { id: string }) => r.id)).toEqual(["c"]);
    // The benefit key travels with the row, so the queue is readable as-is.
    expect(res.json().open[0].benefitKey).toBe("private_consultation");
  });

  it("is not registered at all when the service is unwired", async () => {
    // An unwired build must not present an empty queue that reads as
    // "no work waiting" when the truth is "nothing is connected".
    const { built } = build([req()], false);
    app = built;

    const res = await app.inject({ method: "GET", url: "/v1/admin/benefit-requests", headers: AUTH });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/admin/benefit-requests/:id/transition (Req 18.5/10.9)", () => {
  const transition = (instance: FastifyInstance, body: unknown, id = REQUEST_ID) =>
    instance.inject({
      method: "POST",
      url: `/v1/admin/benefit-requests/${id}/transition`,
      headers: AUTH,
      payload: body as never,
    });

  it("denies without an admin token and changes nothing", async () => {
    const { built, audit, store } = build();
    app = built;

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/benefit-requests/${REQUEST_ID}/transition`,
      payload: { status: "fulfilled" },
    });

    expect(res.statusCode).toBe(401);
    expect(audit.all()).toHaveLength(0);
    expect((await store.find(REQUEST_ID))!.status).toBe("requested");
  });

  it("fulfils a request, records the audit trail, and echoes the new state", async () => {
    const { built, audit } = build();
    app = built;

    const res = await transition(app, { status: "fulfilled", reason: "delivered in store" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: true, request: { status: "fulfilled" } });
    expect(res.json()[Object.keys(res.json()).find((k) => k === "apiVersion") ?? "apiVersion"]).toBe("v1");
    expect(audit.all()).toHaveLength(1);
    expect(audit.all()[0]).toMatchObject({ adminUserId: "ops-alice", operationType: "benefit_request" });
  });

  it("is idempotent on a repeat, reporting success with changed: false", async () => {
    const { built, audit } = build();
    app = built;

    await transition(app, { status: "fulfilled" });
    const again = await transition(app, { status: "fulfilled" });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ changed: false, request: { status: "fulfilled" } });
    // Exactly one audit record for one real change.
    expect(audit.all()).toHaveLength(1);
  });

  it("409s an illegal transition out of a terminal status, echoing from/to", async () => {
    const { built, audit } = build([req({ status: "fulfilled" })]);
    app = built;

    const res = await transition(app, { status: "declined" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "benefit_request_invalid_transition",
      from: "fulfilled",
      to: "declined",
    });
    expect(audit.all()).toHaveLength(0);
  });

  it("404s an unknown request id", async () => {
    const { built } = build();
    app = built;

    const res = await transition(app, { status: "fulfilled" }, "no-such-id");

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("benefit_request_not_found");
  });

  it("400s an unknown or missing status, listing what is accepted", async () => {
    const { built, audit } = build();
    app = built;

    for (const body of [{}, { status: "requested" }, { status: "nonsense" }]) {
      const res = await transition(app, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_request");
      expect(res.json().message).toContain("fulfilled");
    }
    expect(audit.all()).toHaveLength(0);
  });

  it("400s an over-long reason rather than truncating it into the audit trail", async () => {
    const { built, audit } = build();
    app = built;

    const res = await transition(app, { status: "declined", reason: "x".repeat(501) });

    expect(res.statusCode).toBe(400);
    expect(audit.all()).toHaveLength(0);
  });

  it("supports the two-step confirm-then-fulfil path with two audit records", async () => {
    const { built, audit } = build();
    app = built;

    expect((await transition(app, { status: "confirmed" })).statusCode).toBe(200);
    expect((await transition(app, { status: "fulfilled" })).statusCode).toBe(200);

    expect(audit.all().map((r) => r.detail.toStatus)).toEqual(["confirmed", "fulfilled"]);
  });

  it("declines and cancels as distinct outcomes", async () => {
    const declined = build();
    app = declined.built;
    expect((await transition(app, { status: "declined" })).json().request.status).toBe("declined");
    await app.close();

    const cancelled = build();
    app = cancelled.built;
    expect((await transition(app, { status: "cancelled" })).json().request.status).toBe("cancelled");
  });
});
