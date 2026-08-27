/**
 * Property-based test for Property 5 (Idempotent redeem) — task 5.6.
 *
 * **Validates: Requirements 3.7**
 *
 * Property 5 (from design.md "Correctness Properties"):
 *   the same `(customer, idempotencyKey)` yields EXACTLY ONE spend and AT MOST
 *   ONE discount code, and every repeat request returns the existing
 *   redemption (Req 3.7).
 *
 * This exercises the APPROVED implementation of {@link redeem} (task 5.2) —
 * together with the reward catalog (task 5.1), the append-only ledger
 * repository (task 2.1), and FIFO consumption + spendable projection
 * (task 2.3) — across many arbitrary sequences that repeat the same
 * `(customer, idempotencyKey)`. It asserts two universal facts:
 *
 *   (5a) Same key, repeated (sequential AND concurrent replays) — across N
 *        repeats of one key, exactly one negative `spend` ledger entry is
 *        created, exactly one `redemptions` row exists, at most one
 *        discount-code job is enqueued, and every non-winning attempt returns
 *        the winner's redemption with status `replayed`.
 *
 *   (5b) Interleaved DISTINCT keys — when several distinct keys are each
 *        repeated and interleaved/run concurrently, the invariant holds
 *        independently per key: each key produces exactly one spend and at most
 *        one code, so the total spend count equals the number of distinct keys.
 *
 * CONCURRENCY MODEL: in the real service, `SELECT ... FOR UPDATE` on the
 * customer row serialises concurrent redeems for the same customer — that lock
 * is precisely what makes idempotency hold under a replay storm. The fake
 * {@link Transactor} here therefore serialises transactions (a single-customer
 * async mutex), faithfully modelling the customer-row lock, while the redeem
 * calls themselves are fired concurrently via `Promise.all` to reproduce
 * interleaved replays.
 *
 * No live/production system is touched: {@link redeem} is driven against a tiny
 * in-memory {@link Queryable} fake (the same technique used by `redeem.test.ts`),
 * so there is no Postgres or Shopify Admin API dependency. This is a
 * verification task — the approved implementation is NOT changed.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { REWARDS, REWARD_IDS, type RewardId } from "../rewards/catalog.js";
import {
  redeem,
  type DiscountCodeEnqueuer,
  type RedeemOutcome,
  type Transactor,
} from "./redeem.js";

const CUSTOMER = "22222222-2222-2222-2222-222222222222";

// --- In-memory fake Postgres ------------------------------------------------

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
  redemption_id: string | null;
  created_at: Date;
}

interface FakeDb {
  db: Queryable;
  lots: FakeLot[];
  redemptions: FakeRedemption[];
  ledger: FakeLedgerEntry[];
}

/** A Postgres-shaped error carrying a SQLSTATE `code`. */
function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Understands exactly the statements {@link redeem} issues: the lock-timeout
 * SET, the customer `FOR UPDATE` lock, the redemptions idempotency select and
 * insert (enforcing the `UNIQUE (customer_id, idempotency_key)` constraint),
 * the append-only ledger insert, the spendable SUM projection, and the
 * point_lots FIFO select + decrement.
 */
