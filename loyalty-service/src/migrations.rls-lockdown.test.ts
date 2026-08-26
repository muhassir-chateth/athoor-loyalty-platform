/**
 * Migration tests for the RLS lockdown (`1786400000000_enable-rls-and-revoke-public-api.ts`).
 *
 * WHAT THIS VERIFIES, AND WHAT IT HONESTLY CANNOT
 * ===============================================
 * NO DATABASE IS TOUCHED AND NONE IS AVAILABLE. There is no Postgres in CI and
 * this test introduces no dependency on one, matching the shipped approach in
 * `migrations.test.ts`, `migrations.profile.test.ts` and their siblings: the
 * migration's `up`/`down` run against a capturing `MigrationBuilder` stub and
 * every assertion is made against the emitted DDL.
 *
 * That means this test proves the migration SAYS the right things. It cannot
 * prove PostgreSQL DOES the right things in response — that `anon` really loses
 * its SELECT, that the owner really bypasses RLS, that the `pg_roles` guards
 * really fire on a database without the Supabase roles. Those are properties of
 * the server, verifiable only by applying the migration and querying
 * `pg_policies`, `information_schema.role_table_grants` and `pg_class.relrowsecurity`
 * afterwards. Nothing below should be read as evidence that the lockdown was
 * applied or that a live privilege check was performed, because neither happened.
 *
 * WHAT IT DOES ESTABLISH is the set of things a reviewer would otherwise have to
 * eyeball, and the one thing eyeballing cannot keep doing over time:
 *
 *   1. COVERAGE, against a table universe DISCOVERED rather than typed in. Every
 *      `CREATE TABLE` in every other migration is parsed, and the lockdown must
 *      name all of them. This is the assertion that matters most, because it is
 *      the one that fails LATER — the day somebody adds a migration creating a
 *      table and does not add it to the roster, this test goes red instead of a
 *      table quietly sitting in `public` with RLS off.
 *   2. That no policy exists, and specifically that no `USING (true)` policy was
 *      added to silence the advisor while changing nothing.
 *   3. That `FORCE ROW LEVEL SECURITY` appears nowhere.
 *   4. That the revokes actually cover both client-API roles at all four levels.
 *   5. That `service_role` is never revoked from.
 *   6. That no schema other than `public` is named.
 *   7. That the migration destroys nothing.
 *   8. That the scanners above are not vacuous — each is shown rejecting a
 *      synthetic violation, because a scanner that matches nothing passes
 *      everything.
 *
 * WHY COVERAGE IS ASSERTED AS ⊇ RATHER THAN =
 * ===========================================
 * The roster in the migration names thirty tables. On `main` only twenty-five of
 * them exist: `customer_birthdays`, `birthday_grants`,
 * `customer_fragrance_preferences`, `customer_communication_preferences` and
 * `customer_erasure_requests` are created by the portal migration stack, which is
 * not yet merged. A strict set equality would therefore fail on `main` and pass
 * only after an unrelated merge, which would make this test a nuisance rather
 * than a gate.
 *
 * So the property is split in two, and BOTH are asserted:
 *   - EVERY DISCOVERED TABLE IS COVERED. This is the gate. It has no allowance
 *     and no exception list.
 *   - EVERY COVERED TABLE IS EITHER DISCOVERED OR NAMED IN
 *     {@link KNOWN_FORWARD_TABLES}. This stops the roster drifting the other
 *     way, accumulating names for tables that do not and will not exist.
 * Together they are equality-modulo-one-named-and-bounded-exception, and once
 * the portal stack merges the exception set empties out and they collapse into
 * exact equality with no edit here.
 *
 * DOLLAR-QUOTING IS HANDLED, UNLIKE IN THE SIBLING TESTS
 * =====================================================
 * `migrations.portal-additive.test.ts` says outright that its splitter does not
 * handle `$$ … $$`, which was fine for migrations made of plain `CREATE TABLE`.
 * This migration is made almost entirely of `DO $$ … $$` blocks containing
 * semicolons, so a splitter that ignored dollar-quoting would shred one DO block
 * into eight fragments and every "statement" assertion below would be measuring
 * nonsense. {@link splitStatements} tracks dollar tags, so a DO block stays one
 * statement. {@link splitterHandlesDollarQuoting} asserts that it does.
 *
 * SQL COMMENTS ARE STRIPPED BEFORE ANALYSIS
 * =========================================
 * Every scan runs on comment-stripped, executable text. The migration's SQL
 * carries explanatory `--` comments, and a comment grants nothing and revokes
 * nothing; scanning it would only produce false failures on a comment that says
 * "do not add FORCE ROW LEVEL SECURITY" — which is a comment this migration
 * deliberately contains. That trade is recorded here because it is the one place
 * these assertions look at less than the raw source. It also means the loud
 * warnings in the migration are invisible to these scanners, by design.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------

/** The migration under test, matched on disk rather than imported by path. */
const SUBJECT_PATTERN = /_enable-rls-and-revoke-public-api\.ts$/;

/** The expected filename, asserted so a rename cannot silently orphan this test. */
const SUBJECT_FILENAME = "1786400000000_enable-rls-and-revoke-public-api.ts";

/** The two roles that must lose every privilege on `public`. */
const LOCKED_OUT = ["anon", "authenticated"] as const;

/**
 * The role that must KEEP its privileges.
 *
 * `service_role` is `BYPASSRLS` and Supabase internals authenticate as it, so
 * revoking from it would break platform features without improving safety — a
 * `BYPASSRLS` role ignores RLS regardless. The control for `service_role` is
 * that its key never reaches a browser, which is an operational fact no
 * migration can assert.
 */
const PRESERVED_ROLE = "service_role";

/**
 * The only schema this migration may name.
 *
 * `pgboss` is called out explicitly below: the job queue has its own schema and
 * its own owner, and a lockdown that swept it would be changing a component this
 * change has no business touching.
 */
const PERMITTED_SCHEMA = "public";

/** Schemas that must never appear, whatever the scanners think a schema position is. */
const FORBIDDEN_SCHEMAS = ["pgboss", "auth", "storage", "extensions", "graphql", "vault", "realtime"] as const;

/**
 * Tables the roster may name that no migration on this branch creates.
 *
 * These five come from the portal stack (`1786000000000`–`1786300000000`), which
 * is not merged to `main`. The lockdown must be mergeable on its own, so it names
 * them ahead of time and guards each on `pg_tables` at apply time. They are
 * listed here — rather than the coverage check simply allowing any surplus — so
 * that a roster entry for a table that will never exist still fails.
 */
