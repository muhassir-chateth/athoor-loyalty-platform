/**
 * Paid-order earning, first-purchase bonus, and point lots (task 4.2).
 *
 * Implements the `orders/paid` earning rules of the Loyalty Engine
 * (design.md "Component 2: Loyalty Engine" `earnOrder` / `earnFirstPurchase`;
 * "Key Functions → earnOrder()"; the earning data-flow "resolve tier, compute
 * points = floor(eligible_total * multiplier)" then "INSERT ledger(earn) +
 * point_lot; recompute tier"). It is the ONLY writer of `earn_order` and
 * `earn_first_purchase` movements and their matching `point_lots`.
 *
 * Requirements covered:
 *   - 2.2  On a verified `orders/paid` with `eligibleTotal > 0`, create exactly
 *          one `earn_order` earning of `floor(eligibleTotal × tierMultiplier)`
 *          points, where `eligibleTotal` is the post-discount subtotal in store
 *          currency excluding shipping and tax. *(Property 7, A2)*
 *   - 2.3  If `eligibleTotal <= 0`, create no order earning and leave the
 *          customer's Balance unchanged.
 *   - 2.5  If no prior paid-order earning exists for the customer, create an
 *          additional `earn_first_purchase` earning of exactly 100 points.
 *          *(Property 7)*
 *   - 2.6  For each earning created, create a matching Point_Lot whose expiry
 *          timestamp is exactly 12 months after the earning timestamp. *(A1)*
 *   - 2.11 Increase only the affected customer's Balance; no other customer's
 *          rows are touched.
 *   - 7.2/7.3 (Property 11) Advance the customer's tier from the updated
 *          lifetime spend and NEVER lower it; the multiplier applied is the
 *          tier held at the time the order is processed (Req 2.4).
 *
 * ---------------------------------------------------------------------------
 * `eligibleTotal` derivation (A2 — post-discount, excludes shipping & tax)
 * ---------------------------------------------------------------------------
 * Derived from the Shopify `orders/paid` payload using this documented
 * precedence (all monetary fields are store-currency, GBP at MVP per A8, sent
 * by Shopify as decimal strings such as "45.00"):
 *
 *   1. `current_subtotal_price` — the order's current line-item subtotal AFTER
 *      discounts and EXCLUDING shipping and tax. Preferred because it reflects
 *      the order's state at payment.
 *   2. `subtotal_price` — the line-item subtotal after discounts, excluding
 *      shipping and tax (used when `current_subtotal_price` is absent).
 *   3. `max(0, total_line_items_price − total_discounts)` — computed fallback
 *      when neither subtotal field is present.
 *
 * Shipping (`total_shipping_price_set`) and tax (`total_tax`) are deliberately
 * NEVER included, satisfying A2.
 *
 * ---------------------------------------------------------------------------
 * Lifetime spend / tier
 * ---------------------------------------------------------------------------
 * The order's `eligibleTotal` is added to `customers.lifetime_spend_gbp`, then
 * the tier is advanced via {@link advanceTier} (task 4.3), which is monotonic
 * and never lowers the retained tier (Property 11). The earning multiplier is
 * looked up from the tier held BEFORE this order is applied (`tier_at_time`,
 * Req 2.4). This module reuses the tier module unchanged (deriveTier /
 * advanceTier / tierMultiplier); it does not reimplement tier maths.
 *
 * SAFETY: defining this module touches no live/production system and calls no
 * Shopify Admin API. It issues SQL only when a caller passes a real
 * Pool/PoolClient (or a transaction client) at runtime; all logic is unit
 * tested against an in-memory {@link Queryable} fake, so live DB verification is
 * deferred to deploy time.
 */
import { z } from "zod";
import type { LedgerEntry, LedgerRepository, Queryable } from "../ledger/repository.js";
import { addMonths, createExpiringPointLot, LOT_EXPIRY_MONTHS } from "../ledger/pointLots.js";
import { advanceTier, tierMultiplier, type Tier } from "../tier/tier.js";
import type { WebhookJob } from "../webhooks/enqueue.js";

/** The exact first-purchase earning amount (Requirement 2.5). */
export const FIRST_PURCHASE_POINTS = 100 as const;

/** The reason recorded on an `earn_order` ledger entry. */
export const ORDER_EARN_REASON = "paid_order" as const;

/** The reason recorded on an `earn_first_purchase` ledger entry. */
export const FIRST_PURCHASE_REASON = "first_purchase_bonus" as const;

/** The webhook topic this earning responds to. */
export const ORDERS_PAID_TOPIC = "orders/paid" as const;

