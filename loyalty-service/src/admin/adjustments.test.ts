/**
 * Unit tests for admin manual adjustments and manual credit (task 17.1,
 * Requirements 10.2, 10.3, 10.4, 10.8, 10.9).
 *
 * No live/production database is touched. The real {@link LedgerRepository} is
 * used unchanged against a fake {@link Queryable} that emulates the
 * `INSERT INTO ledger_entries ... RETURNING` the append issues; the immutable
 * audit trail uses the {@link InMemoryAuditTrailRecorder}; a fake transactor
 * runs the unit of work against the fake db. This verifies the reason 1–500
 * rule, signed/positive amount rules, the single `adjust` ledger entry + single
 * immutable audit record, the acting-admin tag on the entry, and the
 * manual-only-action guard for the automated grant path.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { InMemoryAuditTrailRecorder } from "./auditTrail.js";
import type { AdminCtx } from "./adminAuth.js";
import {
  applyAdjustment,
  assertAutomatableAction,
  AutomatedGrantRejectedError,
  grantManualCredit,
  InvalidActionError,
  InvalidAmountError,
  InvalidReasonError,
  isManualOnlyAction,
  REASON_MAX_LENGTH,
  validateReason,
  type AdjustmentDeps,
  type Transactor,
} from "./adjustments.js";

const ADMIN: AdminCtx = { adminUserId: "ops-alice", role: "admin" };
const CUSTOMER = "11111111-1111-1111-1111-111111111111";

/** Fake db emulating the ledger INSERT ... RETURNING. Records the insert. */
function makeFakeDb(): { db: Queryable; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      if (/INSERT INTO ledger_entries/i.test(queryText)) {
        inserts.push(values);
        const [customer_id, entry_type, points, reason, orderRef, lotId, redemptionId, sourceEventId] =
          values;
        const row = {
          id: "ledger-uuid-1",
          customer_id,
          entry_type,
          points: String(points),
          reason,
          order_reference: orderRef ?? null,
          point_lot_id: lotId ?? null,
          redemption_id: redemptionId ?? null,
          source_event_id: sourceEventId ?? null,
          created_at: new Date("2025-03-03T12:00:00.000Z"),
        };
        return { rows: [row as unknown as R], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
    },
  };
  return { db, inserts };
}

/** A transactor that runs the work against the fake db (no real BEGIN/COMMIT). */
function makeTransactor(db: Queryable): Transactor {
  return async (work) => work(db);
}

function makeDeps(): {
  deps: AdjustmentDeps;
  audit: InMemoryAuditTrailRecorder;
  inserts: unknown[][];
} {
  const { db, inserts } = makeFakeDb();
  const audit = new InMemoryAuditTrailRecorder();
  return {
    deps: { repo: new LedgerRepository(db), audit, transactor: makeTransactor(db) },
    audit,
    inserts,
  };
}

describe("validateReason (Req 10.2/10.3)", () => {
  it("accepts a 1-char reason and trims", () => {
    expect(validateReason("  x  ")).toBe("x");
  });

  it("accepts a 500-char reason", () => {
    expect(validateReason("a".repeat(REASON_MAX_LENGTH))).toHaveLength(REASON_MAX_LENGTH);
  });

  it("rejects an empty / whitespace-only reason", () => {
    expect(() => validateReason("")).toThrow(InvalidReasonError);
    expect(() => validateReason("   ")).toThrow(InvalidReasonError);
  });

  it("rejects a reason over 500 chars", () => {
    expect(() => validateReason("a".repeat(REASON_MAX_LENGTH + 1))).toThrow(InvalidReasonError);
  });

  it("rejects a non-string reason", () => {
    expect(() => validateReason(undefined)).toThrow(InvalidReasonError);
  });
});

