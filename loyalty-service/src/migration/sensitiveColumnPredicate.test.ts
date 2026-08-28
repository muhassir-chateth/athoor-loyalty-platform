/**
 * The sensitive-column predicate in
 * `docs/ops/supabase-critical-findings-production-probe.sql`.
 *
 * ── WHY A HAND-RUN SQL FILE HAS A TEST ───────────────────────────────────────
 * That probe answers a CRITICAL Supabase advisory: `sensitive_columns_exposed`. Its
 * summary emits a COUNT, and the owner uses that number to decide whether production
 * is exposed. A count is only worth having if every member earns its place.
 *
 * The predicate was a short alternation of fragments, and it could not be checked
 * because it lived in a `.sql` file nobody executed in CI. Measured against the 109
 * columns the migrations actually create, it produced three false positives out of
 * twelve matches and missed a genuine bearer value:
 *
 *   markets.code                                        HTTP-irrelevant market code
 *   idempotency_keys.status_code                        an HTTP status integer
 *   customer_communication_preferences.birthday_messages  a BOOLEAN opt-in toggle
 *   redemptions.idempotency_key                         MISSED — a replay credential
 *
 * ── THE PREDICATE IS EXTRACTED, NEVER TRANSCRIBED ────────────────────────────
 * The regex is read out of the `.sql` file at run time, and the column inventory is
 * derived from the migrations. Both sides are the real artefacts. A transcribed copy
 * would drift from the file the owner actually pastes into a SQL console, which is
 * the one failure this test exists to prevent.
 *
 * ── THE ONE APPROXIMATION, STATED ────────────────────────────────────────────
 * Postgres `~*` is a case-insensitive POSIX ERE; this runs it as a JavaScript
 * `RegExp` with the `i` flag. For an alternation of literal words — which is all this
 * predicate contains, asserted below — the two engines agree. If the predicate ever
 * gains a construct where they diverge (a POSIX character class, a back-reference)
 * `thePredicateIsAPlainAlternation` fails and this note stops being true quietly.
 *
 * SAFETY: two file reads. No database, no network. The probe itself is never executed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROBE = join(REPO_ROOT, "docs", "ops", "supabase-critical-findings-production-probe.sql");
const MIGRATIONS = join(REPO_ROOT, "loyalty-service", "migrations");

/* ========================================================================== *
 * Reading the real artefacts
 * ========================================================================== */

const probeSql = readFileSync(PROBE, "utf8");

/** The `~*` alternation from the `sensitive` CTE, as written in the file. */
function extractPredicate(): string {
  const match = /att\.attname::text\s*~\*\s*'\(([^']+)\)'/.exec(probeSql);
  if (match?.[1] === undefined) {
    throw new Error("could not find the sensitive-column predicate in the probe SQL");
  }
  return match[1];
}

const PREDICATE_SOURCE = extractPredicate();
const PREDICATE = new RegExp(`(${PREDICATE_SOURCE})`, "i");

/** Table-scoped exceptions of the form `r.name = 'x' AND att.attname::text = 'y'`. */
function extractTableScoped(): { relation: string; column: string }[] {
  const out: { relation: string; column: string }[] = [];
  const pattern =
    /r\.name\s*=\s*'([a-z_]+)'\s*AND\s*att\.attname::text\s*=\s*'([a-z_]+)'/gi;
  for (const match of probeSql.matchAll(pattern)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      out.push({ relation: match[1], column: match[2] });
    }
  }
  return out;
}

const TABLE_SCOPED = extractTableScoped();

