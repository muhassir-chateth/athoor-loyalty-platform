/**
 * Market-config drift detection (task 32) — Req 21.1, 21.2, 21.3, 21.4, 21.6.
 *
 * ── THE DECISION THIS MODULE ENFORCES ────────────────────────────────────────
 * Requirement 21 asks the platform to **structure** earning and reward
 * configuration so per-market rule sets and currency conversion **can be added**
 * without redesigning the ledger. It does not require the engine to READ that
 * configuration at runtime, and the owner's decision (task 32) is that the
 * hardcoded constants — `DEFAULT_TIER_RULES` and `REWARDS` — remain the MVP
 * source of truth, with `markets` / `earning_rule_sets` / `reward_rule_sets` and
 * `DbMarketConfigProvider` retained as the proven forward path for a second
 * market. One GBP market, no second market planned, and wiring the provider into
 * the earning and redemption paths would add a way for a data edit to abort a
 * money transaction in exchange for editing four numbers without a deploy.
 *
 * ── WHY A DETECTOR IS STILL NEEDED ───────────────────────────────────────────
 * That decision creates a hazard: two representations of the same rules now
 * exist, and only one of them is obeyed. `migrations.market-config.test.ts`
 * already asserts the seed DEFINITIONS in code match the constants, but nothing
 * checks the ROWS actually in the database. The seed inserts with
 * `ON CONFLICT DO NOTHING`, so a hand-edited row — or a constant changed in code
 * after the seed ran — leaves the table quietly disagreeing with live behaviour.
 * An operator reading `earning_rule_sets` would then draw a false conclusion
 * about how the service is behaving, which is exactly the class of silent
 * divergence this codebase has been bitten by before.
 *
 * So the deviation is MACHINE-CHECKED rather than merely written down (the same
 * treatment task 29 gave the backup posture): this module compares the configured
 * rows against the constants the engine actually uses and publishes the result on
 * `/health`, where the keep-alive watchdog can see it.
 *
 * A drift finding is INFORMATIONAL, never fatal: the engine's behaviour does not
 * depend on these rows, so drift means "the table is misleading", not "the
 * service is wrong". Reporting it must never fail a request or a liveness probe.
 *
 * This is also the first production call site for `DbMarketConfigProvider`,
 * strictly read-only — the provider is exercised in production without any
 * engine reading its output for a decision.
 *
 * SAFETY: pure comparison plus one read-only provider call. Touches no ledger
 * table, writes nothing, and calls no Shopify API.
 */
import { DEFAULT_MARKET_CONFIG, type MarketConfig, type MarketConfigProvider } from "./marketConfig.js";
import { TIERS } from "../tier/tier.js";
import { REWARD_IDS } from "../rewards/catalog.js";

/** How the engine actually decides thresholds, multipliers and reward costs. */
export const RULE_SOURCE_OF_TRUTH = "constants" as const;

/** The outcome of comparing configured rows against the engine's constants. */
export interface MarketConfigDriftReport {
  /** Always `"constants"` at MVP — states plainly what the engine obeys. */
  source: typeof RULE_SOURCE_OF_TRUTH;
  /** True when any configured value differs from the constant the engine uses. */
  drifted: boolean;
  /**
   * One human-readable line per difference, naming the field, the configured
   * value and the constant. Empty when there is no drift. Capped so a wildly
   * malformed row cannot produce an unbounded health payload.
   */
  differences: string[];
  /**
   * Set when the configuration could not be read or parsed at all (e.g. a
   * malformed JSONB rule set, which `DbMarketConfigProvider` rejects). Treated as
   * drift, because an unreadable rule set is at least as misleading as a wrong
   * one.
   */
  error?: string;
}

/** Upper bound on reported differences, so the health payload stays small. */
const MAX_REPORTED_DIFFERENCES = 20;

