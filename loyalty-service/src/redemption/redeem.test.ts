/**
 * Unit tests for concurrency-safe redemption (task 5.2).
 *
 * No live/production database or Shopify Admin API is touched. The redemption
 * flow is exercised end-to-end against a stateful in-memory fake that models
 * the tables and the SQL the flow issues — the customer lock, the redemptions
 * idempotency select/insert, the append-only ledger insert, the spendable
 * SUM projection, and the point_lots FIFO select/decrement — plus a fake
 * Transactor and a recording discount-code enqueuer. The real
 * {@link LedgerRepository}, {@link consumeLotsFifo}, and reward catalog are
 * used unchanged; only the DB boundary is faked.
 *
 * Covers:
 *   - successful spend + FIFO consume + pending redemption + one enqueued job
 *     (Req 3.2, 3.4; Properties 3, 4);
 *   - insufficient balance rolls back with no ledger change (Req 3.3, 5.7);
 *   - idempotent replay returns the same redemption with exactly one spend and
 *     no second job (Req 3.7, Property 5);
 *   - unknown reward rejected before any ledger change (Req 3.10);
 *   - lock-timeout path aborts with no ledger change (Req 3.11).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { UnknownRewardError } from "../rewards/catalog.js";
import {
  CustomerNotFoundError,
  InvalidIdempotencyKeyError,
  LockTimeoutError,
  redeem,
  REDEMPTION_STATUS_PENDING,
  RedemptionInsufficientPointsError,
  type DiscountCodeEnqueuer,
  type Transactor,
} from "./redeem.js";

const CUSTOMER = "11111111-1111-1111-1111-111111111111";

interface FakeLot {
  id: string;
  remaining_points: number;
  earned_at: Date;
  expires_at: Date | null;
  seq: number;
}

interface FakeRedemption {
  id: string;
  customer_id: string;
  reward_id: string;
  points_spent: number;
  value_gbp: number;
  status: string;
  idempotency_key: string;
  discount_code_id: string | null;
  channel: string;
  created_at: Date;
}

interface FakeLedgerEntry {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  order_reference: number | null;
  point_lot_id: string | null;
  redemption_id: string | null;
  source_event_id: string | null;
  created_at: Date;
}

interface FakeDbOptions {
  /** Whether a customer row exists to lock (default true). */
  customerExists?: boolean;
  /** Initial point lots. */
  lots?: FakeLot[];
  /** Pre-existing redemptions (for the idempotency-replay case). */
  redemptions?: FakeRedemption[];
  /** When true, the customer FOR UPDATE lock throws a Postgres 55P03 (lock timeout). */
  lockTimeout?: boolean;
}

interface FakeDb {
  db: Queryable;
  lots: FakeLot[];
  redemptions: FakeRedemption[];
  ledger: FakeLedgerEntry[];
  /** Ordered log of the SQL statements issued, for lock-ordering assertions. */
  statements: string[];
}

