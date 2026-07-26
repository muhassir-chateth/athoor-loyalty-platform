/**
 * Shared plumbing for the M0–M2 cutover operator scripts (task 33).
 *
 * These scripts are the ONLY sanctioned way to run the migration: the HTTP
 * surface refuses it (Req 10.7a, `POST /v1/admin/operations/migration` → 501)
 * because the M0 export must exist as the rollback anchor before anything is
 * written. Everything in this file exists to make an operator run hard to get
 * wrong:
 *
 *   - TARGET-STORE GUARD. The store domain must be given explicitly. If it is
 *     the PRODUCTION store, the run additionally requires
 *     `--confirm-production-store=<exact domain>`; a missing or mistyped
 *     confirmation refuses the run. Pointing a cutover at the wrong store is
 *     the worst possible outcome of this tooling, so the guard is loud and
 *     cannot be satisfied by accident.
 *   - SECRETS FROM THE ENVIRONMENT ONLY. Admin tokens and database URLs are
 *     never accepted as arguments, so they cannot land in shell history, in a
 *     `ps` listing, or in a screen share.
 *   - NO EMAILS, NO TOKENS IN OUTPUT. Customers are referenced by Shopify id.
 *     Every printed structure is passed through {@link redact}.
 *   - HALT ≠ SUCCESS. {@link finish} exits non-zero for any status other than
 *     the single success status the phase defines.
 *
 * These scripts import the COMPILED service from `dist/`, so run
 * `npm run build` (or `npm ci && npm run build`) first.
 */

/** The production store. Never a default; only ever reached deliberately. */
export const PRODUCTION_STORE_DOMAIN = "myathoorlondon.myshopify.com";

/** The staging store used for rehearsals. */
export const STAGING_STORE_DOMAIN = "athoor-loyalty-staging.myshopify.com";

/** Exit codes: 0 success, 2 usage/guard error, 3 abort/halt status, 4 unexpected throw. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_HALTED = 3;
export const EXIT_ERROR = 4;

/**
 * Minimal argv parser: `--key value`, `--key=value` and boolean `--flag`.
 * Deliberately dependency-free and strict — unknown keys are returned as-is and
 * each script validates the ones it cares about.
 */
export function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return { args, positional };
}

/** Prints the usage block and exits with the usage code. */
export function usage(message, usageText) {
  if (message) {
    console.error(`\nERROR: ${message}`);
  }
  console.error(usageText);
  process.exit(EXIT_USAGE);
}

/** Normalises a store domain: strips scheme, trailing slash, whitespace, case. */
export function normaliseStoreDomain(raw) {
  return String(raw)
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Resolves and GUARDS the target store domain.
 *
 * Requires an explicit `--store` (or `SHOPIFY_STORE_DOMAIN`). When the resolved
 * domain is the production store, `--confirm-production-store=<exact domain>` is
 * also required. A confirmation that does not match the target refuses the run,
 * so a stale flag copied from another command cannot arm a production write.
 */
export function resolveTargetStore({ args, usageText }) {
  const raw = args.store ?? process.env.SHOPIFY_STORE_DOMAIN;
  if (!raw || raw === true) {
    usage(
      "--store is required (or set SHOPIFY_STORE_DOMAIN). The target store is never defaulted.",
      usageText,
    );
  }
  const store = normaliseStoreDomain(raw);
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(store)) {
    usage(
      `--store "${store}" does not look like a *.myshopify.com admin domain.`,
      usageText,
    );
  }

  const confirmation =
    args["confirm-production-store"] === undefined
      ? undefined
      : normaliseStoreDomain(args["confirm-production-store"]);

  if (store === PRODUCTION_STORE_DOMAIN) {
    console.error(
      [
        "",
        "==============================================================================",
        "  ⚠  TARGET IS THE PRODUCTION STORE: " + PRODUCTION_STORE_DOMAIN,
        "==============================================================================",
      ].join("\n"),
    );
    if (confirmation !== store) {
      usage(
        `refusing to run against the PRODUCTION store without explicit confirmation. ` +
          `Re-run with --confirm-production-store=${PRODUCTION_STORE_DOMAIN} ` +
          `(exact match required)${
            confirmation === undefined ? "" : `; got "${confirmation}"`
          }.`,
        usageText,
      );
    }
    console.error("  Confirmation flag accepted. Proceeding against PRODUCTION.\n");
  } else if (confirmation !== undefined) {
    usage(
      `--confirm-production-store was passed as "${confirmation}" but the target store is ` +
        `"${store}". Refusing to run with a confirmation that does not match the target.`,
      usageText,
    );
  }

  return store;
}

/**
 * Reads a required secret from the environment. Never accepted as an argument.
 * Refuses if the same name was passed on the command line, so a habit of
 * `--token …` fails loudly instead of leaking into shell history.
 */
export function requireSecretFromEnv({ args, envNames, argAliases = [], what, usageText }) {
  for (const alias of argAliases) {
    if (args[alias] !== undefined) {
      usage(
        `--${alias} is not accepted: ${what} must come from the environment ` +
          `(${envNames.join(" or ")}) so it never lands in shell history or a process listing.`,
        usageText,
      );
    }
  }
  for (const name of envNames) {
    const value = process.env[name];
    if (value && value.trim() !== "") {
      return value.trim();
    }
  }
  usage(`${what} is required: set ${envNames.join(" or ")} in the environment.`, usageText);
}

/** Parses a required positive integer argument. */
export function positiveInt(value, name, usageText, fallback) {
  if (value === undefined || value === true) {
    if (fallback !== undefined) return fallback;
    usage(`--${name} is required and must be a positive integer.`, usageText);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    usage(`--${name} must be a positive integer; received "${value}".`, usageText);
  }
  return n;
}

/**
 * Deep-copies a structure with every `email` field removed and any token-looking
 * string masked, so printed output can never carry a customer email address or a
 * secret. Customers are referenced by Shopify id only.
 */
export function redact(value) {
  if (Array.isArray(value)) {
    return value.map((v) => redact(v));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "email" || key === "emails") {
        continue;
      }
      out[key] = redact(v);
    }
    return out;
  }
  if (typeof value === "string") {
    // Mask anything shaped like a Shopify token or an email address.
    return value
      .replace(/shp[a-z]{2}_[A-Za-z0-9]+/g, "[redacted-token]")
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]");
  }
  return value;
}

/** Prints a labelled, redacted JSON block. */
export function printBlock(label, value) {
  console.log(`\n${label}:`);
  console.log(JSON.stringify(redact(value), null, 2));
}

/**
 * Prints the final structured result and exits: 0 only when `status` equals the
 * phase's single success status, otherwise non-zero so a halt can never be
 * mistaken for success.
 */
export function finish({ phase, result, successStatus }) {
  printBlock(`${phase} result`, result);
  if (result.status === successStatus) {
    console.log(`\n${phase}: SUCCESS (status "${result.status}").`);
    process.exit(EXIT_OK);
  }
  console.error(
    `\n${phase}: HALTED (status "${result.status}"). This is NOT a success — stop and follow ` +
      `the halt conditions in docs/ops/m0-m2-cutover-runbook.md before doing anything else.`,
  );
  process.exit(EXIT_HALTED);
}

/** Wraps a main function so an unexpected throw exits non-zero with a clean message. */
export async function runMain(main) {
  try {
    await main();
  } catch (err) {
    console.error(`\nUNEXPECTED FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    if (err && typeof err === "object" && "code" in err) {
      console.error(`code: ${String(err.code)}`);
    }
    if (err instanceof Error && err.stack) {
      console.error(redact(err.stack));
    }
    process.exit(EXIT_ERROR);
  }
}
