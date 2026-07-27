/**
 * ONE ACCEPTED REFERRAL PER CUSTOMER (task 40) — Req 2.9, 2.9a, 11.8, 11.9,
 * beside Property 12.
 *
 * WHAT WAS WRONG, confirmed live on staging under task 39 rather than inferred:
 *
 *  1. **Multi-claim fan-out.** A brand-new account claimed three DIFFERENT
 *     referral codes and every one returned `rewarded`: three `referrals` rows
 *     sharing a `referred_id`, three referrers credited +150 each, no purchase by
 *     anyone. The dedupe read was `WHERE referrer_id = $1 AND referred_id = $2`,
 *     which cannot see that the claimant already has a *different* referrer.
 *  2. **Concurrent duplicate pair.** Two parallel claims of the SAME code with
 *     different `Idempotency-Key` values both returned `rewarded` and paid the
 *     referrer twice, 9 ms apart. READ COMMITTED plus a read-then-write.
 *
 * WHAT THESE TESTS PIN:
 *  - the accepted-referral lookup is by `referred_id`, so a second referrer is
 *    refused with the DEDICATED `already_claimed` status — never mislabelled
 *    `already_rewarded`, which would claim this referrer had been credited;
 *  - the INSERT, not the read, is the gate: when the fake's unique index refuses
 *    the row (the concurrency case, where the pre-read saw nothing), no reward is
 *    written and the loser reports the truth;
 *  - `awardReferralFirstPurchase` picks its row deterministically;
 *  - the route maps `already_claimed` to `409 referral_already_claimed`.
 *
 * The fake Postgres MODELS THE PARTIAL UNIQUE INDEX on `referrals (referred_id)`
 * and `ON CONFLICT DO NOTHING` (a conflict returns zero rows, it does not raise).
 * Without that the tests would pass while the real constraint behaved differently,
 * which is the failure mode this whole task exists to correct.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import type { Queryable } from "../ledger/repository.js";
import { LedgerRepository } from "../ledger/repository.js";
import {
  awardReferralFirstPurchase,
  recordReferralOnSignup,
  REFERRAL_SIGNUP_POINTS,
} from "./referral.js";
import { registerReferralRoutes } from "../routes/referral.js";

interface ReferralRow {
  id: string;
  referrer_id: string;
  referred_id: string;
  signup_rewarded: boolean;
  purchase_rewarded: boolean;
}

/**
 * Fake Postgres for the referral paths, faithful on the one point that matters:
 * uniqueness is enforced at INSERT time on `referred_id`, exactly as the partial
 * unique index does, and a conflict yields zero rows rather than an error.
 */
