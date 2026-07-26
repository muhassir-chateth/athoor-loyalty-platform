/**
 * Queued single-use discount-code generation worker (task 5.3).
 *
 * This is the consumer of the `generateDiscountCode` job enqueued by the
 * redemption flow (task 5.2, `redeem.ts`). For a redemption that has already
 * spent points and sits in `pending_code`, it mints — via the injectable
 * {@link ShopifyAdminGateway} — EXACTLY ONE unique, single-use, customer-bound
 * Shopify discount code, persists the `discount_codes` row, and moves the
 * redemption to `issued` carrying the code (Req 3.5, 3.6, 3.8, Property 10).
 *
 * The whole thing is designed around the design's "Data Flow: Redemption"
 * sequence (Q -> A create code -> DB update redemption issued) and its
 * error-scenarios table:
 *
 *   - Idempotency (Req 3.7 / Property 10): if the redemption is already
 *     `issued` (or a `discount_codes` row already exists for it), the worker
 *     returns the existing code and mints NO second code. Re-running the job is
 *     therefore safe — at most one spend, at most one code.
 *   - Throttling (Req 13.2 / 13.3): all Admin calls go through the gateway's
 *     exponential-backoff loop (1s doubling, 60s cap, ≤10 attempts). The Admin
 *     API is NEVER called synchronously in a webhook handler — only here, in
 *     the worker.
 *   - Throttle exhaustion (Req 13.4): if all 10 attempts stay throttled, the
 *     redemption is LEFT `pending_code` (spend retained, not duplicated) and a
 *     {@link CodeNotIssuedError} is surfaced; the code can still be minted on a
 *     later retry.
 *   - Hard failure (Req 3.9): on 3 consecutive Admin failures within 60s, the
 *     redemption is marked `failed` and a compensating `adjust` ledger entry
 *     reverses the spend by the exact reward cost (plus a restoring point-lot so
 *     the refunded points are spendable again). A {@link RedemptionFailedError}
 *     is surfaced.
 *
 * SCOPE: this task does NOT implement the metafield cache writer (task 6.6) or
 * the dashboard/read-endpoint wiring (task 6.7). The redemption now CARRIES the
 * code (via `discount_code_id` → `discount_codes.code`); exposing it over
 * `GET /v1/*` is deferred.
 *
 * SAFETY: no live system is touched by defining this module. The Admin API is
 * reached only through the injected gateway/client; all DB access goes through
 * the injected {@link Transactor}/{@link Queryable}. Every path is unit-tested
 * against a fake Admin client + fake DB, so no live Shopify Admin API is called.
 */
import type { LedgerRepository, Queryable } from "../ledger/repository.js";
import { getRewardOrThrow } from "../rewards/catalog.js";
import { generateCandidateCode, type RandomInt } from "./discountCodeFormat.js";
import { DISCOUNT_CODE_JOB, type DiscountCodeEnqueuer, type Transactor } from "./redeem.js";
import type { MetafieldCacheEnqueuer } from "../shopify/metafieldCache.js";
import {
  AdminApiFailureError,
  AdminThrottleExhaustedError,
  type DiscountCode,
  type DiscountInput,
} from "../shopify/adminGateway.js";

/** Redemption status once its code has been minted and persisted (Req 3.8). */
export const REDEMPTION_STATUS_ISSUED = "issued" as const;

/** Redemption status after a terminal Admin hard failure + compensating reversal (Req 3.9). */
export const REDEMPTION_STATUS_FAILED = "failed" as const;

/** The ledger reason recorded on the compensating reversal adjustment (Req 3.9). */
export const REVERSAL_REASON = "redemption_failed_reversal" as const;

/** Max distinct codes to try before giving up on collisions (astronomically unlikely to exhaust). */
const MAX_CODE_GENERATION_ATTEMPTS = 10 as const;

/** The minter surface the worker needs — satisfied by {@link ShopifyAdminGateway}. */
export interface DiscountMinter {
  createSingleUseDiscount(input: DiscountInput): Promise<DiscountCode>;
}

