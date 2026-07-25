/**
 * Property-based test for Property 4 — "Redemption/spend conservation" (task 5.5).
 *
 *   abs(spend_entry.points) == reward.cost == SUM(lot decrements)
 *
 * **Validates: Requirements 3.2**
 *
 * This is a DISTINCT property-test file for task 5.5. It does not modify the
 * task-5.2 unit tests in `redeem.test.ts`; it exercises the SAME production
 * redemption flow ({@link redeem}) — which itself uses the real
 * {@link LedgerRepository} append, the real {@link consumeLotsFifo} FIFO
 * primitive, and the real reward catalog — against a stateful in-memory fake DB.
 *
 * For every successful redemption of ANY reward tier, over randomly generated
 * sufficient-balance lot sets, it asserts the single conservation chain of
 * Requirement 3.2 (Property 4):
 *
 *   1. exactly ONE negative `spend` ledger entry is recorded, and its magnitude
 *      `abs(points)` equals the reward's cost;
 *   2. the SUM of the per-lot FIFO decrements equals the reward's cost EXACTLY;
 *   3. and the two agree with each other and with `reward.cost` — no points are
 *      created or destroyed by a redemption.
 *
 * No live/production database or Shopify Admin API is touched. The fake models
 * only the SQL shapes the flow issues (the customer `FOR UPDATE` lock, the
 * redemptions idempotency select/insert, the append-only ledger insert, the
 * spendable `SUM` projection, and the point_lots FIFO select + decrement
 * `UPDATE`) over shared mutable row sets, returning BIGINT columns as strings
 * exactly as `pg` does. Lot decrements are captured INDEPENDENTLY by summing the
 * `take` argument of every decrement `UPDATE`, so a divergence between the
 * spend magnitude, the applied decrements, and `reward.cost` would fail the test.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { REWARDS, REWARD_IDS, type RewardId } from "../rewards/catalog.js";
import { redeem, type DiscountCodeEnqueuer, type Transactor } from "./redeem.js";

const CUSTOMER = "33333333-3333-3333-3333-333333333333";
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The reference instant for lot expiry. {@link redeem} computes its own
 * `asOf = new Date()` internally (it takes no asOf parameter), so lot dates MUST
 * be anchored to the real current time — not a fixed past date — or a lot the
 * test intends to be "live" would be treated as expired by production. All
 * generated expiries are whole days clearly in the past or clearly in the
 * future relative to {@link NOW}, so the millisecond drift between NOW and
 * redeem's own `new Date()` can never cross an expiry boundary.
 */
const NOW = new Date();

/** A raw point_lot row in the in-memory store. */
interface FakeLot {
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

interface FakeDb {
  db: Queryable;
  lots: FakeLot[];
  redemptions: FakeRedemptionRow[];
  ledger: FakeLedgerRow[];
  /** The `take` of every decrement UPDATE issued against point_lots, in order. */
  lotDecrements: number[];
}

/**
 * Builds a stateful in-memory fake DB that answers exactly the SQL the
 * redemption flow issues. A customer row always exists (so the lock succeeds)
 * and no lock timeout is simulated — this test targets the success path only.
 */
function makeDb(initialLots: FakeLot[]): FakeDb {
  const lots = initialLots.map((l) => ({ ...l }));
  const redemptions: FakeRedemptionRow[] = [];
  const ledger: FakeLedgerRow[] = [];
  const lotDecrements: number[] = [];
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

      // Customer lock: the row always exists here (success path).
      if (/FROM customers WHERE id/i.test(queryText) && /FOR UPDATE/i.test(queryText)) {
        return ok([{ id: values[0] as string }] as unknown as R[], "SELECT");
      }

      // Idempotency guard: look up an existing redemption by (customer, key).
      if (/FROM redemptions/i.test(queryText)) {
        const [customer_id, idempotency_key] = values as [string, string];
        const found = redemptions.find(
          (r) => r.customer_id === customer_id && r.idempotency_key === idempotency_key,
        );
        const rows = found
          ? [
              {
                ...found,
                points_spent: String(found.points_spent),
                value_gbp: String(found.value_gbp),
              },
            ]
          : [];
        return ok(rows as unknown as R[], "SELECT");
      }

      // Insert the pending redemption row.
      if (/INSERT INTO redemptions/i.test(queryText)) {
        const [customer_id, reward_id, points_spent, value_gbp, status, idempotency_key, channel] =
          values as [string, string, number, number, string, string, string];
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
          created_at: NOW,
        };
        redemptions.push(row);
        return ok(
          [
            {
              ...row,
              points_spent: String(points_spent),
              value_gbp: String(value_gbp),
            },
          ] as unknown as R[],
          "INSERT",
        );
      }