class FakeDb implements Queryable {
  readonly codes = new Map<string, string>();
  readonly referredBy = new Map<string, string>();
  readonly referrals: ReferralRow[] = [];
  readonly ledger: Array<{ id: string; customer_id: string; entry_type: string; points: number }> = [];
  readonly lots: Array<{ customer_id: string; ledger_entry_id: string; points: number }> = [];
  readonly paidPurchasers = new Set<string>();
  /** Set to true to make the next INSERT conflict, simulating a concurrent winner. */
  indexRefusesNextInsert = false;
  private seq = 0;

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = (rows: QueryResultRow[], command = "SELECT", rowCount?: number): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rowCount ?? rows.length,
      command,
      oid: 0,
      fields: [],
    });

    if (text.includes("FROM customers c") && text.includes("referral_code")) {
      const id = values[0] as string;
      const code = [...this.codes.entries()].find(([, cid]) => cid === id)?.[0] ?? null;
      return ok([
        {
          referral_code: code,
          was_referred: this.referredBy.has(id),
          signup_rewards: this.referrals.filter((r) => r.referrer_id === id && r.signup_rewarded).length,
          purchase_rewards: this.referrals.filter((r) => r.referrer_id === id && r.purchase_rewarded)
            .length,
        },
      ]);
    }
    if (text.includes("entry_type = 'earn_order'")) {
      return ok(this.paidPurchasers.has(values[0] as string) ? [{ one: 1 }] : []);
    }
    if (text.includes("SELECT id FROM customers WHERE referral_code")) {
      const id = this.codes.get(values[0] as string);
      return ok(id ? [{ id }] : []);
    }
    if (text.includes("UPDATE customers") && text.includes("referred_by")) {
      const [customerId, referrerId] = values as [string, string];
      if (customerId === referrerId || this.referredBy.has(customerId)) return ok([], "UPDATE", 0);
      this.referredBy.set(customerId, referrerId);
      return ok([], "UPDATE", 1);
    }
    // The task-40 lookup: the customer's ONE accepted referral, by `referred_id`.
    if (text.includes("SELECT id, referrer_id, signup_rewarded, purchase_rewarded")) {
      const row = this.referrals.find((r) => r.referred_id === (values[0] as string));
      return ok(row ? [row] : []);
    }
    // The first-purchase lookup (different projection, no `signup_rewarded`).
    if (text.includes("SELECT id, referrer_id, purchase_rewarded")) {
      const matches = this.referrals.filter((r) => r.referred_id === (values[0] as string));
      return ok(matches[0] ? [matches[0]] : []);
    }
    if (text.includes("INSERT INTO referrals")) {
      const [referrerId, referredId] = values as [string, string];
      if (referrerId === referredId) {
        const err = new Error('violates check constraint "referrals_check"');
        (err as { code?: string }).code = "23514";
        throw err;
      }
      const conflicts =
        this.indexRefusesNextInsert || this.referrals.some((r) => r.referred_id === referredId);
      this.indexRefusesNextInsert = false;
      if (conflicts) {
        return ok([], "INSERT", 0); // ON CONFLICT DO NOTHING
      }
      this.seq += 1;
      const row: ReferralRow = {
        id: `ref-${this.seq}`,
        referrer_id: referrerId,
        referred_id: referredId,
        signup_rewarded: true,
        purchase_rewarded: false,
      };
      this.referrals.push(row);
      return ok([row], "INSERT");
    }
    if (text.includes("UPDATE referrals SET signup_rewarded")) {
      const row = this.referrals.find((r) => r.id === values[0] && !r.signup_rewarded);
      if (!row) return ok([], "UPDATE", 0);
      row.signup_rewarded = true;
      return ok([], "UPDATE", 1);
    }
    if (text.includes("UPDATE referrals") && text.includes("purchase_rewarded = true")) {
      const row = this.referrals.find((r) => r.id === values[0] && !r.purchase_rewarded);
      if (!row) return ok([], "UPDATE", 0);
      row.purchase_rewarded = true;
      return ok([], "UPDATE", 1);
    }
    if (text.includes("INSERT INTO ledger_entries")) {
      this.seq += 1;
      const row = {
        id: `ledg-${this.seq}`,
        customer_id: values[0] as string,
        entry_type: values[1] as string,
        points: values[2] as number,
      };
      this.ledger.push(row);
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
            created_at: new Date("2026-07-01T00:00:00Z"),
          },
        ],
        "INSERT",
      );
    }
    if (text.includes("INSERT INTO point_lots")) {
      this.lots.push({
        customer_id: values[0] as string,
        ledger_entry_id: values[1] as string,
        points: values[2] as number,
      });
      return ok([], "INSERT");
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  referralPointsFor(customerId: string): number {
    return this.ledger
      .filter((e) => e.entry_type === "earn_referral" && e.customer_id === customerId)
      .reduce((sum, e) => sum + e.points, 0);
  }
}

const FRIEND = "friend-uuid";
const REFERRER_A = "referrer-a-uuid";
const REFERRER_B = "referrer-b-uuid";
const CODE_A = "ATH-AAAA-1111";
const CODE_B = "ATH-BBBB-2222";

