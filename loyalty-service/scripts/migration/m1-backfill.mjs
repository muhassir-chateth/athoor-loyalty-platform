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
  printBlock,
  requireSecretFromEnv,
  resolveTargetStore,
  runMain,
  usage,
} from "./_shared.mjs";
import { runM1Backfill } from "../../dist/migration/m1Backfill.js";
import { LedgerRepository } from "../../dist/ledger/repository.js";

const USAGE = `
M1 — ledger backfill & reconciliation (writes Postgres, never Shopify)

  node scripts/migration/m1-backfill.mjs \\
    --backup <path to m0-metafield-export-*.json> \\
    --store <shop.myshopify.com> \\
    [--db-ssl-no-verify] \\
    [--confirm-production-store <shop.myshopify.com>]

Required environment
  DATABASE_URL   Postgres connection string. NEVER passed as an argument.

Notes
  * Run \`npm run build\` first — this script imports from dist/.
  * --db-ssl-no-verify sets ssl.rejectUnauthorized = false, for a managed pooler
    whose certificate chain is not locally verifiable (e.g. Supabase).
  * The backup's storeDomain must match --store; a mismatch refuses the run.
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

  const enrolled = backup.customers.filter((c) => c.enrolled).length;
  printBlock("M1 configuration", {
    store,
    backup: resolve(String(backupPath)),
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
        customers: result.customers.map((c) => ({
          shopifyCustomerId: c.shopifyCustomerId,
          migrationPoints: c.migrationPoints,
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
