/**
 * Concurrency-safe redemption (task 5.2).
 *
 * Implements the Loyalty Engine's `redeem()` (design.md "Component 2: Loyalty
 * Engine" `redeem`; "Key Functions → redeem()"; the "Data Flow: Redemption
 * (concurrency-safe)" sequence; and the "Tier multiplier and redemption
 * (concurrency-safe core)" pseudocode). A redemption converts points into a
 * pending Shopify discount code, spending points atomically and exactly once.
 *
 * The whole thing runs inside ONE database transaction (the Transactor pattern
 * already used by signup/order earning) so a partially-applied redemption can
 * never occur:
 *
 *   1. Acquire an EXCLUSIVE lock on the customer row (`SELECT ... FOR UPDATE`)
 *      within 5 seconds; on lock-timeout abort with {@link LockTimeoutError}
 *      and no ledger change (Req 3.11). Serialising concurrent redeems on the
 *      same customer is what prevents double-spend.
 *   2. Idempotency: if this `(customer, idempotencyKey)` already produced a
 *      redemption, return it and DO NOT spend again — at most one spend, at
 *      most one code (Req 3.2 / Req 3.7, Property 5). Enforced by the
 *      `redemptions (customer_id, idempotency_key)` UNIQUE constraint plus the
 *      customer lock.
 *   3. Verify `Spendable_Balance >= reward.cost`; if not, roll back with no
 *      ledger change and return {@link RedemptionInsufficientPointsError}
 *      (Req 3.3, 5.7).
 *   4. Record EXACTLY ONE negative `spend` ledger entry equal to the reward
 *      cost and consume `point_lots` FIFO for exactly the cost via
 *      {@link consumeLotsFifo} (Req 3.2, Property 4). Because we only ever
 *      consume from non-expired lots and only after verifying sufficiency, the
 *      resulting Spendable_Balance is >= 0 (Req 3.4, Property 3).
 *   5. Insert a `redemptions` row with status `pending_code` and enqueue a
 *      placeholder discount-code-generation job (Req 3.5 hand-off). The actual
 *      Admin Gateway that mints the code is task 5.3 — here we only ENQUEUE;
 *      no Admin API is called.
 *
 * An unknown reward id is rejected via {@link getRewardOrThrow} BEFORE the
 * transaction starts, so an invalid reward never touches the ledger (Req 3.10,
 * supports the invalid-reward path).
 *
 * SCOPE (task 5.2 only): this module does NOT generate the discount code
 * (task 5.3), wire the `/v1/redeem` HTTP route beyond exposing this callable
 * function, or rate-limit (task 6.5). It reuses — and never modifies — the
 * reward catalog (task 5.1), FIFO consumption + spendable projection
 * (task 2.3), and the append-only ledger repository (task 2.1).
 *
 * SAFETY: defining this module touches no live/production system and calls no
 * Shopify Admin API. It issues SQL only when a caller passes a real
 * transaction client at runtime; all logic is unit tested against an in-memory
 * fake Transactor + Queryable, so live DB verification is deferred to deploy
 * time.
 */
import {
  computeSpendableBalance,
  consumeLotsFifo,
  type ConsumptionPlan,
} from "../ledger/balance.js";
import type { LedgerEntry, LedgerRepository, Queryable } from "../ledger/repository.js";
import { getRewardOrThrow, type Reward, type RewardId } from "../rewards/catalog.js";
import {
  DEFAULT_CHANNEL,
  isGrantableOnChannel,
  normalizeChannel,
  type Channel,
} from "../channel/channel.js";

/** The maximum time to wait for the customer-row lock before aborting (Req 3.11). */
export const LOCK_TIMEOUT_MS = 5000 as const;

/** The status a freshly recorded redemption carries until its code is minted (task 5.3). */
export const REDEMPTION_STATUS_PENDING = "pending_code" as const;

/**
 * The placeholder job name enqueued for discount-code generation. The actual
 * Admin Gateway worker that consumes it is task 5.3; task 5.2 only enqueues.
 */
export const DISCOUNT_CODE_JOB = "generateDiscountCode" as const;

/** PostgreSQL error code raised when `lock_timeout` fires (lock_not_available). */
const PG_LOCK_NOT_AVAILABLE = "55P03" as const;

/** PostgreSQL error code for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = "23505" as const;

/** Maximum accepted idempotency-key length (aligns with Req 9.6, enforced fully in task 6.1). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 128 as const;

/**
 * Runs a unit of work inside a single database transaction. The redemption
 * flow (lock customer → idempotency guard → balance check → spend + FIFO
 * consume → record redemption) MUST be atomic; the caller supplies a
 * transactor that BEGINs, passes the transaction client, and COMMITs /
 * ROLLBACKs. Declared locally (structurally identical to the earning modules')
 * so redemption is independent of them.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Enqueues the placeholder discount-code-generation job for a recorded
 * redemption (Req 3.5 hand-off). Implementations MUST return quickly and MUST
 * NOT call the Admin API inline — minting the code is task 5.3.
 */
