/**
 * Unit tests for referral code, staged rewards, and self-referral guards
 * (task 11.1).
 *
 * No live/production database is touched. A fake {@link Queryable} backed by
 * tiny in-memory stores routes the statements the referral flows issue — the
 * customers read/update, the `referrals` lookup/insert/update, and the ledger
 * append (via {@link LedgerRepository}) — so the referral contract is verified
 * without any Postgres or Shopify Admin API:
 *
 *   - +150 to the referrer on the friend's signup, exactly once (Req 2.9);
 *   - +250 to the referrer on the friend's first paid purchase, once (Req 2.10);
 *   - NO purchase reward when the friend had a prior paid purchase (Req 11.9);
 *   - a self-referral is rejected with no `referrals` row and no earning
 *     (Req 11.8, Property 12).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import {
  assignReferralCode,
  awardReferralFirstPurchase,
  generateReferralCode,
  recordReferralOnSignup,
  resolveReferrerByCode,
  REFERRAL_PURCHASE_POINTS,
  REFERRAL_PURCHASE_REASON,
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
 * An in-memory fake Postgres understanding exactly the statements the referral
 * flows issue. Enforces the self-referral DB CHECK on insert so tests exercise
 * the same invariant the schema guarantees.
 */
class FakeDb implements Queryable {
  readonly customers = new Map<string, CustomerStore>();
  readonly referrals: ReferralStore[] = [];
  readonly ledger: LedgerStore[] = [];
  /** Point_Lots backing each referral credit (Property 17). */
  readonly lots: Array<{
    customer_id: string;
    ledger_entry_id: string;
    points: number;
    expires_at: Date | null;
  }> = [];
  private seq = 0;