/** The `generateDiscountCode` job payload (mirrors what `redeem.ts` enqueues). */
export interface DiscountCodeJob {
  redemptionId: string;
}

/** Dependencies for {@link processDiscountCodeJob}. */
export interface DiscountCodeDeps {
  /** The rate-limit-aware Admin Gateway (backed by an injectable client). */
  gateway: DiscountMinter;
  /** The append-only ledger repository (task 2.1) — used only for the reversal. */
  repo: LedgerRepository;
  /** Runs the persist / failure transitions inside one transaction. */
  transactor: Transactor;
  /** Read connection for loading the redemption and collision-checking codes. */
  db: Queryable;
  /** Random source for code generation; defaults to the CSPRNG (overridden in tests). */
  randomInt?: RandomInt;
  /**
   * OPTIONAL Metafield_Cache refresh enqueuer (Req 13.5a). A compensating
   * reversal credits the customer back, changing their Balance, so the display
   * cache must be refreshed. Threaded in ONLY when the Shopify Admin token is
   * configured; otherwise omitted and reconciliation converges the cache
   * (Req 13.7). Minting a code changes no balance, so only the reversal path
   * enqueues.
   */
  metafieldEnqueuer?: MetafieldCacheEnqueuer;
}

/** The outcome of processing a `generateDiscountCode` job. */
export type DiscountCodeOutcome =
  | { status: "issued"; code: string; discountCodeId: string; redemptionId: string }
  | { status: "already_issued"; code: string; discountCodeId: string; redemptionId: string };

/** Thrown when the referenced redemption row does not exist. */
export class RedemptionNotFoundError extends Error {
  readonly code = "redemption_not_found";
  readonly redemptionId: string;
  constructor(redemptionId: string) {
    super(`No redemption ${redemptionId} exists to issue a discount code for.`);
    this.name = "RedemptionNotFoundError";
    this.redemptionId = redemptionId;
  }
}

/**
 * Thrown when the Admin API stayed throttled across all retry attempts (Req 13.4).
 * The redemption is retained in `pending_code` (spend not reversed, not
 * duplicated) and the code can be issued on a later retry.
 */
export class CodeNotIssuedError extends Error {
  readonly code = "code_not_issued";
  readonly statusCode = 503;
  readonly redemptionId: string;
  constructor(redemptionId: string) {
    super(
      `The discount code for redemption ${redemptionId} could not be issued yet ` +
        `(Admin API throttled); the redemption remains pending and will be retried.`,
    );
    this.name = "CodeNotIssuedError";
    this.redemptionId = redemptionId;
  }
}

/**
 * Thrown after a terminal Admin hard failure (Req 3.9). Before throwing, the
 * worker marks the redemption `failed` and records a compensating adjustment
 * reversing the spend by the exact reward cost.
 */
export class RedemptionFailedError extends Error {
  readonly code = "redemption_failed";
  readonly statusCode = 502;
  readonly redemptionId: string;
  override readonly cause?: unknown;
  constructor(redemptionId: string, cause?: unknown) {
    super(
      `The discount code for redemption ${redemptionId} could not be issued after ` +
        `repeated Admin API failures; the spend was reversed and the redemption marked failed.`,
    );
    this.name = "RedemptionFailedError";
    this.redemptionId = redemptionId;
    this.cause = cause;
  }
}

interface RedemptionWithCustomerRow {
  id: string;
  customer_id: string;
  reward_id: string;
  points_spent: string | number;
  value_gbp: string | number;
  status: string;
  discount_code_id: string | null;
  shopify_customer_id: string | number;
}

interface DiscountCodeRow {
  id: string;
  code: string;
}

const LOAD_REDEMPTION_SQL = `
  SELECT r.id, r.customer_id, r.reward_id, r.points_spent, r.value_gbp, r.status,
         r.discount_code_id, c.shopify_customer_id
  FROM redemptions r
  JOIN customers c ON c.id = r.customer_id
  WHERE r.id = $1
  LIMIT 1
`;

const FIND_CODE_FOR_REDEMPTION_SQL = `
  SELECT id, code FROM discount_codes WHERE redemption_id = $1 LIMIT 1
`;

