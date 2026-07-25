/**
 * Schema + seed verification for the Market / rule-set config migration
 * (task 20.1).
 *
 * No live/production database is touched by this test. As with the other
 * migration verifications, and because no local Postgres/Docker is available
 * here, we execute the migration's `up`/`down` against a capturing
 * MigrationBuilder stub and assert the emitted DDL matches design.md "Additive
 * Data Models" exactly (the `markets`, `earning_rule_sets`, and
 * `reward_rule_sets` tables, their columns/defaults/constraints), plus that the
 * single base UK / GBP market and its rule sets are seeded (Req 21.1, 21.6).
 * Applying the migration against a real Postgres is deferred to deploy time via
 * `npm run migrate:up`.
 *
 * We also verify the human-readable seed module
 * (`src/markets/market-definitions.ts`) and assert it stays in lock-step with
 * the values the migration seeds — and that those values reproduce the current
 * hardcoded GBP behaviour EXACTLY (no behavioural change; Req 21.1, 21.6).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  BASE_MARKET,
  BASE_EARNING_RULE_SET,
  BASE_REWARD_RULE_SET,
} from "./markets/market-definitions.js";
import { DEFAULT_TIER_RULES, TIERS } from "./tier/tier.js";
import { REWARD_IDS, REWARDS } from "./rewards/catalog.js";

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
  const file = readdirSync(migrationsDir).find((f) => /create-market-config\.ts$/.test(f));
  expect(file, "market-config migration file should exist").toBeTruthy();

  const url = pathToFileURL(join(migrationsDir, file as string)).href;
  mod = (await import(/* @vite-ignore */ url)) as MigrationModule;

  upBuilder = makeBuilder();
  await mod.up(upBuilder);
  upSql = normalize(upBuilder.statements.join("\n"));

  const downBuilder = makeBuilder();
  await mod.down(downBuilder);
  downSql = normalize(downBuilder.statements.join("\n"));
});

