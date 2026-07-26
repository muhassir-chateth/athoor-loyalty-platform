/**
 * Unit tests for the queued single-use discount-code worker (task 5.3).
 *
 * No live/production database or Shopify Admin API is touched. The worker runs
 * end-to-end against a stateful in-memory fake that models exactly the tables
 * and SQL the worker issues — the redemption+customer load, the
 * discount_codes collision check / insert, the redemption status updates, the
 * append-only ledger insert, and the compensating point-lot insert — plus a
 * fake Admin client injected behind the real {@link ShopifyAdminGateway}. The
 * real {@link LedgerRepository} is used unchanged; only the DB and Admin
 * boundaries are faked, so NO live Shopify Admin API is ever called.
 *
 * Covers:
 *   - a single unique, single-use, customer-bound code minted + persisted, and
 *     the redemption moved to `issued` carrying the code (Req 3.5, 3.6, 3.8,
 *     Property 10);
 *   - code collision retried against discount_codes.code (design collision-check);
 *   - idempotent replay: an already-issued redemption mints no second code
 *     (Req 3.7 / Property 10);
 *   - throttling retried with backoff then issued (Req 13.2 / 13.3);
 *   - throttle exhaustion leaves the redemption pending + surfaces CodeNotIssuedError
 *     (Req 13.4);
 *   - a terminal hard failure marks the redemption failed and records a
 *     compensating adjustment reversing the spend (Req 3.9).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import {
  ShopifyAdminGateway,
  ShopifyThrottleError,
  type DiscountCode,
  type DiscountInput,
  type ShopifyAdminClient,
} from "../shopify/adminGateway.js";
import type { RandomInt } from "./discountCodeFormat.js";
import type { Transactor } from "./redeem.js";
import {
  CodeNotIssuedError,
  processDiscountCodeJob,
  REDEMPTION_STATUS_FAILED,
  REDEMPTION_STATUS_ISSUED,
  RedemptionFailedError,
  REVERSAL_REASON,
  type DiscountCodeDeps,
} from "./generateDiscountCode.js";

const REDEMPTION_ID = "redemption-1";
const CUSTOMER_ID = "cust-uuid-1";
const SHOPIFY_CUSTOMER_ID = 987654321;

interface FakeRedemption {
  id: string;
  customer_id: string;
  reward_id: string;
  points_spent: number;
  value_gbp: number;
  status: string;
  discount_code_id: string | null;
}

interface FakeDiscountCode {
  id: string;
  redemption_id: string;
  code: string;
  shopify_price_rule_id: number | null;
  shopify_discount_id: number | null;
  amount_off_gbp: number;
  status: string;
}

interface FakeLedgerEntry {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  redemption_id: string | null;
}

interface FakePointLot {
  id: string;
  customer_id: string;
  ledger_entry_id: string;
  original_points: number;
  remaining_points: number;
  expires_at: Date | null;
}

interface FakeDbOptions {
  redemption?: Partial<FakeRedemption>;
  seedCodes?: string[];
}

interface FakeDb {
  db: Queryable;
  redemptions: Map<string, FakeRedemption>;
  discountCodes: FakeDiscountCode[];
  ledger: FakeLedgerEntry[];
  lots: FakePointLot[];
}

function makeDb(options: FakeDbOptions = {}): FakeDb {
  const redemption: FakeRedemption = {
    id: REDEMPTION_ID,
    customer_id: CUSTOMER_ID,
    reward_id: "reward_5",
    points_spent: 100,
    value_gbp: 5,
    status: "pending_code",
    discount_code_id: null,
    ...options.redemption,
  };
  const redemptions = new Map<string, FakeRedemption>([[redemption.id, redemption]]);
  const discountCodes: FakeDiscountCode[] = (options.seedCodes ?? []).map((code, i) => ({
    id: `seed-code-${i}`,
    redemption_id: "some-other-redemption",
    code,
    shopify_price_rule_id: null,
    shopify_discount_id: null,
    amount_off_gbp: 5,
    status: "active",
  }));
  const ledger: FakeLedgerEntry[] = [];
  const lots: FakePointLot[] = [];
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

      // Load redemption + customer (the JOIN query).
      if (/JOIN customers/i.test(text)) {
        const r = redemptions.get(values[0] as string);
        const rows = r
          ? [
              {
                id: r.id,
                customer_id: r.customer_id,
                reward_id: r.reward_id,
                points_spent: String(r.points_spent),
                value_gbp: String(r.value_gbp),
                status: r.status,
                discount_code_id: r.discount_code_id,
                shopify_customer_id: String(SHOPIFY_CUSTOMER_ID),
              },
            ]
          : [];
        return ok(rows as unknown as R[], "SELECT");
      }

      // Find an existing code for the redemption (idempotency).
      if (/FROM discount_codes WHERE redemption_id/i.test(text)) {
        const found = discountCodes.filter((c) => c.redemption_id === (values[0] as string));
        const rows = found.map((c) => ({ id: c.id, code: c.code }));
        return ok(rows as unknown as R[], "SELECT");
      }

      // Collision check by code.
      if (/FROM discount_codes WHERE code/i.test(text)) {
        const hit = discountCodes.some((c) => c.code === (values[0] as string));
        return ok((hit ? [{ one: 1 }] : []) as unknown as R[], "SELECT");
      }

      // Insert a minted discount code.
      if (/INSERT INTO discount_codes/i.test(text)) {
        const [redemption_id, code, priceRule, discountId, amount] = values as [
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
          shopify_price_rule_id: priceRule ?? null,
          shopify_discount_id: discountId ?? null,
          amount_off_gbp: amount,
          status: "active",
        };
        discountCodes.push(row);
        return ok([{ id: row.id, code: row.code }] as unknown as R[], "INSERT");
      }

      // Update redemption -> issued (carries discount_code_id).
      if (/UPDATE redemptions SET status = \$2, discount_code_id/i.test(text)) {
        const r = redemptions.get(values[0] as string);
        if (r) {
          r.status = values[1] as string;
          r.discount_code_id = values[2] as string;
        }
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      // Update redemption -> failed.
      if (/UPDATE redemptions SET status = \$2 WHERE id/i.test(text)) {
        const r = redemptions.get(values[0] as string);
        if (r) {
          r.status = values[1] as string;
        }
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      // Existing-reversal guard (exactly one compensating adjustment, Req 3.9).
      if (/SELECT 1\s+FROM ledger_entries/i.test(text)) {
        const hit = ledger.some(
          (e) =>
            e.redemption_id === (values[0] as string) &&
            e.entry_type === "adjust" &&
            e.reason === (values[1] as string),
        );
        return ok((hit ? [{ one: 1 }] : []) as unknown as R[], "SELECT");
      }

      // Append-only ledger insert (from LedgerRepository.append).
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
              created_at: new Date("2025-06-01T00:00:00Z"),
            },
          ] as unknown as R[],
          "INSERT",
        );
      }

      // Compensating point-lot insert.
      if (/INSERT INTO point_lots/i.test(text)) {
        const [customer_id, ledger_entry_id, points] = values as [string, string, number];
        lots.push({
          id: nextId("lot"),
          customer_id,
          ledger_entry_id,
          original_points: points,
          remaining_points: points,
          expires_at: null,
        });
        return ok([], "INSERT") as unknown as QueryResult<R>;
      }

      throw new Error(`unexpected query: ${text}`);
    },
  };

  return { db, redemptions, discountCodes, ledger, lots };
}

function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

/** A fake Admin client whose per-call behaviour is scripted. */
type Step = "ok" | "throttle" | "fail";
function scriptedClient(steps: Step[]): { client: ShopifyAdminClient; inputs: DiscountInput[] } {
  const inputs: DiscountInput[] = [];
  let i = 0;
  const client: ShopifyAdminClient = {
    async createSingleUseDiscount(input: DiscountInput): Promise<DiscountCode> {
      inputs.push(input);
      const step = steps[i] ?? steps[steps.length - 1] ?? "ok";
      i += 1;
      if (step === "throttle") throw new ShopifyThrottleError();
      if (step === "fail") throw new Error("admin hard failure");
      return {
        code: input.code,
        shopifyPriceRuleId: 111,
        shopifyDiscountId: 222,
        amountOffGBP: input.amountOffGBP,
      };
    },
  };
  return { client, inputs };
}

