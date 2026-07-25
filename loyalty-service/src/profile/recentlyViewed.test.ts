/**
 * Unit + property tests for off-ledger recently-viewed ingestion (task 14.3).
 *
 * Everything is exercised against an in-memory {@link FakeQueryable} and an
 * injectable clock — no live database. The fake records every SQL statement so
 * we can assert exactly which table is touched, proving recently-viewed stays
 * OFF the ledger (Req 17.3/17.5) and that sampling drops writes.
 *
 * Covers:
 *   - a view is recorded/upserted into customer_recently_viewed (Req 17.5);
 *   - entries older than the 90-day window are excluded from the list (A10, Req 17.5);
 *   - prune removes stale entries (Req 11.10);
 *   - rate-limit/sampling: repeat views inside the interval perform no write;
 *   - recordView never writes to ledger_entries (Property 13 / Req 17.3).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_RETENTION_DAYS,
  RecentlyViewedStore,
  RecentlyViewedValidationError,
} from "./recentlyViewed.js";

interface RecordedCall {
  sql: string;
  values: unknown[];
}

/**
 * Minimal in-memory Queryable that records calls and returns canned rows for
 * SELECTs. `deleteRowCount` lets a test simulate how many rows a DELETE removed.
 */
class FakeQueryable {
  readonly calls: RecordedCall[] = [];
  listRows: Array<{ product_id: string; viewed_at: Date }> = [];
  deleteRowCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: string, values: unknown[] = []): Promise<any> {
    this.calls.push({ sql, values });
    const normalised = sql.trim().toUpperCase();
    if (normalised.startsWith("SELECT")) {
      return { rows: this.listRows, rowCount: this.listRows.length };
    }
    if (normalised.startsWith("DELETE")) {
      return { rows: [], rowCount: this.deleteRowCount };
    }
    // INSERT ... ON CONFLICT (upsert)
    return { rows: [], rowCount: 1 };
  }

  callsMatching(fragment: string): RecordedCall[] {
    return this.calls.filter((c) => c.sql.toUpperCase().includes(fragment.toUpperCase()));
  }
}

const CUSTOMER = "11111111-1111-1111-1111-111111111111";

/** A fixed-clock helper returning a mutable "current time". */
function fixedClock(start: Date): { now: () => Date; set: (d: Date) => void } {
  let current = start;
  return { now: () => current, set: (d) => (current = d) };
}

describe("RecentlyViewedStore.recordView", () => {
  it("records a view by upserting into customer_recently_viewed", async () => {
    const db = new FakeQueryable();
    const now = new Date("2025-01-01T00:00:00.000Z");
    const store = new RecentlyViewedStore(db, { now: () => now });

    await store.recordView(CUSTOMER, "555");

    const upserts = db.callsMatching("INSERT INTO customer_recently_viewed");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.sql.toUpperCase()).toContain("ON CONFLICT");
    expect(upserts[0]?.sql.toUpperCase()).toContain("DO UPDATE SET VIEWED_AT");
    expect(upserts[0]?.values).toEqual([CUSTOMER, "555", now]);
  });

  it("never writes to ledger_entries (off-ledger — Property 13)", async () => {
    const db = new FakeQueryable();
    const store = new RecentlyViewedStore(db, { minIntervalMs: 0 });

    await store.recordView(CUSTOMER, "1");
    await store.recordView(CUSTOMER, "2");
    await store.recordView(CUSTOMER, "3");

    expect(db.callsMatching("ledger_entries")).toHaveLength(0);
    // Every statement issued targets only the recently-viewed table.
    for (const call of db.calls) {
      expect(call.sql).toContain("customer_recently_viewed");
    }
  });

  it("upserts (not duplicates) on a repeat view, refreshing viewed_at", async () => {
    const db = new FakeQueryable();
    const clock = fixedClock(new Date("2025-01-01T00:00:00.000Z"));
    // Disable sampling so both accepted writes reach the DB.
    const store = new RecentlyViewedStore(db, { now: clock.now, minIntervalMs: 0 });

    await store.recordView(CUSTOMER, "777");
    clock.set(new Date("2025-02-01T00:00:00.000Z"));
    await store.recordView(CUSTOMER, "777");

    const upserts = db.callsMatching("INSERT INTO customer_recently_viewed");
    expect(upserts).toHaveLength(2);
    // Second upsert carries the newer timestamp and relies on ON CONFLICT to update.
    expect(upserts[1]?.values[2]).toEqual(new Date("2025-02-01T00:00:00.000Z"));
  });

  it("rejects a missing or malformed product id and writes nothing", async () => {
    const db = new FakeQueryable();
    const store = new RecentlyViewedStore(db);

    await expect(store.recordView(CUSTOMER, "")).rejects.toBeInstanceOf(
      RecentlyViewedValidationError,
    );
    await expect(store.recordView(CUSTOMER, "abc")).rejects.toBeInstanceOf(
      RecentlyViewedValidationError,
    );
    await expect(store.recordView(CUSTOMER, "0")).rejects.toBeInstanceOf(
      RecentlyViewedValidationError,
    );
    await expect(store.recordView("", "5")).rejects.toBeInstanceOf(RecentlyViewedValidationError);
    expect(db.calls).toHaveLength(0);
  });
});

