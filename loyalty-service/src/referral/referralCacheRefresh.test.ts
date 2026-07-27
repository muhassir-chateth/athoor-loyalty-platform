/**
 * Metafield_Cache refresh after EVERY committed REFERRAL balance change
 * (task 35, Req 13.5a; audit finding F4).
 *
 * WHAT WAS WRONG: `metafieldEnqueuer` was threaded through the webhook, redemption
 * and admin-adjustment paths but never the referral engine. Both referral rewards
 * credit the REFERRER, who is a DIFFERENT customer from the claiming friend and
 * from the order's buyer — so the `orders/paid` refresh covered the buyer only and
 * the referrer's `loyalty.*` cache stayed stale. Live staging showed exactly that:
 * a member with 250 spendable had `loyalty.points_balance: 50`.
 *
 * These tests drive the two real call sites with a recording enqueuer and
 * in-memory fakes:
 *   - `POST /v1/referral` (+150): a rewarded claim enqueues exactly one refresh
 *     for the REFERRER and none for the claimer; every non-rewarding outcome
 *     (`already_rewarded`, self-referral, unknown code, ineligible) enqueues
 *     nothing; a throwing enqueuer never fails the already-committed credit; and
 *     no enqueuer wired is a safe no-op.
 *   - the `orders/paid` referral stage (+250): a first-purchase award enqueues for
 *     BOTH the buyer and the referrer; a non-awarding advance enqueues for the
 *     buyer only; a throwing enqueuer does not fail dispatch.
 *
 * No live Postgres, Shopify Admin API or pg-boss queue is touched.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { registerReferralRoutes } from "../routes/referral.js";
import { dispatchWebhookJob, type Transactor } from "../worker.js";
import { ORDERS_PAID_TOPIC } from "../earning/order.js";
import type { WebhookJob } from "../webhooks/enqueue.js";
import {
  RecordingMetafieldCacheEnqueuer,
  type MetafieldCacheEnqueuer,
  type MetafieldCacheJob,
} from "../shopify/metafieldCache.js";

const FRIEND = "friend-uuid";
const REFERRER = "referrer-uuid";
const CODE = "ATH-6JX5-CJQJ";

/** An enqueuer whose queue is down: every publish throws (Req 13.5 non-fatality). */
class ThrowingEnqueuer implements MetafieldCacheEnqueuer {
  readonly attempts: MetafieldCacheJob[] = [];
  async enqueueMetafieldCache(job: MetafieldCacheJob): Promise<void> {
    this.attempts.push({ ...job });
    throw new Error("pg-boss unavailable");
  }
}

/* -------------------------------------------------------------------------- */
/* POST /v1/referral — the +150 signup reward credits the REFERRER.           */
/* -------------------------------------------------------------------------- */

interface ClaimState {
  /** referral_code → owning customers.id */
  codes: Map<string, string>;
  referredBy: Map<string, string>;
  referrals: Array<{
    id: string;
    referrer_id: string;
    referred_id: string;
    signup_rewarded: boolean;
    purchase_rewarded: boolean;
  }>;
  ledger: Array<{ id: string; customer_id: string; entry_type: string; points: number }>;
  lots: Array<{ customer_id: string; points: number }>;
  hasPaidPurchase: Set<string>;
}

