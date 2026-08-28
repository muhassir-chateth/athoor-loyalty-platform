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
 * Deep-copies a structure with every `email` field removed and every secret-shaped
 * string masked, so printed output can never carry a customer email address or a
 * secret. Customers are referenced by Shopify id only.
 *
 * The masked shapes are listed in {@link SECRET_PATTERNS}: private keys, URI
 * userinfo (`user:password@host` — the connection-string case), database URIs,
 * Shopify credential prefixes, `Bearer`/`Basic` header values and email addresses.
 * Identifiers are deliberately left intact; see the note on that list.
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
    return redactString(value);
  }
  return value;
}

/**
 * The secret shapes this redactor masks, in the order they must be applied.
 *
 * ── WHY THIS LIST GREW ───────────────────────────────────────────────────────
 * It used to be two rules: a Shopify token shape and an email address. That left a
 * gap the repository had already noticed and worked around rather than closed.
 * `migrateDownGuard.test.ts` says so in as many words — "does not use runMain,
 * whose redact does not mask a connection string" — and `migrate-down-guard.mjs`
 * was deliberately written without `runMain` for that reason.
 *
 * The workaround covered ONE of four exposed scripts. `m0-export.mjs`,
 * `m1-backfill.mjs` and `m1-recovery.mjs` all call `runMain` and all connect with
 * `DATABASE_URL`, so on any unexpected throw they printed an error message through a
 * redactor that could not mask a connection string. Those are the production cutover
 * scripts. Fixing the redactor closes all four at once and makes the workaround a
 * belt-and-braces measure rather than the only thing standing in the way.
 *
 * ── ALIGNED WITH THE SERVICE'S OWN DEFINITION, NOT AN INVENTED ONE ───────────
 * Every pattern below is taken from `src/observability/logCapture.gate.test.ts`,
 * which is the repository's existing statement of what counts as secret-shaped in a
 * log line. Two implementations of "redact" with different ideas of what a secret is
 * was the underlying problem; this removes the divergence for the secret kinds.
 *
 * ── WHAT IS DELIBERATELY NOT MASKED ─────────────────────────────────────────
 * The gate test also forbids long digit runs, UUIDs, hex digests and postcodes. Those
 * are NOT masked here, and that is a decision rather than an omission: these scripts
 * exist to report cohort membership by Shopify customer id, and `redact`'s own
 * contract says "Customers are referenced by Shopify id only". Masking ids would
 * destroy the tooling's purpose while protecting nothing that is secret. The split is
 * between SECRETS, which are masked, and IDENTIFIERS, which this output is for.
 */
const SECRET_PATTERNS = [
  // A private key block, before anything else — it contains base64 that later
  // patterns could partially rewrite, and it is the most damaging single leak.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted-private-key]",
  },
  // A URI carrying userinfo — the `scheme://user:password@host` form. THIS is the
  // connection-string leak: it masks the credentials while leaving the host and
  // path readable, which is what makes a failure diagnosable. `databaseFingerprint`
  // prints host and database as bare strings, so its intentional output is
  // unaffected.
  {
    pattern: /(\/\/)[^\s/@:]+:[^\s/@]+@/g,
    replacement: "$1[redacted-credentials]@",
  },
  // A database URI with no inline credentials. The scheme and host are not secret,
  // but a full connection string is exactly what must never be pasted into a
  // ticket, so the whole URI is replaced.
  {
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/\S+/gi,
    replacement: "[redacted-database-uri]",
  },
  // Shopify credential prefixes: admin/custom-app tokens, shared secrets,
  // storefront and customer-account tokens. Widened from `shp[a-z]{2}_` to the
  // explicit set the gate test names, and to include `_` in the body.
  {
    pattern: /\bshp(?:at|ss|pa|ca|us)_[A-Za-z0-9_]+/gi,
    replacement: "[redacted-token]",
  },
  // An HTTP authentication header value.
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "$1 [redacted-credential]",
  },
  // An email address.
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: "[redacted-email]",
  },
];

/** Applies every secret pattern to one string. Exported so it can be tested directly. */
export function redactString(value) {
  let out = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
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
    // EVERY branch goes through `redactString`. Previously `err.stack` was redacted
    // and `err.message` was not — which is self-contradictory, because a V8 stack
    // BEGINS with `${name}: ${message}`. The same text was masked on one line and
    // printed raw on the line above it.
    //
    // `err.code` and the `String(err)` fallback are redacted for the same reason: a
    // thrown non-Error can carry anything, and a driver's `code` field is not
    // guaranteed to be a short enum.
    console.error(
      `\nUNEXPECTED FAILURE: ${redactString(err instanceof Error ? err.message : String(err))}`,
    );
    if (err && typeof err === "object" && "code" in err) {
      console.error(`code: ${redactString(String(err.code))}`);
    }
    if (err instanceof Error && err.stack) {
      console.error(redactString(err.stack));
    }
    process.exit(EXIT_ERROR);
  }
}
