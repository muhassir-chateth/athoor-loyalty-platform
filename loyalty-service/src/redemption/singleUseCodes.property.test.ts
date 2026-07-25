/**
 * Task 5.7 — Property / integration test for single-use discount codes.
 *
 * **Property 10 (Single-use codes):** each redemption yields EXACTLY ONE
 * generated discount code, minted with `usageLimit = 1` and
 * `appliesOncePerCustomer = true`, and BOUND to the redeeming customer only;
 * and an idempotency-key replay mints no second code.
 * **Validates: Requirements 3.5** (and 3.6 for the usage-limit / customer-bound
 * shape the property asserts).
 *
 * This is an INTEGRATION property: it drives the real redemption flow
 * (`redeem`, task 5.2) followed by the real queued code-generation worker
 * (`processDiscountCodeJob`, task 5.3) end-to-end, through the real
 * {@link ShopifyAdminGateway}, over arbitrarily generated cohorts of customers,
 * rewards, and idempotency keys. Only two boundaries are faked, exactly as the
 * existing example-based tests do (`redeem.test.ts`, `generateDiscountCode.test.ts`):
 *
 *   - a single stateful in-memory DB that models the tables + SQL both modules
 *     issue (customers, redemptions, discount_codes, ledger_entries, point_lots);
 *   - a fake {@link ShopifyAdminClient} injected behind the real gateway that
 *     records every mint input and always succeeds.
 *
 * No live Postgres and NO live Shopify Admin API are ever touched. The
 * approved implementation is NOT modified — this test only observes it.
 *
 * The properties asserted across every generated input:
 *   P10a  Exactly one discount code is minted and persisted per redemption.
 *   P10b  Every minted code carries `usageLimit === 1` and
 *         `appliesOncePerCustomer === true` (Req 3.6, Property 10).
 *   P10c  Every minted code is bound to the redeeming customer's Shopify GID
 *         and no other — binding is never crossed between customers.
 *   P10d  Re-running the generation job any number of times (idempotent replay)
 *         mints no additional code; and replaying `redeem` with the same
 *         `(customer, idempotencyKey)` records no second spend and enqueues no
 *         second job. At most one spend and one code per redemption.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { REWARDS, REWARD_IDS, type RewardId } from "../rewards/catalog.js";
import {
  ShopifyAdminGateway,
  type DiscountCode,
  type DiscountInput,
  type ShopifyAdminClient,
} from "../shopify/adminGateway.js";
import {
  redeem,
  type DiscountCodeEnqueuer,
  type Transactor,
} from "./redeem.js";
import { processDiscountCodeJob, type DiscountCodeDeps } from "./generateDiscountCode.js";

const NUM_RUNS = 150;

// --- Fake persistence -------------------------------------------------------

interface FakeCustomer {
  id: string;
  shopify_customer_id: number;
}

interface FakeLot {
  id: string;
  customer_id: string;
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

interface FakeDiscountCode {
  id: string;
  redemption_id: string;
  code: string;
  amount_off_gbp: number;
}

interface FakeLedgerEntry {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  redemption_id: string | null;
}

interface Harness {
  db: Queryable;
  customers: Map<string, FakeCustomer>;
  lots: FakeLot[];
  redemptions: FakeRedemption[];
  discountCodes: FakeDiscountCode[];
  ledger: FakeLedgerEntry[];
}

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Builds one stateful in-memory DB shared by `redeem` and
 * `processDiscountCodeJob`, seeded with the given customers + lots. The `query`
 * dispatcher matches the exact SQL both modules issue; the ordering of the
 * checks matters (the generation load JOINs customers, so it is matched before
 * the plain redemption/customer selects).
 */
