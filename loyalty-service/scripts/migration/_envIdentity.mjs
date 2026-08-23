/**
 * Explicit environment identity for migration operator scripts — fail closed.
 *
 * WHY THIS EXISTS. `loyalty-service/.env` declares `NODE_ENV=production` while
 * pointing at `athoor-loyalty-staging.myshopify.com` and the dev database. A
 * migration script that silently consumes that file looks like it is running
 * against production and is not. That confusion already invalidated one recorded
 * baseline; against a WRITE phase it would corrupt a migration.
 *
 * THE RULE. The operator must STATE the environment on the command line. The
 * script then proves that every independent signal agrees with that statement,
 * and REFUSES to run on any disagreement. Nothing is inferred, and no default is
 * assumed.
 *
 * Signals cross-checked against the stated environment:
 *   1. the Shopify shop domain being targeted;
 *   2. the database host (from DATABASE_URL, never printed in full);
 *   3. `NODE_ENV`, which is advisory only and reported when it disagrees.
 *
 * NEVER PRINTS A CREDENTIAL. The database is identified by host plus a short
 * one-way fingerprint of host+database-name — enough for an operator to confirm
 * they are pointed where they think, and useless to anyone who obtains it.
 */
import { createHash } from "node:crypto";

/** The environments a migration may be run against. */
export const ENVIRONMENTS = ["production", "staging", "development"];

/** Substrings that mark a NON-production Shopify domain or database host. */
const NON_PRODUCTION_MARKERS = ["staging", "-dev", "dev-", "development", "test", "sandbox", "localhost", "127.0.0.1"];

/**
 * A short, non-reversible fingerprint of a database URL's host + database name.
 * Deliberately excludes user, password and query string, so it is safe to print
 * and safe to paste into a runbook or a ticket.
 */
