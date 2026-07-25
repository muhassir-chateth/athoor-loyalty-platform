/**
 * Refund and cancellation clawback (task 9.1).
 *
 * Implements the `refunds/create` and `orders/cancelled` clawback rules of the
 * Loyalty Engine (design.md "Component 2: Loyalty Engine" `clawback`; the
 * "Data Flow: Refund / Cancellation clawback" sequence; the `clawback()`
 * pre/post-conditions; Property 8). It is the ONLY writer of `clawback`
 * movements and it never touches the `earn_*` writers owned by
 * `src/earning/order.ts` / `src/earning/signup.ts` / `src/referral/**`.
 *
 * Requirements covered:
 *   - 4.1  On a signature-verified `refunds/create`, create a negative
 *          `clawback` entry whose magnitude equals the original earn rate
 *          applied to the refunded eligible amount, rounded to the nearest
 *          whole point with 0.5 rounding up.
 *   - 4.2  On a signature-verified `orders/cancelled`, create negative
 *          `clawback` entries reversing the points earned on that order.
 *   - 4.3  For any order, cumulative absolute clawback is in
 *          `[0, totalEarned(order)]`. *(Property 8)*
 *   - 4.4  A full refund of a fully-earning order claws back exactly what the
 *          order earned, so the net order-attributable balance is 0.
 *   - 4.5  A partial refund claws back points proportional to the refunded
 *          eligible amount, bounded so cumulative absolute clawback never
 *          exceeds the total points earned on the order.
 *   - 4.6  WHERE `allowNegative` is disabled, clamp the clawback so the
 *          resulting Spendable_Balance is >= 0 (A7).
 *   - 4.7  WHERE `allowTierDowngradeOnClawback` is disabled, retain the
 *          customer's tier unchanged after a clawback (A4).
 *   - 4.8  On signature failure the event never reaches here — the HMAC gate
 *          (task 3.1) rejects with 401 and nothing is enqueued, so clawback
 *          runs ONLY on the verified/deduped hand-off path. The module exposes
 *          no unauthenticated entry point: {@link clawback} is invoked
 *          exclusively from {@link handleRefundJob} / {@link handleOrderCancelledJob}.
 *   - 4.9  A duplicate of an already-processed event id creates no additional
 *          clawback and leaves balances unchanged — enforced by a per-order
 *          `(source_event_id)` idempotency guard in addition to the upstream
 *          webhook-id dedupe (task 3.2).
 *
 * ---------------------------------------------------------------------------
 * How the clawback magnitude is computed
 * ---------------------------------------------------------------------------
 * `totalEarned(order)` is the sum of the positive points of the order-
 * attributable earn entries (`earn_order`, `earn_first_purchase`,
 * `earn_referral`) recorded against the order reference. `alreadyClawedBack` is
 * the sum of the absolute magnitudes of prior `clawback` entries for that order.
 * The remaining head-room is `remaining = totalEarned − alreadyClawedBack`,
 * which is the Property-8 ceiling for this event.
 *
 *   - **Cancellation** reverses the whole order: it claws back exactly
 *     `remaining` (Req 4.2), driving cumulative clawback to `totalEarned`.
 *
 *   - **Refund** claws back the earnings attributable to the refunded eligible
 *     amount, then bounds the result to `remaining` (Req 4.1, 4.5; Property 8).
 *     Two equivalent derivations are supported, preferring (b) when the order's
 *     original eligible total is known so a *full* refund lands exactly on
 *     `totalEarned` (Req 4.4):
 *       (a) rate form  — `round(refundedEligibleAmount × earnRate)`, the literal
 *           Req-4.1 "earn rate applied to the refunded eligible amount"; used
 *           when the original eligible total is not supplied.
 *       (b) fraction form — `round(totalEarned × refunded/original)`, the
 *           refunded fraction of the order applied to everything the order
 *           earned (including the first-purchase bonus); used when
 *           `originalEligibleTotal > 0` so a full refund (fraction = 1) claws
 *           back `totalEarned` and the net order-attributable balance is 0.
 *
 * ---------------------------------------------------------------------------
 * Balance / spendable consistency and the negative-balance clamp (Req 4.6)
 * ---------------------------------------------------------------------------
 * A clawback removes previously-earned points from circulation, so it consumes
 * Point_Lots FIFO (reusing the task-2.3 primitive) as well as appending the
 * negative ledger entry — keeping Balance (= SUM ledger) and Spendable_Balance
 * (= SUM lot remainders) consistent. WHERE `allowNegative` is disabled (the
 * default, A7) the magnitude is clamped to the current Spendable_Balance so the
 * result can never drop below zero; WHERE it is enabled the full magnitude is
 * recorded (consuming all available lots) and Balance may go negative.
 *
 * ---------------------------------------------------------------------------
 * Tier (Req 4.7 / A4)
 * ---------------------------------------------------------------------------
 * WHERE `allowTierDowngradeOnClawback` is disabled (the default) the customer's
 * retained tier is left untouched — clawback never lowers a tier. WHERE it is
 * enabled, lifetime spend is reduced by the refunded/cancelled money and the
 * tier is recomputed from the reduced spend.
 *
 * SAFETY: defining this module touches no live/production system and calls no
 * Shopify Admin API. It issues SQL only when a caller passes a real
 * Pool/PoolClient (or a transaction client) at runtime; all logic is unit
 * tested against an in-memory {@link Queryable} fake, so live DB verification is
 * deferred to deploy time.
 */