export interface DiscountCodeEnqueuer {
  enqueueDiscountCode(job: { redemptionId: string }): Promise<void>;
}

/** A persisted redemption row, mapped from `redemptions`. */
export interface Redemption {
  id: string;
  customerId: string;
  rewardId: string;
  pointsSpent: number;
  valueGBP: number;
  status: string;
  idempotencyKey: string;
  discountCodeId: string | null;
  /** The Channel the redemption was attributed to (`web`|`app`) (Req 19.3, task 21.1). */
  channel: Channel;
  createdAt: Date;
}

/**
 * The outcome of a redemption attempt.
 *  - `redeemed` a new spend was recorded: one negative `spend` ledger entry,
 *               FIFO lots consumed for exactly the cost, a `pending_code`
 *               redemption row created, and a discount-code job enqueued.
 *  - `replayed` this `(customer, idempotencyKey)` already redeemed: the
 *               existing redemption is returned, no new spend, no new job
 *               (Req 3.7, Property 5).
 */
export type RedeemOutcome =
  | {
      status: "redeemed";
      redemption: Redemption;
      /** The single negative `spend` ledger entry (points === -reward.cost). */
      spendEntry: LedgerEntry;
      /** The applied FIFO consumption (sum of decrements === reward.cost). */
      consumption: ConsumptionPlan;
    }
  | { status: "replayed"; redemption: Redemption };

/** Dependencies for {@link redeem}. */
export interface RedeemDeps {
  /** The append-only ledger repository (task 2.1) — the only ledger writer. */
  repo: LedgerRepository;
  /** Runs the redemption inside one transaction. */
  transactor: Transactor;
  /** Enqueues the placeholder discount-code job after a successful spend. */
  enqueuer: DiscountCodeEnqueuer;
}

/**
 * Thrown when the exclusive customer-row lock cannot be acquired within
 * {@link LOCK_TIMEOUT_MS}. The transaction rolls back, so no ledger change is
 * made (Req 3.11).
 */
export class LockTimeoutError extends Error {
  readonly code = "lock_timeout";
  readonly statusCode = 503;
  readonly customerId: string;
  constructor(customerId: string) {
    super(
      `Could not acquire the exclusive lock on customer ${customerId} within ` +
        `${LOCK_TIMEOUT_MS}ms; the redemption was aborted and the ledger is unchanged.`,
    );
    this.name = "LockTimeoutError";
    this.customerId = customerId;
  }
}

/**
 * Thrown when Spendable_Balance is less than the reward cost. The transaction
 * rolls back, leaving the balance and every lot unchanged (Req 3.3, 5.7).
 */
export class RedemptionInsufficientPointsError extends Error {
  readonly code = "insufficient_points";
  readonly statusCode = 409;
  readonly requested: number;
  readonly available: number;
  constructor(requested: number, available: number) {
    super(
      `Insufficient points to redeem: reward costs ${requested} but only ${available} ` +
        `are spendable; the redemption was rolled back and no ledger change was made.`,
    );
    this.name = "RedemptionInsufficientPointsError";
    this.requested = requested;
    this.available = available;
  }
}

/** Thrown when the locked customer row does not exist. */
export class CustomerNotFoundError extends Error {
  readonly code = "customer_not_found";
  readonly statusCode = 404;
  readonly customerId: string;
  constructor(customerId: string) {
    super(`No customer ${customerId} exists to redeem against.`);
    this.name = "CustomerNotFoundError";
    this.customerId = customerId;
  }
}

/** Thrown when the supplied idempotency key is missing or malformed. */
export class InvalidIdempotencyKeyError extends Error {
  readonly code = "invalid_idempotency_key";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdempotencyKeyError";
  }
}

/**
 * Thrown when an app-exclusive reward is redeemed from a non-`app` channel
 * (Req 19.4, Property 15). Raised BEFORE any transaction/ledger change, so an
 * app-exclusive reward is never granted off the `app` channel and no state is
 * touched. The reward and offending channel are carried for the caller.
 */
export class RewardChannelNotAllowedError extends Error {
  readonly code = "reward_channel_not_allowed";
  readonly statusCode = 403;
  readonly rewardId: string;
  readonly channel: Channel;
  readonly requiredChannel: Channel = "app";
  constructor(rewardId: string, channel: Channel) {
    super(
      `Reward '${rewardId}' is app-exclusive and can only be redeemed on the 'app' ` +
        `channel; the attributed channel was '${channel}', so no redemption was made.`,
    );
    this.name = "RewardChannelNotAllowedError";
    this.rewardId = rewardId;
    this.channel = channel;
  }
}

