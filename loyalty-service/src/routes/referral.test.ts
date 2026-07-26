/**
 * Referral lifecycle tests (task 25, Req 2.9/2.10/11.8/11.9, Property 12/17).
 *
 * WHAT WAS WRONG: the referral engine was fully implemented and unit-tested but
 * had NO production call site, so Req 2.9/2.10 could never fire — no referrer had
 * ever been credited. Shopify's `customers/create` payload carries no referral
 * field, so attribution now arrives from the storefront through the signed App
 * Proxy surface (`POST /v1/referral`), and the first-purchase reward is advanced
 * from the `orders/paid` handler.
 *
 * These tests exercise that wiring end to end against in-memory fakes: the claim
 * endpoint's outcomes and guards, and the +250 advance being ATOMIC with the
 * order earning (which is what stops a retry from losing the first-purchase
 * flag). No live Postgres or Shopify API is touched.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import type { Queryable } from "../ledger/repository.js";
import { LedgerRepository } from "../ledger/repository.js";
import { registerReferralRoutes } from "./referral.js";
import { handleOrdersPaidJob } from "../earning/order.js";
import type { WebhookJob } from "../webhooks/enqueue.js";

const FRIEND = "friend-uuid";
const REFERRER = "referrer-uuid";
const CODE = "ATH-REF-1234";

interface FakeState {
  /** referral_code → customers.id */
  codes: Map<string, string>;
  /** customers.id → referred_by */
  referredBy: Map<string, string>;
  referrals: Array<{
    id: string;
    referrer_id: string;
    referred_id: string;
    signup_rewarded: boolean;
    purchase_rewarded: boolean;
  }>;
  ledger: Array<{ id: string; customer_id: string; entry_type: string; points: number }>;
  lots: Array<{ customer_id: string; ledger_entry_id: string; points: number; expires_at: Date | null }>;
  hasPaidPurchase: Set<string>;
}

function makeState(over: Partial<FakeState> = {}): FakeState {
  return {
    codes: new Map([[CODE, REFERRER]]),
    referredBy: new Map(),
    referrals: [],
    ledger: [],
    lots: [],
    hasPaidPurchase: new Set(),
    ...over,
  };
}

