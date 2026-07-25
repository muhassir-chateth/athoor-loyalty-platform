/**
 * Unit tests for the append-only ledger repository (task 2.1).
 *
 * No live/production database is touched. A fake {@link Queryable} captures the
 * INSERTs the repository would issue and returns a synthesised row, so the
 * append + validation + append-only contract (Requirement 1: 1.1, 1.4, 1.5,
 * 1.6, 1.8) is verified without any Postgres. Applying against a real database
 * is deferred to deploy time (`npm run migrate:up` + integration runs).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  AppendOnlyViolationError,
  DEBIT_ENTRY_TYPES,
  EARN_ENTRY_TYPES,
  LEDGER_ENTRY_TYPES,
  LEDGER_ERROR_CODES,
  LedgerAppendError,
  LedgerRepository,
  LedgerValidationError,
  validateAppendEntry,
  type AppendEntryInput,
  type LedgerEntryType,
  type Queryable,
} from "./repository.js";

interface CapturedInsert {
  queryText: string;
  values: unknown[];
}

/**
 * A fake Queryable that records every INSERT and echoes a plausible row back,
 * mirroring what Postgres would RETURNING. BIGINT columns are returned as
 * strings (as `pg` does) so the repository's parsing is exercised too.
 */
function makeFakeDb(): { db: Queryable; inserts: CapturedInsert[] } {
  const inserts: CapturedInsert[] = [];
  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      inserts.push({ queryText, values });
      const [customerId, entryType, points, reason, orderRef, lotId, redemptionId, sourceEventId] =
        values;
      const row = {
        id: "00000000-0000-0000-0000-000000000001",
        customer_id: customerId as string,
        entry_type: entryType as string,
        points: String(points), // pg returns BIGINT as string
        reason: reason as string,
        order_reference: orderRef === null || orderRef === undefined ? null : String(orderRef),
        point_lot_id: (lotId as string | null) ?? null,
        redemption_id: (redemptionId as string | null) ?? null,
        source_event_id: (sourceEventId as string | null) ?? null,
        created_at: new Date("2025-01-01T00:00:00.000Z"),
      };
      return {
        rows: [row as unknown as R],
        rowCount: 1,
        command: "INSERT",
        oid: 0,
        fields: [],
      };
    },
  };
  return { db, inserts };
}

/** A Queryable that always fails, to simulate a DB append failure (Req 1.8). */
function makeFailingDb(err: Error): { db: Queryable; calls: number } {
  const state = { calls: 0 };
  const db: Queryable = {
    async query(): Promise<never> {
      state.calls += 1;
      throw err;
    },
  };
  return { db, get calls() {
    return state.calls;
  } };
}

const CUSTOMER = "11111111-1111-1111-1111-111111111111";

function baseEntry(overrides: Partial<AppendEntryInput> = {}): AppendEntryInput {
  return {
    customerId: CUSTOMER,
    entryType: "earn_signup",
    points: 50,
    reason: "signup bonus",
    ...overrides,
  };
}

describe("LEDGER_ENTRY_TYPES (Req 1.1)", () => {
  it("declares exactly the nine design entry types", () => {
    expect([...LEDGER_ENTRY_TYPES]).toEqual([
      "earn_signup",
      "earn_order",
      "earn_first_purchase",
      "earn_referral",
      "spend",
      "clawback",
      "expire",
      "adjust",
      "migration",
    ]);
  });
});

