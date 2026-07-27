/**
 * Unit tests for the tier-change history writer (task 46).
 *
 * Covers the contract that made the milestone unreachable before this module
 * existed, and the guards that keep it honest:
 *   - a real transition writes exactly one row with from/to/reason;
 *   - an unchanged tier writes NOTHING (no no-op rows);
 *   - the caller's executor is used, so the row is atomic with the tier UPDATE;
 *   - unrecognised/absent tiers normalise rather than writing junk.
 *
 * Validates: Requirements 17.8, 17.9, 7.3
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  recordTierChange,
  TIER_CHANGE_REASON_CLAWBACK,
  TIER_CHANGE_REASON_PAID_ORDER,
} from "./tierHistory.js";

const CUST = "11111111-1111-4111-8111-111111111111";

/** Records every statement so we can assert exactly what was (not) issued. */
class RecordingExecutor implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    this.calls.push({ sql, params: params ?? [] });
    return {
      rows: [] as R[],
      rowCount: 1,
      command: "INSERT",
      oid: 0,
      fields: [],
    } as unknown as QueryResult<R>;
  }

  /** The INSERTs issued against tier_change_history. */
  get inserts(): Array<{ sql: string; params: readonly unknown[] }> {
    return this.calls.filter((c) => /INSERT INTO tier_change_history/i.test(c.sql));
  }
}

describe("recordTierChange: writes one row per real transition (Req 17.8)", () => {
  it("writes a row for a single-threshold promotion", async () => {
    const ex = new RecordingExecutor();

    await expect(
      recordTierChange(ex, CUST, "bronze", "silver", TIER_CHANGE_REASON_PAID_ORDER),
    ).resolves.toBe(true);

    expect(ex.inserts).toHaveLength(1);
    expect(ex.inserts[0]!.params).toEqual([CUST, "bronze", "silver", "paid_order"]);
  });

  it("writes a single row for a multi-threshold promotion (bronze → gold)", async () => {
    // The genuine task 45 order jumped two tiers at once; that is ONE change.
    const ex = new RecordingExecutor();

    await expect(
      recordTierChange(ex, CUST, "bronze", "gold", TIER_CHANGE_REASON_PAID_ORDER),
    ).resolves.toBe(true);

    expect(ex.inserts).toHaveLength(1);
    expect(ex.inserts[0]!.params).toEqual([CUST, "bronze", "gold", "paid_order"]);
  });

  it("records a downgrade with the clawback reason", async () => {
    const ex = new RecordingExecutor();

    await expect(
      recordTierChange(ex, CUST, "gold", "silver", TIER_CHANGE_REASON_CLAWBACK),
    ).resolves.toBe(true);

    expect(ex.inserts[0]!.params).toEqual([CUST, "gold", "silver", "clawback"]);
  });
});

describe("recordTierChange: no-op when the tier did not change (Req 17.9)", () => {
  it("writes nothing when from and to are identical", async () => {
    const ex = new RecordingExecutor();

    await expect(
      recordTierChange(ex, CUST, "silver", "silver", TIER_CHANGE_REASON_PAID_ORDER),
    ).resolves.toBe(false);

    expect(ex.calls).toHaveLength(0);
  });

  it("writes nothing for repeated calls with the same unchanged tier", async () => {
    const ex = new RecordingExecutor();

    for (let i = 0; i < 5; i += 1) {
      await recordTierChange(ex, CUST, "gold", "gold", TIER_CHANGE_REASON_PAID_ORDER);
    }

    expect(ex.calls).toHaveLength(0);
  });

  it("treats an absent/unrecognised pair as bronze → bronze and writes nothing", async () => {
    const ex = new RecordingExecutor();

    await expect(
      recordTierChange(ex, CUST, undefined, "platinum", TIER_CHANGE_REASON_PAID_ORDER),
    ).resolves.toBe(false);
    await expect(
      recordTierChange(ex, CUST, null, "bronze", TIER_CHANGE_REASON_PAID_ORDER),
    ).resolves.toBe(false);

    expect(ex.calls).toHaveLength(0);
  });
});

describe("recordTierChange: normalisation and atomicity", () => {
  it("normalises an unrecognised source tier to bronze rather than writing it raw", async () => {
    const ex = new RecordingExecutor();

    await expect(
      recordTierChange(ex, CUST, "platinum", "gold", TIER_CHANGE_REASON_PAID_ORDER),
    ).resolves.toBe(true);

    // 'platinum' is not a tier; it normalises to bronze (Req 2.4/7.4) so the
    // stored history can only ever contain recognised tier values.
    expect(ex.inserts[0]!.params).toEqual([CUST, "bronze", "gold", "paid_order"]);
  });

  it("issues the INSERT on the executor it was given, never on another handle", async () => {
    // This is what makes the row atomic with the tier UPDATE: the caller passes
    // its transaction client and this module uses exactly that.
    const tx = new RecordingExecutor();
    const pool = new RecordingExecutor();

    await recordTierChange(tx, CUST, "bronze", "royal_vip", TIER_CHANGE_REASON_PAID_ORDER);

    expect(tx.inserts).toHaveLength(1);
    expect(pool.calls).toHaveLength(0);
  });

  it("propagates a write failure so the surrounding transaction rolls back", async () => {
    const failing: Queryable = {
      async query() {
        throw new Error("insert failed");
      },
    };

    await expect(
      recordTierChange(failing, CUST, "bronze", "gold", TIER_CHANGE_REASON_PAID_ORDER),
    ).rejects.toThrow("insert failed");
  });
});