import { z } from "zod";
import {
  computeSpendableBalance,
  consumeLotsFifo,
} from "../ledger/balance.js";
import type { LedgerEntry, LedgerRepository, Queryable } from "../ledger/repository.js";
import { deriveTier, normalizeTier, type Tier } from "../tier/tier.js";
import type { WebhookJob } from "../webhooks/enqueue.js";

/** The webhook topics this module reverses earnings for. */
export const REFUNDS_CREATE_TOPIC = "refunds/create" as const;
export const ORDERS_CANCELLED_TOPIC = "orders/cancelled" as const;

/** The reason recorded on a refund-driven `clawback` ledger entry. */
export const REFUND_CLAWBACK_REASON = "refund_clawback" as const;
/** The reason recorded on a cancellation-driven `clawback` ledger entry. */
export const CANCELLATION_CLAWBACK_REASON = "cancellation_clawback" as const;

/**
 * The earn entry types attributable to a specific order — the basis for
 * `totalEarned(order)`. Signup earnings carry no order reference and are never
 * clawed back here.
 */
export const ORDER_ATTRIBUTABLE_EARN_TYPES = [
  "earn_order",
  "earn_first_purchase",
  "earn_referral",
] as const;

/**
 * Clawback policy flags (A4/A7). Defaults are both OFF: the ledger never forces
 * a balance below zero and clawback never lowers a tier.
 */
export interface ClawbackPolicy {
  /** WHERE off (default), clamp so Spendable_Balance stays >= 0 (Req 4.6, A7). */
  allowNegative: boolean;
  /** WHERE off (default), retain the customer's tier after a clawback (Req 4.7, A4). */
  allowTierDowngradeOnClawback: boolean;
}

/** The default clawback policy: no negative balance, no tier downgrade. */
export const DEFAULT_CLAWBACK_POLICY: ClawbackPolicy = {
  allowNegative: false,
  allowTierDowngradeOnClawback: false,
} as const;

/** Which webhook drove the clawback. */
export type ClawbackMode = "refund" | "cancellation";

/** Input to {@link clawback}. */
export interface ClawbackInput {
  /** The numeric Shopify order id whose earnings are being reversed. */
  orderReference: number;
  /** Which event drove this clawback. */
  mode: ClawbackMode;
  /**
   * Refund mode only: the refunded eligible amount in store currency (GBP at
   * MVP), post-discount and excluding shipping and tax (A2). Ignored for
   * cancellation, which reverses the whole remaining earning.
   */
  refundedEligibleAmount?: number;
  /**
   * Refund mode only: the order's ORIGINAL eligible total. When provided and
   * positive, the clawback uses the fraction form (refunded/original) so a full
   * refund lands exactly on `totalEarned` (Req 4.4). When omitted, the rate
   * form is used instead.
   */
  originalEligibleTotal?: number | null;
  /**
   * Refund mode only: the original earn rate (tier multiplier) applied to the
   * order. Used by the rate form when `originalEligibleTotal` is not supplied.
   * Defaults to 1 (Bronze). Property 8 bounds the result regardless.
   */
  earnRate?: number;
  /** X-Shopify-Webhook-Id, recorded on the clawback entry and used for dedupe. */
  sourceEventId?: string | null;
  /** Policy flags; defaults to {@link DEFAULT_CLAWBACK_POLICY}. */
  policy?: ClawbackPolicy;
}