const KNOWN_FORWARD_TABLES = [
  "customer_birthdays",
  "birthday_grants",
  "customer_fragrance_preferences",
  "customer_communication_preferences",
  "customer_erasure_requests",
] as const;

/**
 * Tables whose exposure is named in the advisory finding, asserted by name.
 *
 * The discovered-universe check above already covers these, but a universe-driven
 * assertion can only fail on what it discovers. If migration parsing ever broke
 * and discovered nothing, that check would pass vacuously while these would not.
 * `discount_codes` is first because it is the monetary one.
 */
const MUST_COVER_BY_NAME = ["discount_codes", "customers", "ledger_entries"] as const;

// ---------------------------------------------------------------------------
// A capturing MigrationBuilder that also notices what it was NOT asked to do
// ---------------------------------------------------------------------------

interface RecordingBuilder {
  readonly calls: string[];
  readonly otherMembersUsed: string[];
  readonly builder: unknown;
}

/**
 * Records `pgm.sql()` calls AND every other builder member touched.
 *
 * The second half matters more than it looks. A DDL-scanning test that only
 * implemented `sql` would give a clean bill of health to a migration written
 * with `pgm.dropTable()`: the scanner would find no statements and every
 * "contains no FORCE" assertion would pass by finding nothing. Recording the
 * miss, and asserting there were none, closes that hole.
 */
function makeRecordingBuilder(): RecordingBuilder {
  const calls: string[] = [];
  const otherMembersUsed: string[] = [];

  const target = {
    sql(statement: string): void {
      calls.push(statement);
    },
  };

  const builder = new Proxy(target as Record<string, unknown>, {
    get(obj, prop) {
      if (prop === "sql") return obj["sql"];
      const name = typeof prop === "symbol" ? prop.toString() : prop;
      if (name === "then" || name === "constructor" || name === "toJSON") {
        return undefined;
      }
      otherMembersUsed.push(name);
      return () => undefined;
    },
  });

  return { calls, otherMembersUsed, builder };
}

// ---------------------------------------------------------------------------
// SQL text utilities
// ---------------------------------------------------------------------------

/**
 * Removes `--` line comments, leaving executable SQL.
 *
 * Single-quoted literals are respected, so a comment marker inside a string
 * value is not mistaken for a comment. Dollar-quoted bodies need no special
 * handling here: a `--` inside a `DO $$ … $$` body IS a comment when the body
 * executes, and the single-quote tracking still protects literals nested inside
 * the body.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Collapses whitespace so assertions are insensitive to formatting. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Reads a dollar-quote tag (`$$` or `$tag$`) starting at `i`, or null.
 *
 * Scans forward without slicing, so this stays linear over the whole input.
 */
function dollarTagAt(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length) {
    const ch = sql[j] as string;
    if (ch === "$") return sql.slice(i, j + 1);
    if (!/[A-Za-z0-9_]/.test(ch)) return null;
    j += 1;
  }
  return null;
}

/**
 * Splits a `pgm.sql()` payload into statements on top-level `;`.
 *
 * Semicolons inside single-quoted literals and inside dollar-quoted bodies do
 * not split. The dollar-quoting half is what makes this usable on this
 * migration at all: every statement it emits is a `DO $$ … $$` block whose body
 * is full of semicolons, and a splitter without it would report eight
 * statements where there is one.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let openTag: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;

    if (openTag !== null) {
      if (sql.startsWith(openTag, i)) {
        current += openTag;
        i += openTag.length - 1;
        openTag = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (inString) {
      current += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }

    const tag = dollarTagAt(sql, i);
    if (tag !== null) {
      openTag = tag;
      current += tag;
      i += tag.length - 1;
      continue;
    }

    if (ch === ";") {
      statements.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  statements.push(current);
  return statements.map(normalize).filter((s) => s.length > 0);
}

/** Comment-stripped, split, normalized statements from a list of `pgm.sql()` payloads. */
export function executableStatements(calls: readonly string[]): string[] {
  return calls.flatMap((call) => splitStatements(stripSqlComments(call)));
}

// ---------------------------------------------------------------------------
// Scanner 1 — which tables get RLS
// ---------------------------------------------------------------------------

/**
 * The tables named in the migration's RLS roster array.
 *
 * Read from the DDL the migration actually emits, not from the exported
 * `RLS_TABLES` constant. The two are cross-checked in a test below, and the DDL
 * is the authority here because the DDL is what Postgres executes: a roster
 * constant that was never rendered into SQL would protect nothing.
 */
export function rosterTables(statements: readonly string[]): string[] {
  const found = new Set<string>();
  for (const statement of statements) {
    const arrayBlock = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([\s\S]*?)\]/i.exec(statement);
    if (arrayBlock === null) continue;
    const body = arrayBlock[1];
    if (body === undefined) continue;
    const scanner = /'([a-z_][a-z0-9_]*)'/gi;
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(body)) !== null) {
      const name = match[1];
      if (name !== undefined) found.add(name.toLowerCase());
    }
  }
  return [...found].sort();
}

/** True when the migration also sweeps `pg_tables` for anything off-roster. */
export function hasCatalogueSweep(statements: readonly string[]): boolean {
  return statements.some(
    (s) =>
      /\bFROM\s+pg_tables\b/i.test(s) &&
      /\bschemaname\s*=\s*'public'/i.test(s) &&
      /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s),
  );
}

/**
 * Discovered tables that the migration does not cover.
 *
 * The gate. No allowance list, on purpose.
 */
export function uncoveredTables(
  discovered: readonly string[],
  covered: readonly string[],
): string[] {
  const have = new Set(covered);
  return discovered.filter((t) => !have.has(t)).sort();
}

/** Covered tables that are neither discovered on disk nor a known forward table. */
export function unexplainedRosterEntries(
  covered: readonly string[],
  discovered: readonly string[],
  forward: readonly string[],
): string[] {
  const known = new Set([...discovered, ...forward]);
  return covered.filter((t) => !known.has(t)).sort();
}

// ---------------------------------------------------------------------------
// Scanner 2 — policies, and the USING (true) anti-pattern
// ---------------------------------------------------------------------------