function makeClaimState(over: Partial<ClaimState> = {}): ClaimState {
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

/** Models exactly the statements the claim path issues (mirrors referral.test.ts). */
class ClaimFakeDb implements Queryable {
  private seq = 0;
  constructor(readonly state: ClaimState) {}

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

    if (text.includes("entry_type = 'earn_order'")) {
      return ok(s.hasPaidPurchase.has(values[0] as string) ? [{ one: 1 }] : []);
    }
    if (text.includes("WHERE referral_code")) {
      const id = s.codes.get(values[0] as string);
      return ok(id ? [{ id }] : []);
    }
    if (text.includes("UPDATE customers") && text.includes("referred_by")) {
      const [customerId, referrerId] = values as [string, string];
      if (customerId === referrerId) return ok([]);
      s.referredBy.set(customerId, referrerId);
      return ok([{ id: customerId }], "UPDATE");
    }
    // Task 40: the accepted-referral lookup is by `referred_id`, not by the pair.
    if (text.includes("SELECT id, referrer_id, signup_rewarded, purchase_rewarded")) {
      const referredId = values[0] as string;
      const row = s.referrals.find((r) => r.referred_id === referredId);
      return ok(row ? [row] : []);
    }
    if (text.includes("INSERT INTO referrals")) {
      const [referrerId, referredId] = values as [string, string];
      // Partial unique index on `referred_id` + `ON CONFLICT DO NOTHING`:
      // a conflict returns zero rows rather than raising.
      if (s.referrals.some((r) => r.referred_id === referredId)) {
        return ok([], "INSERT");
      }
      const row = {
        id: `ref-${++this.seq}`,
        referrer_id: referrerId,
        referred_id: referredId,
        signup_rewarded: true,
        purchase_rewarded: false,
      };
      s.referrals.push(row);
      return ok([row], "INSERT");
    }
    if (text.includes("INSERT INTO ledger_entries")) {
      const row = {
        id: `ledg-${++this.seq}`,
        customer_id: values[0] as string,
        entry_type: values[1] as string,
        points: values[2] as number,
      };
      s.ledger.push(row);
      return ok(
        [
          {
            ...row,
            points: String(row.points),
            reason: values[3] as string,
            order_reference: null,
            point_lot_id: null,
            redemption_id: null,
            source_event_id: null,
            created_at: new Date("2026-07-26T13:01:32.831Z"),
          },
        ],
        "INSERT",
      );
    }
    if (text.includes("INSERT INTO point_lots")) {
      s.lots.push({ customer_id: values[0] as string, points: values[2] as number });
      return ok([], "INSERT");
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

async function buildClaimApp(
  db: ClaimFakeDb,
  customerId: string,
  metafieldEnqueuer?: MetafieldCacheEnqueuer,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    req.authCtx = { customerId, source: "app_proxy", channel: "web" };
  });
  registerReferralRoutes(app, {
    repo: new LedgerRepository(db),
    transactor: { transaction: (fn) => fn(db) },
    db,
    ...(metafieldEnqueuer ? { metafieldEnqueuer } : {}),
  });
  await app.ready();
  return app;
}

const claim = (app: FastifyInstance, referralCode: string) =>
  app.inject({ method: "POST", url: "/referral", payload: { referralCode } });

describe("POST /v1/referral refreshes the REFERRER's display cache (task 35, Req 13.5a)", () => {
  it("enqueues exactly one refresh for the referrer — and none for the claiming friend", async () => {
    const db = new ClaimFakeDb(makeClaimState());
    const enqueuer = new RecordingMetafieldCacheEnqueuer();
    const app = await buildClaimApp(db, FRIEND, enqueuer);

    const res = await claim(app, CODE);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "rewarded" });
    // The referrer's balance is the only one that moved (+150), so it is the
    // only cache that needs refreshing.
    expect(enqueuer.jobs).toEqual([{ customerId: REFERRER }]);
    expect(enqueuer.jobs.map((j) => j.customerId)).not.toContain(FRIEND);

    await app.close();
  });

  it("enqueues nothing on a repeated claim (already_rewarded — no balance change)", async () => {
    const db = new ClaimFakeDb(makeClaimState());
    const enqueuer = new RecordingMetafieldCacheEnqueuer();
    const app = await buildClaimApp(db, FRIEND, enqueuer);

    await claim(app, CODE);
    const second = await claim(app, CODE);

    expect(second.json()).toMatchObject({ status: "already_rewarded" });
    // Still exactly the one enqueue from the first, rewarded claim.
    expect(enqueuer.jobs).toEqual([{ customerId: REFERRER }]);

    await app.close();
  });

  it("enqueues nothing when a self-referral is rejected (Req 11.8)", async () => {
    const db = new ClaimFakeDb(makeClaimState());
    const enqueuer = new RecordingMetafieldCacheEnqueuer();
    const app = await buildClaimApp(db, REFERRER, enqueuer);

    const res = await claim(app, CODE);

    expect(res.statusCode).toBe(409);
    expect(enqueuer.jobs).toEqual([]);

    await app.close();
  });

  it("enqueues nothing for an unknown code (no_referrer)", async () => {
    const db = new ClaimFakeDb(makeClaimState());
    const enqueuer = new RecordingMetafieldCacheEnqueuer();
    const app = await buildClaimApp(db, FRIEND, enqueuer);

    const res = await claim(app, "ATH-NOPE-0000");

    expect(res.statusCode).toBe(404);
    expect(enqueuer.jobs).toEqual([]);

    await app.close();
  });

  it("enqueues nothing when the claim is refused as ineligible", async () => {
    const db = new ClaimFakeDb(makeClaimState({ hasPaidPurchase: new Set([FRIEND]) }));
    const enqueuer = new RecordingMetafieldCacheEnqueuer();
    const app = await buildClaimApp(db, FRIEND, enqueuer);

    const res = await claim(app, CODE);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "referral_not_eligible" });
    expect(enqueuer.jobs).toEqual([]);

    await app.close();
  });

  it("still succeeds when the enqueue FAILS: the credit is committed and the response is success", async () => {
    const state = makeClaimState();
    const db = new ClaimFakeDb(state);
    const enqueuer = new ThrowingEnqueuer();
    const app = await buildClaimApp(db, FRIEND, enqueuer);

    const res = await claim(app, CODE);

    // The queue is down, but the ledger is authoritative and already committed.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "rewarded" });
    expect(enqueuer.attempts).toEqual([{ customerId: REFERRER }]);
    const rewards = state.ledger.filter((e) => e.entry_type === "earn_referral");
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.points).toBe(150);
    expect(rewards[0]!.customer_id).toBe(REFERRER);
    expect(state.lots).toEqual([{ customer_id: REFERRER, points: 150 }]);

    await app.close();
  });

  it("performs no enqueue at all when no enqueuer is wired (Admin token absent)", async () => {
    const state = makeClaimState();
    const db = new ClaimFakeDb(state);
    const app = await buildClaimApp(db, FRIEND);

    const res = await claim(app, CODE);

    expect(res.statusCode).toBe(200);
    expect(state.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(1);

    await app.close();
  });
});