const noSleep = async (): Promise<void> => {};

function makeDeps(
  fake: FakeDb,
  gateway: DiscountCodeDeps["gateway"],
  randomInt?: RandomInt,
): DiscountCodeDeps {
  const deps: DiscountCodeDeps = {
    gateway,
    repo: new LedgerRepository(fake.db),
    transactor: makeTransactor(fake.db),
    db: fake.db,
  };
  if (randomInt) {
    deps.randomInt = randomInt;
  }
  return deps;
}

/** A deterministic random source that walks the alphabet indices sequentially. */
function sequentialRandom(): RandomInt {
  let n = 0;
  return (max: number) => n++ % max;
}

describe("processDiscountCodeJob: mints exactly one single-use, customer-bound code (Req 3.5, 3.6, 3.8, Property 10)", () => {
  it("persists the code, binds it to the customer, and marks the redemption issued", async () => {
    const fake = makeDb();
    const { client, inputs } = scriptedClient(["ok"]);
    const gateway = new ShopifyAdminGateway(client, { sleep: noSleep, now: () => 0 });

    const outcome = await processDiscountCodeJob(REDEMPTION_ID, makeDeps(fake, gateway));

    expect(outcome.status).toBe("issued");

    // Exactly one code minted, single-use + customer-bound (Property 10, Req 3.6).
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.usageLimit).toBe(1);
    expect(inputs[0]!.appliesOncePerCustomer).toBe(true);
    expect(inputs[0]!.customerGid).toBe(`gid://shopify/Customer/${SHOPIFY_CUSTOMER_ID}`);
    expect(inputs[0]!.amountOffGBP).toBe(5);

    // Exactly one discount_codes row, linked to this redemption (Req 3.8).
    expect(fake.discountCodes).toHaveLength(1);
    expect(fake.discountCodes[0]!.redemption_id).toBe(REDEMPTION_ID);
    expect(fake.discountCodes[0]!.code).toBe(outcome.code);

    // Redemption now carries the code and is issued (Req 3.8).
    const r = fake.redemptions.get(REDEMPTION_ID)!;
    expect(r.status).toBe(REDEMPTION_STATUS_ISSUED);
    expect(r.discount_code_id).toBe(outcome.discountCodeId);

    // No reversal happened.
    expect(fake.ledger).toHaveLength(0);
    expect(fake.lots).toHaveLength(0);
  });

  it("regenerates the code on a collision against discount_codes.code", async () => {
    // First deterministic candidate is ATH-ABCD-EFGH; seed it so it collides.
    const fake = makeDb({ seedCodes: ["ATH-ABCD-EFGH"] });
    const { client, inputs } = scriptedClient(["ok"]);
    const gateway = new ShopifyAdminGateway(client, { sleep: noSleep, now: () => 0 });

    const outcome = await processDiscountCodeJob(
      REDEMPTION_ID,
      makeDeps(fake, gateway, sequentialRandom()),
    );

    // The colliding candidate was skipped; the second candidate was minted.
    expect(outcome.code).toBe("ATH-JKLM-NPQR");
    expect(inputs[0]!.code).toBe("ATH-JKLM-NPQR");
    expect(fake.discountCodes.some((c) => c.code === "ATH-JKLM-NPQR")).toBe(true);
  });
});