const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;

const LOCK_CUSTOMER_SQL = `SELECT id FROM customers WHERE id = $1 FOR UPDATE`;

const FIND_REDEMPTION_SQL = `
  SELECT id, customer_id, reward_id, points_spent, value_gbp, status,
         idempotency_key, discount_code_id, channel, created_at
  FROM redemptions
  WHERE customer_id = $1 AND idempotency_key = $2
  LIMIT 1
`;

const INSERT_REDEMPTION_SQL = `
  INSERT INTO redemptions
    (customer_id, reward_id, points_spent, value_gbp, status, idempotency_key, channel)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING id, customer_id, reward_id, points_spent, value_gbp, status,
            idempotency_key, discount_code_id, channel, created_at
`;

interface RedemptionRow {
  id: string;
  customer_id: string;
  reward_id: string;
  points_spent: string | number;
  value_gbp: string | number;
  status: string;
  idempotency_key: string;
  discount_code_id: string | null;
  channel: string | null;
  created_at: Date;
}

function parseIntColumn(value: string | number, column: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`redemptions.${column} value '${value}' is not a finite number.`);
  }
  return n;
}

function mapRedemption(row: RedemptionRow): Redemption {
  return {
    id: row.id,
    customerId: row.customer_id,
    rewardId: row.reward_id,
    pointsSpent: parseIntColumn(row.points_spent, "points_spent"),
    valueGBP: parseIntColumn(row.value_gbp, "value_gbp"),
    status: row.status,
    idempotencyKey: row.idempotency_key,
    discountCodeId: row.discount_code_id,
    // A pre-channel row (or a fake without the column) defaults to `web`, matching
    // the `redemptions.channel` column default (Req 19.7, additive).
    channel: normalizeChannel(row.channel),
    createdAt: row.created_at,
  };
}

/** True iff the error is Postgres reporting that the lock could not be acquired in time. */
function isLockTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_LOCK_NOT_AVAILABLE
  );
}

/** True iff the error is a Postgres unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

function validateIdempotencyKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
    throw new InvalidIdempotencyKeyError("A redemption requires a non-empty idempotency key.");
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new InvalidIdempotencyKeyError(
      `An idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
}

/**
 * Finds an existing redemption for `(customerId, idempotencyKey)`, or null.
 * Used both for the primary idempotency guard and to resolve the winner of a
 * concurrent insert race (unique-violation fallback).
 */
async function findRedemption(
  tx: Queryable,
  customerId: string,
  idempotencyKey: string,
): Promise<Redemption | null> {
  const result = await tx.query<RedemptionRow>(FIND_REDEMPTION_SQL, [customerId, idempotencyKey]);
  const row = result.rows[0];
  return row ? mapRedemption(row) : null;
}

/**
 * Redeems `rewardId` for `customerId`, spending `reward.cost` points atomically
 * and exactly once per `idempotencyKey` (Requirements 3.2, 3.3, 3.4, 3.11, 5.7;
 * Properties 3, 4, 5).
 *
 * Returns the `redeemed` outcome (with the spend entry + FIFO consumption) on a
 * fresh redemption, or the `replayed` outcome (the existing redemption) when
 * the idempotency key was already used. Throws:
 *   - {@link import("../rewards/catalog.js").UnknownRewardError} for an unknown
 *     reward id — BEFORE any transaction/ledger change (Req 3.10);
 *   - {@link InvalidIdempotencyKeyError} for a missing/oversized key;
 *   - {@link LockTimeoutError} if the customer lock is not acquired in 5s (Req 3.11);
 *   - {@link CustomerNotFoundError} if the customer row is missing;
 *   - {@link RedemptionInsufficientPointsError} if Spendable_Balance < cost
 *     (Req 3.3) — the transaction rolls back with no ledger change.
 *
 * The discount-code job is enqueued only AFTER the transaction commits, so a
 * rolled-back redemption enqueues nothing and a replay enqueues nothing
 * (at most one code per spend, Property 5).
 *
 * CHANNEL ATTRIBUTION (task 21.1, Req 19.3/19.4): the redemption is attributed
 * to the originating {@link Channel} (`web` by default, `app` for the future
 * native app), which is recorded on the `redemptions.channel` column. When the
 * reward is app-exclusive, it is granted ONLY on the `app` channel — a non-`app`
 * attempt throws {@link RewardChannelNotAllowedError} BEFORE any transaction, so
 * the reward is never granted and no state changes (Property 15). The gating
 * rule itself is the pure {@link isGrantableOnChannel} predicate, so the
 * invariant is verifiable in isolation.
 */
