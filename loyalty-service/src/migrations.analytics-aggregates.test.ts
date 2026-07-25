/**
 * Schema verification for the analytics-aggregates migration (task 17.x).
 *
 * No live/production database is touched. Because no local Postgres/Docker is
 * available in this environment, we verify the migration by executing its
 * `up`/`down` against a capturing MigrationBuilder stub and asserting the
 * emitted DDL matches design.md "Component 7: Analytics / Reporting" and
 * Requirement 20.3 / A12: hourly-refreshed materialized views projecting the
 * ledger + enrolment + redemption columns that ACTUALLY exist, each with a
 * unique index enabling concurrent refresh, plus a populate (`REFRESH`) path and
 * a clean `DROP` teardown.
 *
 * Applying the migration against a real Postgres is deferred to deploy time via
 * `npm run migrate:up`.
 *
 * Requirements: 20.3 (metrics derive from ledger + Shopify order data via cached
 * aggregates / materialized views), 20.6 (computedAt = refresh instant), A12
 * (aggregates refreshed at least hourly).
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
let upStatements: string[];
let downStatements: string[];
let upSql: string;
let downSql: string;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "migrations");
  const file = readdirSync(migrationsDir).find((f) =>
    /create-analytics-aggregates\.ts$/.test(f),
  );
  expect(file, "analytics-aggregates migration file should exist").toBeTruthy();
  // The unique timestamp prefix requested for this migration.
  expect(file).toMatch(/^1785300000000_/);

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  const upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upStatements = upBuilder.statements.map(normalize);
  upSql = upStatements.join("\n");

  const downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downStatements = downBuilder.statements.map(normalize);
  downSql = downStatements.join("\n");
});

describe("analytics-aggregates migration module", () => {
  it("exports up, down, and shorthands", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect("shorthands" in mod).toBe(true);
  });

  it("emits DDL on up and down", () => {
    expect(upStatements.length).toBeGreaterThan(0);
    expect(downStatements.length).toBeGreaterThan(0);
  });
});

describe("materialized views (Req 20.3 / A12)", () => {
  it("creates a materialized view for each analytics source segment", () => {
    expect(upSql).toContain("CREATE MATERIALIZED VIEW analytics_customers");
    expect(upSql).toContain("CREATE MATERIALIZED VIEW analytics_ledger");
    expect(upSql).toContain("CREATE MATERIALIZED VIEW analytics_redemptions");
  });

  it("projects only columns that exist in the ledger-core schema", () => {
    // customers: id + enrolled_at
    expect(upSql).toMatch(/analytics_customers[\s\S]*FROM customers/);
    expect(upSql).toContain("enrolled_at");
    // ledger: customer_id, entry_type, points, created_at
    expect(upSql).toMatch(/analytics_ledger[\s\S]*FROM ledger_entries/);
    expect(upSql).toContain("entry_type");
    // redemptions: customer_id, reward_id, created_at
    expect(upSql).toMatch(/analytics_redemptions[\s\S]*FROM redemptions/);
    expect(upSql).toContain("reward_id");
  });

  it("adds a UNIQUE index to each matview so it can be refreshed CONCURRENTLY", () => {
    expect(upSql).toContain("CREATE UNIQUE INDEX analytics_customers_pk");
    expect(upSql).toContain("CREATE UNIQUE INDEX analytics_ledger_pk");
    expect(upSql).toContain("CREATE UNIQUE INDEX analytics_redemptions_pk");
  });

  it("emits a REFRESH statement to populate the views", () => {
    // Created WITH NO DATA, then populated with a (non-concurrent) REFRESH —
    // a concurrent refresh cannot run inside the migration's transaction.
    expect(upSql).toContain("WITH NO DATA");
    expect(upSql).toContain("REFRESH MATERIALIZED VIEW analytics_customers");
    expect(upSql).toContain("REFRESH MATERIALIZED VIEW analytics_ledger");
    expect(upSql).toContain("REFRESH MATERIALIZED VIEW analytics_redemptions");
    // The populate REFRESH is non-concurrent (safe inside the migration txn).
    expect(upSql).not.toContain("REFRESH MATERIALIZED VIEW CONCURRENTLY");
  });
});

describe("refresh-state table (Req 20.6 — computedAt)", () => {
  it("creates a single-row refresh-state table and seeds it", () => {
    expect(upSql).toContain("CREATE TABLE analytics_aggregate_refresh");
    expect(upSql).toContain("refreshed_at");
    expect(upSql).toContain("INSERT INTO analytics_aggregate_refresh");
  });
});

describe("immutable ledger is never mutated (Req 1.6)", () => {
  it("only reads from the ledger — no ALTER/DROP of ledger tables on up", () => {
    expect(upSql).not.toContain("ALTER TABLE ledger_entries");
    expect(upSql).not.toContain("DROP TABLE ledger_entries");
    expect(upSql).not.toContain("ALTER TABLE point_lots");
  });
});

describe("down migration is a clean teardown", () => {
  it("drops every materialized view and the refresh-state table", () => {
    expect(downSql).toContain("DROP MATERIALIZED VIEW IF EXISTS analytics_customers");
    expect(downSql).toContain("DROP MATERIALIZED VIEW IF EXISTS analytics_ledger");
    expect(downSql).toContain("DROP MATERIALIZED VIEW IF EXISTS analytics_redemptions");
    expect(downSql).toContain("DROP TABLE IF EXISTS analytics_aggregate_refresh");
  });

  it("never drops the underlying source tables", () => {
    expect(downSql).not.toContain("DROP TABLE IF EXISTS customers");
    expect(downSql).not.toContain("DROP TABLE IF EXISTS ledger_entries");
    expect(downSql).not.toContain("DROP TABLE IF EXISTS redemptions");
  });
});