describe("processDiscountCodeJob: idempotent replay (Req 3.7, Property 10)", () => {
  it("mints no second code when the redemption is already issued", async () => {
    const fake = makeDb();
    const { client } = scriptedClient(["ok"]);
    const gateway = new ShopifyAdminGateway(client, { sleep: noSleep, now: () => 0 });
    const deps = makeDeps(fake, gateway);

    const first = await processDiscountCodeJob(REDEMPTION_ID, deps);
    expect(first.status).toBe("issued");

    // Re-run the job: must return the same code and mint nothing new.
    const second = await processDiscountCodeJob(REDEMPTION_ID, deps);
    expect(second.status).toBe("already_issued");
    expect(second.code).toBe(first.code);
    expect(second.discountCodeId).toBe(first.discountCodeId);

    // Still exactly one code, one issued redemption, no reversal.
    expect(fake.discountCodes).toHaveLength(1);
    expect(fake.ledger).toHaveLength(0);
  });
});

describe("processDiscountCodeJob: throttling (Req 13.2 / 13.3 / 13.4)", () => {
  it("retries on throttle then issues the code", async () => {
    const fake = makeDb();
    const { client, inputs } = scriptedClient(["throttle", "throttle", "ok"]);
    const gateway = new ShopifyAdminGateway(client, { sleep: noSleep, now: () => 0 });

    const outcome = await processDiscountCodeJob(REDEMPTION_ID, makeDeps(fake, gateway));

    expect(outcome.status).toBe("issued");
    expect(inputs.length).toBe(3);
    expect(fake.redemptions.get(REDEMPTION_ID)!.status).toBe(REDEMPTION_STATUS_ISSUED);
  });

  it("leaves the redemption pending and surfaces CodeNotIssuedError after throttle exhaustion (Req 13.4)", async () => {
    const fake = makeDb();
    const { client } = scriptedClient(["throttle"]); // always throttled
    const gateway = new ShopifyAdminGateway(client, { sleep: noSleep, now: () => 0 });

    await expect(
      processDiscountCodeJob(REDEMPTION_ID, makeDeps(fake, gateway)),
    ).rejects.toBeInstanceOf(CodeNotIssuedError);

    // Redemption retained pending; no code, no spend duplication, no reversal.
    expect(fake.redemptions.get(REDEMPTION_ID)!.status).toBe("pending_code");
    expect(fake.discountCodes).toHaveLength(0);
    expect(fake.ledger).toHaveLength(0);
  });
});

