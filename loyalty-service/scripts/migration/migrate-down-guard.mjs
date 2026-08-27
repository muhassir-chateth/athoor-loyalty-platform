#!/usr/bin/env node
/**
 * OPERATOR SCRIPT — the `migrate:down` row-count precondition (task 6.5,
 * Requirements 22.3, 23.5).
 *
 * Runs BEFORE `node-pg-migrate down` and exits non-zero unless every table the
 * four portal migrations created is provably empty. Wired into package.json as:
 *
 *   "migrate:down"       : build -> this guard -> node-pg-migrate down
 *   "migrate:down:check" : build -> this guard            (standalone dry check)
 *
 * The dry check exists because an operator planning a rollback should be able to
 * ask "would this be allowed?" without the answer being followed immediately by
 * the thing they were asking about. Same code path, same exit codes, no `down`.
 *
 * READ-ONLY. The only statement it issues is `SELECT count(*)`. It opens one
 * connection, counts five tables, closes it. It writes nothing, in any
 * circumstance, to any database.
 *
 * FAIL CLOSED. Exit 0 means "every table proven empty". Anything else — no
 * DATABASE_URL, unreachable host, bad credentials, missing table, unparseable
 * count, unexpected throw — exits non-zero, so the `&&` in the npm script stops
 * and `down` never runs. The decision itself lives in
 * src/migration/migrateDownGuard.ts, where it is unit-tested against injected
 * fakes with no Postgres involved.
 *
 * SECRETS. `DATABASE_URL` is read from the environment (never an argument, so it
 * cannot land in shell history or a `ps` listing) and is NEVER printed, in whole
 * or in part, on any path including failure. Concretely, this script:
 *   - never passes an error object, `err.message`, `err.stack` or `err.input` to
 *     console — `pg` puts host and port in connection errors and Node puts the
 *     entire malformed URL on `ERR_INVALID_URL.input`, which `console.error(err)`
 *     would print;
 *   - does NOT use `runMain` from `_shared.mjs`, which prints `err.message` and
 *     `err.stack`; its `redact` masks Shopify tokens and emails but not a
 *     `postgres://user:pass@host/db` connection string;
 *   - installs process-level handlers so an unexpected rejection cannot reach
 *     Node's default printer, which dumps the error's own properties.
 * Everything the operator sees comes from the closed literal union in
 * migrateDownGuard.ts.
 *
 * PREREQUISITE: `npm run build` — this script imports the compiled guard from
 * `dist/`, matching the other operator scripts here. The npm scripts run the
 * build first, deliberately: a stale `dist/` would guard using an out-of-date
 * table list, which is the one way this could fail OPEN.
 *
 * Exit codes: 0 permitted; 3 refused (the expected non-zero); 4 unexpected.
 */
import { Client } from "pg";
import { evaluateMigrateDownGuard, isSafeTableIdentifier } from "../../dist/migration/migrateDownGuard.js";

const EXIT_PERMITTED = 0;
const EXIT_REFUSED = 3;
const EXIT_UNEXPECTED = 4;

/**
 * Last-resort handlers. Node's default printer for an uncaught error writes the
 * error's own enumerable properties, which for a `pg` or URL error can include
 * the connection string. These replace it with a fixed line and a non-zero exit.
 */
function installSilentFailureHandlers() {
  const bail = () => {
    console.error(
      "\nmigrate:down precondition: REFUSING — the guard itself failed unexpectedly.\n" +
        "  The underlying error is deliberately not printed: it may carry DATABASE_URL.\n" +
        "  Re-run with the database reachable, or run the SELECT count(*) checks by hand.",
    );
    process.exit(EXIT_UNEXPECTED);
  };
  process.on("uncaughtException", bail);
  process.on("unhandledRejection", bail);
}

/**
 * Builds the row-count probe over one connection.
 *
 * `count(*)` comes back as a string because it is a `bigint`; `Number(...)` of a
 * non-numeric string is `NaN`, which the guard classifies as `count_unreadable`
 * rather than reading as zero. The table name is interpolated because an
 * identifier cannot be a bound parameter, so it is gated on
 * `isSafeTableIdentifier` — and every name it ever sees comes from the frozen
 * list in the guard module.
 */
function makeProbe(client) {
  return async (table) => {
    if (!isSafeTableIdentifier(table)) {
      throw Object.assign(new Error("unsafe table identifier"), { code: "GUARD_UNSAFE_IDENT" });
    }
    const result = await client.query(`SELECT count(*) AS n FROM ${table}`);
    return Number(result.rows[0]?.n);
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  // No database configured: evaluate with a null probe so the operator gets the
  // full refusal (including the flag-flip and second-grant blocks) rather than a
  // bare "missing env var", which reads like a setup problem instead of a stop.
  if (!databaseUrl || databaseUrl.trim() === "") {
    const result = await evaluateMigrateDownGuard({ probe: null });
    console.error(result.message);
    process.exit(EXIT_REFUSED);
  }

  // Construction is inside the try because a malformed DATABASE_URL can throw
  // HERE rather than at connect time, and that throw is the one that carries the
  // whole URL on `error.input`. Catching it turns it into the ordinary refusal
  // instead of routing it to the generic handler.
  let client = null;
  let connected = false;
  let failureCode = "ECONNREFUSED";
  try {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    connected = true;
  } catch (error) {
    // `code` only — see the header. Nothing else about the error is read.
    const code = error && typeof error === "object" ? error.code : undefined;
    if (typeof code === "string") {
      failureCode = code;
    }
  }

  let result;
  try {
    result = await evaluateMigrateDownGuard({
      probe: connected
        ? makeProbe(client)
        : async () => {
            throw Object.assign(new Error("connection not established"), { code: failureCode });
          },
    });
  } finally {
    if (connected && client !== null) {
      // Never let a close failure change the verdict or print anything.
      await client.end().catch(() => undefined);
    }
  }

  if (result.decision === "permit") {
    console.log(result.message);
    process.exit(EXIT_PERMITTED);
  }
  console.error(result.message);
  process.exit(EXIT_REFUSED);
}

installSilentFailureHandlers();
await main();
