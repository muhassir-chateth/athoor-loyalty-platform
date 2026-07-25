/**
 * Schema verification for the redemption-channel migration (task 21.1).
 *
 * No live/production database is touched. Because no local Postgres/Docker is
 * available in this environment, we verify the migration by executing its
 * `up`/`down` against a capturing MigrationBuilder stub and asserting the
 * emitted DDL matches design.md "Channel attribution (Requirement 19)":
 *
 *   ALTER TABLE redemptions ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';
 *
 * Applying the migration against a real Postgres is deferred to deploy time via
 * `npm run migrate:up`.
 *
 * Requirements: 19.3 (attribute rewards to an originating Channel), 19.4
 * (app-exclusive rewards only for `app`), 19.7 (additive-only — the ledger is
 * never touched).
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
let upBuilder: CapturedBuilder;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "migrations");
  const file = readdirSync(migrationsDir).find((f) => /add-redemption-channel\.ts$/.test(f));
  expect(file, "redemption-channel migration file should exist").toBeTruthy();

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upSql = normalize(upBuilder.statements.join("\n"));

  const downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downSql = normalize(downBuilder.statements.join("\n"));
});

describe("redemption-channel migration module", () => {
  it("exports up, down, and shorthands", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect("shorthands" in mod).toBe(true);
  });

  it("emits DDL on up and down", () => {
    expect(upBuilder.statements.length).toBeGreaterThan(0);
    expect(downSql.length).toBeGreaterThan(0);
  });
});

describe("channel column (exactly as design.md)", () => {
  it("adds the additive channel column with a web default (backfills existing rows)", () => {
    expect(upSql).toContain(
      "ALTER TABLE redemptions ADD COLUMN channel TEXT NOT NULL DEFAULT 'web'",
    );
  });

  it("constrains channel to web|app", () => {
    expect(upSql).toContain("CHECK (channel IN ('web', 'app'))");
  });
});

describe("additive-only / off-ledger (Req 19.7)", () => {
  it("only alters redemptions — never the ledger tables", () => {
    expect(upSql).not.toContain("ledger_entries");
    expect(upSql).not.toContain("point_lots");
    expect(upSql).not.toContain("DROP TABLE");
  });
});

describe("down migration is a clean teardown", () => {
  it("drops the constraint and the column, leaving the table intact", () => {
    expect(downSql).toContain(
      "ALTER TABLE redemptions DROP CONSTRAINT IF EXISTS redemptions_channel_check",
    );
    expect(downSql).toContain("ALTER TABLE redemptions DROP COLUMN IF EXISTS channel");
    expect(downSql).not.toContain("DROP TABLE");
  });
});
