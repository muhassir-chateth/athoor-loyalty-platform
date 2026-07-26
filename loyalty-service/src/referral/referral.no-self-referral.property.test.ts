/**
 * Property-based test for the no-self-referral-reward guarantee (task 11.2).
 *
 * **Property 12 (No self-referral reward):** `referrer != referred` — a customer
 * can never earn referral points from their own signup. For every possible
 * referral signup attempt, whenever the referrer and the referred friend are the
 * same customer the attempt is rejected: no `referrals` row is created, no
 * `earn_referral` ledger entry is ever appended, and the customer's balance is
 * left completely unchanged. Distinct (legitimate) referrals continue to award
 * the referrer exactly one +150 signup earning.
 *
 * **Validates: Requirements 11.8**
 *
 * This exercises {@link recordReferralOnSignup} through fast-check with arbitrary
 * referral scenarios that deliberately mix self-referral attempts
 * (`referrer === referred`) with legitimate distinct referrals and duplicates.
 * The invariant asserted across every generated sequence is:
 *
 *   - no self-referral ever produces a `referrals` row or an `earn_referral`
 *     entry (Property 12 / Req 11.8);
 *   - the total signup referral points credited to any customer equal
 *     `150 × (number of DISTINCT friends they legitimately referred)`, so no
 *     customer's own signup can inflate their own balance;
 *   - a customer's own balance is never credited by an event whose referred
 *     friend is that same customer.
 *
 * SAFETY: no live/production system is touched. A fully self-contained in-memory
 * fake {@link Queryable} routes exactly the statements the referral flow issues
 * (the customers read/update, the `referrals` lookup/insert/update, and the
 * ledger append), and it enforces the DB `CHECK (referrer_id <> referred_id)` on
 * insert so the property runs against the same invariant the schema guarantees.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import {
  recordReferralOnSignup,
  REFERRAL_SIGNUP_POINTS,
  REFERRAL_SIGNUP_REASON,
} from "./referral.js";

interface CustomerStore {
  id: string;
  referral_code: string | null;
  referred_by: string | null;
}

interface ReferralStore {
  id: string;
  referrer_id: string;
  referred_id: string | null;
  referred_email: string | null;
  signup_rewarded: boolean;
  purchase_rewarded: boolean;
}

interface LedgerStore {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  source_event_id: string | null;
}

/**
 * A fully self-contained in-memory fake Postgres understanding exactly the
 * statements the signup referral flow issues. It enforces the self-referral DB
 * `CHECK (referrer_id <> referred_id)` on insert so the property exercises the
 * same backstop the real schema provides.
 */
class FakeDb implements Queryable {
  readonly customers = new Map<string, CustomerStore>();
  readonly referrals: ReferralStore[] = [];
  readonly ledger: LedgerStore[] = [];
  /** Point_Lots backing each referral credit (Property 17). */
  readonly lots: Array<{ customer_id: string; ledger_entry_id: string; points: number }> = [];
  private seq = 0;