/** Why a clawback attempt resulted in no ledger movement. */
export type ClawbackNoOpReason =
  /** No customer/earnings are attributable to the order reference. */
  | "no_earnings"
  /** A `clawback` with this source event id already exists for the order (Req 4.9). */
  | "duplicate_event"
  /** The bounded, clamped magnitude was zero (e.g. order already fully clawed back). */
  | "zero_amount";

/** The outcome of a clawback attempt. */
export type ClawbackOutcome =
  | {
      status: "clawed_back";
      customerId: string;
      orderReference: number;
      /** The negative `clawback` ledger entry created this event. */
      entry: LedgerEntry;
      /** The absolute magnitude clawed back this event (> 0). */
      clawbackPoints: number;
      /** Total points earned on the order (`earn_*` attributable to it). */
      totalEarned: number;
      /** Cumulative absolute clawback for the order after this event (<= totalEarned). */
      cumulativeClawback: number;
      /** Points removed from lots this event (== clawbackPoints unless allowNegative drove it higher). */
      lotsConsumed: number;
      /** The customer's tier after the clawback. */
      tier: Tier;
      /** True iff the tier was left unchanged (Req 4.7). */
      tierRetained: boolean;
    }
  | {
      status: "no_op";
      customerId: string | null;
      orderReference: number;
      reason: ClawbackNoOpReason;
    };

/** Thrown when a clawback payload lacks a usable order id. */
export class InvalidClawbackPayloadError extends Error {
  readonly code = "invalid_clawback_payload";
  constructor(message: string) {
    super(message);
    this.name = "InvalidClawbackPayloadError";
  }
}

/**
 * Runs a unit of work inside a single database transaction. The clawback flow
 * (resolve customer → guards → append clawback + consume lots → optional tier
 * recompute) MUST be atomic; the caller supplies a transactor that BEGINs,
 * passes the transaction client, and COMMITs / ROLLBACKs. Declared locally so
 * clawback is independent of the earning modules.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Rounds to the nearest whole number with 0.5 rounding UP (Req 4.1). Operates
 * on non-negative magnitudes only, so `floor(x + 0.5)` gives exact half-up
 * behaviour (e.g. 2.5 → 3, 2.4 → 2).
 */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value + 0.5);
}

/**
 * Computes the raw (pre-bound) refund clawback magnitude (Req 4.1/4.4/4.5).
 * Prefers the fraction form when `originalEligibleTotal > 0` (so a full refund
 * claws back all of `totalEarned`), otherwise uses the literal rate form. The
 * result is a non-negative whole number; Property-8 bounding is applied by the
 * caller.
 */
export function computeRefundRawClawback(params: {
  refundedEligibleAmount: number;
  originalEligibleTotal?: number | null;
  earnRate?: number;
  totalEarned: number;
}): number {
  const { refundedEligibleAmount, originalEligibleTotal, earnRate, totalEarned } = params;
  if (!Number.isFinite(refundedEligibleAmount) || refundedEligibleAmount <= 0) {
    return 0;
  }

  // Fraction form (preferred when the original eligible total is known): the
  // refunded fraction of the order applied to everything it earned.
  if (
    typeof originalEligibleTotal === "number" &&
    Number.isFinite(originalEligibleTotal) &&
    originalEligibleTotal > 0
  ) {
    const fraction = Math.min(1, refundedEligibleAmount / originalEligibleTotal);
    return roundHalfUp(totalEarned * fraction);
  }

  // Rate form: original earn rate applied to the refunded eligible amount.
  const rate = typeof earnRate === "number" && Number.isFinite(earnRate) ? earnRate : 1;
  if (rate <= 0) {
    return 0;
  }
  // Money handled in integer pence before applying the rate to avoid float drift.
  const pence = Math.round(refundedEligibleAmount * 100);
  return roundHalfUp((pence * rate) / 100);
}

/** Resolves the local customer id that owns the order's earnings (DB-only). */
const RESOLVE_CUSTOMER_BY_ORDER_SQL = `
  SELECT customer_id
  FROM ledger_entries
  WHERE order_reference = $1
    AND entry_type IN ('earn_order', 'earn_first_purchase', 'earn_referral')
  LIMIT 1
`;

/** Reads the customer's retained tier + lifetime spend (for the downgrade branch). */
const CUSTOMER_TOTALS_SQL = `
  SELECT tier, lifetime_spend_gbp
  FROM customers
  WHERE id = $1
`;