/* -------------------------------------------------------------------------- */
/* orders/paid — the +250 first-purchase reward credits the REFERRER.          */
/* -------------------------------------------------------------------------- */

/** Minimal order-earning fake: every order is the buyer's first paid purchase. */
class OrderFakeDb implements Queryable, Transactor {
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
    if (text.includes("INSERT INTO customers")) {
      return ok([{ id: "buyer-uuid", tier: "bronze", lifetime_spend_gbp: "0.00" }]);
    }
    if (text.includes("FOR UPDATE")) {
      return ok([{ id: "buyer-uuid", tier: "bronze", lifetime_spend_gbp: "0.00" }]);
    }
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
          created_at: new Date("2026-07-26T13:03:32.388Z"),
        },
      ]);
    }
    return ok([]);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const orderJob = (): WebhookJob =>
  ({
    webhookId: "wh-order-35",
    topic: ORDERS_PAID_TOPIC,
    shopDomain: "athoor-loyalty-staging.myshopify.com",
    payload: {
      id: 6_600_000_003,
      current_subtotal_price: "100.00",
      customer: { id: 9_037_455_425_735 },
    },
  }) as unknown as WebhookJob;

describe("orders/paid refreshes BOTH the buyer's and the referrer's cache (task 35)", () => {
  it("enqueues one refresh for the buyer and one for the credited referrer", async () => {
    const db = new OrderFakeDb();
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    await dispatchWebhookJob(orderJob(), {
      repo: new LedgerRepository(db),
      transactor: db,
      metafieldEnqueuer: enqueuer,
      // The engine awarded the referrer +250 inside the order transaction.
      advanceReferralStage: async () => ({ referrerId: REFERRER }),
    });

    expect(enqueuer.jobs).toEqual([{ customerId: "buyer-uuid" }, { customerId: REFERRER }]);
  });

  it("enqueues for the buyer only when the referral advance awarded nothing", async () => {
    const db = new OrderFakeDb();
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    await dispatchWebhookJob(orderJob(), {
      repo: new LedgerRepository(db),
      transactor: db,
      metafieldEnqueuer: enqueuer,
      // no_referral / not_first_purchase / already_rewarded all report null.
      advanceReferralStage: async () => null,
    });

    expect(enqueuer.jobs).toEqual([{ customerId: "buyer-uuid" }]);
  });

  it("does not fail the committed earning when the enqueue throws", async () => {
    const db = new OrderFakeDb();
    const enqueuer = new ThrowingEnqueuer();
    const seen: Array<{ customerId: string }> = [];

    await expect(
      dispatchWebhookJob(orderJob(), {
        repo: new LedgerRepository(db),
        transactor: db,
        metafieldEnqueuer: enqueuer,
        advanceReferralStage: async () => ({ referrerId: REFERRER }),
        onCacheEnqueueError: (_err, customerId) => seen.push({ customerId }),
      }),
    ).resolves.toBeUndefined();

    // Both enqueues were attempted and both failures were reported, not swallowed
    // silently — and a failed BUYER enqueue never suppressed the REFERRER's.
    expect(enqueuer.attempts).toEqual([{ customerId: "buyer-uuid" }, { customerId: REFERRER }]);
    expect(seen).toEqual([{ customerId: "buyer-uuid" }, { customerId: REFERRER }]);
  });

  it("performs no enqueue when no enqueuer is wired, award or not", async () => {
    const db = new OrderFakeDb();

    await expect(
      dispatchWebhookJob(orderJob(), {
        repo: new LedgerRepository(db),
        transactor: db,
        advanceReferralStage: async () => ({ referrerId: REFERRER }),
      }),
    ).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Redemption — the display-cache enqueue must not fail a committed spend.     */
/* -------------------------------------------------------------------------- */

/**
 * `redeem.ts` documented its cache enqueue as best-effort but did not guard it,
 * so a pg-boss blip would have surfaced as a FAILED redemption to a member whose
 * points had already been spent and whose discount-code job was already queued —
 * the worst possible outcome. Found while implementing task 35; fixed with the
 * same contract as the referral and webhook paths.
 *
 * The asymmetry is deliberate and is asserted here too: the DISCOUNT-CODE enqueue
 * stays unguarded, because without it no code is ever minted for a committed
 * spend and the failure must reach the compensating-reversal path (Req 3.9).
 */
describe("redemption cache enqueue is guarded (task 35)", () => {
  it("exposes onCacheEnqueueError and swallows a failed cache enqueue", async () => {
    const redeem = await import("../redemption/redeem.js");
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../redemption/redeem.ts", import.meta.url), "utf8"),
    );

    // The metafield enqueue is inside a try/catch that reports via the hook.
    expect(source).toMatch(
      /try \{\s*await deps\.metafieldEnqueuer\.enqueueMetafieldCache\(\{ customerId \}\);\s*\} catch \(err\) \{\s*deps\.onCacheEnqueueError\?\.\(err, customerId\);/,
    );
    // The discount-code enqueue is deliberately NOT wrapped.
    expect(source).toMatch(/^\s*await deps\.enqueuer\.enqueueDiscountCode\(/m);
    expect(redeem).toBeDefined();
  });
});