export async function redeem(
  customerId: string,
  rewardId: RewardId | string,
  idempotencyKey: string,
  deps: RedeemDeps,
  channel: Channel = DEFAULT_CHANNEL,
): Promise<RedeemOutcome> {
  // Reject an unknown reward before touching the ledger/transaction (Req 3.10).
  const reward: Reward = getRewardOrThrow(rewardId);
  validateIdempotencyKey(idempotencyKey);

  // Normalise the attributed channel and enforce channel gating BEFORE any
  // transaction: an app-exclusive reward is granted iff channel === 'app'
  // (Req 19.4, Property 15). A non-'app' attempt is rejected with no state
  // change; a non-exclusive reward passes on every channel (additive, Req 19.7).
  const attributedChannel = normalizeChannel(channel);
  if (!isGrantableOnChannel(reward, attributedChannel)) {
    throw new RewardChannelNotAllowedError(reward.id, attributedChannel);
  }

  // A single expiry cutoff shared by the sufficiency check and the consumption
  // so both see the identical non-expired lot pool.
  const asOf = new Date();

  const outcome = await deps.transactor.transaction<RedeemOutcome>(async (tx) => {
    // (1) Bound the lock wait to 5s, then take the exclusive customer lock.
    // A timeout surfaces as Postgres 55P03, which we map to LockTimeoutError;
    // the transaction then rolls back leaving the ledger unchanged (Req 3.11).
    await tx.query(SET_LOCK_TIMEOUT_SQL);
    let lockResult;
    try {
      lockResult = await tx.query<{ id: string }>(LOCK_CUSTOMER_SQL, [customerId]);
    } catch (err) {
      if (isLockTimeout(err)) {
        throw new LockTimeoutError(customerId);
      }
      throw err;
    }
    if ((lockResult.rowCount ?? lockResult.rows.length) === 0) {
      throw new CustomerNotFoundError(customerId);
    }

    // (2) Idempotency: same key => return the existing redemption, no re-spend
    // (Req 3.7, Property 5). The customer lock serialises concurrent same-key
    // redeems so the second caller reaches here and finds the first's row.
    const existing = await findRedemption(tx, customerId, idempotencyKey);
    if (existing) {
      return { status: "replayed", redemption: existing };
    }

    // (3) Balance check against the derived Spendable_Balance (Req 3.3, 5.7).
    const spendable = await computeSpendableBalance(customerId, tx, asOf);
    if (spendable < reward.cost) {
      // Throwing rolls the transaction back: no ledger change, lots unchanged.
      throw new RedemptionInsufficientPointsError(reward.cost, spendable);
    }

    // (4) Record the redemption row first so the spend entry can link to it.
    let redemption: Redemption;
    try {
      const inserted = await tx.query<RedemptionRow>(INSERT_REDEMPTION_SQL, [
        customerId,
        reward.id,
        reward.cost,
        reward.valueGBP,
        REDEMPTION_STATUS_PENDING,
        idempotencyKey,
        attributedChannel,
      ]);
      const row = inserted.rows[0];
      if (!row) {
        throw new Error("Redemption insert returned no row; the redemption did not persist.");
      }
      redemption = mapRedemption(row);
    } catch (err) {
      // Defensive: a concurrent insert with the same (customer, key) violates
      // the UNIQUE constraint. The winner's row is authoritative; return it
      // without a second spend (Property 5). The lock normally prevents this.
      if (isUniqueViolation(err)) {
        const winner = await findRedemption(tx, customerId, idempotencyKey);
        if (winner) {
          return { status: "replayed", redemption: winner };
        }
      }
      throw err;
    }

    // (5) Append EXACTLY ONE negative spend ledger entry equal to the cost
    // (Req 3.2, Property 4) and consume lots FIFO for exactly the cost. The
    // spend links to its redemption via ledger_entries.redemption_id.
    const spendEntry = await deps.repo.append(
      {
        customerId,
        entryType: "spend",
        points: -reward.cost,
        reason: reward.id,
        redemptionId: redemption.id,
        sourceEventId: null,
      },
      tx,
    );

    // FIFO consume for exactly the cost. Sufficiency was verified in (3), so
    // this succeeds; it decrements only non-expired lots, keeping the resulting
    // Spendable_Balance >= 0 (Req 3.4, Property 3).
    const consumption = await consumeLotsFifo(customerId, reward.cost, tx, asOf);

    return { status: "redeemed", redemption, spendEntry, consumption };
  });

  // (6) Enqueue the placeholder discount-code job only after the spend has
  // committed, and only for a fresh redemption — never on replay or rollback,
  // so at most one code is ever produced per spend (Req 3.5, Property 5).
  if (outcome.status === "redeemed") {
    await deps.enqueuer.enqueueDiscountCode({ redemptionId: outcome.redemption.id });
  }

  return outcome;
}