export function databaseFingerprint(databaseUrl) {
  if (!databaseUrl) return null;
  let host = null;
  let database = null;
  try {
    const u = new URL(databaseUrl);
    host = u.hostname;
    database = u.pathname.replace(/^\//, "");
  } catch {
    return { host: "unparseable", database: null, fingerprint: null };
  }
  const fingerprint = createHash("sha256").update(`${host}/${database}`).digest("hex").slice(0, 12);
  return { host, database, fingerprint };
}

function looksNonProduction(value) {
  if (!value) return false;
  const lower = String(value).toLowerCase();
  return NON_PRODUCTION_MARKERS.some((m) => lower.includes(m));
}

/**
 * Requires an explicit `--environment` and proves every signal agrees with it.
 * Prints a non-secret identity banner, then returns the resolved identity.
 *
 * Throws (via the supplied `fail` callback) rather than returning on any
 * disagreement — fail closed, never warn-and-continue.
 *
 * @param {object} params
 * @param {Record<string, unknown>} params.args      Parsed CLI args.
 * @param {string}  params.store                     Shopify domain being targeted.
 * @param {string}  params.phase                     e.g. "M0 (read-only)" / "M1 (WRITES)".
 * @param {boolean} params.writes                    True for a phase that writes.
 * @param {number}  [params.expectedTotal]           Operator's stated total cohort.
 * @param {number}  [params.expectedEnrolled]        Operator's stated legacy cohort.
 * @param {string}  [params.databaseUrl]             DATABASE_URL, if the phase needs one.
 * @param {(msg: string) => never} params.fail       Called with a message to abort.
 */
export function assertEnvironmentIdentity({
  args,
  store,
  phase,
  writes,
  expectedTotal,
  expectedEnrolled,
  databaseUrl,
  fail,
}) {
  const stated = args.environment ?? args.env;

  if (!stated || stated === true) {
    fail(
      "--environment is REQUIRED and has no default. State it explicitly:\n" +
        `  --environment ${ENVIRONMENTS.join(" | ")}\n\n` +
        "This exists because loyalty-service/.env declares NODE_ENV=production while\n" +
        "pointing at the STAGING store and the dev database. Nothing is inferred.",
    );
  }

  if (!ENVIRONMENTS.includes(String(stated))) {
    fail(`--environment must be one of: ${ENVIRONMENTS.join(", ")} (got "${String(stated)}").`);
  }

  const environment = String(stated);
  const isProduction = environment === "production";
  const db = databaseFingerprint(databaseUrl);

  /* -- Signal 1: the Shopify domain must agree with the stated environment -- */
  const domainLooksNonProd = looksNonProduction(store);
  if (isProduction && domainLooksNonProd) {
    fail(
      `REFUSING TO RUN: --environment production, but the target Shopify domain looks non-production.\n` +
        `  domain: ${store}\n\n` +
        "Either you meant --environment staging, or you are pointed at the wrong store.",
    );
  }
  if (!isProduction && !domainLooksNonProd) {
    fail(
      `REFUSING TO RUN: --environment ${environment}, but the target Shopify domain looks like PRODUCTION.\n` +
        `  domain: ${store}\n\n` +
        "Refusing so a non-production run cannot touch the production store by accident.",
    );
  }

  /* -- Signal 2: the database host must agree with the stated environment ---- */
  if (db && db.host && db.host !== "unparseable") {
    const dbLooksNonProd = looksNonProduction(db.host) || looksNonProduction(db.database);
    if (isProduction && dbLooksNonProd) {
      fail(
        "REFUSING TO RUN: --environment production, but DATABASE_URL points somewhere non-production.\n" +
          `  db host: ${db.host}\n  db name: ${db.database}\n\n` +
          "This is the exact trap in loyalty-service/.env. Supply the production DATABASE_URL\n" +
          "explicitly for this command; do not rely on a .env file.",
      );
    }
  }

  /* -- Signal 3: NODE_ENV is advisory; report disagreement, never trust it --- */
  const nodeEnv = process.env.NODE_ENV ?? "(unset)";
  const nodeEnvDisagrees = nodeEnv !== "(unset)" && nodeEnv !== environment;

  /* -- A write phase must confirm the database fingerprint explicitly -------- */
  if (writes && isProduction) {
    const confirmed = args["confirm-db-fingerprint"];
    if (!confirmed || confirmed === true) {
      fail(
        "REFUSING TO WRITE: --confirm-db-fingerprint is required for a production write phase.\n" +
          (db?.fingerprint
            ? `  The database currently configured fingerprints as: ${db.fingerprint}\n` +
              `  (host ${db.host}, database ${db.database})\n\n` +
              "Re-run with --confirm-db-fingerprint " +
              db.fingerprint +
              " once you have satisfied yourself\n  that this is the production database.\n\n"
            : "  No DATABASE_URL is configured, so there is nothing to confirm.\n\n") +
          "Typing the fingerprint is the point: it cannot be satisfied by a silently\n" +
          "inherited .env, only by an operator who looked.",
      );
    }
    if (String(confirmed) !== String(db?.fingerprint)) {
      fail(
        "REFUSING TO WRITE: --confirm-db-fingerprint does not match the configured database.\n" +
          `  you passed : ${String(confirmed)}\n` +
          `  actual     : ${String(db?.fingerprint)}\n\n` +
          "You are not pointed at the database you think you are.",
      );
    }
  }

  /* -- Identity banner: non-secret values only ------------------------------ */
  const banner = [
    "",
    "──────────────────────────────────────────────────────────────",
    ` MIGRATION IDENTITY — ${phase}`,
    "──────────────────────────────────────────────────────────────",
    ` intended environment : ${environment}${writes ? "   (THIS PHASE WRITES)" : "   (read-only)"}`,
    ` shopify shop domain  : ${store}`,
    ` database host        : ${db?.host ?? "(not required by this phase)"}`,
    ` database name        : ${db?.database ?? "(n/a)"}`,
    ` database fingerprint : ${db?.fingerprint ?? "(n/a)"}`,
    ` expected total cohort: ${expectedTotal ?? "(not stated)"}`,
    ` expected legacy cohort: ${expectedEnrolled ?? "(not stated)"}`,
    ` NODE_ENV             : ${nodeEnv}${nodeEnvDisagrees ? "   <-- DISAGREES with --environment (advisory only)" : ""}`,
    "──────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
  console.error(banner);

  if (nodeEnvDisagrees) {
    console.error(
      `NOTE: NODE_ENV is "${nodeEnv}" but you stated --environment ${environment}.\n` +
        "      NODE_ENV is NOT trusted for migration decisions — this is only a heads-up\n" +
        "      that some environment file in scope disagrees with your invocation.\n",
    );
  }

  return { environment, isProduction, store, database: db, writes };
}
