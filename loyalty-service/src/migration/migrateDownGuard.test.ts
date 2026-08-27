/**
 * Tests for the `migrate:down` row-count precondition (task 6.5, Requirements
 * 22.3, 23.5).
 *
 * NO DATABASE IS TOUCHED, and none is needed. Every count comes from an injected
 * fake probe, which is why the decision logic lives in a module that takes one:
 * CI has no Postgres service, the existing `src/migrations.*.test.ts` files
 * verify migrations without a live database, and a guard whose tests required a
 * real connection could not be tested at all here.
 *
 * The four groups mirror the four things that have to be true:
 *   1. it permits ONLY when every table is proven empty;
 *   2. it refuses on every unprovable path — fail closed;
 *   3. the refusal states the flag flip and the second-birthday-grant
 *      consequence, because that is what the requirement asks the message to do;
 *   4. no connection string can reach the output, whichever error shape arrives.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PORTAL_MIGRATIONS,
  buildRefusalMessage,
  classifyCountFailure,
  evaluateMigrateDownGuard,
  isSafeTableIdentifier,
  portalTablesInOrder,
  type RowCountProbe,
  type TableFinding,
} from "./migrateDownGuard.js";

/**
 * A DATABASE_URL-shaped value used ONLY to prove it cannot reach the output.
 *
 * SYNTHETIC. The host is in the reserved `.invalid` TLD (RFC 2606) so it can
 * never resolve, and the password is literally the words "not a real password".
 * Nothing here is a credential; it exists so the leak assertions have something
 * recognisable to search for.
 */
const FAKE_DATABASE_URL =
  "postgres://guard_test_user:not-a-real-password@db.example.invalid:5432/guard_test";

/** The distinctive fragments a leak would show up as. */
const LEAK_MARKERS = [FAKE_DATABASE_URL, "not-a-real-password", "db.example.invalid"];

const ALL_TABLES = portalTablesInOrder().map((t) => t.table);

/** A probe that returns the same count for every table. */
function constantProbe(count: number): RowCountProbe {
  return async () => count;
}

/** A probe that returns 0 for everything except the named table. */
function probeWith(counts: Readonly<Record<string, number>>): RowCountProbe {
  return async (table) => counts[table] ?? 0;
}

/** A probe that always rejects with the given value. */
function throwingProbe(error: unknown): RowCountProbe {
  return async () => {
    throw error;
  };
}

