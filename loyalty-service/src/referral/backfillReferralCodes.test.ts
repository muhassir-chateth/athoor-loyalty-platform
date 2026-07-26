/**
 * Referral-code backfill (task 36) — the five safety properties the operator
 * relies on, plus the cache refresh that makes a new code visible.
 *
 * The fake DB models `customers.referral_code` with the SAME predicate the real
 * schema enforces: the UPDATE only lands when the column is currently NULL, and
 * the code column is UNIQUE. That is what lets these tests exercise the
 * concurrency and collision paths honestly rather than assuming them.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  runReferralCodeBackfill,
  type Transactor,
} from "./backfillReferralCodes.js";
import {
  RecordingMetafieldCacheEnqueuer,
  type MetafieldCacheEnqueuer,
  type MetafieldCacheJob,
} from "../shopify/metafieldCache.js";

interface CustomerRow {
  id: string;
  shopify_customer_id: string;
  referral_code: string | null;
  created_at: Date;
}

/** An enqueuer whose queue is down. */
class ThrowingEnqueuer implements MetafieldCacheEnqueuer {
  readonly attempts: MetafieldCacheJob[] = [];
  async enqueueMetafieldCache(job: MetafieldCacheJob): Promise<void> {
    this.attempts.push({ ...job });
    throw new Error("pg-boss unavailable");
  }
}

/**
 * Models only the three statements the backfill path issues, enforcing the two
 * real invariants: `referral_code` is UNIQUE, and the UPDATE is guarded on the
 * column being NULL.
 */
class FakeDb implements Queryable, Transactor {
  /** Called immediately before each guarded UPDATE — used to inject a race. */
  onBeforeUpdate?: (customerId: string) => void;

  constructor(readonly customers: CustomerRow[]) {}

  private codeTaken(code: string, exceptId: string): boolean {
    return this.customers.some((c) => c.referral_code === code && c.id !== exceptId);
  }

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

    if (text.includes("WHERE referral_code IS NULL") && text.includes("ORDER BY created_at")) {
      const missing = this.customers
        .filter((c) => c.referral_code === null)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      return ok(missing.map((c) => ({ id: c.id, shopify_customer_id: c.shopify_customer_id })));
    }

    if (text.includes("SELECT referral_code FROM customers")) {
      const row = this.customers.find((c) => c.id === values[0]);
      return ok(row ? [{ referral_code: row.referral_code }] : []);
    }

    if (text.includes("UPDATE customers") && text.includes("referral_code = $2")) {
      const [id, candidate] = values as [string, string];
      this.onBeforeUpdate?.(id);
      const row = this.customers.find((c) => c.id === id);
      if (!row) return ok([], "UPDATE");
      // UNIQUE(referral_code)
      if (this.codeTaken(candidate, id)) {
        const err = new Error("duplicate key value violates unique constraint");
        (err as { code?: string }).code = "23505";
        throw err;
      }
      // WHERE referral_code IS NULL — a set code is never overwritten.
      if (row.referral_code !== null) {
        return ok([], "UPDATE");
      }
      row.referral_code = candidate;
      return ok([{ referral_code: candidate }], "UPDATE");
    }

    throw new Error(`Unexpected query: ${text}`);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

let seq = 0;
const customer = (id: string, code: string | null, minute = ++seq): CustomerRow => ({
  id,
  shopify_customer_id: `90000000000${id.slice(-1)}`,
  referral_code: code,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, minute)),
});

/** A deterministic generator producing ATH-0001-0001, ATH-0002-0002, … */
function sequentialCodes(): () => string {
  let n = 0;
  return () => {
    n += 1;
    const p = String(n).padStart(4, "0");
    return `ATH-${p}-${p}`;
  };
}