/** Models exactly the statements the referral claim path issues. */
class FakeDb implements Queryable {
  private seq = 0;
  constructor(readonly state: FakeState) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = (rows: QueryResultRow[], command = "SELECT"): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rows.length,
      command,
      oid: 0,
      fields: [],
    });
    const s = this.state;

    // GET /v1/referral self lookup.
    if (text.includes("FROM customers c") && text.includes("referral_code")) {
      const id = values[0] as string;
      const code = [...s.codes.entries()].find(([, cid]) => cid === id)?.[0] ?? null;
      return ok([
        {
          referral_code: code,
          was_referred: s.referredBy.has(id),
          signup_rewards: s.referrals.filter((r) => r.referrer_id === id && r.signup_rewarded).length,
          purchase_rewards: s.referrals.filter((r) => r.referrer_id === id && r.purchase_rewarded)
            .length,
        },
      ]);
    }
    // Eligibility gate: any prior paid-order earning?
    if (text.includes("entry_type = 'earn_order'")) {
      return ok(s.hasPaidPurchase.has(values[0] as string) ? [{ one: 1 }] : []);
    }
    // resolveReferrerByCode
    if (text.includes("WHERE referral_code")) {
      const id = s.codes.get(values[0] as string);
      return ok(id ? [{ id }] : []);
    }
    // referred_by assignment
    if (text.includes("UPDATE customers") && text.includes("referred_by")) {
      const [customerId, referrerId] = values as [string, string];
      if (customerId === referrerId) return ok([]); // DB CHECK analogue
      s.referredBy.set(customerId, referrerId);
      return ok([{ id: customerId }], "UPDATE");
    }
    // Existing referral for (referrer, referred)
    if (text.includes("SELECT id, signup_rewarded, purchase_rewarded")) {
      const [referrerId, referredId] = values as [string, string];
      const row = s.referrals.find(
        (r) => r.referrer_id === referrerId && r.referred_id === referredId,
      );
      return ok(row ? [row] : []);
    }
    if (text.includes("INSERT INTO referrals")) {
      const [referrerId, referredId] = values as [string, string];
      if (referrerId === referredId) {
        throw new Error('violates check constraint "referrals_check"');
      }
      // The real INSERT inlines the stage flags in the SQL (`VALUES ($1, $2,
      // $3, true, false)`) — it records the row ALREADY signup-rewarded. Mirror
      // that, or a second claim would see an un-rewarded row and award twice.
      const row = {
        id: `ref-${++this.seq}`,
        referrer_id: referrerId,
        referred_id: referredId,
        signup_rewarded: /signup_rewarded[\s\S]*VALUES[\s\S]*true/i.test(text),
        purchase_rewarded: false,
      };
      s.referrals.push(row);
      return ok([row], "INSERT");
    }
    if (text.includes("UPDATE referrals SET signup_rewarded")) {
      const row = s.referrals.find((r) => r.id === values[0]);
      if (row) row.signup_rewarded = true;
      return ok([], "UPDATE");
    }
    if (text.includes("INSERT INTO ledger_entries")) {
      const row = {
        id: `ledg-${++this.seq}`,
        customer_id: values[0] as string,
        entry_type: values[1] as string,
        points: values[2] as number,
      };
      s.ledger.push(row);
      return ok([
        {
          ...row,
          points: String(row.points),
          reason: values[3] as string,
          order_reference: null,
          point_lot_id: null,
          redemption_id: null,
          source_event_id: null,
          created_at: new Date("2026-06-01T00:00:00Z"),
        },
      ], "INSERT");
    }
    if (text.includes("INSERT INTO point_lots")) {
      s.lots.push({
        customer_id: values[0] as string,
        ledger_entry_id: values[1] as string,
        points: values[2] as number,
        expires_at: (values[4] as Date | null) ?? null,
      });
      return ok([], "INSERT");
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

/** Builds an app with the claim routes and a stubbed resolved identity. */
async function buildTestApp(db: FakeDb, customerId: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Stand in for the scope-level App Proxy auth preHandler, which resolves the
  // customer from the VERIFIED signature — never from the request body.
  app.addHook("preHandler", async (req) => {
    req.authCtx = { customerId, source: "app_proxy", channel: "web" };
  });
  registerReferralRoutes(app, {
    repo: new LedgerRepository(db),
    transactor: { transaction: (fn) => fn(db) },
    db,
  });
  await app.ready();
  return app;
}

const claim = (app: FastifyInstance, referralCode: string) =>
  app.inject({ method: "POST", url: "/referral", payload: { referralCode } });

describe("POST /v1/referral — attribution and the +150 signup reward (Req 2.9)", () => {
  it("credits the referrer +150 exactly once, with a 12-month backing lot", async () => {
    const state = makeState();
    const db = new FakeDb(state);
    const app = await buildTestApp(db, FRIEND);

    const res = await claim(app, CODE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "rewarded" });

    // Exactly one +150 earn_referral, credited to the REFERRER not the friend.
    const rewards = state.ledger.filter((e) => e.entry_type === "earn_referral");
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.points).toBe(150);
    expect(rewards[0]!.customer_id).toBe(REFERRER);

    // Property 17: the credit is backed by a lot of the same amount.
    expect(state.lots).toHaveLength(1);
    expect(state.lots[0]!.points).toBe(150);
    expect(state.lots[0]!.customer_id).toBe(REFERRER);
    expect(state.lots[0]!.expires_at).not.toBeNull();

    await app.close();
  });

  it("is idempotent: a repeated claim creates no second reward or lot", async () => {
    const state = makeState();
    const db = new FakeDb(state);
    const app = await buildTestApp(db, FRIEND);

    await claim(app, CODE);
    const second = await claim(app, CODE);

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: "already_rewarded" });
    expect(state.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(1);
    expect(state.lots).toHaveLength(1);

    await app.close();
  });

  it("refuses self-referral, creating no earning and no lot (Req 11.8, Property 12)", async () => {
    const state = makeState();
    const db = new FakeDb(state);
    // The claimant IS the owner of the code.
    const app = await buildTestApp(db, REFERRER);

    const res = await claim(app, CODE);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "self_referral_rejected" });
    expect(state.ledger).toHaveLength(0);
    expect(state.lots).toHaveLength(0);
    expect(state.referrals).toHaveLength(0);

    await app.close();
  });

  it("rejects an unknown code without creating anything", async () => {
    const state = makeState();
    const db = new FakeDb(state);
    const app = await buildTestApp(db, FRIEND);

    const res = await claim(app, "ATH-NOPE-0000");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "unknown_referral_code" });
    expect(state.ledger).toHaveLength(0);

    await app.close();
  });

  it("refuses a late claim once the account already has a paid purchase (Req 11.9 spirit)", async () => {
    const state = makeState({ hasPaidPurchase: new Set([FRIEND]) });
    const db = new FakeDb(state);
    const app = await buildTestApp(db, FRIEND);

    const res = await claim(app, CODE);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "referral_not_eligible" });
    expect(state.ledger).toHaveLength(0);

    await app.close();
  });

  it("validates the body", async () => {
    const db = new FakeDb(makeState());
    const app = await buildTestApp(db, FRIEND);

    const res = await app.inject({ method: "POST", url: "/referral", payload: {} });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /v1/referral — the member's own referral state", () => {
  it("returns the member's code and stage counts", async () => {
    const state = makeState();
    state.referrals.push({
      id: "ref-x",
      referrer_id: REFERRER,
      referred_id: FRIEND,
      signup_rewarded: true,
      purchase_rewarded: false,
    });
    const db = new FakeDb(state);
    const app = await buildTestApp(db, REFERRER);

    const res = await app.inject({ method: "GET", url: "/referral" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      referralCode: CODE,
      wasReferred: false,
      referredSignups: 1,
      referredFirstPurchases: 0,
    });

    await app.close();
  });
});

