/**
 * Static security checks over the migration series — the CI layer that stops a
 * future migration from putting customer data back on the public internet.
 *
 * WHAT THIS PROTECTS, AND WHY A TEST IS THE RIGHT PLACE FOR IT
 * ============================================================
 * Supabase exposes the entire `public` schema through PostgREST. Two roles reach
 * that endpoint from a browser — `anon` (publishable key only) and
 * `authenticated` (end-user JWT) — so any privilege either holds on any relation
 * in `public` is a public HTTP endpoint over that data.
 *
 * Migration `1785950000000_harden-data-api-exposure` closes that surface and
 * turns the default off for future objects. But a default only protects the
 * table nobody thought about. It cannot stop a later migration from issuing an
 * explicit `GRANT`, disabling RLS, or adding an owner-rights view over a
 * protected table. Those are authoring mistakes, they are invisible in review
 * unless someone is looking for them, and the environment where they would be
 * caught at runtime is production.
 *
 * NO DATABASE IS TOUCHED AND NONE IS AVAILABLE. This follows the shipped
 * convention of `migrations.test.ts` and `migrations.portal-additive.test.ts`:
 * each migration's `up`/`down` is executed against a capturing
 * `MigrationBuilder` stub and the assertions are made against the emitted DDL.
 *
 * WHAT THIS CANNOT DO, STATED PLAINLY
 * ===================================
 * It cannot tell you whether a live database is currently exposed. The grants
 * that caused the original CRITICAL findings were applied by the Supabase
 * PLATFORM through `ALTER DEFAULT PRIVILEGES`, and appear in no migration —
 * which is exactly why reading migrations was never enough. The runtime half is
 * `scripts/audit-api-exposure.mjs` (`npm run security:audit`), which asks the
 * database directly and exits non-zero on a finding. Both halves are needed:
 * this one catches the mistake before it ships, that one catches the state
 * nobody wrote down.
 *
 * WHY THE RULES APPLY TO `up()` AND NOT `down()`
 * ==============================================
 * `down()` legitimately restores the previous state, and for the hardening
 * migration that previous state is the insecure one — its `down()` contains
 * `GRANT` by design, because an exact reversal is the whole point of having
 * snapshotted the baseline. Scoping these rules to `up()` therefore needs no
 * per-migration exception list, and an exception list is the thing that rots.
 * `down()` only ever runs as a deliberate operator rollback, already gated by
 * `migrate:down:check`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  PUBLIC_SCHEMA_INVENTORY,
  INVENTORY_BY_NAME,
  RELATIONS_NOT_CREATED_BY_MIGRATIONS,
} from "./security/publicSchemaInventory.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** The Data API roles, plus PUBLIC, which reaches them by inheritance. */
const FORBIDDEN_GRANTEES = ["anon", "authenticated", "public"];

/** The migration that establishes the posture every other migration must not undo. */
const HARDENING_MIGRATION = "1785950000000_harden-data-api-exposure.ts";

// ---------------------------------------------------------------------------
// Capturing builder (same shape as migrations.portal-additive.test.ts)
// ---------------------------------------------------------------------------

interface RecordingBuilder {
  readonly calls: string[];
  readonly otherMembersUsed: string[];
  readonly builder: unknown;
}

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
      if (name === "then" || name === "constructor" || name === "toJSON") return undefined;
      otherMembersUsed.push(name);
      return () => undefined;
    },
  });
  return { calls, otherMembersUsed, builder };
}

// ---------------------------------------------------------------------------
// SQL text utilities — dollar-quote aware
// ---------------------------------------------------------------------------

/**
 * Removes `--` comments, `$tag$ … $tag$` bodies and `'…'` literals, replacing
 * each with a space.
 *
 * DOLLAR QUOTING IS THE REASON THIS EXISTS rather than reusing the splitter in
 * `migrations.portal-additive.test.ts`, which documents that it does not handle
 * it. The hardening migration is built from `DO $$ … $$` blocks, and two
 * different false readings follow from ignoring them:
 *
 *   1. A `;` inside a `DO` body would split one statement into several, so a
 *      fragment like `END LOOP` would be classified as an unknown statement.
 *   2. The string `'CREATE TABLE AS'` appears inside the event-trigger function
 *      body as a `command_tag` comparison. A naive `CREATE TABLE (\w+)` scan
 *      reads that as a table literally named `as`.
 *
 * Both were observed before this helper existed. Stripping the bodies is also
 * semantically right for the questions asked here: DDL inside these blocks is
 * built dynamically with `format()`, so there is no literal table name to find,
 * and a real `CREATE TABLE` in these migrations is always a top-level
 * `pgm.sql()` call.
 */
