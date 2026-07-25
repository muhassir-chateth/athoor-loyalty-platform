/**
 * Schema + seed verification for the benefits migration (task 15.1).
 *
 * No live/production database is touched by this test. As with the ledger-core
 * verification, and because no local Postgres/Docker is available here, we
 * execute the migration's `up`/`down` against a capturing MigrationBuilder stub
 * and assert the emitted DDL matches design.md "Additive Data Models" exactly
 * (the `benefits` and `benefit_requests` tables, their columns/defaults, and
 * the `idx_benefit_requests_customer` index), plus that the initial Benefit
 * catalogue is seeded (Req 18.4 / A13). Applying the migration against a real
 * Postgres is deferred to deploy time via `npm run migrate:up`.
 *
 * We also verify the human-readable seed module
 * (`src/benefits/benefit-definitions.ts`) and assert it stays in lock-step with
 * the SQL the migration seeds (Req 18.1, 18.7 — config-driven, additive).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { BENEFIT_SEED } from "./benefits/benefit-definitions.js";

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
    /create-benefits-schema\.ts$/.test(f),
  );
  expect(file, "benefits-schema migration file should exist").toBeTruthy();

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upSql = normalize(upBuilder.statements.join("\n"));

  const downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downSql = normalize(downBuilder.statements.join("\n"));
});

describe("benefits migration module", () => {
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

describe("benefits table (exactly as design.md)", () => {
  it("creates the benefits table", () => {
    expect(upSql).toContain("CREATE TABLE benefits (");
  });

  it("key is UNIQUE NOT NULL", () => {
    expect(upSql).toContain("key TEXT UNIQUE NOT NULL");
  });

  it("has a name column", () => {
    expect(upSql).toContain("name TEXT NOT NULL");
  });

  it("has min_qualifying_tier for tier gating", () => {
    expect(upSql).toContain("min_qualifying_tier TEXT NOT NULL");
  });

  it("config is JSONB defaulting to '{}' (config-driven, Req 18.1/18.7)", () => {
    expect(upSql).toContain("config JSONB NOT NULL DEFAULT '{}'");
  });

  it("active is a boolean defaulting to true", () => {
    expect(upSql).toContain("active BOOLEAN NOT NULL DEFAULT true");
  });
});

describe("benefit_requests table (exactly as design.md)", () => {
  it("creates the benefit_requests table", () => {
    expect(upSql).toContain("CREATE TABLE benefit_requests (");
  });

  it("references customers(id) and benefits(id)", () => {
    expect(upSql).toContain("customer_id UUID NOT NULL REFERENCES customers(id)");
    expect(upSql).toContain("benefit_id UUID NOT NULL REFERENCES benefits(id)");
  });

  it("status defaults to 'requested'", () => {
    expect(upSql).toContain("status TEXT NOT NULL DEFAULT 'requested'");
  });

  it("has a requested_at timestamp defaulting to now()", () => {
    expect(upSql).toContain("requested_at TIMESTAMPTZ NOT NULL DEFAULT now()");
  });

  it("creates idx_benefit_requests_customer on (customer_id, requested_at)", () => {
    expect(upSql).toContain(
      "CREATE INDEX idx_benefit_requests_customer ON benefit_requests(customer_id, requested_at)",
    );
  });
});

describe("seed configuration (Req 18.4 / A13)", () => {
  it("seeds the initial benefit catalogue via an idempotent INSERT", () => {
    expect(upSql).toContain("INSERT INTO benefits (key, name, min_qualifying_tier, config, active) VALUES");
    expect(upSql).toContain("ON CONFLICT (key) DO NOTHING");
  });

  it("seeds each future-roadmap Royal_VIP perk gated to royal_vip", () => {
    const expectedKeys = [
      "private_consultation",
      "early_access_launches",
      "limited_edition_access",
      "exclusive_samples",
      "dedicated_service",
      "invitation_only_experiences",
    ];
    for (const key of expectedKeys) {
      expect(upSql).toContain(`'${key}'`);
    }
    // Every seeded perk is gated to royal_vip.
    expect(upSql).not.toContain("'bronze'");
    expect(upSql).toContain("'royal_vip'");
  });

  it("seeds future-roadmap perks inactive (active = false) as sensible defaults", () => {
    // The only INSERTed active flags should be false for the roadmap perks.
    expect(upSql).toContain(", false)");
    // Sanity: the private-consultation booking perk is present (Req 18.5 target).
    expect(upSql).toContain("'Private Consultation Booking'");
  });
});

describe("seed module (src/benefits/benefit-definitions.ts)", () => {
  it("exposes exactly the future-roadmap Royal_VIP perks", () => {
    expect(BENEFIT_SEED.length).toBe(6);
  });

  it("gates every seeded benefit to royal_vip and ships it inactive", () => {
    for (const b of BENEFIT_SEED) {
      expect(b.minQualifyingTier).toBe("royal_vip");
      expect(b.active).toBe(false);
      expect(typeof b.key).toBe("string");
      expect(b.key.length).toBeGreaterThan(0);
      expect(typeof b.name).toBe("string");
      expect(b.name.length).toBeGreaterThan(0);
      expect(typeof b.config).toBe("object");
    }
  });

  it("has unique keys", () => {
    const keys = BENEFIT_SEED.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stays in lock-step with the migration seed (every module key + name is seeded)", () => {
    for (const b of BENEFIT_SEED) {
      expect(upSql, `migration should seed key '${b.key}'`).toContain(`'${b.key}'`);
      expect(upSql, `migration should seed name '${b.name}'`).toContain(`'${b.name}'`);
      expect(upSql, `migration should seed tier for '${b.key}'`).toContain(
        `'${b.minQualifyingTier}'`,
      );
    }
  });

  it("covers the A13 private-client perk set", () => {
    const keys = BENEFIT_SEED.map((b) => b.key);
    expect(keys).toContain("private_consultation");
    expect(keys).toContain("early_access_launches");
    expect(keys).toContain("limited_edition_access");
    expect(keys).toContain("exclusive_samples");
    expect(keys).toContain("dedicated_service");
    expect(keys).toContain("invitation_only_experiences");
  });
});

describe("down migration is a clean, ordered teardown", () => {
  it("drops benefit_requests before benefits (FK order)", () => {
    const dropRequests = downSql.indexOf("DROP TABLE IF EXISTS benefit_requests");
    const dropBenefits = downSql.indexOf("DROP TABLE IF EXISTS benefits");
    expect(dropRequests).toBeGreaterThan(-1);
    expect(dropBenefits).toBeGreaterThan(-1);
    expect(dropRequests).toBeLessThan(dropBenefits);
  });
});