/**
 * Policy-shaped text, in every spelling that would defeat the lockdown.
 *
 * A `USING (true)` policy is the specific failure this scanner exists for: it
 * satisfies the advisor's `rls_disabled_in_public` check, turns the dashboard
 * green, and leaves every row exactly as readable as before. Whitespace-tolerant
 * so `USING(true)` and `USING ( TRUE )` are caught too.
 */
const POLICY_FORMS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "CREATE POLICY", pattern: /\bCREATE\s+POLICY\b/i },
  { label: "ALTER POLICY", pattern: /\bALTER\s+POLICY\b/i },
  { label: "USING (true)", pattern: /\bUSING\s*\(\s*true\s*\)/i },
  { label: "WITH CHECK (true)", pattern: /\bWITH\s+CHECK\s*\(\s*true\s*\)/i },
  { label: "TO anon in a policy", pattern: /\bCREATE\s+POLICY\b[\s\S]*\bTO\s+anon\b/i },
];

export interface StatementProblem {
  readonly statement: string;
  readonly reason: string;
}

/** Every statement containing policy-shaped text. */
export function findPolicyStatements(statements: readonly string[]): StatementProblem[] {
  const problems: StatementProblem[] = [];
  for (const statement of statements) {
    for (const { label, pattern } of POLICY_FORMS) {
      if (pattern.test(statement)) {
        problems.push({ statement, reason: `contains ${label}` });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scanner 3 — FORCE ROW LEVEL SECURITY must not appear
// ---------------------------------------------------------------------------

/**
 * Finds `FORCE ROW LEVEL SECURITY`, which would take production down.
 *
 * `FORCE` extends RLS to the table OWNER. The loyalty service connects as
 * `postgres`, which owns all thirty tables, and this migration adds NO
 * POLICIES — so `FORCE` would deny the backend every row of every table.
 * Balances would read zero, enrolment would fail, and nothing would raise an
 * error: the queries would succeed and return nothing, which is the worst
 * possible shape for an outage. The owner bypass is not a gap being tolerated,
 * it is the mechanism that makes this migration safe to apply to a live system.
 *
 * This scanner exists because `FORCE` reads as the more secure option, so a
 * future reviewer hardening the file is precisely who would add it.
 */
export function findForceRls(statements: readonly string[]): StatementProblem[] {
  return statements
    .filter((s) => /\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s))
    .map((statement) => ({
      statement,
      reason: "FORCE ROW LEVEL SECURITY applies RLS to the table owner; the backend connects as the owner and there are no policies, so this would deny it every row",
    }));
}

// ---------------------------------------------------------------------------
// Scanner 4 — revoke coverage
// ---------------------------------------------------------------------------

/** The four privilege levels the lockdown has to reach. */
export type RevokeLevel = "schema" | "tables" | "sequences" | "functions" | "default_privileges";

/** One revoke found in the DDL: which level, which role. */
export interface RevokeFact {
  readonly level: RevokeLevel;
  readonly role: string;
  readonly isDefaultPrivileges: boolean;
}

const REVOKE_PATTERNS: readonly { readonly level: RevokeLevel; readonly pattern: RegExp }[] = [
  { level: "schema", pattern: /\bREVOKE\s+(?:ALL\s+(?:PRIVILEGES\s+)?|USAGE\s*)(?:ON\s+SCHEMA)\s+(\w+)\s+FROM\s+(\w+)/gi },
  { level: "tables", pattern: /\bREVOKE\s+ALL\s+(?:PRIVILEGES\s+)?ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+(\w+)\s+FROM\s+(\w+)/gi },
  { level: "sequences", pattern: /\bREVOKE\s+ALL\s+(?:PRIVILEGES\s+)?ON\s+ALL\s+SEQUENCES\s+IN\s+SCHEMA\s+(\w+)\s+FROM\s+(\w+)/gi },
  { level: "functions", pattern: /\bREVOKE\s+ALL\s+(?:PRIVILEGES\s+)?ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+(\w+)\s+FROM\s+(\w+)/gi },
];

/** `ALTER DEFAULT PRIVILEGES … REVOKE … ON <what> FROM <role>`. */
const DEFAULT_PRIVILEGES_REVOKE =
  /\bALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+(\w+)\s+REVOKE\s+ALL\s+ON\s+(TABLES|SEQUENCES|FUNCTIONS)\s+FROM\s+(\w+)/gi;

/** Every revoke the DDL performs, as (level, role) facts. */
export function findRevokes(statements: readonly string[]): RevokeFact[] {
  const facts: RevokeFact[] = [];
  for (const statement of statements) {
    for (const { level, pattern } of REVOKE_PATTERNS) {
      const scanner = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = scanner.exec(statement)) !== null) {
        const role = match[2];
        if (role !== undefined) {
          facts.push({ level, role: role.toLowerCase(), isDefaultPrivileges: false });
        }
      }
    }

    const scanner = new RegExp(DEFAULT_PRIVILEGES_REVOKE.source, DEFAULT_PRIVILEGES_REVOKE.flags);
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(statement)) !== null) {
      const role = match[3];
      if (role !== undefined) {
        facts.push({ level: "default_privileges", role: role.toLowerCase(), isDefaultPrivileges: true });
      }
    }
  }
  return facts;
}

/** Levels a given role is NOT revoked at. */
export function missingRevokeLevels(
  facts: readonly RevokeFact[],
  role: string,
  required: readonly RevokeLevel[],
): RevokeLevel[] {
  const covered = new Set(facts.filter((f) => f.role === role).map((f) => f.level));
  return required.filter((level) => !covered.has(level));
}

// ---------------------------------------------------------------------------
// Scanner 5 — service_role must never be revoked from
// ---------------------------------------------------------------------------

/**
 * Every statement that revokes anything from `service_role`.
 *
 * Word-boundary matched so this is precise in both directions: it catches
 * `FROM service_role` and does not false-match a hypothetical
 * `service_role_audit`.
 */
