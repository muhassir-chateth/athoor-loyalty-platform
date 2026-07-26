#!/usr/bin/env node
/**
 * OPERATOR SCRIPT — assign referral codes to members who never got one (task 36).
 *
 * WHY: `assignReferralCode` runs only on the `customers/create` signup webhook,
 * so every member enrolled before that wiring landed has
 * `customers.referral_code IS NULL` permanently. For them `GET /v1/referral`
 * returns null, the Metafield_Cache writer correctly writes no
 * `loyalty.referral_code`, and the dashboard shows the "Preparing your code…"
 * placeholder for ever — they can never refer anyone.
 *
 * GUARANTEES (all enforced by `src/referral/backfillReferralCodes.ts`, which this
 * script is a thin wrapper around — the logic is unit-tested, this file is only
 * argument handling and reporting):
 *   - DRY RUN BY DEFAULT. Pass `--apply` to write.
 *   - ONLY NULL CODES ARE TOUCHED. Selection and the underlying UPDATE are both
 *     guarded `WHERE referral_code IS NULL`, so an existing code cannot be
 *     modified even if it appears mid-run.
 *   - IDEMPOTENT. After a successful apply nothing matches the selection, so a
 *     rerun scans nothing and writes nothing.
 *   - CONCURRENCY-SAFE. Two simultaneous runs (or a run racing the signup
 *     webhook) cannot produce two different codes: the guarded UPDATE loses and
 *     the loser re-reads the winner's code.
 *   - PER-CUSTOMER TRANSACTIONS. One failure neither rolls back nor blocks the
 *     rest; failures are listed at the end.
 *   - OFF-LEDGER. `customers.referral_code` bears no balance. Nothing here reads
 *     or writes `ledger_entries` or `point_lots`.
 *
 * CACHE REFRESH: each CREATED code enqueues a `writeMetafieldCache` job so the
 * storefront's server-rendered fallback stops showing the placeholder. Requires
 * pg-boss; skipped with a notice when `--no-cache-refresh` is passed or pg-boss
 * cannot be started. Best-effort — a queue failure never loses a committed code,
 * and reconciliation converges the cache regardless.
 *
 * RUN RECONCILIATION AFTERWARDS. This script only refreshes the cache for codes
 * it CREATED — by design, since it must not touch customers that already had a
 * code. But a customer who already had a code may still be MISSING the
 * `loyalty.referral_code` metafield, because that key was only added to the cache
 * payload in task 34: their last cache write predates it. Observed exactly that
 * on staging — the two customers with pre-existing codes had no metafield until
 * reconciliation ran. So after applying:
 *
 *     POST /v1/admin/operations/reconciliation
 *
 * which recomputes every customer's cache from the ledger and repairs the drift
 * (Req 13.7). On staging that also converged a `points_balance` that had been
 * stale since before the task-35 fix (50 → 450).
 *
 * USAGE
 *   DATABASE_URL=postgres://... node scripts/backfill-referral-codes.mjs
 *   DATABASE_URL=postgres://... node scripts/backfill-referral-codes.mjs --apply
 *
 * Run `npm run build` first — this imports the compiled service from `dist/`.
 * Set PGSSL_NO_VERIFY=1 for a managed pooler whose cert chain is not locally
 * verifiable (e.g. Supabase).
 */
import pg from "pg";
import PgBoss from "pg-boss";
import { runReferralCodeBackfill } from "../dist/referral/backfillReferralCodes.js";
import {
  METAFIELD_CACHE_JOB,
  PgBossMetafieldCacheEnqueuer,
} from "../dist/shopify/metafieldCache.js";

const APPLY = process.argv.includes("--apply");
const NO_CACHE_REFRESH = process.argv.includes("--no-cache-refresh");
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const ssl = process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined;
const pool = new pg.Pool({ connectionString: DATABASE_URL, ...(ssl ? { ssl } : {}) });

/** Per-customer transaction, so one failure cannot roll back the others. */
const transactor = {
  async transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await work(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
};

let boss;
let metafieldEnqueuer;

try {
  // Only start pg-boss when we are actually going to write; a dry run must touch
  // nothing at all, including the queue.
  if (APPLY && !NO_CACHE_REFRESH) {
    try {
      boss = new PgBoss({ connectionString: DATABASE_URL, ...(ssl ? { ssl } : {}) });
      await boss.start();
      await boss.createQueue(METAFIELD_CACHE_JOB);
      metafieldEnqueuer = new PgBossMetafieldCacheEnqueuer(boss);
    } catch (err) {
      console.warn(
        `WARNING: could not start pg-boss (${err instanceof Error ? err.message : String(err)}).\n` +
          "         Codes will still be assigned; the display cache will be repaired by the\n" +
          "         periodic reconciliation job instead of immediately.",
      );
      boss = undefined;
      metafieldEnqueuer = undefined;
    }
  }

  const result = await runReferralCodeBackfill({
    db: pool,
    transactor,
    ...(metafieldEnqueuer ? { metafieldEnqueuer } : {}),
    apply: APPLY,
  });

  console.log(`Mode                  : ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  console.log(`Customers missing code: ${result.scanned}`);

  if (result.mode === "dry_run") {
    if (result.scanned === 0) {
      console.log("\nNothing to do — every customer already has a referral code.");
    } else {
      console.log("\nWould assign a code to (Shopify customer ids):");
      for (const c of result.candidates) {
        console.log(`  ${c.shopifyCustomerId}  (local ${c.customerId})`);
      }
      console.log("\nDry run only. Re-run with --apply to assign these codes.");
    }
  } else {
    console.log(`Codes created         : ${result.created}`);
    console.log(`Already set by another writer: ${result.wonByConcurrentWriter}`);
    console.log(`Cache refreshes queued: ${result.cacheRefreshesEnqueued}`);
    if (result.cacheEnqueueFailures > 0) {
      console.log(
        `Cache refresh FAILURES: ${result.cacheEnqueueFailures} ` +
          "(codes are committed; reconciliation will repair the cache)",
      );
    }
    for (const a of result.assigned) {
      console.log(
        `  ${a.shopifyCustomerId}  ${a.referralCode}` +
          `${a.createdByThisRun ? "" : "  (assigned concurrently — left as-is)"}` +
          `${a.createdByThisRun && !a.cacheRefreshEnqueued ? "  (cache refresh NOT queued)" : ""}`,
      );
    }
    if (result.failures.length > 0) {
      console.error(`\n${result.failures.length} customer(s) FAILED and were skipped:`);
      for (const f of result.failures) {
        console.error(
          `  ${f.shopifyCustomerId}: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
        );
      }
    }
  }

  // Post-state: the question the operator actually cares about.
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(referral_code)::int AS with_code,
            count(*) FILTER (WHERE referral_code IS NULL)::int AS without_code,
            count(DISTINCT referral_code)::int AS distinct_codes
       FROM customers`,
  );
  const s = rows[0];
  console.log(
    `\nCustomers: ${s.total} total, ${s.with_code} with a code, ${s.without_code} without.`,
  );
  // A duplicate would mean the UNIQUE constraint was bypassed — it cannot be, but
  // report the check so the run is self-evidencing.
  console.log(
    `Distinct codes: ${s.distinct_codes} (must equal ${s.with_code} — duplicates would be a bug).`,
  );
  if (s.distinct_codes !== s.with_code) {
    console.error("ERROR: duplicate referral codes detected.");
    process.exitCode = 1;
  }

  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
} finally {
  if (boss) {
    await boss.stop({ graceful: true, wait: true });
  }
  await pool.end();
}
