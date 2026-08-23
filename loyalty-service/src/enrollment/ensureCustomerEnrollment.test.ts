/**
 * Tests for the reusable customer-enrollment service.
 *
 * NO live Shopify endpoint and NO live database are touched. A fake
 * {@link Queryable} + {@link Transactor} backed by a tiny in-memory store routes
 * the statements the flow issues — the customer upsert, the population
 * classification read, the `earn_signup` idempotency guard, the ledger append,
 * and the Point_Lot insert.
 *
 * The fake models ONE property of real Postgres deliberately, because the
 * service's race-safety argument depends on it: `INSERT ... ON CONFLICT
 * (shopify_customer_id) DO UPDATE` takes a ROW-LEVEL LOCK on that customer's row
 * and holds it until COMMIT, so a concurrent enrollment of the same Shopify id
 * blocks at the upsert rather than interleaving with the award decision. See
 * {@link FakeDb.acquireRowLock}. Without modelling that, a concurrency test
 * against a fake would prove nothing about production.
 *
 * The nine required scenarios are covered here except the two that are
 * properties of the HTTP boundary — an unverified App Proxy request, and a
 * browser-supplied foreign customer id — which are exercised through a real
 * Fastify instance in `lazyEnrollment.auth.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { MIGRATION_ENTRY_TYPE, MIGRATION_REASON } from "../migration/m1Backfill.js";
import { CUSTOMERS_CREATE_TOPIC, type Transactor } from "../earning/signup.js";
import type { WebhookJob } from "../webhooks/enqueue.js";
import {
  backfillEnrollment,
  ensureCustomerEnrollmentInTransaction,
  handleCustomersCreateEnrollment,
  InvalidEnrollmentIdentityError,
  LazyEnrollmentGate,
  parseVerifiedShopifyCustomerId,
  SIGNUP_POINTS,
  TRIGGER_SIGNUP_AWARD_POLICY,
  type EnrollmentOutcome,
  type TransactionalEnrollmentDeps,
} from "./ensureCustomerEnrollment.js";

const SHOPIFY_ID = 4995;

interface LedgerRowStore {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  source_event_id: string | null;
}

/**
 * In-memory Postgres stand-in understanding exactly the statements enrollment
 * issues, plus the row-lock semantics the concurrency guarantee rests on.
 */
class FakeDb implements Transactor {
  readonly customersByShopifyId = new Map<number, string>();
  readonly ledger: LedgerRowStore[] = [];
  readonly lots: Array<{ customer_id: string; ledger_entry_id: string; points: number }> = [];
  /** Referral codes assigned, to prove the delegated award path stays intact. */
  readonly referralCodesAssigned: string[] = [];
  private seq = 0;
  /** One promise chain per Shopify id — the fake's model of a row lock. */
  private readonly rowLocks = new Map<number, Promise<void>>();

