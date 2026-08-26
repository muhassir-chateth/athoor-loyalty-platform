/**
 * THE `migrate:down` ROW-COUNT PRECONDITION (task 6.5, Requirements 22.3, 23.5).
 *
 * WHY THIS EXISTS
 * ---------------
 * The four portal migrations (tasks 6.1–6.4) are additive: they only
 * `CREATE TABLE`. Their `down` functions are not additive — they `DROP TABLE`,
 * and what they drop is customer-entered data plus two records that cannot be
 * reconstructed from anything else. So `npm run migrate:down` is the one command
 * in the portal's toolchain that can destroy data, and it destroys it silently:
 * `DROP TABLE IF EXISTS` succeeds just as quietly on a table with ten thousand
 * rows as on an empty one.
 *
 * This module is the precondition that makes that impossible by accident. It
 * answers exactly one question — "is every table these migrations created
 * empty?" — and it answers `refuse` whenever it cannot prove the answer is yes.
 *
 * ROLLING BACK THE FEATURE IS NOT A MIGRATION
 * -------------------------------------------
 * Requirement 22.3: when the Portal_Feature_Flag is disabled after the portal has
 * been deployed, the storefront presents the previous account experience WITHOUT
 * a further deployment. That is the rollback. It is a flag flip. It takes effect
 * with no schema change, and because the migrations are additive, leaving the
 * five tables in place while the flag is off costs nothing and breaks nothing.
 *
 * An operator reaching for `migrate:down` to "undo the portal" is therefore
 * reaching for the wrong lever, and the refusal message says so first, before it
 * says anything about row counts.
 *
 * THE SHARPEST CONSEQUENCE: A SECOND BIRTHDAY GRANT IN THE SAME YEAR
 * -----------------------------------------------------------------
 * `birthday_grants` is not history. The once-per-year guarantee of Requirement
 * 11.6 IS its `PRIMARY KEY (customer_id, grant_year)` — there is no application
 * lock behind it and no second record of who has been granted. Dropping that
 * table therefore does not lose a log; it REMOVES THE CONSTRAINT, so every
 * customer already granted this year becomes eligible again and can be granted a
 * second time. That is points issued twice for one birthday: a points-integrity
 * defect, in the ledger, from a command that looked like a rollback.
 *
 * `customer_erasure_requests` is the other irreplaceable one (Requirement 23.5):
 * it is the record that a customer exercised a deletion right and whether it was
 * honoured. Dropping it loses in-flight requests — the request is gone and the
 * customer is never told — and destroys the completed ones that are the evidence
 * the obligation was met.
 *
 * FAIL CLOSED, WITHOUT EXCEPTION
 * ------------------------------
 * Every path that is not "I read a count and it was zero" returns `refuse`:
 * no `DATABASE_URL`, connection refused, authentication failure, permission
 * denied, a count that does not parse, an unrecognised driver error, and — see
 * below — a table that does not exist. A guard that opens when it cannot see is
 * not a guard; it is a guard-shaped delay.
 *
 * A MISSING TABLE MEANS "I CANNOT TELL", NOT "NOTHING TO LOSE"
 * -----------------------------------------------------------
 * The tempting reading is that an absent table has no rows, so `down` can
 * destroy nothing, so permit. That reading is wrong for two reasons.
 *
 * First, absence is not an answer to the question asked. The guard is asked
 * whether the data these migrations hold is safe to drop. "The table is not
 * here" tells us only what is true of the database `DATABASE_URL` currently
 * resolves to — and by far the most common real cause of a portal table being
 * absent is that the connection points at a database where these migrations were
 * never applied, i.e. NOT the database the operator believes they are rolling
 * back. Permitting on absence is precisely the wrong-database failure that
 * `scripts/migration/_envIdentity.mjs` exists to prevent, arrived at from the
 * other direction.
 *
 * Second, if the migration IS recorded as applied in `pgmigrations` and its table
 * is missing, the schema and the migration ledger disagree. That is a state a
 * human needs to look at, not one to drive a `DROP` through.
 *
 * The cost of choosing "cannot tell" is near zero: each `down` already uses
 * `DROP TABLE IF EXISTS`, so permitting an absent table buys no capability that
 * matters — it only removes the check.
 *
 * WHY ALL FIVE TABLES, EVERY TIME
 * -------------------------------
 * `node-pg-migrate down` rolls back one migration by default, but the step count
 * is an argument the operator supplies, so at guard time the number of
 * migrations about to be reversed is unknown. The guard therefore assumes the
 * worst case it cannot rule out — all four — and requires all five tables to be
 * empty. Refusing while an unrelated older migration is the intended target is
 * correct rather than over-broad: `node-pg-migrate` reverses in reverse order, so
 * reaching an older migration means passing through these four first.
 *
 * NOTHING FROM AN ERROR REACHES THE OUTPUT
 * ----------------------------------------
 * The guard runs where `DATABASE_URL` is in scope, and Postgres/Node errors
 * routinely carry it: `pg` embeds host and port in connection failures, and
 * Node's `ERR_INVALID_URL` puts the whole malformed URL on `error.input`, which
 * `console.error(err)` prints. `logRedaction.ts` (task 5.7) closed that leak
 * class for the service log; this module closes it for a shell.
 *
 * {@link classifyCountFailure} is how. It reads ONE property of the error —
 * `code` — compares it against a fixed table, and returns a member of a closed
 * union of literal strings. No `message`, no `stack`, no `input`, no unmatched
 * `code` value is ever read into the result, so there is no data path along which
 * a connection string could travel from an error into anything this module
 * renders. The guarantee is structural, not a filter that has to be kept
 * up to date.
 */