  seedCustomer(id: string, opts: Partial<CustomerStore> = {}): void {
    this.customers.set(id, {
      id,
      referral_code: opts.referral_code ?? null,
      referred_by: opts.referred_by ?? null,
    });
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = queryText.trim();

    if (q.startsWith("SELECT referral_code FROM customers")) {
      const c = this.customers.get(values[0] as string);
      return this.result<R>(c ? [{ referral_code: c.referral_code } as unknown as R] : []);
    }
    if (q.startsWith("UPDATE customers") && q.includes("referral_code =")) {
      return this.assignCode<R>(values);
    }
    if (q.startsWith("SELECT id FROM customers WHERE referral_code")) {
      const code = values[0] as string;
      const match = [...this.customers.values()].find((c) => c.referral_code === code);
      return this.result<R>(match ? [{ id: match.id } as unknown as R] : []);
    }
    if (q.startsWith("UPDATE customers") && q.includes("referred_by =")) {
      return this.setReferredBy<R>(values);
    }
    if (q.startsWith("SELECT id, referrer_id, signup_rewarded, purchase_rewarded")) {
      return this.findAcceptedByReferred<R>(values);
    }
    if (q.startsWith("SELECT id, referrer_id, purchase_rewarded")) {
      return this.findByReferred<R>(values);
    }
    if (q.startsWith("INSERT INTO referrals")) {
      return this.insertReferral<R>(values);
    }
    if (q.startsWith("UPDATE referrals SET signup_rewarded")) {
      const row = this.referrals.find((r) => r.id === values[0]);
      if (row) row.signup_rewarded = true;
      return this.result<R>([], row ? 1 : 0);
    }
    if (q.startsWith("UPDATE referrals") && q.includes("purchase_rewarded = true")) {
      return this.claimPurchase<R>(values);
    }
    if (q.startsWith("INSERT INTO ledger_entries")) {
      return this.appendLedger<R>(values);
    }
    if (q.startsWith("INSERT INTO point_lots")) {
      const [customer_id, ledger_entry_id, points, , expires_at] = values as [
        string,
        string,
        number,
        Date,
        Date | null,
      ];
      this.lots.push({ customer_id, ledger_entry_id, points, expires_at });
      return this.result<R>([]);
    }
    throw new Error(`Unexpected query in FakeDb: ${q}`);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(12, "0")}`;
  }

  private assignCode<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [id, code] = values as [string, string];
    // Unique-violation simulation: reject if another customer holds the code.
    const clash = [...this.customers.values()].find((c) => c.referral_code === code && c.id !== id);
    if (clash) {
      const err = new Error("duplicate key value violates unique constraint");
      (err as { code?: string }).code = "23505";
      throw err;
    }
    const c = this.customers.get(id);
    if (c && c.referral_code === null) {
      c.referral_code = code;
      return this.result<R>([{ referral_code: code } as unknown as R], 1);
    }
    return this.result<R>([], 0);
  }

  private setReferredBy<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [id, referrer] = values as [string, string];
    const c = this.customers.get(id);
    if (c && c.referred_by === null && id !== referrer) {
      c.referred_by = referrer;
      return this.result<R>([], 1);
    }
    return this.result<R>([], 0);
  }

  /**
   * The task-40 lookup: this customer's ONE accepted referral, found by
   * `referred_id` rather than by the `(referrer, referred)` pair — a pair read
   * cannot see that a different referrer already holds the attribution, which is
   * the hole confirmed live on staging. Insertion order stands in for
   * `ORDER BY created_at, id`.
   */
  private findAcceptedByReferred<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const referred = values[0] as string;
    const row = this.referrals.find((r) => r.referred_id === referred);
    return this.result<R>(
      row
        ? [
            {
              id: row.id,
              referrer_id: row.referrer_id,
              signup_rewarded: row.signup_rewarded,
              purchase_rewarded: row.purchase_rewarded,
            } as unknown as R,
          ]
        : [],
    );
  }

  private findByReferred<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const referred = values[0] as string;
    const row = this.referrals.find((r) => r.referred_id === referred);
    return this.result<R>(
      row
        ? [{ id: row.id, referrer_id: row.referrer_id, purchase_rewarded: row.purchase_rewarded } as unknown as R]
        : [],
    );
  }

  private insertReferral<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [referrer, referred, email] = values as [string, string, string | null];
    // Enforce the DB CHECK (referrer_id <> referred_id).
    if (referrer === referred) {
      const err = new Error('new row violates check constraint "referrals_check"');
      (err as { code?: string }).code = "23514";
      throw err;
    }
    // Task 40: model the PARTIAL UNIQUE INDEX on `referrals (referred_id)`. The
    // statement carries `ON CONFLICT DO NOTHING`, so a conflict yields ZERO rows
    // rather than a raised error — the engine must then re-read to learn who won.
    // Modelling this in the fake is the point: without it the tests would pass
    // while the real constraint did the opposite of what they assert.
    if (referred !== null && this.referrals.some((r) => r.referred_id === referred)) {
      return this.result<R>([], 0);
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
        referrer_id: row.referrer_id,
        signup_rewarded: row.signup_rewarded,
        purchase_rewarded: row.purchase_rewarded,
      } as unknown as R,
    ]);
  }

  private claimPurchase<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const id = values[0] as string;
    const row = this.referrals.find((r) => r.id === id);
    if (row && !row.purchase_rewarded) {
      row.purchase_rewarded = true;
      return this.result<R>([], 1);
    }
    return this.result<R>([], 0);
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

  referralEntriesFor(customerId: string): LedgerStore[] {
    return this.ledger.filter((r) => r.customer_id === customerId && r.entry_type === "earn_referral");
  }
}

describe("generateReferralCode", () => {
  it("produces an ATH-XXXX-XXXX code from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(/^ATH-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });
});

describe("assignReferralCode", () => {
  it("assigns a code to a customer with none and is idempotent on replay", async () => {
    const db = new FakeDb();
    db.seedCustomer("cust-1");

    const first = await assignReferralCode(db, "cust-1", () => "ATH-AAAA-BBBB");
    expect(first).toBe("ATH-AAAA-BBBB");

    // Replay: keeps the existing code, never rotates it.
    const second = await assignReferralCode(db, "cust-1", () => "ATH-CCCC-DDDD");
    expect(second).toBe("ATH-AAAA-BBBB");
  });

  it("retries on a code collision and assigns a fresh code", async () => {
    const db = new FakeDb();
    db.seedCustomer("owner", { referral_code: "ATH-DUPE-CODE" });
    db.seedCustomer("cust-2");

    const codes = ["ATH-DUPE-CODE", "ATH-FRESH-ONE"];
    let i = 0;
    const code = await assignReferralCode(db, "cust-2", () => codes[i++] ?? "ATH-XXXX-YYYY");
    expect(code).toBe("ATH-FRESH-ONE");
  });
});

describe("resolveReferrerByCode", () => {
  it("maps an invite code to the owning customer, or null when unknown", async () => {
    const db = new FakeDb();
    db.seedCustomer("ref-1", { referral_code: "ATH-INVT-CODE" });

    expect(await resolveReferrerByCode(db, "ATH-INVT-CODE")).toBe("ref-1");
    expect(await resolveReferrerByCode(db, "ATH-NOPE-NOPE")).toBeNull();
    expect(await resolveReferrerByCode(db, null)).toBeNull();
  });
});

describe("recordReferralOnSignup: +150 to the referrer on the friend's signup (Req 2.9)", () => {
  it("credits the referrer exactly one +150 earn_referral and records the referral", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    db.seedCustomer("referrer");
    db.seedCustomer("friend");

    const outcome = await recordReferralOnSignup(
      repo,
      { referredCustomerId: "friend", referrerId: "referrer", referredEmail: "f@example.com", sourceEventId: "wh-1" },
      db,
    );

    expect(outcome.status).toBe("rewarded");
    if (outcome.status !== "rewarded") return;
    expect(outcome.entry.entryType).toBe("earn_referral");
    expect(outcome.entry.points).toBe(REFERRAL_SIGNUP_POINTS);
    expect(outcome.entry.points).toBe(150);
    expect(outcome.entry.reason).toBe(REFERRAL_SIGNUP_REASON);

    // Only the referrer is credited (Req 2.11); the friend earns nothing here.
    expect(db.referralEntriesFor("referrer")).toHaveLength(1);
    expect(db.referralEntriesFor("friend")).toHaveLength(0);
    // The referral row exists and the friend's referred_by is set.
    expect(db.referrals).toHaveLength(1);
    expect(db.customers.get("friend")?.referred_by).toBe("referrer");
  });

  it("is exactly-once: a replayed signup for the same pair credits no second +150", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    db.seedCustomer("referrer");
    db.seedCustomer("friend");

    const first = await recordReferralOnSignup(repo, { referredCustomerId: "friend", referrerId: "referrer" }, db);
    expect(first.status).toBe("rewarded");

    const replay = await recordReferralOnSignup(repo, { referredCustomerId: "friend", referrerId: "referrer" }, db);
    expect(replay.status).toBe("already_rewarded");

    expect(db.referralEntriesFor("referrer")).toHaveLength(1);
    expect(db.referrals).toHaveLength(1);
  });

  it("does nothing when the friend has no referrer", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    db.seedCustomer("friend");

    const outcome = await recordReferralOnSignup(repo, { referredCustomerId: "friend", referrerId: null }, db);

    expect(outcome.status).toBe("no_referrer");
    expect(db.referrals).toHaveLength(0);
    expect(db.ledger).toHaveLength(0);
  });
});

describe("recordReferralOnSignup: self-referral is rejected with no earning (Req 11.8, Property 12)", () => {
  it("creates no referrals row and no earning when referrer === referred", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    db.seedCustomer("self");

    const outcome = await recordReferralOnSignup(
      repo,
      { referredCustomerId: "self", referrerId: "self", sourceEventId: "wh-9" },
      db,
    );

    expect(outcome.status).toBe("self_referral_rejected");
    // No referral row, no ledger entry, no balance change.
    expect(db.referrals).toHaveLength(0);
    expect(db.ledger).toHaveLength(0);
    expect(db.customers.get("self")?.referred_by).toBeNull();
  });
});

describe("awardReferralFirstPurchase: +250 on the friend's first paid purchase (Req 2.10)", () => {
  it("credits the referrer exactly one +250 earn_referral and marks it rewarded", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    db.seedCustomer("referrer");
    db.seedCustomer("friend");
    await recordReferralOnSignup(repo, { referredCustomerId: "friend", referrerId: "referrer" }, db);

    const outcome = await awardReferralFirstPurchase(
      repo,
      { referredCustomerId: "friend", isFirstPaidPurchase: true, sourceEventId: "wh-2" },
      db,
    );

    expect(outcome.status).toBe("rewarded");
    if (outcome.status !== "rewarded") return;
    expect(outcome.entry.entryType).toBe("earn_referral");
    expect(outcome.entry.points).toBe(REFERRAL_PURCHASE_POINTS);
    expect(outcome.entry.points).toBe(250);
    expect(outcome.entry.reason).toBe(REFERRAL_PURCHASE_REASON);

    // Referrer now has +150 (signup) and +250 (purchase) = two referral entries.
    expect(db.referralEntriesFor("referrer")).toHaveLength(2);
    expect(db.referralEntriesFor("friend")).toHaveLength(0);
  });

  it("is exactly-once: a second first-purchase event awards no second +250", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    db.seedCustomer("referrer");
    db.seedCustomer("friend");
    await recordReferralOnSignup(repo, { referredCustomerId: "friend", referrerId: "referrer" }, db);

    const first = await awardReferralFirstPurchase(repo, { referredCustomerId: "friend", isFirstPaidPurchase: true }, db);
    expect(first.status).toBe("rewarded");

    const again = await awardReferralFirstPurchase(repo, { referredCustomerId: "friend", isFirstPaidPurchase: true }, db);
    expect(again.status).toBe("already_rewarded");

    // Only one +250 total.
    const purchaseEntries = db.referralEntriesFor("referrer").filter((e) => e.reason === REFERRAL_PURCHASE_REASON);
    expect(purchaseEntries).toHaveLength(1);
  });

  it("does nothing when the friend was not referred", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    db.seedCustomer("stranger");

    const outcome = await awardReferralFirstPurchase(repo, { referredCustomerId: "stranger", isFirstPaidPurchase: true }, db);

    expect(outcome.status).toBe("no_referral");
    expect(db.ledger).toHaveLength(0);
  });
});

describe("awardReferralFirstPurchase: no reward if the friend had a prior paid purchase (Req 11.9)", () => {
  it("does not award the +250 when this is not the friend's first paid purchase", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    db.seedCustomer("referrer");
    db.seedCustomer("friend");
    await recordReferralOnSignup(repo, { referredCustomerId: "friend", referrerId: "referrer" }, db);
    const signupEntries = db.referralEntriesFor("referrer").length; // 1 (the +150)

    const outcome = await awardReferralFirstPurchase(
      repo,
      { referredCustomerId: "friend", isFirstPaidPurchase: false, sourceEventId: "wh-3" },
      db,
    );

    expect(outcome.status).toBe("not_first_purchase");
    // No new earning: still only the signup +150, no +250.
    expect(db.referralEntriesFor("referrer")).toHaveLength(signupEntries);
    const purchaseEntries = db.referralEntriesFor("referrer").filter((e) => e.reason === REFERRAL_PURCHASE_REASON);
    expect(purchaseEntries).toHaveLength(0);
    // The referral row is not marked purchase-rewarded, so a later genuine first
    // purchase could still qualify.
    expect(db.referrals[0]?.purchase_rewarded).toBe(false);
  });
});
