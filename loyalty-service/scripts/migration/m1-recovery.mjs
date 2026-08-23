#!/usr/bin/env node
/**
 * OPERATOR SCRIPT — M1 RECOVERY: reverses the historical backfill (DESTRUCTIVE).
 *
 * Runs the real `runM1Recovery` against a real `pg` transactor
 * (BEGIN / COMMIT / ROLLBACK), with the cohort taken ONLY from the M0 anchor
 * file. It touches Postgres and NEVER Shopify. Inspection and deletion happen in
 * ONE transaction, so an abort or a refusal leaves the ledger exactly as it was.
 *
 * THIS SCRIPT IS A THIN WRAPPER ON PURPOSE. Every guard that decides whether the
 * reversal may proceed lives in `src/migration/m1Recovery.ts` — store, database
 * fingerprint, migration-identity confirmation, destructive acknowledgement,
 * mandatory expectations, anchor agreement, clean-post-M1-state verification and
 * the post-M1 activity whitelist. They live there because a guard that cannot be
 * unit tested is a guard nobody has checked. This file only parses arguments,
 * opens the pool, and prints. The one guard it adds is
 * `assertEnvironmentIdentity`, which is inherently argv/process-shaped and is
 * shared with M0/M1 (the module independently re-checks the environment and the
 * fingerprint, so nothing depends on this file being run at all).
 *
 * WHAT IT CAN AND CANNOT DO. It can delete exactly M1's own output — the
 * `entry_type='migration'` / `reason='m1_backfill'` ledger entry, its matching
 * non-expiring point lot, and the cohort `customers` row — for the customers the
 * anchor lists, and nothing else, ever. There is no table argument, no WHERE
 * argument, no id argument and no entry-type argument. It refuses if ANY row
 * exists outside the expected cohort, and it refuses outright on ANY post-M1
 * loyalty activity (order earnings, referrals, birthday rewards, redemptions,
 * adjustments, clawbacks, or an entry type that does not exist yet), telling the
 * operator that manual recovery planning is required.
 *
 * DRY RUN IS THE DEFAULT. Without `--execute` this prints exactly what would be
 * affected and writes nothing. `--execute` additionally requires
 * `--i-understand-this-deletes-migration-rows`.
 *
 * PREREQUISITE: `npm run build` — this script imports the compiled service from
 * `dist/`.
 *
 * SECRETS: `DATABASE_URL` is read from the environment only — never as an
 * argument, because a connection string contains a password and arguments are
 * visible in shell history and in `ps`. Customer identifiers are printed masked
 * to the last 4 digits, and emails are never printed.
 *
 * Exit codes: 0 `dry_run` (dry run) / `reverted` (write mode); 3 `refused` /
 * `aborted_delete_error`; 2 usage/guard failure; 4 unexpected error.
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
import { assertEnvironmentIdentity, databaseFingerprint } from "./_envIdentity.mjs";
import { runM1Recovery } from "../../dist/migration/m1Recovery.js";

const PHASE_LABEL = "M1 RECOVERY — reverses the historical backfill (DESTRUCTIVE)";

const USAGE = `
M1 RECOVERY — reverses the historical backfill (writes Postgres, never Shopify)

  node scripts/migration/m1-recovery.mjs \\
    --backup <path to m0-metafield-export-*.json> \\
    --store myathoorlondon.myshopify.com \\
    --confirm-production-store myathoorlondon.myshopify.com \\
    --environment production \\
    --confirm-db-fingerprint <fingerprint> \\
    --confirm-entry-type migration \\
    --confirm-reason m1_backfill \\
    --expect-cohort <n> --expect-total-points <n> \\
    [--dry-run]                                  (the DEFAULT) \\
    [--execute --i-understand-this-deletes-migration-rows] \\
    [--db-ssl-no-verify]

Required environment
  DATABASE_URL   Postgres connection string. NEVER passed as an argument.

What this reverses
  ONLY M1's own output: the entry_type='migration' / reason='m1_backfill' ledger
  entry, its matching non-expiring point_lot, and the cohort customers row — for
  the customers listed in the M0 anchor. Deletion order respects the foreign
  keys: point lots -> ledger entries -> customers, all in ONE transaction.

  There is deliberately NO table argument, NO WHERE argument, NO id argument and
  NO entry-type argument. This is a one-migration reversal, not a delete tool.

Notes
  * Run \`npm run build\` first — this script imports from dist/.
  * DRY RUN IS THE DEFAULT. Omit --execute and nothing is written; you get the
    exact plan instead. --execute additionally requires
    --i-understand-this-deletes-migration-rows.
  * --environment production is REQUIRED; anything else refuses. --store must be
    exactly myathoorlondon.myshopify.com; any other value is REJECTED outright.
  * --confirm-db-fingerprint is REQUIRED and must match the configured database,
    exactly as for the M1 write phase. The guard prints the current fingerprint
    when the flag is missing, so it cannot be satisfied by an inherited .env.
  * --confirm-entry-type and --confirm-reason must be stated and must equal
    "migration" and "m1_backfill". They are CONFIRMATIONS: they cannot change
    which rows are affected, only prove you know which migration you are
    reversing.
  * --expect-cohort and --expect-total-points are REQUIRED with no defaults, and
    must match BOTH what the anchor implies AND what is actually in the database
    (the owner-verified production values are 9 and 484).
  * The cohort comes from the anchor's enrolled customers only — never a
    hardcoded id list. The anchor's storeDomain must match --store.
  * REFUSES, never warns, if: any row exists outside the expected cohort (all
    three tables must hold exactly the cohort size); any post-M1 loyalty activity
    exists for the cohort (order earnings, referrals, birthday rewards,
    redemptions, adjustments, clawbacks, or ANY entry type other than
    'migration'); the M1 state is partial or malformed; a migrated lot has been
    partially spent; or the cohort/total does not match.
  * A second run after a successful reversal refuses cleanly with
    "nothing_to_revert" — it does not throw and does not half-act.
  * Every refusal and every dry run has already rolled the transaction back, so
    the database is byte-for-byte unchanged.
  * Shopify is never contacted, orders are never read or written, and no customer
    row outside the anchor cohort is ever touched. Customer ids are printed
    masked to the last 4 digits; emails are never printed.
`;

await runMain(async () => {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(USAGE);
    process.exit(0);
  }

  // Dry run is the DEFAULT: the destructive path must be asked for by name.
  const wantsExecute = args.execute === true || args.execute === "true";
  const wantsDryRun = args["dry-run"] === true || args["dry-run"] === "true";
  if (wantsExecute && wantsDryRun) {
    usage("--execute and --dry-run are mutually exclusive. Pick one.", USAGE);
  }
  const mode = wantsExecute ? "execute" : "dry_run";

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
    usage(
      "--backup <file> is required: the M0 anchor is the ONLY definition of the cohort. This tool " +
        "never accepts a customer id list.",
      USAGE,
    );
  }

  const raw = await readFile(resolve(String(backupPath)), "utf8");
  let backup;
  try {
    backup = JSON.parse(raw);
  } catch {
    usage(`--backup file "${backupPath}" is not valid JSON.`, USAGE);
  }

  // MANDATORY, no fallback. State the cohort and total you verified immediately
  // before the run; the module then requires them to match BOTH the anchor and
  // the database before anything is deleted.
  const expectCohort = positiveInt(args["expect-cohort"], "expect-cohort", USAGE);
  const expectTotalPoints = positiveInt(args["expect-total-points"], "expect-total-points", USAGE);

  // Explicit environment identity BEFORE the pool is opened. `writes: true`
  // demands --confirm-db-fingerprint for a production run, so a destructive
  // reversal cannot be aimed at a database the operator has not looked at. The
  // recovery module re-checks the environment and the fingerprint itself, so this
  // is defence in depth rather than the only place either is enforced.
  assertEnvironmentIdentity({
    args,
    store,
    phase: PHASE_LABEL,
    writes: true,
    expectedTotal: Number(backup?.totalExported) || undefined,
    expectedEnrolled: expectCohort,
    databaseUrl: process.env.DATABASE_URL,
    fail: (message) => usage(message, USAGE),
  });

  const fingerprint = databaseFingerprint(databaseUrl);

  printBlock("M1 RECOVERY configuration", {
    mode,
    destructive: mode === "execute",
    store,
    backup: resolve(String(backupPath)),
    expectCohort,
    expectTotalPoints,
    confirmEntryType: args["confirm-entry-type"] ?? "(unset)",
    confirmReason: args["confirm-reason"] ?? "(unset)",
    anchorKind: backup?.kind,
    anchorStoreDomain: backup?.storeDomain,
    anchorExportedAt: backup?.exportedAt,
    anchorEnrolledExported: backup?.enrolledExported,
    databaseUrlSource: "environment",
    databaseFingerprint: fingerprint?.fingerprint ?? "(n/a)",
    sslRejectUnauthorized: args["db-ssl-no-verify"] === true ? false : "default",
  });

  if (mode === "execute") {
    console.error(
      [
        "",
        "==============================================================================",
        "  ⚠  DESTRUCTIVE MODE: M1's migration rows WILL be deleted if every guard",
        "     passes. Dry run is the default; you opted out of it.",
        "==============================================================================",
        "",
      ].join("\n"),
    );
  }

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

    const result = await runM1Recovery({
      environment: args.environment ?? args.env ?? null,
      store,
      confirmDbFingerprint: args["confirm-db-fingerprint"] ?? null,
      actualDbFingerprint: fingerprint?.fingerprint ?? null,
      confirmEntryType: args["confirm-entry-type"] ?? null,
      confirmReason: args["confirm-reason"] ?? null,
      backup,
      expectCohort,
      expectTotalPoints,
      mode,
      acknowledgeDeletesMigrationRows: args["i-understand-this-deletes-migration-rows"] === true,
      transactor,
    });

    if (result.status === "dry_run" || result.status === "reverted") {
      printBlock(
        result.status === "dry_run"
          ? "M1 RECOVERY plan (DRY RUN — nothing was written)"
          : "M1 RECOVERY plan (APPLIED)",
        {
          store: result.plan.store,
          cohortSize: result.plan.cohortSize,
          totalMigrationPoints: result.plan.totalMigrationPoints,
          observedRowCounts: result.plan.observed,
          rows: result.status === "dry_run" ? result.wouldDelete : result.deleted,
          // Masked ids only — the module never returns a full id or an email.
          customers: result.plan.customers.map((c) => ({
            customer: c.maskedShopifyCustomerId,
            migrationPoints: c.migrationPoints,
          })),
        },
      );
      if (result.status === "dry_run") {
        console.error(
          "\nDRY RUN: nothing was written. Re-run with --execute " +
            "--i-understand-this-deletes-migration-rows to apply exactly the plan above.\n",
        );
      }
    }

    if (result.status === "refused") {
      printBlock("M1 RECOVERY refusal", {
        code: result.refusal.code,
        message: result.refusal.message,
        manualRecoveryRequired: result.refusal.manualRecoveryRequired,
        postMigrationActivity: result.refusal.activity,
        malformedState: result.refusal.malformed,
      });
      if (result.refusal.manualRecoveryRequired) {
        console.error(
          "\nAUTOMATIC ROLLBACK IS NOT POSSIBLE for this state. MANUAL RECOVERY PLANNING IS " +
            "REQUIRED.\nNothing was changed. Take the findings above to the halt procedure in " +
            "docs/ops/m0-m2-cutover-runbook.md before touching anything.\n",
        );
      }
    }

    finish({
      phase: "M1 RECOVERY",
      successStatus: mode === "execute" ? "reverted" : "dry_run",
      result,
    });
  } finally {
    await pool.end();
  }
});
