/**
 * Referral code, staged referral rewards, and self-referral guards (task 11.1).
 *
 * Implements the referral rules of the Loyalty Engine (design.md
 * "Component 2: Loyalty Engine" `earnReferral`; the webhook table rows
 * `customers/create → … create referral_code; if referred_by present, create
 * referrals row` and `orders/paid → … advance referral stage`). It owns all
 * writes to the `referrals` table and the `earn_referral` ledger movements, and
 * it is the sole place the staged referral rewards are decided.
 *
 * Requirements covered:
 *   - 2.9   WHEN a referred friend completes signup, create a referral earning
 *           of exactly 150 points for the referrer.
 *   - 2.10  WHEN a referred friend completes their first paid purchase, create a
 *           referral earning of exactly 250 points for the referrer.
 *   - 11.8  IF a referral is submitted where referrer and referred are the same,
 *           reject it, create no earning, and leave all balances unchanged
 *           (DB `CHECK (referrer_id <> referred_id)` + the `referred_by` guard).
 *           *(Property 12)*
 *   - 11.9  WHEN a referred friend makes their first paid purchase, award the
 *           referral first-purchase reward EXACTLY ONCE, and NEVER award it if
 *           the referred friend has any prior paid purchase.
 *
 * Both staged rewards are awarded to the REFERRER (only the referrer's balance
 * changes, Req 2.11) and each is awarded at most once — the signup reward is
 * guarded by the `referrals.signup_rewarded` flag and a `(referrer, referred)`
 * uniqueness check, the first-purchase reward by the `referrals.purchase_rewarded`
 * flag plus the caller-supplied "is this the friend's first paid purchase" fact
 * (Req 11.9).
 *
 * ---------------------------------------------------------------------------
 * Wiring boundary
 * ---------------------------------------------------------------------------
 * This module is the referral engine. The signup / order earning flows
 * (`src/earning/signup.ts`, `src/earning/order.ts`) are owned by concurrent
 * tasks and are NOT edited here. Instead this module exposes functions the
 * engine wiring calls from inside the same webhook transaction:
 *   - {@link assignReferralCode}      — give a new customer a referral code.
 *   - {@link resolveReferrerByCode}   — map an invite code to a referrer id.
 *   - {@link recordReferralOnSignup}  — record the `referrals` row and award the
 *                                       referrer +150 on the friend's signup.
 *   - {@link awardReferralFirstPurchase} — award the referrer +250 on the
 *                                       friend's first paid purchase.
 * Each takes a {@link Queryable} executor so it runs within the caller's
 * transaction, exactly like the signup / order modules.
 *
 * SAFETY: defining this module touches no live/production system and calls no
 * Shopify Admin API. It issues SQL only when a caller passes a real
 * Pool/PoolClient (or transaction client) at runtime; all logic is unit tested
 * against an in-memory {@link Queryable} fake, so live DB verification is
 * deferred to deploy time.
 */
import { randomInt } from "node:crypto";
import type { LedgerEntry, LedgerRepository, Queryable } from "../ledger/repository.js";

/** The exact referral signup reward for the referrer (Requirement 2.9). */
export const REFERRAL_SIGNUP_POINTS = 150 as const;

/** The exact referral first-purchase reward for the referrer (Requirement 2.10). */
export const REFERRAL_PURCHASE_POINTS = 250 as const;

/** Reason recorded on the friend-signup `earn_referral` entry. */
export const REFERRAL_SIGNUP_REASON = "referral_signup_bonus" as const;

/** Reason recorded on the friend-first-purchase `earn_referral` entry. */
export const REFERRAL_PURCHASE_REASON = "referral_first_purchase_bonus" as const;

/**
 * Referral-code alphabet: unambiguous, excludes the visually confusable
 * characters `I`, `O`, `0`, `1` so shared codes are hard to mistype.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PREFIX = "ATH";
const CODE_SEGMENT_LENGTH = 4;
/** Attempts to assign a collision-free referral code before giving up. */
const MAX_CODE_ATTEMPTS = 10;

/**
 * Generates a random, human-shareable referral code of the form
 * `ATH-XXXX-XXXX` (design.md example `ATH-9F3K-…`). Uses a cryptographically
 * strong RNG. Purely functional — persistence and collision handling live in
 * {@link assignReferralCode}.
 */
export function generateReferralCode(): string {
  const segment = (): string => {
    let out = "";
    for (let i = 0; i < CODE_SEGMENT_LENGTH; i += 1) {
      out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return out;
  };
  return `${CODE_PREFIX}-${segment()}-${segment()}`;
}

/** Thrown when a referral operation is given a malformed customer identifier. */
export class InvalidReferralInputError extends Error {
  readonly code = "invalid_referral_input";
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferralInputError";
  }
}

