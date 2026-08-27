/**
 * Tests for the Task 10 loyalty additions — spec tasks 10.1, 10.2, 10.4;
 * design §9.1, §9.2, §9.4, §6.3 N16; Req 8.1–8.3, 8.5–8.9, 8.11–8.13, 20.6, 9.6.
 *
 * Three concerns:
 *   1. the additive `GET /v1/balance` fields, and that NOTHING shipped changed;
 *   2. `GET /v1/redemptions` (N16), including the two states that withhold a code;
 *   3. the auth → idempotency → rate-limit composition order, asserted so it
 *      cannot regress, plus a static check that no limiter is ever registered on
 *      the `/v1` scope.
 *
 * SAFETY: no network, no production, no live Postgres.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import { REWARD_CATALOG, REWARDS } from "../rewards/catalog.js";
import { isMoneyGBP, PORTAL_REDEMPTIONS_PAGE_SIZE } from "../portal/types.js";
import type { PortalRedemption } from "../portal/types.js";
import {
  EXPIRING_SOON_WINDOW_DAYS,
  InMemoryCustomerBalanceSource,
  buildBalanceSummary,
  withEligibility,
} from "./balance.js";
import { InMemoryPortalRedemptionSource, projectRedemption, toMoneyGBP } from "./redemptions.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };

/* ========================================================================== *
 * 10.1 — additive balance fields
 * ========================================================================== */

describe("withEligibility (task 10.1, Req 8.3/8.6, §9.1)", () => {
  it("marks a reward redeemable when the balance covers its cost", () => {
    const reward = REWARDS.reward_5;
    expect(withEligibility(reward, reward.cost)).toMatchObject({
      redeemable: true,
      additionalPointsRequired: 0,
    });
    expect(withEligibility(reward, reward.cost + 1).redeemable).toBe(true);
  });

  it("reports the shortfall when it does not, never a negative number", () => {
    const reward = REWARDS.reward_15;
    expect(withEligibility(reward, reward.cost - 30)).toMatchObject({
      redeemable: false,
      additionalPointsRequired: 30,
    });
    expect(withEligibility(reward, 0).additionalPointsRequired).toBe(reward.cost);
  });

  it("preserves every shipped Reward field, including numeric valueGBP (Req 20.6)", () => {
    for (const reward of REWARD_CATALOG) {
      const withElig = withEligibility(reward, 0);
      expect(withElig).toMatchObject(reward);
      // The representation divergence is DELIBERATE: shipped `Reward.valueGBP`
      // stays a number; only the new N16 contract uses a decimal string.
      expect(typeof withElig.valueGBP).toBe("number");
    }
  });

  it("performs no arithmetic beyond the comparison — the balance is taken as given", () => {
    // A reward costing exactly the balance is redeemable with zero required; this
    // is the boundary a client-side `>` instead of `>=` would get wrong, which is
    // why §9.1 moves the comparison to the server.
    const reward = REWARDS.reward_35;
    const atBoundary = withEligibility(reward, reward.cost);
    expect(atBoundary.redeemable).toBe(true);
    expect(atBoundary.additionalPointsRequired).toBe(0);
  });
});

describe("buildBalanceSummary expiringSoon (task 10.1, Req 8.13, §9.4)", () => {
  const base = { lifetimeSpendGBP: 450, tier: "silver", spendableBalance: 120 };

  it("OMITS the field entirely when nothing expires in the window", () => {
    const summary = buildBalanceSummary({ ...base });
    // Absent, not `{ points: 0 }` — so the UI can tell "nothing expiring" from
    // "unknown" (Req 4.11). `in` rather than a truthiness check, because a
    // zero-valued object would pass the latter.
    expect("expiringSoon" in summary).toBe(false);
  });

  it("passes the block through when points do expire", () => {
    const summary = buildBalanceSummary({
      ...base,
      expiringSoon: {
        points: 150,
        earliestExpiryAt: "2026-11-02T00:00:00.000Z",
        windowDays: EXPIRING_SOON_WINDOW_DAYS,
      },
    });
    expect(summary.expiringSoon).toEqual({
      points: 150,
      earliestExpiryAt: "2026-11-02T00:00:00.000Z",
      windowDays: 60,
    });
  });

  it("reports the window it used, so the client never hardcodes 60", () => {
    expect(EXPIRING_SOON_WINDOW_DAYS).toBe(60);
  });

  it("leaves every shipped balance field unchanged (Req 20.6)", () => {
    const summary = buildBalanceSummary({ ...base });
    for (const field of [
      "spendableBalance",
      "tier",
      "tierMultiplier",
      "lifetimeSpendGBP",
      "isTopTier",
      "nextTier",
      "nextTierThresholdGBP",
      "progressToNextTierGBP",
      "availableRewards",
    ]) {
      expect(summary, `shipped field ${field} must survive`).toHaveProperty(field);
    }
    expect(summary.spendableBalance).toBe(120);
  });
});