describe("append: records exactly one signed-integer entry (Req 1.1)", () => {
  it("issues a single INSERT with type, amount, reason, customer id", async () => {
    const { db, inserts } = makeFakeDb();
    const repo = new LedgerRepository(db);

    const entry = await repo.append(baseEntry());

    expect(inserts).toHaveLength(1);
    const insert = inserts[0]!;
    expect(insert.queryText).toContain("INSERT INTO ledger_entries");
    expect(insert.queryText).not.toMatch(/UPDATE|DELETE/i);
    // customer_id, entry_type, points, reason are the first four bound params.
    expect(insert.values.slice(0, 4)).toEqual([CUSTOMER, "earn_signup", 50, "signup bonus"]);

    expect(entry.id).toBeTruthy();
    expect(entry.customerId).toBe(CUSTOMER);
    expect(entry.entryType).toBe("earn_signup");
    expect(entry.points).toBe(50);
    expect(entry.reason).toBe("signup bonus");
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("parses BIGINT points returned as a string back into a number", async () => {
    const { db } = makeFakeDb();
    const repo = new LedgerRepository(db);
    const entry = await repo.append(baseEntry({ entryType: "earn_order", points: 1234 }));
    expect(entry.points).toBe(1234);
    expect(typeof entry.points).toBe("number");
  });

  it("passes optional references through and defaults absent ones to null", async () => {
    const { db, inserts } = makeFakeDb();
    const repo = new LedgerRepository(db);

    await repo.append(
      baseEntry({
        entryType: "spend",
        points: -100,
        reason: "reward_5",
        redemptionId: "22222222-2222-2222-2222-222222222222",
      }),
    );

    const values = inserts[0]!.values;
    // order: customer, type, points, reason, orderRef, lotId, redemptionId, sourceEventId
    expect(values[4]).toBeNull(); // orderReference
    expect(values[5]).toBeNull(); // pointLotId
    expect(values[6]).toBe("22222222-2222-2222-2222-222222222222");
    expect(values[7]).toBeNull(); // sourceEventId
  });

  it("runs within a caller-supplied transaction client when provided", async () => {
    const { db: pool } = makeFakeDb();
    const { db: txClient, inserts: txInserts } = makeFakeDb();
    const repo = new LedgerRepository(pool);

    await repo.append(baseEntry({ entryType: "migration", points: 500, reason: "M1 backfill" }), txClient);

    expect(txInserts).toHaveLength(1);
  });
});

describe("sign rules: earn_* strictly positive (Req 1.4)", () => {
  for (const entryType of EARN_ENTRY_TYPES) {
    it(`accepts a positive amount for ${entryType}`, async () => {
      const { db } = makeFakeDb();
      const repo = new LedgerRepository(db);
      const entry = await repo.append(baseEntry({ entryType, points: 10 }));
      expect(entry.points).toBe(10);
    });

    it(`rejects a zero amount for ${entryType}`, async () => {
      const { db, inserts } = makeFakeDb();
      const repo = new LedgerRepository(db);
      await expect(repo.append(baseEntry({ entryType, points: 0 }))).rejects.toBeInstanceOf(
        LedgerValidationError,
      );
      expect(inserts).toHaveLength(0);
    });

    it(`rejects a negative amount for ${entryType}`, async () => {
      const { db, inserts } = makeFakeDb();
      const repo = new LedgerRepository(db);
      await expect(repo.append(baseEntry({ entryType, points: -5 }))).rejects.toBeInstanceOf(
        LedgerValidationError,
      );
      expect(inserts).toHaveLength(0);
    });
  }
});

describe("sign rules: spend/clawback/expire strictly negative (Req 1.5)", () => {
  for (const entryType of DEBIT_ENTRY_TYPES) {
    it(`accepts a negative amount for ${entryType}`, async () => {
      const { db } = makeFakeDb();
      const repo = new LedgerRepository(db);
      const entry = await repo.append(baseEntry({ entryType, points: -100, reason: "debit" }));
      expect(entry.points).toBe(-100);
    });

    it(`rejects a zero amount for ${entryType}`, async () => {
      const { db, inserts } = makeFakeDb();
      const repo = new LedgerRepository(db);
      await expect(
        repo.append(baseEntry({ entryType, points: 0, reason: "debit" })),
      ).rejects.toBeInstanceOf(LedgerValidationError);
      expect(inserts).toHaveLength(0);
    });

    it(`rejects a positive amount for ${entryType}`, async () => {
      const { db, inserts } = makeFakeDb();
      const repo = new LedgerRepository(db);
      await expect(
        repo.append(baseEntry({ entryType, points: 100, reason: "debit" })),
      ).rejects.toBeInstanceOf(LedgerValidationError);
      expect(inserts).toHaveLength(0);
    });
  }
});

describe("sign rules: adjust/migration may carry either sign but must be non-zero", () => {
  for (const entryType of ["adjust", "migration"] as LedgerEntryType[]) {
    it(`accepts a positive amount for ${entryType}`, async () => {
      const { db } = makeFakeDb();
      const repo = new LedgerRepository(db);
      const entry = await repo.append(baseEntry({ entryType, points: 75, reason: "r" }));
      expect(entry.points).toBe(75);
    });

    it(`accepts a negative amount for ${entryType}`, async () => {
      const { db } = makeFakeDb();
      const repo = new LedgerRepository(db);
      const entry = await repo.append(baseEntry({ entryType, points: -75, reason: "r" }));
      expect(entry.points).toBe(-75);
    });

    it(`rejects a zero amount for ${entryType}`, async () => {
      const { db, inserts } = makeFakeDb();
      const repo = new LedgerRepository(db);
      await expect(
        repo.append(baseEntry({ entryType, points: 0, reason: "r" })),
      ).rejects.toBeInstanceOf(LedgerValidationError);
      expect(inserts).toHaveLength(0);
    });
  }
});

describe("entry validation (Req 1.1)", () => {
  it("rejects a non-integer amount", () => {
    expect(() => validateAppendEntry(baseEntry({ points: 12.5 }))).toThrow(LedgerValidationError);
  });

  it("rejects a non-finite amount", () => {
    expect(() => validateAppendEntry(baseEntry({ points: Number.NaN }))).toThrow(
      LedgerValidationError,
    );
  });

  it("rejects an amount outside the safe integer range", () => {
    expect(() =>
      validateAppendEntry(baseEntry({ points: Number.MAX_SAFE_INTEGER + 2 })),
    ).toThrow(LedgerValidationError);
  });

  it("rejects an unknown entry type", () => {
    expect(() =>
      validateAppendEntry(baseEntry({ entryType: "earn_bonus" as LedgerEntryType })),
    ).toThrow(LedgerValidationError);
  });

  it("rejects an empty reason", () => {
    expect(() => validateAppendEntry(baseEntry({ reason: "   " }))).toThrow(LedgerValidationError);
  });

  it("rejects a missing customer id", () => {
    expect(() => validateAppendEntry(baseEntry({ customerId: "" }))).toThrow(LedgerValidationError);
  });

  it("does not touch the database when validation fails", async () => {
    const { db, inserts } = makeFakeDb();
    const repo = new LedgerRepository(db);
    await expect(repo.append(baseEntry({ points: 0 }))).rejects.toBeInstanceOf(
      LedgerValidationError,
    );
    expect(inserts).toHaveLength(0);
  });
});

describe("append-only contract (Req 1.6)", () => {
  it("exposes no update/delete of existing rows and rejects update()", () => {
    const { db } = makeFakeDb();
    const repo = new LedgerRepository(db);
    expect(() => repo.update()).toThrow(AppendOnlyViolationError);
  });

  it("rejects remove() as an append-only violation", () => {
    const { db } = makeFakeDb();
    const repo = new LedgerRepository(db);
    expect(() => repo.remove()).toThrow(AppendOnlyViolationError);
  });

  it("surfaces the append-only error code", () => {
    const { db } = makeFakeDb();
    const repo = new LedgerRepository(db);
    try {
      repo.update();
      expect.unreachable("update() must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppendOnlyViolationError);
      expect((err as AppendOnlyViolationError).code).toBe(LEDGER_ERROR_CODES.appendOnly);
    }
  });

  it("never emits UPDATE or DELETE SQL for any append", async () => {
    const { db, inserts } = makeFakeDb();
    const repo = new LedgerRepository(db);
    await repo.append(baseEntry());
    for (const insert of inserts) {
      expect(insert.queryText).not.toMatch(/\bUPDATE\b|\bDELETE\b/i);
    }
  });
});

describe("append failure leaves the ledger unchanged (Req 1.8)", () => {
  it("wraps a DB error as LedgerAppendError and rejects the operation", async () => {
    const { db } = makeFailingDb(new Error("connection reset"));
    const repo = new LedgerRepository(db);

    await expect(repo.append(baseEntry())).rejects.toBeInstanceOf(LedgerAppendError);
  });

  it("preserves the original cause and error code on failure", async () => {
    const cause = new Error("unique_violation");
    const { db } = makeFailingDb(cause);
    const repo = new LedgerRepository(db);

    try {
      await repo.append(baseEntry());
      expect.unreachable("append must throw on DB failure");
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerAppendError);
      expect((err as LedgerAppendError).code).toBe(LEDGER_ERROR_CODES.appendFailed);
      expect((err as LedgerAppendError).cause).toBe(cause);
    }
  });

  it("throws when the append returns no row (nothing persisted)", async () => {
    const emptyDb: Queryable = {
      async query() {
        return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
      },
    };
    const repo = new LedgerRepository(emptyDb);
    await expect(repo.append(baseEntry())).rejects.toBeInstanceOf(LedgerAppendError);
  });
});
