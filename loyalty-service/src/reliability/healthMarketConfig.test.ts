/**
 * `/health` publishes the market-config posture (task 32, Req 21.6a, A18).
 *
 * The point of the block is that an operator reading `earning_rule_sets` cannot
 * be misled about live behaviour: `/health` names the source of truth and says
 * whether the retained rows still agree with it. These tests pin that contract at
 * the HTTP boundary, and pin the guarantee that matters most — a drifted or
 * unreadable rule set never degrades liveness, because no engine decision depends
 * on those rows.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ProviderMarketConfigDriftSource } from "../markets/configDrift.js";
import { StaticMarketConfigProvider, DEFAULT_MARKET_CONFIG } from "../markets/marketConfig.js";
import type { MarketConfigDriftSource } from "../markets/configDrift.js";

const config = () => loadConfig({ NODE_ENV: "test" });

describe("/health marketConfig block", () => {
  it("reports source 'constants' and no drift for the as-seeded configuration", async () => {
    const app = buildApp(config(), {
      marketConfigDrift: new ProviderMarketConfigDriftSource(new StaticMarketConfigProvider()),
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      marketConfig: { source: "constants", drifted: false, differences: [] },
    });
    await app.close();
  });

  it("reports drift, naming the field, without affecting liveness", async () => {
    const drifted = {
      ...DEFAULT_MARKET_CONFIG,
      earning: {
        currency: "GBP",
        rules: {
          thresholds: { ...DEFAULT_MARKET_CONFIG.earning.rules.thresholds, gold: 700 },
          multipliers: { ...DEFAULT_MARKET_CONFIG.earning.rules.multipliers },
        },
      },
    };
    const app = buildApp(config(), {
      marketConfigDrift: new ProviderMarketConfigDriftSource(new StaticMarketConfigProvider(drifted)),
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    // Still ok: the engine reads the constants, so a diverged row is misleading,
    // not broken. The whole value is that it is now visible.
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.json().marketConfig.drifted).toBe(true);
    expect(res.json().marketConfig.differences.join(" ")).toContain("earning.thresholds.gold");
    await app.close();
  });

  it("keeps answering ok when the drift check itself throws", async () => {
    const exploding: MarketConfigDriftSource = {
      report: async () => {
        throw new Error("rule-set tables unavailable");
      },
    };
    const app = buildApp(config(), { marketConfigDrift: exploding });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    // The block is omitted rather than reported as a false "no drift".
    expect("marketConfig" in res.json()).toBe(false);
    await app.close();
  });

  it("omits the block entirely when no drift source is wired (payload unchanged)", async () => {
    const app = buildApp(config(), {});
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect("marketConfig" in res.json()).toBe(false);
    await app.close();
  });
});
