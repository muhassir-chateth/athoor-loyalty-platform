/**
 * Task 11.2 — referral contract tests (design §10.2, Req 10.7, 10.9, 10.16, 21.7).
 *
 * Three things are worth proving here and nothing else is:
 *   1. every awarded/pending stage combination produces the right server-derived
 *      `state`, since the client is forbidden from comparing counts;
 *   2. `creditedPoints` is UNCHANGED by a configuration change while
 *      `currentRewardPoints` follows it — the whole content of Req 10.16 and §9.6;
 *   3. no response on this surface names the referred person, and
 *      `referral_already_claimed` never names the existing referrer (Req 10.7).
 *
 * SAFETY: pure functions and an in-process Fastify app over a fake db. No network,
 * no production, no live Postgres.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REFERRAL_CLAIM_RATE_LIMIT_MAX_REQUESTS,
  REFERRAL_CLAIM_RATE_LIMIT_WINDOW_MS,
  REFERRAL_STAGES,
  buildShareUrl,
  deriveStageState,
} from "./referral.js";
import {
  REFERRAL_PURCHASE_POINTS,
  REFERRAL_PURCHASE_REASON,
  REFERRAL_SIGNUP_POINTS,
  REFERRAL_SIGNUP_REASON,
} from "../referral/referral.js";

/* ========================================================================== *
 * 1 — every stage combination
 * ========================================================================== */

describe("deriveStageState — server-derived, never a client comparison (Req 10.9)", () => {
  it("covers every awarded/pending combination", () => {
    // PENDING WINS when work is outstanding. §10.2's own example shows a stage with
    // awardedCount 1 AND pendingCount 1 reported as "pending", because what the
    // customer needs to see is the opportunity, not the past success.
    const cases: ReadonlyArray<readonly [number, number, string]> = [
      [0, 0, "none"],
      [0, 1, "pending"],
      [0, 5, "pending"],
      [1, 0, "awarded"],
      [3, 0, "awarded"],
      [1, 1, "pending"],
      [2, 3, "pending"],
    ];
    for (const [awarded, pending, expected] of cases) {
      expect(deriveStageState(awarded, pending), `${awarded}/${pending}`).toBe(expected);
    }
  });

  it("is total — no combination yields undefined", () => {
    for (let a = 0; a <= 4; a += 1) {
      for (let p = 0; p <= 4; p += 1) {
        expect(["awarded", "pending", "none"]).toContain(deriveStageState(a, p));
      }
    }
  });
});

/* ========================================================================== *
 * 2 — Req 10.16: configuration moves, history does not
 * ========================================================================== */

describe("creditedPoints vs currentRewardPoints (Req 10.16, §9.6)", () => {
  /**
   * The two numbers come from two different places, and this test states that
   * structurally rather than by mocking a config change.
   *
   * `currentRewardPoints` is read from the ENGINE's constants at response-build
   * time, so it follows a programme change by construction. `creditedPoints` is
   * summed from `ledger_entries` by the SQL, so it cannot follow one — history is a
   * different query. That is why §9.6 says Req 10.16 holds "without any extra
   * mechanism".
   */
  it("takes currentRewardPoints from the engine constants, not a local literal", () => {
    // If someone restated 150/250 here, the programme would have two sources of
    // truth and they would be free to disagree with what is actually awarded.
    const signup = REFERRAL_STAGES.find((s) => s.reason === REFERRAL_SIGNUP_REASON);
    const purchase = REFERRAL_STAGES.find((s) => s.reason === REFERRAL_PURCHASE_REASON);
    expect(signup?.currentRewardPoints).toBe(REFERRAL_SIGNUP_POINTS);
    expect(purchase?.currentRewardPoints).toBe(REFERRAL_PURCHASE_POINTS);
  });

  it("reads creditedPoints from the LEDGER, so a configuration change cannot rewrite it", () => {
    // Asserted on the SQL itself: the credited sums must come from `ledger_entries`
    // filtered by the stage reason, and must NOT reference the point constants. A
    // future edit that computed `awardedCount * currentRewardPoints` instead would
    // silently restate history at today's prices, which is exactly what Req 10.16
    // forbids — and it would pass any test that only checked the number's shape.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "referral.ts"), "utf8");
    const sql = source.slice(
      source.indexOf("const REFERRAL_ADDITIONS_SQL"),
      source.indexOf("interface ReferralAdditionsRow"),
    );
    expect(sql).toContain("FROM ledger_entries");
    expect(sql).toContain("earn_referral");
    // The credited figures are summed, not multiplied out of configuration.
    expect(sql).toMatch(/sum\(points\)/);
    expect(sql).not.toMatch(/REFERRAL_SIGNUP_POINTS|REFERRAL_PURCHASE_POINTS|\b150\b|\b250\b/);
  });

  it("binds the stage reasons rather than interpolating them into SQL", () => {
    // `${...}` in SQL is the pattern `scopedQuery.ts` refuses outright. These are
    // compile-time constants so there is no injection risk, but a codebase that
    // forbids the shape in one layer should not model it in another.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "referral.ts"), "utf8");
    const sql = source.slice(
      source.indexOf("const REFERRAL_ADDITIONS_SQL"),
      source.indexOf("interface ReferralAdditionsRow"),
    );
    expect(sql).not.toContain("${");
    expect(sql).toContain("$2");
    expect(sql).toContain("$3");
  });

  it("scopes every subquery to the caller (Req 10.7, design §4.3 Rule 1)", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "referral.ts"), "utf8");
    const sql = source.slice(
      source.indexOf("const REFERRAL_ADDITIONS_SQL"),
      source.indexOf("interface ReferralAdditionsRow"),
    );
    // Referral rows are reached by `referrer_id` ONLY, so no referred person's row
    // is ever projected — Req 10.7 satisfied structurally, not by remembering to
    // omit columns.
    expect(sql).not.toMatch(/referred_id|referred_email/);
    const subqueries = sql.split("SELECT").slice(2);
    for (const sub of subqueries) {
      expect(sub, `every subquery must be scoped:\n${sub}`).toMatch(
        /(customer_id|referrer_id)\s*=\s*\$1/,
      );
    }
  });
});