  /**
   * Runs the unit of work on a transaction-scoped client. Row locks taken during
   * the transaction are released when it ends, mirroring COMMIT/ROLLBACK — which
   * is what makes a blocked concurrent enrollment resume and then SEE the
   * committed `earn_signup`.
   */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const tx = new FakeTx(this);
    try {
      return await fn(tx);
    } finally {
      tx.releaseLocks();
    }
  }

  /**
   * Models `INSERT ... ON CONFLICT DO UPDATE`'s row-level lock: the second caller
   * for the same Shopify id waits until the first transaction ends. Re-entrant,
   * because a transaction that already holds the row lock does not block on
   * itself (enrollment upserts once, then the delegated `earnSignup` upserts the
   * same row again inside the same transaction).
   */
  async acquireRowLock(shopifyId: number, held: Set<number>): Promise<() => void> {
    if (held.has(shopifyId)) {
      return () => {};
    }
    const previous = this.rowLocks.get(shopifyId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.rowLocks.set(
      shopifyId,
      previous.then(() => mine),
    );
    await previous;
    held.add(shopifyId);
    return release;
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(12, "0")}`;
  }

  result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
    return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  }

  /** Test setup: place a customer in Population B exactly as M1 backfill does. */
  seedMigratedCustomer(shopifyId: number, points: number): string {
    const customerId = this.nextId("cust");
    this.customersByShopifyId.set(shopifyId, customerId);
    this.ledger.push({
      id: this.nextId("ledg"),
      customer_id: customerId,
      entry_type: MIGRATION_ENTRY_TYPE,
      points,
      reason: MIGRATION_REASON,
      source_event_id: null,
    });
    return customerId;
  }

  entriesOfType(customerId: string, entryType: string): LedgerRowStore[] {
    return this.ledger.filter((r) => r.customer_id === customerId && r.entry_type === entryType);
  }

  balanceOf(customerId: string): number {
    return this.ledger
      .filter((r) => r.customer_id === customerId)
      .reduce((sum, r) => sum + r.points, 0);
  }
}

/** A transaction-scoped client over {@link FakeDb}, holding its own row locks. */
class FakeTx implements Queryable {
  private readonly releases: Array<() => void> = [];
  private readonly held = new Set<number>();

  constructor(private readonly db: FakeDb) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (queryText.includes("INSERT INTO customers")) {
      return this.upsertCustomer<R>(queryText, values);
    }
    // Classification MUST be matched before the guard: both read
    // `ledger_entries` and both mention `earn_signup`, and only the
    // classification aggregates with bool_or.
    if (queryText.includes("bool_or")) {
      return this.classify<R>(values);
    }
    if (queryText.includes("FROM ledger_entries") && queryText.includes("earn_signup")) {
      return this.guardSignup<R>(values);
    }
    if (queryText.includes("INSERT INTO ledger_entries")) {
      return this.appendLedger<R>(values);
    }
    if (queryText.includes("INSERT INTO point_lots")) {
      const [customer_id, ledger_entry_id, points] = values as [string, string, number];
      this.db.lots.push({ customer_id, ledger_entry_id, points });
      return this.db.result<R>([]);
    }
    throw new Error(`Unexpected query in FakeTx: ${queryText}`);
  }

  releaseLocks(): void {
    for (const release of this.releases) {
      release();
    }
    this.releases.length = 0;
    this.held.clear();
  }

  private async upsertCustomer<R extends QueryResultRow>(
    queryText: string,
    values: unknown[],
  ): Promise<QueryResult<R>> {
    const shopifyId = values[0] as number;
    // Take (or re-enter) the row lock BEFORE touching the row, exactly where
    // Postgres would, and hold it for the rest of the transaction.
    this.releases.push(await this.db.acquireRowLock(shopifyId, this.held));

    let id = this.db.customersByShopifyId.get(shopifyId);
    const inserted = id === undefined;
    if (!id) {
      id = this.db.nextId("cust");
      this.db.customersByShopifyId.set(shopifyId, id);
    }
    // Only the enrollment upsert asks for the xmax-derived `inserted` flag; the
    // signup module's upsert returns the id alone.
    const row = queryText.includes("xmax") ? { id, inserted } : { id };
    return this.db.result<R>([row as unknown as R]);
  }

  private classify<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const customerId = values[0] as string;
    const rows = this.db.ledger.filter((r) => r.customer_id === customerId);
    const relevant = rows.filter(
      (r) => r.entry_type === MIGRATION_ENTRY_TYPE || r.entry_type === "earn_signup",
    );
    // bool_or over an empty set yields NULL, which the service reads as false.
    const row =
      relevant.length === 0
        ? { has_migration_state: null, has_signup_award: null }
        : {
            has_migration_state: relevant.some((r) => r.entry_type === MIGRATION_ENTRY_TYPE),
            has_signup_award: relevant.some((r) => r.entry_type === "earn_signup"),
          };
    return this.db.result<R>([row as unknown as R]);
  }

  private guardSignup<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const customerId = values[0] as string;
    const exists = this.db.ledger.some(
      (r) => r.customer_id === customerId && r.entry_type === "earn_signup",
    );
    return this.db.result<R>(exists ? [{ "?column?": 1 } as unknown as R] : []);
  }

  private appendLedger<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, entryType, points, reason, , , , sourceEventId] = values;
    const row: LedgerRowStore = {
      id: this.db.nextId("ledg"),
      customer_id: customerId as string,
      entry_type: entryType as string,
      points: points as number,
      reason: reason as string,
      source_event_id: (sourceEventId as string | null) ?? null,
    };
    this.db.ledger.push(row);
    return this.db.result<R>([
      {
        id: row.id,
        customer_id: row.customer_id,
        entry_type: row.entry_type,
        points: String(row.points), // pg returns BIGINT as a string
        reason: row.reason,
        order_reference: null,
        point_lot_id: null,
        redemption_id: null,
        source_event_id: row.source_event_id,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      } as unknown as R,
    ]);
  }
}

function makeDeps(db: FakeDb): TransactionalEnrollmentDeps {
  return {
    repo: new LedgerRepository(db as unknown as Queryable),
    transactor: db,
    ensureReferralCode: async (customerId) => {
      db.referralCodesAssigned.push(customerId);
    },
  };
}

function makeJob(overrides: Partial<WebhookJob> = {}): WebhookJob {
  return {
    webhookId: "wh-1",
    topic: CUSTOMERS_CREATE_TOPIC,
    shopDomain: "myathoorlondon.myshopify.com",
    payload: { id: SHOPIFY_ID, email: "new@example.com" },
    ...overrides,
  };
}

/** The authenticated fallback, as the auth layer invokes it: enabled, id only. */
function makeGate(db: FakeDb, enabled = true): LazyEnrollmentGate {
  return new LazyEnrollmentGate({ ...makeDeps(db), enabled });
}

/** Asserts the end state every scenario must reach. */
function expectSingleCustomerWithOneAward(db: FakeDb, shopifyId: number, awards: number): void {
  expect(db.customersByShopifyId.size).toBe(1);
  const customerId = db.customersByShopifyId.get(shopifyId);
  expect(customerId).toBeDefined();
  expect(db.entriesOfType(customerId!, "earn_signup")).toHaveLength(awards);
  expect(db.balanceOf(customerId!)).toBe(awards * SIGNUP_POINTS);
}

describe("scenario 1: webhook arrives first, then an authenticated request", () => {
  it("awards +50 once on the webhook and the later request only resolves the same customer", async () => {
    const db = new FakeDb();
    const deps = makeDeps(db);

    const webhook = await handleCustomersCreateEnrollment(makeJob(), deps);
    expect(webhook?.signupAward).toBe("awarded");
    expect(webhook?.createdCustomer).toBe(true);
    expect(webhook?.pointsAwarded).toBe(50);

    const fromRequest = await makeGate(db).enrollVerifiedCustomer(String(SHOPIFY_ID));

    // Same ownership, no second row, no second award.
    expect(fromRequest).toBe(webhook?.customerId);
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 1);
    // The delegated award path stays intact: one referral code, from the webhook.
    expect(db.referralCodesAssigned).toEqual([webhook!.customerId]);
  });
});

describe("scenario 2: the authenticated fallback enrolls first, then the webhook arrives", () => {
  it("creates the row without awarding, then the webhook awards exactly one +50", async () => {
    const db = new FakeDb();
    const deps = makeDeps(db);

    const enrolled = await makeGate(db).enrollVerifiedCustomer(String(SHOPIFY_ID));
    expect(enrolled).not.toBeNull();
    // The row now exists and carries NO points: repairing enrollment is not a signup.
    expect(db.ledger).toHaveLength(0);

    const webhook = await handleCustomersCreateEnrollment(makeJob(), deps);

    // Shopify confirmed a genuinely new customer, so the award lands here — once.
    expect(webhook?.customerId).toBe(enrolled);
    expect(webhook?.signupAward).toBe("awarded");
    // The row already existed, so this call did not create it.
    expect(webhook?.createdCustomer).toBe(false);
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 1);
  });
});

describe("scenario 3: two simultaneous authenticated first requests", () => {
  it("creates exactly one customer and exactly one signup award", async () => {
    const db = new FakeDb();
    const gate = makeGate(db);

    const [a, b] = await Promise.all([
      gate.enrollVerifiedCustomer(String(SHOPIFY_ID)),
      gate.enrollVerifiedCustomer(String(SHOPIFY_ID)),
    ]);

    // Both requests resolve to the SAME local customer — the unique constraint on
    // customers.shopify_customer_id makes a duplicate row impossible.
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    // Neither awarded, because a repair is never a signup.
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 0);
  });

  it("still awards exactly once when a simultaneous webhook and request race", async () => {
    const db = new FakeDb();
    const deps = makeDeps(db);

    const [webhook, viaRequest] = await Promise.all([
      handleCustomersCreateEnrollment(makeJob(), deps),
      makeGate(db).enrollVerifiedCustomer(String(SHOPIFY_ID)),
    ]);

    expect(viaRequest).toBe(webhook?.customerId);
    // Exactly one award regardless of which transaction won the row lock.
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 1);
    expect(db.lots).toHaveLength(1);
  });

  it("awards once when several webhook deliveries land simultaneously", async () => {
    const db = new FakeDb();
    const deps = makeDeps(db);

    const outcomes = await Promise.all([
      handleCustomersCreateEnrollment(makeJob({ webhookId: "wh-a" }), deps),
      handleCustomersCreateEnrollment(makeJob({ webhookId: "wh-b" }), deps),
      handleCustomersCreateEnrollment(makeJob({ webhookId: "wh-c" }), deps),
    ]);

    // The upsert's row lock serialises them, so the losers see the committed
    // earn_signup and the existing guard declines.
    expect(outcomes.filter((o) => o?.signupAward === "awarded")).toHaveLength(1);
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 1);
  });
});

describe("scenario 4: repeated webhook delivery", () => {
  it("awards on the first delivery and nothing on replays, under any webhook id", async () => {
    const db = new FakeDb();
    const deps = makeDeps(db);

    const first = await handleCustomersCreateEnrollment(makeJob({ webhookId: "wh-1" }), deps);
    const sameId = await handleCustomersCreateEnrollment(makeJob({ webhookId: "wh-1" }), deps);
    const newId = await handleCustomersCreateEnrollment(makeJob({ webhookId: "wh-2" }), deps);

    expect(first?.signupAward).toBe("awarded");
    expect(sameId?.signupAward).toBe("skipped_already_awarded");
    // Idempotent even under a DIFFERENT webhook id, because the business key is
    // the per-customer earn_signup entry, not the webhook id.
    expect(newId?.signupAward).toBe("skipped_already_awarded");
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 1);
    expect(db.lots).toHaveLength(1);
  });

  it("ignores a job for another topic entirely", async () => {
    const db = new FakeDb();

    const outcome = await handleCustomersCreateEnrollment(
      makeJob({ topic: "orders/paid", payload: { id: 777 } }),
      makeDeps(db),
    );

    expect(outcome).toBeNull();
    expect(db.customersByShopifyId.size).toBe(0);
    expect(db.ledger).toHaveLength(0);
  });

  it("refuses a payload with no usable customer id and creates nothing", async () => {
    const db = new FakeDb();

    await expect(
      handleCustomersCreateEnrollment(makeJob({ payload: { email: "x@example.com" } }), makeDeps(db)),
    ).rejects.toBeInstanceOf(InvalidEnrollmentIdentityError);

    expect(db.customersByShopifyId.size).toBe(0);
    expect(db.ledger).toHaveLength(0);
  });
});

describe("scenario 5: repeated authenticated requests", () => {
  it("enrolls once and never awards, however many requests arrive", async () => {
    const db = new FakeDb();
    const gate = makeGate(db);

    const ids = [
      await gate.enrollVerifiedCustomer(String(SHOPIFY_ID)),
      await gate.enrollVerifiedCustomer(String(SHOPIFY_ID)),
      await gate.enrollVerifiedCustomer(String(SHOPIFY_ID)),
    ];

    expect(new Set(ids).size).toBe(1);
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 0);
  });

  it("keeps returning the same customer after the webhook has awarded", async () => {
    const db = new FakeDb();
    const deps = makeDeps(db);
    const gate = makeGate(db);

    const webhook = await handleCustomersCreateEnrollment(makeJob(), deps);
    await gate.enrollVerifiedCustomer(String(SHOPIFY_ID));
    await gate.enrollVerifiedCustomer(String(SHOPIFY_ID));

    expect(await gate.enrollVerifiedCustomer(String(SHOPIFY_ID))).toBe(webhook?.customerId);
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 1);
  });
});

describe("scenario 6: a historical migrated customer never receives a second +50", () => {
  it("leaves a migrated customer's balance untouched on an authenticated request", async () => {
    const db = new FakeDb();
    const migratedId = db.seedMigratedCustomer(SHOPIFY_ID, 84);

    const resolved = await makeGate(db).enrollVerifiedCustomer(String(SHOPIFY_ID));

    expect(resolved).toBe(migratedId);
    // Balance is still exactly the migrated opening balance.
    expect(db.balanceOf(migratedId)).toBe(84);
    expect(db.entriesOfType(migratedId, "earn_signup")).toHaveLength(0);
  });

  it("refuses the award on the WEBHOOK path too, naming migrated state as the reason", async () => {
    const db = new FakeDb();
    const migratedId = db.seedMigratedCustomer(SHOPIFY_ID, 84);

    // Even the one trigger that IS award-eligible is vetoed by the ledger, so a
    // replayed or re-fired customers/create cannot credit Population B.
    const outcome = await handleCustomersCreateEnrollment(makeJob(), makeDeps(db));

    expect(outcome?.customerId).toBe(migratedId);
    expect(outcome?.population).toBe("legacy_migrated");
    expect(outcome?.signupAward).toBe("skipped_legacy_migrated_state");
    expect(db.balanceOf(migratedId)).toBe(84);
  });

  it("classifies a genuinely new customer as new, so Population A is still paid", async () => {
    const db = new FakeDb();

    const outcome = await handleCustomersCreateEnrollment(makeJob(), makeDeps(db));

    expect(outcome?.population).toBe("new_or_unknown");
    expect(outcome?.signupAward).toBe("awarded");
  });

  it("enrolls a never-backfilled historical customer without inventing points", async () => {
    // The 40 pre-existing customers who were never backfilled: their row is
    // missing, which is a gap in OUR data, not a signup event.
    const db = new FakeDb();

    const outcome = await backfillEnrollment(makeDeps(db), { shopifyCustomerId: SHOPIFY_ID });

    expect(outcome.createdCustomer).toBe(true);
    expect(outcome.signupAward).toBe("skipped_trigger_not_eligible");
    expectSingleCustomerWithOneAward(db, SHOPIFY_ID, 0);
  });
});

describe("scenario 7: no duplicate signup credit in ANY ordering", () => {
  type Step = "webhook" | "fallback" | "backfill";

  const orderings: Step[][] = [
    ["webhook", "fallback"],
    ["fallback", "webhook"],
    ["webhook", "webhook"],
    ["fallback", "fallback"],
    ["backfill", "webhook"],
    ["webhook", "backfill"],
    ["fallback", "webhook", "fallback"],
    ["webhook", "fallback", "webhook"],
    ["backfill", "fallback", "webhook", "fallback", "backfill"],
  ];

  it.each(orderings.map((steps) => [steps.join(" → "), steps] as const))(
    "ends with one customer and at most one +50 for: %s",
    async (_label, steps) => {
      const db = new FakeDb();
      const deps = makeDeps(db);
      const gate = makeGate(db);
      const ids: string[] = [];
      let webhookSeen = false;

      for (const [index, step] of steps.entries()) {
        if (step === "webhook") {
          webhookSeen = true;
          const out = await handleCustomersCreateEnrollment(
            makeJob({ webhookId: `wh-${index}` }),
            deps,
          );
          ids.push(out!.customerId);
        } else if (step === "fallback") {
          const id = await gate.enrollVerifiedCustomer(String(SHOPIFY_ID));
          ids.push(id!);
        } else {
          const out = await backfillEnrollment(deps, { shopifyCustomerId: SHOPIFY_ID });
          ids.push(out.customerId);
        }
      }

      // One owner throughout — every step resolved to the same local customer.
      expect(new Set(ids).size).toBe(1);
      // Exactly one award if Shopify ever confirmed a new customer, else none.
      expectSingleCustomerWithOneAward(db, SHOPIFY_ID, webhookSeen ? 1 : 0);
      expect(db.lots).toHaveLength(webhookSeen ? 1 : 0);
    },
  );

  it("never awards twice when a migrated customer is hit by every path", async () => {
    const db = new FakeDb();
    const migratedId = db.seedMigratedCustomer(SHOPIFY_ID, 84);
    const deps = makeDeps(db);
    const gate = makeGate(db);

    await gate.enrollVerifiedCustomer(String(SHOPIFY_ID));
    await handleCustomersCreateEnrollment(makeJob(), deps);
    await backfillEnrollment(deps, { shopifyCustomerId: SHOPIFY_ID });
    await gate.enrollVerifiedCustomer(String(SHOPIFY_ID));

    expect(db.balanceOf(migratedId)).toBe(84);
    expect(db.entriesOfType(migratedId, "earn_signup")).toHaveLength(0);
  });

  it("keeps customers isolated: enrolling one never touches another", async () => {
    const db = new FakeDb();
    const deps = makeDeps(db);

    const a = await handleCustomersCreateEnrollment(makeJob({ payload: { id: 1001 } }), deps);
    const b = await handleCustomersCreateEnrollment(makeJob({ payload: { id: 2002 } }), deps);
    await makeGate(db).enrollVerifiedCustomer("3003");

    expect(a!.customerId).not.toBe(b!.customerId);
    expect(db.customersByShopifyId.size).toBe(3);
    expect(db.balanceOf(a!.customerId)).toBe(50);
    expect(db.balanceOf(b!.customerId)).toBe(50);
    expect(db.balanceOf(db.customersByShopifyId.get(3003)!)).toBe(0);
  });
});

describe("the award gate is default-deny by construction", () => {
  it("marks only the customers/create trigger as award-eligible", () => {
    // A trigger added later must opt IN here explicitly; this test is the tripwire.
    expect(TRIGGER_SIGNUP_AWARD_POLICY).toEqual({
      webhook_customers_create: "award_when_genuinely_new",
      authenticated_fallback: "never_award",
      migration_backfill: "never_award",
    });
  });

  it("refuses to enrol on an unusable Shopify customer id", async () => {
    const db = new FakeDb();

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        ensureCustomerEnrollmentInTransaction(makeDeps(db), {
          shopifyCustomerId: bad,
          trigger: "authenticated_fallback",
        }),
      ).rejects.toBeInstanceOf(InvalidEnrollmentIdentityError);
    }
    expect(db.customersByShopifyId.size).toBe(0);
  });
});

describe("the configuration gate defaults to off", () => {
  it("enrolls nothing at all when the fallback is disabled", async () => {
    const db = new FakeDb();

    const result = await makeGate(db, false).enrollVerifiedCustomer(String(SHOPIFY_ID));

    // Identity stays unresolved, so the caller returns its normal 401.
    expect(result).toBeNull();
    expect(db.customersByShopifyId.size).toBe(0);
    expect(db.ledger).toHaveLength(0);
  });

  it("degrades to unresolved identity — never a throw — when enrollment fails", async () => {
    const db = new FakeDb();
    const failures: string[] = [];
    const gate = new LazyEnrollmentGate({
      repo: new LedgerRepository(db as unknown as Queryable),
      transactor: {
        transaction: async () => {
          throw new Error("connection lost");
        },
      },
      enabled: true,
      onEnrollmentError: (_err, id) => failures.push(id),
    });

    await expect(gate.enrollVerifiedCustomer(String(SHOPIFY_ID))).resolves.toBeNull();
    // The failure is surfaced rather than silently swallowed.
    expect(failures).toEqual([String(SHOPIFY_ID)]);
  });

  it("rejects a verified id that is not a positive integer", () => {
    for (const bad of ["", "0", "-5", "12.5", "abc", "12abc", " 12", "0x10"]) {
      expect(parseVerifiedShopifyCustomerId(bad)).toBeNull();
    }
    expect(parseVerifiedShopifyCustomerId("4995")).toBe(4995);
  });

  it("never enrols the anonymous storefront id, even when enabled", async () => {
    const db = new FakeDb();

    // Shopify sends logged_in_customer_id=0 for a not-logged-in session. The auth
    // layer rejects it before reaching here; the gate refuses it as well.
    expect(await makeGate(db).enrollVerifiedCustomer("0")).toBeNull();
    expect(db.customersByShopifyId.size).toBe(0);
  });
});

describe("outcome reporting is auditable", () => {
  it("distinguishes creating the row from paying the bonus", async () => {
    const db = new FakeDb();
    const deps = makeDeps(db);

    const created = await backfillEnrollment(deps, { shopifyCustomerId: SHOPIFY_ID });
    const awarded = (await handleCustomersCreateEnrollment(makeJob(), deps)) as EnrollmentOutcome;

    // The row was created by a call that paid nothing…
    expect(created).toMatchObject({
      createdCustomer: true,
      signupAward: "skipped_trigger_not_eligible",
      pointsAwarded: 0,
      ledgerEntryId: null,
    });
    // …and paid for by a later call that created nothing.
    expect(awarded).toMatchObject({
      createdCustomer: false,
      signupAward: "awarded",
      pointsAwarded: SIGNUP_POINTS,
    });
    expect(awarded.ledgerEntryId).not.toBeNull();
  });

  it("records the webhook id on the awarded entry for traceability", async () => {
    const db = new FakeDb();

    await handleCustomersCreateEnrollment(makeJob({ webhookId: "wh-trace" }), makeDeps(db));

    expect(db.ledger[0]!.source_event_id).toBe("wh-trace");
  });
});