/** Postgres unique-violation SQLSTATE — a code collision on `referral_code`. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * Assigns the customer their referral code if they do not already have one and
 * returns the effective code (Req 2.9 / design "create referral_code" on
 * signup). Idempotent: a customer who already has a code keeps it, so a replayed
 * `customers/create` never rotates the code. Collision-safe: on the (rare)
 * `referral_code` unique violation a fresh code is generated and retried.
 *
 * Only the one target customer row is touched.
 *
 * @param executor the transaction client to run within.
 * @param customerId the local `customers.id` of the new customer.
 * @param generate injectable code generator (defaults to {@link generateReferralCode}).
 */
export async function assignReferralCode(
  executor: Queryable,
  customerId: string,
  generate: () => string = generateReferralCode,
): Promise<string> {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    throw new InvalidReferralInputError("assignReferralCode requires a customer id.");
  }

  // If the customer already has a code, keep it (idempotent on replay).
  const existing = await executor.query<{ referral_code: string | null }>(
    `SELECT referral_code FROM customers WHERE id = $1`,
    [customerId],
  );
  const current = existing.rows[0]?.referral_code;
  if (current) {
    return current;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const candidate = generate();
    try {
      const updated = await executor.query<{ referral_code: string }>(
        `UPDATE customers
           SET referral_code = $2, updated_at = now()
         WHERE id = $1 AND referral_code IS NULL
         RETURNING referral_code`,
        [customerId, candidate],
      );
      const assigned = updated.rows[0]?.referral_code;
      if (assigned) {
        return assigned;
      }
      // rowCount 0 → another writer set a code between our SELECT and UPDATE;
      // re-read and return theirs.
      const reread = await executor.query<{ referral_code: string | null }>(
        `SELECT referral_code FROM customers WHERE id = $1`,
        [customerId],
      );
      const now = reread.rows[0]?.referral_code;
      if (now) {
        return now;
      }
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      // Code already taken by another customer — try a new one.
      lastError = err;
    }
  }
  throw new InvalidReferralInputError(
    `Could not assign a unique referral code after ${MAX_CODE_ATTEMPTS} attempts.` +
      (lastError ? ` Last collision: ${String((lastError as Error).message ?? lastError)}` : ""),
  );
}

/**
 * Resolves an invite/referral code to the referrer's local `customers.id`, or
 * `null` when no customer owns that code. Used by the engine wiring to turn a
 * `referred_by` code carried on a friend's signup into a referrer id.
 */
export async function resolveReferrerByCode(
  executor: Queryable,
  referralCode: string | null | undefined,
): Promise<string | null> {
  if (typeof referralCode !== "string" || referralCode.trim() === "") {
    return null;
  }
  const found = await executor.query<{ id: string }>(
    `SELECT id FROM customers WHERE referral_code = $1 LIMIT 1`,
    [referralCode.trim()],
  );
  return found.rows[0]?.id ?? null;
}

/** Input to {@link recordReferralOnSignup}. */
export interface ReferralSignupInput {
  /** The new friend's resolved local `customers.id`. */
  referredCustomerId: string;
  /**
   * The referrer's resolved local `customers.id`, if the friend arrived with a
   * `referred_by` code. Absent/null means there is no referrer and no reward.
   */
  referrerId?: string | null;
  /** The friend's email, recorded on the `referrals` row for fraud review. */
  referredEmail?: string | null;
  /** X-Shopify-Webhook-Id, recorded on the ledger entry for traceability. */
  sourceEventId?: string | null;
}

/**
 * Outcome of the signup-side referral handling.
 *  - `rewarded`               referrals row created + referrer credited +150.
 *  - `no_referrer`            the friend arrived without a referrer; nothing done.
 *  - `self_referral_rejected` referrer === referred; no row, no earning (Req 11.8).
 *  - `already_rewarded`       a referral for this pair was already signup-rewarded.
 */
export type ReferralSignupOutcome =
  | { status: "rewarded"; referrerId: string; referredCustomerId: string; referralId: string; entry: LedgerEntry }
  | { status: "no_referrer"; referredCustomerId: string }
  | { status: "self_referral_rejected"; referredCustomerId: string }
  | { status: "already_rewarded"; referrerId: string; referredCustomerId: string; referralId: string };

interface ReferralRow {
  id: string;
  signup_rewarded: boolean;
  purchase_rewarded: boolean;
}