/* ========================================================================== *
 * 3 — identifiers only, and no referred person anywhere
 * ========================================================================== */

describe("identifiers, not sentences (Req 21.7, Property 10)", () => {
  it("uses stable identifiers for key and qualification", () => {
    for (const stage of REFERRAL_STAGES) {
      // snake_case identifiers, no spaces, no punctuation a sentence would carry.
      expect(stage.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(stage.qualification).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("names the two approved stages and no others", () => {
    expect(REFERRAL_STAGES.map((s) => s.key)).toEqual([
      "friend_signup",
      "friend_first_purchase",
    ]);
    expect(REFERRAL_STAGES.map((s) => s.qualification)).toEqual([
      "friend_account_created",
      "friend_first_paid_order",
    ]);
  });

  it("never names the existing referrer in referral_already_claimed (Req 10.7)", () => {
    // Asserted on the source, because the value that must not appear is one this
    // handler HAS in scope: the claim path resolves a referrer id before deciding
    // the outcome, so omitting it is a choice that could be reversed by an edit.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "referral.ts"), "utf8");
    const start = source.indexOf('"referral_already_claimed"');
    expect(start).toBeGreaterThan(-1);
    const responseBlock = source.slice(start - 400, start + 400);
    for (const forbidden of ["referrerId", "referrer_id", "referredBy", "existingReferrer"]) {
      expect(responseBlock, `the already-claimed body must not carry ${forbidden}`).not.toMatch(
        new RegExp(`${forbidden}\\s*[,:}]`),
      );
    }
  });
});

/* ========================================================================== *
 * 4 — shareUrl is server-built
 * ========================================================================== */

describe("buildShareUrl (Req 10.11, 10.13)", () => {
  it("builds the link from the domain and the code", () => {
    expect(buildShareUrl("myathoorlondon.com", "ATH-7QK2M")).toBe(
      "https://myathoorlondon.com/?ref=ATH-7QK2M",
    );
  });

  it("tolerates a domain given with a scheme or a trailing slash", () => {
    for (const domain of [
      "https://myathoorlondon.com",
      "http://myathoorlondon.com/",
      "myathoorlondon.com/",
    ]) {
      expect(buildShareUrl(domain, "ATH-1")).toBe("https://myathoorlondon.com/?ref=ATH-1");
    }
  });

  it("percent-encodes the code so a share link cannot be broken by it", () => {
    expect(buildShareUrl("shop.example", "ATH 7QK&2M")).toBe(
      "https://shop.example/?ref=ATH%207QK%262M",
    );
  });
});

/* ========================================================================== *
 * 5 — the claim limiter is route-level, at 5/h
 * ========================================================================== */

describe("POST /v1/referral rate limit (task 11.1)", () => {
  it("is 5 per hour", () => {
    expect(REFERRAL_CLAIM_RATE_LIMIT_MAX_REQUESTS).toBe(5);
    expect(REFERRAL_CLAIM_RATE_LIMIT_WINDOW_MS).toBe(3_600_000);
  });

  it("is attached as a ROUTE preHandler, never as a /v1 scope hook (task 10.4)", () => {
    // A scope-level limiter would make reading a referral summary consume a claim's
    // allowance, and would run before auth had resolved an identity to key on.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "referral.ts"), "utf8");
    expect(source).toMatch(/preHandler:\s*\[referralRateLimiter\]/);
    const hooks = source.match(/addHook\(\s*["']preHandler["'][\s\S]{0,300}?\)/g) ?? [];
    for (const hook of hooks) {
      expect(hook).not.toMatch(/RateLimiter|rateLimit/i);
    }
  });
});