function makeDb(lots: FakeLot[]): FakeDb {
  const state: FakeDb = {
    db: undefined as unknown as Queryable,
    lots: lots.map((l) => ({ ...l })),
    redemptions: [],
    ledger: [],
  };
  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++idCounter}`;

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
        return ok([{ id: values[0] as string }] as unknown as R[], "SELECT");
      }

      if (/INSERT INTO redemptions/i.test(queryText)) {
        const [customer_id, reward_id, points_spent, value_gbp, status, idempotency_key, channel] =
          values as [string, string, number, number, string, string, string];
        // Enforce the UNIQUE (customer_id, idempotency_key) constraint.
        const clash = state.redemptions.find(
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
        state.redemptions.push(row);
        return ok(
          [{ ...row, points_spent: String(points_spent), value_gbp: String(value_gbp) }] as unknown as R[],
          "INSERT",
        );
      }

      if (/FROM redemptions/i.test(queryText)) {
        const [customer_id, idempotency_key] = values as [string, string];
        const found = state.redemptions.find(
          (r) => r.customer_id === customer_id && r.idempotency_key === idempotency_key,
        );
        const rows = found
          ? [{ ...found, points_spent: String(found.points_spent), value_gbp: String(found.value_gbp) }]
          : [];
        return ok(rows as unknown as R[], "SELECT");
      }

      if (/INSERT INTO ledger_entries/i.test(queryText)) {
        const [customer_id, entry_type, points, reason, , , redemption_id] = values as [
          string,
          string,
          number,
          string,
          number | null,
          string | null,
          string | null,
          string | null,
        ];
        const row: FakeLedgerEntry = {
          id: nextId("ledger"),
          customer_id,
          entry_type,
          points,
          reason,
          redemption_id: redemption_id ?? null,
          created_at: new Date("2025-06-01T00:00:00.000Z"),
        };
        state.ledger.push(row);
        // Mirror the repository's RETURNING column set so mapRow() maps cleanly.
        return ok(
          [
            {
              id: row.id,
              customer_id: row.customer_id,
              entry_type: row.entry_type,
              points: String(points),
              reason: row.reason,
              order_reference: null,
              point_lot_id: null,
              redemption_id: row.redemption_id,
              source_event_id: null,
              created_at: row.created_at,
            },
          ] as unknown as R[],
          "INSERT",
        );
      }

      if (/SUM\(remaining_points\)/i.test(queryText)) {
        const asOf = values[1] as Date;
        const sum = state.lots
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
        const selected = state.lots
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
        const target = state.lots.find((l) => l.id === lotId);
        if (!target) {
          throw new Error(`lot ${lotId} not found`);
        }
        target.remaining_points -= take;
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      throw new Error(`unexpected query: ${queryText}`);
    },
  };

  state.db = db;
  return state;
}

/**
 * A serialising Transactor: it runs at most one transaction at a time against
 * the fake db, modelling the `SELECT ... FOR UPDATE` customer-row lock that
 * serialises concurrent same-customer redeems in the real service. Every run
 * (success or failure) releases the mutex for the next.
 */
function makeSerializingTransactor(db: Queryable): Transactor {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const run = tail.then(() => fn(db));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
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
  const transactor = makeSerializingTransactor(fake.db);
  const enqueuer = new RecordingEnqueuer();
  return { repo, transactor, enqueuer };
}

function singleLot(remaining: number): FakeLot {
  return {
    id: "lot-1",
    remaining_points: remaining,
    earned_at: new Date("2025-01-01T00:00:00.000Z"),
    expires_at: new Date("2030-01-01T00:00:00.000Z"),
    seq: 0,
  };
}

// --- Arbitraries ------------------------------------------------------------

const rewardIdArb: fc.Arbitrary<RewardId> = fc.constantFrom(...REWARD_IDS);

// --- Property 5a: same key, sequential AND concurrent replays ---------------

describe("Property 5 (Idempotent redeem) — Requirement 3.7", () => {
  it("same (customer, key) → exactly one spend, at most one code, replays return the existing redemption", async () => {
    await fc.assert(
      fc.asyncProperty(
        rewardIdArb,
        // Total repeats of the identical key (>= 2 so there is at least one replay).
        fc.integer({ min: 2, max: 8 }),
        // Extra spendable headroom beyond the reward cost.
        fc.integer({ min: 0, max: 400 }),
        // Fire the replays concurrently (Promise.all) vs strictly sequentially.
        fc.boolean(),
        async (rewardId, repeats, headroom, concurrent) => {
          const reward = REWARDS[rewardId];
          const fake = makeDb([singleLot(reward.cost + headroom)]);
          const deps = makeDeps(fake);
          const key = "same-key";

          const attempt = () => redeem(CUSTOMER, rewardId, key, deps);

          let outcomes: RedeemOutcome[];
          if (concurrent) {
            outcomes = await Promise.all(Array.from({ length: repeats }, attempt));
          } else {
            outcomes = [];
            for (let i = 0; i < repeats; i++) {
              outcomes.push(await attempt());
            }
          }

          // Exactly one attempt performed the spend; every other is a replay.
          const redeemed = outcomes.filter((o) => o.status === "redeemed");
          const replayed = outcomes.filter((o) => o.status === "replayed");
          expect(redeemed).toHaveLength(1);
          expect(replayed).toHaveLength(repeats - 1);

          // Every attempt returns the SAME redemption (the winner's row).
          const winnerId = redeemed[0]!.redemption.id;
          for (const o of outcomes) {
            expect(o.redemption.id).toBe(winnerId);
          }

          // Exactly one negative spend ledger entry equal to the reward cost.
          const spends = fake.ledger.filter((e) => e.entry_type === "spend");
          expect(spends).toHaveLength(1);
          expect(spends[0]!.points).toBe(-reward.cost);
          expect(spends[0]!.redemption_id).toBe(winnerId);

          // Exactly one redemptions row for the key.
          expect(fake.redemptions).toHaveLength(1);
          expect(fake.redemptions[0]!.id).toBe(winnerId);

          // AT MOST ONE discount-code job — here exactly one, referencing the winner.
          expect(deps.enqueuer.jobs.length).toBeLessThanOrEqual(1);
          expect(deps.enqueuer.jobs).toEqual([{ redemptionId: winnerId }]);

          // Spendable decreased by exactly the reward cost (one spend, not N).
          const remaining = fake.lots.reduce((s, l) => s + l.remaining_points, 0);
          expect(remaining).toBe(headroom);
        },
      ),
    );
  });

  // --- Property 5b: interleaved DISTINCT keys — invariant holds per key ------

  it("interleaved distinct keys each yield exactly one spend and one code (per-key idempotency)", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A schedule of key indices drawn from a small pool, so several distinct
        // keys are interleaved and most are repeated at least once.
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 2, maxLength: 20 }),
        fc.integer({ min: 0, max: 600 }),
        async (keyIndexSchedule, headroom) => {
          // Use the cheapest reward so a bounded lot covers every distinct key.
          const rewardId: RewardId = "reward_5";
          const reward = REWARDS[rewardId];
          const distinctKeys = Array.from(new Set(keyIndexSchedule)).map((i) => `key-${i}`);

          // Seed enough spendable balance for one spend per distinct key.
          const fake = makeDb([singleLot(reward.cost * distinctKeys.length + headroom)]);
          const deps = makeDeps(fake);

          // Fire the whole interleaved schedule concurrently.
          const outcomes = await Promise.all(
            keyIndexSchedule.map((i) => redeem(CUSTOMER, rewardId, `key-${i}`, deps)),
          );

          // Per key: exactly one `redeemed`, the rest `replayed`, all sharing an id.
          for (const key of distinctKeys) {
            const forKey = outcomes.filter((o) => o.redemption.idempotencyKey === key);
            const redeemed = forKey.filter((o) => o.status === "redeemed");
            expect(redeemed).toHaveLength(1);
            const winnerId = redeemed[0]!.redemption.id;
            for (const o of forKey) {
              expect(o.redemption.id).toBe(winnerId);
            }
          }

          // Total spends and codes equal the number of DISTINCT keys — never the
          // number of (repeated) requests.
          const spends = fake.ledger.filter((e) => e.entry_type === "spend");
          expect(spends).toHaveLength(distinctKeys.length);
          expect(fake.redemptions).toHaveLength(distinctKeys.length);
          expect(deps.enqueuer.jobs).toHaveLength(distinctKeys.length);

          // One code per redemption — at most (indeed exactly) one each, no dupes.
          const jobRedemptionIds = deps.enqueuer.jobs.map((j) => j.redemptionId).sort();
          const redemptionIds = fake.redemptions.map((r) => r.id).sort();
          expect(jobRedemptionIds).toEqual(redemptionIds);

          // Spendable dropped by exactly cost × distinctKeys.
          const remaining = fake.lots.reduce((s, l) => s + l.remaining_points, 0);
          expect(remaining).toBe(headroom);
        },
      ),
    );
  });
});

// Feature: customer-experience-portal, Property 4: Redemption is idempotent and never double-debits
/* ========================================================================== *
 * PROPERTY 4 — spec task 10.3. Validates Requirements 8.7, 8.9.
 *
 * EXTENDS this file rather than starting a new one, which is what task 10.3 asks
 * for: the fakes above are the harness the shipped redemption properties already
 * trust, and a second private copy of a serializing transactor would be a second
 * definition of how the engine behaves under contention — free to disagree with
 * this one, and the disagreement would look like a passing suite.
 *
 * THE ENGINE IS NOT MODIFIED. The enforcement point stays exactly where it is:
 * the `redemptions (customer_id, idempotency_key)` UNIQUE constraint, whose
 * violation the fake raises as SQLSTATE 23505 and which `redeem()` already
 * translates into a replay. These properties assert that guarantee from the
 * outside across dimensions the existing Property 5 does not generate: retry
 * COUNT, the POINT in the lifecycle at which a caller gives up, and the full
 * catalogue of reward ids.
 * ========================================================================== */

describe("Property 4: redemption is idempotent and never double-debits", () => {
  it("any retry count, sequential or concurrent, debits exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(
        rewardIdArb,
        fc.integer({ min: 1, max: 9 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 400 }),
        async (rewardId, retries, concurrent, headroom) => {
          const reward = REWARDS[rewardId];
          const fake = makeDb([singleLot(reward.cost + headroom)]);
          const deps = makeDeps(fake);
          const attempt = () => redeem(CUSTOMER, rewardId, "same-key", deps);

          if (concurrent) {
            await Promise.all(Array.from({ length: retries }, attempt));
          } else {
            for (let i = 0; i < retries; i += 1) await attempt();
          }

          // THE SPEND SUM EQUALS THE NEGATIVE OF points_spent, once.
          const spends = fake.ledger.filter((e) => e.entry_type === "spend");
          const spendTotal = spends.reduce((sum, e) => sum + e.points, 0);
          expect(fake.redemptions).toHaveLength(1);
          expect(spendTotal).toBe(-fake.redemptions[0]!.points_spent);
          expect(spends).toHaveLength(1);

          // EXACTLY ONE discount code is ever requested, however many retries.
          expect(deps.enqueuer.jobs).toEqual([{ redemptionId: fake.redemptions[0]!.id }]);

          // The balance moved by exactly the reward's cost and no more.
          const remaining = fake.lots.reduce((sum, l) => sum + l.remaining_points, 0);
          expect(remaining).toBe(headroom);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a caller abandoning at ANY point in the lifecycle still leaves one debit", async () => {
    // Models the real failure §9.3 cares about: a network timeout. The customer's
    // browser gives up, but the server-side transaction may already have committed.
    // Whether the caller ever saw the response must not change what the ledger holds,
    // and the retry with the SAME key must not debit again.
    await fc.assert(
      fc.asyncProperty(
        rewardIdArb,
        fc.integer({ min: 1, max: 4 }),
        async (rewardId, abandonedAttempts) => {
          const reward = REWARDS[rewardId];
          const fake = makeDb([singleLot(reward.cost * 3)]);
          const deps = makeDeps(fake);

          // Each "abandoned" attempt is issued and its result discarded — exactly
          // what a timed-out client leaves behind on the server.
          for (let i = 0; i < abandonedAttempts; i += 1) {
            await redeem(CUSTOMER, rewardId, "timeout-key", deps).catch(() => undefined);
          }
          // The eventual retry the customer's client actually reads.
          const final = await redeem(CUSTOMER, rewardId, "timeout-key", deps);

          expect(fake.redemptions).toHaveLength(1);
          expect(final.redemption.id).toBe(fake.redemptions[0]!.id);
          const spends = fake.ledger.filter((e) => e.entry_type === "spend");
          expect(spends).toHaveLength(1);
          expect(spends[0]!.points).toBe(-reward.cost);
          expect(deps.enqueuer.jobs).toHaveLength(1);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("a FAILED redemption leaves the spendable balance untouched", async () => {
    // An insufficient balance must cost nothing: no spend, no redemption row, no
    // code job, and the lots exactly as they were.
    await fc.assert(
      fc.asyncProperty(
        rewardIdArb,
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 5 }),
        async (rewardId, shortfall, attempts) => {
          const reward = REWARDS[rewardId];
          const available = Math.max(0, reward.cost - shortfall);
          const fake = makeDb([singleLot(available)]);
          const deps = makeDeps(fake);

          for (let i = 0; i < attempts; i += 1) {
            await redeem(CUSTOMER, rewardId, `short-${i}`, deps).catch(() => undefined);
          }

          const remaining = fake.lots.reduce((sum, l) => sum + l.remaining_points, 0);
          expect(remaining).toBe(available);
          expect(fake.ledger.filter((e) => e.entry_type === "spend")).toEqual([]);
          expect(deps.enqueuer.jobs).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("distinct keys debit independently — idempotency is per key, not per customer", async () => {
    // The counterpart to the property above: idempotency must not become a global
    // "one redemption per customer" lock, which would silently refuse a second
    // legitimate redemption.
    await fc.assert(
      fc.asyncProperty(
        rewardIdArb,
        fc.integer({ min: 2, max: 5 }),
        async (rewardId, distinctKeys) => {
          const reward = REWARDS[rewardId];
          const fake = makeDb([singleLot(reward.cost * distinctKeys)]);
          const deps = makeDeps(fake);

          await Promise.all(
            Array.from({ length: distinctKeys }, (_v, i) =>
              redeem(CUSTOMER, rewardId, `key-${i}`, deps),
            ),
          );

          expect(fake.redemptions).toHaveLength(distinctKeys);
          const spends = fake.ledger.filter((e) => e.entry_type === "spend");
          expect(spends).toHaveLength(distinctKeys);
          const spendTotal = spends.reduce((sum, e) => sum + e.points, 0);
          const debited = fake.redemptions.reduce((sum, r) => sum + r.points_spent, 0);
          expect(spendTotal).toBe(-debited);
          expect(deps.enqueuer.jobs).toHaveLength(distinctKeys);
          expect(fake.lots.reduce((sum, l) => sum + l.remaining_points, 0)).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
