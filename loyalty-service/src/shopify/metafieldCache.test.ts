/**
 * Unit + property tests for the metafield cache writer (task 6.6).
 *
 * NO live/production Shopify Admin API is touched: the writer is exercised
 * against a fake {@link CustomerMetafieldClient} that stores the "current"
 * metafield value in memory and can be scripted to fail per-attempt, plus a
 * fake {@link Sleeper} that records backoff delays without waiting and a fake
 * {@link Queryable} DB that serves ledger-derived rows.
 *
 * Covers:
 *   - the snapshot is DERIVED FROM THE LEDGER (spendable lots + ledger sum) and
 *     the tier model — Req 13.1;
 *   - a successful write mirrors the derived `loyalty.*` metafields — Req 15.5;
 *   - a transient failure is retried with the exact backoff schedule then
 *     succeeds — Req 13.5;
 *   - total failure is NON-FATAL: last known-good is preserved and the failure
 *     is recorded for reconciliation — Req 13.5 / 15.6;
 *   - the ≤3-retry preserve-last-known-good path — Req 15.6;
 *   - an unknown customer is skipped (non-fatal);
 *   - the enqueue happens off the request path and no Admin API is called inline.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import type { Sleeper } from "./adminGateway.js";
import {
  customerGid,
  deriveCacheSnapshot,
  InMemoryFailureRecorder,
  LOYALTY_METAFIELD_NAMESPACE,
  METAFIELD_BACKOFF,
  MetafieldCacheWriter,
  PRESERVE_LAST_KNOWN_GOOD_MAX_ATTEMPTS,
  processMetafieldCacheJob,
  RecordingMetafieldCacheEnqueuer,
  registerMetafieldCacheWorker,
  snapshotToMetafields,
  type CacheSnapshot,
  type CustomerMetafieldClient,
  type MetafieldCacheJob,
  type MetafieldWriteInput,
} from "./metafieldCache.js";

/* --------------------------------- fakes ---------------------------------- */

/** A fake Admin metafield client: stores the last written value; fails on scripted attempts. */
class FakeMetafieldClient implements CustomerMetafieldClient {
  calls = 0;
  /** The "current" metafield value in Shopify, keyed by customerGid. */
  readonly stored = new Map<string, MetafieldWriteInput["metafields"]>();
  /** 1-based attempt numbers on which the client should throw. */
  private readonly failOn: Set<number>;

  constructor(failOnAttempts: number[] = []) {
    this.failOn = new Set(failOnAttempts);
  }

  async writeCustomerMetafields(input: MetafieldWriteInput): Promise<void> {
    this.calls += 1;
    if (this.failOn.has(this.calls)) {
      throw new Error(`fake admin metafield write failure on attempt ${this.calls}`);
    }
    this.stored.set(input.customerGid, input.metafields);
  }
}

/** A recording sleeper that never actually waits. */
function recordingSleeper(): { sleep: Sleeper; delays: number[] } {
  const delays: number[] = [];
  return {
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    delays,
  };
}

/**
 * A tiny fake DB serving the three reads {@link deriveCacheSnapshot} performs:
 * the customer row, the ledger balance sum, and the spendable-lots sum.
 */
