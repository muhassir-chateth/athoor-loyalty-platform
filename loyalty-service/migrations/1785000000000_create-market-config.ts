/**
 * Migration: create the Market / rule-set configuration schema + seed the
 * single base UK / GBP market and its rule sets (task 20.1).
 *
 * Creates the three additive tables from design.md "Additive Data Models"
 * EXACTLY as specified (Requirement 21):
 *   - markets            (id, code UNIQUE, base_currency DEFAULT 'GBP',
 *                         language DEFAULT 'en', active DEFAULT true)
 *   - earning_rule_sets  (id, market_id -> markets, currency DEFAULT 'GBP',
 *                         tier_thresholds JSONB, tier_multipliers JSONB,
 *                         active DEFAULT true, UNIQUE (market_id, active))
 *   - reward_rule_sets   (id, market_id -> markets, currency DEFAULT 'GBP',
 *                         reward_map JSONB, active DEFAULT true,
 *                         UNIQUE (market_id, active))
 *
 * WHY (Req 21.1–21.4, 21.6, 21.7): today's tier thresholds, tier multipliers,
 * and the reward map lived as hardcoded constants in `src/tier/tier.ts`
 * (`TIER_THRESHOLDS_GBP` / `TIER_MULTIPLIERS`) and `src/rewards/catalog.ts`
 * (`REWARDS`). This migration externalises them into config the engine reads,
 * so per-Market currencies and rule sets become an ADDITIVE change (a new
 * `markets` row + rule-set rows) with NO ledger redesign and no breaking `/v1`
 * change. The immutable ledger core (`ledger_entries`, `point_lots`, …) is left
 * exactly as-is: the ledger stays currency-agnostic (points are unitless);
 * only these money-bearing config records carry an explicit `currency` (GBP at
 * MVP, per A8).
 *
 * SEED (Req 21.1, 21.6): a single active UK market with `base_currency = 'GBP'`
 * is inserted, plus one active `earning_rule_sets` row (the current GBP tier
 * thresholds Bronze £0 / Silver £300 / Gold £750 / Royal_VIP £1500 and
 * multipliers 1 / 1.5 / 2 / 3) and one active `reward_rule_sets` row (the
 * current reward map reward_5→£5 … reward_75→£75). These values are the current
 * hardcoded behaviour reproduced EXACTLY, so migrating changes nothing for the
 * existing (UK) customers — with only the base market configured, the GBP rule
 * set applies to all customers (Req 21.6). The INSERTs are idempotent
 * (`ON CONFLICT DO NOTHING` on the unique keys) so the migration is safe to
 * re-run. This seed is kept in lock-step with `src/markets/market-definitions.ts`
 * (verified by `src/migrations.market-config.test.ts`) but is inlined here so
 * the migration is self-contained and deploy-safe.
 *
 * The config loader that reads these rows (`src/markets/marketConfig.ts`) is
 * intentionally NOT part of this DDL file.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.6, 21.7.
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it touches
 * no live/production database. Application happens at deploy time via
 * `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Market / currency configuration (Req 21.3). A single active market operates
  // at MVP; additional markets are added purely by inserting rows (no schema
  // redesign — Req 21.7). base_currency defaults to GBP (A8).
  pgm.sql(`
    CREATE TABLE markets (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code                TEXT UNIQUE NOT NULL,       -- e.g. UK
        base_currency       TEXT NOT NULL DEFAULT 'GBP',-- A8: Base_Currency = GBP
        language            TEXT NOT NULL DEFAULT 'en',
        active              BOOLEAN NOT NULL DEFAULT true
    );
  `);

  // Earning rule sets keyed by market: tier thresholds + multipliers moved out
  // of hardcoded constants (Req 21.1, 21.2, 21.4). Money-bearing → explicit
  // currency. UNIQUE (market_id, active) keeps at most one active set per market.
  pgm.sql(`
    CREATE TABLE earning_rule_sets (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        market_id           UUID NOT NULL REFERENCES markets(id),
        currency            TEXT NOT NULL DEFAULT 'GBP',-- money-bearing: explicit currency
        tier_thresholds     JSONB NOT NULL,            -- { bronze:0, silver:300, gold:750, royal_vip:1500 } in currency
        tier_multipliers    JSONB NOT NULL,            -- { bronze:1, silver:1.5, gold:2, royal_vip:3 }
        active              BOOLEAN NOT NULL DEFAULT true,
        UNIQUE (market_id, active)
    );
  `);

  // Reward rule sets keyed by market: reward map moved out of hardcoded
  // constants (Req 21.1, 21.4). Money-bearing → explicit currency.
  pgm.sql(`
    CREATE TABLE reward_rule_sets (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        market_id           UUID NOT NULL REFERENCES markets(id),
        currency            TEXT NOT NULL DEFAULT 'GBP',-- money-bearing: explicit currency
        reward_map          JSONB NOT NULL,            -- { reward_5:{cost:100,value:5}, ... } value in currency
        active              BOOLEAN NOT NULL DEFAULT true,
        UNIQUE (market_id, active)
    );
  `);

  // Seed the single base UK / GBP market (Req 21.1, 21.3, 21.6). Idempotent on
  // the unique `code`.
  pgm.sql(`
    INSERT INTO markets (code, base_currency, language, active)
    VALUES ('UK', 'GBP', 'en', true)
    ON CONFLICT (code) DO NOTHING;
  `);

  // Seed the active GBP earning rule set for the base market — the current
  // hardcoded tier thresholds/multipliers reproduced EXACTLY (Req 21.1, 21.6).
  // Keyed to the UK market via a sub-select so it is independent of the market
  // id. Idempotent on UNIQUE (market_id, active).
  pgm.sql(`
    INSERT INTO earning_rule_sets (market_id, currency, tier_thresholds, tier_multipliers, active)
    SELECT m.id, 'GBP',
           '{"bronze":0,"silver":300,"gold":750,"royal_vip":1500}'::jsonb,
           '{"bronze":1,"silver":1.5,"gold":2,"royal_vip":3}'::jsonb,
           true
    FROM markets m
    WHERE m.code = 'UK'
    ON CONFLICT (market_id, active) DO NOTHING;
  `);

  // Seed the active GBP reward rule set for the base market — the current
  // hardcoded reward map reproduced EXACTLY (Req 21.1, 21.6). Idempotent on
  // UNIQUE (market_id, active).
  pgm.sql(`
    INSERT INTO reward_rule_sets (market_id, currency, reward_map, active)
    SELECT m.id, 'GBP',
           '{"reward_5":{"cost":100,"value":5},"reward_15":{"cost":250,"value":15},"reward_35":{"cost":500,"value":35},"reward_75":{"cost":1000,"value":75}}'::jsonb,
           true
    FROM markets m
    WHERE m.code = 'UK'
    ON CONFLICT (market_id, active) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse dependency order: rule sets reference markets.
  pgm.sql("DROP TABLE IF EXISTS reward_rule_sets;");
  pgm.sql("DROP TABLE IF EXISTS earning_rule_sets;");
  pgm.sql("DROP TABLE IF EXISTS markets;");
}