/** One of the four portal migrations and the tables its `down` would drop. */
export interface PortalMigrationDefinition {
  /** The migration's timestamp prefix, as node-pg-migrate records it. */
  readonly version: string;
  /** The migration filename, quoted verbatim in the refusal so it is greppable. */
  readonly filename: string;
  /** Every table this migration's `up` creates, in creation order. */
  readonly tables: readonly string[];
}

/**
 * The four portal migrations and their five tables, in application order.
 *
 * This list is the guard's whole notion of scope and is deliberately a frozen
 * literal rather than something derived by reading the migrations directory: a
 * derived list would silently widen or narrow when unrelated migrations are
 * added, and a guard whose scope moves on its own is not a guard. A fifth portal
 * migration must be added here by hand, which is the point.
 */
export const PORTAL_MIGRATIONS = [
  {
    version: "1786000000000",
    filename: "1786000000000_create-customer-birthdays.ts",
    tables: ["customer_birthdays", "birthday_grants"],
  },
  {
    version: "1786100000000",
    filename: "1786100000000_create-fragrance-preferences.ts",
    tables: ["customer_fragrance_preferences"],
  },
  {
    version: "1786200000000",
    filename: "1786200000000_create-communication-preferences.ts",
    tables: ["customer_communication_preferences"],
  },
  {
    version: "1786300000000",
    filename: "1786300000000_create-erasure-requests.ts",
    tables: ["customer_erasure_requests"],
  },
] as const satisfies readonly PortalMigrationDefinition[];

/** The table whose loss is a points-integrity defect rather than lost history. */
export const GRANT_GUARD_TABLE = "birthday_grants";

/** The table whose loss destroys the evidence that a deletion right was honoured. */
export const ERASURE_AUDIT_TABLE = "customer_erasure_requests";

/**
 * Why a count could not be established.
 *
 * A CLOSED UNION OF LITERALS, deliberately. This is the only value derived from a
 * driver error that survives into the guard's output, so it is a fixed vocabulary
 * rather than anything copied out of the error. That is what makes
 * "no connection string can reach the output" a property of the types rather
 * than a promise about a regular expression.
 */
export type CountUnavailableReason =
  | "no_database_configured"
  | "database_url_unusable"
  | "connection_unavailable"
  | "permission_denied"
  | "table_absent"
  | "count_unreadable"
  | "unclassified_failure";

/** Operator-facing wording for each reason. Contains no interpolated values. */
const REASON_EXPLANATION: Readonly<Record<CountUnavailableReason, string>> = {
  no_database_configured:
    "DATABASE_URL is not set, so no count could be attempted at all. Refusing rather than assuming an empty database.",
  database_url_unusable:
    "DATABASE_URL is set but could not be parsed as a connection URL. Its value is deliberately not echoed here.",
  connection_unavailable:
    "the database could not be reached or would not authenticate, so the row count is unknown.",
  permission_denied:
    "the connected role may not read this table, so the row count is unknown to this guard even though rows may exist.",
  table_absent:
    "the table does not exist in the connected database. That is NOT proof there is nothing to lose — see below.",
  count_unreadable:
    "the count query returned a value that is not a whole non-negative number, so it was not trusted.",
  unclassified_failure:
    "the count failed for a reason this guard does not recognise. The underlying error is not printed, because it may carry the connection string.",
};