/**
 * Records the referral relationship for a freshly-signed-up friend and awards
 * the referrer the +150 signup reward exactly once (Requirements 2.9, 11.8;
 * Property 12).
 *
 * Flow (all within the caller's transaction):
 *   1. No `referrerId` → `no_referrer`; nothing is written (a friend who was not
 *      referred simply has no referral).
 *   2. Self-referral guard: `referrerId === referredCustomerId` → reject with
 *      `self_referral_rejected`, creating NO `referrals` row and NO earning
 *      (Req 11.8). The DB `CHECK (referrer_id <> referred_id)` is the backstop.
 *   3. Idempotency: if a `(referrer, referred)` referral already exists and was
 *      signup-rewarded, return `already_rewarded` and change nothing.
 *   4. Set the friend's `customers.referred_by` (guarded so it is never self and
 *      is only set once).
 *   5. Insert the `referrals` row with `signup_rewarded = true`.
 *   6. Append exactly one +150 `earn_referral` entry for the REFERRER.
 *
 * @param repo the append-only ledger repository (the only sanctioned writer).
 * @param input the referred/referrer ids (+ optional email / event id).
 * @param executor the transaction client the whole flow runs within.
 */
export async function recordReferralOnSignup(
  repo: LedgerRepository,
  input: ReferralSignupInput,
  executor: Queryable,
): Promise<ReferralSignupOutcome> {
  const referredCustomerId = input.referredCustomerId;
  if (typeof referredCustomerId !== "string" || referredCustomerId.trim() === "") {
    throw new InvalidReferralInputError("recordReferralOnSignup requires a referred customer id.");
  }

  const referrerId = input.referrerId ?? null;

  // (1) No referrer → nothing to record or reward.
  if (!referrerId) {
    return { status: "no_referrer", referredCustomerId };
  }

  // (2) Self-referral guard (Req 11.8, Property 12): reject BEFORE any write, so
  // no `referrals` row and no `earn_referral` entry are ever created for a
  // customer referring themselves. The DB CHECK is the defence-in-depth backstop.
  if (referrerId === referredCustomerId) {
    return { status: "self_referral_rejected", referredCustomerId };
  }

  // (3) Idempotency: has this (referrer, referred) pair already been recorded?
  const existing = await executor.query<ReferralRow>(
    `SELECT id, signup_rewarded, purchase_rewarded
       FROM referrals
      WHERE referrer_id = $1 AND referred_id = $2
      LIMIT 1`,
    [referrerId, referredCustomerId],
  );
  const existingRow = existing.rows[0];
  if (existingRow && existingRow.signup_rewarded) {
    return {
      status: "already_rewarded",
      referrerId,
      referredCustomerId,
      referralId: existingRow.id,
    };
  }

  // (4) Record the friend's referred_by (only when unset and never self).
  await executor.query(
    `UPDATE customers
       SET referred_by = $2, updated_at = now()
     WHERE id = $1 AND referred_by IS NULL AND id <> $2`,
    [referredCustomerId, referrerId],
  );

  // (5) Insert the referrals row (signup stage complete).
  const insertedRow = existingRow
    ? existingRow
    : (
        await executor.query<ReferralRow>(
          `INSERT INTO referrals
             (referrer_id, referred_id, referred_email, signup_rewarded, purchase_rewarded)
           VALUES ($1, $2, $3, true, false)
           RETURNING id, signup_rewarded, purchase_rewarded`,
          [referrerId, referredCustomerId, input.referredEmail ?? null],
        )
      ).rows[0];

  if (!insertedRow) {
    throw new InvalidReferralInputError("Failed to record the referrals row for the signup reward.");
  }

  // If the row pre-existed but had not been signup-rewarded, mark it now.
  if (existingRow && !existingRow.signup_rewarded) {
    await executor.query(
      `UPDATE referrals SET signup_rewarded = true WHERE id = $1`,
      [insertedRow.id],
    );
  }

  // (6) Award the REFERRER exactly one +150 earn_referral (Req 2.9, 2.11).
  const entry = await repo.append(
    {
      customerId: referrerId,
      entryType: "earn_referral",
      points: REFERRAL_SIGNUP_POINTS,
      reason: REFERRAL_SIGNUP_REASON,
      sourceEventId: input.sourceEventId ?? null,
    },
    executor,
  );

  return { status: "rewarded", referrerId, referredCustomerId, referralId: insertedRow.id, entry };
}