/**
 * Point-lot expiry window in months, measured from the earning timestamp
 * (A1, Req 2.6). Re-exported from the shared lot helper so existing importers
 * are unaffected by the move.
 */
export { LOT_EXPIRY_MONTHS };

/**
 * Runs a unit of work inside a single database transaction. The order-earning
 * flow (resolve/lock customer → idempotency guard → append earnings + lots →
 * update spend/tier) MUST be atomic so a partially-applied order can never
 * occur; the caller supplies a transactor that BEGINs, passes the transaction
 * client, and COMMITs / ROLLBACKs.
 *
 * Declared locally (structurally identical to the signup module's) so order
 * earning is independent of signup.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Input to {@link earnOrder}. */
export interface OrderEarnInput {
  /** The numeric Shopify customer id from the `orders/paid` payload. */
  shopifyCustomerId: number;
  /** The numeric Shopify order id — the idempotency anchor for `earn_order`. */
  shopifyOrderId: number;
  /**
   * The post-discount order subtotal in store currency, excluding shipping and
   * tax (A2). Positive earns; `<= 0` is a no-op (Req 2.3).
   */
  eligibleTotal: number;
  /** Customer email, if present in the payload (stored, never logged raw). */
  email?: string | null;
  /** X-Shopify-Webhook-Id, recorded on the ledger entries for traceability. */
  sourceEventId?: string | null;
}

/**
 * The outcome of an order-earning attempt.
 *  - `earned`         a positive-eligible order was processed: 0–2 earning
 *                     entries were created (`earn_order`, plus
 *                     `earn_first_purchase` when it is the first earning order)
 *                     and lifetime spend / tier were updated.
 *  - `no_earning`     `eligibleTotal <= 0`: nothing was created and the
 *                     Balance is unchanged (Req 2.3).
 *  - `already_earned` an `earn_order` already existed for this order reference;
 *                     nothing was created and all balances are unchanged
 *                     (order-replay idempotency).
 */
export type OrderEarnOutcome =
  | {
      status: "earned";
      customerId: string;
      orderReference: number;
      /** The earning entries created, in creation order (length 0, 1, or 2). */
      entries: LedgerEntry[];
      /** The `earn_order` point amount `floor(eligibleTotal × multiplier)`. */
      orderPoints: number;
      /** True iff an `earn_first_purchase` (+100) was created this time. */
      firstPurchase: boolean;
      /** The multiplier tier used (the tier held before this order, Req 2.4). */
      tierAtTime: Tier;
      /** The customer's retained tier after advancement (never lowered). */
      tier: Tier;
      /** The customer's lifetime spend (GBP) after adding this order. */
      lifetimeSpendGBP: number;
    }
  | { status: "no_earning"; customerId: string; orderReference: number }
  | { status: "already_earned"; customerId: string; orderReference: number };

/** Thrown when the `orders/paid` payload lacks a usable order or customer id. */
export class InvalidOrdersPaidPayloadError extends Error {
  readonly code = "invalid_orders_paid_payload";
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrdersPaidPayloadError";
  }
}

/**
 * Upserts the customer keyed by Shopify id and returns the id plus the CURRENT
 * (pre-order) tier and lifetime spend. The upsert makes resolution idempotent
 * at the row level and, on conflict, takes a row lock held to commit so the
 * read-modify-write of `lifetime_spend_gbp` is safe under concurrency. It only
 * bumps `updated_at` (and back-fills a missing email), so the RETURNed `tier`
 * and `lifetime_spend_gbp` are the customer's current values.
 *
 * Per A3, a customer with no prior `customers` row is enrolled lazily here on
 * this qualifying event. Only this one Shopify id is touched (Req 2.11).
 */
const UPSERT_CUSTOMER_SQL = `
  INSERT INTO customers (shopify_customer_id, email)
  VALUES ($1, $2)
  ON CONFLICT (shopify_customer_id) DO UPDATE
    SET email      = COALESCE(customers.email, EXCLUDED.email),
        updated_at = now()
  RETURNING id, tier, lifetime_spend_gbp
`;

/**
 * Order-replay idempotency guard: does an `earn_order` already exist for this
 * customer AND this Shopify order reference? Combined with the upstream
 * webhook-id dedupe (task 3.2), this ensures a replayed `orders/paid` for the
 * same order never double-earns — even under a different webhook id.
 */
const EXISTING_ORDER_EARNING_SQL = `
  SELECT 1
  FROM ledger_entries
  WHERE customer_id = $1
    AND entry_type = 'earn_order'
    AND order_reference = $2
  LIMIT 1
`;