/** A Postgres-shaped error: `pg` sets `code` to the SQLSTATE. */
function pgError(code: string, message = "database says no"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function findingFor(findings: readonly TableFinding[], table: string): TableFinding {
  const found = findings.find((f) => f.table === table);
  expect(found, `expected a finding for ${table}`).toBeDefined();
  return found as TableFinding;
}

describe("scope — the five portal migrations and their six tables", () => {
  it("covers exactly the migrations of tasks 6.1–6.4 and 9.1", () => {
    expect(PORTAL_MIGRATIONS.map((m) => m.filename)).toEqual([
      "1786000000000_create-customer-birthdays.ts",
      "1786100000000_create-fragrance-preferences.ts",
      "1786200000000_create-communication-preferences.ts",
      "1786300000000_create-erasure-requests.ts",
      // Task 9.1's explicit-removal tombstone. In scope because `node-pg-migrate
      // down` reverses in TIMESTAMP order and knows nothing about task numbering:
      // reaching an older migration passes through this one first.
      "1786500000000_create-wishlist-removals.ts",
    ]);
  });

  it("covers exactly the six tables those migrations create", () => {
    expect(ALL_TABLES).toEqual([
      "customer_birthdays",
      "birthday_grants",
      "customer_fragrance_preferences",
      "customer_communication_preferences",
      "customer_erasure_requests",
      "customer_wishlist_removals",
    ]);
  });

  it("names no pre-existing or ledger table", () => {
    for (const forbidden of [
      "ledger_entries",
      "point_lots",
      "redemptions",
      "discount_codes",
      "referrals",
      "customers",
    ]) {
      expect(ALL_TABLES).not.toContain(forbidden);
    }
  });
});

describe("permits only when every table is proven empty", () => {
  it("permits when every count is zero", async () => {
    const result = await evaluateMigrateDownGuard({ probe: constantProbe(0) });
    expect(result.decision).toBe("permit");
    expect(result.findings).toHaveLength(6);
    expect(result.findings.every((f) => f.status === "empty")).toBe(true);
  });

  it("queries every table, once each", async () => {
    const asked: string[] = [];
    const result = await evaluateMigrateDownGuard({
      probe: async (table) => {
        asked.push(table);
        return 0;
      },
    });
    expect(result.decision).toBe("permit");
    expect(asked).toEqual(ALL_TABLES);
  });

  it("still tells the operator the flag flip was sufficient", async () => {
    const result = await evaluateMigrateDownGuard({ probe: constantProbe(0) });
    expect(result.message).toContain("Portal_Feature_Flag");
    expect(result.message).toContain("Requirement 22.3");
  });
});

describe("refuses when any table holds rows", () => {
  for (const table of ALL_TABLES) {
    it(`refuses when ${table} is not empty`, async () => {
      const result = await evaluateMigrateDownGuard({ probe: probeWith({ [table]: 1 }) });
      expect(result.decision).toBe("refuse");
      const finding = findingFor(result.findings, table);
      expect(finding.status).toBe("occupied");
      expect(result.message).toContain(table);
    });
  }

  it("reports the actual row count so the operator knows the scale", async () => {
    const result = await evaluateMigrateDownGuard({
      probe: probeWith({ birthday_grants: 4271 }),
    });
    expect(result.decision).toBe("refuse");
    expect(result.message).toContain("4271");
  });

  it("refuses when only one table is occupied", async () => {
    const result = await evaluateMigrateDownGuard({
      probe: probeWith({ customer_erasure_requests: 1 }),
    });
    expect(result.decision).toBe("refuse");
    expect(result.findings.filter((f) => f.status === "empty")).toHaveLength(5);
  });

  it("refuses when the wishlist tombstone holds rows, and names the consequence", async () => {
    // Specific and worth asserting: dropping this table resurrects products the
    // customer explicitly deleted, because the device list is never cleared.
    const result = await evaluateMigrateDownGuard({
      probe: probeWith({ customer_wishlist_removals: 3 }),
    });
    expect(result.decision).toBe("refuse");
    expect(result.message).toContain("RESURRECT");
    expect(result.message).toContain("customer_wishlist_removals");
  });
});

describe("fails closed — every unprovable path refuses", () => {
  it("refuses when no database is configured at all", async () => {
    const result = await evaluateMigrateDownGuard({ probe: null });
    expect(result.decision).toBe("refuse");
    expect(result.findings.every((f) => f.status === "unknown")).toBe(true);
    expect(result.message).toContain("DATABASE_URL is not set");
  });

  it("refuses when the connection is refused", async () => {
    const result = await evaluateMigrateDownGuard({
      probe: throwingProbe(pgError("ECONNREFUSED")),
    });
    expect(result.decision).toBe("refuse");
    expect(result.message).toContain("connection_unavailable");
  });

  it("refuses when authentication fails", async () => {
    const result = await evaluateMigrateDownGuard({ probe: throwingProbe(pgError("28P01")) });
    expect(result.decision).toBe("refuse");
  });

  it("refuses when the role may not read the table", async () => {
    const result = await evaluateMigrateDownGuard({ probe: throwingProbe(pgError("42501")) });
    expect(result.decision).toBe("refuse");
    expect(result.message).toContain("permission_denied");
  });

  it("refuses when a table does not exist, and says absence is not proof", async () => {
    const result = await evaluateMigrateDownGuard({ probe: throwingProbe(pgError("42P01")) });
    expect(result.decision).toBe("refuse");
    expect(result.message).toContain("table_absent");
    // The decision that a missing table means "cannot tell", not "nothing to lose".
    expect(result.message).toContain("NOT proof");
    expect(result.message).toContain("migrations were never applied");
  });

  it("refuses on an error shape it does not recognise", async () => {
    const result = await evaluateMigrateDownGuard({ probe: throwingProbe("just a string") });
    expect(result.decision).toBe("refuse");
    expect(result.message).toContain("unclassified_failure");
  });

  it("does not read an unparseable count as zero", async () => {
    const result = await evaluateMigrateDownGuard({ probe: constantProbe(Number.NaN) });
    expect(result.decision).toBe("refuse");
    expect(result.message).toContain("count_unreadable");
  });

  it("does not trust a non-numeric count", async () => {
    const result = await evaluateMigrateDownGuard({
      probe: (async () => "0") as unknown as RowCountProbe,
    });
    expect(result.decision).toBe("refuse");
  });

  it("does not trust a negative or fractional count", async () => {
    for (const bad of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      const result = await evaluateMigrateDownGuard({ probe: constantProbe(bad) });
      expect(result.decision, `count ${bad} should not be trusted`).toBe("refuse");
    }
  });

  it("refuses rather than throwing when the table list is mis-edited", async () => {
    const result = await evaluateMigrateDownGuard({
      probe: constantProbe(0),
      migrations: [
        { version: "1", filename: "bad.ts", tables: ['x"; DROP TABLE customers; --'] },
      ],
    });
    expect(result.decision).toBe("refuse");
  });
});

describe("the refusal message says what Requirements 22.3 and 23.5 require", () => {
  /** Every refusal shape, so the mandated content is asserted on all of them. */
  const refusals: readonly { readonly label: string; readonly probe: RowCountProbe | null }[] = [
    { label: "occupied table", probe: probeWith({ birthday_grants: 12 }) },
    { label: "no database configured", probe: null },
    { label: "connection refused", probe: throwingProbe(pgError("ECONNREFUSED")) },
    { label: "table absent", probe: throwingProbe(pgError("42P01")) },
    { label: "unrecognised error", probe: throwingProbe(new Error("who knows")) },
  ];

  for (const { label, probe } of refusals) {
    describe(label, () => {
      it("states that rolling back the feature is a flag flip, not a migration", async () => {
        const { message, decision } = await evaluateMigrateDownGuard({ probe });
        expect(decision).toBe("refuse");
        expect(message).toContain("FEATURE-FLAG FLIP, NOT A MIGRATION");
        expect(message).toContain("Portal_Feature_Flag");
        expect(message).toContain("no further deployment");
        expect(message).toContain("Requirement 22.3");
      });

      it("warns that rolling back migration 1 permits a second grant in the same year", async () => {
        const { message } = await evaluateMigrateDownGuard({ probe });
        expect(message).toContain("SECOND BIRTHDAY GRANT IN THE SAME YEAR");
        expect(message).toContain("birthday_grants");
        expect(message).toContain("1786000000000_create-customer-birthdays.ts");
        expect(message).toContain("PRIMARY KEY (customer_id, grant_year)");
      });

      it("warns that rolling back migration 4 destroys deletion-request evidence", async () => {
        const { message } = await evaluateMigrateDownGuard({ probe });
        expect(message).toContain("customer_erasure_requests");
        expect(message).toContain("Requirement 23.5");
      });
    });
  }

  it("puts the flag flip and the second-grant warning before the row counts", async () => {
    const { message } = await evaluateMigrateDownGuard({
      probe: probeWith({ birthday_grants: 3 }),
    });
    const flagFlip = message.indexOf("FEATURE-FLAG FLIP");
    const secondGrant = message.indexOf("SECOND BIRTHDAY GRANT");
    const counts = message.indexOf("WHAT THIS GUARD FOUND");
    expect(flagFlip).toBeGreaterThan(-1);
    expect(secondGrant).toBeGreaterThan(flagFlip);
    expect(counts).toBeGreaterThan(secondGrant);
  });

  it("is honest that it is a stop-and-think and not a security boundary", async () => {
    const { message } = await evaluateMigrateDownGuard({ probe: constantProbe(1) });
    expect(message).toContain("not a security");
    expect(message).toContain("node-pg-migrate");
  });
});

describe("no connection string can reach the output", () => {
  /**
   * The four properties on which a driver error carries a connection string.
   * `pg` puts host and port in `message`; Node's `ERR_INVALID_URL` puts the whole
   * URL on `input`; `stack` embeds `message`; and `cause` can carry another
   * error. All four are present here at once.
   */
  function leakyError(code: string): Error {
    const error = new Error(`connect ECONNREFUSED for ${FAKE_DATABASE_URL}`);
    return Object.assign(error, {
      code,
      input: FAKE_DATABASE_URL,
      connectionString: FAKE_DATABASE_URL,
      cause: new Error(`inner: ${FAKE_DATABASE_URL}`),
      stack: `Error: ${FAKE_DATABASE_URL}\n    at Client.connect`,
    });
  }

  for (const code of ["ECONNREFUSED", "ERR_INVALID_URL", "42P01", "28P01", "NOT_A_KNOWN_CODE"]) {
    it(`leaks nothing when the failure carries the URL and code is ${code}`, async () => {
      const result = await evaluateMigrateDownGuard({ probe: throwingProbe(leakyError(code)) });
      expect(result.decision).toBe("refuse");
      for (const marker of LEAK_MARKERS) {
        expect(result.message).not.toContain(marker);
      }
      // Nor via the structured findings, which a caller might print itself.
      expect(JSON.stringify(result.findings)).not.toContain("db.example.invalid");
    });
  }

  it("leaks nothing when the connection string is itself the error code", async () => {
    const result = await evaluateMigrateDownGuard({
      probe: throwingProbe(Object.assign(new Error("x"), { code: FAKE_DATABASE_URL })),
    });
    expect(result.decision).toBe("refuse");
    for (const marker of LEAK_MARKERS) {
      expect(result.message).not.toContain(marker);
    }
  });

  it("classifies an unrecognised code without echoing it", () => {
    expect(classifyCountFailure({ code: FAKE_DATABASE_URL })).toBe("unclassified_failure");
    expect(classifyCountFailure(leakyError("NOT_A_KNOWN_CODE"))).toBe("unclassified_failure");
  });

  it("never matches an inherited Object.prototype key as an error code", () => {
    for (const code of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(classifyCountFailure({ code })).toBe("unclassified_failure");
    }
  });

  it("maps only the codes it knows", () => {
    expect(classifyCountFailure(pgError("42P01"))).toBe("table_absent");
    expect(classifyCountFailure(pgError("42501"))).toBe("permission_denied");
    expect(classifyCountFailure(pgError("ECONNREFUSED"))).toBe("connection_unavailable");
    expect(classifyCountFailure(pgError("ERR_INVALID_URL"))).toBe("database_url_unusable");
    expect(classifyCountFailure(undefined)).toBe("unclassified_failure");
    expect(classifyCountFailure(null)).toBe("unclassified_failure");
    expect(classifyCountFailure(new Error("no code at all"))).toBe("unclassified_failure");
  });

  it("renders a refusal from findings alone without any error material", () => {
    const message = buildRefusalMessage([
      {
        table: "customer_birthdays",
        migrationFilename: "1786000000000_create-customer-birthdays.ts",
        status: "unknown",
        reason: "unclassified_failure",
      },
    ]);
    for (const marker of LEAK_MARKERS) {
      expect(message).not.toContain(marker);
    }
  });
});

describe("identifier safety for the one interpolated SQL fragment", () => {
  it("accepts the five portal tables", () => {
    for (const table of ALL_TABLES) {
      expect(isSafeTableIdentifier(table)).toBe(true);
    }
  });

  it("rejects anything that could change the statement", () => {
    for (const bad of [
      'customers"; DROP TABLE customers; --',
      "customer_birthdays; DELETE FROM customers",
      "customer birthdays",
      "Customer_Birthdays",
      "1_leading_digit",
      "",
      "public.customer_birthdays",
      "'quoted'",
      "a".repeat(64),
    ]) {
      expect(isSafeTableIdentifier(bad), `${bad} should be rejected`).toBe(false);
    }
  });
});

describe("the operator CLI keeps the leak-proofing decisions", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, "..", "..", "scripts", "migration", "migrate-down-guard.mjs");
  const source = readFileSync(cliPath, "utf8");

  /**
   * Comments stripped before scanning, because the CLI's header NAMES the things
   * it refuses to do ("does not use runMain", "would print err.stack") and a scan
   * of the raw file would read that documentation as the defect it warns about.
   * The assertions below are about executable code.
   *
   * `[^:]` before `//` so a `scheme://` in a string is not mistaken for a comment.
   */
  const cli = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("never prints an error object or its message, stack or input", () => {
    // The exact leak _shared.mjs's runMain would introduce.
    expect(cli).not.toMatch(/console\.(error|log)\(\s*err/);
    expect(cli).not.toContain("err.message");
    expect(cli).not.toContain("err.stack");
    expect(cli).not.toContain("error.message");
    expect(cli).not.toContain(".input");
  });

  it("does not use runMain, whose redact does not mask a connection string", () => {
    expect(cli).not.toContain("runMain");
  });

  it("never prints DATABASE_URL and reads it only from the environment", () => {
    expect(cli).toContain("process.env.DATABASE_URL");
    expect(cli).not.toMatch(/console\.(error|log)\([^)]*databaseUrl/);
  });

  it("replaces Node's default uncaught-error printer, which dumps error properties", () => {
    expect(cli).toContain('process.on("uncaughtException"');
    expect(cli).toContain('process.on("unhandledRejection"');
  });

  it("issues only SELECT count(*)", () => {
    expect(cli).toContain("SELECT count(*)");
    for (const forbidden of ["DROP ", "DELETE ", "UPDATE ", "INSERT ", "ALTER ", "TRUNCATE "]) {
      expect(cli).not.toContain(forbidden);
    }
  });
});

