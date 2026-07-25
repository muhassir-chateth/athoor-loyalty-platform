/**
 * Schema verification for the pre-expiry-notifications migration (task 10.2).
 *
 * No live/production database is touched. Because no local Postgres/Docker is
 * available in this environment, we verify the migration by executing its
 * `up`/`down` against a capturing MigrationBuilder stub and asserting the
 * emitted DDL matches the AUTHORITATIVE
 * {@link PRE_EXPIRY_NOTIFICATIONS_DDL} documented in
 * `src/expiry/preExpiryNotify.ts` EXACTLY — same table, columns, types,
 * defaults, foreign keys and the `UNIQUE (point_lot_id)` guard — and that the
 * up/down statements are ordered (create on up, drop on down).
 *
 * Applying the migration against a real Postgres is deferred to deploy time via
 * `npm run migrate:up`.
 *
 * Requirements: 5.4 (enqueue exactly one pre-expiry notification per qualifying
 * lot), 5.5 (never enqueue a duplicate within a lot's pre-expiry window — backed
 * by this table's `UNIQUE (point_lot_id)`).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { PRE_EXPIRY_NOTIFICATIONS_DDL } from "./expiry/preExpiryNotify.js";

/** Minimal capture of the MigrationBuilder surface our migration uses. */
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

/** Collapse all whitespace so assertions are insensitive to formatting. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

type MigrationModule = {
  up: (pgm: unknown) => Promise<void>;
  down: (pgm: unknown) => Promise<void>;
  shorthands: unknown;
};

let mod: MigrationModule;
let upSql: string; // normalized concatenation of all up() statements
let downSql: string; // normalized concatenation of all down() statements
let upBuilder: CapturedBuilder;
let downBuilder: CapturedBuilder;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "migrations");
  const file = readdirSync(migrationsDir).find((f) =>
    /create-pre-expiry-notifications\.ts$/.test(f),
  );
  expect(file, "pre-expiry-notifications migration file should exist").toBeTruthy();

  // Guard: the timestamp prefix must be the unique 1785200000000 (not a reused
  // 1785000000000 / 1785100000000).
  expect(file).toMatch(/^1785200000000_/);

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upSql = normalize(upBuilder.statements.join("\n"));

  downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downSql = normalize(downBuilder.statements.join("\n"));
});

describe("pre-expiry-notifications migration module", () => {
  it("exports up, down, and shorthands", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect("shorthands" in mod).toBe(true);
  });

  it("emits exactly one DDL statement on up and one on down", () => {
    expect(upBuilder.statements.length).toBe(1);
    expect(downBuilder.statements.length).toBe(1);
  });
});

describe("emitted DDL matches the documented PRE_EXPIRY_NOTIFICATIONS_DDL exactly", () => {
  it("up() emits the documented table verbatim (whitespace-insensitive)", () => {
    expect(upSql).toBe(normalize(PRE_EXPIRY_NOTIFICATIONS_DDL));
  });

  it("creates the pre_expiry_notifications table", () => {
    expect(upSql).toContain("CREATE TABLE pre_expiry_notifications (");
  });

  it("declares every documented column with its exact type/default", () => {
    expect(upSql).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(upSql).toContain("point_lot_id UUID NOT NULL REFERENCES point_lots(id)");
    expect(upSql).toContain("customer_id UUID NOT NULL REFERENCES customers(id)");
    expect(upSql).toContain("expires_at TIMESTAMPTZ NOT NULL");
    expect(upSql).toContain("points BIGINT NOT NULL");
    expect(upSql).toContain("window_days INTEGER NOT NULL");
    expect(upSql).toContain("notified_at TIMESTAMPTZ NOT NULL DEFAULT now()");
  });

  it("guards at most one pre-expiry notice per lot via UNIQUE (point_lot_id) (Req 5.5)", () => {
    expect(upSql).toContain("UNIQUE (point_lot_id)");
  });
});

describe("additive-only / off-ledger (a pre-expiry heads-up is not a point movement)", () => {
  it("only creates the tracking table — never writes to or alters the ledger", () => {
    expect(upSql).not.toContain("ledger_entries");
    expect(upSql).not.toContain("ALTER TABLE point_lots");
    expect(upSql).not.toContain("ALTER TABLE customers");
    expect(upSql).not.toContain("DROP TABLE");
  });
});

describe("down migration is a clean teardown (ordered after up)", () => {
  it("drops only the pre_expiry_notifications table", () => {
    expect(downSql).toContain("DROP TABLE IF EXISTS pre_expiry_notifications");
  });

  it("does not drop the shared point_lots / customers tables", () => {
    expect(downSql).not.toContain("DROP TABLE IF EXISTS point_lots");
    expect(downSql).not.toContain("DROP TABLE IF EXISTS customers");
  });
});
