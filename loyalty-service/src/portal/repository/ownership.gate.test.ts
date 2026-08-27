/**
 * THE OWNERSHIP GATE — the test that makes a future unsafe query fail without
 * anyone remembering to add a case (spec task 5.4).
 *
 * WHY A GATE AND NOT MORE UNIT TESTS
 * ----------------------------------
 * `scopedQuery.test.ts` proves the primitive rejects unscoped SQL. That is a
 * statement about the primitive, not about the codebase: it says nothing about a
 * repository function added in three months that bypasses the primitive entirely
 * and calls `executor.query` directly, and nothing about a delegation target
 * whose predicate someone loosens. This gate closes both, in the spirit of the
 * 5.3 route census: it DISCOVERS the surface rather than enumerating it, so new
 * code is covered on the day it is written.
 *
 * WHAT IT DISCOVERS, AND WHAT IT ASSERTS
 * --------------------------------------
 *   1. Every SQL statement in this directory — found by scanning source, not
 *      listed — must pass the SAME {@link validateScopedStatement} the runtime
 *      uses. One definition of "safe", enforced statically and dynamically, so
 *      the two cannot drift.
 *   2. Every SQL statement in each module this layer DELEGATES to must pass it
 *      too. This is what makes delegation safe rather than trusted: weakening
 *      `WHERE customer_id = $1` in `profile/favouritesWishlist.ts` fails a test
 *      in `src/portal/repository/`.
 *   3. `DELEGATION_TARGETS` cannot fall behind: every value import this
 *      directory makes into `profile/**` or `ledger/**` must be listed, so a new
 *      delegation is either declared or it fails here.
 *   4. No file but `scopedQuery.ts` may call `.query(` — the primitive is the
 *      only executor, so ownership validation cannot be sidestepped.
 *   5. Every `scope.customerId` unwrap is accounted for structurally.
 *   6. No exported signature takes a bare `customerId: string`.
 *   7. This directory emits no logs (it holds SQL and bound parameters).
 *   8. Every GraphQL document here belongs to exactly ONE security class and
 *      passes that class's guard: {@link assertScopedCustomerQuery} for a
 *      customer-rooted read, {@link assertGlobalCatalogueQuery} for a global
 *      catalogue read. Membership is declared per FILE, never sniffed from
 *      content, so an edit cannot downgrade a document to the weaker gate.
 *
 * THE VACUOUS-PASS PROBLEM, AND HOW IT IS HANDLED
 * ----------------------------------------------
 * A source-scanning gate has one characteristic failure: the extractor breaks,
 * finds nothing, and every assertion passes over an empty set. That is worse than
 * having no gate, because it reports safety it never checked. So the extractor is
 * itself under test — {@link REQUIRED_DISCOVERIES} names statements that must be
 * found, and a minimum count is asserted per file. A scanner that silently stops
 * working fails loudly here.
 *
 * SAFETY: reads source files from disk. No Postgres, no Shopify, no network.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 2.6
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DELEGATION_TARGETS } from "./customerOwned.js";
import { assertGlobalCatalogueQuery, assertScopedCustomerQuery } from "./shopifyScope.js";
import { UnscopedStatementError, validateScopedStatement } from "./scopedQuery.js";

const REPOSITORY_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(REPOSITORY_DIR, "..", "..");

/* ========================================================================== *
 * A real scanner, because a regex over TypeScript is not good enough here
 * ========================================================================== */

/**
 * Source with comments blanked, plus every string/template literal found.
 *
 * WHY NOT A REGEX. This file's own module headers contain deliberately-UNSAFE
 * illustrative SQL inside quotes — `db.query("SELECT * FROM t WHERE id = $1")`
 * appears in `scopedQuery.ts` as the anti-pattern being described. A regex
 * extractor would find it and fail the gate on a comment, and the natural fix
 * would be to delete the explanation. Equally, stripping `//` comments by regex
 * would truncate `gid://shopify/Customer/…` mid-string in `shopifyScope.ts`.
 * A character scanner that knows which construct it is inside gets both right.
 *
 * Comments are blanked rather than removed so byte offsets stay meaningful, and
 * newlines are preserved so line-based assertions still report usable positions.
 */