describe("the npm hook runs the guard before node-pg-migrate down", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    readFileSync(join(here, "..", "..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  it("gates migrate:down on the guard, with the guard first", () => {
    const script = pkg.scripts["migrate:down"] ?? "";
    expect(script).toContain("scripts/migration/migrate-down-guard.mjs");
    expect(script).toContain("node-pg-migrate down");
    expect(script.indexOf("migrate-down-guard.mjs")).toBeLessThan(
      script.indexOf("node-pg-migrate down"),
    );
    // `&&`, not `;` — a refusal must stop the chain.
    expect(script).toContain("&&");
    expect(script).not.toContain(";");
  });

  it("builds first, so a stale dist cannot guard with an old table list", () => {
    expect(pkg.scripts["migrate:down"] ?? "").toContain("npm run build");
  });

  it("offers the guard standalone as a dry check that runs no migration", () => {
    const check = pkg.scripts["migrate:down:check"] ?? "";
    expect(check).toContain("scripts/migration/migrate-down-guard.mjs");
    expect(check).not.toContain("node-pg-migrate");
  });

  it("leaves migrate:up semantics untouched", () => {
    expect(pkg.scripts["migrate:up"]).toBe("node-pg-migrate up");
    expect(pkg.scripts["migrate"]).toBe("node-pg-migrate");
  });
});