describe("referral-code backfill — dry run makes no changes", () => {
  it("reports the candidates and writes nothing", async () => {
    const db = new FakeDb([customer("c-1", null), customer("c-2", "ATH-KEEP-KEEP")]);
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    const result = await runReferralCodeBackfill({
      db,
      transactor: db,
      metafieldEnqueuer: enqueuer,
      generate: sequentialCodes(),
      // apply omitted entirely — dry run must be the DEFAULT, not opt-in.
    });

    expect(result.mode).toBe("dry_run");
    expect(result.scanned).toBe(1);
    expect(result.candidates).toEqual([{ customerId: "c-1", shopifyCustomerId: "900000000001" }]);
    expect(result.assigned).toEqual([]);
    // Nothing written, nothing enqueued.
    expect(db.customers.find((c) => c.id === "c-1")?.referral_code).toBeNull();
    expect(enqueuer.jobs).toEqual([]);
  });

  it("refuses to apply without a transactor rather than silently dry-running", async () => {
    const db = new FakeDb([customer("c-1", null)]);

    await expect(runReferralCodeBackfill({ db, apply: true })).rejects.toThrow(/refusing/i);
    expect(db.customers[0]?.referral_code).toBeNull();
  });
});

describe("referral-code backfill — apply creates codes only for missing customers", () => {
  it("assigns to the null customers and leaves the others untouched", async () => {
    const db = new FakeDb([
      customer("c-1", null),
      customer("c-2", "ATH-KEEP-KEEP"),
      customer("c-3", null),
    ]);
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    const result = await runReferralCodeBackfill({
      db,
      transactor: db,
      metafieldEnqueuer: enqueuer,
      apply: true,
      generate: sequentialCodes(),
    });

    expect(result.mode).toBe("apply");
    expect(result.scanned).toBe(2);
    expect(result.created).toBe(2);
    expect(result.failures).toEqual([]);
    expect(db.customers.find((c) => c.id === "c-1")?.referral_code).toBe("ATH-0001-0001");
    expect(db.customers.find((c) => c.id === "c-3")?.referral_code).toBe("ATH-0002-0002");
    // The pre-existing code is byte-identical.
    expect(db.customers.find((c) => c.id === "c-2")?.referral_code).toBe("ATH-KEEP-KEEP");
    // A refresh per CREATED code, and none for the customer that already had one.
    expect(enqueuer.jobs).toEqual([{ customerId: "c-1" }, { customerId: "c-3" }]);
  });

  it("assigns every code in the ATH-XXXX-XXXX shape by default", async () => {
    const db = new FakeDb([customer("c-1", null)]);

    await runReferralCodeBackfill({ db, transactor: db, apply: true });

    expect(db.customers[0]?.referral_code).toMatch(/^ATH-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe("referral-code backfill — rerun creates nothing", () => {
  it("is a complete no-op the second time", async () => {
    const db = new FakeDb([customer("c-1", null), customer("c-2", null)]);
    const enqueuer = new RecordingMetafieldCacheEnqueuer();
    const opts = {
      db,
      transactor: db,
      metafieldEnqueuer: enqueuer,
      apply: true,
      generate: sequentialCodes(),
    };

    const first = await runReferralCodeBackfill(opts);
    expect(first.created).toBe(2);
    const codesAfterFirst = db.customers.map((c) => c.referral_code);

    const second = await runReferralCodeBackfill({ ...opts, generate: sequentialCodes() });

    expect(second.scanned).toBe(0);
    expect(second.assigned).toEqual([]);
    expect(second.created).toBe(0);
    // No code rotated, and no second refresh enqueued.
    expect(db.customers.map((c) => c.referral_code)).toEqual(codesAfterFirst);
    expect(enqueuer.jobs).toHaveLength(2);
  });
});

describe("referral-code backfill — existing codes are never modified", () => {
  it("never touches a customer that already has a code, even across reruns", async () => {
    const db = new FakeDb([
      customer("c-1", "ATH-AAAA-AAAA"),
      customer("c-2", "ATH-BBBB-BBBB"),
      customer("c-3", null),
    ]);

    await runReferralCodeBackfill({ db, transactor: db, apply: true, generate: sequentialCodes() });
    await runReferralCodeBackfill({ db, transactor: db, apply: true, generate: sequentialCodes() });

    expect(db.customers.find((c) => c.id === "c-1")?.referral_code).toBe("ATH-AAAA-AAAA");
    expect(db.customers.find((c) => c.id === "c-2")?.referral_code).toBe("ATH-BBBB-BBBB");
    expect(db.customers.find((c) => c.id === "c-3")?.referral_code).toBe("ATH-0001-0001");
  });

  it("cannot overwrite a code that appears between the SELECT and the UPDATE", async () => {
    const db = new FakeDb([customer("c-1", null)]);
    // The signup webhook assigns a code after we selected the row as NULL.
    db.onBeforeUpdate = (id) => {
      const row = db.customers.find((c) => c.id === id);
      if (row && row.referral_code === null) {
        row.referral_code = "ATH-RACE-WINS";
      }
    };

    const result = await runReferralCodeBackfill({
      db,
      transactor: db,
      apply: true,
      generate: sequentialCodes(),
    });

    // The guarded UPDATE matched no row, so the racer's code stands.
    expect(db.customers[0]?.referral_code).toBe("ATH-RACE-WINS");
    expect(result.assigned).toEqual([
      {
        customerId: "c-1",
        shopifyCustomerId: "900000000001",
        referralCode: "ATH-RACE-WINS",
        createdByThisRun: false,
        cacheRefreshEnqueued: false,
      },
    ]);
    expect(result.created).toBe(0);
    expect(result.wonByConcurrentWriter).toBe(1);
  });
});

describe("referral-code backfill — concurrent execution cannot assign two codes", () => {
  it("two simultaneous runs leave exactly one code, and agree on it", async () => {
    const db = new FakeDb([customer("c-1", null), customer("c-2", null)]);

    // Distinct candidate spaces per run, mirroring the real random generator —
    // two independent runs realistically never offer the same string. (What
    // happens when they DO is pinned by the next test.)
    const prefixed = (tag: string): (() => string) => {
      let n = 0;
      return () => {
        n += 1;
        return `ATH-${tag}${String(n).padStart(2, "0")}-${tag}${String(n).padStart(2, "0")}`;
      };
    };

    // Both runs select the same NULL rows, then interleave their updates.
    const [a, b] = await Promise.all([
      runReferralCodeBackfill({ db, transactor: db, apply: true, generate: prefixed("AA") }),
      runReferralCodeBackfill({ db, transactor: db, apply: true, generate: prefixed("BB") }),
    ]);

    for (const id of ["c-1", "c-2"]) {
      const code = db.customers.find((c) => c.id === id)?.referral_code;
      expect(code).toMatch(/^ATH-/);
      // Both runs report the SAME effective code for the customer — one created
      // it, the other observed it. Neither invents a competing value.
      const fromA = a.assigned.find((x) => x.customerId === id)?.referralCode;
      const fromB = b.assigned.find((x) => x.customerId === id)?.referralCode;
      expect(fromA).toBe(code);
      expect(fromB).toBe(code);
    }

    // Exactly one of the two runs created each code.
    expect(a.created + b.created).toBe(2);
    expect(a.wonByConcurrentWriter + b.wonByConcurrentWriter).toBe(2);
    // And no duplicate codes exist anywhere.
    const codes = db.customers.map((c) => c.referral_code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("still assigns exactly one code when both runs offer the IDENTICAL candidate", async () => {
    // Pathological case: identical deterministic generators. Provenance
    // reporting becomes ambiguous (documented on `createdByThisRun`), but the
    // guarantees that matter must still hold.
    const db = new FakeDb([customer("c-1", null)]);
    const enqueuer = new RecordingMetafieldCacheEnqueuer();

    const [a, b] = await Promise.all([
      runReferralCodeBackfill({
        db,
        transactor: db,
        metafieldEnqueuer: enqueuer,
        apply: true,
        generate: sequentialCodes(),
      }),
      runReferralCodeBackfill({
        db,
        transactor: db,
        metafieldEnqueuer: enqueuer,
        apply: true,
        generate: sequentialCodes(),
      }),
    ]);

    // ONE code on the row, and both runs report that same code.
    expect(db.customers[0]?.referral_code).toBe("ATH-0001-0001");
    expect(a.assigned[0]?.referralCode).toBe("ATH-0001-0001");
    expect(b.assigned[0]?.referralCode).toBe("ATH-0001-0001");
    expect(a.failures).toEqual([]);
    expect(b.failures).toEqual([]);
    // The only cost of the ambiguity is a possibly-redundant refresh for the
    // SAME customer — which pg-boss coalesces on singletonKey. Never a second
    // code, and never a different one.
    for (const job of enqueuer.jobs) {
      expect(job).toEqual({ customerId: "c-1" });
    }
  });

  it("retries past a code collision with another customer", async () => {
    const db = new FakeDb([customer("c-1", "ATH-0001-0001"), customer("c-2", null)]);

    // The generator's first candidate is already taken by c-1 → unique violation
    // → assignReferralCode retries with the next one.
    await runReferralCodeBackfill({
      db,
      transactor: db,
      apply: true,
      generate: sequentialCodes(),
    });

    expect(db.customers.find((c) => c.id === "c-2")?.referral_code).toBe("ATH-0002-0002");
    expect(db.customers.find((c) => c.id === "c-1")?.referral_code).toBe("ATH-0001-0001");
  });
});

describe("referral-code backfill — cache refresh is best-effort", () => {
  it("records an enqueue failure without losing the committed code", async () => {
    const db = new FakeDb([customer("c-1", null)]);
    const enqueuer = new ThrowingEnqueuer();

    const result = await runReferralCodeBackfill({
      db,
      transactor: db,
      metafieldEnqueuer: enqueuer,
      apply: true,
      generate: sequentialCodes(),
    });

    // The code is assigned and durable; only the display refresh failed.
    expect(db.customers[0]?.referral_code).toBe("ATH-0001-0001");
    expect(result.created).toBe(1);
    expect(result.cacheEnqueueFailures).toBe(1);
    expect(result.cacheRefreshesEnqueued).toBe(0);
    expect(result.assigned[0]?.cacheRefreshEnqueued).toBe(false);
    expect(enqueuer.attempts).toEqual([{ customerId: "c-1" }]);
  });

  it("assigns codes with no enqueuer wired at all (non-Shopify boot)", async () => {
    const db = new FakeDb([customer("c-1", null)]);

    const result = await runReferralCodeBackfill({
      db,
      transactor: db,
      apply: true,
      generate: sequentialCodes(),
    });

    expect(db.customers[0]?.referral_code).toBe("ATH-0001-0001");
    expect(result.cacheRefreshesEnqueued).toBe(0);
    expect(result.cacheEnqueueFailures).toBe(0);
  });
});

describe("referral-code backfill — one failure does not abort the run", () => {
  it("continues past a customer whose assignment throws", async () => {
    const db = new FakeDb([customer("c-1", null), customer("c-2", null)]);
    const original = db.query.bind(db);
    // Fail every UPDATE for c-1 with a non-unique-violation error.
    db.query = (async (text: string, values: unknown[] = []) => {
      if (text.includes("UPDATE customers") && values[0] === "c-1") {
        throw new Error("connection reset");
      }
      return original(text, values);
    }) as typeof db.query;

    const result = await runReferralCodeBackfill({
      db,
      transactor: db,
      apply: true,
      generate: sequentialCodes(),
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.customerId).toBe("c-1");
    // c-2 still got its code — a per-customer transaction isolates the failure.
    expect(db.customers.find((c) => c.id === "c-2")?.referral_code).toMatch(/^ATH-/);
    expect(result.created).toBe(1);
  });
});