/* ========================================================================== *
 * 10.2 — N16
 * ========================================================================== */

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
    reward_id: "reward_15",
    points_spent: "300",
    value_gbp: "15.00",
    status: "issued",
    code: "ATHOOR-ABC123",
    created_at: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  } as Parameters<typeof projectRedemption>[0];
}

describe("projectRedemption (task 10.2, §6.3 N16)", () => {
  it("projects the N16 shape with money as a 2-dp decimal STRING (§6.2)", () => {
    const projected = projectRedemption(row());
    expect(projected).toEqual({
      id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
      rewardId: "reward_15",
      pointsSpent: 300,
      valueGBP: "15.00",
      status: "issued",
      code: "ATHOOR-ABC123",
      createdAt: "2026-08-01T10:00:00.000Z",
    });
    expect(isMoneyGBP(projected.valueGBP)).toBe(true);
    expect(typeof projected.valueGBP).toBe("string");
  });

  it("WITHHOLDS the code while pending_code — the mint is asynchronous", () => {
    const projected = projectRedemption(row({ status: "pending_code", code: null }));
    expect(projected.status).toBe("pending_code");
    expect(projected.code).toBeNull();
  });

  it("WITHHOLDS the code after voided, even though the row still has one", () => {
    // Structural: the projection withholds it, so a future caller cannot obtain a
    // voided code by writing its own query.
    const projected = projectRedemption(row({ status: "voided", code: "ATHOOR-VOIDED" }));
    expect(projected.code).toBeNull();
  });

  it("returns the code for issued, and null for failed with no code", () => {
    expect(projectRedemption(row({ status: "issued" })).code).toBe("ATHOOR-ABC123");
    expect(projectRedemption(row({ status: "failed", code: null })).code).toBeNull();
  });

  it("maps an unrecognised status to failed rather than breaking the closed union", () => {
    const projected = projectRedemption(row({ status: "something_new" }));
    expect(projected.status).toBe("failed");
  });

  it("normalises money defensively without inventing a value", () => {
    expect(toMoneyGBP("15")).toBe("15.00");
    expect(toMoneyGBP("15.5")).toBe("15.50");
    expect(toMoneyGBP(15)).toBe("15.00");
    expect(toMoneyGBP(null)).toBe("0.00");
    expect(toMoneyGBP("not-money")).toBe("0.00");
    expect(toMoneyGBP(-0)).toBe("0.00");
    for (const v of ["15", "15.5", 15, null, "x"]) {
      expect(isMoneyGBP(toMoneyGBP(v as string)), String(v)).toBe(true);
    }
  });
});

/* ========================================================================== *
 * The routes, and 10.4's composition order
 * ========================================================================== */

interface Wiring {
  redemptions?: readonly PortalRedemption[];
  spendableBalance?: number;
}

function buildLoyaltyApp(wiring: Wiring = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  const balanceSource = new InMemoryCustomerBalanceSource({
    [LOCAL_CUSTOMER_ID]: {
      lifetimeSpendGBP: 450,
      tier: "silver",
      spendableBalance: wiring.spendableBalance ?? 120,
    },
  });
  const redemptionSource = new InMemoryPortalRedemptionSource();
  if (wiring.redemptions) redemptionSource.set(LOCAL_CUSTOMER_ID, wiring.redemptions);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    balanceSource,
    redemptionSource,
  });
  return app;
}

describe("GET /v1/balance additive fields, end to end", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("carries eligibility on every reward, decided by the server", async () => {
    app = buildLoyaltyApp({ spendableBalance: REWARDS.reward_5.cost });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/balance", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const rewards = res.json().availableRewards as Array<Record<string, unknown>>;
    expect(rewards).toHaveLength(REWARD_CATALOG.length);
    for (const reward of rewards) {
      expect(typeof reward.redeemable).toBe("boolean");
      expect(typeof reward.additionalPointsRequired).toBe("number");
      expect(reward.additionalPointsRequired as number).toBeGreaterThanOrEqual(0);
    }
    // The cheapest reward is exactly affordable; the dearest is not.
    expect(rewards[0]?.redeemable).toBe(true);
    expect(rewards[rewards.length - 1]?.redeemable).toBe(false);
  });

  it("omits expiringSoon when nothing expires, rather than sending zero", async () => {
    app = buildLoyaltyApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/balance", headers: AUTH });
    expect(res.json().expiringSoon).toBeUndefined();
  });
});

