#!/usr/bin/env node
/**
 * OPERATOR SCRIPT — M0–M2 rollback: restore the `loyalty.*` metafields.
 *
 * Runs the real `runMetafieldRollback` with the real
 * `ShopifyGraphqlMetafieldRestoreClient` (upsert + read-back, NO delete path —
 * Req 14.8) and the real `OperatorSuspendedServiceController`, using the M0
 * backup as the only source of truth (Req 14.9).
 *
 * THE SERVICE CHECK IS NOT OPTIONAL AND CANNOT BE SKIPPED. The controller cannot
 * suspend the service — that is a manual Render action — but it PROBES
 * `GET /health` and reports the service as running until three consecutive probes
 * fail. While it answers, the rollback aborts with `aborted_service_running`
 * WITHOUT touching a single metafield, so the restore can never race the
 * metafield-cache writer. Suspend the service first (Render dashboard → the
 * service → Suspend), then re-run.
 *
 * PREREQUISITE: `npm run build` — this script imports the compiled service from
 * `dist/`.
 *
 * SECRETS: the Admin token (needs `write_metafields` + `read_customers`) is read
 * from the environment only.
 *
 * Exit codes: 0 `rolled_back`; 3 `verification_failed` /
 * `aborted_service_running`; 2 usage/guard failure; 4 unexpected error.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
import { runMetafieldRollback } from "../../dist/migration/rollback.js";
import { ShopifyGraphqlMetafieldRestoreClient } from "../../dist/migration/metafieldRestoreClient.js";
import { OperatorSuspendedServiceController } from "../../dist/migration/serviceController.js";

const USAGE = `
Rollback — restore loyalty.* metafields from the M0 backup

  node scripts/migration/metafield-rollback.mjs \\
    --backup <path to m0-metafield-export-*.json> \\
    --store <shop.myshopify.com> \\
    --service-url <https://…> \\
    [--probe-failures 3] [--probe-interval-ms 2000] \\
    [--confirm-production-store <shop.myshopify.com>]

Required environment
  SHOPIFY_ADMIN_API_TOKEN   Admin token (write_metafields + read_customers).
                            NEVER passed as an argument.

Optional environment
  SHOPIFY_STORE_DOMAIN      Used when --store is omitted.
  LOYALTY_SERVICE_URL       Used when --service-url is omitted.

Notes
  * Run \`npm run build\` first — this script imports from dist/.
  * SUSPEND THE SERVICE FIRST. The health probe is a real check, not a formality:
    while /health answers, this script restores nothing and exits non-zero.
  * Values are upserted verbatim from the backup. NO metafield is ever deleted.
    A metafield whose backed-up value is null cannot be written through
    metafieldsSet and is SKIPPED and reported rather than written as "".
  * Idempotent: re-running restores to the same end state and re-verifies.
`;

await runMain(async () => {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(USAGE);
    process.exit(0);
  }

  const store = resolveTargetStore({ args, usageText: USAGE });
  const adminToken = requireSecretFromEnv({
    args,
    envNames: ["SHOPIFY_ADMIN_API_TOKEN", "SHOPIFY_ADMIN_TOKEN"],
    argAliases: ["token", "admin-token", "access-token"],
    what: "the Shopify Admin API token",
    usageText: USAGE,
  });

  const backupPath = args.backup;
  if (!backupPath || backupPath === true) {
    usage("--backup <file> is required (the M0 export is the only source of truth).", USAGE);
  }
  const serviceUrl = args["service-url"] ?? process.env.LOYALTY_SERVICE_URL;
  if (!serviceUrl || serviceUrl === true) {
    usage(
      "--service-url is required (or set LOYALTY_SERVICE_URL). The rollback must be able to " +
        "PROVE the service is stopped before it touches a metafield; there is no skip flag.",
      USAGE,
    );
  }

  const probeFailures = positiveInt(args["probe-failures"], "probe-failures", USAGE, 3);
  const probeIntervalMs = positiveInt(args["probe-interval-ms"], "probe-interval-ms", USAGE, 2000);

  const raw = await readFile(resolve(String(backupPath)), "utf8");
  let backup;
  try {
    backup = JSON.parse(raw);
  } catch {
    usage(`--backup file "${backupPath}" is not valid JSON.`, USAGE);
  }
  if (backup.kind !== "m0-metafield-export") {
    usage(
      `--backup file is not an M0 export (kind: "${String(backup.kind)}"). Refusing to restore ` +
        `from an unrecognised file.`,
      USAGE,
    );
  }
  if (String(backup.storeDomain).toLowerCase() !== store) {
    usage(
      `backup storeDomain "${backup.storeDomain}" does not match --store "${store}". Refusing ` +
        `to write one store's metafields from another store's export.`,
      USAGE,
    );
  }

  printBlock("Rollback configuration", {
    store,
    backup: resolve(String(backupPath)),
    exportedAt: backup.exportedAt,
    customersInBackup: backup.customers.length,
    metafieldsInBackup: backup.customers.reduce((n, c) => n + c.metafields.length, 0),
    serviceUrl: String(serviceUrl),
    probeFailures,
    probeIntervalMs,
    adminTokenSource: "environment",
  });

  const skippedNull = [];
  const probes = [];

  const client = new ShopifyGraphqlMetafieldRestoreClient(store, adminToken, undefined, {
    onSkippedNullValue: (s) => skippedNull.push({ ...s, customerGid: undefined }),
  });
  const service = new OperatorSuspendedServiceController(String(serviceUrl), {
    requiredConsecutiveFailures: probeFailures,
    probeIntervalMs,
    log: (m) => console.log(`[service] ${m}`),
    onProbe: (p) => probes.push(p),
  });

  const result = await runMetafieldRollback({ backup, client, service });

  printBlock("Health probes (is the service genuinely suspended?)", probes);
  if (skippedNull.length > 0) {
    printBlock(
      "SKIPPED null-valued metafields (NOT written — an empty string would corrupt the restore)",
      skippedNull,
    );
  }

  if (result.status !== "aborted_service_running") {
    printBlock("Rollback per-customer detail (Shopify ids only)", {
      customers: result.details.map((d) => ({
        id: d.id,
        metafieldsRestored: d.metafieldsRestored,
        verified: d.verified,
      })),
    });
  }

  finish({
    phase: "Rollback",
    successStatus: "rolled_back",
    result:
      result.status === "aborted_service_running"
        ? result
        : {
            status: result.status,
            serviceStopped: result.serviceStopped,
            customersRestored: result.customersRestored,
            metafieldsRestored: result.metafieldsRestored,
            skippedNullValued: skippedNull.length,
            mismatches: result.mismatches,
          },
  });
});