/** Input to {@link awardReferralFirstPurchase}. */
export interface ReferralPurchaseInput {
  /** The friend's local `customers.id` whose paid order was just processed. */
  referredCustomerId: string;
  /**
   * Whether the order just processed is the friend's FIRST paid purchase.
   * Sourced from the order-earning outcome (`firstPurchase`). When false, the
   * friend already had a prior paid purchase, so the reward is NOT awarded
   * (Req 11.9).
   */
  isFirstPaidPurchase: boolean;
  /** X-Shopify-Webhook-Id, recorded on the ledger entry for traceability. */
  sourceEventId?: string | null;
}

/**
 * Outcome of the first-purchase-side referral handling.
 *  - `rewarded`          referrer credited +250; referral marked purchase-rewarded.
 *  - `no_referral`       the friend was not referred; nothing to do.
 *  - `not_first_purchase` friend had a prior paid purchase; not awarded (Req 11.9).
 *  - `already_rewarded`  the first-purchase reward was already granted.
 */
export type ReferralPurchaseOutcome =
  | { status: "rewarded"; referrerId: string; referredCustomerId: string; referralId: string; entry: LedgerEntry }
  | { status: "no_referral"; referredCustomerId: string }
  | { status: "not_first_purchase"; referredCustomerId: string; referralId: string }
  | { status: "already_rewarded"; referrerId: string; referredCustomerId: string; referralId: string };

interface ReferralPurchaseRow {
  id: string;
  referrer_id: string;
  purchase_rewarded: boolean;
}

/**
 * Awards the referrer the +250 first-purchase reward when their referred friend
 * completes their FIRST paid purchase — exactly once, and never when the friend
 * already had a prior paid purchase (Requirements 2.10, 11.9).
 *
 * Flow (all within the caller's transaction):
 *   1. Look up the referral by `referred_id`; none → `no_referral`.
 *   2. If `isFirstPaidPurchase` is false, the friend already purchased before,
 *      so do NOT award (Req 11.9) → `not_first_purchase`.
 *   3. If the referral was already purchase-rewarded → `already_rewarded`.
 *   4. Flip `purchase_rewarded` to true guarded on its being false (exactly-once
 *      under concurrency via `rowCount`).
 *   5. Append exactly one +250 `earn_referral` entry for the REFERRER.
 *
 * The self-referral case cannot arise here: {@link recordReferralOnSignup}
 * never creates a `referrals` row for a self-referral (and the DB CHECK forbids
 * it), so there is no row to reward.
 */
export async function awardReferralFirstPurchase(
  repo: LedgerRepository,
  input: ReferralPurchaseInput,
  executor: Queryable,
): Promise<ReferralPurchaseOutcome> {
  const referredCustomerId = input.referredCustomerId;
  if (typeof referredCustomerId !== "string" || referredCustomerId.trim() === "") {
    throw new InvalidReferralInputError("awardReferralFirstPurchase requires a referred customer id.");
  }

  // (1) Is this friend a referred customer?
  const found = await executor.query<ReferralPurchaseRow>(
    `SELECT id, referrer_id, purchase_rewarded
       FROM referrals
      WHERE referred_id = $1
      LIMIT 1`,
    [referredCustomerId],
  );
  const referral = found.rows[0];
  if (!referral) {
    return { status: "no_referral", referredCustomerId };
  }

  // (3) Already rewarded → exactly-once, nothing to do.
  if (referral.purchase_rewarded) {
    return {
      status: "already_rewarded",
      referrerId: referral.referrer_id,
      referredCustomerId,
      referralId: referral.id,
    };
  }

  // (2) Only the friend's FIRST paid purchase qualifies (Req 11.9).
  if (!input.isFirstPaidPurchase) {
    return { status: "not_first_purchase", referredCustomerId, referralId: referral.id };
  }

  // (4) Claim the reward atomically: flip the flag guarded on it being false.
  const claimed = await executor.query(
    `UPDATE referrals
       SET purchase_rewarded = true
     WHERE id = $1 AND purchase_rewarded = false`,
    [referral.id],
  );
  if ((claimed.rowCount ?? 0) === 0) {
    // Another concurrent processor won the race; treat as already rewarded.
    return {
      status: "already_rewarded",
      referrerId: referral.referrer_id,
      referredCustomerId,
      referralId: referral.id,
    };
  }

  // (5) Award the REFERRER exactly one +250 earn_referral (Req 2.10, 2.11).
  const entry = await repo.append(
    {
      customerId: referral.referrer_id,
      entryType: "earn_referral",
      points: REFERRAL_PURCHASE_POINTS,
      reason: REFERRAL_PURCHASE_REASON,
      sourceEventId: input.sourceEventId ?? null,
    },
    executor,
  );

  return {
    status: "rewarded",
    referrerId: referral.referrer_id,
    referredCustomerId,
    referralId: referral.id,
    entry,
  };
}