/**
 * Compares a resolved {@link MarketConfig} against {@link DEFAULT_MARKET_CONFIG}
 * — which is derived from `DEFAULT_TIER_RULES` and `REWARDS`, so it IS the
 * constants the engine uses. Pure.
 *
 * Currency and market code are compared too: a market row switched to another
 * currency while every threshold stays numerically identical is precisely the
 * misleading state worth surfacing, because the engine would keep treating those
 * numbers as GBP (A8).
 */
export function evaluateMarketConfigDrift(config: MarketConfig): MarketConfigDriftReport {
  const differences: string[] = [];
  const expected = DEFAULT_MARKET_CONFIG;

  const note = (line: string): void => {
    if (differences.length < MAX_REPORTED_DIFFERENCES) {
      differences.push(line);
    }
  };

  if (config.market.currency !== expected.market.currency) {
    note(
      `market.currency configured '${config.market.currency}' but the engine denominates in ` +
        `'${expected.market.currency}' (A8)`,
    );
  }
  if (config.earning.currency !== expected.earning.currency) {
    note(
      `earning.currency configured '${config.earning.currency}' but thresholds are read as ` +
        `'${expected.earning.currency}'`,
    );
  }
  if (config.reward.currency !== expected.reward.currency) {
    note(
      `reward.currency configured '${config.reward.currency}' but reward values are read as ` +
        `'${expected.reward.currency}'`,
    );
  }

  for (const tier of TIERS) {
    const configuredThreshold = config.earning.rules.thresholds[tier];
    const expectedThreshold = expected.earning.rules.thresholds[tier];
    if (configuredThreshold !== expectedThreshold) {
      note(
        `earning.thresholds.${tier} configured ${configuredThreshold} but the engine uses ` +
          `${expectedThreshold}`,
      );
    }
    const configuredMultiplier = config.earning.rules.multipliers[tier];
    const expectedMultiplier = expected.earning.rules.multipliers[tier];
    if (configuredMultiplier !== expectedMultiplier) {
      note(
        `earning.multipliers.${tier} configured ${configuredMultiplier} but the engine uses ` +
          `${expectedMultiplier}`,
      );
    }
  }

  for (const id of REWARD_IDS) {
    const configured = config.reward.rewardsById[id];
    const expectedReward = expected.reward.rewardsById[id];
    if (!configured) {
      note(`reward.${id} is missing from the configured reward map`);
      continue;
    }
    if (configured.cost !== expectedReward.cost) {
      note(`reward.${id}.cost configured ${configured.cost} but the engine uses ${expectedReward.cost}`);
    }
    if (configured.valueGBP !== expectedReward.valueGBP) {
      note(
        `reward.${id}.value configured ${configured.valueGBP} but the engine uses ` +
          `${expectedReward.valueGBP}`,
      );
    }
  }

  return {
    source: RULE_SOURCE_OF_TRUTH,
    drifted: differences.length > 0,
    differences,
  };
}

/** Read-only view of configured-versus-obeyed rules, surfaced on `/health`. */
export interface MarketConfigDriftSource {
  report(): Promise<MarketConfigDriftReport>;
}

/**
 * Reads the active market configuration through the EXISTING
 * {@link MarketConfigProvider} and reports drift against the constants.
 *
 * A provider failure (unreadable or malformed rule set) is reported as drift
 * with the reason attached rather than thrown: the engine does not depend on
 * these rows, so this check must never break the caller. That is also why the
 * report is honest about the failure instead of quietly claiming "no drift".
 */
export class ProviderMarketConfigDriftSource implements MarketConfigDriftSource {
  constructor(private readonly provider: MarketConfigProvider) {}

  async report(): Promise<MarketConfigDriftReport> {
    let config: MarketConfig;
    try {
      config = await this.provider.loadActiveMarketConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        source: RULE_SOURCE_OF_TRUTH,
        drifted: true,
        differences: ["the configured rule set could not be read"],
        error: message,
      };
    }
    return evaluateMarketConfigDrift(config);
  }
}
