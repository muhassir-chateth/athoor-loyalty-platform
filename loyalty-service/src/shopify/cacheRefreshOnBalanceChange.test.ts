/**
 * Metafield_Cache refresh after EVERY committed balance change (Req 13.1/13.5a).
 *
 * The webhook worker already enqueued a refresh after an earning or clawback,
 * but three other paths change a Balance and did not: a redemption spend, an
 * admin adjustment / manual credit, and a failed-redemption compensating
 * reversal. Staging observed the consequence — a customer's cached
 * `points_balance` read 400 while their spendable balance was 150.
 *
 * These tests drive the real code paths with a recording enqueuer and a fake DB,
 * asserting a refresh is enqueued for the affected customer after the change
 * commits, that a no-op (an idempotent replay) enqueues nothing, and that every
 * path still works when no enqueuer is wired (the Admin-token-absent boot).
 *
 * No live Shopify Admin API or database is touched.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { RecordingMetafieldCacheEnqueuer } from "./metafieldCache.js";
import { applyAdjustment, grantManualCredit } from "../admin/adjustments.js";
import { InMemoryAuditTrailRecorder } from "../admin/auditTrail.js";

const ADMIN = { adminUserId: "admin-1" } as const;
const CUSTOMER_ID = "cust-uuid-1";

/** Minimal fake understanding the ledger append and the lot insert. */
class FakeDb implements Queryable {
  readonly ledger: Array<{ id: string; customer_id: string; points: number }> = [];
  private seq = 0;

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = <T extends QueryResultRow>(rows: T[]): QueryResult<T> => ({
      rows,
      rowCount: rows.length,
      command: "SELECT",
      oid: 0,
      fields: [],
    });

    if (text.includes("INSERT INTO ledger_entries")) {
      this.seq += 1;
      const row = {
        id: `ledg-${this.seq}`,
        customer_id: values[0] as string,
        points: values[2] as number,
      };
      this.ledger.push(row);
      return ok([
        {
          id: row.id,
          customer_id: row.customer_id,
          entry_type: values[1] as string,
          points: String(row.points),
          reason: values[3] as string,
          order_reference: null,
          point_lot_id: null,
          redemption_id: null,
          source_event_id: (values[7] as string | null) ?? null,
          created_at: new Date("2026-04-01T10:00:00.000Z"),
        } as unknown as R,
      ]);
    }
    if (text.includes("INSERT INTO point_lots")) {
      return ok([] as unknown as R[]);
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function deps(db: FakeDb, enqueuer?: RecordingMetafieldCacheEnqueuer) {
  return {
    repo: new LedgerRepository(db),
    audit: new InMemoryAuditTrailRecorder(),
    transactor: <T,>(fn: (tx: Queryable) => Promise<T>): Promise<T> => db.transaction(fn),
    ...(enqueuer ? { metafieldEnqueuer: enqueuer } : {}),
  };
}

describe("admin adjustment / manual credit refresh the display cache (Req 13.1/13.5a)", () => {
  it("enqueues a refresh for the adjusted customer after a positive adjustment", async () => {
    const db = new FakeDb();
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    await applyAdjustment(
      { customerId: CUSTOMER_ID, points: 40, reason: "goodwill" },
      ADMIN,
      deps(db, enqueuer),
    );

    expect(enqueuer.jobs).toEqual([{ customerId: CUSTOMER_ID }]);
  });

  it("enqueues a refresh after a NEGATIVE adjustment too (the balance still changed)", async () => {
    const db = new FakeDb();
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    await applyAdjustment(
      { customerId: CUSTOMER_ID, points: -75, reason: "correction" },
      ADMIN,
      deps(db, enqueuer),
    );

    expect(enqueuer.jobs).toEqual([{ customerId: CUSTOMER_ID }]);
  });

  it("enqueues a refresh after a manual credit", async () => {
    const db = new FakeDb();
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    await grantManualCredit(
      { customerId: CUSTOMER_ID, points: 25, action: "story_share", reason: "shared a story" },
      ADMIN,
      deps(db, enqueuer),
    );

    expect(enqueuer.jobs).toEqual([{ customerId: CUSTOMER_ID }]);
  });

  it("still applies the adjustment when no enqueuer is wired (Admin token absent)", async () => {
    const db = new FakeDb();

    const result = await applyAdjustment(
      { customerId: CUSTOMER_ID, points: 10, reason: "no enqueuer wired" },
      ADMIN,
      deps(db),
    );

    expect(result.entry.points).toBe(10);
    expect(db.ledger).toHaveLength(1);
  });

  it("does not enqueue when validation rejects the adjustment (no balance changed)", async () => {
    const db = new FakeDb();
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    await expect(
      applyAdjustment({ customerId: CUSTOMER_ID, points: 5, reason: "" }, ADMIN, deps(db, enqueuer)),
    ).rejects.toThrow();

    expect(enqueuer.jobs).toEqual([]);
    expect(db.ledger).toHaveLength(0);
  });
});