      // Append the (single) negative spend ledger entry. The RETURNING row must
      // carry every column the real LedgerRepository.mapRow parses.
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
          created_at: NOW,
        };
        ledger.push(row);
        return ok([{ ...row, points: String(points) }] as unknown as R[], "INSERT");
      }

      // Spendable projection: SUM(remaining_points) over non-expired lots.
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

      // FIFO consumable-lot selection, locked FOR UPDATE, ordered (earned_at, seq).
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

      // Decrement UPDATE: remaining_points -= $1 WHERE id = $2. Capture the take.
      if (/UPDATE point_lots/i.test(queryText)) {
        const take = values[0] as number;
        const lotId = values[1] as string;
        const target = lots.find((l) => l.id === lotId);
        if (!target) {
          throw new Error(`lot ${lotId} not found`);
        }
        target.remaining_points -= take;
        lotDecrements.push(take);
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      throw new Error(`unexpected query: ${queryText}`);
    },
  };

  return { db, lots, redemptions, ledger, lotDecrements };
}

/** A Transactor that runs the callback directly against the fake db. */
function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

/** Records enqueued discount-code jobs (unused by the assertions here). */
class RecordingEnqueuer implements DiscountCodeEnqueuer {
  readonly jobs: Array<{ redemptionId: string }> = [];
  async enqueueDiscountCode(job: { redemptionId: string }): Promise<void> {
    this.jobs.push(job);
  }
}

function makeDeps(fake: FakeDb) {
  return {
    repo: new LedgerRepository(fake.db),
    transactor: makeTransactor(fake.db),
    enqueuer: new RecordingEnqueuer(),
  };
}

/** A reward id drawn uniformly from the four defined tiers (Req 3.1). */
const rewardIdArb: fc.Arbitrary<RewardId> = fc.constantFrom(...REWARD_IDS);

/**
 * Generates a set of "base" lots as day-offsets from {@link NOW}: a mix of
 * live, expired (excluded from spendable), non-expiring, and zero-remaining
 * lots — so the FIFO consumer must correctly skip the non-spendable ones. A
 * guaranteed-live top-up lot is appended separately to ensure sufficiency.
 */
const baseLotArb = (index: number) =>
  fc
    .record({
      remaining: fc.nat({ max: 400 }),
      earnedOffsetDays: fc.integer({ min: 1, max: 400 }), // earned in the past
      // "expired" => clearly-past expiry (excluded); "live" => clearly-future
      // expiry (included); null => never expires (included).
      expiryKind: fc.oneof(
        fc.constant<"none">("none"),
        fc.constant<"expired">("expired"),
        fc.constant<"live">("live"),
      ),
      expiredDays: fc.integer({ min: 1, max: 200 }),
      liveDays: fc.integer({ min: 30, max: 400 }),
    })
    .map(({ remaining, earnedOffsetDays, expiryKind, expiredDays, liveDays }): FakeLot => {
      const earned_at = new Date(NOW.getTime() - earnedOffsetDays * DAY_MS);
      const expires_at =
        expiryKind === "none"
          ? null
          : expiryKind === "expired"
            ? new Date(NOW.getTime() - expiredDays * DAY_MS)
            : new Date(NOW.getTime() + liveDays * DAY_MS);
      return { id: `base-${index}`, remaining_points: remaining, earned_at, expires_at, seq: index };
    });

/**
 * Independent oracle: sum of remaining points across non-expired lots, using
 * the same expiry rule production applies (`expires_at IS NULL OR expires_at >
 * asOf`). Evaluated against a fresh `new Date()` so it matches redeem's own
 * internal asOf; every generated expiry is whole days from {@link NOW}, so the
 * sub-second difference cannot flip a lot's live/expired classification.
 */
function liveSpendable(lots: readonly FakeLot[]): number {
  const now = Date.now();
  return lots
    .filter(
      (l) => l.remaining_points > 0 && (l.expires_at === null || l.expires_at.getTime() > now),
    )
    .reduce((s, l) => s + l.remaining_points, 0);
}

/**
 * A scenario: a reward tier plus a lot set whose NON-EXPIRED spendable balance
 * is guaranteed `>= reward.cost` (so the redemption succeeds), by appending a
 * live top-up lot covering any shortfall plus a random surplus.
 */
const baseLotsArb: fc.Arbitrary<FakeLot[]> = fc
  .integer({ min: 0, max: 8 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_v, i) => baseLotArb(i))))
  .map((lots) => [...lots]);

