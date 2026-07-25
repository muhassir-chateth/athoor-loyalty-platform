/**
 * Schema verification for the ledger-core migration (task 1.2).
 *
 * No live/production database is touched by this test. Because no local
 * Postgres/Docker is available in this environment, we verify the migration by
 * executing its `up`/`down` against a capturing MigrationBuilder stub and
 * asserting the emitted DDL matches the design.md "Data Models" schema exactly
 * (all seven core tables, the three named indexes, and the CHECK / UNIQUE
 * constraints). Applying the migration against a real Postgres is deferred to
 * deploy time via `npm run migrate:up`.
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
let upSql: string; // normalized concatenation of all up() statements
let downSql: string; // normalized concatenation of all down() statements
let upBuilder: CapturedBuilder;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "migrations");
  const file = readdirSync(migrationsDir).find((f) =>
    /create-ledger-core\.ts$/.test(f),
  );
  expect(file, "ledger-core migration file should exist").toBeTruthy();

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upSql = normalize(upBuilder.statements.join("\n"));

  const downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downSql = normalize(downBuilder.statements.join("\n"));
});

describe("ledger-core migration module", () => {
  it("exports up, down, and shorthands", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect("shorthands" in mod).toBe(true);
  });

  it("emits at least one DDL statement on up and down", () => {
    expect(upBuilder.statements.length).toBeGreaterThan(0);
    expect(downSql.length).toBeGreaterThan(0);
  });
});

describe("required extensions", () => {
  it("creates citext and pgcrypto", () => {
    expect(upSql).toContain("CREATE EXTENSION IF NOT EXISTS citext");
    expect(upSql).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  });
});

describe("core tables (exactly as design.md)", () => {
  const tables = [
    "customers",
    "ledger_entries",
    "point_lots",
    "redemptions",
    "discount_codes",
    "webhook_events",
    "referrals",
  ];

  for (const t of tables) {
    it(`creates ${t}`, () => {
      expect(upSql).toContain(`CREATE TABLE ${t} (`);
    });
  }

  it("keys customers by a unique Shopify customer id", () => {
    expect(upSql).toContain("shopify_customer_id BIGINT UNIQUE NOT NULL");
  });

  it("customers has a self-referential referred_by FK (self-referral guard)", () => {
    expect(upSql).toContain("referred_by UUID REFERENCES customers(id)");
  });

  it("ledger_entries references customers and stores signed points", () => {
    expect(upSql).toContain("customer_id UUID NOT NULL REFERENCES customers(id)");
    expect(upSql).toContain("points BIGINT NOT NULL");
  });
});

describe("required indexes", () => {
  it("creates idx_ledger_customer on (customer_id, created_at)", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_ledger_customer ON ledger_entries(customer_id, created_at)",
    );
  });

  it("creates partial idx_lots_fifo on (customer_id, earned_at) where remaining_points > 0", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_lots_fifo ON point_lots(customer_id, earned_at) WHERE remaining_points > 0",
    );
  });

  it("creates partial idx_lots_expiry on (expires_at) where remaining_points > 0", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_lots_expiry ON point_lots(expires_at) WHERE remaining_points > 0",
    );
  });
});

describe("CHECK and UNIQUE constraints", () => {
  it("point_lots: original_points > 0", () => {
    expect(upSql).toContain("original_points BIGINT NOT NULL CHECK (original_points > 0)");
  });

  it("point_lots: remaining_points >= 0", () => {
    expect(upSql).toContain("remaining_points BIGINT NOT NULL CHECK (remaining_points >= 0)");
  });

  it("point_lots: remaining_points <= original_points", () => {
    expect(upSql).toContain("CHECK (remaining_points <= original_points)");
  });

  it("redemptions: points_spent > 0", () => {
    expect(upSql).toContain("points_spent BIGINT NOT NULL CHECK (points_spent > 0)");
  });

  it("redemptions: unique (customer_id, idempotency_key)", () => {
    expect(upSql).toContain("UNIQUE (customer_id, idempotency_key)");
  });

  it("discount_codes: code is UNIQUE NOT NULL", () => {
    expect(upSql).toContain("code TEXT UNIQUE NOT NULL");
  });

  it("webhook_events: shopify_webhook_id is UNIQUE NOT NULL", () => {
    expect(upSql).toContain("shopify_webhook_id TEXT UNIQUE NOT NULL");
  });

  it("referrals: CHECK (referrer_id <> referred_id) (no self-referral)", () => {
    expect(upSql).toContain("CHECK (referrer_id <> referred_id)");
  });
});

describe("circular FK between redemptions and discount_codes", () => {
  it("discount_codes.redemption_id references redemptions(id)", () => {
    expect(upSql).toContain("redemption_id UUID NOT NULL REFERENCES redemptions(id)");
  });

  it("redemptions.discount_code_id FK added after discount_codes exists", () => {
    expect(upSql).toContain(
      "ALTER TABLE redemptions ADD CONSTRAINT redemptions_discount_code_id_fkey FOREIGN KEY (discount_code_id) REFERENCES discount_codes(id)",
    );
    // The ALTER must come after both tables are created.
    const alterIdx = upSql.indexOf("ADD CONSTRAINT redemptions_discount_code_id_fkey");
    const discountIdx = upSql.indexOf("CREATE TABLE discount_codes (");
    expect(discountIdx).toBeGreaterThan(-1);
    expect(alterIdx).toBeGreaterThan(discountIdx);
  });
});

describe("down migration is a clean, ordered teardown", () => {
  const dropped = [
    "referrals",
    "webhook_events",
    "discount_codes",
    "redemptions",
    "point_lots",
    "ledger_entries",
    "customers",
  ];

  for (const t of dropped) {
    it(`drops ${t}`, () => {
      expect(downSql).toContain(`DROP TABLE IF EXISTS ${t}`);
    });
  }

  it("removes the circular FK before dropping the mutually-referencing tables", () => {
    const dropFk = downSql.indexOf("DROP CONSTRAINT IF EXISTS redemptions_discount_code_id_fkey");
    const dropDiscount = downSql.indexOf("DROP TABLE IF EXISTS discount_codes");
    const dropRedemptions = downSql.indexOf("DROP TABLE IF EXISTS redemptions");
    expect(dropFk).toBeGreaterThan(-1);
    expect(dropFk).toBeLessThan(dropDiscount);
    expect(dropFk).toBeLessThan(dropRedemptions);
  });
});
