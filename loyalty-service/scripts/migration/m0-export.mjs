#!/usr/bin/env node
/**
 * OPERATOR SCRIPT — Migration Phase M0: export & snapshot (read-only).
 *
 * Runs the real `runM0Export` with the real `ShopifyGraphqlMigrationClient` and
 * the real `FileBackupWriter`, producing the versioned JSON backup that is the
 * ROLLBACK ANCHOR for every later phase (Req 14.1). It reads Shopify and writes
 * one local file; it modifies nothing in the store (Req 14.8 — the client has no
 * write or delete method at all).
 *
 * PREREQUISITE: `npm run build` — this script imports the compiled service from
 * `dist/`.
 *
 * SECRETS: the Admin token is read from the environment only.
 * SCOPES: `read_customers` + `read_orders`. For a LIFETIME spend derivation you
 * also need `read_all_orders`, or Shopify hides orders older than 60 days and the
 * derived spend will be silently too low.
 *
 * Exit codes: 0 `exported`; 3 `aborted_incomplete_export` /
 * `halted_balance_mismatch`; 2 usage/guard failure; 4 unexpected error.
 */
import {
  EXIT_HALTED,
  finish,
  parseArgs,
  positiveInt,
  printBlock,
  requireSecretFromEnv,
  resolveTargetStore,
  runMain,
  usage,
} from "./_shared.mjs";
import { runM0Export } from "../../dist/migration/m0Export.js";
import { FileBackupWriter } from "../../dist/migration/backupWriter.js";
import {
  DEFAULT_ACCEPTED_FINANCIAL_STATUSES,
  DEFAULT_EXPECTED_CURRENCY,
  MigrationCurrencyMismatchError,
  ShopifyGraphqlMigrationClient,
} from "../../dist/migration/migrationShopifyClient.js";

const USAGE = `
M0 — export & snapshot (read-only)

  node scripts/migration/m0-export.mjs \\
    --store <shop.myshopify.com> \\
    --backup-dir <directory> \\
    [--total-expected 39] [--enrolled-expected 8] \\
    [--expected-currency GBP] \\
    [--accepted-financial-statuses PAID,PARTIALLY_REFUNDED,REFUNDED] \\
    [--include-cancelled-orders] [--include-test-orders] \\
    [--page-size 100] \\
    [--confirm-production-store <shop.myshopify.com>]

Required environment
  SHOPIFY_ADMIN_API_TOKEN   Admin token (read_customers, read_orders, ideally
                            read_all_orders). NEVER passed as an argument.

Optional environment
  SHOPIFY_STORE_DOMAIN      Used when --store is omitted.
  M0_BACKUP_DIR             Used when --backup-dir is omitted.

Notes
  * Run \`npm run build\` first — this script imports from dist/.
  * --expected-currency defaults to GBP (Req 21.1). The export ABORTS if any
    order reports a different currency; summing another currency as GBP would
    misplace every customer's tier.
  * --accepted-financial-statuses decides which orders count towards lifetime
    spend and therefore REAL CUSTOMERS' TIERS. The default means "was paid at
    some point" (a refund does not reduce lifetime spend, Req 4.7). Changing it
    needs the business owner's sign-off.
  * Copy the backup file off this machine as soon as the run succeeds.
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

  const backupDirRaw = args["backup-dir"] ?? process.env.M0_BACKUP_DIR;
  if (!backupDirRaw || backupDirRaw === true) {
    usage("--backup-dir is required (or set M0_BACKUP_DIR).", USAGE);
  }

  const totalExpected = positiveInt(args["total-expected"], "total-expected", USAGE, 39);
  const enrolledExpected = positiveInt(args["enrolled-expected"], "enrolled-expected", USAGE, 8);
  const pageSize = positiveInt(args["page-size"], "page-size", USAGE, 100);
  const expectedCurrency =
    typeof args["expected-currency"] === "string"
      ? args["expected-currency"].toUpperCase()
      : DEFAULT_EXPECTED_CURRENCY;
  const acceptedFinancialStatuses =
    typeof args["accepted-financial-statuses"] === "string"
      ? args["accepted-financial-statuses"]
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s !== "")
      : [...DEFAULT_ACCEPTED_FINANCIAL_STATUSES];
  if (acceptedFinancialStatuses.length === 0) {
    usage("--accepted-financial-statuses must list at least one status.", USAGE);
  }

  printBlock("M0 configuration", {
    store,
    backupDir: backupDirRaw,
    totalExpected,
    enrolledExpected,
    expectedCurrency,
    acceptedFinancialStatuses,
    includeCancelledOrders: args["include-cancelled-orders"] === true,
    includeTestOrders: args["include-test-orders"] === true,
    pageSize,
    adminTokenSource: "environment",
  });

  const client = new ShopifyGraphqlMigrationClient(store, adminToken, undefined, {
    expectedCurrency,
    acceptedFinancialStatuses,
    includeCancelledOrders: args["include-cancelled-orders"] === true,
    includeTestOrders: args["include-test-orders"] === true,
    pageSize,
  });

  let result;
  try {
    result = await runM0Export({
      client,
      backupWriter: new FileBackupWriter(String(backupDirRaw)),
      storeDomain: store,
      totalExpected,
      enrolledExpected,
    });
  } catch (err) {
    if (err instanceof MigrationCurrencyMismatchError) {
      console.error(
        `\nM0: HALTED — currency guard fired. NOTHING was written and NOTHING in the store ` +
          `changed.\n` +
          `  customer id     : ${err.customerId}\n` +
          `  order           : ${err.orderGid}\n` +
          `  field           : ${err.field}\n` +
          `  expected        : ${err.expectedCurrency}\n` +
          `  found           : ${err.foundCurrency}\n\n` +
          `If ${err.foundCurrency} really is the store's base currency, re-run with ` +
          `--expected-currency ${err.foundCurrency}. Otherwise investigate the order before ` +
          `going any further: mixing currencies would misplace tiers.`,
      );
      process.exit(EXIT_HALTED);
    }
    throw err;
  }

  // Summarise per customer WITHOUT emails and without dumping every metafield
  // value: the file on disk is the record, the console is for the operator.
  if (result.status !== "aborted_incomplete_export") {
    printBlock("M0 per-customer summary (Shopify ids only)", {
      backupLocation: result.backupLocation,
      customers: result.backup.customers.map((c) => ({
        id: c.id,
        enrolled: c.enrolled,
        lifetimeSpend: c.lifetimeSpendGBP.toFixed(2),
        loyaltyMetafieldCount: c.metafields.length,
        pointsBalance: c.loyalty.pointsBalance,
        tier: c.loyalty.tier,
      })),
    });
  }

  finish({
    phase: "M0",
    successStatus: "exported",
    result:
      result.status === "aborted_incomplete_export"
        ? result
        : {
            status: result.status,
            backupLocation: result.backupLocation,
            schemaVersion: result.backup.schemaVersion,
            kind: result.backup.kind,
            exportedAt: result.backup.exportedAt,
            storeDomain: result.backup.storeDomain,
            totalExpected: result.backup.totalExpected,
            enrolledExpected: result.backup.enrolledExpected,
            totalExported: result.backup.totalExported,
            enrolledExported: result.backup.enrolledExported,
            mismatches: result.mismatches,
          },
  });
});
