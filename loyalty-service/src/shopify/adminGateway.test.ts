/**
 * Unit tests for the Shopify Admin Gateway (task 5.3).
 *
 * No live/production Shopify Admin API is touched: the gateway is exercised
 * against a fake {@link ShopifyAdminClient} whose responses (success, throttle,
 * hard failure) are scripted per-attempt, a fake {@link Sleeper} that records
 * the backoff delays without waiting, and a fake {@link Clock} the test drives
 * to control the 60-second hard-failure window.
 *
 * Covers:
 *   - the exact backoff schedule (1s doubling, 60s cap) — Req 13.2;
 *   - retry-then-succeed on throttling — Req 13.3;
 *   - throttle exhaustion after 10 attempts -> AdminThrottleExhaustedError — Req 13.4;
 *   - 3 consecutive hard failures within 60s -> AdminApiFailureError — Req 3.9;
 *   - a success resets the consecutive hard-failure streak.
 */
import { describe, expect, it } from "vitest";
import {
  AdminApiFailureError,
  AdminThrottleExhaustedError,
  backoffDelayMs,
  DEFAULT_BACKOFF,
  ShopifyAdminGateway,
  ShopifyThrottleError,
  type DiscountCode,
  type DiscountInput,
  type ShopifyAdminClient,
} from "./adminGateway.js";

const INPUT: DiscountInput = {
  customerGid: "gid://shopify/Customer/123",
  amountOffGBP: 5,
  code: "ATH-9F3K-2QX7",
  usageLimit: 1,
  appliesOncePerCustomer: true,
  redemptionId: "redemption-1",
};

const OK: DiscountCode = {
  code: INPUT.code,
  shopifyPriceRuleId: 111,
  shopifyDiscountId: 222,
  amountOffGBP: 5,
};

/** A client whose per-call behaviour is scripted: each entry is what call N does. */
type Step = "ok" | "throttle" | "fail";

function scriptedClient(steps: Step[]): { client: ShopifyAdminClient; calls: () => number } {
  let i = 0;
  const client: ShopifyAdminClient = {
    async createSingleUseDiscount(): Promise<DiscountCode> {
      const step = steps[i] ?? steps[steps.length - 1] ?? "ok";
      i += 1;
      if (step === "throttle") {
        throw new ShopifyThrottleError();
      }
      if (step === "fail") {
        throw new Error("boom: admin api hard failure");
      }
      return OK;
    },
  };
  return { client, calls: () => i };
}

/** A recording sleeper that never actually waits. */
function recordingSleeper(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    async sleep(ms: number): Promise<void> {
      delays.push(ms);
    },
  };
}

describe("backoffDelayMs (Req 13.2: 1s initial, doubling, 60s cap)", () => {
  it("doubles from 1s and caps at 60s", () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(4)).toBe(8000);
    expect(backoffDelayMs(5)).toBe(16000);
    expect(backoffDelayMs(6)).toBe(32000);
    // 64000 would exceed the cap → clamped to 60000.
    expect(backoffDelayMs(7)).toBe(60000);
    expect(backoffDelayMs(8)).toBe(60000);
    expect(backoffDelayMs(10)).toBe(60000);
  });

  it("rejects non-positive attempts", () => {
    expect(() => backoffDelayMs(0)).toThrow(RangeError);
    expect(() => backoffDelayMs(-1)).toThrow(RangeError);
  });
});

describe("ShopifyAdminGateway: success paths", () => {
  it("returns the minted code on the first successful call with no backoff", async () => {
    const { client, calls } = scriptedClient(["ok"]);
    const { sleep, delays } = recordingSleeper();
    const gw = new ShopifyAdminGateway(client, { sleep, now: () => 0 });

    const result = await gw.createSingleUseDiscount(INPUT);

    expect(result).toEqual(OK);
    expect(calls()).toBe(1);
    expect(delays).toHaveLength(0);
  });
});

describe("ShopifyAdminGateway: throttling (Req 13.2 / 13.3)", () => {
  it("retries on throttle with the exact backoff schedule, then succeeds", async () => {
    const { client, calls } = scriptedClient(["throttle", "throttle", "ok"]);
    const { sleep, delays } = recordingSleeper();
    const gw = new ShopifyAdminGateway(client, { sleep, now: () => 0 });

    const result = await gw.createSingleUseDiscount(INPUT);

    expect(result).toEqual(OK);
    expect(calls()).toBe(3);
    // Backoff before attempt 2 (1s) and before attempt 3 (2s).
    expect(delays).toEqual([1000, 2000]);
  });

  it("throws AdminThrottleExhaustedError after 10 throttled attempts (Req 13.4)", async () => {
    const { client, calls } = scriptedClient(["throttle"]); // always throttle
    const { sleep, delays } = recordingSleeper();
    const gw = new ShopifyAdminGateway(client, { sleep, now: () => 0 });

    await expect(gw.createSingleUseDiscount(INPUT)).rejects.toBeInstanceOf(
      AdminThrottleExhaustedError,
    );
    // Exactly maxAttempts calls, and one fewer sleep than attempts (no sleep after the last).
    expect(calls()).toBe(DEFAULT_BACKOFF.maxAttempts);
    expect(delays).toHaveLength(DEFAULT_BACKOFF.maxAttempts - 1);
  });
});

describe("ShopifyAdminGateway: hard failures (Req 3.9)", () => {
  it("throws AdminApiFailureError on 3 consecutive failures within 60s", async () => {
    const { client, calls } = scriptedClient(["fail", "fail", "fail"]);
    const { sleep } = recordingSleeper();
    // Clock stays within the 60s window across the streak.
    let t = 0;
    const now = (): number => {
      const v = t;
      t += 1000; // 1s between observations, well within 60s
      return v;
    };
    const gw = new ShopifyAdminGateway(client, { sleep, now });

    const err = await gw.createSingleUseDiscount(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiFailureError);
    expect((err as AdminApiFailureError).withinWindow).toBe(true);
    expect((err as AdminApiFailureError).consecutiveFailures).toBe(3);
    // Stops at the 3rd consecutive failure — does not exhaust all 10 attempts.
    expect(calls()).toBe(3);
  });

  it("resets the consecutive streak after an intervening throttle", async () => {
    // fail, fail, throttle (resets), fail, ok  → never 3 consecutive fails.
    const { client, calls } = scriptedClient(["fail", "fail", "throttle", "fail", "ok"]);
    const { sleep } = recordingSleeper();
    const gw = new ShopifyAdminGateway(client, { sleep, now: () => 0 });

    const result = await gw.createSingleUseDiscount(INPUT);
    expect(result).toEqual(OK);
    expect(calls()).toBe(5);
  });
});