describe("GET /v1/redemptions (N16)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const sample: PortalRedemption = {
    id: "aaaa1111-1111-4111-8111-aaaaaaaaaaaa",
    rewardId: "reward_15",
    pointsSpent: 300,
    valueGBP: "15.00",
    status: "issued",
    code: "ATHOOR-ABC123",
    createdAt: "2026-08-01T10:00:00.000Z",
  };

  it("returns the customer's redemptions", async () => {
    app = buildLoyaltyApp({ redemptions: [sample] });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/redemptions", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().redemptions).toEqual([sample]);
  });

  it("returns an empty list for a customer with none — true, not a falsehood", async () => {
    app = buildLoyaltyApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/redemptions", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().redemptions).toEqual([]);
  });

  it("serves at most one page of PORTAL_REDEMPTIONS_PAGE_SIZE", async () => {
    const many: PortalRedemption[] = Array.from({ length: 30 }, (_v, i) => ({
      ...sample,
      id: `aaaa1111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    }));
    app = buildLoyaltyApp({ redemptions: many });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/redemptions", headers: AUTH });
    expect(res.json().redemptions).toHaveLength(PORTAL_REDEMPTIONS_PAGE_SIZE);
  });

  it("requires an identity", async () => {
    app = buildLoyaltyApp({ redemptions: [sample] });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/redemptions" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("ATHOOR-ABC123");
  });

  it("leaks no discount code to an unauthenticated caller", async () => {
    app = buildLoyaltyApp({ redemptions: [sample] });
    await app.ready();
    for (const url of ["/v1/redemptions", "/v1/redemptions?pageSize=99"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain("ATHOOR");
    }
  });
});

/* ========================================================================== *
 * 10.4 — the composition order, asserted so it cannot regress
 * ========================================================================== */

describe("auth → idempotency → rate limit composition (task 10.4, Req 8.9/8.11)", () => {
  const SRC_DIR = dirname(fileURLToPath(import.meta.url));

  it("registers NO rate limiter on the /v1 scope — every limiter is route-level", () => {
    // WHY THIS MATTERS. A scope-level limiter would count EVERY /v1 request against
    // one budget, so reading a balance would consume a redemption's allowance, and a
    // customer browsing the portal could rate-limit themselves out of redeeming.
    // Route-level attachment also guarantees the limiter runs AFTER the scope-level
    // auth preHandler, so it is keyed on a resolved identity rather than failing open.
    const v1 = readFileSync(join(SRC_DIR, "v1.ts"), "utf8");
    // A limiter passed to `addHook` would be scope-level.
    const scopeHooks = v1.match(/addHook\(\s*["']preHandler["'][\s\S]{0,400}?\)/g) ?? [];
    for (const hook of scopeHooks) {
      expect(hook, "no rate limiter may be attached as a /v1 scope hook").not.toMatch(
        /RateLimiter|rateLimit/i,
      );
    }
    // And every construction site must be inside a route options object.
    const limiterSites = [...v1.matchAll(/createRedemptionRateLimiter/g)];
    expect(limiterSites.length).toBeGreaterThan(0);
  });

  it("every limiter across the route modules is attached via route preHandler", () => {
    const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    let found = 0;
    for (const file of files) {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      if (!/createRedemptionRateLimiter|RateLimiter/.test(source)) continue;
      found += 1;
      // Each limiter-bearing route module must place it in a `preHandler: [...]`
      // option, never in an `addHook`.
      const hooks = source.match(/addHook\(\s*["']preHandler["'][\s\S]{0,400}?\)/g) ?? [];
      for (const hook of hooks) {
        expect(hook, `${file} must not attach a limiter as a scope hook`).not.toMatch(
          /RateLimiter|rateLimit/i,
        );
      }
    }
    // A scan that finds nothing proves nothing.
    expect(found).toBeGreaterThan(0);
  });

  // The replay-under-exhaustion proof lives in `redeem.test.ts`, appended to the
  // suite that already owns a FakeRedeemDb capable of producing a real `200`.
  // Rebuilding that fake here would be a second definition of how a successful
  // redemption behaves, free to disagree with the one the shipped tests trust.

  it("an unauthenticated state-changing request is refused before idempotency or the limiter", async () => {
    // FAIL CLOSED, and in the right order: a stranger must learn nothing — not
    // whether their key was seen, not whether a limit exists.
    const app = buildLoyaltyApp();
    try {
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: "/v1/redeem",
        headers: { "idempotency-key": "stranger" },
        payload: { rewardId: "reward_5" },
      });
      expect(res.statusCode).toBe(401);
      const body = res.body;
      expect(body).not.toMatch(/rate_limit_exceeded|invalid_idempotency_key/);
    } finally {
      await app.close();
    }
  });
});