interface ScannedSource {
  /** Source with every comment replaced by whitespace of equal length. */
  readonly code: string;
  /** Every string and template literal body, in source order. */
  readonly literals: readonly string[];
  /** `code` split into lines, for assertions that want a line of context. */
  readonly codeLines: readonly string[];
}

function scanSource(source: string): ScannedSource {
  const literals: string[] = [];
  let code = "";
  let index = 0;

  while (index < source.length) {
    const character = source[index] as string;
    const lookahead = source[index + 1];

    if (character === "/" && lookahead === "/") {
      while (index < source.length && source[index] !== "\n") {
        code += " ";
        index += 1;
      }
      continue;
    }

    if (character === "/" && lookahead === "*") {
      code += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        code += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        code += "  ";
        index += 2;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const start = index;
      index += 1;
      let value = "";
      while (index < source.length) {
        const inner = source[index] as string;
        if (inner === "\\") {
          value += inner + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (inner === quote) {
          index += 1;
          break;
        }
        value += inner;
        index += 1;
      }
      literals.push(value);
      code += source.slice(start, index);
      continue;
    }

    code += character;
    index += 1;
  }

  return { code, literals, codeLines: code.split("\n") };
}

/**
 * A literal is SQL if it OPENS with a statement keyword — position, not presence,
 * so a comment or a message mentioning `SELECT` is not mistaken for a statement.
 */
const SQL_OPENING = /^\s*(?:select|insert|update|delete|with)\b/i;

/**
 * …and carries a clause that makes it a statement rather than a bare word.
 *
 * WITHOUT THIS the gate flagged the string `"select"` — a member of
 * `SCOPED_STATEMENT_KINDS` in `scopedQuery.ts` — as an unscoped statement. Which
 * is the gate working: it found a hole in its own discriminator on the first run.
 * Every statement that can read or write customer rows names a table, so
 * requiring `FROM`/`INTO`/`SET` excludes vocabulary strings without excluding
 * anything that could touch data.
 */
const SQL_CLAUSE = /\b(?:from|into|set)\b/i;

/** A literal is a GraphQL document if it opens with an operation keyword. */
const GRAPHQL_OPENING = /^\s*(?:query|mutation)\b/i;

function sqlLiterals(scanned: ScannedSource): string[] {
  return scanned.literals.filter(
    (literal) => SQL_OPENING.test(literal) && SQL_CLAUSE.test(literal),
  );
}

function graphqlLiterals(scanned: ScannedSource): string[] {
  return scanned.literals.filter((literal) => GRAPHQL_OPENING.test(literal));
}

/* ========================================================================== *
 * The surface under test, discovered rather than listed
 * ========================================================================== */

/** Every non-test TypeScript file in this directory. Discovered on each run. */
function repositorySourceFiles(): string[] {
  return readdirSync(REPOSITORY_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

function readRepositoryFile(name: string): ScannedSource {
  return scanSource(readFileSync(join(REPOSITORY_DIR, name), "utf8"));
}

/**
 * Statements that MUST be discovered, so a broken extractor cannot pass
 * vacuously. Each entry is a fragment unique to a statement this layer relies
 * on; if the scanner stops finding SQL, these fail rather than everything
 * quietly succeeding over an empty set.
 */
const REQUIRED_DISCOVERIES: readonly { where: string; fragment: RegExp }[] = [
  { where: "customerOwned.ts", fragment: /count\(\*\)::text AS item_count/i },
  { where: "customerOwned.ts", fragment: /INSERT INTO customer_wishlist/i },
  { where: "customerOwned.ts", fragment: /DELETE FROM customer_wishlist/i },
  { where: "profile/favouritesWishlist.ts", fragment: /FROM customer_wishlist/i },
  { where: "profile/favouritesWishlist.ts", fragment: /DELETE FROM customer_favourites/i },
];

describe("the extractor itself works (a scanning gate that finds nothing is worse than no gate)", () => {
  it("finds the statements this layer is known to contain", () => {
    const discovered = new Map<string, string[]>();
    for (const name of repositorySourceFiles()) {
      discovered.set(name, sqlLiterals(readRepositoryFile(name)));
    }
    for (const target of DELEGATION_TARGETS) {
      const scanned = scanSource(readFileSync(join(SRC_DIR, target), "utf8"));
      discovered.set(target, sqlLiterals(scanned));
    }

    for (const { where, fragment } of REQUIRED_DISCOVERIES) {
      const statements = discovered.get(where) ?? [];
      expect(
        statements.some((sql) => fragment.test(sql)),
        `${where} should contain a statement matching ${String(fragment)} — ` +
          `if this fails the SQL extractor has stopped working, and every other ` +
          `assertion in this file is passing over an empty set`,
      ).toBe(true);
    }
  });

  it("does not mistake illustrative SQL inside a comment for a real statement", () => {
    // `scopedQuery.ts` documents the anti-pattern it exists to abolish, using a
    // quoted unscoped statement. If comment-stripping regressed, the gate would
    // fail on prose — and the tempting fix would be to delete the explanation.
    const raw = readFileSync(join(REPOSITORY_DIR, "scopedQuery.ts"), "utf8");
    expect(raw).toContain('db.query("SELECT * FROM t WHERE id = $1"');

    const scanned = scanSource(raw);
    expect(scanned.literals.some((literal) => /FROM t WHERE id = \$1/.test(literal))).toBe(false);
  });

  it("keeps a string containing a double slash intact", () => {
    // `gid://shopify/Customer/…` would be cut at `//` by regex comment-stripping.
    const scanned = readRepositoryFile("shopifyScope.ts");
    expect(scanned.code).toContain("gid://shopify/Customer/");
  });
});

/* ========================================================================== *
 * 1 + 2 — every statement, here and in every delegation target, is scoped
 * ========================================================================== */

describe("every SQL statement carries customer ownership (Requirements 2.1, 2.5)", () => {
  it("validates every statement in this directory with the runtime validator", () => {
    let checked = 0;
    for (const name of repositorySourceFiles()) {
      for (const sql of sqlLiterals(readRepositoryFile(name))) {
        checked += 1;
        // No param count is available from source, so the numbering rule is
        // skipped — deliberately, and stated, rather than guessed at.
        expect(
          () => validateScopedStatement(sql),
          `${name} contains a statement without customer ownership:\n${sql}`,
        ).not.toThrow();
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("validates every statement in each delegation target", () => {
    let checked = 0;
    for (const target of DELEGATION_TARGETS) {
      const scanned = scanSource(readFileSync(join(SRC_DIR, target), "utf8"));
      const statements = sqlLiterals(scanned);
      expect(
        statements.length,
        `${target} is listed as a delegation target but contains no SQL — either ` +
          `the listing is stale or the extractor broke`,
      ).toBeGreaterThan(0);

      for (const sql of statements) {
        checked += 1;
        expect(
          () => validateScopedStatement(sql),
          `delegation target ${target} contains a statement without customer ` +
            `ownership, so a portal read through it would not be scoped:\n${sql}`,
        ).not.toThrow();
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});

/* ========================================================================== *
 * 3 — the delegation list cannot fall behind the imports
 * ========================================================================== */

/** `import … from "…"` with the module specifier and whether it is type-only. */
const IMPORT_STATEMENT = /import\s+(type\s+)?([\s\S]*?)from\s+["']([^"']+)["']/g;

describe("DELEGATION_TARGETS stays in step with what this directory actually imports", () => {
  it("lists every value import reaching into profile/** or ledger/**", () => {
    const declared = new Set(DELEGATION_TARGETS);

    for (const name of repositorySourceFiles()) {
      const { code } = readRepositoryFile(name);
      let match: RegExpExecArray | null;
      const pattern = new RegExp(IMPORT_STATEMENT.source, "g");

      while ((match = pattern.exec(code)) !== null) {
        const [, typeKeyword, clause, specifier = ""] = match;
        if (!specifier.startsWith("../")) continue;

        // A type-only import cannot execute a statement, so it needs no
        // ownership guarantee. Both spellings count: `import type { X }` and an
        // inline `{ type X }` on every binding.
        const bindings = (clause ?? "").replace(/[{}]/g, "").split(",").map((s) => s.trim());
        const everyBindingIsType =
          bindings.length > 0 && bindings.every((b) => b === "" || b.startsWith("type "));
        if (typeKeyword !== undefined || everyBindingIsType) continue;

        const resolved = relative(SRC_DIR, resolve(REPOSITORY_DIR, specifier)).replace(
          /\.js$/,
          ".ts",
        );
        if (!/^(profile|ledger)\//.test(resolved)) continue;

        expect(
          declared.has(resolved),
          `${name} value-imports ${resolved}, whose SQL this layer therefore ` +
            `depends on, but it is not in DELEGATION_TARGETS — so its ownership ` +
            `predicates are trusted rather than verified`,
        ).toBe(true);
      }
    }
  });
});

/* ========================================================================== *
 * 4 — the primitive is the only executor
 * ========================================================================== */

describe("no repository file executes SQL outside the primitive (Requirement 2.1)", () => {
  it("permits .query( only in scopedQuery.ts", () => {
    for (const name of repositorySourceFiles()) {
      const { code } = readRepositoryFile(name);
      const executes = /\.query\s*[<(]/.test(code);
      if (name === "scopedQuery.ts") {
        expect(executes, "scopedQuery.ts is the executor and must contain the call").toBe(true);
        expect((code.match(/\.query\s*[<(]/g) ?? []).length).toBe(1);
        continue;
      }
      expect(
        executes,
        `${name} calls .query( directly, bypassing validateScopedStatement and ` +
          `the $1 binding — the two things that make a statement provably scoped`,
      ).toBe(false);
    }
  });
});

/* ========================================================================== *
 * 5 — every unwrap is accounted for
 * ========================================================================== */

describe("scope.customerId is unwrapped only where the layer says it is", () => {
  it("allows exactly one unwrap in each primitive module", () => {
    for (const name of ["scopedQuery.ts", "shopifyScope.ts"]) {
      const { code } = readRepositoryFile(name);
      const unwraps = (code.match(/scope\.customerId/g) ?? []).length;
      expect(
        unwraps,
        `${name} should hold exactly one unwrap — the single boundary where the ` +
          `checked world is left`,
      ).toBe(1);
    }
  });

  it("allows an unwrap in customerOwned.ts only on a line that delegates to an engine function", () => {
    const scanned = readRepositoryFile("customerOwned.ts");

    // The permitted callees are READ OUT OF THE IMPORT STATEMENT rather than
    // hardcoded, so adding a delegation updates this check automatically while
    // an unwrap that calls anything else still fails.
    const importClause = /import\s*\{([\s\S]*?)\}\s*from\s+["']\.\.\/\.\.\/profile\//.exec(
      scanned.code,
    );
    expect(importClause?.[1], "expected a value import from profile/**").toBeDefined();
    const engineCallees = (importClause?.[1] ?? "")
      .split(",")
      .map((binding) => binding.trim().split(/\s+as\s+/).pop()?.trim() ?? "")
      .filter((name) => name !== "");
    expect(engineCallees.length).toBeGreaterThan(0);

    const unwrapLines = scanned.codeLines.filter((line) => line.includes("scope.customerId"));
    expect(unwrapLines.length).toBeGreaterThan(0);

    for (const line of unwrapLines) {
      expect(
        engineCallees.some((callee) => line.includes(callee)),
        `an unwrap in customerOwned.ts is not a delegation call, so scope.customerId ` +
          `is being used as a plain string somewhere it should not be:\n${line.trim()}`,
      ).toBe(true);
    }
  });

  it("permits no unwrap at all in any other file in the directory", () => {
    for (const name of repositorySourceFiles()) {
      if (["scopedQuery.ts", "shopifyScope.ts", "customerOwned.ts"].includes(name)) continue;
      const { code } = readRepositoryFile(name);
      expect(
        code.includes("scope.customerId"),
        `${name} unwraps the scope; a new file must route through the primitives ` +
          `rather than reach for the raw id`,
      ).toBe(false);
    }
  });
});

/* ========================================================================== *
 * 6 — no signature accepts a bare customer id
 * ========================================================================== */

describe("no repository signature accepts a bare customer id (Requirement 2.1)", () => {
  it("declares no `customerId: string` parameter or field", () => {
    for (const name of repositorySourceFiles()) {
      const { code } = readRepositoryFile(name);
      // `CustomerScope` itself declares `customerId: string`, but it lives in
      // src/auth and is not in this directory, so a hit here is always a new
      // signature taking the raw id.
      const matches = code.match(/customerId\s*(\?)?\s*:\s*string/g) ?? [];
      expect(
        matches,
        `${name} declares a bare customerId: string, which is the exact ` +
          `interchangeable-with-any-string shape CustomerScope replaced`,
      ).toEqual([]);
    }
  });
});

/* ========================================================================== *
 * 7 — the layer that holds SQL and parameters logs nothing
 * ========================================================================== */

describe("the repository layer emits no logs (design §24.3)", () => {
  it("contains no logger or console call", () => {
    const forbidden = [/\bconsole\s*\./, /\breq\s*\.\s*log\b/, /\blogger\s*\./, /\.\s*log\s*\./];
    for (const name of repositorySourceFiles()) {
      const { code } = readRepositoryFile(name);
      for (const pattern of forbidden) {
        expect(
          pattern.test(code),
          `${name} logs. This layer holds SQL text and bound parameters — a ` +
            `customer id and a resource id among them — which §24.3 forbids ` +
            `logging outright. Diagnostics belong at the route boundary, where ` +
            `the allowlist serialiser reduces a failure to errorCode.`,
        ).toBe(false);
      }
    }
  });
});

/* ========================================================================== *
 * 8 — every GraphQL document belongs to exactly one security class
 * ========================================================================== */

/**
 * THE TWO SECURITY CLASSES, AND WHY MEMBERSHIP IS DECLARED PER FILE.
 *
 * Most documents here are customer-rooted and must satisfy
 * `assertScopedCustomerQuery`. The N4 catalogue read (task 8.4) cannot be —
 * products are global data with no customer to scope to — so it satisfies
 * `assertGlobalCatalogueQuery`, which proves the inverse property: the query
 * cannot reach customer-owned data.
 *
 * MEMBERSHIP IS BY FILENAME, NEVER BY CONTENT. If the class were inferred from
 * what a document contains, deleting a `customer(id:)` traversal would silently
 * move that document to the weaker gate — an edit that REMOVES a safety property
 * would also remove the check for it. Declaring the class per file means a
 * customer read cannot become a catalogue read by being edited; it can only be
 * moved deliberately, in a diff a reviewer sees.
 */
const GLOBAL_CATALOGUE_FILES: readonly string[] = ["catalog.ts"];

describe("every GraphQL document belongs to exactly one security class", () => {
  it("validates each document with the guard for its declared class", () => {
    for (const name of repositorySourceFiles()) {
      const isCatalogue = GLOBAL_CATALOGUE_FILES.includes(name);
      for (const document of graphqlLiterals(readRepositoryFile(name))) {
        if (isCatalogue) {
          expect(
            () => assertGlobalCatalogueQuery(document),
            `${name} is declared a GLOBAL CATALOGUE file but contains a document that could reach customer-owned data`,
          ).not.toThrow();
        } else {
          expect(
            () => assertScopedCustomerQuery(document),
            `${name} contains a document that does not traverse from customer(id:)`,
          ).not.toThrow();
        }
      }
    }
  });

  it("holds the two classes apart: neither guard accepts the other's documents", () => {
    // If either guard accepted both kinds, having two would be theatre.
    for (const name of repositorySourceFiles()) {
      const isCatalogue = GLOBAL_CATALOGUE_FILES.includes(name);
      for (const document of graphqlLiterals(readRepositoryFile(name))) {
        if (isCatalogue) {
          expect(
            () => assertScopedCustomerQuery(document),
            `${name}'s catalogue document also satisfies the SCOPED guard, so the two classes are not distinct`,
          ).toThrow();
        } else {
          expect(
            () => assertGlobalCatalogueQuery(document),
            `${name}'s customer document also satisfies the CATALOGUE guard, so that guard is not proving "no customer data reachable"`,
          ).toThrow();
        }
      }
    }
  });

  it("refuses a customer, order or private traversal smuggled into a catalogue query", () => {
    // The negative cases a future author would actually write. Each must be
    // refused BEFORE any request is made.
    const smuggled: readonly (readonly [string, string])[] = [
      ["a Customer inline fragment", 'query q($ids: [ID!]!) { nodes(ids: $ids) { ... on Customer { id } } }'],
      ["an Order inline fragment", 'query q($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id } } }'],
      ["a DraftOrder inline fragment", 'query q($ids: [ID!]!) { nodes(ids: $ids) { ... on DraftOrder { id } } }'],
      [
        "a customer root field beside the catalogue read",
        'query q($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id } } customer(id: "x") { id } }',
      ],
      [
        "an orders connection nested under a product",
        'query q($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id orders(first: 1) { nodes { id } } } } }',
      ],
      ["an email selection", 'query q($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id email } } }'],
      [
        "a shippingAddress selection",
        'query q($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id shippingAddress { city } } } }',
      ],
      ["a customers( listing", 'query q($ids: [ID!]!) { customers(first: 10) { nodes { id } } }'],
      ["a mutation in catalogue clothing", 'mutation m($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id } } }'],
      ["an interpolated document", 'query q($ids: [ID!]!) { nodes(ids: ${x}) { ... on Product { id } } }'],
      ["a non-catalogue root", 'query q($ids: [ID!]!) { shop { name } }'],
    ];
    for (const [why, document] of smuggled) {
      expect(() => assertGlobalCatalogueQuery(document), why).toThrow();
    }
  });

  it("would catch a by-order-id document if one were added to a scoped file", () => {
    expect(() =>
      assertScopedCustomerQuery(`query portalOrderDetail($id: ID!) {
        order(id: $id) { id name totalPriceSet { shopMoney { amount } } }
      }`),
    ).toThrow(/forbidden_root_field|missing_customer_variable_declaration/);
  });
});

/* ========================================================================== *
 * The gate's own failure behaviour
 * ========================================================================== */

describe("the gate fails on the statements it is meant to fail on", () => {
  it("rejects the post-hoc-filter pattern this layer exists to abolish", () => {
    // `SELECT … WHERE id = $1` is the real shape from
    // `redemption/generateDiscountCode.ts` — correct for an internal worker that
    // has no caller, and exactly what must never appear on a portal path, where
    // ownership would then rest on a comparison in a handler.
    expect(() =>
      validateScopedStatement(`SELECT r.id, r.customer_id, r.status
                                 FROM redemptions r
                                WHERE r.id = $1
                                LIMIT 1`),
    ).toThrow(UnscopedStatementError);
  });

  it("rejects a statement that filters on the resource but not the customer", () => {
    expect(() =>
      validateScopedStatement("DELETE FROM customer_wishlist WHERE shopify_product_id = $1"),
    ).toThrow(UnscopedStatementError);
  });
});