/** What the guard established about one table. */
export type TableFinding = {
  readonly table: string;
  readonly migrationFilename: string;
} & (
  | { readonly status: "empty" }
  | { readonly status: "occupied"; readonly rowCount: number }
  | { readonly status: "unknown"; readonly reason: CountUnavailableReason }
);

/** The guard's verdict. `permit` only when every table was proven empty. */
export type GuardDecision = "permit" | "refuse";

export interface MigrateDownGuardResult {
  readonly decision: GuardDecision;
  /** One finding per table, in migration order. */
  readonly findings: readonly TableFinding[];
  /** The message to print. Self-contained; safe to write to stdout or stderr. */
  readonly message: string;
}

/**
 * Reads `SELECT count(*)` for one table.
 *
 * Injected rather than owned so the decision logic is testable without a
 * Postgres: the tests supply fakes, and the operator CLI supplies the only
 * implementation that opens a socket. The probe is expected to REJECT on
 * failure; every rejection becomes a `refuse`.
 */
export type RowCountProbe = (table: string) => Promise<number>;

export interface MigrateDownGuardInput {
  /**
   * `null` means no database is configured — every table becomes
   * `no_database_configured` and the decision is `refuse`. Modelled explicitly
   * rather than as a probe that always throws, because "nothing was even
   * attempted" is a different thing to tell an operator than "the attempt
   * failed".
   */
  readonly probe: RowCountProbe | null;
  /** Overridable for tests only; defaults to {@link PORTAL_MIGRATIONS}. */
  readonly migrations?: readonly PortalMigrationDefinition[];
}

/**
 * Postgres SQLSTATEs and Node system error codes this guard recognises.
 *
 * Only the KEYS of this table are ever compared against `error.code`, and only
 * the VALUES are ever emitted. An unrecognised code produces
 * `unclassified_failure` and is not echoed, so a code whose value happens to be
 * attacker- or environment-controlled cannot become output.
 */
const ERROR_CODE_REASONS: Readonly<Record<string, CountUnavailableReason>> = {
  // -- Postgres SQLSTATEs ---------------------------------------------------
  "42P01": "table_absent", // undefined_table
  "3F000": "table_absent", // invalid_schema_name
  "42501": "permission_denied", // insufficient_privilege
  "28000": "connection_unavailable", // invalid_authorization_specification
  "28P01": "connection_unavailable", // invalid_password
  "3D000": "connection_unavailable", // invalid_catalog_name (no such database)
  "53300": "connection_unavailable", // too_many_connections
  "57P03": "connection_unavailable", // cannot_connect_now
  "08006": "connection_unavailable", // connection_failure
  "08001": "connection_unavailable", // sqlclient_unable_to_establish_sqlconnection
  // -- Node / libuv socket + DNS failures ----------------------------------
  ECONNREFUSED: "connection_unavailable",
  ECONNRESET: "connection_unavailable",
  ENOTFOUND: "connection_unavailable",
  EAI_AGAIN: "connection_unavailable",
  ETIMEDOUT: "connection_unavailable",
  EHOSTUNREACH: "connection_unavailable",
  ENETUNREACH: "connection_unavailable",
  EPIPE: "connection_unavailable",
  // -- Node URL parsing ----------------------------------------------------
  ERR_INVALID_URL: "database_url_unusable",
};

/**
 * Maps a thrown value onto the closed reason union.
 *
 * READS `error.code` AND NOTHING ELSE. Not `message`, not `stack`, not `input`,
 * not `cause`. That restriction is the leak-proofing: `pg` connection errors and
 * Node's `ERR_INVALID_URL` both carry the connection string in properties this
 * function never touches, and the value returned is always one of the literals
 * above, never a fragment of the error.
 */
export function classifyCountFailure(error: unknown): CountUnavailableReason {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unclassified_failure";
  }
  const { code } = error as { code?: unknown };
  if (typeof code !== "string") {
    return "unclassified_failure";
  }
  // Own-property lookup only: a `code` of "toString" or "__proto__" must not
  // match something inherited from Object.prototype.
  if (!Object.prototype.hasOwnProperty.call(ERROR_CODE_REASONS, code)) {
    return "unclassified_failure";
  }
  return ERROR_CODE_REASONS[code] ?? "unclassified_failure";
}