/** Every `table.column` the migrations create. */
function schemaColumns(): { relation: string; column: string; type: string }[] {
  const out: { relation: string; column: string; type: string }[] = [];
  const types =
    "uuid|text|int|integer|bigint|smallint|boolean|numeric|timestamptz|date|jsonb|citext|serial|bigserial";
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".ts")).sort()) {
    const source = readFileSync(join(MIGRATIONS, file), "utf8");
    const tablePattern = /create table(?:\s+if not exists)?\s+([a-z_."]+)\s*\(([\s\S]*?)\n\s*\);/gi;
    for (const table of source.matchAll(tablePattern)) {
      const relation = (table[1] ?? "").replace(/"/g, "").replace(/^public\./, "");
      for (const line of (table[2] ?? "").split("\n")) {
        const column = new RegExp(`^\\s*([a-z_][a-z0-9_]*)\\s+(${types})\\b`, "i").exec(line);
        if (column?.[1] !== undefined) {
          out.push({ relation, column: column[1].toLowerCase(), type: (column[2] ?? "").toLowerCase() });
        }
      }
    }
  }
  return out;
}

const COLUMNS = schemaColumns();

/** Does the probe flag this column, by either mechanism? */
function flagged(relation: string, column: string): boolean {
  if (PREDICATE.test(column)) return true;
  return TABLE_SCOPED.some((entry) => entry.relation === relation && entry.column === column);
}

/* ========================================================================== *
 * The extraction works — a scan that reads nothing proves nothing
 * ========================================================================== */

describe("the test reads the real probe and the real schema", () => {
  it("found the predicate in the probe SQL", () => {
    expect(PREDICATE_SOURCE.length).toBeGreaterThan(40);
    expect(PREDICATE_SOURCE).toContain("email");
  });

  it("found a substantial column inventory in the migrations", () => {
    // If the parser broke, every assertion below would pass over an empty list.
    expect(COLUMNS.length).toBeGreaterThan(90);
    const relations = new Set(COLUMNS.map((c) => c.relation));
    expect(relations.size).toBeGreaterThan(15);
    // Spot-check a column that must exist, so a silent parser regression is caught.
    expect(COLUMNS).toEqual(
      expect.arrayContaining([expect.objectContaining({ relation: "customer_birthdays" })]),
    );
  });

  it("the predicate is a plain alternation, which is why a JS RegExp is faithful", () => {
    // The approximation this file rests on. POSIX ERE and JS agree on an alternation
    // of literal words; they diverge on POSIX classes and back-references.
    expect(PREDICATE_SOURCE).not.toMatch(/\[\[:[a-z]+:\]\]/);
    expect(PREDICATE_SOURCE).not.toMatch(/\\[1-9]/);
    for (const alternative of PREDICATE_SOURCE.split("|")) {
      expect(alternative, `"${alternative}" is not a literal word`).toMatch(/^[a-z_]+$/i);
    }
  });
});

/* ========================================================================== *
 * No false positives — the count must be trustworthy
 * ========================================================================== */

describe("the predicate does not flag columns that hold nothing sensitive", () => {
  /**
   * Each entry is a real column, with the reason it is not sensitive. These are the
   * three the previous predicate flagged, plus the two that adding `name` or `key`
   * would have introduced.
   */
  const MUST_NOT_FLAG: readonly { relation: string; column: string; because: string }[] = [
    { relation: "markets", column: "code", because: "a market code such as GB" },
    { relation: "idempotency_keys", column: "status_code", because: "an HTTP status integer" },
    {
      relation: "customer_communication_preferences",
      column: "birthday_messages",
      because: "a BOOLEAN opt-in toggle, not a birth date",
    },
    { relation: "benefits", column: "name", because: "a catalogue label, not a person" },
    { relation: "benefits", column: "key", because: "an identifier such as free_shipping" },
    {
      relation: "redemptions",
      column: "discount_code_id",
      because: "an opaque UUID foreign key — it reveals no code",
    },
  ];

  it.each(MUST_NOT_FLAG)("$relation.$column is not flagged — $because", ({ relation, column }) => {
    // Guard: if the column stopped existing this test would pass vacuously.
    expect(
      COLUMNS.some((c) => c.relation === relation && c.column === column),
      `${relation}.${column} is not in the schema — this test has gone stale`,
    ).toBe(true);
    expect(flagged(relation, column)).toBe(false);
  });

  it("no BOOLEAN column is flagged at all", () => {
    // A boolean holds a yes/no preference. It cannot carry an email, a token or a
    // birth date, so a flagged boolean is a false positive by construction — which is
    // exactly how `birthday_messages` was caught.
    const flaggedBooleans = COLUMNS.filter(
      (c) => c.type === "boolean" && flagged(c.relation, c.column),
    ).map((c) => `${c.relation}.${c.column}`);
    expect(flaggedBooleans, `boolean columns flagged as sensitive:\n  ${flaggedBooleans.join("\n  ")}`).toEqual(
      [],
    );
  });
});

/* ========================================================================== *
 * No false negatives — a missed column is worse than a noisy count
 * ========================================================================== */

describe("the predicate flags every column that does hold personal or bearer data", () => {
  const MUST_FLAG: readonly { relation: string; column: string; because: string }[] = [
    { relation: "customer_birthdays", column: "birth_month", because: "a birth date component" },
    { relation: "customer_birthdays", column: "birth_day", because: "a birth date component" },
    { relation: "referrals", column: "referred_email", because: "another person's email" },
    {
      relation: "discount_codes",
      column: "code",
      because: "a redeemable code — table-scoped, since the column is named just `code`",
    },
    {
      relation: "redemptions",
      column: "idempotency_key",
      because: "a replay credential — missed entirely before",
    },
    {
      relation: "idempotency_keys",
      column: "key",
      because: "the stored idempotency key — table-scoped, since benefits.key is not sensitive",
    },
  ];

  it.each(MUST_FLAG)("$relation.$column IS flagged — $because", ({ relation, column }) => {
    expect(
      COLUMNS.some((c) => c.relation === relation && c.column === column),
      `${relation}.${column} is not in the schema — this test has gone stale`,
    ).toBe(true);
    expect(flagged(relation, column)).toBe(true);
  });

  it("every column whose name contains email, token, secret or password is flagged", () => {
    // A category check rather than a list, so a column added later is covered without
    // this file being edited.
    const missed = COLUMNS.filter(
      (c) => /email|token|secret|password/i.test(c.column) && !flagged(c.relation, c.column),
    ).map((c) => `${c.relation}.${c.column}`);
    expect(missed, `unflagged credential-shaped columns:\n  ${missed.join("\n  ")}`).toEqual([]);
  });

  it("the table-scoped exception is present and names idempotency_keys.key", () => {
    // The one case a name-only heuristic cannot decide. If this clause were dropped
    // the column would silently stop being counted.
    expect(TABLE_SCOPED).toEqual(
      expect.arrayContaining([
        { relation: "idempotency_keys", column: "key" },
        { relation: "discount_codes", column: "code" },
      ]),
    );
  });
});

/* ========================================================================== *
 * Non-vacuity — the old predicate really was wrong
 * ========================================================================== */

describe("is NON-VACUOUS: the previous predicate misclassified these very columns", () => {
  /** The predicate exactly as it was, so this file demonstrably asserts a change. */
  const OLD = new RegExp(
    "(email|phone|birth|dob|token|secret|password|hash|ip_address|user_agent|address|postcode|shopify_customer_id|referral_code|code)",
    "i",
  );

  it("the old predicate flagged three columns that hold nothing sensitive", () => {
    for (const column of ["code", "status_code", "birthday_messages", "discount_code_id"]) {
      expect(OLD.test(column), `old predicate did not flag ${column}`).toBe(true);
    }
    // And the new one does not.
    expect(flagged("markets", "code")).toBe(false);
    expect(flagged("idempotency_keys", "status_code")).toBe(false);
    expect(flagged("customer_communication_preferences", "birthday_messages")).toBe(false);
    expect(flagged("redemptions", "discount_code_id")).toBe(false);
  });

  it("the old predicate missed the redemption replay credential", () => {
    expect(OLD.test("idempotency_key")).toBe(false);
    expect(flagged("redemptions", "idempotency_key")).toBe(true);
  });

  it("the old predicate produced ~30% noise across the real schema", () => {
    // The number that motivated the change, recomputed from the artefacts rather than
    // quoted. If the schema grows this figure moves, and the assertion is a range.
    const oldFlagged = COLUMNS.filter((c) => OLD.test(c.column));
    const falsePositives = oldFlagged.filter((c) =>
      // `code` here is `markets.code`; `discount_codes.code` is a true positive and is
      // excluded by relation below.
      (["status_code", "birthday_messages", "discount_code_id"].includes(c.column) ||
        (c.column === "code" && c.relation === "markets")),
    );
    expect(oldFlagged.length).toBeGreaterThan(8);
    expect(falsePositives.length).toBe(4);
    // Roughly a quarter of the old count was noise.
    expect(falsePositives.length / oldFlagged.length).toBeGreaterThan(0.2);
  });

  it("the new predicate still flags everything the old one correctly flagged", () => {
    // A regression guard: the tightening must not have dropped a true positive.
    const lostGround = COLUMNS.filter(
      (c) =>
        OLD.test(c.column) &&
        !["status_code", "birthday_messages", "discount_code_id"].includes(c.column) &&
        !(c.column === "code" && c.relation === "markets") &&
        !flagged(c.relation, c.column),
    ).map((c) => `${c.relation}.${c.column}`);
    expect(lostGround, `columns the old predicate caught and the new one does not:\n  ${lostGround.join("\n  ")}`).toEqual(
      [],
    );
  });
});

/* ========================================================================== *
 * The probe itself stays read-only
 * ========================================================================== */

describe("the probe remains a read-only diagnostic", () => {
  it("contains no statement that could change production", () => {
    // Its own header promises this. Asserted here so the promise is enforced rather
    // than trusted — this file is pasted into a console against production.
    // Comments go, AND so do single-quoted string literals. `has_table_privilege(role,
    // oid, 'TRUNCATE')` ASKS WHETHER a role may truncate — it is a read-only catalogue
    // lookup, and the keyword inside the quotes is data. Scanning the raw text read
    // that privilege check as a destructive statement, which is a false positive of
    // exactly the kind this whole change is about.
    const withoutComments = probeSql
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .replace(/'(?:[^']|'')*'/g, "''");
    for (const forbidden of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bDROP\b/i,
      /\bALTER\b/i,
      /\bGRANT\b/i,
      /\bREVOKE\b/i,
      /\bTRUNCATE\b/i,
      /\bCREATE\s+(?:TABLE|INDEX|FUNCTION|ROLE|USER)\b/i,
    ]) {
      expect(withoutComments, `probe contains ${String(forbidden)}`).not.toMatch(forbidden);
    }
  });

  it("selects no column VALUE from a sensitive column, only names", () => {
    // The distinction the probe's header draws: it reports that `email` is readable,
    // never what any email is. `attname` is a catalogue lookup; a bare `SELECT email`
    // would be reading customer data.
    expect(probeSql).toContain("att.attname::text AS column_name");
    expect(probeSql).not.toMatch(/select[^;]*\bfrom\s+(?:public\.)?customers\b/i);
    expect(probeSql).not.toMatch(/select[^;]*\bfrom\s+(?:public\.)?referrals\b/i);
  });

  it("is NON-VACUOUS: the forbidden-statement patterns match what they describe", () => {
    expect(/\bINSERT\s+INTO\b/i.test("INSERT INTO t VALUES (1)")).toBe(true);
    expect(/\bGRANT\b/i.test("GRANT SELECT ON t TO anon")).toBe(true);
    expect(/\bCREATE\s+(?:TABLE|INDEX|FUNCTION|ROLE|USER)\b/i.test("CREATE TABLE x ()")).toBe(true);
    // And a CTE's `CREATE`-free `WITH ... AS (SELECT ...)` is not caught.
    expect(/\bCREATE\s+(?:TABLE|INDEX|FUNCTION|ROLE|USER)\b/i.test("WITH x AS (SELECT 1)")).toBe(false);
  });
});