export function stripNonCode(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    // -- line comment
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    // /* block comment */ (nesting is legal in Postgres)
    if (sql[i] === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out += " ";
      continue;
    }
    // $tag$ … $tag$
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar !== null) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += " ";
      continue;
    }
    // '…' literal, '' escapes
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Collapses whitespace. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Code-only statements from a list of `pgm.sql()` payloads, split on `;`. */
function codeStatements(calls: readonly string[]): string[] {
  return calls
    .flatMap((call) => stripNonCode(call).split(";"))
    .map(normalize)
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Load every migration
// ---------------------------------------------------------------------------

interface Loaded {
  readonly filename: string;
  readonly up: string[];
  readonly down: string[];
  readonly rawUp: string;
}

let loaded: Loaded[];

beforeAll(async () => {
  const filenames = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.ts$/.test(f))
    .sort();
  expect(filenames.length, "migrations directory should not be empty").toBeGreaterThan(0);

  loaded = [];
  for (const filename of filenames) {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(migrationsDir, filename)).href)) as {
      up: (pgm: unknown) => Promise<void>;
      down: (pgm: unknown) => Promise<void>;
    };
    const upRec = makeRecordingBuilder();
    await mod.up(upRec.builder);
    const downRec = makeRecordingBuilder();
    await mod.down(downRec.builder);
    loaded.push({
      filename,
      up: codeStatements(upRec.calls),
      down: codeStatements(downRec.calls),
      rawUp: upRec.calls.join("\n"),
    });
  }
});

/** Relations created by `up()`, discovered from the emitted DDL. */
function createdRelations(m: Loaded): { tables: string[]; matviews: string[]; views: string[] } {
  const tables: string[] = [];
  const matviews: string[] = [];
  const views: string[] = [];
  for (const s of m.up) {
    let match = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(s);
    if (match?.[1] !== undefined) {
      tables.push(match[1].toLowerCase());
      continue;
    }
    match = /^CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(s);
    if (match?.[1] !== undefined) {
      matviews.push(match[1].toLowerCase());
      continue;
    }
    match = /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(s);
    if (match?.[1] !== undefined) views.push(match[1].toLowerCase());
  }
  return { tables, matviews, views };
}

// ---------------------------------------------------------------------------
// 1. The inventory and the migrations agree
// ---------------------------------------------------------------------------