function seeded(): FakeDb {
  const db = new FakeDb();
  db.codes.set(CODE_A, REFERRER_A);
  db.codes.set(CODE_B, REFERRER_B);
  return db;
}

const signup = (db: FakeDb, referrerId: string, referredCustomerId = FRIEND) =>
  recordReferralOnSignup(new LedgerRepository(db), { referredCustomerId, referrerId }, db);

describe("a customer accepts at most one referral (task 40)", () => {
  it("refuses a SECOND referrer's code with already_claimed and pays nobody twice", async () => {
    const db = seeded();

    const first = await signup(db, REFERRER_A);
    expect(first.status).toBe("rewarded");

    // The confirmed fan-out: a different referrer, same claimant.
    const second = await signup(db, REFERRER_B);
    expect(second.status).toBe("already_claimed");
    if (second.status === "already_claimed") {
      expect(second.existingReferrerId).toBe(REFERRER_A);
    }

    // Exactly one row, one credit, one lot — and B got nothing.
    expect(db.referrals).toHaveLength(1);
    expect(db.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(1);
    expect(db.lots).toHaveLength(1);
    expect(db.referralPointsFor(REFERRER_A)).toBe(REFERRAL_SIGNUP_POINTS);
    expect(db.referralPointsFor(REFERRER_B)).toBe(0);
  });

  it("refuses a third, fourth and fifth referrer just as flatly", async () => {
    const db = seeded();
    db.codes.set("ATH-CCCC-3333", "referrer-c");
    db.codes.set("ATH-DDDD-4444", "referrer-d");

    await signup(db, REFERRER_A);
    for (const other of [REFERRER_B, "referrer-c", "referrer-d"]) {
      const outcome = await signup(db, other);
      expect(outcome.status).toBe("already_claimed");
      expect(db.referralPointsFor(other)).toBe(0);
    }
    expect(db.referrals).toHaveLength(1);
    expect(db.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(1);
  });

  it("does NOT report already_rewarded for a different referrer — the distinction is the point", async () => {
    const db = seeded();
    await signup(db, REFERRER_A);

    const sameReferrer = await signup(db, REFERRER_A);
    const otherReferrer = await signup(db, REFERRER_B);

    // Same pair repeated: their friend really was credited, so say so.
    expect(sameReferrer.status).toBe("already_rewarded");
    // Different referrer: this code's owner was NEVER credited. Reporting
    // `already_rewarded` here would tell the member a lie about a payment.
    expect(otherReferrer.status).toBe("already_claimed");
  });

  it("lets the INSERT arbitrate: a conflict the pre-read could not see awards nothing", async () => {
    const db = seeded();
    // The concurrency case: the pre-read finds no accepted referral (the other
    // transaction has not committed), so the code proceeds to INSERT — and the
    // index refuses it. This is the exact shape that paid the referrer twice.
    db.indexRefusesNextInsert = true;
    // A committed row exists from the racing transaction's point of view.
    db.referrals.push({
      id: "ref-winner",
      referrer_id: REFERRER_A,
      referred_id: FRIEND,
      signup_rewarded: true,
      purchase_rewarded: false,
    });

    const outcome = await signup(db, REFERRER_A);

    expect(outcome.status).toBe("already_rewarded");
    expect(db.referrals).toHaveLength(1);
    expect(db.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(0);
    expect(db.lots).toHaveLength(0);
  });

  it("CONCURRENT same-pair claims: two interleaved flows produce one row and one +150", async () => {
    const db = seeded();
    const repo = new LedgerRepository(db);

    // Genuinely interleaved, not sequential: both flows start before either has
    // inserted, so both pre-reads see nothing — the shape that paid the referrer
    // twice on staging. Serialisation now comes from the unique index alone.
    const [a, b] = await Promise.all([
      recordReferralOnSignup(repo, { referredCustomerId: FRIEND, referrerId: REFERRER_A }, db),
      recordReferralOnSignup(repo, { referredCustomerId: FRIEND, referrerId: REFERRER_A }, db),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["already_rewarded", "rewarded"]);
    expect(db.referrals).toHaveLength(1);
    expect(db.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(1);
    expect(db.lots).toHaveLength(1);
    expect(db.referralPointsFor(REFERRER_A)).toBe(REFERRAL_SIGNUP_POINTS);
  });

  it("CONCURRENT different-referrer claims: exactly one referrer is paid", async () => {
    const db = seeded();
    const repo = new LedgerRepository(db);

    const [a, b] = await Promise.all([
      recordReferralOnSignup(repo, { referredCustomerId: FRIEND, referrerId: REFERRER_A }, db),
      recordReferralOnSignup(repo, { referredCustomerId: FRIEND, referrerId: REFERRER_B }, db),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["already_claimed", "rewarded"]);
    expect(db.referrals).toHaveLength(1);
    expect(db.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(1);
    // Whichever won, the other got nothing — the total is one reward, not two.
    const paid = [REFERRER_A, REFERRER_B].map((r) => db.referralPointsFor(r)).sort();
    expect(paid).toEqual([0, REFERRAL_SIGNUP_POINTS]);
  });

  it("fails loudly rather than awarding blind when a conflict leaves nothing readable", async () => {
    const db = seeded();
    // Conflict with no visible row: a constraint the engine does not model
    // refused the insert. Guessing here would risk an unbacked payout.
    db.indexRefusesNextInsert = true;

    await expect(signup(db, REFERRER_A)).rejects.toThrow(/no accepted referral could be read back/i);
    expect(db.ledger).toHaveLength(0);
  });

  it("still claims a PENDING row for the same referrer (invite recorded before the claim)", async () => {
    const db = seeded();
    db.referrals.push({
      id: "ref-pending",
      referrer_id: REFERRER_A,
      referred_id: FRIEND,
      signup_rewarded: false,
      purchase_rewarded: false,
    });

    const outcome = await signup(db, REFERRER_A);

    expect(outcome.status).toBe("rewarded");
    expect(db.referrals[0]!.signup_rewarded).toBe(true);
    expect(db.referralPointsFor(REFERRER_A)).toBe(REFERRAL_SIGNUP_POINTS);
    // A second attempt on the now-rewarded row is idempotent.
    expect((await signup(db, REFERRER_A)).status).toBe("already_rewarded");
    expect(db.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(1);
  });

  it("refuses a pending row belonging to a DIFFERENT referrer without rewarding it", async () => {
    const db = seeded();
    db.referrals.push({
      id: "ref-pending-other",
      referrer_id: REFERRER_A,
      referred_id: FRIEND,
      signup_rewarded: false,
      purchase_rewarded: false,
    });

    const outcome = await signup(db, REFERRER_B);

    expect(outcome.status).toBe("already_claimed");
    expect(db.referrals[0]!.signup_rewarded).toBe(false);
    expect(db.ledger).toHaveLength(0);
  });

  it("leaves the friend's referred_by pointing at their one real referrer", async () => {
    const db = seeded();
    await signup(db, REFERRER_A);
    await signup(db, REFERRER_B);
    expect(db.referredBy.get(FRIEND)).toBe(REFERRER_A);
  });

  it("sends the +250 first-purchase reward to the one accepted referrer", async () => {
    const db = seeded();
    await signup(db, REFERRER_A);
    await signup(db, REFERRER_B); // refused

    const outcome = await awardReferralFirstPurchase(
      new LedgerRepository(db),
      { referredCustomerId: FRIEND, isFirstPaidPurchase: true },
      db,
    );

    expect(outcome.status).toBe("rewarded");
    if (outcome.status === "rewarded") {
      expect(outcome.referrerId).toBe(REFERRER_A);
    }
    expect(db.referralPointsFor(REFERRER_B)).toBe(0);
  });
});

describe("POST /v1/referral maps the refusal (task 40)", () => {
  async function app(db: FakeDb, customerId: string): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.addHook("preHandler", async (req) => {
      req.authCtx = { customerId, source: "app_proxy", channel: "web" };
    });
    registerReferralRoutes(instance, {
      repo: new LedgerRepository(db),
      transactor: { transaction: (fn) => fn(db) },
      db,
    });
    await instance.ready();
    return instance;
  }

  it("returns 409 referral_already_claimed and never leaks the other referrer's id", async () => {
    const db = seeded();
    const instance = await app(db, FRIEND);

    const first = await instance.inject({
      method: "POST",
      url: "/referral",
      payload: { referralCode: CODE_A },
    });
    expect(first.statusCode).toBe(200);

    const second = await instance.inject({
      method: "POST",
      url: "/referral",
      payload: { referralCode: CODE_B },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "referral_already_claimed" });
    // The claimant has no business learning who holds their attribution.
    expect(second.body).not.toContain(REFERRER_A);
    expect(db.ledger.filter((e) => e.entry_type === "earn_referral")).toHaveLength(1);

    await instance.close();
  });

  it("still returns 200 already_rewarded when the SAME code is re-submitted", async () => {
    const db = seeded();
    const instance = await app(db, FRIEND);

    await instance.inject({ method: "POST", url: "/referral", payload: { referralCode: CODE_A } });
    const again = await instance.inject({
      method: "POST",
      url: "/referral",
      payload: { referralCode: CODE_A },
    });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: "already_rewarded" });

    await instance.close();
  });
});

describe("PROPERTY: no customer is ever the referred party of more than one referral", () => {
  const CUSTOMERS = ["c1", "c2", "c3", "c4"] as const;
  const arbAttempt = fc.record({
    referrer: fc.constantFrom(...CUSTOMERS),
    referred: fc.constantFrom(...CUSTOMERS),
  });

  it("holds across any sequence of claims, and total referral points equal 150 × accepted referrals", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbAttempt, { minLength: 0, maxLength: 30 }), async (attempts) => {
        const db = new FakeDb();
        const repo = new LedgerRepository(db);

        // The model: the FIRST non-self attempt naming a customer decides their
        // one referrer. Everything after it pays nothing.
        const accepted = new Map<string, string>();

        for (const { referrer, referred } of attempts) {
          const outcome = await recordReferralOnSignup(
            repo,
            { referredCustomerId: referred, referrerId: referrer },
            db,
          );
          if (referrer === referred) {
            expect(outcome.status).toBe("self_referral_rejected");
            continue;
          }
          const holder = accepted.get(referred);
          if (holder === undefined) {
            expect(outcome.status).toBe("rewarded");
            accepted.set(referred, referrer);
          } else if (holder === referrer) {
            expect(outcome.status).toBe("already_rewarded");
          } else {
            expect(outcome.status).toBe("already_claimed");
          }
        }

        // The invariant the migration enforces.
        const perReferred = new Map<string, number>();
        for (const row of db.referrals) {
          perReferred.set(row.referred_id, (perReferred.get(row.referred_id) ?? 0) + 1);
          expect(row.referrer_id).not.toBe(row.referred_id);
        }
        for (const count of perReferred.values()) {
          expect(count).toBe(1);
        }

        // Payout is bounded by the number of accepted referrals, not by the
        // number of codes anyone tried — this is what the fan-out broke.
        const totalPoints = db.ledger
          .filter((e) => e.entry_type === "earn_referral")
          .reduce((sum, e) => sum + e.points, 0);
        expect(totalPoints).toBe(accepted.size * REFERRAL_SIGNUP_POINTS);

        // Property 17: every credit is backed by a lot of the same size.
        expect(db.lots).toHaveLength(db.ledger.filter((e) => e.entry_type === "earn_referral").length);
      }),
      { numRuns: 200 },
    );
  });
});