/**
 * A plain, unquoted Postgres identifier: lower-case, no spaces, no quotes, no
 * semicolons, at most 63 bytes.
 *
 * The guard only ever counts tables from the frozen {@link PORTAL_MIGRATIONS}
 * list, so this is defence in depth rather than input validation — but the CLI
 * builds `SELECT count(*) FROM <ident>`, where an identifier cannot be a bound
 * parameter, so the one place string interpolation is unavoidable is gated on a
 * check that is exported and tested rather than assumed.
 */
export function isSafeTableIdentifier(table: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(table);
}

/** Every table the guard checks, flattened, in migration order. */
export function portalTablesInOrder(
  migrations: readonly PortalMigrationDefinition[] = PORTAL_MIGRATIONS,
): readonly { readonly table: string; readonly migrationFilename: string }[] {
  return migrations.flatMap((migration) =>
    migration.tables.map((table) => ({ table, migrationFilename: migration.filename })),
  );
}

/**
 * Establishes a finding for one table.
 *
 * A count is only believed when it is a whole, non-negative, safe integer.
 * `pg` returns `count(*)` as a string because it is a `bigint`, so the CLI
 * converts it; a `NaN` from a failed conversion must not be read as zero, which
 * is what `count_unreadable` exists to prevent.
 */
async function probeOne(
  probe: RowCountProbe,
  table: string,
  migrationFilename: string,
): Promise<TableFinding> {
  if (!isSafeTableIdentifier(table)) {
    // Unreachable for PORTAL_MIGRATIONS; refuses rather than throws so a
    // mis-edited list degrades to "cannot tell" instead of a stack trace.
    return { table, migrationFilename, status: "unknown", reason: "unclassified_failure" };
  }

  let raw: number;
  try {
    raw = await probe(table);
  } catch (error) {
    return { table, migrationFilename, status: "unknown", reason: classifyCountFailure(error) };
  }

  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return { table, migrationFilename, status: "unknown", reason: "count_unreadable" };
  }
  return raw === 0
    ? { table, migrationFilename, status: "empty" }
    : { table, migrationFilename, status: "occupied", rowCount: raw };
}

/**
 * Runs the precondition and produces the verdict plus the message to print.
 *
 * Sequential rather than concurrent: five queries, and a stable output order
 * matters more here than a few milliseconds. It also means a database that is
 * refusing connections is hit once per table rather than five times at once.
 */
export async function evaluateMigrateDownGuard(
  input: MigrateDownGuardInput,
): Promise<MigrateDownGuardResult> {
  const migrations = input.migrations ?? PORTAL_MIGRATIONS;
  const targets = portalTablesInOrder(migrations);

  const findings: TableFinding[] = [];
  for (const { table, migrationFilename } of targets) {
    findings.push(
      input.probe === null
        ? { table, migrationFilename, status: "unknown", reason: "no_database_configured" }
        : await probeOne(input.probe, table, migrationFilename),
    );
  }

  const decision: GuardDecision = findings.every((f) => f.status === "empty")
    ? "permit"
    : "refuse";

  return {
    decision,
    findings,
    message: decision === "permit" ? buildPermitMessage(findings) : buildRefusalMessage(findings),
  };
}

/** Right-pads to a column width so the findings block lines up in a terminal. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** One line per table: what was found, and for `unknown`, why. */
export function formatFindings(findings: readonly TableFinding[]): string {
  const nameWidth = Math.max(5, ...findings.map((f) => f.table.length));
  const lines = [`  ${pad("table", nameWidth)}  rows`, `  ${"-".repeat(nameWidth)}  ----`];
  for (const finding of findings) {
    const value =
      finding.status === "empty"
        ? "0  (empty)"
        : finding.status === "occupied"
          ? `${finding.rowCount}  <-- NOT EMPTY`
          : `unknown  <-- ${finding.reason}`;
    lines.push(`  ${pad(finding.table, nameWidth)}  ${value}`);
  }
  const reasons = [
    ...new Set(
      findings.flatMap((f) => (f.status === "unknown" ? [f.reason] : [])),
    ),
  ];
  for (const reason of reasons) {
    lines.push("", `  ${reason}: ${REASON_EXPLANATION[reason]}`);
  }
  return lines.join("\n");
}

