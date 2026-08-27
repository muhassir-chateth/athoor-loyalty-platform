/**
 * Migration tests for the four additive portal migrations (task 6.6) —
 * Requirements 3.3, 23.6, 22.11.
 *
 * WHAT THIS VERIFIES, AND WHAT IT HONESTLY CANNOT
 * ===============================================
 * NO DATABASE IS TOUCHED AND NONE IS AVAILABLE. There is no Postgres in CI and
 * this test deliberately introduces no dependency on one, matching the shipped
 * approach in `migrations.test.ts`, `migrations.profile.test.ts` and their
 * siblings: each migration's `up`/`down` is executed against a capturing
 * `MigrationBuilder` stub and the assertions are made against the emitted DDL.
 * Applying the migrations for real is a deploy-time action (`npm run migrate:up`).
 *
 * The task asks for proof that "`up` then `down` is clean on an empty database".
 * THAT PROPERTY IS NOT EXERCISED HERE, because exercising it requires a live
 * database. It is asserted STRUCTURALLY instead, and the structural form is
 * stated plainly so nobody later mistakes it for the real thing:
 *
 *   - every table created by `up` is dropped by `down`;
 *   - the drops are in reverse creation order;
 *   - every drop is `IF EXISTS`;
 *   - no statement in `down` touches anything `up` did not create;
 *   - the created set and the dropped set are EQUAL, so `up` followed by `down`
 *     leaves no created object unaccounted for.
 *
 * Those five together are what "clean teardown" MEANS for migrations of this
 * shape (`CREATE TABLE` only, no shared objects, indexes and constraints owned by
 * the tables that carry them). They are not a substitute for having run it. What
 * they cannot catch is a genuinely database-level failure — a dependency Postgres
 * knows about and this test does not, or a `DROP` that a real catalogue would
 * refuse. Nothing below should be read as evidence that a live `up`/`down` cycle
 * was performed, because it was not.
 *
 * WHY THE SURFACE IS DISCOVERED RATHER THAN ENUMERATED
 * ===================================================
 * Four hardcoded imports would silently stop covering the feature the moment a
 * fifth portal migration landed, which is the failure mode the 5.3 route census
 * and the 5.4 ownership gate exist to avoid. So the subject under test is
 * discovered twice and the two are cross-checked:
 *
 *   1. FROM DISK — every file in `migrations/` whose timestamp prefix is at or
 *      above {@link PORTAL_ERA_FLOOR}. A fifth portal migration is picked up with
 *      no edit here and is held to every assertion automatically.
 *   2. FROM THE GUARD — `PORTAL_MIGRATIONS`, the frozen literal that scopes the
 *      task-6.5 `migrate:down` precondition.
 *
 * The two must agree, on filenames AND on the tables each migration creates
 * (the latter parsed from the DDL actually emitted, not taken on trust). That
 * makes the guard's frozen list unable to drift from reality in either
 * direction: a fifth migration on disk that nobody added to `PORTAL_MIGRATIONS`
 * fails here, because a guard whose scope silently narrows is worse than none.
 *
 * THE ONE PERMITTED REFERENCE TO EXISTING SCHEMA
 * ==============================================
 * The task says "or any existing table", and all four migrations legitimately
 * carry a `customers(id)` foreign key — the design's intent, and the reason
 * §14.3 refuses to put any portal column ON `customers`. So the rule asserted is
 * the precise one: the ONLY pre-existing table any portal statement may name is
 * `customers`, and it may appear ONLY as a foreign-key target — never created,
 * altered, dropped, inserted into, updated, deleted from or truncated. See
 * {@link findForeignTableRefs}: it works by subtracting the tables the portal
 * migrations create from every table-position identifier found, so a future
 * migration reaching for a DIFFERENT existing table has nothing to subtract and
 * fails by name.
 *
 * SQL COMMENTS ARE STRIPPED BEFORE ANALYSIS
 * =========================================
 * The migrations carry explanatory `--` comments inside their DDL, so every scan
 * runs on comment-stripped, executable text. A comment references nothing and can
 * affect no balance; scanning it would only produce false failures on a migration
 * whose comment says "does not touch `ledger_entries`". The trade is recorded
 * here because it is the one place these assertions look at less than the raw
 * source.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { PORTAL_MIGRATIONS } from "./migration/migrateDownGuard.js";
import { AUDIT_OPERATION_TYPES } from "./admin/auditTrail.js";

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------

/**
 * The timestamp at which the portal migration series begins (task 6.1).
 *
 * Every migration at or above this prefix is a portal migration and is held to
 * the assertions below. Anything earlier is pre-existing schema, and is used
 * only to build the universe of table names the portal must not touch.
 */
const PORTAL_ERA_FLOOR = 1786000000000;

/**
 * The five tables Requirement 23.6 puts out of reach: nothing in the portal's
 * data layer may affect a balance.
 *
 * These names are cross-checked against the pre-existing migrations below, so a
 * typo here cannot silently turn an assertion into a no-op.
 */
const LEDGER_TABLES = [
  "ledger_entries",
  "point_lots",
  "redemptions",
  "discount_codes",
  "referrals",
] as const;

/** The one pre-existing table a portal migration may name, and only as an FK target. */
const PERMITTED_EXISTING_TABLE = "customers";

// ---------------------------------------------------------------------------
// A capturing MigrationBuilder that also notices what it was NOT asked to do
// ---------------------------------------------------------------------------

interface RecordingBuilder {
  /** Every string passed to `pgm.sql()`, in call order. */
  readonly calls: string[];
  /** Any builder member other than `sql` that the migration reached for. */
  readonly otherMembersUsed: string[];
  /** The stub to hand to `up`/`down`. */
  readonly builder: unknown;
}