/**
 * First-purchase guard (Req 2.5): does the customer already have ANY
 * `earn_order` entry? "First" is defined as the customer having no existing
 * `earn_order` entry. Runs inside the transaction so the guard read and the
 * subsequent appends are atomic.
 */
const ANY_ORDER_EARNING_SQL = `
  SELECT 1
  FROM ledger_entries
  WHERE customer_id = $1
    AND entry_type = 'earn_order'
  LIMIT 1
`;

/**
 * Persists the updated lifetime spend and advanced tier. Spend is incremented
 * RELATIVELY (`+ $2`) so concurrent orders sum correctly; the tier is the
 * monotonic {@link advanceTier} result (never lowered, Property 11).
 */
const UPDATE_CUSTOMER_TOTALS_SQL = `
  UPDATE customers
  SET lifetime_spend_gbp = lifetime_spend_gbp + $2,
      tier               = $3,
      updated_at         = now()
  WHERE id = $1
`;

interface CustomerTotalsRow {
  id: string;
  tier: string;
  lifetime_spend_gbp: string | number;
}

/**
 * Re-exported from {@link ../ledger/pointLots.js} so existing importers keep
 * working now that lot creation is shared across every credit path.
 */
export { addMonths };

/**
 * Computes the `earn_order` point amount `floor(eligibleTotal × multiplier)`
 * (Req 2.2, Property 7). Money is handled in integer minor units (pence) before
 * applying the multiplier so the multiply-then-floor is free of binary-float
 * drift for the tier multipliers (1, 1.5, 2, 3). Never returns a negative
 * value.
 */
export function computeOrderPoints(eligibleTotal: number, multiplier: number): number {
  if (!Number.isFinite(eligibleTotal) || eligibleTotal <= 0) {
    return 0;
  }
  const pence = Math.round(eligibleTotal * 100);
  const points = Math.floor((pence * multiplier) / 100);
  return points > 0 ? points : 0;
}