describe("RecentlyViewedStore rate-limit / sampling", () => {
  it("samples out a repeat view of the same product within the interval (no write)", async () => {
    const db = new FakeQueryable();
    const clock = fixedClock(new Date("2025-01-01T00:00:00.000Z"));
    const store = new RecentlyViewedStore(db, { now: clock.now, minIntervalMs: 60_000 });

    await store.recordView(CUSTOMER, "42"); // accepted
    clock.set(new Date("2025-01-01T00:00:30.000Z")); // +30s, inside 60s window
    await store.recordView(CUSTOMER, "42"); // sampled out

    expect(db.callsMatching("INSERT INTO customer_recently_viewed")).toHaveLength(1);
  });

  it("accepts a repeat view once the interval has elapsed", async () => {
    const db = new FakeQueryable();
    const clock = fixedClock(new Date("2025-01-01T00:00:00.000Z"));
    const store = new RecentlyViewedStore(db, { now: clock.now, minIntervalMs: 60_000 });

    await store.recordView(CUSTOMER, "42"); // accepted
    clock.set(new Date("2025-01-01T00:01:00.000Z")); // +60s, at the boundary
    await store.recordView(CUSTOMER, "42"); // accepted again

    expect(db.callsMatching("INSERT INTO customer_recently_viewed")).toHaveLength(2);
  });

  it("throttles per (customer, product): different products are not throttled together", async () => {
    const db = new FakeQueryable();
    const clock = fixedClock(new Date("2025-01-01T00:00:00.000Z"));
    const store = new RecentlyViewedStore(db, { now: clock.now, minIntervalMs: 60_000 });

    await store.recordView(CUSTOMER, "1"); // accepted
    await store.recordView(CUSTOMER, "2"); // accepted (different product)
    await store.recordView(CUSTOMER, "1"); // sampled out (same product, same instant)

    expect(db.callsMatching("INSERT INTO customer_recently_viewed")).toHaveLength(2);
  });

  it("property: within a fixed instant, each product is written at most once per interval", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 40 }),
        async (productNumbers) => {
          const db = new FakeQueryable();
          const now = new Date("2025-01-01T00:00:00.000Z");
          const store = new RecentlyViewedStore(db, { now: () => now, minIntervalMs: 60_000 });

          for (const n of productNumbers) {
            await store.recordView(CUSTOMER, String(n));
          }

          const writes = db.callsMatching("INSERT INTO customer_recently_viewed");
          const distinctProducts = new Set(productNumbers.map(String)).size;
          // All views share one instant, so only the first per product is written.
          expect(writes).toHaveLength(distinctProducts);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("RecentlyViewedStore.listRecentlyViewed", () => {
  it("queries with the 90-day retention cutoff and returns entries most-recent-first", async () => {
    const db = new FakeQueryable();
    const now = new Date("2025-06-01T00:00:00.000Z");
    const store = new RecentlyViewedStore(db, { now: () => now });
    db.listRows = [
      { product_id: "9", viewed_at: new Date("2025-05-31T00:00:00.000Z") },
      { product_id: "8", viewed_at: new Date("2025-05-01T00:00:00.000Z") },
    ];

    const entries = await store.listRecentlyViewed(CUSTOMER);

    const selects = db.callsMatching("SELECT");
    expect(selects).toHaveLength(1);
    // The cutoff passed to SQL excludes anything older than the window.
    const cutoff = selects[0]?.values[1] as Date;
    const expectedCutoff = new Date(now.getTime() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(cutoff.getTime()).toBe(expectedCutoff.getTime());
    expect(selects[0]?.sql.toUpperCase()).toContain("VIEWED_AT >");
    expect(selects[0]?.sql.toUpperCase()).toContain("ORDER BY VIEWED_AT DESC");
    expect(entries).toEqual([
      { productId: "9", viewedAt: new Date("2025-05-31T00:00:00.000Z") },
      { productId: "8", viewedAt: new Date("2025-05-01T00:00:00.000Z") },
    ]);
  });

  it("excludes entries older than the retention window (the DB filter is driven by the cutoff)", async () => {
    // The SQL filter `viewed_at > cutoff` is what enforces exclusion; verify the
    // cutoff moves with the clock so a stale entry falls outside the window.
    const db = new FakeQueryable();
    const clock = fixedClock(new Date("2025-06-01T00:00:00.000Z"));
    const store = new RecentlyViewedStore(db, { now: clock.now, retentionDays: 90 });

    await store.listRecentlyViewed(CUSTOMER);
    const firstCutoff = db.callsMatching("SELECT")[0]?.values[1] as Date;

    // A view from 100 days before "now" is older than the 90-day cutoff.
    const staleView = new Date(clock.now().getTime() - 100 * 24 * 60 * 60 * 1000);
    expect(staleView.getTime()).toBeLessThan(firstCutoff.getTime());
    // A view from 30 days before "now" is inside the window.
    const freshView = new Date(clock.now().getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(freshView.getTime()).toBeGreaterThan(firstCutoff.getTime());
  });

  it("returns an empty array when there are no in-window entries (no error)", async () => {
    const db = new FakeQueryable();
    const store = new RecentlyViewedStore(db, { now: () => new Date("2025-06-01T00:00:00.000Z") });
    db.listRows = [];

    await expect(store.listRecentlyViewed(CUSTOMER)).resolves.toEqual([]);
  });
});

describe("RecentlyViewedStore.prune", () => {
  it("deletes entries older than the retention window for a single customer", async () => {
    const db = new FakeQueryable();
    const now = new Date("2025-06-01T00:00:00.000Z");
    const store = new RecentlyViewedStore(db, { now: () => now });
    db.deleteRowCount = 3;

    const deleted = await store.prune(CUSTOMER);

    const deletes = db.callsMatching("DELETE FROM customer_recently_viewed");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.sql.toUpperCase()).toContain("VIEWED_AT <=");
    expect(deletes[0]?.sql.toUpperCase()).toContain("CUSTOMER_ID =");
    const cutoff = deletes[0]?.values[0] as Date;
    const expectedCutoff = new Date(now.getTime() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(cutoff.getTime()).toBe(expectedCutoff.getTime());
    expect(deletes[0]?.values[1]).toBe(CUSTOMER);
    expect(deleted).toBe(3);
  });

  it("prunes across all customers when no customer id is given", async () => {
    const db = new FakeQueryable();
    const now = new Date("2025-06-01T00:00:00.000Z");
    const store = new RecentlyViewedStore(db, { now: () => now });
    db.deleteRowCount = 7;

    const deleted = await store.prune();

    const deletes = db.callsMatching("DELETE FROM customer_recently_viewed");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.sql.toUpperCase()).not.toContain("CUSTOMER_ID =");
    expect(deletes[0]?.values).toHaveLength(1); // cutoff only
    expect(deleted).toBe(7);
  });

  it("never touches the ledger while pruning", async () => {
    const db = new FakeQueryable();
    const store = new RecentlyViewedStore(db, { now: () => new Date("2025-06-01T00:00:00.000Z") });

    await store.prune(CUSTOMER);

    expect(db.callsMatching("ledger_entries")).toHaveLength(0);
  });
});