  seedCustomer(id: string): void {
    if (!this.customers.has(id)) {
      this.customers.set(id, { id, referral_code: null, referred_by: null });
    }
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = queryText.trim();

    if (q.startsWith("UPDATE customers") && q.includes("referred_by =")) {
      return this.setReferredBy<R>(values);
    }
    if (q.startsWith("SELECT id, signup_rewarded, purchase_rewarded")) {
      return this.findByPair<R>(values);
    }
    if (q.startsWith("INSERT INTO referrals")) {
      return this.insertReferral<R>(values);
    }
    if (q.startsWith("UPDATE referrals SET signup_rewarded")) {
      const row = this.referrals.find((r) => r.id === values[0]);
      if (row) row.signup_rewarded = true;
      return this.result<R>([], row ? 1 : 0);
    }
    if (q.startsWith("INSERT INTO ledger_entries")) {
      return this.appendLedger<R>(values);
    }
    if (q.startsWith("INSERT INTO point_lots")) {
      const [customer_id, ledger_entry_id, points] = values as [string, string, number];
      this.lots.push({ customer_id, ledger_entry_id, points });
      return this.result<R>([]);
    }
    throw new Error(`Unexpected query in FakeDb: ${q}`);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(12, "0")}`;
  }

  private setReferredBy<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [id, referrer] = values as [string, string];
    const c = this.customers.get(id);
    // The UPDATE is guarded so it never sets referred_by to self and only once.
    if (c && c.referred_by === null && id !== referrer) {
      c.referred_by = referrer;
      return this.result<R>([], 1);
    }
    return this.result<R>([], 0);
  }

  private findByPair<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [referrer, referred] = values as [string, string];
    const row = this.referrals.find((r) => r.referrer_id === referrer && r.referred_id === referred);
    return this.result<R>(
      row
        ? [
            {
              id: row.id,
              signup_rewarded: row.signup_rewarded,
              purchase_rewarded: row.purchase_rewarded,
            } as unknown as R,
          ]
        : [],
    );
  }

  private insertReferral<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [referrer, referred, email] = values as [string, string, string | null];
    // Enforce the DB CHECK (referrer_id <> referred_id) — a self-referral must
    // never reach an INSERT, but if it somehow did the schema would reject it.
    if (referrer === referred) {
      const err = new Error('new row violates check constraint "referrals_check"');
      (err as { code?: string }).code = "23514";
      throw err;
    }
    const row: ReferralStore = {
      id: this.nextId("ref"),
      referrer_id: referrer,
      referred_id: referred,
      referred_email: email ?? null,
      signup_rewarded: true,
      purchase_rewarded: false,
    };
    this.referrals.push(row);
    return this.result<R>([
      {
        id: row.id,
        signup_rewarded: row.signup_rewarded,
        purchase_rewarded: row.purchase_rewarded,
      } as unknown as R,
    ]);
  }

  private appendLedger<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, entryType, points, reason, , , , sourceEventId] = values;
    const row: LedgerStore = {
      id: this.nextId("ledg"),
      customer_id: customerId as string,
      entry_type: entryType as string,
      points: points as number,
      reason: reason as string,
      source_event_id: (sourceEventId as string | null) ?? null,
    };
    this.ledger.push(row);
    return this.result<R>([
      {
        id: row.id,
        customer_id: row.customer_id,
        entry_type: row.entry_type,
        points: String(row.points), // pg returns BIGINT as string
        reason: row.reason,
        order_reference: null,
        point_lot_id: null,
        redemption_id: null,
        source_event_id: row.source_event_id,
        created_at: new Date("2025-01-01T00:00:00.000Z"),
      } as unknown as R,
    ]);
  }

  private result<R extends QueryResultRow>(rows: R[], rowCount = rows.length): QueryResult<R> {
    return { rows, rowCount, command: "SELECT", oid: 0, fields: [] };
  }

  /** Sum of a customer's referral-signup earnings (their balance from referrals). */
  signupPointsFor(customerId: string): number {
    return this.ledger
      .filter(
        (r) =>
          r.customer_id === customerId &&
          r.entry_type === "earn_referral" &&
          r.reason === REFERRAL_SIGNUP_REASON,
      )
      .reduce((sum, r) => sum + r.points, 0);
  }
}

/** A pool of candidate customer ids the arbitraries draw referrer/referred from. */
const CUSTOMER_IDS = ["c1", "c2", "c3", "c4", "c5"] as const;
const arbCustomer = fc.constantFrom(...CUSTOMER_IDS);

/** A single referral signup attempt: referrer and referred may be equal. */
const arbSignupAttempt = fc.record({
  referrer: arbCustomer,
  referred: arbCustomer,
});

describe("Property 12 — no self-referral reward (Req 11.8)", () => {
  it("a single self-referral is always rejected with no row, no earning, no balance change", async () => {
    await fc.assert(
      fc.asyncProperty(arbCustomer, async (self) => {
        const db = new FakeDb();
        const repo = new LedgerRepository(db);
        db.seedCustomer(self);

        const outcome = await recordReferralOnSignup(
          repo,
          { referredCustomerId: self, referrerId: self, sourceEventId: "wh-self" },
          db,
        );

        expect(outcome.status).toBe("self_referral_rejected");
        // No referrals row, no ledger entry, balance untouched (Property 12).
        expect(db.referrals).toHaveLength(0);
        expect(db.ledger).toHaveLength(0);
        expect(db.signupPointsFor(self)).toBe(0);
        expect(db.customers.get(self)?.referred_by).toBeNull();
      }),
    );
  });

  it("distinct referrals still award the referrer exactly one +150 signup earning", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(arbCustomer, arbCustomer).filter(([a, b]) => a !== b),
        async ([referrer, referred]) => {
          const db = new FakeDb();
          const repo = new LedgerRepository(db);
          db.seedCustomer(referrer);
          db.seedCustomer(referred);

          const outcome = await recordReferralOnSignup(
            repo,
            { referredCustomerId: referred, referrerId: referrer, sourceEventId: "wh-ok" },
            db,
          );

          expect(outcome.status).toBe("rewarded");
          // Exactly one +150 to the referrer, and only the referrer.
          expect(db.signupPointsFor(referrer)).toBe(REFERRAL_SIGNUP_POINTS);
          expect(db.signupPointsFor(referrer)).toBe(150);
          expect(db.signupPointsFor(referred)).toBe(0);
          expect(db.customers.get(referred)?.referred_by).toBe(referrer);
        },
      ),
    );
  });

  it(
    "across any mixed sequence of self and distinct attempts, self-referrals never earn and " +
      "signup points equal 150× the DISTINCT friends legitimately referred",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(arbSignupAttempt, { minLength: 0, maxLength: 40 }), async (attempts) => {
          const db = new FakeDb();
          const repo = new LedgerRepository(db);
          for (const id of CUSTOMER_IDS) db.seedCustomer(id);

          // Model the expected legitimate referrals: a referrer earns once per
          // DISTINCT non-self friend they refer (the flow is idempotent per pair
          // and self-referrals earn nothing).
          const distinctFriends = new Map<string, Set<string>>();

          let eventIndex = 0;
          for (const { referrer, referred } of attempts) {
            const outcome = await recordReferralOnSignup(
              repo,
              { referredCustomerId: referred, referrerId: referrer, sourceEventId: `wh-${eventIndex}` },
              db,
            );
            eventIndex += 1;

            if (referrer === referred) {
              // Property 12: a self-referral is ALWAYS rejected outright.
              expect(outcome.status).toBe("self_referral_rejected");
            } else {
              const friends = distinctFriends.get(referrer) ?? new Set<string>();
              friends.add(referred);
              distinctFriends.set(referrer, friends);
            }
          }

          // No self-referral ever created a referrals row: every recorded row is
          // between two DISTINCT customers.
          for (const row of db.referrals) {
            expect(row.referrer_id).not.toBe(row.referred_id);
          }

          // A customer's own signup can never credit their own balance: the
          // signup points a customer holds equal 150× the DISTINCT friends they
          // legitimately referred — self-referrals contribute nothing.
          for (const id of CUSTOMER_IDS) {
            const expected = (distinctFriends.get(id)?.size ?? 0) * REFERRAL_SIGNUP_POINTS;
            expect(db.signupPointsFor(id)).toBe(expected);
          }

          // Every earn_referral entry is attributable to a real referrals row
          // whose referred friend is NOT the credited customer (no self-earning).
          for (const entry of db.ledger.filter((e) => e.entry_type === "earn_referral")) {
            const backing = db.referrals.filter((r) => r.referrer_id === entry.customer_id);
            expect(backing.length).toBeGreaterThan(0);
            for (const row of backing) {
              expect(row.referred_id).not.toBe(entry.customer_id);
            }
          }
        }),
      );
    },
  );
});
