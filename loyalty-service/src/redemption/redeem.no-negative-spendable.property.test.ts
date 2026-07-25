/**
 * Property-based test for Property 3 — "No negative spendable" (task 5.4).
 *
 *   post-redemption spendableBalance(c) >= 0
 *
 * **Validates: Requirements 3.4**
 *
 * This is a DISTINCT property-test file for task 5.4. It does not modify the
 * task-5.2 unit tests in `redeem.test.ts` (nor the task-2.4 projection property
 * test in `../ledger/balance.property.test.ts`); it exercises the SAME
 * production {@link redeem} flow, the SAME {@link computeSpendableBalance}
 * projection, and the SAME {@link consumeLotsFifo} FIFO primitive against a
 * single, shared in-memory fake that models the tables and SQL the flow issues
 * — the customer `FOR UPDATE` lock, the redemptions idempotency select/insert,
 * the append-only ledger insert, the `SUM(remaining_points)` spendable
 * projection, and the point_lots FIFO select/decrement.
 *
 * The generator produces arbitrary lot sets AND a sequence of redemption
 * attempts (varying reward tiers/costs, a small pool of idempotency keys so
 * replays occur, and an occasional simulated lock timeout) run against varying
 * spendable balances. After EVERY outcome — `redeemed`, `replayed`, or rejected
 * with an insufficient-points / lock-timeout error — the test asserts:
 *
 *   1. the resulting Spendable_Balance is always >= 0 (Property 3, Req 3.4);
 *   2. a rejected (or replayed) redemption leaves every lot's `remaining_points`
 *      exactly unchanged (Req 3.3, 3.11, 5.7);
 *   3. a fresh `redeemed` outcome reduces the non-expired spendable pool by
 *      exactly the reward cost (FIFO consumes exactly the cost).
 *
 * No live/production database or Shopify Admin API is touched. The real
 * {@link LedgerRepository}, {@link redeem}, {@link computeSpendableBalance}, and
 * {@link consumeLotsFifo} are used unchanged; only the DB boundary is faked. An
 * INDEPENDENT oracle recomputes "non-expired remaining points" with a plain
 * reduction so any divergence from the Property-3 definition fails the test.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { computeSpendableBalance } from "../ledger/balance.js";
import { REWARD_IDS, REWARDS, type RewardId } from "../rewards/catalog.js";
import {
  LockTimeoutError,
  redeem,
  RedemptionInsufficientPointsError,
  type DiscountCodeEnqueuer,
  type Transactor,
} from "./redeem.js";

const CUSTOMER = "33333333-3333-3333-3333-333333333333";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A raw point_lot row in the shared in-memory store. */
interface FakeLotRow {
  id: string;
  remaining_points: number;
  earned_at: Date;
  /** null = never expires. */
  expires_at: Date | null;
  /** Physical insertion order, standing in for ctid (creation-order tie-break). */
  seq: number;
}