/* ------------------ orders/paid advances the referral stage ------------------ */

describe("orders/paid advances the referral stage atomically (Req 2.10/11.9)", () => {
  const orderJob = (): WebhookJob =>
    ({
      webhookId: "wh-order-1",
      topic: "orders/paid",
      shopDomain: "athoor-loyalty-staging.myshopify.com",
      payload: {
        id: 5_500_000_001,
        current_subtotal_price: "100.00",
        customer: { id: 9_100_000_001 },
      },
    }) as unknown as WebhookJob;

  /** Minimal order-earning fake; records whether the advance shared the tx. */
  class OrderFakeDb implements Queryable {
    advanceCalls: Array<{ isFirstPaidPurchase: boolean }> = [];
    private seq = 0;
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      const ok = (rows: QueryResultRow[]): QueryResult<R> => ({
        rows: rows as R[],
        rowCount: rows.length,
        command: "SELECT",
        oid: 0,
        fields: [],
      });
      if (text.includes("INSERT INTO customers")) return ok([{ id: "cust-1", tier: "bronze", lifetime_spend_gbp: "0.00" }]);
      if (text.includes("FOR UPDATE")) return ok([{ id: "cust-1", tier: "bronze", lifetime_spend_gbp: "0.00" }]);
      if (text.includes("FROM ledger_entries")) return ok([]);
      if (text.includes("INSERT INTO ledger_entries")) {
        this.seq += 1;
        return ok([
          {
            id: `ledg-${this.seq}`,
            customer_id: values[0] as string,
            entry_type: values[1] as string,
            points: String(values[2]),
            reason: values[3] as string,
            order_reference: null,
            point_lot_id: null,
            redemption_id: null,
            source_event_id: null,
            created_at: new Date("2026-06-01T00:00:00Z"),
          },
        ]);
      }
      if (text.includes("INSERT INTO point_lots")) return ok([]);
      if (text.startsWith("UPDATE customers") || text.includes("SET lifetime_spend_gbp")) return ok([]);
      return ok([]);
    }
  }

  it("passes the first-purchase flag to the referral advance inside the order transaction", async () => {
    const db = new OrderFakeDb();
    const seenTx: unknown[] = [];

    const outcome = await handleOrdersPaidJob(orderJob(), {
      repo: new LedgerRepository(db),
      transactor: { transaction: (fn) => fn(db) },
      advanceReferralStage: async (args, tx) => {
        db.advanceCalls.push({ isFirstPaidPurchase: args.isFirstPaidPurchase });
        seenTx.push(tx);
      },
    });

    expect(outcome?.status).toBe("earned");
    expect(db.advanceCalls).toEqual([{ isFirstPaidPurchase: true }]);
    // Same executor as the earning → the award is atomic with it, so a retry
    // cannot lose the first-purchase flag.
    expect(seenTx[0]).toBe(db);
  });

  it("works unchanged when no referral advance is wired", async () => {
    const db = new OrderFakeDb();
    const outcome = await handleOrdersPaidJob(orderJob(), {
      repo: new LedgerRepository(db),
      transactor: { transaction: (fn) => fn(db) },
    });
    expect(outcome?.status).toBe("earned");
    expect(db.advanceCalls).toEqual([]);
  });
});