/** A Postgres-shaped error carrying a SQLSTATE `code`. */
function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function makeDb(options: FakeDbOptions = {}): FakeDb {
  const customerExists = options.customerExists ?? true;
  const lots = (options.lots ?? []).map((l) => ({ ...l }));
  const redemptions = (options.redemptions ?? []).map((r) => ({ ...r }));
  const ledger: FakeLedgerEntry[] = [];
  const statements: string[] = [];
  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++idCounter}`;

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      statements.push(queryText.trim());
      const ok = <T extends QueryResultRow>(rows: T[], command: string): QueryResult<T> => ({
        rows,
        rowCount: rows.length,
        command,
        oid: 0,
        fields: [],
      });

      if (/SET LOCAL lock_timeout/i.test(queryText)) {
        return ok([], "SET") as unknown as QueryResult<R>;
      }

      if (/FROM customers WHERE id/i.test(queryText) && /FOR UPDATE/i.test(queryText)) {
        if (options.lockTimeout) {
          throw pgError("55P03", "canceling statement due to lock timeout");
        }
        const rows = customerExists ? [{ id: values[0] as string }] : [];
        return ok(rows as unknown as R[], "SELECT");
      }

      if (/INSERT INTO redemptions/i.test(queryText)) {
        const [customer_id, reward_id, points_spent, value_gbp, status, idempotency_key, channel] =
          values as [string, string, number, number, string, string, string];
        // Enforce the UNIQUE (customer_id, idempotency_key) constraint.
        const clash = redemptions.find(
          (r) => r.customer_id === customer_id && r.idempotency_key === idempotency_key,
        );
        if (clash) {
          throw pgError("23505", "duplicate key value violates unique constraint");
        }
        const row: FakeRedemption = {
          id: nextId("redemption"),
          customer_id,
          reward_id,
          points_spent,
          value_gbp,
          status,
          idempotency_key,
          discount_code_id: null,
          channel: channel ?? "web",
          created_at: new Date("2025-06-01T00:00:00.000Z"),
        };
        redemptions.push(row);
        return ok([{ ...row, points_spent: String(points_spent), value_gbp: String(value_gbp) }] as unknown as R[], "INSERT");
      }

      if (/FROM redemptions/i.test(queryText)) {
        const [customer_id, idempotency_key] = values as [string, string];
        const found = redemptions.find(
          (r) => r.customer_id === customer_id && r.idempotency_key === idempotency_key,
        );
        const rows = found
          ? [{ ...found, points_spent: String(found.points_spent), value_gbp: String(found.value_gbp) }]
          : [];
        return ok(rows as unknown as R[], "SELECT");
      }

      if (/INSERT INTO ledger_entries/i.test(queryText)) {
        const [
          customer_id,
          entry_type,
          points,
          reason,
          order_reference,
          point_lot_id,
          redemption_id,
          source_event_id,
        ] = values as [string, string, number, string, number | null, string | null, string | null, string | null];
        const row: FakeLedgerEntry = {
          id: nextId("ledger"),
          customer_id,
          entry_type,
          points,
          reason,
          order_reference: order_reference ?? null,
          point_lot_id: point_lot_id ?? null,
          redemption_id: redemption_id ?? null,
          source_event_id: source_event_id ?? null,
          created_at: new Date("2025-06-01T00:00:00.000Z"),
        };
        ledger.push(row);
        return ok([{ ...row, points: String(points) }] as unknown as R[], "INSERT");
      }

      if (/SUM\(remaining_points\)/i.test(queryText)) {
        const asOf = values[1] as Date;
        const sum = lots
          .filter(
            (l) =>
              l.remaining_points > 0 &&
              (l.expires_at === null || l.expires_at.getTime() > asOf.getTime()),
          )
          .reduce((s, l) => s + l.remaining_points, 0);
        return ok([{ spendable: String(sum) }] as unknown as R[], "SELECT");
      }

      if (/FROM point_lots/i.test(queryText) && /FOR UPDATE/i.test(queryText)) {
        const asOf = values[1] as Date;
        const selected = lots
          .filter(
            (l) =>
              l.remaining_points > 0 &&
              (l.expires_at === null || l.expires_at.getTime() > asOf.getTime()),
          )
          .sort((a, b) => a.earned_at.getTime() - b.earned_at.getTime() || a.seq - b.seq)
          .map((l) => ({
            id: l.id,
            remaining_points: String(l.remaining_points),
            earned_at: l.earned_at,
            expires_at: l.expires_at,
          }));
        return ok(selected as unknown as R[], "SELECT");
      }

      if (/UPDATE point_lots/i.test(queryText)) {
        const take = values[0] as number;
        const lotId = values[1] as string;
        const target = lots.find((l) => l.id === lotId);
        if (!target) {
          throw new Error(`lot ${lotId} not found`);
        }
        target.remaining_points -= take;
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      throw new Error(`unexpected query: ${queryText}`);
    },
  };

  return { db, lots, redemptions, ledger, statements };
}

/** A fake Transactor that runs the callback against the fake db (no real BEGIN/COMMIT). */
function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

/** Records enqueued discount-code jobs. */
class RecordingEnqueuer implements DiscountCodeEnqueuer {
  readonly jobs: Array<{ redemptionId: string }> = [];
  async enqueueDiscountCode(job: { redemptionId: string }): Promise<void> {
    this.jobs.push(job);
  }
}

function makeDeps(fake: FakeDb) {
  const repo = new LedgerRepository(fake.db);
  const transactor = makeTransactor(fake.db);
  const enqueuer = new RecordingEnqueuer();
  return { repo, transactor, enqueuer };
}

function lot(over: Partial<FakeLot> & Pick<FakeLot, "id" | "remaining_points">): FakeLot {
  return {
    earned_at: new Date("2025-01-01T00:00:00.000Z"),
    expires_at: new Date("2030-01-01T00:00:00.000Z"),
    seq: 0,
    ...over,
  };
}

describe("redeem: successful spend + FIFO consume + pending redemption (Req 3.2, 3.4; Properties 3,4)", () => {
  it("records one negative spend equal to cost, consumes lots FIFO, and enqueues one job", async () => {
    const fake = makeDb({
      lots: [
        lot({ id: "old", remaining_points: 60, earned_at: new Date("2025-01-01T00:00:00Z"), seq: 0 }),
        lot({ id: "new", remaining_points: 100, earned_at: new Date("2025-02-01T00:00:00Z"), seq: 1 }),
      ],
    });
    const deps = makeDeps(fake);

    const outcome = await redeem(CUSTOMER, "reward_5", "key-1", deps);

    expect(outcome.status).toBe("redeemed");
    if (outcome.status !== "redeemed") return;

    // Exactly one negative spend entry equal to the reward cost (Req 3.2, Property 4).
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger[0]!.entry_type).toBe("spend");
    expect(fake.ledger[0]!.points).toBe(-100);
    expect(fake.ledger[0]!.reason).toBe("reward_5");
    expect(fake.ledger[0]!.redemption_id).toBe(outcome.redemption.id);
    expect(outcome.spendEntry.points).toBe(-100);

    // FIFO consumption drains the oldest lot first, sum of decrements == cost (Property 4).
    expect(outcome.consumption.totalConsumed).toBe(100);
    expect(outcome.consumption.allocations.map((a) => a.lotId)).toEqual(["old", "new"]);
    expect(fake.lots.find((l) => l.id === "old")!.remaining_points).toBe(0);
    expect(fake.lots.find((l) => l.id === "new")!.remaining_points).toBe(60);

    // Resulting spendable is >= 0 (Req 3.4, Property 3): 160 - 100 = 60.
    const remaining = fake.lots.reduce((s, l) => s + l.remaining_points, 0);
    expect(remaining).toBe(60);

    // A pending_code redemption row was recorded with the right cost/value.
    expect(outcome.redemption.status).toBe(REDEMPTION_STATUS_PENDING);
    expect(outcome.redemption.pointsSpent).toBe(100);
    expect(outcome.redemption.valueGBP).toBe(5);
    expect(outcome.redemption.idempotencyKey).toBe("key-1");

    // Exactly one discount-code job enqueued (after commit).
    expect(deps.enqueuer.jobs).toEqual([{ redemptionId: outcome.redemption.id }]);
  });

  it("locks the customer row before checking balance or spending", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 100 })] });
    await redeem(CUSTOMER, "reward_5", "key-order", makeDeps(fake));

    const lockIdx = fake.statements.findIndex((s) => /FROM customers.*FOR UPDATE/is.test(s));
    const spendIdx = fake.statements.findIndex((s) => /INSERT INTO ledger_entries/i.test(s));
    const timeoutIdx = fake.statements.findIndex((s) => /SET LOCAL lock_timeout/i.test(s));
    expect(timeoutIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(timeoutIdx);
    expect(spendIdx).toBeGreaterThan(lockIdx);
  });

  it("consumes exactly to zero when the balance equals the cost", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 100 })] });
    const outcome = await redeem(CUSTOMER, "reward_5", "key-exact", makeDeps(fake));
    expect(outcome.status).toBe("redeemed");
    expect(fake.lots[0]!.remaining_points).toBe(0);
  });
});

describe("redeem: insufficient balance rolls back with no ledger change (Req 3.3, 5.7)", () => {
  it("throws RedemptionInsufficientPointsError and writes no spend and no lot decrement", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 50 })] });
    const deps = makeDeps(fake);

    await expect(redeem(CUSTOMER, "reward_5", "key-poor", deps)).rejects.toBeInstanceOf(
      RedemptionInsufficientPointsError,
    );

    // No ledger entry, no redemption row, no lot change, no job (Req 3.3, 5.7).
    expect(fake.ledger).toHaveLength(0);
    expect(fake.redemptions).toHaveLength(0);
    expect(fake.lots[0]!.remaining_points).toBe(50);
    expect(deps.enqueuer.jobs).toHaveLength(0);
  });

  it("carries requested cost and available balance on the error", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 50 })] });
    try {
      await redeem(CUSTOMER, "reward_5", "key-poor2", makeDeps(fake));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RedemptionInsufficientPointsError);
      expect((err as RedemptionInsufficientPointsError).requested).toBe(100);
      expect((err as RedemptionInsufficientPointsError).available).toBe(50);
    }
  });

  it("treats expired lots as unavailable when checking sufficiency", async () => {
    const fake = makeDb({
      lots: [
        lot({
          id: "expired",
          remaining_points: 1000,
          earned_at: new Date("2024-01-01T00:00:00Z"),
          expires_at: new Date("2024-06-01T00:00:00Z"),
        }),
      ],
    });
    const deps = makeDeps(fake);
    await expect(redeem(CUSTOMER, "reward_5", "key-exp", deps)).rejects.toBeInstanceOf(
      RedemptionInsufficientPointsError,
    );
    expect(fake.lots[0]!.remaining_points).toBe(1000);
  });
});

describe("redeem: idempotent replay (Req 3.7, Property 5)", () => {
  it("returns the existing redemption with no second spend and no second job", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 500 })] });
    const deps = makeDeps(fake);

    const first = await redeem(CUSTOMER, "reward_5", "same-key", deps);
    expect(first.status).toBe("redeemed");

    const second = await redeem(CUSTOMER, "reward_5", "same-key", deps);
    expect(second.status).toBe("replayed");
    if (second.status !== "replayed" || first.status !== "redeemed") return;

    // Same redemption returned; exactly one spend; exactly one job (Property 5).
    expect(second.redemption.id).toBe(first.redemption.id);
    expect(fake.ledger.filter((e) => e.entry_type === "spend")).toHaveLength(1);
    expect(fake.redemptions).toHaveLength(1);
    expect(deps.enqueuer.jobs).toHaveLength(1);
    // Only 100 consumed in total across both calls.
    expect(fake.lots[0]!.remaining_points).toBe(400);
  });

  it("distinct idempotency keys each produce their own spend", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 500 })] });
    const deps = makeDeps(fake);

    await redeem(CUSTOMER, "reward_5", "key-a", deps);
    await redeem(CUSTOMER, "reward_5", "key-b", deps);

    expect(fake.ledger.filter((e) => e.entry_type === "spend")).toHaveLength(2);
    expect(fake.redemptions).toHaveLength(2);
    expect(deps.enqueuer.jobs).toHaveLength(2);
    expect(fake.lots[0]!.remaining_points).toBe(300);
  });
});

describe("redeem: unknown reward rejected before any ledger change (Req 3.10)", () => {
  it("throws UnknownRewardError and never opens a transaction or writes", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 1000 })] });
    const deps = makeDeps(fake);

    await expect(redeem(CUSTOMER, "reward_999", "key-x", deps)).rejects.toBeInstanceOf(
      UnknownRewardError,
    );

    expect(fake.statements).toHaveLength(0);
    expect(fake.ledger).toHaveLength(0);
    expect(fake.redemptions).toHaveLength(0);
    expect(deps.enqueuer.jobs).toHaveLength(0);
  });

  it("rejects a missing/empty idempotency key before any ledger change", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 1000 })] });
    const deps = makeDeps(fake);
    await expect(redeem(CUSTOMER, "reward_5", "", deps)).rejects.toBeInstanceOf(
      InvalidIdempotencyKeyError,
    );
    expect(fake.statements).toHaveLength(0);
    expect(fake.ledger).toHaveLength(0);
  });
});

describe("redeem: lock-timeout path aborts with no ledger change (Req 3.11)", () => {
  it("maps Postgres lock timeout to LockTimeoutError and writes nothing", async () => {
    const fake = makeDb({
      lockTimeout: true,
      lots: [lot({ id: "l1", remaining_points: 1000 })],
    });
    const deps = makeDeps(fake);

    await expect(redeem(CUSTOMER, "reward_5", "key-lock", deps)).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    // Aborted at the lock: no redemption, no spend, no consumption, no job (Req 3.11).
    expect(fake.ledger).toHaveLength(0);
    expect(fake.redemptions).toHaveLength(0);
    expect(fake.lots[0]!.remaining_points).toBe(1000);
    expect(deps.enqueuer.jobs).toHaveLength(0);
  });
});

describe("redeem: missing customer", () => {
  it("throws CustomerNotFoundError when the customer row does not exist", async () => {
    const fake = makeDb({ customerExists: false, lots: [] });
    const deps = makeDeps(fake);
    await expect(redeem(CUSTOMER, "reward_5", "key-missing", deps)).rejects.toBeInstanceOf(
      CustomerNotFoundError,
    );
    expect(fake.ledger).toHaveLength(0);
  });
});

describe("redeem: channel attribution (task 21.1, Req 19.3)", () => {
  it("defaults the attributed channel to 'web' when none is supplied", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 100 })] });
    const outcome = await redeem(CUSTOMER, "reward_5", "key-default", makeDeps(fake));
    expect(outcome.status).toBe("redeemed");
    if (outcome.status !== "redeemed") return;

    // The redemption is attributed to 'web' and the column is persisted.
    expect(outcome.redemption.channel).toBe("web");
    expect(fake.redemptions[0]!.channel).toBe("web");
  });

  it("records the attributed 'app' channel on the redemption", async () => {
    const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 100 })] });
    const outcome = await redeem(CUSTOMER, "reward_5", "key-app", makeDeps(fake), "app");
    expect(outcome.status).toBe("redeemed");
    if (outcome.status !== "redeemed") return;

    expect(outcome.redemption.channel).toBe("app");
    expect(fake.redemptions[0]!.channel).toBe("app");
  });

  it("grants a non-app-exclusive reward on both web and app channels (Req 19.4)", async () => {
    // The four MVP rewards are not app-exclusive, so they redeem on any channel.
    for (const channel of ["web", "app"] as const) {
      const fake = makeDb({ lots: [lot({ id: "l1", remaining_points: 100 })] });
      const outcome = await redeem(CUSTOMER, "reward_5", `key-${channel}`, makeDeps(fake), channel);
      expect(outcome.status).toBe("redeemed");
    }
  });
});
