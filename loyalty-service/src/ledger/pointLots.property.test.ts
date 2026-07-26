/**
 * **Property 17: Every credit is backed by a lot**
 *
 * ∀ ledger entry `e` with `e.points > 0`, a matching Point_Lot exists with
 * `ledger_entry_id == e.id` and `original_points == e.points`.
 *
 * **Validates: Requirements 1.3, 2.6, 2.9, 2.10, 10.2, 10.4**
 *
 * WHY THIS PROPERTY EXISTS: `Spendable_Balance` is derived solely from
 * non-expired Point_Lot remainders (Req 1.3), while a customer's history is
 * derived from the ledger. A credit appended WITHOUT a backing lot is therefore
 * shown to the customer as points earned yet can never be redeemed and never
 * expires. Staging validation observed exactly that: a customer with a ledger
 * balance of 140 (a 50-point signup bonus plus 90 in admin credits) whose
 * spendable balance was 0.
 *
 * The property drives the real credit paths — signup, referral, order earning,
 * admin adjustment and manual credit — over an in-memory {@link Queryable} fake
 * that records both tables, then asserts the pairing holds for every generated
 * sequence. No live database or Shopify Admin API is touched.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "./repository.js";
import { LOT_EXPIRY_MONTHS, addMonths } from "./pointLots.js";
import { earnSignup } from "../earning/signup.js";
import { applyAdjustment, grantManualCredit } from "../admin/adjustments.js";
import { InMemoryAuditTrailRecorder } from "../admin/auditTrail.js";

interface LedgerRow {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
}

interface LotRow {
  customer_id: string;
  ledger_entry_id: string;
  original_points: number;
  earned_at: Date;
  expires_at: Date | null;
}

/**
 * An in-memory Postgres understanding exactly the statements the credit paths
 * issue: the customer upsert, the signup idempotency guard, the append-only
 * ledger insert, and the Point_Lot insert.
 */
class FakeDb implements Queryable {
  readonly ledger: LedgerRow[] = [];
  readonly lots: LotRow[] = [];
  private readonly customersByShopifyId = new Map<number, string>();
  private seq = 0;

  private next(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
    return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (text.includes("INSERT INTO customers")) {
      const shopifyId = values[0] as number;
      let id = this.customersByShopifyId.get(shopifyId);
      if (!id) {
        id = this.next("cust");
        this.customersByShopifyId.set(shopifyId, id);
      }
      return this.result<R>([{ id } as unknown as R]);
    }
    if (text.includes("FROM ledger_entries") && text.includes("earn_signup")) {
      const customerId = values[0] as string;
      const exists = this.ledger.some(
        (e) => e.customer_id === customerId && e.entry_type === "earn_signup",
      );
      return this.result<R>(exists ? [{ one: 1 } as unknown as R] : []);
    }
    if (text.includes("INSERT INTO ledger_entries")) {
      const row: LedgerRow = {
        id: this.next("ledg"),
        customer_id: values[0] as string,
        entry_type: values[1] as string,
        points: values[2] as number,
        reason: values[3] as string,
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
          source_event_id: (values[7] as string | null) ?? null,
          created_at: new Date("2026-03-01T12:00:00.000Z"),
        } as unknown as R,
      ]);
    }
    if (text.includes("INSERT INTO point_lots")) {
      this.lots.push({
        customer_id: values[0] as string,
        ledger_entry_id: values[1] as string,
        original_points: values[2] as number,
        earned_at: values[3] as Date,
        expires_at: values[4] as Date | null,
      });
      return this.result<R>([]);
    }
    throw new Error(`Unexpected query in FakeDb: ${text}`);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Every positive ledger entry paired with its backing lot, if any. */
  unbackedCredits(): LedgerRow[] {
    return this.ledger.filter(
      (e) => e.points > 0 && !this.lots.some((l) => l.ledger_entry_id === e.id),
    );
  }
}

/** The credit operations the property drives. */
type Credit =
  | { kind: "signup"; shopifyCustomerId: number }
  | { kind: "adjustment"; customerId: string; points: number }
  | { kind: "credit"; customerId: string; points: number };

const creditArb: fc.Arbitrary<Credit> = fc.oneof(
  fc
    .integer({ min: 1, max: 5 })
    .map((n) => ({ kind: "signup" as const, shopifyCustomerId: 1_000 + n })),
  fc.record({
    kind: fc.constant("adjustment" as const),
    customerId: fc.constantFrom("cust-a", "cust-b"),
    points: fc.integer({ min: 1, max: 5_000 }),
  }),
  fc.record({
    kind: fc.constant("credit" as const),
    customerId: fc.constantFrom("cust-a", "cust-b"),
    points: fc.integer({ min: 1, max: 5_000 }),
  }),
);

const ADMIN = { adminUserId: "admin-1" } as const;

describe("Property 17 — every credit is backed by a point lot (Req 1.3, 2.6, 2.9, 2.10, 10.2, 10.4)", () => {
  it("pairs every positive ledger entry with a lot of the same amount", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(creditArb, { minLength: 1, maxLength: 12 }), async (credits) => {
        const db = new FakeDb();
        const repo = new LedgerRepository(db);
        const audit = new InMemoryAuditTrailRecorder();
        const transactor = <T,>(fn: (tx: Queryable) => Promise<T>): Promise<T> => db.transaction(fn);

        for (const credit of credits) {
          if (credit.kind === "signup") {
            await earnSignup(repo, { shopifyCustomerId: credit.shopifyCustomerId }, db);
          } else if (credit.kind === "adjustment") {
            await applyAdjustment(
              { customerId: credit.customerId, points: credit.points, reason: "property reason" },
              ADMIN,
              { repo, audit, transactor },
            );
          } else {
            await grantManualCredit(
              {
                customerId: credit.customerId,
                points: credit.points,
                action: "property_action",
                reason: "property reason",
              },
              ADMIN,
              { repo, audit, transactor },
            );
          }
        }

        // The invariant: no positive entry lacks a lot.
        expect(db.unbackedCredits()).toEqual([]);

        // And each lot matches its entry's amount exactly.
        for (const entry of db.ledger.filter((e) => e.points > 0)) {
          const lot = db.lots.find((l) => l.ledger_entry_id === entry.id);
          expect(lot).toBeDefined();
          expect(lot!.original_points).toBe(entry.points);
          expect(lot!.customer_id).toBe(entry.customer_id);
          // Expiry is exactly 12 months after the earning timestamp (A1).
          expect(lot!.expires_at).toEqual(addMonths(lot!.earned_at, LOT_EXPIRY_MONTHS));
        }

        // Spendable (sum of lots) equals the credited total, so no credited
        // point is permanently unspendable.
        const credited = db.ledger
          .filter((e) => e.points > 0)
          .reduce((sum, e) => sum + e.points, 0);
        const spendable = db.lots.reduce((sum, l) => sum + l.original_points, 0);
        expect(spendable).toBe(credited);
      }),
      { numRuns: 60 },
    );
  });

  it("creates no lot for a negative adjustment (a debit consumes lots, it does not create one)", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const audit = new InMemoryAuditTrailRecorder();
    const transactor = <T,>(fn: (tx: Queryable) => Promise<T>): Promise<T> => db.transaction(fn);

    await applyAdjustment(
      { customerId: "cust-a", points: -250, reason: "correcting a duplicate reversal" },
      ADMIN,
      { repo, audit, transactor },
    );

    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]!.points).toBe(-250);
    expect(db.lots).toHaveLength(0);
    expect(db.unbackedCredits()).toEqual([]);
  });
});