describe("processDiscountCodeJob: terminal hard failure reverses the spend (Req 3.9)", () => {
  it("marks the redemption failed and records a compensating adjustment for the exact cost", async () => {
    const fake = makeDb();
    const { client } = scriptedClient(["fail", "fail", "fail"]);
    // Clock advances 1s per observation → 3 consecutive failures within 60s.
    let t = 0;
    const now = (): number => {
      const v = t;
      t += 1000;
      return v;
    };
    const gateway = new ShopifyAdminGateway(client, { sleep: noSleep, now });

    await expect(
      processDiscountCodeJob(REDEMPTION_ID, makeDeps(fake, gateway)),
    ).rejects.toBeInstanceOf(RedemptionFailedError);

    // Redemption marked failed, no code issued (Req 3.9).
    expect(fake.redemptions.get(REDEMPTION_ID)!.status).toBe(REDEMPTION_STATUS_FAILED);
    expect(fake.discountCodes).toHaveLength(0);

    // Exactly one compensating +cost adjustment reversing the spend (Req 3.9).
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger[0]!.entry_type).toBe("adjust");
    expect(fake.ledger[0]!.points).toBe(100);
    expect(fake.ledger[0]!.reason).toBe(REVERSAL_REASON);
    expect(fake.ledger[0]!.redemption_id).toBe(REDEMPTION_ID);

    // A restoring point-lot makes the reversed points spendable again.
    expect(fake.lots).toHaveLength(1);
    expect(fake.lots[0]!.remaining_points).toBe(100);
  });

  it("reverses the spend only ONCE when the queue retries the failed job (Req 3.9)", async () => {
    // Regression: a terminal failure marks the redemption `failed` and throws,
    // which hands the job back to pg-boss. Every retry used to re-run the mint
    // path and reverse the spend again, crediting the customer once per attempt
    // (observed on staging: three +cost adjustments and three lots for a single
    // 250-point spend). A retry must be a no-op against the ledger.
    const fake = makeDb();
    const { client, inputs } = scriptedClient(["fail", "fail", "fail"]);
    let t = 0;
    const now = (): number => {
      const v = t;
      t += 1000;
      return v;
    };
    const gateway = new ShopifyAdminGateway(client, { sleep: noSleep, now });
    const deps = makeDeps(fake, gateway);

    // First attempt: terminal failure → failed + exactly one reversal.
    await expect(processDiscountCodeJob(REDEMPTION_ID, deps)).rejects.toBeInstanceOf(
      RedemptionFailedError,
    );
    const adminCallsAfterFirst = inputs.length;

    // Two queue-level retries of the same job.
    await expect(processDiscountCodeJob(REDEMPTION_ID, deps)).rejects.toBeInstanceOf(
      RedemptionFailedError,
    );
    await expect(processDiscountCodeJob(REDEMPTION_ID, deps)).rejects.toBeInstanceOf(
      RedemptionFailedError,
    );

    // Still exactly one compensating adjustment and one restoring lot.
    expect(fake.ledger.filter((e) => e.reason === REVERSAL_REASON)).toHaveLength(1);
    expect(fake.lots).toHaveLength(1);

    // And the retries short-circuit before touching the Admin API.
    expect(inputs).toHaveLength(adminCallsAfterFirst);
    expect(fake.discountCodes).toHaveLength(0);
    expect(fake.redemptions.get(REDEMPTION_ID)!.status).toBe(REDEMPTION_STATUS_FAILED);
  });
});