const CODE_EXISTS_SQL = `SELECT 1 FROM discount_codes WHERE code = $1 LIMIT 1`;

/**
 * Guard for the compensating reversal (Req 3.9): has a reversal adjustment
 * already been recorded for this redemption? Read inside the reversal
 * transaction so the check and the append are atomic, keeping the invariant
 * "exactly one compensating adjustment per failed redemption" true even under a
 * queue-level retry or a concurrent worker.
 */
const EXISTING_REVERSAL_SQL = `
  SELECT 1 FROM ledger_entries
  WHERE redemption_id = $1 AND entry_type = 'adjust' AND reason = $2
  LIMIT 1
`;

const INSERT_DISCOUNT_CODE_SQL = `
  INSERT INTO discount_codes
    (redemption_id, code, shopify_price_rule_id, shopify_discount_id, amount_off_gbp, status)
  VALUES ($1, $2, $3, $4, $5, 'active')
  RETURNING id, code
`;

const UPDATE_REDEMPTION_ISSUED_SQL = `
  UPDATE redemptions SET status = $2, discount_code_id = $3 WHERE id = $1
`;

const UPDATE_REDEMPTION_FAILED_SQL = `UPDATE redemptions SET status = $2 WHERE id = $1`;

const INSERT_REVERSAL_LOT_SQL = `
  INSERT INTO point_lots
    (customer_id, ledger_entry_id, original_points, remaining_points, expires_at)
  VALUES ($1, $2, $3, $3, NULL)
`;

/** Builds the Shopify customer GID a code is bound to (Req 3.6). */
function customerGid(shopifyCustomerId: string | number): string {
  return `gid://shopify/Customer/${shopifyCustomerId}`;
}

