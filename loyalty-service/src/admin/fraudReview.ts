/**
 * Admin fraud-review view (task 17.2, Requirement 10.6).
 *
 * Requirement 10.6: WHEN an Admin_User opens the fraud-review view, THE
 * Loyalty_Service SHALL display the list of REFERRALS and REDEMPTIONS with, for
 * EACH item, its:
 *   - status                        (where the item stands in its lifecycle);
 *   - associated customer identifier (the customer the item belongs to);
 *   - the point or credit amount     (points involved);
 *   - the timestamp                  (when it was created).
 *
 * Referrals and redemptions are the two staged, reward-bearing flows most
 * exposed to abuse (throwaway accounts farming referral bonuses; discount-code
 * sharing/resale), so they are surfaced side by side for review.
 *
 * STATUS MAPPING.
 *   - Redemptions carry a first-class `status` column
 *     (`pending_code | issued | failed | voided`) — surfaced as-is.
 *   - Referrals have no single status column; their lifecycle is encoded by the
 *     staged `signup_rewarded` / `purchase_rewarded` flags. {@link referralStatus}
 *     derives a readable status:
 *       - neither flag set              → `pending`      (recorded, no reward yet);
 *       - signup rewarded only          → `signup_rewarded`;
 *       - signup + purchase rewarded    → `purchase_rewarded` (fully matured).
 *
 * AMOUNT.
 *   - A redemption's amount is its `points_spent` (the points debited).
 *   - A referral's amount is the referral points AWARDED to the referrer so far:
 *     +150 once signup-rewarded, +250 once purchase-rewarded (Req 2.9/2.10),
 *     computed by {@link referralAwardedPoints}.
 *
 * ASSOCIATED CUSTOMER. For a redemption it is the redeeming customer. For a
 * referral it is the REFERRER (the customer whose balance the reward credits);
 * the referred friend is also carried for review context.
 *
 * Data access is behind an injectable {@link FraudReviewSource} with an
 * in-memory default, mirroring the codebase's source pattern, so the admin
 * surface boots and is unit-testable WITHOUT live Postgres; the Pg-backed
 * source issues read-only SQL only when a real Pool/PoolClient is wired.
 *
 * SAFETY: defining this module touches no live/production system. It performs
 * only read-only SELECTs when a real database is wired.
 */