/** Parses a NUMERIC column (`pg` returns it as a string) into a GBP number. */
function parseMoneyColumn(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Creates a Point_Lot matching an earning entry (Req 2.6). Delegates to the
 * shared {@link createExpiringPointLot} so every credit path — signup, order,
 * referral, admin credit — produces an identically shaped lot (Property 17).
 */
async function createPointLot(
  executor: Queryable,
  customerId: string,
  entry: LedgerEntry,
): Promise<void> {
  await createExpiringPointLot(executor, customerId, entry);
}

/**
 * Applies the `orders/paid` earning for a single order inside the caller's
 * transaction (Requirements 2.2, 2.3, 2.5, 2.6, 2.11; Property 7, Property 11).
 *
 * Flow:
 *   1. Resolve + lazily enrol the customer, reading the pre-order tier + spend.
 *   2. If `eligibleTotal <= 0`: no-op, Balance unchanged (Req 2.3).
 *   3. Order-replay idempotency guard on `(customer, order_reference)`.
 *   4. Compute `orderPoints = floor(eligibleTotal × multiplier(tier_at_time))`.
 *   5. If `orderPoints >= 1`: append one `earn_order` + matching lot; when no
 *      prior `earn_order` existed, also append `earn_first_purchase` (+100) +
 *      matching lot (Req 2.5).
 *   6. Increase `lifetime_spend_gbp` by `eligibleTotal` and advance the tier
 *      (never lowering it, Property 11).
 *
 * MUST run inside a transaction: pass the transaction client as `executor`.
 * Performs no HMAC/verification itself — invoked only from the verified/deduped
 * path (see {@link handleOrdersPaidJob}).
 */
export async function earnOrder(
  repo: LedgerRepository,
  input: OrderEarnInput,
  executor: Queryable,
): Promise<OrderEarnOutcome> {
  // (1) Resolve + lazily enrol the customer; read pre-order tier and spend.
  const upserted = await executor.query<CustomerTotalsRow>(UPSERT_CUSTOMER_SQL, [
    input.shopifyCustomerId,
    input.email ?? null,
  ]);
  const customerRow = upserted.rows[0];
  if (!customerRow) {
    throw new Error(
      `Failed to resolve customer id for shopify_customer_id ${input.shopifyCustomerId}.`,
    );
  }
  const customerId = customerRow.id;
  const tierAtTime = advanceTier(customerRow.tier, parseMoneyColumn(customerRow.lifetime_spend_gbp));
  const currentSpend = parseMoneyColumn(customerRow.lifetime_spend_gbp);

  // (2) Non-positive eligible total → create nothing, Balance unchanged (Req 2.3).
  if (!Number.isFinite(input.eligibleTotal) || input.eligibleTotal <= 0) {
    return { status: "no_earning", customerId, orderReference: input.shopifyOrderId };
  }

  // (3) Order-replay idempotency: if this order already earned, change nothing.
  const alreadyEarned = await executor.query(EXISTING_ORDER_EARNING_SQL, [
    customerId,
    input.shopifyOrderId,
  ]);
  if ((alreadyEarned.rowCount ?? alreadyEarned.rows.length) > 0) {
    return { status: "already_earned", customerId, orderReference: input.shopifyOrderId };
  }

  // (4) Earning maths: multiplier from the tier held at processing time (Req 2.4).
  const multiplier = tierMultiplier(tierAtTime);
  const orderPoints = computeOrderPoints(input.eligibleTotal, multiplier);

  const entries: LedgerEntry[] = [];
  let firstPurchase = false;

  // (5) Create the earning entries + matching lots. An earn entry must be
  // strictly positive (Req 1.4), so a sub-point order (floor === 0) creates no
  // earning; its spend still accrues below.
  if (orderPoints >= 1) {
    const priorOrderEarning = await executor.query(ANY_ORDER_EARNING_SQL, [customerId]);
    const isFirstEarningOrder = (priorOrderEarning.rowCount ?? priorOrderEarning.rows.length) === 0;

    const orderEntry = await repo.append(
      {
        customerId,
        entryType: "earn_order",
        points: orderPoints,
        reason: ORDER_EARN_REASON,
        orderReference: input.shopifyOrderId,
        sourceEventId: input.sourceEventId ?? null,
      },
      executor,
    );
    await createPointLot(executor, customerId, orderEntry);
    entries.push(orderEntry);

    // First-purchase bonus (Req 2.5): granted with the customer's first earning
    // order, i.e. when no prior `earn_order` existed. Anchoring it to the first
    // `earn_order` creation guarantees exactly-once.
    if (isFirstEarningOrder) {
      const firstPurchaseEntry = await repo.append(
        {
          customerId,
          entryType: "earn_first_purchase",
          points: FIRST_PURCHASE_POINTS,
          reason: FIRST_PURCHASE_REASON,
          orderReference: input.shopifyOrderId,
          sourceEventId: input.sourceEventId ?? null,
        },
        executor,
      );
      await createPointLot(executor, customerId, firstPurchaseEntry);
      entries.push(firstPurchaseEntry);
      firstPurchase = true;
    }
  }

  // (6) Update lifetime spend and advance the tier (never lowering it).
  const newLifetimeSpend = currentSpend + input.eligibleTotal;
  const advancedTier = advanceTier(tierAtTime, newLifetimeSpend);
  await executor.query(UPDATE_CUSTOMER_TOTALS_SQL, [customerId, input.eligibleTotal, advancedTier]);

  return {
    status: "earned",
    customerId,
    orderReference: input.shopifyOrderId,
    entries,
    orderPoints,
    firstPurchase,
    tierAtTime,
    tier: advancedTier,
    lifetimeSpendGBP: newLifetimeSpend,
  };
}

/**
 * Minimal schema for the `orders/paid` payload fields we need. Shopify sends
 * ids as numbers (or numeric strings) and money as decimal strings. Unknown
 * fields are ignored.
 */
const moneyLike = z.union([z.number(), z.string()]).optional().nullable();
const ordersPaidPayloadSchema = z.object({
  id: z.union([z.number(), z.string()]),
  customer: z
    .object({
      id: z.union([z.number(), z.string()]),
      email: z.string().email().optional().nullable(),
    })
    .optional()
    .nullable(),
  email: z.string().email().optional().nullable(),
  current_subtotal_price: moneyLike,
  subtotal_price: moneyLike,
  total_line_items_price: moneyLike,
  total_discounts: moneyLike,
});

/** Parses a Shopify money-like value (number or decimal string) to a number, or null. */
function parseMoneyLike(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derives `eligibleTotal` — the post-discount subtotal excluding shipping and
 * tax (A2) — from an `orders/paid` payload, using the documented field
 * precedence (see module header). Exported for unit testing.
 */
export function deriveEligibleTotal(payload: unknown): number {
  const parsed = ordersPaidPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return 0;
  }
  const p = parsed.data;

  const current = parseMoneyLike(p.current_subtotal_price);
  if (current !== null) {
    return current;
  }
  const subtotal = parseMoneyLike(p.subtotal_price);
  if (subtotal !== null) {
    return subtotal;
  }
  // Computed fallback: line-item total minus discounts, never negative.
  const lineItems = parseMoneyLike(p.total_line_items_price) ?? 0;
  const discounts = parseMoneyLike(p.total_discounts) ?? 0;
  return Math.max(0, lineItems - discounts);
}

/** Extracts and validates the numeric Shopify order id and customer id + eligibleTotal. */
function extractOrderInput(payload: unknown): {
  shopifyOrderId: number;
  shopifyCustomerId: number;
  eligibleTotal: number;
  email: string | null;
} {
  const parsed = ordersPaidPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidOrdersPaidPayloadError("orders/paid payload is missing a usable order id.");
  }
  const rawOrderId = parsed.data.id;
  const orderId = typeof rawOrderId === "number" ? rawOrderId : Number(rawOrderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new InvalidOrdersPaidPayloadError(
      `orders/paid payload carried an invalid order id: ${String(rawOrderId)}.`,
    );
  }

  const customer = parsed.data.customer;
  if (!customer) {
    throw new InvalidOrdersPaidPayloadError(
      "orders/paid payload has no customer to attribute the earning to.",
    );
  }
  const rawCustomerId = customer.id;
  const customerId = typeof rawCustomerId === "number" ? rawCustomerId : Number(rawCustomerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new InvalidOrdersPaidPayloadError(
      `orders/paid payload carried an invalid customer id: ${String(rawCustomerId)}.`,
    );
  }

  return {
    shopifyOrderId: orderId,
    shopifyCustomerId: customerId,
    eligibleTotal: deriveEligibleTotal(payload),
    email: customer.email ?? parsed.data.email ?? null,
  };
}