/** Sum of positive points earned on the order (`totalEarned`, Property 8 ceiling). */
const TOTAL_EARNED_SQL = `
  SELECT COALESCE(SUM(points), 0)::text AS total
  FROM ledger_entries
  WHERE customer_id = $1
    AND order_reference = $2
    AND entry_type IN ('earn_order', 'earn_first_purchase', 'earn_referral')
`;

/** Sum of prior clawback magnitudes for the order (a negative number). */
const ALREADY_CLAWED_SQL = `
  SELECT COALESCE(SUM(points), 0)::text AS total
  FROM ledger_entries
  WHERE customer_id = $1
    AND order_reference = $2
    AND entry_type = 'clawback'
`;

/** Duplicate-event guard (Req 4.9): a clawback for this event id already exists. */
const DUPLICATE_EVENT_SQL = `
  SELECT 1
  FROM ledger_entries
  WHERE customer_id = $1
    AND order_reference = $2
    AND entry_type = 'clawback'
    AND source_event_id = $3
  LIMIT 1
`;

/** Reduces lifetime spend and writes the recomputed tier (downgrade branch only). */
const UPDATE_CUSTOMER_TOTALS_SQL = `
  UPDATE customers
  SET lifetime_spend_gbp = GREATEST(0, lifetime_spend_gbp - $2),
      tier               = $3,
      updated_at         = now()
  WHERE id = $1
`;