import type { QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { REFERRAL_PURCHASE_POINTS, REFERRAL_SIGNUP_POINTS } from "../referral/referral.js";

/** The kind of fraud-review item, so a mixed list can be rendered/filtered. */
export type FraudReviewItemKind = "referral" | "redemption";

/** A referral's derived lifecycle status (Req 10.6). */
export type ReferralStatus = "pending" | "signup_rewarded" | "purchase_rewarded";

/** A raw referral row as loaded for fraud review. */
export interface RawReferral {
  id: string;
  /** The referrer's local `customers.id` — the customer credited by the reward. */
  referrerId: string;
  /** The referred friend's local `customers.id`, or null if not yet linked. */
  referredId: string | null;
  signupRewarded: boolean;
  purchaseRewarded: boolean;
  createdAt: Date;
}

/** A raw redemption row as loaded for fraud review. */
export interface RawRedemption {
  id: string;
  customerId: string;
  rewardId: string;
  pointsSpent: number;
  status: string;
  createdAt: Date;
}

/** A referral as shown in the fraud-review list (Req 10.6). */
export interface FraudReviewReferral {
  kind: "referral";
  id: string;
  status: ReferralStatus;
  /** The associated customer (the referrer, whose balance the reward credits). */
  customerId: string;
  /** The referred friend, for review context (may be null). */
  referredCustomerId: string | null;
  /** Referral points awarded to the referrer so far (Req 2.9/2.10). */
  amount: number;
  timestamp: string;
}

/** A redemption as shown in the fraud-review list (Req 10.6). */
export interface FraudReviewRedemption {
  kind: "redemption";
  id: string;
  status: string;
  /** The associated (redeeming) customer. */
  customerId: string;
  rewardId: string;
  /** Points debited by the redemption. */
  amount: number;
  timestamp: string;
}

/** The fraud-review payload: referrals and redemptions side by side (Req 10.6). */
export interface FraudReviewView {
  referrals: FraudReviewReferral[];
  redemptions: FraudReviewRedemption[];
}

/** Derives a referral's readable status from its staged reward flags (pure). */
export function referralStatus(signupRewarded: boolean, purchaseRewarded: boolean): ReferralStatus {
  if (purchaseRewarded) {
    return "purchase_rewarded";
  }
  if (signupRewarded) {
    return "signup_rewarded";
  }
  return "pending";
}

/**
 * Computes the referral points awarded to the referrer so far (pure, Req
 * 2.9/2.10): +150 once signup-rewarded and a further +250 once
 * purchase-rewarded.
 */
export function referralAwardedPoints(signupRewarded: boolean, purchaseRewarded: boolean): number {
  return (
    (signupRewarded ? REFERRAL_SIGNUP_POINTS : 0) +
    (purchaseRewarded ? REFERRAL_PURCHASE_POINTS : 0)
  );
}

/** Projects a raw referral into its fraud-review shape (pure, Req 10.6). */
export function mapFraudReviewReferral(row: RawReferral): FraudReviewReferral {
  return {
    kind: "referral",
    id: row.id,
    status: referralStatus(row.signupRewarded, row.purchaseRewarded),
    customerId: row.referrerId,
    referredCustomerId: row.referredId,
    amount: referralAwardedPoints(row.signupRewarded, row.purchaseRewarded),
    timestamp: row.createdAt.toISOString(),
  };
}

/** Projects a raw redemption into its fraud-review shape (pure, Req 10.6). */
export function mapFraudReviewRedemption(row: RawRedemption): FraudReviewRedemption {
  return {
    kind: "redemption",
    id: row.id,
    status: row.status,
    customerId: row.customerId,
    rewardId: row.rewardId,
    amount: row.pointsSpent,
    timestamp: row.createdAt.toISOString(),
  };
}

/**
 * Builds the fraud-review view from raw rows (pure). Both lists are ordered
 * most-recent-first so the newest activity — most relevant to fraud review —
 * surfaces first.
 */
export function buildFraudReviewView(
  referrals: readonly RawReferral[],
  redemptions: readonly RawRedemption[],
): FraudReviewView {
  const byCreatedDesc = <T extends { createdAt: Date; id: string }>(a: T, b: T): number => {
    const byDate = b.createdAt.getTime() - a.createdAt.getTime();
    if (byDate !== 0) {
      return byDate;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  };
  return {
    referrals: [...referrals].sort(byCreatedDesc).map(mapFraudReviewReferral),
    redemptions: [...redemptions].sort(byCreatedDesc).map(mapFraudReviewRedemption),
  };
}

/**
 * Loads the referral and redemption rows for the fraud-review view (Req 10.6).
 * Injectable so the route is unit-testable with an in-memory fake and needs no
 * live Postgres.
 */
export interface FraudReviewSource {
  listReferrals(): Promise<RawReferral[]>;
  listRedemptions(): Promise<RawRedemption[]>;
}

const SELECT_REFERRALS_SQL = `
  SELECT id, referrer_id, referred_id, signup_rewarded, purchase_rewarded, created_at
  FROM referrals
  ORDER BY created_at DESC, id DESC
`;

const SELECT_REDEMPTIONS_SQL = `
  SELECT id, customer_id, reward_id, points_spent, status, created_at
  FROM redemptions
  ORDER BY created_at DESC, id DESC
`;

interface ReferralDbRow extends QueryResultRow {
  id: string;
  referrer_id: string;
  referred_id: string | null;
  signup_rewarded: boolean;
  purchase_rewarded: boolean;
  created_at: Date;
}

interface RedemptionDbRow extends QueryResultRow {
  id: string;
  customer_id: string;
  reward_id: string;
  points_spent: string | number;
  status: string;
  created_at: Date;
}

function parseIntegerColumn(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Postgres-backed {@link FraudReviewSource}: reads all referrals and
 * redemptions, most-recent-first. Read-only.
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing.
 */
export class PgFraudReviewSource implements FraudReviewSource {
  constructor(private readonly db: Queryable) {}

  async listReferrals(): Promise<RawReferral[]> {
    const result = await this.db.query<ReferralDbRow>(SELECT_REFERRALS_SQL);
    return result.rows.map((row) => ({
      id: row.id,
      referrerId: row.referrer_id,
      referredId: row.referred_id,
      signupRewarded: row.signup_rewarded,
      purchaseRewarded: row.purchase_rewarded,
      createdAt: row.created_at,
    }));
  }

  async listRedemptions(): Promise<RawRedemption[]> {
    const result = await this.db.query<RedemptionDbRow>(SELECT_REDEMPTIONS_SQL);
    return result.rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      rewardId: row.reward_id,
      pointsSpent: parseIntegerColumn(row.points_spent),
      status: row.status,
      createdAt: row.created_at,
    }));
  }
}

/**
 * In-memory {@link FraudReviewSource} for local runs and tests: returns the
 * referrals/redemptions it was seeded with, so the fraud-review view runs with
 * no live Postgres.
 */
export class InMemoryFraudReviewSource implements FraudReviewSource {
  private referrals: RawReferral[];
  private redemptions: RawRedemption[];

  constructor(seed: { referrals?: RawReferral[]; redemptions?: RawRedemption[] } = {}) {
    this.referrals = [...(seed.referrals ?? [])];
    this.redemptions = [...(seed.redemptions ?? [])];
  }

  async listReferrals(): Promise<RawReferral[]> {
    return [...this.referrals];
  }

  async listRedemptions(): Promise<RawRedemption[]> {
    return [...this.redemptions];
  }

  /** Test/setup helper: append a referral row. */
  addReferral(referral: RawReferral): void {
    this.referrals.push(referral);
  }

  /** Test/setup helper: append a redemption row. */
  addRedemption(redemption: RawRedemption): void {
    this.redemptions.push(redemption);
  }
}