/**
 * The refusal.
 *
 * Ordered by what the operator most needs to know rather than by what the guard
 * measured: the flag flip first (because it is almost always what was actually
 * wanted), then the second-grant consequence (because it is the one that damages
 * the ledger), then the erasure audit, then the counts, and last — stated plainly
 * rather than hidden — how to proceed anyway.
 *
 * Requirements 22.3 and 23.5 are satisfied by the first three blocks; they are
 * present in EVERY refusal, including a refusal caused by an unreachable
 * database, because an operator who cannot reach the database is exactly as
 * likely to be reaching for the wrong lever as one who can.
 */
export function buildRefusalMessage(findings: readonly TableFinding[]): string {
  const occupied = findings.filter((f) => f.status === "occupied");
  const unknown = findings.filter((f) => f.status === "unknown");

  const headline =
    occupied.length > 0
      ? `REFUSING migrate:down — ${occupied.length} of the ${findings.length} portal tables still hold rows.`
      : `REFUSING migrate:down — the row count could not be established for ${unknown.length} of the ${findings.length} portal tables.`;

  return [
    "",
    "==============================================================",
    ` ${headline}`,
    "==============================================================",
    "",
    "ROLLING BACK THE PORTAL IS A FEATURE-FLAG FLIP, NOT A MIGRATION.",
    "  Disabling the Portal_Feature_Flag returns the storefront to the previous",
    "  account experience with no further deployment and no schema change",
    "  (Requirement 22.3). All four portal migrations are additive, so leaving",
    "  these tables in place while the flag is off costs nothing and loses",
    "  nothing. If your goal is to turn the portal off, flip the flag and stop",
    "  here — migrate:down is not the lever you want.",
    "",
    `A ROLLBACK OF MIGRATION 1 WOULD PERMIT A SECOND BIRTHDAY GRANT IN THE SAME YEAR.`,
    "  1786000000000_create-customer-birthdays.ts drops `birthday_grants`, and",
    "  that table is not a log — the once-per-year guarantee IS its",
    "  PRIMARY KEY (customer_id, grant_year), with nothing behind it. Dropping it",
    "  removes the constraint, so every customer already granted this year becomes",
    "  eligible again and CAN BE GRANTED A SECOND TIME. That is points issued",
    "  twice for one birthday, written into the ledger, by a command that looked",
    "  like a rollback. It also drops `customer_birthdays`, which is data the",
    "  customer typed and which cannot be re-derived from anywhere.",
    "",
    "A ROLLBACK OF MIGRATION 4 WOULD DESTROY DELETION-REQUEST EVIDENCE.",
    "  1786300000000_create-erasure-requests.ts drops `customer_erasure_requests`.",
    "  Open requests are lost silently — the customer is never told and never",
    "  chases it — and completed rows are the record that the obligation was met",
    "  (Requirement 23.5).",
    "",
    "WHAT THIS GUARD FOUND",
    formatFindings(findings),
    "",
    ...(unknown.length > 0
      ? [
          "WHY AN UNKNOWN COUNT IS A REFUSAL",
          "  This guard permits migrate:down only when it has PROVEN every table is",
          "  empty. It cannot prove that here, so it refuses. In particular, a table",
          "  that DOES NOT EXIST is not evidence that there is nothing to lose: the",
          "  usual cause is that DATABASE_URL points at a database where these",
          "  migrations were never applied — that is, not the one you mean to roll",
          "  back. Confirm which database you are connected to before going further.",
          "",
        ]
      : []),
    "IF YOU HAVE DECIDED TO PROCEED ANYWAY",
    "  This precondition wraps `npm run migrate:down` only. `npx node-pg-migrate",
    "  down` is still one command away, deliberately: this is a stop-and-think for",
    "  an operator who has not yet considered `birthday_grants`, not a security",
    "  boundary. Take a verified backup first, and expect to reconcile birthday",
    "  grants by hand afterwards.",
    "",
  ].join("\n");
}

/** The permit. Short, and still names what is about to be dropped. */
export function buildPermitMessage(findings: readonly TableFinding[]): string {
  return [
    "",
    `migrate:down precondition PASSED — all ${findings.length} portal tables are empty.`,
    "",
    formatFindings(findings),
    "",
    "  Proceeding. Note that rolling back the portal FEATURE never requires this:",
    "  disabling the Portal_Feature_Flag is sufficient and needs no deployment",
    "  (Requirement 22.3). This is safe only because there is currently no",
    "  birthday-grant record and no deletion-request record to lose.",
    "",
  ].join("\n");
}
