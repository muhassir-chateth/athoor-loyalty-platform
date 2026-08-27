/**
 * Unit tests for the immutable admin audit trail (task 17.1, Requirement 10.9).
 *
 * No live/production database is touched. A fake {@link Queryable} captures the
 * INSERTs the Pg recorder would issue and echoes a synthesised row, and the
 * in-memory recorder is exercised directly. Together these verify that every
 * adjustment/credit/migration/reconciliation can produce an immutable audit
 * record capturing the acting admin id, operation type, affected customer, and
 * timestamp — and that the recorder exposes only an append (no mutation).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  AUDIT_OPERATION_TYPES,
  AuditValidationError,
  InMemoryAuditTrailRecorder,
  PgAuditTrailRecorder,
  SYSTEM_ACTOR_ID,
  validateAuditRecord,
  type Queryable,
} from "./auditTrail.js";

interface Captured {
  queryText: string;
  values: unknown[];
}

function makeFakeDb(): { db: Queryable; inserts: Captured[] } {
  const inserts: Captured[] = [];
  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      inserts.push({ queryText, values });
      const [adminUserId, operationType, affectedCustomerId, ledgerEntryId, detail] = values;
      const row = {
        id: "audit-uuid-1",
        admin_user_id: adminUserId as string,
        operation_type: operationType as string,
        affected_customer_id: (affectedCustomerId as string | null) ?? null,
        ledger_entry_id: (ledgerEntryId as string | null) ?? null,
        detail: detail as string, // pg returns JSONB as an object; here a JSON string tests parsing
        created_at: new Date("2025-02-02T00:00:00.000Z"),
      };
      return { rows: [row as unknown as R], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    },
  };
  return { db, inserts };
}

describe("AUDIT_OPERATION_TYPES covers the Req 10.9 operations plus benefit_request", () => {
  it("declares adjustment, manual_credit, migration, reconciliation, benefit_request, customer_redaction", () => {
    // The first four are Req 10.9's own list; `benefit_request` was added by
    // task 41 so an operator advancing a benefit request's lifecycle is
    // attributable. `customer_redaction` was added by task 15.3 so the
    // operator-run redaction procedure is accountable — recording an erasure as
    // `reconciliation` would put a false statement in the audit trail. Each is kept
    // in step with the `admin_audit_log.operation_type` CHECK by its own migration
    // (1785900000000_benefit-request-lifecycle, 1786600000000_extend-audit-for-redaction).
    expect([...AUDIT_OPERATION_TYPES]).toEqual([
      "adjustment",
      "manual_credit",
      "migration",
      "reconciliation",
      "benefit_request",
      "customer_redaction",
    ]);
  });
});

describe("validateAuditRecord", () => {
  it("rejects a missing actor id", () => {
    expect(() =>
      validateAuditRecord({ adminUserId: "  ", operationType: "adjustment" }),
    ).toThrow(AuditValidationError);
  });

  it("rejects an unknown operation type", () => {
    expect(() =>
      // @ts-expect-error deliberately invalid type
      validateAuditRecord({ adminUserId: "a", operationType: "delete_everything" }),
    ).toThrow(AuditValidationError);
  });
});

describe("PgAuditTrailRecorder.record (Req 10.9)", () => {
  it("issues a single INSERT capturing actor, op type, customer, ledger link, detail", async () => {
    const { db, inserts } = makeFakeDb();
    const rec = new PgAuditTrailRecorder(db);

    const out = await rec.record({
      adminUserId: "alice",
      operationType: "adjustment",
      affectedCustomerId: "cust-1",
      ledgerEntryId: "ledger-1",
      detail: { points: -20, reason: "goodwill reversal" },
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.queryText).toContain("INSERT INTO admin_audit_log");
    expect(inserts[0]!.queryText).not.toMatch(/\bUPDATE\b|\bDELETE\b/i);
    expect(inserts[0]!.values.slice(0, 4)).toEqual([
      "alice",
      "adjustment",
      "cust-1",
      "ledger-1",
    ]);
    expect(out.adminUserId).toBe("alice");
    expect(out.operationType).toBe("adjustment");
    expect(out.affectedCustomerId).toBe("cust-1");
    expect(out.ledgerEntryId).toBe("ledger-1");
    expect(out.detail).toEqual({ points: -20, reason: "goodwill reversal" });
    expect(out.createdAt).toBeInstanceOf(Date);
  });

  it("supports system-wide migration/reconciliation records (null customer)", async () => {
    const { db, inserts } = makeFakeDb();
    const rec = new PgAuditTrailRecorder(db);
    await rec.record({
      adminUserId: SYSTEM_ACTOR_ID,
      operationType: "reconciliation",
      detail: { processed: 8, failed: 0 },
    });
    expect(inserts[0]!.values[2]).toBeNull(); // affected_customer_id
    expect(inserts[0]!.values[3]).toBeNull(); // ledger_entry_id
  });
});

describe("InMemoryAuditTrailRecorder (immutable append)", () => {
  it("appends and returns a frozen record", async () => {
    const rec = new InMemoryAuditTrailRecorder();
    const out = await rec.record({
      adminUserId: "bob",
      operationType: "manual_credit",
      affectedCustomerId: "cust-9",
      detail: { points: 25, action: "instagram_follow" },
    });
    expect(Object.isFrozen(out)).toBe(true);
    expect(() => {
      (out as { adminUserId: string }).adminUserId = "eve";
    }).toThrow();
  });

  it("records each of the four operation types", async () => {
    const rec = new InMemoryAuditTrailRecorder();
    for (const op of AUDIT_OPERATION_TYPES) {
      await rec.record({ adminUserId: "a", operationType: op, affectedCustomerId: "c" });
    }
    expect(rec.all().map((r) => r.operationType)).toEqual([...AUDIT_OPERATION_TYPES]);
  });

  it("returns a customer's records most-recent-first", async () => {
    const rec = new InMemoryAuditTrailRecorder();
    await rec.record({ adminUserId: "a", operationType: "adjustment", affectedCustomerId: "c1" });
    await rec.record({ adminUserId: "a", operationType: "manual_credit", affectedCustomerId: "c2" });
    await rec.record({ adminUserId: "a", operationType: "adjustment", affectedCustomerId: "c1" });
    const forC1 = rec.forCustomer("c1");
    expect(forC1).toHaveLength(2);
    // Most-recent-first: the later adjustment appears first.
    expect(forC1[0]!.operationType).toBe("adjustment");
  });

  it("defensively copies detail so the caller's object cannot mutate the record", async () => {
    const rec = new InMemoryAuditTrailRecorder();
    const detail = { points: 10 };
    const out = await rec.record({ adminUserId: "a", operationType: "adjustment", detail });
    detail.points = 999;
    expect(out.detail).toEqual({ points: 10 });
  });
});