const scenarioArb = rewardIdArb.chain((rewardId) => {
  const cost = REWARDS[rewardId].cost;
  return fc
    .record({
      baseLots: baseLotsArb,
      surplus: fc.nat({ max: 500 }),
      // Vary where the top-up lot sits in FIFO order (how far in the past it was earned).
      topUpOffsetDays: fc.integer({ min: 0, max: 420 }),
    })
    .map(({ baseLots, surplus, topUpOffsetDays }) => {
      const shortfall = Math.max(0, cost - liveSpendable(baseLots));
      const topUp: FakeLot = {
        id: "topup",
        remaining_points: shortfall + surplus + 1, // strictly guarantees >= cost
        // Earned in the past (varying FIFO position), with a clearly-future expiry.
        earned_at: new Date(NOW.getTime() - topUpOffsetDays * DAY_MS),
        expires_at: new Date(NOW.getTime() + 500 * DAY_MS), // clearly live
        seq: baseLots.length,
      };
      return { rewardId, cost, lots: [...baseLots, topUp] };
    });
});

describe("Property 4 — redemption/spend conservation: |spend| == reward.cost == SUM(lot decrements) (Req 3.2)", () => {
  it("conserves points for a successful redemption of any reward tier over any sufficient lot set", async () => {
    let iteration = 0;
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ rewardId, cost, lots }) => {
        const fake = makeDb(lots);
        const deps = makeDeps(fake);
        const idempotencyKey = `conservation-${iteration++}`;

        const liveBefore = liveSpendable(fake.lots);
        // Precondition of this generator: the balance is sufficient.
        expect(liveBefore).toBeGreaterThanOrEqual(cost);

        const outcome = await redeem(CUSTOMER, rewardId, idempotencyKey, deps);

        // The redemption must succeed (sufficient balance was guaranteed).
        expect(outcome.status).toBe("redeemed");
        if (outcome.status !== "redeemed") return;

        // (1) EXACTLY ONE negative spend ledger entry, magnitude == reward.cost.
        const spends = fake.ledger.filter((e) => e.entry_type === "spend");
        expect(spends).toHaveLength(1);
        expect(spends[0]!.points).toBe(-cost);
        expect(Math.abs(spends[0]!.points)).toBe(cost);
        // The returned spend entry agrees.
        expect(outcome.spendEntry.entryType).toBe("spend");
        expect(Math.abs(outcome.spendEntry.points)).toBe(cost);

        // (2) SUM of the applied FIFO lot decrements == reward.cost EXACTLY.
        const totalDecrements = fake.lotDecrements.reduce((s, t) => s + t, 0);
        expect(totalDecrements).toBe(cost);
        // The consumption plan reported by the flow agrees decrement-for-decrement.
        const plannedTotal = outcome.consumption.allocations.reduce((s, a) => s + a.take, 0);
        expect(plannedTotal).toBe(cost);
        expect(outcome.consumption.totalConsumed).toBe(cost);
        expect(outcome.consumption.shortfall).toBe(0);
        expect(outcome.consumption.sufficient).toBe(true);

        // (3) The full conservation chain holds: |spend| == cost == SUM(decrements).
        expect(Math.abs(outcome.spendEntry.points)).toBe(totalDecrements);
        expect(totalDecrements).toBe(cost);

        // Corollary (Req 3.4, Property 3): the live spendable dropped by exactly
        // the cost — no points created or destroyed — and stays >= 0.
        const liveAfter = liveSpendable(fake.lots);
        expect(liveAfter).toBe(liveBefore - cost);
        expect(liveAfter).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it("each individual FIFO decrement is positive and never overdraws its lot", async () => {
    let iteration = 0;
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ rewardId, cost, lots }) => {
        const fake = makeDb(lots);
        const deps = makeDeps(fake);

        const outcome = await redeem(CUSTOMER, rewardId, `alloc-${iteration++}`, deps);
        expect(outcome.status).toBe("redeemed");
        if (outcome.status !== "redeemed") return;

        // Every allocation takes a strictly positive amount and leaves the lot
        // at a non-negative remaining — the decrements are a valid partition of
        // exactly `cost`.
        for (const a of outcome.consumption.allocations) {
          expect(a.take).toBeGreaterThan(0);
          expect(a.remainingAfter).toBeGreaterThanOrEqual(0);
          expect(a.remainingAfter).toBe(a.remainingBefore - a.take);
        }
        const summed = outcome.consumption.allocations.reduce((s, a) => s + a.take, 0);
        expect(summed).toBe(cost);
      }),
      { numRuns: 200 },
    );
  });
});