interface FakeRedemptionRow {
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

interface FakeLedgerRow {
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

interface FakeStore {
  db: Queryable;
  lots: FakeLotRow[];
  redemptions: FakeRedemptionRow[];
  ledger: FakeLedgerRow[];
  /** Toggle: when true, the customer FOR UPDATE lock throws Postgres 55P03. */
  lockTimeout: boolean;
}

/** A Postgres-shaped error carrying a SQLSTATE `code`. */
function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * A single in-memory fake shared by the whole redemption flow: the customer
 * lock, the redemptions idempotency table, the append-only ledger, the
 * spendable `SUM` projection, and the point_lots FIFO select/decrement — all
 * over one mutable row set. Dispatches purely on the SQL text the production
 * code emits, returning BIGINT/NUMERIC columns as strings just as `pg` does.
 */
function makeStore(initialLots: FakeLotRow[]): FakeStore {
  const lots = initialLots.map((l) => ({ ...l }));
  const redemptions: FakeRedemptionRow[] = [];
  const ledger: FakeLedgerRow[] = [];
  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++idCounter}`;

  const store = { lots, redemptions, ledger, lockTimeout: false } as FakeStore;

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
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
        if (store.lockTimeout) {
          throw pgError("55P03", "canceling statement due to lock timeout");
        }
        return ok([{ id: values[0] as string }] as unknown as R[], "SELECT");
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
        const row: FakeRedemptionRow = {
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
        return ok(
          [{ ...row, points_spent: String(points_spent), value_gbp: String(value_gbp) }] as unknown as R[],
          "INSERT",
        );
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
        ] = values as [
          string,
          string,
          number,
          string,
          number | null,
          string | null,
          string | null,
          string | null,
        ];
        const row: FakeLedgerRow = {
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

  store.db = db;
  return store;
}

/** A fake Transactor that runs the callback against the fake db (no real BEGIN/COMMIT). */
function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

/** Records enqueued discount-code jobs (never calls the Admin API). */
class RecordingEnqueuer implements DiscountCodeEnqueuer {
  readonly jobs: Array<{ redemptionId: string }> = [];
  async enqueueDiscountCode(job: { redemptionId: string }): Promise<void> {
    this.jobs.push(job);
  }
}

/** Independent oracle: SUM(remaining_points) over non-expired lots at `asOf`. */
function referenceSpendable(rows: readonly FakeLotRow[], asOf: Date): number {
  return rows
    .filter(
      (r) =>
        r.remaining_points > 0 &&
        (r.expires_at === null || r.expires_at.getTime() > asOf.getTime()),
    )
    .reduce((s, r) => s + r.remaining_points, 0);
}

/** A snapshot of every lot's remaining_points, keyed by lot id, for unchanged-checks. */
function snapshotRemaining(rows: readonly FakeLotRow[]): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const r of rows) {
    snap[r.id] = r.remaining_points;
  }
  return snap;
}

// -- Generators --------------------------------------------------------------

/**
 * One lot as day-offsets from `now`: a mix of expired, live, and non-expiring
 * lots with zero and positive `remaining_points`. Offsets are at day
 * granularity so a lot's expired/live classification is stable across the
 * (sub-second) test runtime, regardless of the exact `new Date()` the
 * production code reads internally.
 */
const lotArb = (index: number, now: number) =>
  fc
    .record({
      remaining: fc.nat({ max: 1500 }),
      earnedOffsetDays: fc.integer({ min: -400, max: 0 }),
      // -400..-1 => expired; 1..400 => live; null => never expires.
      expiryKind: fc.oneof(fc.constant<null>(null), fc.integer({ min: -400, max: 400 })),
    })
    .map(({ remaining, earnedOffsetDays, expiryKind }): FakeLotRow => {
      const earned_at = new Date(now + earnedOffsetDays * DAY_MS);
      // Force a non-zero offset so a lot is unambiguously expired or live.
      const days = expiryKind === null ? null : expiryKind === 0 ? 1 : expiryKind;
      const expires_at = days === null ? null : new Date(now + days * DAY_MS);
      return { id: `lot-${index}`, remaining_points: remaining, earned_at, expires_at, seq: index };
    });

const lotsArb = (now: number) =>
  fc.integer({ min: 0, max: 8 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_v, i) => lotArb(i, now))));

/**
 * A single redemption attempt: one of the four reward tiers, an idempotency key
 * drawn from a small pool (so replays of the same key occur), and an occasional
 * simulated lock timeout.
 */
const attemptArb = fc.record({
  rewardId: fc.constantFrom<RewardId>(...REWARD_IDS),
  key: fc.integer({ min: 0, max: 3 }).map((k) => `key-${k}`),
  lockTimeout: fc.integer({ min: 0, max: 9 }).map((n) => n === 0), // ~10% of attempts
});

const attemptsArb = fc.array(attemptArb, { minLength: 1, maxLength: 8 });

describe("Property 3 — post-redemption spendable balance is never negative (Req 3.4)", () => {
  it("holds after every redeemed / replayed / rejected outcome, and rejections leave lots unchanged", async () => {
    const now = Date.now();
    await fc.assert(
      fc.asyncProperty(lotsArb(now), attemptsArb, async (lots, attempts) => {
        const store = makeStore(lots);
        const repo = new LedgerRepository(store.db);
        const transactor = makeTransactor(store.db);
        const enqueuer = new RecordingEnqueuer();
        const deps = { repo, transactor, enqueuer };

        // Invariant holds before any redemption.
        const startSpendable = await computeSpendableBalance(CUSTOMER, store.db);
        expect(startSpendable).toBeGreaterThanOrEqual(0);
        expect(startSpendable).toBe(referenceSpendable(store.lots, new Date()));

        for (const attempt of attempts) {
          const cost = REWARDS[attempt.rewardId].cost;
          store.lockTimeout = attempt.lockTimeout;

          const beforeRemaining = snapshotRemaining(store.lots);
          const beforeSpendable = referenceSpendable(store.lots, new Date());

          let outcomeStatus: "redeemed" | "replayed" | "rejected";
          try {
            const outcome = await redeem(CUSTOMER, attempt.rewardId, attempt.key, deps);
            outcomeStatus = outcome.status;
          } catch (err) {
            // The only expected rejections here are lock-timeout and
            // insufficient-points; both must leave the ledger/lots unchanged.
            expect(
              err instanceof LockTimeoutError ||
                err instanceof RedemptionInsufficientPointsError,
            ).toBe(true);
            outcomeStatus = "rejected";
          }

          // (1) Property 3 core: spendable is never negative after any outcome.
          const afterSpendable = await computeSpendableBalance(CUSTOMER, store.db);
          expect(afterSpendable).toBeGreaterThanOrEqual(0);
          // The projection agrees with the independent oracle.
          expect(afterSpendable).toBe(referenceSpendable(store.lots, new Date()));

          if (outcomeStatus === "redeemed") {
            // A fresh spend consumes exactly the cost from the non-expired pool.
            expect(afterSpendable).toBe(beforeSpendable - cost);
          } else {
            // (2) A rejected or replayed redemption changes no lot at all.
            expect(snapshotRemaining(store.lots)).toEqual(beforeRemaining);
            expect(afterSpendable).toBe(beforeSpendable);
          }
        }

        // Global invariant: exactly one spend + one job per distinct redeemed key.
        const spends = store.ledger.filter((e) => e.entry_type === "spend");
        expect(spends.length).toBe(store.redemptions.length);
        expect(enqueuer.jobs.length).toBe(store.redemptions.length);
      }),
      { numRuns: 300 },
    );
  });
});