function toInt(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected a finite numeric column value; received '${value}'.`);
  }
  return n;
}

/**
 * Generates a code that does not collide with any existing `discount_codes.code`
 * (design: "collision-checked against discount_codes.code"). Regenerates on the
 * astronomically-rare collision; the DB UNIQUE constraint is the final backstop
 * at insert time.
 */
async function generateUniqueCode(db: Queryable, randomInt?: RandomInt): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generateCandidateCode(randomInt);
    const clash = await db.query(CODE_EXISTS_SQL, [candidate]);
    if ((clash.rowCount ?? clash.rows.length) === 0) {
      return candidate;
    }
  }
  throw new Error(
    `Could not generate a collision-free discount code after ${MAX_CODE_GENERATION_ATTEMPTS} attempts.`,
  );
}

/**
 * Processes one `generateDiscountCode` job for `redemptionId` (Requirements
 * 3.5, 3.6, 3.7, 3.8, 3.9, 13.2, 13.3, 13.4; Property 10).
 *
 * Returns `issued` on a fresh mint, or `already_issued` when the redemption
 * already carries a code (idempotent replay — Req 3.7 / Property 10). Throws:
 *   - {@link RedemptionNotFoundError} if the redemption is missing;
 *   - {@link CodeNotIssuedError} if the Admin API stayed throttled across all
 *     attempts (Req 13.4) — redemption left pending, spend intact;
 *   - {@link RedemptionFailedError} after a terminal Admin hard failure
 *     (Req 3.9) — redemption marked failed, spend reversed by a compensating
 *     adjustment.
 */
export async function processDiscountCodeJob(
  redemptionId: string,
  deps: DiscountCodeDeps,
): Promise<DiscountCodeOutcome> {
  const { gateway, transactor, db, randomInt } = deps;

  // Load the redemption (and its customer's Shopify id for binding the code).
  const loaded = await db.query<RedemptionWithCustomerRow>(LOAD_REDEMPTION_SQL, [redemptionId]);
  const redemption = loaded.rows[0];
  if (!redemption) {
    throw new RedemptionNotFoundError(redemptionId);
  }

  // (Idempotency, Req 3.7 / Property 10) Already issued? Return the existing
  // code and mint nothing more. Covers both the status flag and an existing
  // discount_codes row (belt and braces for a crash between the two writes).
  if (redemption.status === REDEMPTION_STATUS_ISSUED || redemption.discount_code_id !== null) {
    const existing = await db.query<DiscountCodeRow>(FIND_CODE_FOR_REDEMPTION_SQL, [redemptionId]);
    const row = existing.rows[0];
    if (row) {
      return {
        status: "already_issued",
        code: row.code,
        discountCodeId: row.id,
        redemptionId,
      };
    }
  }
  // (Req 3.9) TERMINAL FAILURE is final. The attempt that failed already marked
  // the redemption `failed` and recorded the single compensating reversal, then
  // threw — which hands the job back to the queue for retry. A retry must NOT
  // mint a code and must NOT reverse the spend a second time (that would credit
  // the customer once per attempt). Re-throw before any Admin call so the job
  // stays visibly failed and the ledger is left untouched.
  if (redemption.status === REDEMPTION_STATUS_FAILED) {
    throw new RedemptionFailedError(redemptionId);
  }

  // A pre-existing discount_codes row even without the issued flag => reuse it.
  {
    const existing = await db.query<DiscountCodeRow>(FIND_CODE_FOR_REDEMPTION_SQL, [redemptionId]);
    const row = existing.rows[0];
    if (row) {
      return {
        status: "already_issued",
        code: row.code,
        discountCodeId: row.id,
        redemptionId,
      };
    }
  }

  const cost = toInt(redemption.points_spent);
  const amountOffGBP = toInt(redemption.value_gbp);
  // Reward is validated defensively; value/cost come from the persisted row.
  getRewardOrThrow(redemption.reward_id);

  const code = await generateUniqueCode(db, randomInt);

  const input: DiscountInput = {
    customerGid: customerGid(redemption.shopify_customer_id),
    amountOffGBP,
    code,
    usageLimit: 1,
    appliesOncePerCustomer: true,
    redemptionId,
  };

  let minted: DiscountCode;
  try {
    // The ONLY Admin API call — routed through the gateway's backoff loop
    // (Req 13.2 / 13.3). Never called synchronously in a webhook handler.
    minted = await gateway.createSingleUseDiscount(input);
  } catch (err) {
    if (err instanceof AdminThrottleExhaustedError) {
      // Throttle exhaustion (Req 13.4): keep the redemption pending, spend
      // intact and not duplicated; surface a retryable error.
      throw new CodeNotIssuedError(redemptionId);
    }
    if (err instanceof AdminApiFailureError) {
      // Terminal hard failure (Req 3.9): mark failed + compensating reversal.
      await reverseSpend(redemption, cost, deps);
      throw new RedemptionFailedError(redemptionId, err);
    }
    throw err;
  }

  // Success: persist the code and move the redemption to `issued`, atomically.
  const discountCodeId = await transactor.transaction<string>(async (tx) => {
    const inserted = await tx.query<DiscountCodeRow>(INSERT_DISCOUNT_CODE_SQL, [
      redemptionId,
      minted.code,
      minted.shopifyPriceRuleId,
      minted.shopifyDiscountId,
      amountOffGBP,
    ]);
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("discount_codes insert returned no row; the code did not persist.");
    }
    await tx.query(UPDATE_REDEMPTION_ISSUED_SQL, [
      redemptionId,
      REDEMPTION_STATUS_ISSUED,
      row.id,
    ]);
    return row.id;
  });

  return { status: "issued", code: minted.code, discountCodeId, redemptionId };
}

/**
 * Marks the redemption `failed` and records the compensating reversal (Req 3.9):
 * a `+cost` `adjust` ledger entry (so Balance is restored) plus a matching
 * non-expiring point-lot (so Spendable_Balance is restored and the refunded
 * points are usable again). Runs in a single transaction so the failure state
 * and the reversal are atomic.
 */
async function reverseSpend(
  redemption: RedemptionWithCustomerRow,
  cost: number,
  deps: DiscountCodeDeps,
): Promise<void> {
  const { repo, transactor } = deps;
  await transactor.transaction(async (tx) => {
    await tx.query(UPDATE_REDEMPTION_FAILED_SQL, [redemption.id, REDEMPTION_STATUS_FAILED]);
    // Exactly ONE compensating adjustment per redemption (Req 3.9). Defence in
    // depth alongside the caller's terminal-status guard: if a reversal already
    // exists, the failure state is recorded and there is nothing left to undo.
    const alreadyReversed = await tx.query(EXISTING_REVERSAL_SQL, [
      redemption.id,
      REVERSAL_REASON,
    ]);
    if ((alreadyReversed.rowCount ?? alreadyReversed.rows.length) > 0) {
      return;
    }
    // Compensating credit reversing the spend by the exact reward cost (Req 3.9).
    const reversal = await repo.append(
      {
        customerId: redemption.customer_id,
        entryType: "adjust",
        points: cost,
        reason: REVERSAL_REASON,
        redemptionId: redemption.id,
        sourceEventId: null,
      },
      tx,
    );
    // Restore spendable balance so the refunded points are re-usable.
    await tx.query(INSERT_REVERSAL_LOT_SQL, [redemption.customer_id, reversal.id, cost]);
  });

  // The reversal changed the Balance, so refresh the display cache off the
  // request path (Req 13.1/13.5a). Best-effort and post-commit: the ledger is
  // authoritative, and reconciliation is the safety net (Req 13.7).
  if (deps.metafieldEnqueuer) {
    await deps.metafieldEnqueuer.enqueueMetafieldCache({ customerId: redemption.customer_id });
  }
}

/**
 * A minimal structural view of the job queue's consumer side (pg-boss `work`),
 * declared locally so wiring the worker does not hard-couple to pg-boss types.
 */
export interface DiscountCodeJobConsumer {
  work(
    name: string,
    handler: (jobs: Array<{ data: DiscountCodeJob }>) => Promise<void>,
  ): Promise<string>;
}

/** The queue name the discount-code job is published/consumed on (matches `redeem.ts`). */
export { DISCOUNT_CODE_JOB };

/**
 * The subset of pg-boss this enqueuer relies on. Declared structurally so the
 * real `PgBoss` instance satisfies it without a hard type import here — mirrors
 * the `JobPublisher` declared by the webhook and metafield-cache enqueuers.
 */
export interface JobPublisher {
  send(queue: string, data: object, options?: object): Promise<string | null>;
}

/**
 * pg-boss-backed {@link DiscountCodeEnqueuer}: hands the discount-code job off
 * to the `generateDiscountCode` queue after a committed redemption spend
 * (Req 3.5). Keyed by `redemptionId` via pg-boss's `singletonKey` so a job for a
 * given redemption is not duplicated even if the (already at-most-once) enqueue
 * is somehow retried — at most one code per spend (Property 5/10). Mirrors
 * {@link PgBossWebhookEnqueuer} / {@link PgBossMetafieldCacheEnqueuer} exactly:
 * a thin structural adapter that never calls the Admin API inline (minting
 * happens in the worker above).
 */
export class PgBossDiscountCodeEnqueuer implements DiscountCodeEnqueuer {
  constructor(private readonly boss: JobPublisher) {}

  async enqueueDiscountCode(job: { redemptionId: string }): Promise<void> {
    await this.boss.send(
      DISCOUNT_CODE_JOB,
      { redemptionId: job.redemptionId },
      { singletonKey: job.redemptionId },
    );
  }
}

/**
 * Registers the worker on the job queue. Each delivered job is processed by
 * {@link processDiscountCodeJob}; a {@link CodeNotIssuedError} is re-thrown so
 * the queue retries later (redemption stays pending), while a
 * {@link RedemptionFailedError} is terminal (the spend was already reversed).
 *
 * Registration is intentionally thin — the queue's own retry policy can layer
 * on top of the gateway's in-call backoff. The heavy lifting and all invariants
 * live in {@link processDiscountCodeJob}, which is unit-tested directly.
 */
export async function registerDiscountCodeWorker(
  consumer: DiscountCodeJobConsumer,
  deps: DiscountCodeDeps,
  queueName: string,
): Promise<string> {
  return consumer.work(queueName, async (jobs) => {
    for (const job of jobs) {
      await processDiscountCodeJob(job.data.redemptionId, deps);
    }
  });
}