/**
 * Records `pgm.sql()` calls AND every other builder member touched.
 *
 * The second half matters more than it looks. A DDL-scanning test that only
 * implements `sql` would give a clean bill of health to a migration written with
 * `pgm.dropTable()` or `pgm.addColumn()` — the scanner would find no statements
 * and every "contains no ALTER" assertion would pass vacuously. Recording the
 * miss, and asserting there were none, is what closes that hole. Design §14.6
 * fixes the convention as plain `pgm.sql`, so this also enforces it.
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
      // Vitest/Node may probe for these while inspecting the object; they are
      // not migration API surface, so they are not recorded as misuse.
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
 * Single-quoted literals are respected so a comment marker inside a string
 * value (`DEFAULT 'a--b'`) is not mistaken for a comment.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        // Doubled '' is an escaped quote and does not close the literal.
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
      // Skip to end of line, keeping the newline as whitespace.
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
 * Splits a `pgm.sql()` payload into individual statements on top-level `;`.
 *
 * Semicolons inside single-quoted literals do not split. Dollar-quoting is not
 * handled because none of these migrations uses it; a migration that introduced
 * a `$$ … $$` body would not be additive `CREATE TABLE` anyway and would be
 * caught by {@link classifyStatement}.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
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
// Scanner 1 — additive only
// ---------------------------------------------------------------------------

/** The only two statement shapes an additive `up` may contain. */
const ADDITIVE_STATEMENT = /^CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\b/i;

/**
 * Verb forms that are unambiguously non-additive.
 *
 * Each is a multi-token or delimiter-anchored form on purpose, so a column name
 * cannot trip it: `updated_at` must not read as `UPDATE`, and `birthday_grants`,
 * `grant_year` and `granted_at` must not read as `GRANT`.
 */
