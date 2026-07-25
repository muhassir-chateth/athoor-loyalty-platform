/**
 * Schema verification for the Device_Tokens + notification-events migration
 * (task 19.1).
 *
 * No live/production database is touched by this test. Because no local
 * Postgres/Docker is available in this environment, we verify the migration by
 * executing its `up`/`down` against a capturing MigrationBuilder stub and
 * asserting the emitted DDL matches design.md "Additive Data Models" for
 * `device_tokens`, plus the additive `notification_events` model required by
 * task 19.1 (Req 19.2). Applying the migration against a real Postgres is
 * deferred to deploy time via `npm run migrate:up`.
 *
 * Requirements: 19.1 (register/de-register Device_Tokens additively), 19.2
 * (model notification events targeting Device_Tokens), 19.7 (additive-only,
 * never mutating existing tables or the ledger).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

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
let upSql: string;
let downSql: string;
let upBuilder: CapturedBuilder;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "migrations");
  const file = readdirSync(migrationsDir).find((f) => /create-device-tokens\.ts$/.test(f));
  expect(file, "device-tokens migration file should exist").toBeTruthy();

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upSql = normalize(upBuilder.statements.join("\n"));

  const downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downSql = normalize(downBuilder.statements.join("\n"));
});

describe("device-tokens migration module", () => {
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

describe("device_tokens table (exactly as design.md)", () => {
  it("creates device_tokens with the specified columns", () => {
    // Column-by-column (rather than one contiguous string) because design.md
    // keeps inline `-- ...` comments between columns, which we preserve.
    expect(upSql).toContain("CREATE TABLE device_tokens (");
    expect(upSql).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(upSql).toContain("customer_id UUID NOT NULL REFERENCES customers(id)");
    expect(upSql).toContain("token TEXT NOT NULL");
    expect(upSql).toContain("platform TEXT NOT NULL");
    expect(upSql).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT now()");
    expect(upSql).toContain("revoked_at TIMESTAMPTZ");
    expect(upSql).toContain("UNIQUE (customer_id, token)");
  });

  it("indexes active (non-revoked) tokens per customer", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_device_tokens_active ON device_tokens(customer_id) WHERE revoked_at IS NULL",
    );
  });
});

describe("notification_events model (Req 19.2)", () => {
  it("creates notification_events bound to a customer with type + payload", () => {
    expect(upSql).toContain("CREATE TABLE notification_events (");
    expect(upSql).toContain("customer_id UUID NOT NULL REFERENCES customers(id)");
    expect(upSql).toContain("event_type TEXT NOT NULL");
    expect(upSql).toContain("payload JSONB NOT NULL DEFAULT '{}'");
  });

  it("indexes notification_events by customer + time", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_notification_events_customer ON notification_events(customer_id, created_at)",
    );
  });
});

describe("additive-only / off-ledger (Req 19.7)", () => {
  it("never writes to the ledger tables", () => {
    expect(upSql).not.toContain("ledger_entries");
    expect(upSql).not.toContain("point_lots");
  });

  it("references customers(id) without mutating any existing table", () => {
    expect(upSql).not.toContain("ALTER TABLE customers");
    expect(upSql).not.toContain("DROP TABLE IF EXISTS customers");
    expect(upSql).not.toContain("ALTER TABLE redemptions");
  });
});

describe("down migration is a clean teardown", () => {
  for (const t of ["notification_events", "device_tokens"]) {
    it(`drops ${t}`, () => {
      expect(downSql).toContain(`DROP TABLE IF EXISTS ${t}`);
    });
  }

  it("does not drop the shared customers table", () => {
    expect(downSql).not.toContain("DROP TABLE IF EXISTS customers");
  });
});