/** Dependencies for the `orders/paid` job handler. */
export interface OrderJobDeps {
  repo: LedgerRepository;
  transactor: Transactor;
  /**
   * OPTIONAL referral stage advance (task 25, Req 2.10/11.9). The design's
   * webhook table specifies that `orders/paid` "advance[s] referral stage": if
   * this order is the buyer's FIRST paid purchase and they were referred, the
   * referrer is credited +250.
   *
   * Injected as a callback rather than imported directly so this module keeps no
   * dependency on the referral module, mirroring how the metafield enqueuer is
   * threaded through the worker.
   *
   * WHY IT RUNS INSIDE THE ORDER TRANSACTION: the award is derived from
   * `firstPurchase`, which is only true on the transaction that creates the
   * first-purchase earning. If the award ran afterwards in its own transaction
   * and failed, the pg-boss retry would see `already_earned`, lose the flag, and
   * never award — the reward would be silently skipped. Sharing the transaction
   * makes earning and referral advance succeed or fail together.
   */
  advanceReferralStage?: (
    args: { referredCustomerId: string; isFirstPaidPurchase: boolean; sourceEventId: string | null },
    tx: Queryable,
  ) => Promise<void>;
}

/**
 * Consumes a verified, deduplicated `webhook.process` job for the `orders/paid`
 * topic (the hand-off produced by task 3.2) and applies the order earning.
 *
 * This is the ONLY sanctioned invocation path for {@link earnOrder}: the job
 * exists only because the HMAC gate (task 3.1) passed and the webhook-id dedupe
 * (task 3.2) recorded a new event. The whole earning runs inside one
 * transaction. A job for any other topic is ignored (returns `null`) so this
 * handler can be registered on the shared `webhook.process` queue alongside the
 * signup / refund handlers.
 *
 * @throws InvalidOrdersPaidPayloadError if the payload has no usable order or
 *         customer id.
 */
export async function handleOrdersPaidJob(
  job: WebhookJob,
  deps: OrderJobDeps,
): Promise<OrderEarnOutcome | null> {
  if (job.topic !== ORDERS_PAID_TOPIC) {
    return null;
  }

  const { shopifyOrderId, shopifyCustomerId, eligibleTotal, email } = extractOrderInput(job.payload);

  return deps.transactor.transaction(async (tx) => {
    const outcome = await earnOrder(
      deps.repo,
      { shopifyCustomerId, shopifyOrderId, eligibleTotal, email, sourceEventId: job.webhookId },
      tx,
    );

    // Advance the referral stage in the SAME transaction (Req 2.10/11.9). Only
    // on a fresh earning: a replay (`already_earned`) or a zero-value order
    // (`no_earning`) is not a qualifying purchase event. The referral module
    // itself enforces "exactly once" via `referrals.purchase_rewarded` and
    // declines when `isFirstPaidPurchase` is false.
    if (deps.advanceReferralStage && outcome.status === "earned") {
      await deps.advanceReferralStage(
        {
          referredCustomerId: outcome.customerId,
          isFirstPaidPurchase: outcome.firstPurchase,
          sourceEventId: job.webhookId ?? null,
        },
        tx,
      );
    }

    return outcome;
  });
}