export function findServiceRoleRevokes(statements: readonly string[]): StatementProblem[] {
  const problems: StatementProblem[] = [];
  for (const statement of statements) {
    if (!/\bREVOKE\b/i.test(statement)) continue;
    if (new RegExp(`\\bFROM\\s+${PRESERVED_ROLE}\\b`, "i").test(statement)) {
      problems.push({
        statement,
        reason: `revokes from ${PRESERVED_ROLE}, which is BYPASSRLS and used by Supabase internals`,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scanner 6 — only schema public may be named
// ---------------------------------------------------------------------------

/**
 * Every identifier in a schema position.
 *
 * Four shapes, because the migration names `public` in four different ways:
 * `ON SCHEMA public`, `IN SCHEMA public`, `schemaname = 'public'` (the catalogue
 * predicate that scopes the sweep) and `public.%I` (the qualified target of the
 * generated ALTER). A scanner that only knew about `IN SCHEMA` would miss a
 * sweep silently widened to another schema.
 */
const SCHEMA_POSITION_PATTERNS: readonly RegExp[] = [
  /\b(?:IN|ON)\s+SCHEMA\s+([a-z_][a-z0-9_]*)/gi,
  /\bschemaname\s*=\s*'([a-z_][a-z0-9_]*)'/gi,
  /\b([a-z_][a-z0-9_]*)\.(?:%I|[a-z_][a-z0-9_]*)\b/gi,
];

/** Distinct schema-position identifiers, lower-cased and sorted. */
export function findSchemaReferences(statements: readonly string[]): string[] {
  const found = new Set<string>();
  for (const statement of statements) {
    for (const pattern of SCHEMA_POSITION_PATTERNS) {
      const scanner = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = scanner.exec(statement)) !== null) {
        const name = match[1];
        if (name !== undefined) found.add(name.toLowerCase());
      }
    }
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Scanner 7 — the migration destroys nothing
// ---------------------------------------------------------------------------

/**
 * Data-destroying forms.
 *
 * Each is delimiter-anchored so a column or variable name cannot trip it:
 * `updated_at` must not read as `UPDATE`, and `DISABLE ROW LEVEL SECURITY` —
 * which `down` legitimately uses — must not read as a DROP.
 */
const DESTRUCTIVE_FORMS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "DROP", pattern: /\bDROP\s+(?:TABLE|INDEX|COLUMN|CONSTRAINT|SCHEMA|TYPE|VIEW|SEQUENCE|POLICY|DATABASE|ROLE|OWNED)\b/i },
  { label: "ALTER TABLE … DROP", pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i },
  { label: "DELETE FROM", pattern: /\bDELETE\s+FROM\b/i },
  { label: "UPDATE", pattern: /\bUPDATE\s+[a-z_"]/i },
  { label: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { label: "INSERT INTO", pattern: /\bINSERT\s+INTO\b/i },
  { label: "DROP ROLE", pattern: /\bDROP\s+ROLE\b/i },
];

/** Every statement that would destroy data or drop an object. */
export function findDestructiveStatements(statements: readonly string[]): StatementProblem[] {
  const problems: StatementProblem[] = [];
  for (const statement of statements) {
    for (const { label, pattern } of DESTRUCTIVE_FORMS) {
      if (pattern.test(statement)) {
        problems.push({ statement, reason: `contains ${label}` });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scanner 8 — role guards, so a plain-Postgres apply does not abort
// ---------------------------------------------------------------------------

/**
 * Statements that name a Supabase-created role without a `pg_roles` guard.
 *
 * `anon`, `authenticated` and `service_role` exist only on Supabase. On a
 * developer laptop or a CI container an unguarded REVOKE naming them aborts the
 * whole migration, so every statement mentioning one must also test for its
 * existence.
 */
export function findUnguardedRoleStatements(statements: readonly string[]): StatementProblem[] {
  const problems: StatementProblem[] = [];
  for (const statement of statements) {
    const namesRole = LOCKED_OUT.some((role) => new RegExp(`\\b${role}\\b`, "i").test(statement));
    if (!namesRole) continue;
    if (!/\bFROM\s+pg_roles\b/i.test(statement) || !/\brolname\s*=/i.test(statement)) {
      problems.push({ statement, reason: "names a Supabase role without a pg_roles existence guard" });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Discovery: the subject, and the table universe it has to cover
// ---------------------------------------------------------------------------

interface MigrationModule {
  up: (pgm: unknown) => Promise<void>;
  down: (pgm: unknown) => Promise<void>;
  shorthands?: unknown;
  RLS_TABLES?: readonly string[];
  LOCKED_OUT_ROLES?: readonly string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

/** Numeric timestamp prefix of a `node-pg-migrate` filename, or null. */
function versionOf(filename: string): number | null {
  const match = /^(\d+)_/.exec(filename);
  if (match === null || match[1] === undefined) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** All migration filenames on disk, sorted by timestamp then name. */
function allMigrationFilenames(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".ts") && versionOf(f) !== null)
    .sort((a, b) => (versionOf(a) as number) - (versionOf(b) as number) || a.localeCompare(b));
}

let subjectFilename: string;
let mod: MigrationModule;
let upCalls: readonly string[];
let downCalls: readonly string[];
let up: string[];
let down: string[];
let both: string[];
let otherMembersUsed: string[];

/**
 * Every table created by every migration OTHER than the subject.
 *
 * Read as TEXT rather than executed: this needs only the names, and executing
 * eighteen unrelated migrations to learn them would be a far larger surface.
 * This is the universe the lockdown must cover, and it is discovered on every
 * run — which is what makes a table added next month a failure here rather than
 * a silent exposure.
 */
let discoveredTables: string[];

beforeAll(async () => {
  const all = allMigrationFilenames();
  expect(all.length, "migrations directory should not be empty").toBeGreaterThan(0);

  const found = all.find((f) => SUBJECT_PATTERN.test(f));
  expect(found, `should find the RLS lockdown migration among [${all.join(", ")}]`).toBeDefined();
  subjectFilename = found as string;

  const universe = new Set<string>();
  for (const filename of all) {
    if (filename === subjectFilename) continue;
    const source = readFileSync(join(migrationsDir, filename), "utf8");
    const scanner = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(source)) !== null) {
      const name = match[1];
      if (name !== undefined) universe.add(name.toLowerCase());
    }
  }
  discoveredTables = [...universe].sort();

  const url = pathToFileURL(join(migrationsDir, subjectFilename)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  const upRec = makeRecordingBuilder();
  await mod.up(upRec.builder);

  const downRec = makeRecordingBuilder();
  await mod.down(downRec.builder);

  upCalls = upRec.calls;
  downCalls = downRec.calls;
  up = executableStatements(upRec.calls);
  down = executableStatements(downRec.calls);
  both = [...up, ...down];
  otherMembersUsed = [...upRec.otherMembersUsed, ...downRec.otherMembersUsed];
});

// ---------------------------------------------------------------------------
// Discovery soundness and house conventions
// ---------------------------------------------------------------------------

describe("discovery — the subject and the universe it must cover", () => {
  it("finds the lockdown migration at the expected timestamped filename", () => {
    expect(subjectFilename).toBe(SUBJECT_FILENAME);
  });

  it("sorts after every other migration and its timestamp is unique", () => {
    const all = allMigrationFilenames();
    const subjectVersion = versionOf(subjectFilename) as number;
    expect(subjectVersion).toBe(1786400000000);
    expect(subjectVersion).toBeGreaterThan(1786300000000);

    const others = all.filter((f) => f !== subjectFilename).map((f) => versionOf(f) as number);
    for (const version of others) {
      expect(version, "every other migration should sort before the lockdown").toBeLessThan(subjectVersion);
    }
    expect(others.filter((v) => v === subjectVersion)).toEqual([]);
    // Applies last, so it can lock down everything created before it.
    expect(all.at(-1)).toBe(SUBJECT_FILENAME);
  });

  it("exports up, down and shorthands, per the house convention", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect("shorthands" in mod).toBe(true);
  });

  it("discovered a substantial table universe from the other migrations", () => {
    // Non-vacuity for the coverage gate: if migration parsing broke and found
    // nothing, `uncoveredTables` would return [] and the gate would pass while
    // protecting nothing. These bounds make that impossible.
    expect(discoveredTables.length).toBeGreaterThanOrEqual(25);
    for (const table of MUST_COVER_BY_NAME) {
      expect(discoveredTables, `${table} should be discovered from the migrations`).toContain(table);
    }
  });
});

// ---------------------------------------------------------------------------
// Assertion 1 — RLS coverage against the discovered universe (THE GATE)
// ---------------------------------------------------------------------------

describe("RLS coverage — every table in the discovered universe is locked down", () => {
  it("covers every table created by every other migration", () => {
    // THIS IS THE ASSERTION THAT MATTERS. If it fails after a new migration
    // lands, the fix is to add that table to RLS_TABLES in the lockdown — never
    // to relax this. A table in `public` with RLS off is a Data API read away
    // from being public.
    const covered = rosterTables(up);
    expect(
      uncoveredTables(discoveredTables, covered),
      "tables created by a migration but missing from the RLS roster",
    ).toEqual([]);
  });

  it("names no table that neither exists nor is a known forward table", () => {
    // The other direction, so the roster cannot drift into naming tables that
    // will never exist. The five allowed surplus entries are the unmerged portal
    // stack, and they are named rather than waved through.
    const covered = rosterTables(up);
    expect(
      unexplainedRosterEntries(covered, discoveredTables, KNOWN_FORWARD_TABLES),
      "roster entries with no corresponding CREATE TABLE anywhere",
    ).toEqual([]);
  });

  it("covers the specifically named sensitive tables", () => {
    const covered = rosterTables(up);
    for (const table of MUST_COVER_BY_NAME) {
      expect(covered, `${table} must be behind RLS`).toContain(table);
    }
  });

  it("the exported roster matches the roster actually rendered into SQL", () => {
    // A constant that never reached the DDL would protect nothing.
    const exported = [...(mod.RLS_TABLES ?? [])].map((t) => t.toLowerCase()).sort();
    expect(exported.length, "RLS_TABLES should be exported and non-empty").toBeGreaterThan(0);
    expect(rosterTables(up)).toEqual(exported);
  });

  it("enables RLS through ALTER TABLE … ENABLE ROW LEVEL SECURITY", () => {
    expect(up.join(" ")).toMatch(/\bALTER\s+TABLE\b[\s\S]*\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  });

  it("also sweeps the catalogue, so an unrostered table is still covered", () => {
    // Belt to the roster's braces: a table created from the dashboard or by a
    // hotfix never appears in any migration, so the discovered universe cannot
    // see it either. The sweep is what covers that case.
    expect(hasCatalogueSweep(up)).toBe(true);
  });

  it("guards every roster entry on pg_tables, so a not-yet-created table is skipped", () => {
    // Without this the migration would abort on `main`, where the five portal
    // tables do not exist yet — which is exactly the merge-alone requirement.
    const rosterStatement = up.find((s) => /FOREACH/i.test(s));
    expect(rosterStatement, "should find the roster loop").toBeDefined();
    expect(rosterStatement as string).toMatch(/\bFROM\s+pg_tables\b/i);
    expect(rosterStatement as string).toMatch(/\btablename\s*=/i);
  });
});

// ---------------------------------------------------------------------------
// Assertion 2 — no policies, and specifically no USING (true)
// ---------------------------------------------------------------------------

describe("no policies — RLS with zero policies is the access decision", () => {
  it("creates no policy anywhere in up or down", () => {
    expect(findPolicyStatements(both)).toEqual([]);
  });

  it("contains no USING (true) in any spelling", () => {
    const sql = both.join(" ");
    expect(sql).not.toMatch(/\bUSING\s*\(\s*true\s*\)/i);
    expect(sql).not.toMatch(/USING\(true\)/i);
    expect(sql).not.toMatch(/\bWITH\s+CHECK\s*\(\s*true\s*\)/i);
  });

  it("never writes the word POLICY", () => {
    // Blunt and deliberate. There is no policy to add: nothing legitimately
    // reaches these tables through PostgREST, so a permissive policy could only
    // ever be there to turn the advisor green.
    expect(both.join(" ")).not.toMatch(/\bPOLICY\b/i);
  });
});

// ---------------------------------------------------------------------------
// Assertion 3 — FORCE ROW LEVEL SECURITY appears nowhere
// ---------------------------------------------------------------------------

describe("no FORCE — the owner bypass is what keeps the backend working", () => {
  it("never sets FORCE ROW LEVEL SECURITY", () => {
    // The backend connects as `postgres`, the owner of all thirty tables. Owners
    // bypass RLS unless FORCE is set. With FORCE and no policies, every backend
    // query would return zero rows — a silent, total outage. This assertion is
    // the guard against a future "hardening" pass adding it.
    expect(findForceRls(both)).toEqual([]);
  });

  it("never writes the token FORCE at all", () => {
    expect(both.join(" ")).not.toMatch(/\bFORCE\b/i);
  });

  it("enables RLS without NO FORCE either, leaving the default in place", () => {
    // `NO FORCE` is the default; stating it would imply FORCE was considered
    // per-table and invite someone to flip it.
    expect(both.join(" ")).not.toMatch(/\bNO\s+FORCE\b/i);
  });
});

// ---------------------------------------------------------------------------
// Assertion 4 — revoke coverage at all four levels, plus default privileges
// ---------------------------------------------------------------------------

describe("revokes — both client-API roles lose everything on public", () => {
  const REQUIRED: readonly RevokeLevel[] = [
    "schema",
    "tables",
    "sequences",
    "functions",
    "default_privileges",
  ];

  for (const role of LOCKED_OUT) {
    it(`revokes from ${role} at schema, table, sequence, function and default-privilege level`, () => {
      const facts = findRevokes(up);
      expect(
        missingRevokeLevels(facts, role, REQUIRED),
        `${role} should be revoked at every level`,
      ).toEqual([]);
    });
  }

  it("revokes USAGE on the schema itself, not just object privileges", () => {
    // The load-bearing line: without USAGE on `public`, no privilege on any
    // object inside it can be exercised. Everything else is defence in depth.
    for (const role of LOCKED_OUT) {
      expect(up.join(" ")).toMatch(
        new RegExp(`REVOKE\\s+USAGE\\s+ON\\s+SCHEMA\\s+public\\s+FROM\\s+${role}\\b`, "i"),
      );
    }
  });

  it("revokes default privileges so a later CREATE TABLE cannot re-open the hole", () => {
    for (const role of LOCKED_OUT) {
      for (const objectType of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
        expect(up.join(" ")).toMatch(
          new RegExp(
            `ALTER\\s+DEFAULT\\s+PRIVILEGES\\s+IN\\s+SCHEMA\\s+public\\s+REVOKE\\s+ALL\\s+ON\\s+${objectType}\\s+FROM\\s+${role}\\b`,
            "i",
          ),
        );
      }
    }
  });

  it("guards every role-dependent statement on pg_roles", () => {
    // `anon` and `authenticated` are Supabase-created. On plain Postgres an
    // unguarded REVOKE naming them aborts the migration, which would make this
    // unrunnable locally and in CI.
    expect(findUnguardedRoleStatements(both)).toEqual([]);
  });

  it("revokes ALL PRIVILEGES rather than enumerating verbs", () => {
    // So the migration does not depend on knowing which of SELECT/INSERT/…
    // the platform actually granted.
    expect(up.join(" ")).toMatch(/REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public/i);
  });
});

// ---------------------------------------------------------------------------
// Assertion 5 — service_role is left alone
// ---------------------------------------------------------------------------

describe("service_role — preserved, deliberately", () => {
  it("never revokes anything from service_role", () => {
    // It is BYPASSRLS and Supabase internals authenticate as it. Revoking would
    // break platform features while improving nothing, because a BYPASSRLS role
    // ignores RLS anyway. Its protection is operational: the key must never
    // reach a browser.
    expect(findServiceRoleRevokes(both)).toEqual([]);
  });

  it("does not disturb service_role's schema access", () => {
    expect(both.join(" ")).not.toMatch(/REVOKE[\s\S]*\bFROM\s+service_role\b/i);
  });
});

// ---------------------------------------------------------------------------
// Assertion 6 — schema public only
// ---------------------------------------------------------------------------

describe("scope — schema public and nothing else", () => {
  it("names no schema other than public", () => {
    expect(findSchemaReferences(both)).toEqual([PERMITTED_SCHEMA]);
  });

  for (const schema of FORBIDDEN_SCHEMAS) {
    it(`never mentions the ${schema} schema`, () => {
      expect(both.join(" ")).not.toMatch(new RegExp(`\\b${schema}\\b`, "i"));
    });
  }

  it("scopes both the roster guard and the sweep to schemaname = 'public'", () => {
    const catalogueStatements = both.filter((s) => /\bpg_tables\b/i.test(s));
    expect(catalogueStatements.length).toBeGreaterThan(0);
    for (const statement of catalogueStatements) {
      expect(statement, "every pg_tables read must be scoped to public").toMatch(
        /\bschemaname\s*=\s*'public'/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Assertion 7 — nothing is destroyed
// ---------------------------------------------------------------------------

describe("non-destructive — no data and no object is removed", () => {
  it("up destroys nothing", () => {
    expect(findDestructiveStatements(up)).toEqual([]);
  });

  it("down destroys nothing either", () => {
    // `down` is dangerous for a completely different reason — it re-exposes the
    // data — but it still drops nothing and deletes nothing.
    expect(findDestructiveStatements(down)).toEqual([]);
  });

  it("contains no DROP, DELETE, UPDATE or TRUNCATE in any form", () => {
    const sql = both.join(" ");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+[a-z_"]/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("creates no table, column or index", () => {
    // A security migration should change permissions and nothing else, so that
    // reviewing it is reviewing one thing.
    expect(both.join(" ")).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(both.join(" ")).not.toMatch(/\bCREATE\s+INDEX\b/i);
    expect(both.join(" ")).not.toMatch(/\bADD\s+COLUMN\b/i);
  });
});

// ---------------------------------------------------------------------------
// `down` reverses `up`, and is honest about what that means
// ---------------------------------------------------------------------------

describe("down — a true reverse, and a documented vulnerability", () => {
  it("re-grants at every level up revoked", () => {
    const sql = down.join(" ");
    for (const role of LOCKED_OUT) {
      expect(sql).toMatch(new RegExp(`GRANT\\s+USAGE\\s+ON\\s+SCHEMA\\s+public\\s+TO\\s+${role}\\b`, "i"));
      for (const objectType of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
        expect(sql).toMatch(
          new RegExp(`GRANT\\s+ALL\\s+ON\\s+ALL\\s+${objectType}\\s+IN\\s+SCHEMA\\s+public\\s+TO\\s+${role}\\b`, "i"),
        );
        expect(sql).toMatch(
          new RegExp(
            `ALTER\\s+DEFAULT\\s+PRIVILEGES\\s+IN\\s+SCHEMA\\s+public\\s+GRANT\\s+ALL\\s+ON\\s+${objectType}\\s+TO\\s+${role}\\b`,
            "i",
          ),
        );
      }
    }
  });

  it("disables RLS via the catalogue, so it releases whatever up enabled", () => {
    const sql = down.join(" ");
    expect(sql).toMatch(/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
    expect(sql).toMatch(/\bFROM\s+pg_tables\b/i);
    expect(sql).toMatch(/\browsecurity\b/i);
  });

  it("re-opens schema USAGE last, after the object privileges are back", () => {
    // Ordering matters even in a rollback nobody should run: the schema grant is
    // the statement that actually makes the data reachable again.
    const usageIndex = down.findIndex((s) => /GRANT\s+USAGE\s+ON\s+SCHEMA\s+public/i.test(s));
    const tablesIndex = down.findIndex((s) => /GRANT\s+ALL\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public/i.test(s));
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(tablesIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeGreaterThan(tablesIndex);
  });

  it("keeps its pg_roles guards, so down is as portable as up", () => {
    expect(findUnguardedRoleStatements(down)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity: there is real DDL under all of the above
// ---------------------------------------------------------------------------

describe("non-vacuity — the scanners are looking at substantial DDL", () => {
  it("captured every statement through pgm.sql and nothing through another builder member", () => {
    // Without this, a migration written with a typed helper would emit no SQL and
    // every "does not contain" assertion above would pass by finding nothing.
    expect(otherMembersUsed, "should use only pgm.sql, per design §14.6").toEqual([]);
    expect(upCalls.length, "up should emit SQL").toBeGreaterThan(0);
    expect(downCalls.length, "down should emit SQL").toBeGreaterThan(0);
  });

  it("emits at least the four documented layers in up and four reversals in down", () => {
    expect(up.length, "up should emit at least 5 statements").toBeGreaterThanOrEqual(5);
    expect(down.length, "down should emit at least 4 statements").toBeGreaterThanOrEqual(4);
  });

  it("performs at least fourteen distinct revokes", () => {
    // 2 schema + 6 object + 6 default-privilege, across two roles. A migration
    // that emitted one revoke would satisfy the per-level assertions above; this
    // pins the actual breadth.
    expect(findRevokes(up).length).toBeGreaterThanOrEqual(14);
  });

  it("puts at least twenty-five tables behind RLS", () => {
    expect(rosterTables(up).length).toBeGreaterThanOrEqual(25);
  });

  it("every statement is a DO block, so every one is role- or catalogue-guarded", () => {
    for (const statement of both) {
      expect(statement, "each emitted statement should be a guarded DO block").toMatch(/^DO\s+\$\$/i);
    }
  });

  it("exports the locked-out roles, and they are anon and authenticated", () => {
    expect([...(mod.LOCKED_OUT_ROLES ?? [])]).toEqual([...LOCKED_OUT]);
  });
});

// ---------------------------------------------------------------------------
// Negative controls — proof each scanner has teeth
// ---------------------------------------------------------------------------

/**
 * Synthetic DDL used ONLY to prove the scanners reject what they claim to.
 *
 * ALL SYNTHETIC. Every fixture is a deliberate violation naming either a real
 * table name in a fake statement or an invented object. None is ever applied to
 * anything, and there are no credentials, hosts, keys or connection strings in
 * any of them.
 */
const SYNTHETIC = {
  /** The control's control: shaped like the real migration, and clean. */
  clean: [
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE USAGE ON SCHEMA public FROM anon'; END IF; END $$`,
  ],
  /** The anti-pattern: a permissive policy that turns the advisor green and changes nothing. */
  permissivePolicy: [
    `DO $$ BEGIN EXECUTE 'CREATE POLICY anon_read ON public.customers FOR SELECT TO anon USING (true)'; END $$`,
  ],
  /** The whitespace-free spelling, which a naive regex would miss. */
  permissivePolicyTight: [`DO $$ BEGIN EXECUTE 'CREATE POLICY p ON public.customers USING(true)'; END $$`],
  /** The outage: FORCE applies RLS to the owner, which is how the backend connects. */
  forceRls: [
    `DO $$ BEGIN EXECUTE 'ALTER TABLE public.customers FORCE ROW LEVEL SECURITY'; END $$`,
  ],
  /** A roster that forgot `discount_codes` — the monetary exposure. */
  rosterMissingTable: [
    `DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['customers','ledger_entries'] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); END LOOP; END $$`,
  ],
  /** A roster naming something no migration creates. */
  rosterPhantomTable: [
    `DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['customers','synthetic_phantom_table'] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); END LOOP; END $$`,
  ],
  /** Revoking from the one role that must be preserved. */
  revokesServiceRole: [
    `DO $$ BEGIN EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM service_role'; END $$`,
  ],
  /** Reaching outside `public` into the job-queue schema. */
  touchesOtherSchema: [
    `DO $$ BEGIN EXECUTE 'REVOKE USAGE ON SCHEMA pgboss FROM anon'; END $$`,
  ],
  /** A sweep silently widened past `public`. */
  unscopedSweep: [
    `DO $$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); END LOOP; END $$`,
  ],
  /** Destruction dressed up as cleanup. */
  destructive: [`DO $$ BEGIN EXECUTE 'DROP TABLE IF EXISTS public.discount_codes'; END $$`],
  /** Data mutation. */
  mutating: [`DO $$ BEGIN EXECUTE 'DELETE FROM public.discount_codes WHERE status = ''active'''; END $$`],
  /** A revoke naming a Supabase role with no existence guard: aborts on plain Postgres. */
  unguardedRole: [`REVOKE USAGE ON SCHEMA public FROM anon`],
  /** Only revokes at table level, missing schema/sequence/function/default. */
  partialRevoke: [
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon'; END IF; END $$`,
  ],
} as const;

/** Runs synthetic payloads through the same builder and the same splitter. */
function runSynthetic(payloads: readonly string[]): string[] {
  const rec = makeRecordingBuilder();
  const pgm = rec.builder as { sql(s: string): void };
  for (const payload of payloads) pgm.sql(`${payload};`);
  return executableStatements(rec.calls);
}

describe("negative controls — every scanner rejects what it claims to reject", () => {
  it("accepts the clean synthetic (the control's control)", () => {
    const statements = runSynthetic(SYNTHETIC.clean);
    expect(findPolicyStatements(statements)).toEqual([]);
    expect(findForceRls(statements)).toEqual([]);
    expect(findServiceRoleRevokes(statements)).toEqual([]);
    expect(findDestructiveStatements(statements)).toEqual([]);
    expect(findUnguardedRoleStatements(statements)).toEqual([]);
    expect(findSchemaReferences(statements)).toEqual([PERMITTED_SCHEMA]);
    expect(findRevokes(statements)).toEqual([
      { level: "schema", role: "anon", isDefaultPrivileges: false },
    ]);
  });

  it("REJECTS a USING (true) policy", () => {
    const problems = findPolicyStatements(runSynthetic(SYNTHETIC.permissivePolicy));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.map((p) => p.reason)).toContain("contains USING (true)");
    expect(problems.map((p) => p.reason)).toContain("contains CREATE POLICY");
  });

  it("REJECTS USING(true) written without a space", () => {
    const problems = findPolicyStatements(runSynthetic(SYNTHETIC.permissivePolicyTight));
    expect(problems.map((p) => p.reason)).toContain("contains USING (true)");
  });

  it("REJECTS FORCE ROW LEVEL SECURITY", () => {
    const problems = findForceRls(runSynthetic(SYNTHETIC.forceRls));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.reason).toMatch(/applies RLS to the table owner/);
  });

  it("REJECTS a roster that omits a discovered table", () => {
    const covered = rosterTables(runSynthetic(SYNTHETIC.rosterMissingTable));
    expect(covered).toEqual(["customers", "ledger_entries"]);
    // The gate, run against the same discovered universe the real assertion uses.
    const missing = uncoveredTables(discoveredTables, covered);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain("discount_codes");
  });

  it("REJECTS a roster naming a table no migration creates", () => {
    const covered = rosterTables(runSynthetic(SYNTHETIC.rosterPhantomTable));
    expect(
      unexplainedRosterEntries(covered, discoveredTables, KNOWN_FORWARD_TABLES),
    ).toEqual(["synthetic_phantom_table"]);
  });

  it("REJECTS a revoke naming service_role", () => {
    const problems = findServiceRoleRevokes(runSynthetic(SYNTHETIC.revokesServiceRole));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.reason).toMatch(/BYPASSRLS/);
  });

  it("REJECTS a statement naming a schema other than public", () => {
    const schemas = findSchemaReferences(runSynthetic(SYNTHETIC.touchesOtherSchema));
    expect(schemas).toContain("pgboss");
    expect(schemas).not.toEqual([PERMITTED_SCHEMA]);
  });

  it("REJECTS a catalogue sweep not scoped to public", () => {
    const statements = runSynthetic(SYNTHETIC.unscopedSweep);
    const catalogueStatements = statements.filter((s) => /\bpg_tables\b/i.test(s));
    expect(catalogueStatements.length).toBeGreaterThan(0);
    expect(catalogueStatements.every((s) => /\bschemaname\s*=\s*'public'/i.test(s))).toBe(false);
  });

  it("REJECTS a DROP", () => {
    const problems = findDestructiveStatements(runSynthetic(SYNTHETIC.destructive));
    expect(problems.map((p) => p.reason)).toContain("contains DROP");
  });

  it("REJECTS a DELETE", () => {
    const problems = findDestructiveStatements(runSynthetic(SYNTHETIC.mutating));
    expect(problems.map((p) => p.reason)).toContain("contains DELETE FROM");
  });

  it("REJECTS an unguarded reference to a Supabase-only role", () => {
    const problems = findUnguardedRoleStatements(runSynthetic(SYNTHETIC.unguardedRole));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.reason).toMatch(/without a pg_roles existence guard/);
  });

  it("REJECTS a revoke that covers only the table level", () => {
    const facts = findRevokes(runSynthetic(SYNTHETIC.partialRevoke));
    const missing = missingRevokeLevels(facts, "anon", [
      "schema",
      "tables",
      "sequences",
      "functions",
      "default_privileges",
    ]);
    expect(missing).toEqual(["schema", "sequences", "functions", "default_privileges"]);
  });

  it("NOTICES a migration that bypasses pgm.sql for another builder member", () => {
    const rec = makeRecordingBuilder();
    const pgm = rec.builder as unknown as { createTable(t: string): void };
    pgm.createTable("synthetic_widget");
    expect(rec.calls).toEqual([]);
    expect(rec.otherMembersUsed).toContain("createTable");
  });
});

// ---------------------------------------------------------------------------
// The SQL utilities themselves, since every assertion above rests on them
// ---------------------------------------------------------------------------

describe("SQL utilities", () => {
  it("splitterHandlesDollarQuoting: a DO block stays one statement", () => {
    // The whole test file depends on this. Without dollar-quote awareness the
    // block below splits into four fragments and every statement-level
    // assertion measures nonsense.
    const sql = `DO $$ BEGIN EXECUTE 'a'; EXECUTE 'b'; END $$;`;
    expect(splitStatements(sql)).toEqual([`DO $$ BEGIN EXECUTE 'a'; EXECUTE 'b'; END $$`]);
  });

  it("handles a tagged dollar quote too", () => {
    const sql = `DO $body$ BEGIN EXECUTE 'a'; END $body$;`;
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it("still splits genuinely separate statements", () => {
    expect(splitStatements("DO $$ BEGIN END $$; DO $$ BEGIN END $$;")).toHaveLength(2);
  });

  it("does not split on a semicolon inside a string literal", () => {
    expect(splitStatements(`SELECT 'a;b';`)).toEqual([`SELECT 'a;b'`]);
  });

  it("strips line comments but keeps executable text", () => {
    expect(normalize(stripSqlComments("REVOKE USAGE ON SCHEMA public FROM anon; -- a note"))).toBe(
      "REVOKE USAGE ON SCHEMA public FROM anon;",
    );
  });

  it("does not treat a comment marker inside a string literal as a comment", () => {
    expect(stripSqlComments(`RAISE NOTICE 'x--y';`)).toContain("'x--y'");
  });

  it("finds the schema in every position shape the migration uses", () => {
    expect(
      findSchemaReferences([
        "REVOKE USAGE ON SCHEMA public FROM anon",
        "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon",
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
        "format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t)",
      ]),
    ).toEqual(["public"]);
  });

  it("does not mistake updated_at for an UPDATE", () => {
    expect(findDestructiveStatements(["DO $$ BEGIN RAISE NOTICE 'updated_at'; END $$"])).toEqual([]);
  });

  it("does not mistake service_role_audit for service_role", () => {
    expect(
      findServiceRoleRevokes(["REVOKE ALL ON ALL TABLES IN SCHEMA public FROM service_role_audit"]),
    ).toEqual([]);
  });

  it("extracts revoke facts with the role, not the schema", () => {
    expect(
      findRevokes(["REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated"]),
    ).toEqual([{ level: "sequences", role: "authenticated", isDefaultPrivileges: false }]);
  });
});