describe("market-config migration module", () => {
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

describe("markets table (exactly as design.md)", () => {
  it("creates the markets table", () => {
    expect(upSql).toContain("CREATE TABLE markets (");
  });

  it("code is UNIQUE NOT NULL", () => {
    expect(upSql).toContain("code TEXT UNIQUE NOT NULL");
  });

  it("base_currency defaults to GBP (A8, money-bearing → explicit currency)", () => {
    expect(upSql).toContain("base_currency TEXT NOT NULL DEFAULT 'GBP'");
  });

  it("language defaults to en (localizable — Req 21.5)", () => {
    expect(upSql).toContain("language TEXT NOT NULL DEFAULT 'en'");
  });

  it("active is a boolean defaulting to true", () => {
    expect(upSql).toContain("active BOOLEAN NOT NULL DEFAULT true");
  });
});

describe("earning_rule_sets table (exactly as design.md)", () => {
  it("creates the earning_rule_sets table keyed by market", () => {
    expect(upSql).toContain("CREATE TABLE earning_rule_sets (");
    expect(upSql).toContain("market_id UUID NOT NULL REFERENCES markets(id)");
  });

  it("carries an explicit currency (money-bearing)", () => {
    expect(upSql).toContain("currency TEXT NOT NULL DEFAULT 'GBP'");
  });

  it("stores tier thresholds and multipliers as JSONB (moved out of constants)", () => {
    expect(upSql).toContain("tier_thresholds JSONB NOT NULL");
    expect(upSql).toContain("tier_multipliers JSONB NOT NULL");
  });

  it("allows at most one active rule set per market", () => {
    expect(upSql).toContain("UNIQUE (market_id, active)");
  });
});

describe("reward_rule_sets table (exactly as design.md)", () => {
  it("creates the reward_rule_sets table keyed by market", () => {
    expect(upSql).toContain("CREATE TABLE reward_rule_sets (");
    expect(upSql).toContain("market_id UUID NOT NULL REFERENCES markets(id)");
  });

  it("carries an explicit currency and a JSONB reward map", () => {
    expect(upSql).toContain("currency TEXT NOT NULL DEFAULT 'GBP'");
    expect(upSql).toContain("reward_map JSONB NOT NULL");
  });
});

describe("seed: single base UK / GBP market (Req 21.1, 21.3, 21.6)", () => {
  it("seeds one UK market via an idempotent insert", () => {
    expect(upSql).toContain("INSERT INTO markets (code, base_currency, language, active)");
    expect(upSql).toContain("'UK', 'GBP', 'en', true");
    expect(upSql).toContain("ON CONFLICT (code) DO NOTHING");
  });

  it("seeds the active GBP earning rule set keyed to the UK market", () => {
    expect(upSql).toContain(
      "INSERT INTO earning_rule_sets (market_id, currency, tier_thresholds, tier_multipliers, active)",
    );
    expect(upSql).toContain('{"bronze":0,"silver":300,"gold":750,"royal_vip":1500}');
    expect(upSql).toContain('{"bronze":1,"silver":1.5,"gold":2,"royal_vip":3}');
    expect(upSql).toContain("WHERE m.code = 'UK'");
    expect(upSql).toContain("ON CONFLICT (market_id, active) DO NOTHING");
  });

  it("seeds the active GBP reward rule set keyed to the UK market", () => {
    expect(upSql).toContain("INSERT INTO reward_rule_sets (market_id, currency, reward_map, active)");
    expect(upSql).toContain('"reward_5":{"cost":100,"value":5}');
    expect(upSql).toContain('"reward_75":{"cost":1000,"value":75}');
  });
});

describe("seed module (src/markets/market-definitions.ts) — no behavioural change", () => {
  it("defines a single active UK / GBP market", () => {
    expect(BASE_MARKET.code).toBe("UK");
    expect(BASE_MARKET.baseCurrency).toBe("GBP");
    expect(BASE_MARKET.language).toBe("en");
    expect(BASE_MARKET.active).toBe(true);
  });

  it("reproduces the current tier thresholds/multipliers exactly", () => {
    for (const tier of TIERS) {
      expect(BASE_EARNING_RULE_SET.tierThresholds[tier]).toBe(DEFAULT_TIER_RULES.thresholds[tier]);
      expect(BASE_EARNING_RULE_SET.tierMultipliers[tier]).toBe(DEFAULT_TIER_RULES.multipliers[tier]);
    }
    expect(BASE_EARNING_RULE_SET.currency).toBe("GBP");
  });

  it("reproduces the current reward map exactly", () => {
    for (const id of REWARD_IDS) {
      expect(BASE_REWARD_RULE_SET.rewardMap[id].cost).toBe(REWARDS[id].cost);
      expect(BASE_REWARD_RULE_SET.rewardMap[id].value).toBe(REWARDS[id].valueGBP);
    }
    expect(BASE_REWARD_RULE_SET.currency).toBe("GBP");
  });

  it("stays in lock-step with the migration seed (thresholds/multipliers/rewards)", () => {
    expect(upSql).toContain(
      `{"bronze":${BASE_EARNING_RULE_SET.tierThresholds.bronze},"silver":${BASE_EARNING_RULE_SET.tierThresholds.silver},"gold":${BASE_EARNING_RULE_SET.tierThresholds.gold},"royal_vip":${BASE_EARNING_RULE_SET.tierThresholds.royal_vip}}`,
    );
    for (const id of REWARD_IDS) {
      expect(upSql).toContain(
        `"${id}":{"cost":${BASE_REWARD_RULE_SET.rewardMap[id].cost},"value":${BASE_REWARD_RULE_SET.rewardMap[id].value}}`,
      );
    }
  });
});

describe("down migration is a clean, ordered teardown", () => {
  it("drops rule sets before markets (FK order)", () => {
    const dropReward = downSql.indexOf("DROP TABLE IF EXISTS reward_rule_sets");
    const dropEarning = downSql.indexOf("DROP TABLE IF EXISTS earning_rule_sets");
    const dropMarkets = downSql.indexOf("DROP TABLE IF EXISTS markets");
    expect(dropReward).toBeGreaterThan(-1);
    expect(dropEarning).toBeGreaterThan(-1);
    expect(dropMarkets).toBeGreaterThan(-1);
    expect(dropReward).toBeLessThan(dropMarkets);
    expect(dropEarning).toBeLessThan(dropMarkets);
  });
});