const NON_ADDITIVE_FORMS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "ALTER TABLE", pattern: /\bALTER\s+TABLE\b/i },
  { label: "ALTER (any object)", pattern: /\bALTER\s+(?:INDEX|SEQUENCE|TYPE|SCHEMA|VIEW)\b/i },
  { label: "DROP", pattern: /\bDROP\s+(?:TABLE|INDEX|COLUMN|CONSTRAINT|SCHEMA|TYPE|VIEW|SEQUENCE)\b/i },
  { label: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { label: "UPDATE", pattern: /\bUPDATE\s+[a-z_"]/i },
  { label: "DELETE FROM", pattern: /\bDELETE\s+FROM\b/i },
  { label: "INSERT INTO", pattern: /\bINSERT\s+INTO\b/i },
  { label: "GRANT", pattern: /\bGRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|USAGE|REFERENCES)\b/i },
  { label: "REVOKE", pattern: /\bREVOKE\b/i },
  { label: "CREATE EXTENSION", pattern: /\bCREATE\s+EXTENSION\b/i },
];

export interface StatementProblem {
  readonly statement: string;
  readonly reason: string;
}

/**
 * Returns every statement that is not purely additive.
 *
 * Two independent checks, because either alone has a gap: the leading-verb
 * classification would accept a `CREATE TABLE` with something appended, and the
 * forbidden-form scan alone would accept a verb nobody thought to list.
 */
export function findNonAdditiveStatements(
  statements: readonly string[],
): StatementProblem[] {
  const problems: StatementProblem[] = [];
  for (const statement of statements) {
    if (!ADDITIVE_STATEMENT.test(statement)) {
      problems.push({
        statement,
        reason: "does not begin with CREATE TABLE or CREATE [UNIQUE] INDEX",
      });
      continue;
    }
    for (const { label, pattern } of NON_ADDITIVE_FORMS) {
      if (pattern.test(statement)) {
        problems.push({ statement, reason: `contains a non-additive ${label}` });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scanner 2 — no ledger contact (Requirement 23.6)
// ---------------------------------------------------------------------------

/**
 * Returns every (statement, ledger table) pair where a forbidden table is named.
 *
 * Word-boundary matched, so this is precise in both directions: it will not let
 * `ledger_entries_archive` through, and it will not false-match `referral_code`
 * or a hypothetical `customer_referrals`, which are different objects.
 */
export function findLedgerReferences(
  statements: readonly string[],
): StatementProblem[] {
  const problems: StatementProblem[] = [];
  for (const statement of statements) {
    for (const table of LEDGER_TABLES) {
      if (new RegExp(`\\b${table}\\b`, "i").test(statement)) {
        problems.push({
          statement,
          reason: `references the ledger table ${table} (Requirement 23.6)`,
        });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scanner 3 — table positions, and the customers(id)-only rule
// ---------------------------------------------------------------------------

/** How a table identifier was used. */
export type TableRole =
  | "create_table"
  | "index_on"
  | "fk_target"
  | "drop_table"
  | "alter_table"
  | "insert_into"
  | "update"
  | "delete_from"
  | "truncate"
  | "select_from"
  | "join"
  | "trigger_on";

export interface TableRef {
  readonly table: string;
  readonly role: TableRole;
  readonly statement: string;
}

const IDENT = "([a-z_][a-z0-9_]*)";

/**
 * Every way a statement can name a table, with the role it names it in.
 *
 * Deliberately broader than what these four migrations use. `select_from`,
 * `join`, `insert_into`, `update`, `delete_from` and `trigger_on` match nothing
 * today; they are here so that a future migration doing
 * `INSERT INTO … SELECT FROM ledger_entries` is caught by the role rules below
 * rather than sliding past a scanner that only knew about `REFERENCES`.
 */
const TABLE_POSITION_PATTERNS: readonly { readonly role: TableRole; readonly pattern: RegExp }[] = [
  { role: "create_table", pattern: new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, "gi") },
  { role: "index_on", pattern: new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[a-z_][a-z0-9_]*\\s+ON\\s+${IDENT}`, "gi") },
  { role: "fk_target", pattern: new RegExp(`\\bREFERENCES\\s+${IDENT}`, "gi") },
  { role: "drop_table", pattern: new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, "gi") },
  { role: "alter_table", pattern: new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, "gi") },
  { role: "insert_into", pattern: new RegExp(`\\bINSERT\\s+INTO\\s+${IDENT}`, "gi") },
  { role: "update", pattern: new RegExp(`\\bUPDATE\\s+${IDENT}\\s+SET\\b`, "gi") },
  { role: "delete_from", pattern: new RegExp(`\\bDELETE\\s+FROM\\s+${IDENT}`, "gi") },
  { role: "truncate", pattern: new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?${IDENT}`, "gi") },
  { role: "select_from", pattern: new RegExp(`\\bFROM\\s+${IDENT}`, "gi") },
  { role: "join", pattern: new RegExp(`\\bJOIN\\s+${IDENT}`, "gi") },
  { role: "trigger_on", pattern: new RegExp(`\\bCREATE\\s+TRIGGER\\b[\\s\\S]*?\\bON\\s+${IDENT}`, "gi") },
];

/** Extracts every table identifier in a table position, with its role. */
export function findTableRefs(statements: readonly string[]): TableRef[] {
  const refs: TableRef[] = [];
  for (const statement of statements) {
    for (const { role, pattern } of TABLE_POSITION_PATTERNS) {
      // Fresh regex per statement: shared /g lastIndex would skip matches.
      const scanner = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = scanner.exec(statement)) !== null) {
        const captured = match[1];
        if (captured !== undefined) {
          refs.push({ table: captured.toLowerCase(), role, statement });
        }
      }
    }
  }
  return refs;
}

/** The tables a set of statements creates, in creation order, de-duplicated. */
export function tablesCreated(statements: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const ref of findTableRefs(statements)) {
    if (ref.role === "create_table" && !seen.has(ref.table)) {
      seen.add(ref.table);
      ordered.push(ref.table);
    }
  }
  return ordered;
}

/** The tables a set of statements drops, in drop order, de-duplicated. */
export function tablesDropped(statements: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const ref of findTableRefs(statements)) {
    if (ref.role === "drop_table" && !seen.has(ref.table)) {
      seen.add(ref.table);
      ordered.push(ref.table);
    }
  }
  return ordered;
}

/**
 * Every reference to a table the portal migrations do not themselves create.
 *
 * This is the whole expression of the "one permitted reference" rule. Subtracting
 * the portal's own tables leaves exactly the pre-existing schema it touches, so
 * the assertion is `every foreign ref is customers, as an fk_target` — and a
 * migration that reached for `orders` or `ledger_entries`, in ANY role, appears
 * here by name with no special case required.
 */
export function findForeignTableRefs(
  statements: readonly string[],
  createdByPortal: readonly string[],
): TableRef[] {
  const own = new Set(createdByPortal);
  return findTableRefs(statements).filter((ref) => !own.has(ref.table));
}

// ---------------------------------------------------------------------------
// Scanner 4 — teardown coherence (the structural stand-in, see the header)
// ---------------------------------------------------------------------------

/**
 * Checks that `down` exactly undoes `up`, structurally.
 *
 * This is the property the task calls "`up` then `down` is clean on an empty
 * database", asserted without a database. See the file header for what that does
 * and does not establish.
 */
export function checkTeardown(
  upStatements: readonly string[],
  downStatements: readonly string[],
): string[] {
  const problems: string[] = [];
  const created = tablesCreated(upStatements);
  const dropped = tablesDropped(downStatements);

  for (const table of created) {
    if (!dropped.includes(table)) {
      problems.push(`up creates ${table} but down never drops it`);
    }
  }

  for (const table of dropped) {
    if (!created.includes(table)) {
      problems.push(`down drops ${table}, which up did not create`);
    }
  }

  const expectedOrder = [...created].reverse();
  if (dropped.length === expectedOrder.length && !dropped.every((t, i) => t === expectedOrder[i])) {
    problems.push(
      `down drops in order [${dropped.join(", ")}] but reverse creation order is [${expectedOrder.join(", ")}]`,
    );
  }

  for (const statement of downStatements) {
    if (!/^DROP\s+TABLE\s+IF\s+EXISTS\b/i.test(statement)) {
      problems.push(`down statement is not a DROP TABLE IF EXISTS: ${statement}`);
    }
  }

  // Nothing in `down` may name an object `up` did not create.
  for (const ref of findTableRefs(downStatements)) {
    if (!created.includes(ref.table)) {
      problems.push(`down names ${ref.table} (${ref.role}), which up did not create`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Discovery: the migrations on disk, and the pre-existing table universe
// ---------------------------------------------------------------------------

interface LoadedMigration {
  readonly filename: string;
  readonly version: string;
  readonly upCalls: readonly string[];
  readonly downCalls: readonly string[];
  readonly up: readonly string[];
  readonly down: readonly string[];
  readonly otherMembersUsed: readonly string[];
  readonly hasShorthands: boolean;
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

/**
 * TWO CLASSES OF PORTAL-ERA MIGRATION, DECLARED BY FILENAME.
 *
 * Every portal migration up to task 14 CREATES A TABLE, and the assertions below
 * are built around that: additive means `CREATE TABLE`/`CREATE INDEX`, teardown
 * means `DROP TABLE IF EXISTS`, and `PORTAL_MIGRATIONS` names the tables so the
 * task-6.5 row-count guard can refuse a destructive `down`.
 *
 * Task 15.3 needs something structurally different: `admin_audit_log`'s
 * `operation_type` CHECK must accept `customer_redaction`, or the redaction
 * procedure cannot record an honest audit entry (recording one as `reconciliation`
 * would put a false statement in the audit trail). That migration creates no table
 * and its statements are `ALTER TABLE ... DROP/ADD CONSTRAINT`.
 *
 * THE FIX IS A SECOND CLASS, NOT LOOSER RULES FOR THE FIRST. Relaxing "every up
 * statement is CREATE TABLE or CREATE INDEX" so an ALTER slips through would
 * weaken the check that protects five real tables, to accommodate one migration
 * that does not touch them. Instead the widening migration is declared here by
 * name and carries its OWN, narrower assertions further down: it may only widen a
 * CHECK, must name no ledger-protected table, and its `down` must REFUSE rather
 * than delete audit history.
 *
 * MEMBERSHIP IS BY FILENAME, NEVER BY CONTENT — the same principle
 * `ownership.gate.test.ts` uses for its three GraphQL classes. If the class were
 * inferred from what a file contains, adding a `CREATE TABLE` to a widening
 * migration would silently move it into the weaker set of rules.
 */
const CONSTRAINT_WIDENING_MIGRATIONS: readonly string[] = [
  "1786600000000_extend-audit-for-redaction.ts",
];

let portalFilenames: string[];
/** The table-creating family — every portal migration except the widening class. */
let tableFamilyFilenames: string[];
let preExistingTables: Set<string>;
let loaded: LoadedMigration[];
/** The widening class, loaded the same way for its own assertions. */
let widening: LoadedMigration[];

/** Every statement from every portal `up`, across the family. */
let familyUp: string[];
/** Every statement from every portal `down`, across the family. */
let familyDown: string[];

beforeAll(async () => {
  const all = allMigrationFilenames();
  expect(all.length, "migrations directory should not be empty").toBeGreaterThan(0);

  portalFilenames = all.filter((f) => (versionOf(f) as number) >= PORTAL_ERA_FLOOR);
  // The table-creating family is every portal migration EXCEPT the declared
  // constraint-widening ones. Filtering here rather than inside each assertion
  // means a new widening migration is excluded once, by name, in one place.
  tableFamilyFilenames = portalFilenames.filter(
    (f) => !CONSTRAINT_WIDENING_MIGRATIONS.includes(f),
  );

  // The universe of table names that existed before the portal series. Read as
  // TEXT rather than executed: this only needs the names, and executing 15
  // unrelated migrations to learn them would be a far larger surface.
  preExistingTables = new Set<string>();
  for (const filename of all.filter((f) => (versionOf(f) as number) < PORTAL_ERA_FLOOR)) {
    const source = readFileSync(join(migrationsDir, filename), "utf8");
    const scanner = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(source)) !== null) {
      if (match[1] !== undefined) preExistingTables.add(match[1].toLowerCase());
    }
  }

  loaded = [];
  for (const filename of tableFamilyFilenames) {
    const url = pathToFileURL(join(migrationsDir, filename)).href;
    const mod = (await import(/* @vite-ignore */ url)) as {
      up: (pgm: unknown) => Promise<void>;
      down: (pgm: unknown) => Promise<void>;
      shorthands?: unknown;
    };

    const upRec = makeRecordingBuilder();
    await mod.up(upRec.builder);

    const downRec = makeRecordingBuilder();
    await mod.down(downRec.builder);

    loaded.push({
      filename,
      version: String(versionOf(filename)),
      upCalls: upRec.calls,
      downCalls: downRec.calls,
      up: executableStatements(upRec.calls),
      down: executableStatements(downRec.calls),
      otherMembersUsed: [...upRec.otherMembersUsed, ...downRec.otherMembersUsed],
      hasShorthands: "shorthands" in mod,
    });
  }

  familyUp = loaded.flatMap((m) => m.up);
  familyDown = loaded.flatMap((m) => m.down);

  // The widening class, loaded identically so its own assertions can run over
  // real recorded statements rather than over the file as text.
  widening = [];
  for (const filename of portalFilenames.filter((f) =>
    CONSTRAINT_WIDENING_MIGRATIONS.includes(f),
  )) {
    const url = pathToFileURL(join(migrationsDir, filename)).href;
    const mod = (await import(/* @vite-ignore */ url)) as {
      up: (pgm: unknown) => Promise<void>;
      down: (pgm: unknown) => Promise<void>;
      shorthands?: unknown;
    };
    const upRec = makeRecordingBuilder();
    await mod.up(upRec.builder);
    const downRec = makeRecordingBuilder();
    await mod.down(downRec.builder);
    widening.push({
      filename,
      version: String(versionOf(filename)),
      upCalls: upRec.calls,
      downCalls: downRec.calls,
      up: executableStatements(upRec.calls),
      down: executableStatements(downRec.calls),
      otherMembersUsed: [...upRec.otherMembersUsed, ...downRec.otherMembersUsed],
      hasShorthands: "shorthands" in mod,
    });
  }
});

// ---------------------------------------------------------------------------
// Discovery is sound and the guard's frozen list matches reality
// ---------------------------------------------------------------------------

describe("discovery — the portal migration surface, found rather than assumed", () => {
  it("finds at least the four migrations of tasks 6.1–6.4 on disk", () => {
    expect(portalFilenames).toEqual(
      expect.arrayContaining([
        "1786000000000_create-customer-birthdays.ts",
        "1786100000000_create-fragrance-preferences.ts",
        "1786200000000_create-communication-preferences.ts",
        "1786300000000_create-erasure-requests.ts",
        // Task 9.1's explicit-removal tombstone (§8.4 rule 3). Additive, on the
        // same convention, and in the portal era — so this suite governs it too.
        "1786500000000_create-wishlist-removals.ts",
      ]),
    );
    expect(portalFilenames.length).toBeGreaterThanOrEqual(4);
  });

  it("loaded every discovered migration and each exports up, down and shorthands", () => {
    // BOTH classes together must account for every portal-era file on disk. That is
    // what stops a migration being excluded from the table family and then never
    // asserted by anything — the failure mode a per-assertion filter would have
    // allowed.
    expect(loaded.length + widening.length).toBe(portalFilenames.length);
    for (const migration of [...loaded, ...widening]) {
      expect(migration.hasShorthands, `${migration.filename} should export shorthands`).toBe(true);
    }
  });

  it("assigns every portal-era migration to exactly ONE class", () => {
    const inFamily = new Set(tableFamilyFilenames);
    const inWidening = new Set(CONSTRAINT_WIDENING_MIGRATIONS);
    for (const filename of portalFilenames) {
      const memberships = [inFamily.has(filename), inWidening.has(filename)].filter(Boolean).length;
      expect(memberships, `${filename} belongs to ${memberships} classes, expected exactly 1`).toBe(1);
    }
    // And no declared widening migration is absent from disk — a stale name here
    // would silently shrink the table family's coverage.
    for (const declared of CONSTRAINT_WIDENING_MIGRATIONS) {
      expect(portalFilenames, `${declared} is declared but not on disk`).toContain(declared);
    }
  });

  it("PORTAL_MIGRATIONS names exactly the migrations on disk, in order (no drift)", () => {
    // If this fails after a fifth portal migration is added, the fix is to add it
    // to PORTAL_MIGRATIONS — not to loosen this. The task-6.5 guard refuses
    // migrate:down based on that list, so a list narrower than reality means a
    // table whose row count is never checked before it is dropped.
    expect(PORTAL_MIGRATIONS.map((m) => m.filename)).toEqual(tableFamilyFilenames);
  });

  it("PORTAL_MIGRATIONS versions match the filename timestamps", () => {
    for (const migration of PORTAL_MIGRATIONS) {
      expect(migration.filename.startsWith(`${migration.version}_`)).toBe(true);
    }
  });

  it("PORTAL_MIGRATIONS lists exactly the tables each up actually creates", () => {
    // Parsed from emitted DDL, not taken on trust: this is what stops the guard's
    // table list from claiming a table that is not created, or missing one that is.
    for (const migration of loaded) {
      const declared = PORTAL_MIGRATIONS.find((m) => m.filename === migration.filename);
      expect(declared, `PORTAL_MIGRATIONS should cover ${migration.filename}`).toBeDefined();
      expect(
        tablesCreated(migration.up),
        `${migration.filename}: declared tables should match the DDL`,
      ).toEqual([...(declared as { tables: readonly string[] }).tables]);
    }
  });

  it("discovered the pre-existing schema, including every table it must not touch", () => {
    // Non-vacuity for the ledger scan: if a name in LEDGER_TABLES were misspelled,
    // findLedgerReferences would be searching for something that does not exist
    // and would pass on anything. These assertions make that impossible.
    expect(preExistingTables.size).toBeGreaterThan(5);
    for (const table of LEDGER_TABLES) {
      expect(preExistingTables, `${table} should be a real pre-existing table`).toContain(table);
    }
    expect(preExistingTables).toContain(PERMITTED_EXISTING_TABLE);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity: the scanners are looking at real, substantial DDL
// ---------------------------------------------------------------------------

describe("non-vacuity — there is real DDL under these assertions", () => {
  it("captured every statement through pgm.sql and nothing through another builder member", () => {
    // Without this, a migration written with pgm.createTable() would emit no
    // statements and every scan below would pass by finding nothing.
    for (const migration of loaded) {
      expect(
        migration.otherMembersUsed,
        `${migration.filename} should use only pgm.sql (design §14.6)`,
      ).toEqual([]);
      expect(migration.upCalls.length, `${migration.filename} up should emit SQL`).toBeGreaterThan(0);
      expect(migration.downCalls.length, `${migration.filename} down should emit SQL`).toBeGreaterThan(0);
    }
  });

  it("the family emits at least 7 up and 5 down statements", () => {
    // 5 CREATE TABLE + 2 CREATE INDEX up; 5 DROP TABLE down.
    expect(familyUp.length).toBeGreaterThanOrEqual(7);
    expect(familyDown.length).toBeGreaterThanOrEqual(5);
  });

  it("creates exactly the six portal tables, once each", () => {
    expect(tablesCreated(familyUp)).toEqual([
      "customer_birthdays",
      "birthday_grants",
      "customer_fragrance_preferences",
      "customer_communication_preferences",
      "customer_erasure_requests",
      "customer_wishlist_removals",
    ]);
  });

  it("finds the named objects the design requires", () => {
    const sql = familyUp.join(" ");
    expect(sql).toContain("idx_fragrance_pref_single_intensity");
    expect(sql).toContain("idx_erasure_queue");
    expect(sql).toContain("customer_birthdays_valid_day_for_month");
  });

  it("every portal table carries the customers(id) foreign key of §14.3", () => {
    for (const migration of loaded) {
      for (const table of tablesCreated(migration.up)) {
        const statement = migration.up.find((s) =>
          new RegExp(`\\bCREATE\\s+TABLE\\s+${table}\\b`, "i").test(s),
        );
        expect(statement, `should find the CREATE TABLE for ${table}`).toBeDefined();
        expect(statement as string, `${table} should reference customers(id)`).toMatch(
          /\bREFERENCES\s+customers\s*\(\s*id\s*\)/i,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Assertion 1 — additive CREATE TABLE only
// ---------------------------------------------------------------------------

describe("additive only — every up statement creates, nothing else", () => {
  it("the family contains no non-additive statement", () => {
    expect(findNonAdditiveStatements(familyUp)).toEqual([]);
  });

  for (const expected of [
    "1786000000000_create-customer-birthdays.ts",
    "1786100000000_create-fragrance-preferences.ts",
    "1786200000000_create-communication-preferences.ts",
    "1786300000000_create-erasure-requests.ts",
    "1786500000000_create-wishlist-removals.ts",
  ]) {
    it(`${expected}: up is additive`, () => {
      const migration = loaded.find((m) => m.filename === expected);
      expect(migration, `${expected} should have been discovered`).toBeDefined();
      expect(findNonAdditiveStatements((migration as LoadedMigration).up)).toEqual([]);
    });
  }

  it("every up statement is CREATE TABLE or CREATE [UNIQUE] INDEX", () => {
    for (const statement of familyUp) {
      expect(statement, "statement should be additive DDL").toMatch(
        /^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)\b/i,
      );
    }
  });

  it("adds no extension (gen_random_uuid and citext already exist)", () => {
    expect(familyUp.join(" ")).not.toMatch(/\bCREATE\s+EXTENSION\b/i);
  });
});

// ---------------------------------------------------------------------------
// Assertion 2 — no ledger contact (Requirement 23.6)
// ---------------------------------------------------------------------------

describe("no ledger contact — nothing here can affect a balance (Req 23.6)", () => {
  it("no up statement references a ledger table", () => {
    expect(findLedgerReferences(familyUp)).toEqual([]);
  });

  it("no down statement references a ledger table", () => {
    expect(findLedgerReferences(familyDown)).toEqual([]);
  });

  for (const table of LEDGER_TABLES) {
    it(`never names ${table}`, () => {
      const sql = [...familyUp, ...familyDown].join(" ");
      expect(sql).not.toMatch(new RegExp(`\\b${table}\\b`, "i"));
    });
  }
});

// ---------------------------------------------------------------------------
// Assertion 3 — customers(id) is the only permitted existing-table reference
// ---------------------------------------------------------------------------

describe("existing schema — customers(id) as an FK target, and nothing else", () => {
  it("the only pre-existing table referenced is customers", () => {
    const portalTables = tablesCreated(familyUp);
    const foreign = findForeignTableRefs([...familyUp, ...familyDown], portalTables);
    const names = [...new Set(foreign.map((r) => r.table))].sort();
    expect(names).toEqual([PERMITTED_EXISTING_TABLE]);
  });

  it("customers is referenced only as a foreign-key target", () => {
    const portalTables = tablesCreated(familyUp);
    const foreign = findForeignTableRefs([...familyUp, ...familyDown], portalTables);
    const offending = foreign.filter((r) => r.role !== "fk_target");
    expect(
      offending.map((r) => `${r.table} used as ${r.role}`),
      "no existing table may be created, altered, dropped or written",
    ).toEqual([]);
  });

  it("never creates, alters, drops, truncates or writes customers", () => {
    const sql = [...familyUp, ...familyDown].join(" ");
    expect(sql).not.toMatch(/\bALTER\s+TABLE\s+customers\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?customers\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?customers\b/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+customers\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+customers\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+customers\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\s+(?:TABLE\s+)?customers\b/i);
  });

  it("names no pre-existing table other than customers (Req 22.11 — no schema change)", () => {
    // The universe-driven form of the same rule: discovered, not enumerated, so a
    // table added by an earlier migration is covered without an edit here.
    const portalTables = new Set(tablesCreated(familyUp));
    const sql = [...familyUp, ...familyDown].join(" ");
    for (const table of preExistingTables) {
      if (table === PERMITTED_EXISTING_TABLE || portalTables.has(table)) continue;
      expect(sql, `must not name the pre-existing table ${table}`).not.toMatch(
        new RegExp(`\\b${table}\\b`, "i"),
      );
    }
  });

  it("every index created is on a table the same migration creates", () => {
    for (const migration of loaded) {
      const own = tablesCreated(migration.up);
      const indexTargets = findTableRefs(migration.up).filter((r) => r.role === "index_on");
      for (const ref of indexTargets) {
        expect(own, `${migration.filename}: index on ${ref.table} should be on its own table`).toContain(
          ref.table,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Assertion 4 — teardown coherence (structural; see the file header)
// ---------------------------------------------------------------------------

describe("teardown coherence — the structural stand-in for a clean up/down cycle", () => {
  it("each migration's down exactly undoes its up", () => {
    for (const migration of loaded) {
      expect(
        checkTeardown(migration.up, migration.down),
        `${migration.filename}: down should exactly undo up`,
      ).toEqual([]);
    }
  });

  it("across the family, the created set equals the dropped set", () => {
    const created = [...tablesCreated(familyUp)].sort();
    const dropped = [...tablesDropped(familyDown)].sort();
    expect(dropped).toEqual(created);
  });

  it("drops in reverse creation order within each migration", () => {
    for (const migration of loaded) {
      const created = tablesCreated(migration.up);
      expect(
        tablesDropped(migration.down),
        `${migration.filename}: reverse creation order`,
      ).toEqual([...created].reverse());
    }
  });

  it("every drop is IF EXISTS, so a partial apply is still reversible", () => {
    for (const statement of familyDown) {
      expect(statement).toMatch(/^DROP\s+TABLE\s+IF\s+EXISTS\b/i);
    }
  });

  it("no down statement is anything other than a table drop", () => {
    for (const statement of familyDown) {
      expect(statement).not.toMatch(/\bALTER\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+[a-z_]/i);
    }
  });

  it("down drops the birthday pair in reverse order (grants before birthdays)", () => {
    const migration = loaded.find((m) => m.filename === "1786000000000_create-customer-birthdays.ts");
    expect(migration, "the birthdays migration should have been discovered").toBeDefined();
    expect(tablesDropped((migration as LoadedMigration).down)).toEqual([
      "birthday_grants",
      "customer_birthdays",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Negative controls — proof each scanner has teeth
// ---------------------------------------------------------------------------

/**
 * Synthetic migration bodies used ONLY to prove the scanners reject what they
 * claim to reject.
 *
 * ALL SYNTHETIC. These are DDL fragments naming invented objects
 * (`synthetic_widget`, `synthetic_orders`); none is a real table, none is ever
 * applied to anything, and there are no credentials, hosts or connection strings
 * anywhere in them. A scanner that finds nothing passes everything, so each
 * fixture below is a deliberate violation whose rejection is asserted.
 */
const SYNTHETIC = {
  additive: {
    up: [
      "CREATE TABLE synthetic_widget (customer_id UUID NOT NULL REFERENCES customers(id));",
      "CREATE INDEX idx_synthetic_widget ON synthetic_widget(customer_id);",
    ],
    down: ["DROP TABLE IF EXISTS synthetic_widget;"],
  },
  alterInUp: {
    up: [
      "CREATE TABLE synthetic_widget (customer_id UUID NOT NULL REFERENCES customers(id));",
      "ALTER TABLE customers ADD COLUMN birthday DATE;",
    ],
    down: ["DROP TABLE IF EXISTS synthetic_widget;"],
  },
  ledgerContact: {
    up: [
      "CREATE TABLE synthetic_widget (entry_id UUID NOT NULL REFERENCES ledger_entries(id));",
    ],
    down: ["DROP TABLE IF EXISTS synthetic_widget;"],
  },
  otherExistingTable: {
    up: [
      "CREATE TABLE synthetic_widget (order_id UUID NOT NULL REFERENCES synthetic_orders(id));",
    ],
    down: ["DROP TABLE IF EXISTS synthetic_widget;"],
  },
  missingDrop: {
    up: [
      "CREATE TABLE synthetic_widget (customer_id UUID NOT NULL);",
      "CREATE TABLE synthetic_gadget (customer_id UUID NOT NULL);",
    ],
    down: ["DROP TABLE IF EXISTS synthetic_gadget;"],
  },
  forwardOrderDrop: {
    up: [
      "CREATE TABLE synthetic_widget (customer_id UUID NOT NULL);",
      "CREATE TABLE synthetic_gadget (customer_id UUID NOT NULL);",
    ],
    down: [
      "DROP TABLE IF EXISTS synthetic_widget;",
      "DROP TABLE IF EXISTS synthetic_gadget;",
    ],
  },
  dropWithoutIfExists: {
    up: ["CREATE TABLE synthetic_widget (customer_id UUID NOT NULL);"],
    down: ["DROP TABLE synthetic_widget;"],
  },
  downTouchesForeignTable: {
    up: ["CREATE TABLE synthetic_widget (customer_id UUID NOT NULL);"],
    down: [
      "DROP TABLE IF EXISTS synthetic_widget;",
      "DROP TABLE IF EXISTS synthetic_orders;",
    ],
  },
} as const;

/** Runs a synthetic body through the same builder and the same splitter. */
async function runSynthetic(body: {
  readonly up: readonly string[];
  readonly down: readonly string[];
}): Promise<{ up: string[]; down: string[]; otherMembersUsed: string[] }> {
  const upRec = makeRecordingBuilder();
  const pgmUp = upRec.builder as { sql(s: string): void };
  for (const statement of body.up) pgmUp.sql(statement);

  const downRec = makeRecordingBuilder();
  const pgmDown = downRec.builder as { sql(s: string): void };
  for (const statement of body.down) pgmDown.sql(statement);

  return {
    up: executableStatements(upRec.calls),
    down: executableStatements(downRec.calls),
    otherMembersUsed: [...upRec.otherMembersUsed, ...downRec.otherMembersUsed],
  };
}

describe("negative controls — the scanners reject what they claim to reject", () => {
  it("accepts a well-formed synthetic migration (the control's control)", async () => {
    const { up, down } = await runSynthetic(SYNTHETIC.additive);
    expect(findNonAdditiveStatements(up)).toEqual([]);
    expect(findLedgerReferences([...up, ...down])).toEqual([]);
    expect(checkTeardown(up, down)).toEqual([]);
    const foreign = findForeignTableRefs([...up, ...down], tablesCreated(up));
    expect([...new Set(foreign.map((r) => r.table))]).toEqual([PERMITTED_EXISTING_TABLE]);
    expect(foreign.every((r) => r.role === "fk_target")).toBe(true);
  });

  it("REJECTS an ALTER TABLE in up", async () => {
    const { up } = await runSynthetic(SYNTHETIC.alterInUp);
    const problems = findNonAdditiveStatements(up);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => /ALTER TABLE/i.test(p.statement))).toBe(true);
  });

  it("REJECTS an ALTER TABLE against customers via the role rule too", async () => {
    const { up, down } = await runSynthetic(SYNTHETIC.alterInUp);
    const foreign = findForeignTableRefs([...up, ...down], tablesCreated(up));
    const badRoles = foreign.filter((r) => r.role !== "fk_target");
    expect(badRoles.map((r) => `${r.table}:${r.role}`)).toContain("customers:alter_table");
  });

  it("REJECTS a reference to a ledger table", async () => {
    const { up, down } = await runSynthetic(SYNTHETIC.ledgerContact);
    const problems = findLedgerReferences([...up, ...down]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => /ledger_entries/.test(p.reason))).toBe(true);
  });

  it("REJECTS a foreign-key target that is not customers", async () => {
    const { up, down } = await runSynthetic(SYNTHETIC.otherExistingTable);
    const foreign = findForeignTableRefs([...up, ...down], tablesCreated(up));
    const names = [...new Set(foreign.map((r) => r.table))].sort();
    // This is the assertion that makes the customers-only rule real: a DIFFERENT
    // existing table appears here, and the equality assertion in the block above
    // would fail on it.
    expect(names).toContain("synthetic_orders");
    expect(names).not.toEqual([PERMITTED_EXISTING_TABLE]);
  });

  it("REJECTS a down that forgets to drop a table up created", async () => {
    const { up, down } = await runSynthetic(SYNTHETIC.missingDrop);
    const problems = checkTeardown(up, down);
    expect(problems).toContain("up creates synthetic_widget but down never drops it");
  });

  it("REJECTS a down that drops in creation order rather than reverse", async () => {
    const { up, down } = await runSynthetic(SYNTHETIC.forwardOrderDrop);
    const problems = checkTeardown(up, down);
    expect(problems.some((p) => /reverse creation order/.test(p))).toBe(true);
  });

  it("REJECTS a DROP TABLE without IF EXISTS", async () => {
    const { up, down } = await runSynthetic(SYNTHETIC.dropWithoutIfExists);
    const problems = checkTeardown(up, down);
    expect(problems.some((p) => /not a DROP TABLE IF EXISTS/.test(p))).toBe(true);
  });

  it("REJECTS a down that touches something up did not create", async () => {
    const { up, down } = await runSynthetic(SYNTHETIC.downTouchesForeignTable);
    const problems = checkTeardown(up, down);
    expect(problems).toContain("down drops synthetic_orders, which up did not create");
  });

  it("NOTICES a migration that bypasses pgm.sql for another builder member", () => {
    const rec = makeRecordingBuilder();
    // A migration written with the typed helper API instead of plain pgm.sql:
    // it emits no statements, so every DDL scan would pass vacuously.
    const pgm = rec.builder as unknown as { dropTable(t: string): void };
    pgm.dropTable("customers");
    expect(rec.calls).toEqual([]);
    expect(rec.otherMembersUsed).toContain("dropTable");
  });
});

// ---------------------------------------------------------------------------
// The SQL utilities themselves, since every assertion above rests on them
// ---------------------------------------------------------------------------

describe("SQL utilities", () => {
  it("strips line comments but keeps executable text", () => {
    expect(normalize(stripSqlComments("CREATE TABLE t (a INT); -- a note"))).toBe(
      "CREATE TABLE t (a INT);",
    );
  });

  it("does not treat a comment marker inside a string literal as a comment", () => {
    const sql = "CREATE TABLE t (a TEXT DEFAULT 'x--y');";
    expect(stripSqlComments(sql)).toContain("'x--y'");
  });

  it("splits on top-level semicolons only", () => {
    expect(splitStatements("CREATE TABLE a (x INT); CREATE TABLE b (y INT);")).toEqual([
      "CREATE TABLE a (x INT)",
      "CREATE TABLE b (y INT)",
    ]);
  });

  it("does not split on a semicolon inside a string literal", () => {
    expect(splitStatements("CREATE TABLE a (x TEXT DEFAULT 'p;q');")).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT 'p;q')",
    ]);
  });

  it("finds the index target rather than the index name", () => {
    const refs = findTableRefs(["CREATE INDEX idx_q ON some_table(status, at)"]);
    expect(refs.filter((r) => r.role === "index_on").map((r) => r.table)).toEqual(["some_table"]);
  });

  it("word-boundary matching does not confuse referrals with customer_referrals", () => {
    expect(
      findLedgerReferences(["CREATE TABLE customer_referrals (id UUID PRIMARY KEY)"]),
    ).toEqual([]);
    expect(
      findLedgerReferences(["CREATE TABLE x (r UUID REFERENCES referrals(id))"]).length,
    ).toBeGreaterThan(0);
  });

  it("does not mistake updated_at or grant_year for UPDATE or GRANT", () => {
    expect(
      findNonAdditiveStatements([
        "CREATE TABLE t (updated_at TIMESTAMPTZ, grant_year SMALLINT, granted_at TIMESTAMPTZ)",
      ]),
    ).toEqual([]);
  });
});

/* ==========================================================================
 * The constraint-widening class (task 15.3) — its own, narrower rules
 *
 * These migrations create no table, so the family assertions above do not apply.
 * What must hold instead is that they only ever WIDEN a CHECK, touch no
 * ledger-protected table, and refuse rather than delete on the way back down.
 * ========================================================================== */

describe("constraint-widening migrations widen, and only widen", () => {
  it("creates and drops NO table, and touches no row", () => {
    for (const migration of widening) {
      const sql = [...migration.up, ...migration.down].join(" ");
      // The whole point of the separate class: no table lifecycle at all.
      expect(sql, `${migration.filename} should create no table`).not.toMatch(/\bCREATE\s+TABLE\b/i);
      expect(sql, `${migration.filename} should drop no table`).not.toMatch(/\bDROP\s+TABLE\b/i);
      // And no data statement — a constraint change must not rewrite rows.
      expect(sql, `${migration.filename} should delete no row`).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(sql, `${migration.filename} should truncate nothing`).not.toMatch(/\bTRUNCATE\b/i);
      // `UPDATE` guarded to the data form, so `DROP CONSTRAINT` phrasing cannot
      // trip it.
      expect(sql, `${migration.filename} should update no row`).not.toMatch(
        /\bUPDATE\s+[a-z_]+\s+SET\b/i,
      );
    }
  });

  it("only ever DROPs and re-ADDs a CHECK constraint", () => {
    for (const migration of widening) {
      // The RAW calls, not the split statements: `splitStatements` breaks on `;`,
      // which fragments the guarded `DO $$ … END $$` block into pieces that are
      // individually neither constraint work nor a refusal. One `pgm.sql(...)` call
      // is one logical statement, which is the unit this rule is about.
      for (const statement of [...migration.upCalls, ...migration.downCalls]) {
        const isConstraintWork =
          /\bALTER\s+TABLE\b[\s\S]*\b(?:DROP|ADD)\s+CONSTRAINT\b/i.test(statement) ||
          // The guarded `down` preflight, which raises rather than writing.
          /\bRAISE\s+EXCEPTION\b/i.test(statement);
        expect(
          isConstraintWork,
          `${migration.filename} statement is neither constraint work nor a refusal:\n${statement}`,
        ).toBe(true);
      }
    }
  });

  it("WIDENS: every value the old CHECK allowed, the new one still allows", () => {
    // The safety property that makes this class additive at all. A migration that
    // narrowed a CHECK could break an existing write path the moment it applied.
    for (const migration of widening) {
      const values = (sql: string): string[] =>
        [...sql.matchAll(/'([a-z_]+)'/gi)].map((m) => m[1] as string);
      const upAdded = migration.up.filter((s) => /\bADD\s+CONSTRAINT\b/i.test(s)).join(" ");
      const downAdded = migration.down.filter((s) => /\bADD\s+CONSTRAINT\b/i.test(s)).join(" ");
      const after = new Set(values(upAdded));
      const before = new Set(values(downAdded));
      expect(before.size, `${migration.filename} down should restore a value set`).toBeGreaterThan(0);
      for (const value of before) {
        expect(
          after.has(value),
          `${migration.filename} drops '${value}' from the CHECK — that is a narrowing, not a widening`,
        ).toBe(true);
      }
      // And it genuinely adds something, or the migration is a no-op.
      expect(after.size).toBeGreaterThan(before.size);
    }
  });

  it("names NO ledger-protected table (Req 23.6)", () => {
    for (const migration of widening) {
      const sql = [...migration.up, ...migration.down].join(" ").toLowerCase();
      for (const table of [
        "ledger_entries",
        "point_lots",
        "redemptions",
        "discount_codes",
        "referrals",
      ]) {
        expect(sql, `${migration.filename} names ${table}`).not.toMatch(
          new RegExp(`\\b${table}\\b`),
        );
      }
    }
  });

  it("REFUSES on the way down rather than deleting history", () => {
    // An audit trail a rollback can quietly erase is not an audit trail. The `down`
    // must raise when a row holding the new value exists.
    for (const migration of widening) {
      const down = migration.down.join(" ");
      expect(down, `${migration.filename} down should raise rather than delete`).toMatch(
        /\bRAISE\s+EXCEPTION\b/i,
      );
      expect(down).toMatch(/\bcount\(\*\)/i);
    }
  });

  it("keeps the audit vocabulary in step with the code constant", () => {
    // The migration and `AUDIT_OPERATION_TYPES` describe the same set. Drift means
    // either a value the code writes that the CHECK rejects, or a value the CHECK
    // allows that nothing can produce.
    const source = readFileSync(
      join(migrationsDir, "1786600000000_extend-audit-for-redaction.ts"),
      "utf8",
    );
    const declared = [...source.matchAll(/^\s*"([a-z_]+)",$/gm)].map((m) => m[1] as string);
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...AUDIT_OPERATION_TYPES].sort());
  });
});