function parseIntegerText(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function parseMoney(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Applies a refund/cancellation clawback for a single order inside the caller's
 * transaction (Requirements 4.1–4.7, 4.9; Property 8).
 *
 * Flow:
 *   1. Resolve the customer that owns the order's earnings (DB-only). If none,
 *      there is nothing to reverse → no-op (Req 4.9-adjacent: no earnings).
 *   2. Duplicate-event guard on `(order, source_event_id)` → no-op (Req 4.9).
 *   3. Read `totalEarned(order)` and `alreadyClawedBack`; the remaining
 *      head-room is the Property-8 ceiling.
 *   4. Compute the desired magnitude: cancellation reverses `remaining`
 *      (Req 4.2); refund uses the rate/fraction form bounded to `remaining`
 *      (Req 4.1/4.4/4.5).
 *   5. Clamp to Spendable_Balance when `allowNegative` is off (Req 4.6) and
 *      consume that many points from lots FIFO.
 *   6. Append exactly one negative `clawback` entry.
 *   7. Recompute the tier downward only when `allowTierDowngradeOnClawback` is
 *      on; otherwise retain it (Req 4.7).
 *
 * MUST run inside a transaction: pass the transaction client as `executor`.
 * Performs no HMAC/verification itself — invoked only from the verified/deduped
 * path (Req 4.8).
 */
export async function clawback(
  repo: LedgerRepository,
  input: ClawbackInput,
  executor: Queryable,
): Promise<ClawbackOutcome> {
  const policy = input.policy ?? DEFAULT_CLAWBACK_POLICY;
  const orderReference = input.orderReference;

  // (1) Resolve the customer that owns the order's earnings.
  const resolved = await executor.query<{ customer_id: string }>(RESOLVE_CUSTOMER_BY_ORDER_SQL, [
    orderReference,
  ]);
  const customerId = resolved.rows[0]?.customer_id ?? null;
  if (!customerId) {
    return { status: "no_op", customerId: null, orderReference, reason: "no_earnings" };
  }

  // (2) Duplicate-event guard (Req 4.9).
  if (typeof input.sourceEventId === "string" && input.sourceEventId.trim() !== "") {
    const dup = await executor.query(DUPLICATE_EVENT_SQL, [
      customerId,
      orderReference,
      input.sourceEventId,
    ]);
    if ((dup.rowCount ?? dup.rows.length) > 0) {
      return { status: "no_op", customerId, orderReference, reason: "duplicate_event" };
    }
  }

  // (3) totalEarned and the remaining Property-8 head-room.
  const earnedRes = await executor.query<{ total: string }>(TOTAL_EARNED_SQL, [
    customerId,
    orderReference,
  ]);
  const totalEarned = Math.max(0, parseIntegerText(earnedRes.rows[0]?.total));

  const clawedRes = await executor.query<{ total: string }>(ALREADY_CLAWED_SQL, [
    customerId,
    orderReference,
  ]);
  const alreadyClawedBack = Math.abs(parseIntegerText(clawedRes.rows[0]?.total));
  const remaining = Math.max(0, totalEarned - alreadyClawedBack);

  if (totalEarned <= 0 || remaining <= 0) {
    return { status: "no_op", customerId, orderReference, reason: "zero_amount" };
  }

  // (4) Desired magnitude for this event, bounded to remaining (Property 8).
  let desired: number;
  if (input.mode === "cancellation") {
    desired = remaining; // reverse the whole remaining earning (Req 4.2)
  } else {
    const raw = computeRefundRawClawback({
      refundedEligibleAmount: input.refundedEligibleAmount ?? 0,
      originalEligibleTotal: input.originalEligibleTotal ?? null,
      earnRate: input.earnRate,
      totalEarned,
    });
    desired = Math.min(raw, remaining); // Req 4.1/4.5 + Property 8 ceiling
  }

  if (desired <= 0) {
    return { status: "no_op", customerId, orderReference, reason: "zero_amount" };
  }

  // (5) Negative-balance clamp (Req 4.6, A7). Consume points from lots FIFO so
  // Spendable_Balance and Balance stay consistent; the lots can never go below
  // zero, so consumption is capped at the current spendable balance.
  const spendable = await computeSpendableBalance(customerId, executor);
  const consumeAmount = Math.min(desired, Math.max(0, spendable));
  const clawbackMagnitude = policy.allowNegative ? desired : consumeAmount;

  if (clawbackMagnitude <= 0) {
    // Nothing available to reverse without violating the no-negative policy.
    return { status: "no_op", customerId, orderReference, reason: "zero_amount" };
  }

  if (consumeAmount > 0) {
    await consumeLotsFifo(customerId, consumeAmount, executor);
  }

  // (6) Append exactly one negative clawback entry (Req 4.1/4.2).
  const reason =
    input.mode === "cancellation" ? CANCELLATION_CLAWBACK_REASON : REFUND_CLAWBACK_REASON;
  const entry = await repo.append(
    {
      customerId,
      entryType: "clawback",
      points: -clawbackMagnitude,
      reason,
      orderReference,
      sourceEventId: input.sourceEventId ?? null,
    },
    executor,
  );

  // (7) Tier: retain by default (Req 4.7); recompute downward only when enabled.
  let tier = normalizeTier((await readTier(executor, customerId)) ?? undefined);
  let tierRetained = true;
  if (policy.allowTierDowngradeOnClawback) {
    const moneyBack =
      input.mode === "refund" ? Math.max(0, input.refundedEligibleAmount ?? 0) : 0;
    if (moneyBack > 0) {
      const totalsRes = await executor.query<{ tier: string; lifetime_spend_gbp: string | number }>(
        CUSTOMER_TOTALS_SQL,
        [customerId],
      );
      const currentSpend = parseMoney(totalsRes.rows[0]?.lifetime_spend_gbp);
      const newSpend = Math.max(0, currentSpend - moneyBack);
      const newTier = deriveTier(newSpend);
      await executor.query(UPDATE_CUSTOMER_TOTALS_SQL, [customerId, moneyBack, newTier]);
      tierRetained = newTier === tier;
      tier = newTier;
    }
  }

  return {
    status: "clawed_back",
    customerId,
    orderReference,
    entry,
    clawbackPoints: clawbackMagnitude,
    totalEarned,
    cumulativeClawback: alreadyClawedBack + clawbackMagnitude,
    lotsConsumed: consumeAmount,
    tier,
    tierRetained,
  };
}

/** Reads the customer's retained tier column, or null when the row is absent. */
async function readTier(executor: Queryable, customerId: string): Promise<string | null> {
  const res = await executor.query<{ tier: string }>(CUSTOMER_TOTALS_SQL, [customerId]);
  return res.rows[0]?.tier ?? null;
}

// ---------------------------------------------------------------------------
// Webhook payload parsing + job handlers (verified/deduped path only, Req 4.8)
// ---------------------------------------------------------------------------

const moneyLike = z.union([z.number(), z.string()]).optional().nullable();

/** Minimal `refunds/create` payload shape we read. Unknown fields are ignored. */
const refundPayloadSchema = z.object({
  order_id: z.union([z.number(), z.string()]).optional().nullable(),
  refund_line_items: z
    .array(
      z.object({
        subtotal: moneyLike,
        subtotal_set: z
          .object({ shop_money: z.object({ amount: moneyLike }).partial().optional() })
          .partial()
          .optional()
          .nullable(),
      }),
    )
    .optional()
    .nullable(),
});

/** Minimal `orders/cancelled` payload shape we read. */
const cancelledPayloadSchema = z.object({
  id: z.union([z.number(), z.string()]).optional().nullable(),
});

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toPositiveInt(value: number | string | null | undefined): number | null {
  const n = toNumber(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Sums the refunded eligible amount from a `refunds/create` payload — the
 * refund line-item subtotals (post-discount, excluding tax), preferring the
 * explicit `subtotal` and falling back to `subtotal_set.shop_money.amount`.
 * Exported for unit testing.
 */
export function deriveRefundedEligibleAmount(payload: unknown): number {
  const parsed = refundPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return 0;
  }
  const items = parsed.data.refund_line_items ?? [];
  let total = 0;
  for (const item of items) {
    const direct = toNumber(item.subtotal);
    if (direct !== null) {
      total += direct;
      continue;
    }
    const nested = toNumber(item.subtotal_set?.shop_money?.amount);
    if (nested !== null) {
      total += nested;
    }
  }
  return total > 0 ? total : 0;
}

/** Extracts the order id a `refunds/create` payload refers to. */
function extractRefundOrderId(payload: unknown): number {
  const parsed = refundPayloadSchema.safeParse(payload);
  const orderId = parsed.success ? toPositiveInt(parsed.data.order_id) : null;
  if (orderId === null) {
    throw new InvalidClawbackPayloadError(
      "refunds/create payload is missing a usable order_id.",
    );
  }
  return orderId;
}

/** Extracts the order id from an `orders/cancelled` payload. */
function extractCancelledOrderId(payload: unknown): number {
  const parsed = cancelledPayloadSchema.safeParse(payload);
  const orderId = parsed.success ? toPositiveInt(parsed.data.id) : null;
  if (orderId === null) {
    throw new InvalidClawbackPayloadError(
      "orders/cancelled payload is missing a usable order id.",
    );
  }
  return orderId;
}

/** Dependencies for the clawback job handlers. */
export interface ClawbackJobDeps {
  repo: LedgerRepository;
  transactor: Transactor;
  /** Policy flags; defaults to {@link DEFAULT_CLAWBACK_POLICY}. */
  policy?: ClawbackPolicy;
  /**
   * Refund mode only: the original earn rate (tier multiplier) applied to the
   * order. Defaults to 1 (Bronze). Property 8 bounds the result regardless.
   */
  earnRate?: number;
}

/**
 * Consumes a verified, deduplicated `webhook.process` job for the
 * `refunds/create` topic (the hand-off produced by task 3.2) and applies the
 * refund clawback. This is the ONLY sanctioned invocation path for a refund
 * clawback (Req 4.8). A job for any other topic is ignored (returns `null`) so
 * this handler can share the `webhook.process` queue with the earning handlers.
 */
export async function handleRefundJob(
  job: WebhookJob,
  deps: ClawbackJobDeps,
): Promise<ClawbackOutcome | null> {
  if (job.topic !== REFUNDS_CREATE_TOPIC) {
    return null;
  }

  const orderReference = extractRefundOrderId(job.payload);
  const refundedEligibleAmount = deriveRefundedEligibleAmount(job.payload);

  return deps.transactor.transaction((tx) =>
    clawback(
      deps.repo,
      {
        orderReference,
        mode: "refund",
        refundedEligibleAmount,
        earnRate: deps.earnRate,
        sourceEventId: job.webhookId,
        policy: deps.policy,
      },
      tx,
    ),
  );
}

/**
 * Consumes a verified, deduplicated `webhook.process` job for the
 * `orders/cancelled` topic and reverses the order's earned points (Req 4.2).
 * The ONLY sanctioned invocation path for a cancellation clawback (Req 4.8); a
 * job for any other topic returns `null`.
 */
export async function handleOrderCancelledJob(
  job: WebhookJob,
  deps: ClawbackJobDeps,
): Promise<ClawbackOutcome | null> {
  if (job.topic !== ORDERS_CANCELLED_TOPIC) {
    return null;
  }

  const orderReference = extractCancelledOrderId(job.payload);

  return deps.transactor.transaction((tx) =>
    clawback(
      deps.repo,
      {
        orderReference,
        mode: "cancellation",
        sourceEventId: job.webhookId,
        policy: deps.policy,
      },
      tx,
    ),
  );
}