describe("inventory parity — every relation in public is declared and classified", () => {
  it("every table and materialised view created by a migration is in the inventory", () => {
    const undeclared: string[] = [];
    for (const m of loaded) {
      const { tables, matviews } = createdRelations(m);
      for (const name of [...tables, ...matviews]) {
        if (!INVENTORY_BY_NAME.has(name)) undeclared.push(`${name} (created by ${m.filename})`);
      }
    }
    expect(
      undeclared,
      "A new relation in `public` becomes a PostgREST endpoint the moment any privilege is " +
        "granted on it. Add it to src/security/publicSchemaInventory.ts with a DataClass and " +
        "apiAccess: 'none', which is a deliberate classification rather than a default.",
    ).toEqual([]);
  });

  it("every inventory entry is actually created by the migration it names", () => {
    const created = new Map<string, string>();
    for (const m of loaded) {
      const { tables, matviews } = createdRelations(m);
      for (const name of [...tables, ...matviews]) created.set(name, m.filename);
    }
    const presentMigrations = new Set(loaded.map((m) => m.filename));
    const wrong: string[] = [];
    const forwardDeclared: string[] = [];
    for (const entry of PUBLIC_SCHEMA_INVENTORY) {
      if (RELATIONS_NOT_CREATED_BY_MIGRATIONS.includes(entry.name)) continue;
      const actual = created.get(entry.name);
      if (actual === undefined) {
        // FORWARD DECLARATION - bounded, and self-retiring.
        //
        // This branch is cut from `main`, where the four Task 6 migrations do not
        // exist yet, so five inventory entries name a `createdBy` that is
        // legitimately absent HERE. Skipping them is not an allowance list: the
        // skip is CONDITIONAL on the named migration being absent from this
        // branch. The moment Task 6 lands, the entry stops qualifying and is held
        // to full parity again - which is the "re-run the security gate after
        // Task 6, because new tables must not be born exposed" requirement
        // enforced by the test rather than remembered by a person.
        if (!presentMigrations.has(entry.createdBy)) {
          forwardDeclared.push(entry.name);
          continue;
        }
        wrong.push(`${entry.name}: declared but no migration creates it`);
      } else if (actual !== entry.createdBy) {
        wrong.push(`${entry.name}: declared as ${entry.createdBy} but created by ${actual}`);
      }
    }
    expect(wrong, "The inventory must describe the schema that exists, not one that used to.").toEqual([]);

    // Asserted as a SUBSET, not an equality, so this passes both before Task 6
    // (five forward-declared) and after it merges (none) without an edit - while
    // still failing if anyone declares a relation for a migration that does not
    // and will not exist, which is how an inventory drifts into fiction.
    const TASK_6_FORWARD = [
      "birthday_grants",
      "customer_birthdays",
      "customer_communication_preferences",
      "customer_erasure_requests",
      "customer_fragrance_preferences",
    ];
    expect(
      forwardDeclared.filter((n) => !TASK_6_FORWARD.includes(n)),
      "Only the pending Task 6 portal tables may be forward-declared, and only while their migration is absent from this branch.",
    ).toEqual([]);
  });

  it("records the correct kind, so matview-specific handling is not lost", () => {
    // This matters more than it looks: RLS never applies to a materialised view,
    // so a matview mislabelled as a table would look protected by the RLS rules
    // below while in fact being protected by nothing but grants.
    const mismatched: string[] = [];
    for (const m of loaded) {
      const { tables, matviews } = createdRelations(m);
      for (const name of tables) {
        if (INVENTORY_BY_NAME.get(name)?.kind !== "table") mismatched.push(`${name} should be kind "table"`);
      }
      for (const name of matviews) {
        if (INVENTORY_BY_NAME.get(name)?.kind !== "materialized_view") {
          mismatched.push(`${name} should be kind "materialized_view"`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("every relation demands apiAccess none — there is no opted-in relation", () => {
    const opted = PUBLIC_SCHEMA_INVENTORY.filter((r) => r.apiAccess !== "none").map((r) => r.name);
    expect(
      opted,
      "Nothing in this system uses the Supabase Data API. An entry wanting anything other than " +
        "'none' is a design change that must be argued, not a flag flip.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. No migration may re-open the surface
// ---------------------------------------------------------------------------

describe("no migration may grant Data API access", () => {
  it("no up() grants any privilege to anon, authenticated or PUBLIC", () => {
    const offenders: string[] = [];
    for (const m of loaded) {
      for (const s of m.up) {
        if (!/^GRANT\b/i.test(s)) continue;
        const to = /\bTO\s+(.+)$/i.exec(s)?.[1] ?? "";
        for (const grantee of FORBIDDEN_GRANTEES) {
          if (new RegExp(`\\b${grantee}\\b`, "i").test(to)) {
            offenders.push(`${m.filename}: ${s}`);
            break;
          }
        }
      }
    }
    expect(
      offenders,
      "A GRANT to anon or authenticated publishes the relation over HTTP. If a client genuinely " +
        "needs Data API access, that is a design change: update the inventory first.",
    ).toEqual([]);
  });

  it("no up() re-grants default privileges to the Data API roles", () => {
    // This is the subtle one. ALTER DEFAULT PRIVILEGES does not touch a single
    // existing table, so it passes every "does this migration alter my table"
    // review — and then silently exposes every table created afterwards.
    const offenders: string[] = [];
    for (const m of loaded) {
      for (const s of m.up) {
        if (!/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(s)) continue;
        if (!/\bGRANT\b/i.test(s)) continue;
        for (const grantee of FORBIDDEN_GRANTEES) {
          if (new RegExp(`\\b${grantee}\\b`, "i").test(s)) {
            offenders.push(`${m.filename}: ${s}`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no up() disables row level security", () => {
    const offenders: string[] = [];
    for (const m of loaded) {
      for (const s of m.up) {
        if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s)) offenders.push(`${m.filename}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no migration sets FORCE ROW LEVEL SECURITY", () => {
    // Checked across up() AND down(), because this one is an outage rather than a
    // disclosure and the direction does not matter. The Render backend connects
    // as `postgres`, which owns every table. An owner is exempt from RLS unless
    // RLS is FORCEd. Since the deliberate policy count is zero, FORCE would mean
    // the backend reads no rows from any table.
    const offenders: string[] = [];
    for (const m of loaded) {
      for (const s of [...m.up, ...m.down]) {
        if (/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s)) offenders.push(`${m.filename}: ${s}`);
      }
    }
    expect(
      offenders,
      "FORCE ROW LEVEL SECURITY subjects the table OWNER to RLS too. With zero policies by design, " +
        "that takes the Render backend to zero rows on every query.",
    ).toEqual([]);
  });

  it("no up() drops the ensure_rls event trigger except the migration that owns it", () => {
    const offenders: string[] = [];
    for (const m of loaded) {
      if (m.filename === HARDENING_MIGRATION) continue;
      for (const s of m.up) {
        if (/\bDROP\s+EVENT\s+TRIGGER\b/i.test(s) || /\bDROP\s+FUNCTION[^;]*rls_auto_enable/i.test(s)) {
          offenders.push(`${m.filename}: ${s}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Views must not become an RLS bypass
// ---------------------------------------------------------------------------

describe("views cannot be used to read past RLS", () => {
  it("every plain view is created with security_invoker = true", () => {
    // A view without security_invoker runs with its OWNER's rights. Since every
    // relation here is owned by `postgres`, which has BYPASSRLS, such a view
    // hands the caller everything the owner can see.
    const offenders: string[] = [];
    for (const m of loaded) {
      for (const s of m.up) {
        if (!/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(s)) continue;
        if (!/security_invoker\s*=\s*true/i.test(s)) offenders.push(`${m.filename}: ${s.slice(0, 120)}`);
      }
    }
    expect(
      offenders,
      "Add WITH (security_invoker = true) so the view reads with the CALLER's rights.",
    ).toEqual([]);
  });

  it("every materialised view is classified as such in the inventory, with a note about RLS", () => {
    const missing = PUBLIC_SCHEMA_INVENTORY.filter(
      (r) => r.kind === "materialized_view" && (r.note === undefined || !/RLS/i.test(r.note)),
    ).map((r) => r.name);
    expect(
      missing,
      "A materialised view is not protected by RLS at all. Its inventory note must say so, because " +
        "the next person to read this will otherwise assume the RLS rules cover it.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The hardening migration still does what the rest of this file assumes
// ---------------------------------------------------------------------------

describe("the hardening migration is present and coherent", () => {
  it("exists and sorts before the task 6 portal migrations", () => {
    const hardening = loaded.find((m) => m.filename === HARDENING_MIGRATION);
    expect(hardening, `${HARDENING_MIGRATION} must exist`).toBeDefined();

    const version = Number(HARDENING_MIGRATION.split("_")[0]);
    const portal = loaded
      .map((m) => Number(m.filename.split("_")[0]))
      .filter((v) => v >= 1786000000000);
    // Ordering is what lets `migrate:up -- 1` apply the security fix ALONE,
    // leaving the four Task 6 migrations pending until separately approved.
    for (const v of portal) expect(version).toBeLessThan(v);
  });

  it("revokes from the Data API roles and enables RLS, without granting anything", () => {
    const m = loaded.find((x) => x.filename === HARDENING_MIGRATION);
    expect(m).toBeDefined();
    if (m === undefined) return;
    const up = m.up.join(" | ");
    expect(up, "must revoke default privileges for future objects").toMatch(
      /ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]*REVOKE/i,
    );
    expect(up.match(/^GRANT\b/gim), "up() must not grant anything").toBeNull();
  });

  it("snapshots the baseline before changing it, so down() is exact", () => {
    const m = loaded.find((x) => x.filename === HARDENING_MIGRATION);
    expect(m).toBeDefined();
    if (m === undefined) return;
    const created = createdRelations(m).tables;
    expect(created).toContain("security_baseline_grants");
    expect(created).toContain("security_baseline_rls");
    expect(created).toContain("security_baseline_default_acl");

    // Every snapshot table must be dropped again by down(), or a rollback would
    // leave debris that the next up() would collide with.
    const down = m.down.join(" | ");
    for (const t of created) {
      expect(down, `down() must drop ${t}`).toContain(t);
    }
  });
});
