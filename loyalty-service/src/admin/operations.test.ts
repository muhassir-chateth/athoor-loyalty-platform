/**
 * Unit tests for admin migration/reconciliation operations (task 17.2,
 * Req 10.7/10.9).
 */
import { describe, expect, it } from "vitest";
import {
  CallbackAdminOperationsService,
  InMemoryAdminOperationsService,
  summarizeMigration,
  summarizeReconciliation,
  toAdminOperationResponse,
} from "./operations.js";
import { InMemoryAuditTrailRecorder } from "./auditTrail.js";
import type { AdminCtx } from "./adminAuth.js";

const ADMIN: AdminCtx = { adminUserId: "ops-alice", role: "admin" };

describe("summarizeReconciliation (Req 10.7)", () => {
  it("counts processed customers and treats unknown-customer skips as failures", () => {
    const counts = summarizeReconciliation({
      processed: 3,
      customers: [
        { status: "reconciled" },
        { status: "reconciled" },
        { status: "skipped_unknown_customer" },
      ],
    });
    expect(counts).toEqual({ processed: 3, failed: 1 });
  });

  it("reports zero failures when every customer reconciled", () => {
    expect(
      summarizeReconciliation({ processed: 2, customers: [{ status: "reconciled" }, { status: "reconciled" }] }),
    ).toEqual({ processed: 2, failed: 0 });
  });
});

describe("summarizeMigration (Req 10.7)", () => {
  it("reports all processed with no failures on a successful backfill", () => {
    expect(summarizeMigration({ status: "backfilled", processed: 8 })).toEqual({
      processed: 8,
      failed: 0,
    });
  });

  it("reports the mismatch count as failures on a reconciliation abort", () => {
    expect(
      summarizeMigration({
        status: "aborted_reconciliation_mismatch",
        mismatches: [{}, {}],
      }),
    ).toEqual({ processed: 0, failed: 2 });
  });

  it("reports a single failure on a backfill error abort", () => {
    expect(
      summarizeMigration({ status: "aborted_backfill_error", detail: { reason: "bad" } }),
    ).toEqual({ processed: 0, failed: 1 });
  });
});

describe("InMemoryAdminOperationsService (Req 10.7/10.9)", () => {
  it("returns configured counts and writes a migration audit record", async () => {
    const service = new InMemoryAdminOperationsService({
      migrationCounts: { processed: 8, failed: 0 },
    });
    const result = await service.runMigration(ADMIN);
    expect(result).toMatchObject({ operation: "migration", processed: 8, failed: 0 });
    const audits = service.auditRecorder.all();
    expect(audits).toHaveLength(1);
    const [record] = audits;
    expect(record).toMatchObject({
      adminUserId: "ops-alice",
      operationType: "migration",
      affectedCustomerId: null,
    });
    expect(record?.detail).toMatchObject({ processed: 8, failed: 0 });
  });

  it("returns configured counts and writes a reconciliation audit record", async () => {
    const service = new InMemoryAdminOperationsService({
      reconciliationCounts: { processed: 5, failed: 2 },
    });
    const result = await service.runReconciliation(ADMIN);
    expect(result).toMatchObject({ operation: "reconciliation", processed: 5, failed: 2 });
    expect(service.auditRecorder.all()[0]).toMatchObject({ operationType: "reconciliation" });
  });

  it("defaults to zero counts", async () => {
    const service = new InMemoryAdminOperationsService();
    expect(await service.runMigration(ADMIN)).toMatchObject({ processed: 0, failed: 0 });
  });
});

describe("CallbackAdminOperationsService (Req 10.7/10.9)", () => {
  it("runs the injected job and records the audit trail", async () => {
    const audit = new InMemoryAuditTrailRecorder();
    const service = new CallbackAdminOperationsService({
      audit,
      runMigration: async () => ({ processed: 3, failed: 1 }),
      runReconciliation: async () => ({ processed: 10, failed: 0 }),
    });

    const migration = await service.runMigration(ADMIN);
    expect(migration).toMatchObject({ operation: "migration", processed: 3, failed: 1 });

    const reconciliation = await service.runReconciliation(ADMIN);
    expect(reconciliation).toMatchObject({ operation: "reconciliation", processed: 10, failed: 0 });

    expect(audit.all().map((a) => a.operationType)).toEqual(["migration", "reconciliation"]);
  });
});

describe("toAdminOperationResponse", () => {
  it("shapes the completion result + audit link for the wire", async () => {
    const service = new InMemoryAdminOperationsService({
      migrationCounts: { processed: 2, failed: 0 },
    });
    const result = await service.runMigration(ADMIN);
    const body = toAdminOperationResponse(result);
    expect(body).toMatchObject({ operation: "migration", processed: 2, failed: 0 });
    expect(body.audit).toMatchObject({ adminUserId: "ops-alice", operationType: "migration" });
    expect(typeof body.audit.timestamp).toBe("string");
  });
});
