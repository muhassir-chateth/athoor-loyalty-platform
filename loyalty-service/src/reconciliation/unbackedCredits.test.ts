/**
 * Property 17 runtime watchdog (Req 1.3a) — `detectUnbackedCredits` and its
 * integration into the reconciliation pass.
 *
 * WHY THESE TESTS EXIST: a positive ledger entry with no backing `point_lots`
 * row makes credited points permanently unredeemable, and until now nothing
 * detected it at runtime. `reconstructLotRemainders` recomputes the remainders of
 * lots that EXIST, so a missing lot reconciles as "clean" and the gap between
 * Balance and Spendable_Balance stays invisible. That is not hypothetical: two
 * real lots were destroyed on staging by a rehearsal cleanup and the 200
 * unredeemable points survived two subsequent tasks unnoticed
 * (docs/ops/dashboard-audit.md §3.1).
 *
 * The tests therefore pin three things: detection finds the violation, the
 * reconciliation pass ESCALATES it (a returned field alone would be silent,
 * because the scheduled job discards its return value), and neither detection
 * nor escalation can break a pass that is repairing real drift.
 */
import { describe, it, expect } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { detectUnbackedCredits, type UnbackedCredit } from "./reconcile.js";

/** A fake Queryable returning scripted rows, recording the SQL it was asked for. */
function fakeDb(rows: QueryResultRow[], onQuery?: (sql: string) => void) {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
    ): Promise<QueryResult<R>> {
      onQuery?.(sql);
      return { rows: rows as R[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
}

const ROW_A = {
  id: "entry-a",
  customer_id: "cust-1",
  shopify_customer_id: "9037455327431",
  entry_type: "earn_signup",
  points: "50",
  reason: "signup_bonus",
  created_at: new Date("2026-07-26T12:59:54.330Z"),
};

const ROW_B = {
  id: "entry-b",
  customer_id: "cust-1",
  shopify_customer_id: "9037455327431",
  entry_type: "earn_referral",
  points: "150",
  reason: "referral_signup_bonus",
  created_at: new Date("2026-07-26T13:01:32.831Z"),
};

const ROW_OTHER = {
  id: "entry-c",
  customer_id: "cust-2",
  shopify_customer_id: "9037455425735",
  entry_type: "earn_order",
  points: "200",
  reason: "paid_order",
  created_at: new Date("2026-07-26T13:03:32.388Z"),
};

describe("detectUnbackedCredits (Property 17 / Req 1.3a)", () => {
  it("returns an empty list on a healthy ledger", async () => {
    expect(await detectUnbackedCredits(fakeDb([]))).toEqual([]);
  });

  it("maps each violation with the ids and points an operator needs", async () => {
    const found = await detectUnbackedCredits(fakeDb([ROW_A, ROW_B]));

    expect(found).toHaveLength(2);
    expect(found[0]).toEqual<UnbackedCredit>({
      ledgerEntryId: "entry-a",
      customerId: "cust-1",
      shopifyCustomerId: "9037455327431",
      entryType: "earn_signup",
      points: 50,
      reason: "signup_bonus",
      createdAt: ROW_A.created_at,
    });
    // BIGINT arrives from `pg` as a string; it must surface as a number.
    expect(typeof found[1]?.points).toBe("number");
    expect(found[1]?.points).toBe(150);
  });

  it("coerces a numeric shopify_customer_id to a string", async () => {
    const found = await detectUnbackedCredits(
      fakeDb([{ ...ROW_A, shopify_customer_id: 9037455327431 }]),
    );
    expect(found[0]?.shopifyCustomerId).toBe("9037455327431");
  });

  it("scopes to the given customerIds so a per-customer run reports only that customer", async () => {
    const found = await detectUnbackedCredits(fakeDb([ROW_A, ROW_B, ROW_OTHER]), ["cust-2"]);

    expect(found).toHaveLength(1);
    expect(found[0]?.customerId).toBe("cust-2");
  });

  it("reports every customer when no scope is given", async () => {
    const found = await detectUnbackedCredits(fakeDb([ROW_A, ROW_B, ROW_OTHER]));
    expect(found.map((u) => u.customerId)).toEqual(["cust-1", "cust-1", "cust-2"]);
  });

  it("only ever reads — it must not repair, because inserting a lot grants spendable points", async () => {
    const statements: string[] = [];
    await detectUnbackedCredits(fakeDb([ROW_A], (sql) => statements.push(sql)));

    expect(statements).toHaveLength(1);
    const sql = statements[0] ?? "";
    expect(sql).toMatch(/^\s*SELECT/);
    for (const forbidden of ["INSERT", "UPDATE", "DELETE"]) {
      expect(sql.toUpperCase()).not.toContain(forbidden);
    }
  });

  it("finds entries by absence of a lot, not by a balance comparison", async () => {
    // The guard must be a NOT EXISTS against point_lots.ledger_entry_id: a
    // balance-vs-spendable comparison would also fire for legitimately expired
    // or fully spent lots, which are not violations.
    let captured = "";
    await detectUnbackedCredits(fakeDb([], (sql) => (captured = sql)));

    expect(captured).toContain("NOT EXISTS");
    expect(captured).toContain("point_lots");
    expect(captured).toContain("ledger_entry_id");
    expect(captured).toContain("points > 0");
  });
});

describe("runReconciliation escalates Property 17 violations", () => {
  /**
   * Minimal deps: no customers to reconcile (so the per-customer pass is a
   * no-op), but the unbacked-credit query returns violations. That isolates the
   * escalation path from cache-repair behaviour.
   */
  function depsWith(unbackedRows: QueryResultRow[], onUnbackedCredits?: (u: readonly UnbackedCredit[]) => void) {
    const db = {
      async query<R extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<R>> {
        const rows = sql.includes("NOT EXISTS") ? unbackedRows : [];
        return { rows: rows as R[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
      },
    };
    return {
      db,
      transactor: { transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db) },
      metafieldWriter: { write: async () => ({ status: "written" as const }) },
      ...(onUnbackedCredits ? { onUnbackedCredits } : {}),
    };
  }

  it("calls onUnbackedCredits with the violations, so the detection is not silent", async () => {
    const { runReconciliation } = await import("./reconcile.js");
    const seen: UnbackedCredit[][] = [];

    const result = await runReconciliation(
      depsWith([ROW_A, ROW_B], (u) => seen.push([...u])) as never,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(result.unbackedCredits).toHaveLength(2);
    expect(result.unbackedCredits[0]?.ledgerEntryId).toBe("entry-a");
  });

  it("does not call the callback on a healthy ledger", async () => {
    const { runReconciliation } = await import("./reconcile.js");
    let calls = 0;

    const result = await runReconciliation(depsWith([], () => calls++) as never);

    expect(calls).toBe(0);
    expect(result.unbackedCredits).toEqual([]);
  });

  it("a throwing callback does not fail the reconciliation pass", async () => {
    const { runReconciliation } = await import("./reconcile.js");

    const result = await runReconciliation(
      depsWith([ROW_A], () => {
        throw new Error("logger exploded");
      }) as never,
    );

    // Reporting must never break repair.
    expect(result.unbackedCredits).toHaveLength(1);
    expect(result.processed).toBe(0);
  });
});
