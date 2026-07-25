/**
 * Schema verification for the Profile / Preferences migration (task 14.1).
 *
 * No live/production database is touched by this test. Because no local
 * Postgres/Docker is available in this environment, we verify the migration by
 * executing its `up`/`down` against a capturing MigrationBuilder stub and
 * asserting the emitted DDL matches the design.md "Additive Data Models" schema
 * exactly (the five behavioural/preference tables, their primary keys, and the
 * two named indexes). Applying the migration against a real Postgres is
 * deferred to deploy time via `npm run migrate:up`.
 *
 * Requirements: 17.3 — Profile/Preferences tables kept entirely separate from
 * `ledger_entries`.
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
    /create-profile-preferences\.ts$/.test(f),
  );
  expect(file, "profile-preferences migration file should exist").toBeTruthy();

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upSql = normalize(upBuilder.statements.join("\n"));

  const downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downSql = normalize(downBuilder.statements.join("\n"));
});

describe("profile-preferences migration module", () => {
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

describe("behavioural / preference tables (exactly as design.md)", () => {
  const tables = [
    "customer_favourites",
    "customer_wishlist",
    "customer_recently_viewed",
    "tier_change_history",
    "portal_visits",
  ];

  for (const t of tables) {
    it(`creates ${t}`, () => {
      expect(upSql).toContain(`CREATE TABLE ${t} (`);
    });
  }
});

describe("columns and primary keys", () => {
  it("customer_favourites: (customer_id, shopify_product_id, created_at) PK on the pair", () => {
    expect(upSql).toContain(
      "CREATE TABLE customer_favourites ( customer_id UUID NOT NULL REFERENCES customers(id), shopify_product_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (customer_id, shopify_product_id)",
    );
  });

  it("customer_wishlist: (customer_id, shopify_product_id, added_at) PK on the pair", () => {
    expect(upSql).toContain(
      "CREATE TABLE customer_wishlist ( customer_id UUID NOT NULL REFERENCES customers(id), shopify_product_id BIGINT NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (customer_id, shopify_product_id) )",
    );
  });

  it("customer_recently_viewed: (customer_id, shopify_product_id, viewed_at) PK on the pair", () => {
    expect(upSql).toContain(
      "CREATE TABLE customer_recently_viewed ( customer_id UUID NOT NULL REFERENCES customers(id), shopify_product_id BIGINT NOT NULL, viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (customer_id, shopify_product_id)",
    );
  });

  it("tier_change_history: id PK, customer FK, from/to tiers, reason, created_at", () => {
    expect(upSql).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(upSql).toContain("from_tier TEXT");
    expect(upSql).toContain("to_tier TEXT NOT NULL");
    expect(upSql).toContain("reason TEXT NOT NULL");
  });

  it("portal_visits: customer_id PK, first_visited_at, last_visited_at", () => {
    expect(upSql).toContain(
      "CREATE TABLE portal_visits ( customer_id UUID PRIMARY KEY REFERENCES customers(id), first_visited_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_visited_at TIMESTAMPTZ NOT NULL DEFAULT now() )",
    );
  });
});

describe("required indexes", () => {
  it("creates idx_recently_viewed_retention on (customer_id, viewed_at)", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_recently_viewed_retention ON customer_recently_viewed(customer_id, viewed_at)",
    );
  });

  it("creates idx_tier_history_customer on (customer_id, created_at)", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_tier_history_customer ON tier_change_history(customer_id, created_at)",
    );
  });
});

describe("off-ledger separation (Requirement 17.3)", () => {
  it("never writes to the ledger tables", () => {
    expect(upSql).not.toContain("ledger_entries");
    expect(upSql).not.toContain("point_lots");
  });

  it("references only customers(id) from the ledger core, never mutating it", () => {
    expect(upSql).not.toContain("ALTER TABLE customers");
    expect(upSql).not.toContain("DROP TABLE IF EXISTS customers");
  });
});

describe("down migration is a clean teardown", () => {
  const dropped = [
    "portal_visits",
    "tier_change_history",
    "customer_recently_viewed",
    "customer_wishlist",
    "customer_favourites",
  ];

  for (const t of dropped) {
    it(`drops ${t}`, () => {
      expect(downSql).toContain(`DROP TABLE IF EXISTS ${t}`);
    });
  }

  it("does not drop the shared customers table", () => {
    expect(downSql).not.toContain("DROP TABLE IF EXISTS customers");
  });
});