describe("applyAdjustment (Req 10.2)", () => {
  it("creates one signed `adjust` ledger entry + one audit record", async () => {
    const { deps, audit, inserts } = makeDeps();
    const { entry, audit: auditRec } = await applyAdjustment(
      { customerId: CUSTOMER, points: -30, reason: "chargeback reversal" },
      ADMIN,
      deps,
    );

    expect(inserts).toHaveLength(1);
    expect(entry.entryType).toBe("adjust");
    expect(entry.points).toBe(-30);
    expect(entry.reason).toBe("chargeback reversal");
    // Acting admin recorded ON the ledger entry (Req 10.2).
    expect(entry.sourceEventId).toBe("admin:ops-alice");

    // Exactly one immutable audit record (Req 10.9).
    expect(audit.all()).toHaveLength(1);
    expect(auditRec.operationType).toBe("adjustment");
    expect(auditRec.adminUserId).toBe("ops-alice");
    expect(auditRec.affectedCustomerId).toBe(CUSTOMER);
    expect(auditRec.ledgerEntryId).toBe(entry.id);
    expect(auditRec.detail).toMatchObject({ points: -30, reason: "chargeback reversal" });
  });

  it("accepts a positive delta too (either sign)", async () => {
    const { deps } = makeDeps();
    const { entry } = await applyAdjustment(
      { customerId: CUSTOMER, points: 40, reason: "goodwill" },
      ADMIN,
      deps,
    );
    expect(entry.points).toBe(40);
  });

  it("rejects a missing/empty reason without writing anything (Req 10.3)", async () => {
    const { deps, audit, inserts } = makeDeps();
    await expect(
      applyAdjustment({ customerId: CUSTOMER, points: 10, reason: "  " }, ADMIN, deps),
    ).rejects.toBeInstanceOf(InvalidReasonError);
    expect(inserts).toHaveLength(0);
    expect(audit.all()).toHaveLength(0);
  });

  it("rejects an over-length reason without writing anything (Req 10.3)", async () => {
    const { deps, audit, inserts } = makeDeps();
    await expect(
      applyAdjustment(
        { customerId: CUSTOMER, points: 10, reason: "a".repeat(501) },
        ADMIN,
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidReasonError);
    expect(inserts).toHaveLength(0);
    expect(audit.all()).toHaveLength(0);
  });

  it("rejects a zero / non-integer amount", async () => {
    const { deps } = makeDeps();
    await expect(
      applyAdjustment({ customerId: CUSTOMER, points: 0, reason: "r" }, ADMIN, deps),
    ).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(
      applyAdjustment({ customerId: CUSTOMER, points: 1.5, reason: "r" }, ADMIN, deps),
    ).rejects.toBeInstanceOf(InvalidAmountError);
  });
});

describe("grantManualCredit (Req 10.4)", () => {
  it("creates one positive `adjust` earning entry + a manual_credit audit record", async () => {
    const { deps, audit } = makeDeps();
    const { entry, audit: auditRec } = await grantManualCredit(
      { customerId: CUSTOMER, points: 25, action: "instagram_follow", reason: "Followed @athoor" },
      ADMIN,
      deps,
    );
    expect(entry.entryType).toBe("adjust");
    expect(entry.points).toBe(25);
    expect(entry.sourceEventId).toBe("admin:ops-alice");

    expect(audit.all()).toHaveLength(1);
    expect(auditRec.operationType).toBe("manual_credit");
    expect(auditRec.detail).toMatchObject({ points: 25, action: "instagram_follow" });
  });

  it("rejects a non-positive credit amount", async () => {
    const { deps } = makeDeps();
    await expect(
      grantManualCredit(
        { customerId: CUSTOMER, points: -5, action: "instagram_follow", reason: "r" },
        ADMIN,
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidAmountError);
  });

  it("requires a non-empty action identifier", async () => {
    const { deps, audit } = makeDeps();
    await expect(
      grantManualCredit({ customerId: CUSTOMER, points: 5, action: "  ", reason: "r" }, ADMIN, deps),
    ).rejects.toBeInstanceOf(InvalidActionError);
    expect(audit.all()).toHaveLength(0);
  });

  it("enforces the 1–500 reason rule (Req 10.4)", async () => {
    const { deps } = makeDeps();
    await expect(
      grantManualCredit(
        { customerId: CUSTOMER, points: 5, action: "instagram_follow", reason: "" },
        ADMIN,
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidReasonError);
  });
});

describe("manual-only action guard (Req 10.8)", () => {
  it("flags known unverifiable actions as manual-only", () => {
    expect(isManualOnlyAction("instagram_follow")).toBe(true);
    expect(isManualOnlyAction("social_share")).toBe(true);
    expect(isManualOnlyAction("paid_order")).toBe(false);
  });

  it("rejects an AUTOMATED grant for a manual-only action", () => {
    expect(() => assertAutomatableAction("instagram_follow")).toThrow(AutomatedGrantRejectedError);
  });

  it("allows an automated grant for a verifiable action", () => {
    expect(() => assertAutomatableAction("paid_order")).not.toThrow();
  });
});
