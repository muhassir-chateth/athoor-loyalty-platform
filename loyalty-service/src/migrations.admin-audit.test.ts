/**
 * Schema verification for the admin audit-log migration (task 17.1, Req 10.9).
 *
 * No live/production database is touched. As with the other migration tests,
 * the migration's `up`/`down` run against a capturing MigrationBuilder stub and
 * we assert the emitted DDL creates the immutable `admin_audit_log` table with
 * the columns Requirement 10.9 demands (acting admin id, operation type,
 * affected customer, timestamp) plus its indexes. Applying against a real
 * Postgres is deferred to deploy time via `npm run migrate:up`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

interface CapturedBuilder {
  statements: string[];
  sql(s: string): void;
}

function makeBuilder(): CapturedBuilder {
  const statements: string[] = [];
  return {
    statements,
    sql(s: string) {
      statements.push(s);
    },
  };
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

type MigrationModule = {
  up: (pgm: unknown) => Promise<void>;
  down: (pgm: unknown) => Promise<void>;
  shorthands: unknown;
};

let mod: MigrationModule;
let upSql: string;
let downSql: string;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "migrations");
  const file = readdirSync(migrationsDir).find((f) => /create-admin-audit-log\.ts$/.test(f));
  expect(file, "admin-audit-log migration file should exist").toBeTruthy();

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  const upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upSql = normalize(upBuilder.statements.join("\n"));

  const downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downSql = normalize(downBuilder.statements.join("\n"));
});

describe("admin_audit_log migration", () => {
  it("exports up, down, and shorthands", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect("shorthands" in mod).toBe(true);
  });

  it("creates the admin_audit_log table", () => {
    expect(upSql).toContain("CREATE TABLE admin_audit_log (");
  });

  it("captures the acting admin id (NOT NULL, Req 10.9)", () => {
    expect(upSql).toContain("admin_user_id TEXT NOT NULL");
  });

  it("captures the operation type constrained to the four operations", () => {
    expect(upSql).toContain("operation_type TEXT NOT NULL");
    expect(upSql).toContain(
      "CHECK (operation_type IN ('adjustment', 'manual_credit', 'migration', 'reconciliation'))",
    );
  });

  it("captures the affected customer (nullable for system-wide ops)", () => {
    expect(upSql).toContain("affected_customer_id UUID REFERENCES customers(id)");
  });

  it("links to the produced ledger row", () => {
    expect(upSql).toContain("ledger_entry_id UUID REFERENCES ledger_entries(id)");
  });

  it("captures the timestamp defaulting to now()", () => {
    expect(upSql).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT now()");
  });

  it("carries a JSONB detail column", () => {
    expect(upSql).toContain("detail JSONB NOT NULL DEFAULT '{}'");
  });

  it("indexes by customer and by operation type", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_admin_audit_customer ON admin_audit_log(affected_customer_id, created_at DESC)",
    );
    expect(upSql).toContain(
      "CREATE INDEX idx_admin_audit_operation ON admin_audit_log(operation_type, created_at DESC)",
    );
  });

  it("drops the table on down", () => {
    expect(downSql).toContain("DROP TABLE IF EXISTS admin_audit_log");
  });
});
