#!/usr/bin/env node
/**
 * OPERATOR SCRIPT — Migration Phase M1: ledger backfill & reconciliation.
 *
 * Runs the real `runM1Backfill` against the real `LedgerRepository` and a real
 * `pg` transactor (BEGIN / COMMIT / ROLLBACK), seeded ONLY from the M0 backup
 * file. It touches Postgres and never Shopify (Req 14.4–14.7). The whole cohort
 * plus reconciliation runs in ONE transaction, so an abort leaves no partial
 * ledger state.
 *
 * PREREQUISITE: `npm run build` — this script imports the compiled service from
 * `dist/`.
 *
 * SECRETS: `DATABASE_URL` is read from the environment only — never as an
 * argument, because a connection string contains a password and arguments are
 * visible in shell history and in `ps`.
 *
 * ENVIRONMENT GUARD: this is a WRITE phase, so `assertEnvironmentIdentity` runs
 * BEFORE the connection pool is even opened. The operator must STATE
 * `--environment`, and every independent signal (shop domain, DATABASE_URL host)
 * must agree with the statement; a production run must additionally confirm the
 * database fingerprint with `--confirm-db-fingerprint`. Nothing is inferred —
 * `loyalty-service/.env` declares `NODE_ENV=production` while pointing at the
 * STAGING store and the dev database, which is exactly the trap this closes.
 *
 * STORE GUARD: M1 writes no Shopify data, but it DOES write the ledger that
 * serves a specific store. The backup's `storeDomain` must equal `--store`, so a
 * staging backup can never be backfilled into the production ledger (or the
 * reverse). Targeting the production store still requires
 * `--confirm-production-store`.
 *
 * Exit codes: 0 `backfilled`; 3 `aborted_reconciliation_mismatch` /
 * `aborted_backfill_error`; 2 usage/guard failure; 4 unexpected error.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import {
  finish,
  parseArgs,
  positiveInt,
  printBlock,
  requireSecretFromEnv,
  resolveTargetStore,
  runMain,
  usage,
} from "./_shared.mjs";
import { assertEnvironmentIdentity } from "./_envIdentity.mjs";
import { runM1Backfill } from "../../dist/migration/m1Backfill.js";
import { LedgerRepository } from "../../dist/ledger/repository.js";

const USAGE = `
M1 — ledger backfill & reconciliation (writes Postgres, never Shopify)

  node scripts/migration/m1-backfill.mjs \\
    --backup <path to m0-metafield-export-*.json> \\
    --store <shop.myshopify.com> \\
    --environment production|staging|development \\
    --total-expected <n> --enrolled-expected <n> \\
    [--db-ssl-no-verify] \\
    [--confirm-production-store <shop.myshopify.com>] \\
    [--confirm-db-fingerprint <fingerprint>]

Required environment
  DATABASE_URL   Postgres connection string. NEVER passed as an argument.

Notes
  * Run \`npm run build\` first — this script imports from dist/.
  * --environment is REQUIRED and has no default. This phase WRITES, so the run
    ABORTS if the stated environment disagrees with the target shop domain or
    with DATABASE_URL. NODE_ENV is reported but never trusted, because
    loyalty-service/.env sets it to "production" while pointing at the staging
    store and the dev database.
  * --confirm-db-fingerprint is REQUIRED for --environment production: a write
    phase must be aimed at a database the operator has actually looked at. The
    guard prints the fingerprint of the currently configured database when the
    flag is missing, so it cannot be satisfied by an inherited .env.
  * --total-expected and --enrolled-expected are REQUIRED and have no defaults,
    exactly as in m0-export.mjs. State the cohort you verified against the store
    immediately before the run; the backfill ABORTS if the backup disagrees, which
    is the intended protection against backfilling an unexpected cohort.
  * --db-ssl-no-verify sets ssl.rejectUnauthorized = false, for a managed pooler
    whose certificate chain is not locally verifiable (e.g. Supabase).
  * The backup's storeDomain must match --store; a mismatch refuses the run.
  * Legacy balances are converted by the owner-approved rules (refund
    normalisation, then customer-safe upward rounding). The per-customer output
    prints the legacy value, both adjustments and the rule applied.
  * Idempotent: a second run reports created: 0 and skips the cohort.
  * Every abort has already rolled the transaction back — the ledger is
    unchanged and the backup file remains authoritative.
`;

await runMain(async () => {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(USAGE);
    process.exit(0);
  }

  const store = resolveTargetStore({ args, usageText: USAGE });
  const databaseUrl = requireSecretFromEnv({
    args,
    envNames: ["DATABASE_URL"],
    argAliases: ["database-url", "db-url", "connection-string"],
    what: "the Postgres connection string",
    usageText: USAGE,
  });

  const backupPath = args.backup;
  if (!backupPath || backupPath === true) {
    usage("--backup <file> is required (the M0 export is the only source of truth).", USAGE);
  }

  const raw = await readFile(resolve(String(backupPath)), "utf8");
  let backup;
  try {
    backup = JSON.parse(raw);
  } catch {
    usage(`--backup file "${backupPath}" is not valid JSON.`, USAGE);
  }

  if (backup.kind !== "m0-metafield-export") {
    usage(
      `--backup file is not an M0 export (kind: "${String(backup.kind)}"). Refusing to backfill ` +
        `from an unrecognised file.`,
      USAGE,
    );
  }
  if (String(backup.storeDomain).toLowerCase() !== store) {
    usage(
      `backup storeDomain "${backup.storeDomain}" does not match --store "${store}". Refusing ` +
        `to backfill one store's ledger from another store's export.`,
      USAGE,
    );
  }

  // MANDATORY, no fallback — mirrors m0-export.mjs. The cohort must be a fresh,
  // conscious assertion by the operator, not a literal that silently went stale
  // (production drifted from 39/8 to 40/9 when a customer was created on
  // 2026-08-03). The guard below refuses to WRITE when the backup disagrees.
  const totalExpected = positiveInt(args["total-expected"], "total-expected", USAGE);
  const enrolledExpected = positiveInt(args["enrolled-expected"], "enrolled-expected", USAGE);

  const enrolled = backup.customers.filter((c) => c.enrolled).length;

  // Explicit environment identity BEFORE ANY WRITE — the pool is not even opened
  // until this has passed. `writes: true` additionally demands
  // --confirm-db-fingerprint for a production run, so a backfill cannot be aimed
  // at a database the operator has not looked at. Fails closed on any
  // disagreement between the stated environment, the shop domain and DATABASE_URL.
  assertEnvironmentIdentity({
    args,
    store,
    phase: "M1 — historical backfill (WRITES)",
    writes: true,
    expectedTotal: totalExpected,
    expectedEnrolled: enrolledExpected,
    databaseUrl: process.env.DATABASE_URL,
    fail: (message) => usage(message, USAGE),
  });

  // The backup must describe the cohort the operator stated. Checked AFTER the
  // identity guard (so the banner is always printed) but BEFORE the pool opens,
  // so a cohort surprise can never reach the database.
  if (Number(backup.totalExported) !== totalExpected) {
    usage(
      `backup totalExported ${String(backup.totalExported)} does not match --total-expected ` +
        `${totalExpected}. Refusing to backfill a cohort other than the one you verified.`,
      USAGE,
    );
  }
  if (enrolled !== enrolledExpected) {
    usage(
      `backup contains ${enrolled} enrolled customer(s) but --enrolled-expected is ` +
        `${enrolledExpected}. Refusing to backfill a legacy cohort other than the one you verified.`,
      USAGE,
    );
  }

  printBlock("M1 configuration", {
    store,
    backup: resolve(String(backupPath)),
    totalExpected,
    enrolledExpected,
    schemaVersion: backup.schemaVersion,
    exportedAt: backup.exportedAt,
    totalExported: backup.totalExported,
    enrolledExported: backup.enrolledExported,
    enrolledInFile: enrolled,
    databaseUrlSource: "environment",
    sslRejectUnauthorized: args["db-ssl-no-verify"] === true ? false : "default",
  });

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(args["db-ssl-no-verify"] === true ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  try {
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

    const result = await runM1Backfill({
      backup,
      repo: new LedgerRepository(pool),
      transactor,
    });

    if (result.status === "backfilled") {
      printBlock("M1 per-customer detail (Shopify ids only)", {
        totalMigratedPoints: result.customers.reduce((sum, c) => sum + c.migrationPoints, 0),
        customers: result.customers.map((c) => ({
          shopifyCustomerId: c.shopifyCustomerId,
          legacyBalance: c.legacyBalance,
          migrationPoints: c.migrationPoints,
          refundedPointsRemoved: c.refundedPointsRemoved,
          roundingAdjustment: c.roundingAdjustment,
          rule: c.rule,
          audit: c.conversionNote,
          tier: c.tier,
          lifetimeSpend: Number(c.lifetimeSpendGBP).toFixed(2),
          created: c.created,
        })),
      });
    }

    finish({
      phase: "M1",
      successStatus: "backfilled",
      result:
        result.status === "backfilled"
          ? {
              status: result.status,
              processed: result.processed,
              created: result.created,
              skipped: result.skipped,
              nonEnrolledDeferred: result.nonEnrolledDeferred,
              mismatches: result.mismatches,
            }
          : result,
    });
  } finally {
    await pool.end();
  }
});