function fakeDb(opts: {
  customer?: { shopify_customer_id: number; tier: string; lifetime_spend_gbp: string };
  balance: number;
  spendable: number;
}): Queryable {
  return {
    async query<R extends QueryResultRow>(text: string): Promise<QueryResult<R>> {
      let rows: QueryResultRow[] = [];
      if (text.includes("FROM customers")) {
        rows = opts.customer ? [opts.customer] : [];
      } else if (text.includes("SUM(points)")) {
        rows = [{ balance: String(opts.balance) }];
      } else if (text.includes("SUM(remaining_points)")) {
        rows = [{ spendable: String(opts.spendable) }];
      }
      return { rows: rows as R[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
}

const SNAPSHOT: CacheSnapshot = {
  pointsBalance: 150,
  balance: 200,
  tier: "silver",
  lifetimeSpendGBP: 350,
  progressToNextTierGBP: 400,
  computedAt: "2025-01-01T00:00:00.000Z",
};

/* ------------------------------ snapshot map ------------------------------ */

describe("snapshotToMetafields (Req 15.5)", () => {
  it("mirrors the derived snapshot into loyalty.* metafields", () => {
    const fields = snapshotToMetafields(SNAPSHOT);
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

    expect(fields.every((f) => f.namespace === LOYALTY_METAFIELD_NAMESPACE)).toBe(true);
    expect(byKey.points_balance).toMatchObject({ type: "number_integer", value: "150" });
    expect(byKey.lifetime_points).toMatchObject({ type: "number_integer", value: "200" });
    expect(byKey.tier).toMatchObject({ type: "single_line_text_field", value: "silver" });
    expect(byKey.lifetime_spend_gbp).toMatchObject({ type: "number_decimal", value: "350.00" });
    expect(byKey.tier_progress_gbp).toMatchObject({ type: "number_decimal", value: "400.00" });
    expect(byKey.updated_at?.value).toBe("2025-01-01T00:00:00.000Z");
  });

  it("omits tier_progress_gbp at the top tier (null progress)", () => {
    const top: CacheSnapshot = { ...SNAPSHOT, tier: "royal_vip", progressToNextTierGBP: null };
    const keys = snapshotToMetafields(top).map((f) => f.key);
    expect(keys).not.toContain("tier_progress_gbp");
  });
});

/* ------------------------------ derive (13.1) ----------------------------- */

describe("deriveCacheSnapshot (Req 13.1 — ledger is source of truth)", () => {
  it("derives points_balance from spendable lots and balance from the ledger sum", async () => {
    const db = fakeDb({
      customer: { shopify_customer_id: 555, tier: "bronze", lifetime_spend_gbp: "350.00" },
      balance: 200,
      spendable: 150,
    });

    const asOf = new Date("2025-01-01T00:00:00.000Z");
    const derived = await deriveCacheSnapshot("cust-1", db, asOf);

    expect(derived).not.toBeNull();
    expect(derived?.shopifyCustomerId).toBe(555);
    expect(derived?.snapshot.pointsBalance).toBe(150);
    expect(derived?.snapshot.balance).toBe(200);
    // Tier is derived from lifetime spend (£350 → silver), never lowered below the row's tier.
    expect(derived?.snapshot.tier).toBe("silver");
    expect(derived?.snapshot.lifetimeSpendGBP).toBe(350);
    expect(derived?.snapshot.computedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns null for an unknown customer", async () => {
    const db = fakeDb({ balance: 0, spendable: 0 });
    expect(await deriveCacheSnapshot("nope", db)).toBeNull();
  });
});

/* ------------------------------- writer ----------------------------------- */

describe("MetafieldCacheWriter", () => {
  it("writes the derived cache on the first try (Req 15.5)", async () => {
    const client = new FakeMetafieldClient();
    const writer = new MetafieldCacheWriter(client);
    const gid = customerGid(555);

    const outcome = await writer.write(gid, SNAPSHOT);

    expect(outcome.status).toBe("written");
    expect(client.calls).toBe(1);
    const stored = client.stored.get(gid);
    expect(stored?.find((f) => f.key === "points_balance")?.value).toBe("150");
    expect(writer.getLastKnownGood(gid)).toEqual(SNAPSHOT);
  });

  it("retries a transient failure with the 1s-doubling backoff then succeeds (Req 13.5)", async () => {
    const client = new FakeMetafieldClient([1, 2]); // fail attempts 1 & 2, succeed on 3
    const { sleep, delays } = recordingSleeper();
    const writer = new MetafieldCacheWriter(client, { sleep });

    const outcome = await writer.write(customerGid(555), SNAPSHOT);

    expect(outcome.status).toBe("written");
    expect(client.calls).toBe(3);
    // Backoff after attempt 1 → 1000ms, after attempt 2 → 2000ms (Req 13.5).
    expect(delays).toEqual([1000, 2000]);
  });

  it("caps the write at 5 attempts and is NON-FATAL, recording the failure (Req 13.5/15.6)", async () => {
    const client = new FakeMetafieldClient([1, 2, 3, 4, 5]); // always fail
    const { sleep, delays } = recordingSleeper();
    const recorder = new InMemoryFailureRecorder();
    const writer = new MetafieldCacheWriter(client, { sleep, recorder });

    const outcome = await writer.write(customerGid(555), SNAPSHOT);

    expect(outcome.status).toBe("preserved_last_known_good");
    expect(client.calls).toBe(METAFIELD_BACKOFF.maxAttempts);
    expect(client.calls).toBe(5);
    // 4 backoff sleeps between 5 attempts, doubling and capped at 60s.
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    // Failure recorded for reconciliation (Req 15.6).
    expect(recorder.failures).toHaveLength(1);
    expect(recorder.failures[0]?.customerGid).toBe(customerGid(555));
  });

  it("preserves the last known-good value when a later write fails (Req 15.6)", async () => {
    // Attempt 1 (call 1) succeeds; a later write fails all its attempts.
    const client = new FakeMetafieldClient([2, 3, 4]); // calls 2..4 fail
    const { sleep } = recordingSleeper();
    const recorder = new InMemoryFailureRecorder();
    const writer = new MetafieldCacheWriter(client, { sleep, recorder });
    const gid = customerGid(555);

    // First write succeeds and becomes the last known-good cache value.
    const good: CacheSnapshot = { ...SNAPSHOT, pointsBalance: 100 };
    await writer.write(gid, good);
    const storedAfterGood = client.stored.get(gid);

    // Second write (a newer snapshot) fails all 3 attempts of the preserve path.
    const newer: CacheSnapshot = { ...SNAPSHOT, pointsBalance: 175 };
    const outcome = await writer.write(gid, newer, {
      maxAttempts: PRESERVE_LAST_KNOWN_GOOD_MAX_ATTEMPTS,
    });

    expect(outcome.status).toBe("preserved_last_known_good");
    if (outcome.status === "preserved_last_known_good") {
      expect(outcome.attempts).toBe(3);
      expect(outcome.lastKnownGood).toEqual(good);
    }
    // The stored metafield value is UNCHANGED — the good value is preserved.
    expect(client.stored.get(gid)).toEqual(storedAfterGood);
    expect(client.stored.get(gid)?.find((f) => f.key === "points_balance")?.value).toBe("100");
    expect(recorder.failures).toHaveLength(1);
    expect(recorder.failures[0]?.lastKnownGood).toEqual(good);
  });
});

/* ------------------------------- worker ----------------------------------- */

describe("processMetafieldCacheJob", () => {
  it("derives from the ledger and writes the cache (Req 13.1/15.5)", async () => {
    const db = fakeDb({
      customer: { shopify_customer_id: 555, tier: "bronze", lifetime_spend_gbp: "350.00" },
      balance: 200,
      spendable: 150,
    });
    const client = new FakeMetafieldClient();
    const writer = new MetafieldCacheWriter(client);

    const outcome = await processMetafieldCacheJob("cust-1", {
      writer,
      db,
      now: () => new Date("2025-01-01T00:00:00.000Z"),
    });

    expect(outcome.status).toBe("written");
    const stored = client.stored.get(customerGid(555));
    expect(stored?.find((f) => f.key === "points_balance")?.value).toBe("150");
    expect(stored?.find((f) => f.key === "tier")?.value).toBe("silver");
  });

  it("is non-fatal on write failure: preserves last known-good (Req 13.5/15.6)", async () => {
    const db = fakeDb({
      customer: { shopify_customer_id: 555, tier: "bronze", lifetime_spend_gbp: "0.00" },
      balance: 50,
      spendable: 50,
    });
    const client = new FakeMetafieldClient([1, 2, 3, 4, 5]); // always fail
    const { sleep } = recordingSleeper();
    const writer = new MetafieldCacheWriter(client, { sleep });

    const outcome = await processMetafieldCacheJob("cust-1", { writer, db });

    expect(outcome.status).toBe("preserved_last_known_good");
  });

  it("skips an unknown customer (non-fatal)", async () => {
    const db = fakeDb({ balance: 0, spendable: 0 });
    const client = new FakeMetafieldClient();
    const writer = new MetafieldCacheWriter(client);

    const outcome = await processMetafieldCacheJob("ghost", { writer, db });

    expect(outcome.status).toBe("skipped_unknown_customer");
    expect(client.calls).toBe(0);
  });
});

/* --------------------------- enqueue + register --------------------------- */

describe("enqueue + worker registration (off the request path, Req 13.2/15.2)", () => {
  it("records an enqueued cache-refresh job without calling the Admin API", async () => {
    const enqueuer = new RecordingMetafieldCacheEnqueuer();
    await enqueuer.enqueueMetafieldCache({ customerId: "cust-1" });
    expect(enqueuer.jobs).toEqual([{ customerId: "cust-1" }]);
  });

  it("registers a worker that processes delivered jobs", async () => {
    const db = fakeDb({
      customer: { shopify_customer_id: 555, tier: "bronze", lifetime_spend_gbp: "0.00" },
      balance: 50,
      spendable: 50,
    });
    const client = new FakeMetafieldClient();
    const writer = new MetafieldCacheWriter(client);

    type Handler = (jobs: Array<{ data: MetafieldCacheJob }>) => Promise<void>;
    const captured: { name: string; handler: Handler | undefined } = {
      name: "",
      handler: undefined,
    };
    const consumer = {
      async work(name: string, h: Handler) {
        captured.name = name;
        captured.handler = h;
        return "job-id";
      },
    };

    await registerMetafieldCacheWorker(consumer, { writer, db });
    expect(captured.name).toBe("writeMetafieldCache");

    // Deliver a job and confirm the cache was written.
    await captured.handler?.([{ data: { customerId: "cust-1" } }]);
    expect(client.stored.get(customerGid(555))).toBeDefined();
  });
});

/* ------------------------------ property test ----------------------------- */

describe("MetafieldCacheWriter properties", () => {
  it("is non-fatal for any failure pattern: never rejects, and success iff a non-failing attempt exists", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A boolean per attempt: true = that attempt fails.
        fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 1, max: 5 }),
        async (failPattern, maxAttempts) => {
          const failOn = failPattern
            .map((fail, i) => (fail ? i + 1 : 0))
            .filter((n) => n > 0);
          const client = new FakeMetafieldClient(failOn);
          const { sleep } = recordingSleeper();
          const writer = new MetafieldCacheWriter(client, { sleep });

          // Never rejects — the cache write is non-fatal (Req 13.5).
          const outcome = await writer.write(customerGid(1), SNAPSHOT, { maxAttempts });

          // Success iff at least one of the first `maxAttempts` attempts does not
          // fail. An attempt beyond the fail-pattern length always succeeds.
          const anySucceeds = Array.from(
            { length: maxAttempts },
            (_, i) => (i < failPattern.length ? failPattern[i] : false),
          ).some((fail) => !fail);
          expect(outcome.status).toBe(anySucceeds ? "written" : "preserved_last_known_good");
        },
      ),
      { numRuns: 200 },
    );
  });
});