function makeHarness(seed: { customers: FakeCustomer[]; lots: FakeLot[] }): Harness {
  const customers = new Map<string, FakeCustomer>(seed.customers.map((c) => [c.id, { ...c }]));
  const lots = seed.lots.map((l) => ({ ...l }));
  const redemptions: FakeRedemption[] = [];
  const discountCodes: FakeDiscountCode[] = [];
  const ledger: FakeLedgerEntry[] = [];
  let idc = 0;
  const nextId = (p: string): string => `${p}-${++idc}`;

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      const ok = <T extends QueryResultRow>(rows: T[], command: string): QueryResult<T> => ({
        rows,
        rowCount: rows.length,
        command,
        oid: 0,
        fields: [],
      });

      if (/SET LOCAL lock_timeout/i.test(text)) {
        return ok([], "SET") as unknown as QueryResult<R>;
      }

      // (generate) Load redemption + its customer's Shopify id (JOIN customers).
      // Checked FIRST because it also matches /FROM redemptions/.
      if (/JOIN customers/i.test(text)) {
        const r = redemptions.find((x) => x.id === (values[0] as string));
        if (!r) return ok([] as R[], "SELECT");
        const c = customers.get(r.customer_id)!;
        return ok(
          [
            {
              id: r.id,
              customer_id: r.customer_id,
              reward_id: r.reward_id,
              points_spent: String(r.points_spent),
              value_gbp: String(r.value_gbp),
              status: r.status,
              discount_code_id: r.discount_code_id,
              shopify_customer_id: String(c.shopify_customer_id),
            },
          ] as unknown as R[],
          "SELECT",
        );
      }

      // (redeem) Exclusive customer lock.
      if (/FROM customers WHERE id/i.test(text) && /FOR UPDATE/i.test(text)) {
        const c = customers.get(values[0] as string);
        return ok((c ? [{ id: c.id }] : []) as unknown as R[], "SELECT");
      }

      // (generate) Find an existing code for the redemption (idempotency guard).
      if (/FROM discount_codes WHERE redemption_id/i.test(text)) {
        const found = discountCodes.filter((c) => c.redemption_id === (values[0] as string));
        return ok(found.map((c) => ({ id: c.id, code: c.code })) as unknown as R[], "SELECT");
      }

      // (generate) Collision check by code.
      if (/FROM discount_codes WHERE code/i.test(text)) {
        const hit = discountCodes.some((c) => c.code === (values[0] as string));
        return ok((hit ? [{ one: 1 }] : []) as unknown as R[], "SELECT");
      }

      // (generate) Insert a minted discount code.
      if (/INSERT INTO discount_codes/i.test(text)) {
        const [redemption_id, code, , , amount] = values as [
          string,
          string,
          number | null,
          number | null,
          number,
        ];
        const row: FakeDiscountCode = {
          id: nextId("code"),
          redemption_id,
          code,
          amount_off_gbp: amount,
        };
        discountCodes.push(row);
        return ok([{ id: row.id, code: row.code }] as unknown as R[], "INSERT");
      }

      // (generate) Update redemption -> issued (carries discount_code_id).
      if (/UPDATE redemptions SET status = \$2, discount_code_id/i.test(text)) {
        const r = redemptions.find((x) => x.id === (values[0] as string));
        if (r) {
          r.status = values[1] as string;
          r.discount_code_id = values[2] as string;
        }
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      // (generate) Update redemption -> failed (not expected on the happy path).
      if (/UPDATE redemptions SET status = \$2 WHERE id/i.test(text)) {
        const r = redemptions.find((x) => x.id === (values[0] as string));
        if (r) r.status = values[1] as string;
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      // (redeem) Insert a redemption, enforcing UNIQUE (customer_id, idempotency_key).
      if (/INSERT INTO redemptions/i.test(text)) {
        const [customer_id, reward_id, points_spent, value_gbp, status, idempotency_key, channel] =
          values as [string, string, number, number, string, string, string];
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
        return ok(
          [{ ...row, points_spent: String(points_spent), value_gbp: String(value_gbp) }] as unknown as R[],
          "INSERT",
        );
      }

      // (redeem) Idempotency lookup by (customer, key).
      if (/FROM redemptions/i.test(text)) {
        const [customer_id, idempotency_key] = values as [string, string];
        const found = redemptions.find(
          (r) => r.customer_id === customer_id && r.idempotency_key === idempotency_key,
        );
        const rows = found
          ? [{ ...found, points_spent: String(found.points_spent), value_gbp: String(found.value_gbp) }]
          : [];
        return ok(rows as unknown as R[], "SELECT");
      }

      // (both) Append-only ledger insert.
      if (/INSERT INTO ledger_entries/i.test(text)) {
        const [customer_id, entry_type, points, reason, , , redemption_id] = values as [
          string,
          string,
          number,
          string,
          unknown,
          unknown,
          string | null,
        ];
        const row: FakeLedgerEntry = {
          id: nextId("ledger"),
          customer_id,
          entry_type,
          points,
          reason,
          redemption_id: redemption_id ?? null,
        };
        ledger.push(row);
        return ok(
          [
            {
              id: row.id,
              customer_id,
              entry_type,
              points: String(points),
              reason,
              order_reference: null,
              point_lot_id: null,
              redemption_id: row.redemption_id,
              source_event_id: null,
              created_at: new Date("2025-06-01T00:00:00.000Z"),
            },
          ] as unknown as R[],
          "INSERT",
        );
      }

      // (redeem) Spendable balance projection.
      if (/SUM\(remaining_points\)/i.test(text)) {
        const customerId = values[0] as string;
        const asOf = values[1] as Date;
        const sum = lots
          .filter(
            (l) =>
              l.customer_id === customerId &&
              l.remaining_points > 0 &&
              (l.expires_at === null || l.expires_at.getTime() > asOf.getTime()),
          )
          .reduce((s, l) => s + l.remaining_points, 0);
        return ok([{ spendable: String(sum) }] as unknown as R[], "SELECT");
      }

      // (redeem) FIFO consumable lots, locked FOR UPDATE.
      if (/FROM point_lots/i.test(text) && /FOR UPDATE/i.test(text)) {
        const customerId = values[0] as string;
        const asOf = values[1] as Date;
        const selected = lots
          .filter(
            (l) =>
              l.customer_id === customerId &&
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

      // (redeem) Decrement a lot.
      if (/UPDATE point_lots/i.test(text)) {
        const take = values[0] as number;
        const lotId = values[1] as string;
        const target = lots.find((l) => l.id === lotId);
        if (!target) throw new Error(`lot ${lotId} not found`);
        target.remaining_points -= take;
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      // (generate) Compensating reversal lot (only on hard failure — unused here).
      if (/INSERT INTO point_lots/i.test(text)) {
        const [customer_id, ledger_entry_id, points] = values as [string, string, number];
        lots.push({
          id: nextId("lot"),
          customer_id,
          remaining_points: points,
          earned_at: new Date(0),
          expires_at: null,
          seq: idc,
        });
        void ledger_entry_id;
        return ok([], "INSERT") as unknown as QueryResult<R>;
      }

      throw new Error(`unexpected query: ${text}`);
    },
  };

  return { db, customers, lots, redemptions, discountCodes, ledger };
}

function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

/** Records enqueued discount-code jobs so we can assert one-per-fresh-redemption. */
class RecordingEnqueuer implements DiscountCodeEnqueuer {
  readonly jobs: Array<{ redemptionId: string }> = [];
  async enqueueDiscountCode(job: { redemptionId: string }): Promise<void> {
    this.jobs.push(job);
  }
}

/**
 * A fake Admin client that always succeeds and records every mint input, so the
 * property can inspect usage limit, per-customer binding, and the customer GID
 * each code was bound to.
 */
function recordingAdminClient(): { client: ShopifyAdminClient; inputs: DiscountInput[] } {
  const inputs: DiscountInput[] = [];
  const client: ShopifyAdminClient = {
    async createSingleUseDiscount(input: DiscountInput): Promise<DiscountCode> {
      inputs.push({ ...input });
      return {
        code: input.code,
        shopifyPriceRuleId: 1,
        shopifyDiscountId: 2,
        amountOffGBP: input.amountOffGBP,
      };
    },
  };
  return { client, inputs };
}

const noSleep = async (): Promise<void> => {};

// --- Generators -------------------------------------------------------------

/** One redeeming customer: a reward, an idempotency key, and how many times to replay. */
interface Scenario {
  rewardId: RewardId;
  idempotencyKey: string;
  /** Extra job re-runs beyond the first (0..3) to exercise idempotent replay. */
  extraJobRuns: number;
  /** Whether to also replay `redeem` with the same key. */
  replayRedeem: boolean;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  rewardId: fc.constantFrom(...REWARD_IDS),
  idempotencyKey: fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((s) => s.trim().length > 0),
  extraJobRuns: fc.integer({ min: 0, max: 3 }),
  replayRedeem: fc.boolean(),
});

/** A cohort of 1..8 distinct customers, each with its own scenario. */
const cohortArb = fc.array(scenarioArb, { minLength: 1, maxLength: 8 });

// --- Properties -------------------------------------------------------------

describe("Property 10 — single-use, customer-bound discount codes (Req 3.5, 3.6)", () => {
  it("mints exactly one usageLimit=1 customer-bound code per redemption, and replay mints no second code", async () => {
    await fc.assert(
      fc.asyncProperty(cohortArb, async (scenarios) => {
        // Assign each scenario a distinct customer id + Shopify id so we can
        // prove per-customer binding is never crossed.
        const seededCustomers: FakeCustomer[] = [];
        const seededLots: FakeLot[] = [];
        const perScenario = scenarios.map((s, i) => {
          const customerId = `11111111-0000-0000-0000-${String(i).padStart(12, "0")}`;
          const shopifyId = 500000 + i;
          const reward = REWARDS[s.rewardId];
          seededCustomers.push({ id: customerId, shopify_customer_id: shopifyId });
          // Seed a single lot that fully covers the reward cost (+ headroom).
          seededLots.push({
            id: `lot-${i}`,
            customer_id: customerId,
            remaining_points: reward.cost + 25,
            earned_at: new Date("2025-01-01T00:00:00.000Z"),
            expires_at: new Date("2030-01-01T00:00:00.000Z"),
            seq: i,
          });
          return { ...s, customerId, shopifyId, reward };
        });

        const h = makeHarness({ customers: seededCustomers, lots: seededLots });
        const { client, inputs } = recordingAdminClient();
        const gateway = new ShopifyAdminGateway(client, { sleep: noSleep, now: () => 0 });
        const enqueuer = new RecordingEnqueuer();

        const redeemDeps = {
          repo: new LedgerRepository(h.db),
          transactor: makeTransactor(h.db),
          enqueuer,
        };
        const genDeps: DiscountCodeDeps = {
          gateway,
          repo: new LedgerRepository(h.db),
          transactor: makeTransactor(h.db),
          db: h.db,
        };

        for (const sc of perScenario) {
          // Fresh redemption -> spend recorded, one job enqueued.
          const outcome = await redeem(sc.customerId, sc.rewardId, sc.idempotencyKey, redeemDeps);
          expect(outcome.status).toBe("redeemed");
          if (outcome.status !== "redeemed") return;
          const redemptionId = outcome.redemption.id;

          // Optionally replay `redeem` with the same key: must be a no-op replay
          // (no second spend, no second job) — Property 5 supports Property 10.
          if (sc.replayRedeem) {
            const replay = await redeem(sc.customerId, sc.rewardId, sc.idempotencyKey, redeemDeps);
            expect(replay.status).toBe("replayed");
            expect(replay.redemption.id).toBe(redemptionId);
          }

          // First code generation -> issued.
          const first = await processDiscountCodeJob(redemptionId, genDeps);
          expect(first.status).toBe("issued");

          // Re-run the generation job extra times: idempotent, no second code.
          for (let k = 0; k < sc.extraJobRuns; k++) {
            const again = await processDiscountCodeJob(redemptionId, genDeps);
            expect(again.status).toBe("already_issued");
            expect(again.code).toBe(first.code);
            expect(again.discountCodeId).toBe(first.discountCodeId);
          }

          // P10a: exactly one persisted code for this redemption.
          const codesForRedemption = h.discountCodes.filter((c) => c.redemption_id === redemptionId);
          expect(codesForRedemption).toHaveLength(1);

          // P10c: the mint(s) observed for this redemption bind to THIS customer's
          // Shopify GID and no other, and there is exactly one such mint.
          const mintsForRedemption = inputs.filter((inp) => inp.redemptionId === redemptionId);
          expect(mintsForRedemption).toHaveLength(1);
          expect(mintsForRedemption[0]!.customerGid).toBe(
            `gid://shopify/Customer/${sc.shopifyId}`,
          );
          // P10b: single-use + applies-once-per-customer, correct GBP value.
          expect(mintsForRedemption[0]!.usageLimit).toBe(1);
          expect(mintsForRedemption[0]!.appliesOncePerCustomer).toBe(true);
          expect(mintsForRedemption[0]!.amountOffGBP).toBe(sc.reward.valueGBP);
        }

        // Global invariants across the whole cohort:
        // one code per redemption, one mint per redemption, one spend per redemption.
        const redemptionIds = h.redemptions.map((r) => r.id);
        expect(h.discountCodes).toHaveLength(redemptionIds.length);
        expect(inputs).toHaveLength(redemptionIds.length);
        const spendEntries = h.ledger.filter((e) => e.entry_type === "spend");
        expect(spendEntries).toHaveLength(redemptionIds.length);
        // No reversal/adjust entries on the happy path.
        expect(h.ledger.filter((e) => e.entry_type === "adjust")).toHaveLength(0);

        // Every minted code is bound to exactly the customer that redeemed it —
        // binding is never crossed between customers.
        for (const inp of inputs) {
          const r = h.redemptions.find((x) => x.id === inp.redemptionId)!;
          const c = h.customers.get(r.customer_id)!;
          expect(inp.customerGid).toBe(`gid://shopify/Customer/${c.shopify_customer_id}`);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
