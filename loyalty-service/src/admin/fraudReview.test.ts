/**
 * Unit tests for the admin fraud-review view (task 17.2, Req 10.6).
 */
import { describe, expect, it } from "vitest";
import {
  buildFraudReviewView,
  referralAwardedPoints,
  referralStatus,
  InMemoryFraudReviewSource,
  type RawReferral,
  type RawRedemption,
} from "./fraudReview.js";
import { REFERRAL_PURCHASE_POINTS, REFERRAL_SIGNUP_POINTS } from "../referral/referral.js";

describe("referralStatus (Req 10.6)", () => {
  it("derives the staged lifecycle status from the reward flags", () => {
    expect(referralStatus(false, false)).toBe("pending");
    expect(referralStatus(true, false)).toBe("signup_rewarded");
    expect(referralStatus(true, true)).toBe("purchase_rewarded");
    // purchase implies the fully-matured status even if signup flag lags
    expect(referralStatus(false, true)).toBe("purchase_rewarded");
  });
});

describe("referralAwardedPoints (Req 10.6)", () => {
  it("sums the staged rewards awarded so far", () => {
    expect(referralAwardedPoints(false, false)).toBe(0);
    expect(referralAwardedPoints(true, false)).toBe(REFERRAL_SIGNUP_POINTS);
    expect(referralAwardedPoints(true, true)).toBe(
      REFERRAL_SIGNUP_POINTS + REFERRAL_PURCHASE_POINTS,
    );
  });
});

describe("buildFraudReviewView (Req 10.6)", () => {
  it("maps each referral and redemption to status/customer/amount/timestamp, most-recent-first", () => {
    const referrals: RawReferral[] = [
      {
        id: "r-old",
        referrerId: "ref-1",
        referredId: "friend-1",
        signupRewarded: true,
        purchaseRewarded: false,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      },
      {
        id: "r-new",
        referrerId: "ref-2",
        referredId: "friend-2",
        signupRewarded: true,
        purchaseRewarded: true,
        createdAt: new Date("2024-05-01T00:00:00.000Z"),
      },
    ];
    const redemptions: RawRedemption[] = [
      {
        id: "d-1",
        customerId: "cust-9",
        rewardId: "reward_15",
        pointsSpent: 250,
        status: "issued",
        createdAt: new Date("2024-03-01T00:00:00.000Z"),
      },
    ];

    const view = buildFraudReviewView(referrals, redemptions);

    // Referrals ordered most-recent-first.
    expect(view.referrals.map((r) => r.id)).toEqual(["r-new", "r-old"]);
    expect(view.referrals[0]).toEqual({
      kind: "referral",
      id: "r-new",
      status: "purchase_rewarded",
      customerId: "ref-2",
      referredCustomerId: "friend-2",
      amount: REFERRAL_SIGNUP_POINTS + REFERRAL_PURCHASE_POINTS,
      timestamp: "2024-05-01T00:00:00.000Z",
    });

    expect(view.redemptions[0]).toEqual({
      kind: "redemption",
      id: "d-1",
      status: "issued",
      customerId: "cust-9",
      rewardId: "reward_15",
      amount: 250,
      timestamp: "2024-03-01T00:00:00.000Z",
    });
  });

  it("returns empty lists when there is nothing to review", () => {
    expect(buildFraudReviewView([], [])).toEqual({ referrals: [], redemptions: [] });
  });
});

describe("InMemoryFraudReviewSource", () => {
  it("returns seeded and appended rows", async () => {
    const source = new InMemoryFraudReviewSource({
      referrals: [
        {
          id: "r1",
          referrerId: "a",
          referredId: "b",
          signupRewarded: false,
          purchaseRewarded: false,
          createdAt: new Date(),
        },
      ],
    });
    source.addRedemption({
      id: "d1",
      customerId: "c",
      rewardId: "reward_5",
      pointsSpent: 100,
      status: "pending_code",
      createdAt: new Date(),
    });
    expect(await source.listReferrals()).toHaveLength(1);
    expect(await source.listRedemptions()).toHaveLength(1);
  });
});
