/**
 * Balance projection, spendable-balance projection, and FIFO lot consumption
 * (task 2.3).
 *
 * These are the read-side projections and the consumption primitive that sit on
 * top of the append-only ledger (task 2.1 / design.md "Data Models"). Nothing
 * here is an authoritative store of a balance — every value is DERIVED on demand:
 *
 *   - {@link computeBalance}          Balance          = SUM(ledger_entries.points)      (Req 1.2, Property 1)
 *   - {@link computeSpendableBalance} Spendable_Balance = SUM(point_lots.remaining_points
 *                                     over non-expired lots)                             (Req 1.3, Property 2)
 *   - {@link consumeLotsFifo}         FIFO lot consumption primitive                     (Req 5.6)
 *
 * The `customers.lifetime_points` / `tier` columns are caches only; this module
 * never reads them and never treats them as truth — Balance is recomputed from
 * the immutable ledger so it is always reconstructable (Property 1).
 *
 * FIFO consumption (Req 5.6): points are consumed oldest-first by `earned_at`,
 * breaking ties between lots with identical earning dates by ascending lot
 * creation order, and only from lots whose `remaining_points > 0`. Consumption
 * is limited to NON-EXPIRED lots, so the pool available to consume equals the
 * Spendable_Balance (Req 1.3, Req 5.7). `point_lots.remaining_points` is a
 * decrement-only cache (design "Data Models"): this primitive only ever
 * DECREASES it, never increases it, and it remains fully reconstructable from
 * the ledger.
 *
 * This module provides ONLY the consumption primitive. Recording the negative
 * `spend` ledger entry, the `redemptions` row, locking the customer, and
 * minting the discount code belong to redemption (task 5.2) and are NOT done
 * here.
 *
 * SAFETY: no live/production system is touched by defining this module. It
 * issues SQL only when a caller passes a real Pool/PoolClient at runtime; all
 * logic is unit-tested against an in-memory {@link Queryable} fake, so live DB
 * verification is deferred to deploy time.
 */
import type { QueryResultRow } from "pg";
import type { Queryable } from "./repository.js";

/**
 * A point lot as needed for FIFO consumption. `remainingPoints` is the
 * decrement-only remaining balance of the lot; `earnedAt` is the primary FIFO
 * key; `creationOrder` breaks ties between lots sharing an identical
 * `earnedAt` (ascending = created earlier), satisfying Req 5.6.
 */
export interface FifoLot {
  id: string;
  remainingPoints: number;
  earnedAt: Date;
  expiresAt: Date | null;
  /**
   * Ascending lot creation order, used only to break ties when two lots share
   * the same `earnedAt` (e.g. the `earn_order` and `earn_first_purchase` lots
   * created in a single `orders/paid` transaction, which receive the same
   * transaction timestamp). Smaller = created earlier.
   */
  creationOrder: number;
}

/** A single lot decrement produced by planning a FIFO consumption. */
export interface LotAllocation {
  lotId: string;
  /** Points taken from this lot (> 0). */
  take: number;
  /** The lot's `remaining_points` before this allocation. */
  remainingBefore: number;
  /** The lot's `remaining_points` after this allocation (>= 0). */
  remainingAfter: number;
}

/** The result of planning (and, for {@link consumeLotsFifo}, applying) a consumption. */
export interface ConsumptionPlan {
  /** Per-lot decrements in FIFO order. */
  allocations: LotAllocation[];
  /** Total points allocated across all lots. */
  totalConsumed: number;
  /** Points still unmet after exhausting all lots (0 when sufficient). */
  shortfall: number;
  /** True iff the available lots covered the full requested amount. */
  sufficient: boolean;
}

/** Stable machine-readable error codes surfaced to callers. */
export const CONSUMPTION_ERROR_CODES = {
  invalidAmount: "lot_consumption_invalid_amount",
  insufficientPoints: "insufficient_points",
} as const;

/** Thrown when a consumption amount is not a positive safe integer. */
export class LotConsumptionValidationError extends Error {
  readonly code = CONSUMPTION_ERROR_CODES.invalidAmount;
  constructor(message: string) {
    super(message);
    this.name = "LotConsumptionValidationError";
  }
}

/**
 * Thrown when a FIFO consumption requests more points than the sum of
 * `remaining_points` across the customer's non-expired lots. The lots are left
 * unchanged (Req 5.7).
 */
export class InsufficientPointsError extends Error {
  readonly code = CONSUMPTION_ERROR_CODES.insufficientPoints;
  readonly requested: number;
  readonly available: number;
  constructor(requested: number, available: number) {
    super(
      `Insufficient points: requested ${requested} but only ${available} available ` +
        `across non-expired lots; no lot was modified.`,
    );
    this.name = "InsufficientPointsError";
    this.requested = requested;
    this.available = available;
  }
}

/** Parses a BIGINT/NUMERIC column (`pg` returns these as strings) into a safe integer. */
function parseIntegerColumn(value: string | number | null, column: string): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `Column '${column}' value '${value}' is outside the safe integer range.`,
    );
  }
  return n;
}

function assertPositiveInteger(amount: number): void {
  if (typeof amount !== "number" || !Number.isInteger(amount) || !Number.isSafeInteger(amount)) {
    throw new LotConsumptionValidationError(
      `A consumption amount must be a safe integer; received ${String(amount)}.`,
    );
  }
  if (amount <= 0) {
    throw new LotConsumptionValidationError(
      `A consumption amount must be strictly greater than zero; received ${amount}.`,
    );
  }
}

const BALANCE_SQL = `
  SELECT COALESCE(SUM(points), 0)::text AS balance
  FROM ledger_entries
  WHERE customer_id = $1
`;

/**
 * Computes a customer's Balance as `SUM(ledger_entries.points)` (Req 1.2,
 * Property 1). Balance is DERIVED here on demand and is never read from any
 * mutable cache column; recomputing it always reproduces the true balance.
 *
 * @param customerId the customer whose ledger to sum.
 * @param executor   Pool/PoolClient to run on (pass a transaction's client to
 *                   read a consistent snapshot within a redemption).
 */
export async function computeBalance(customerId: string, executor: Queryable): Promise<number> {
  const result = await executor.query<{ balance: string }>(BALANCE_SQL, [customerId]);
  return parseIntegerColumn(result.rows[0]?.balance ?? 0, "balance");
}

const SPENDABLE_SQL = `
  SELECT COALESCE(SUM(remaining_points), 0)::text AS spendable
  FROM point_lots
  WHERE customer_id = $1
    AND remaining_points > 0
    AND (expires_at IS NULL OR expires_at > $2)
`;

/**
 * Computes a customer's Spendable_Balance as the sum of `remaining_points`
 * across their NON-EXPIRED lots (Req 1.3, Property 2). A lot is non-expired
 * when `expires_at` is NULL (never expires) or strictly after `asOf`.
 *
 * This is the pool of points available to redeem; it equals the amount
 * {@link consumeLotsFifo} can consume.
 *
 * @param customerId the customer whose lots to sum.
 * @param executor   Pool/PoolClient to run on.
 * @param asOf       the reference instant for expiry (defaults to now).
 */
export async function computeSpendableBalance(
  customerId: string,
  executor: Queryable,
  asOf: Date = new Date(),
): Promise<number> {
  const result = await executor.query<{ spendable: string }>(SPENDABLE_SQL, [customerId, asOf]);
  return parseIntegerColumn(result.rows[0]?.spendable ?? 0, "spendable");
}

/**
 * Orders lots for FIFO consumption (Req 5.6): ascending `earnedAt`, then
 * ascending `creationOrder` to break ties between lots earned at the same
 * instant. Pure and stable; does not mutate the input array.
 */
export function orderLotsFifo(lots: readonly FifoLot[]): FifoLot[] {
  return [...lots].sort((a, b) => {
    const byEarned = a.earnedAt.getTime() - b.earnedAt.getTime();
    if (byEarned !== 0) {
      return byEarned;
    }
    return a.creationOrder - b.creationOrder;
  });
}

/**
 * Plans a FIFO consumption over the given lots WITHOUT touching a database
 * (pure). Consumes oldest-first (Req 5.6), taking `min(remaining, outstanding)`
 * from each lot and skipping any lot whose `remaining_points <= 0`.
 *
 * Returns the per-lot allocations plus whether the lots covered the full
 * amount. It never allocates more than `amount` and never drives a lot below
 * zero — so applying the plan keeps Spendable_Balance >= 0 (supports Req 3.4 /
 * Property 3 for the later redemption path).
 *
 * @param lots   candidate lots (need not be pre-ordered; ordered internally).
 * @param amount the number of points to consume (positive integer).
 */
export function planFifoConsumption(lots: readonly FifoLot[], amount: number): ConsumptionPlan {
  assertPositiveInteger(amount);

  const ordered = orderLotsFifo(lots);
  const allocations: LotAllocation[] = [];
  let outstanding = amount;

  for (const lot of ordered) {
    if (outstanding <= 0) {
      break;
    }
    if (lot.remainingPoints <= 0) {
      // Only consume from lots with remaining_points > 0 (Req 5.6).
      continue;
    }
    const take = Math.min(lot.remainingPoints, outstanding);
    allocations.push({
      lotId: lot.id,
      take,
      remainingBefore: lot.remainingPoints,
      remainingAfter: lot.remainingPoints - take,
    });
    outstanding -= take;
    // Loop invariant: sum(take so far) + outstanding === amount.
  }

  const totalConsumed = amount - outstanding;
  return {
    allocations,
    totalConsumed,
    shortfall: outstanding,
    sufficient: outstanding === 0,
  };
}

interface PointLotRow extends QueryResultRow {
  id: string;
  remaining_points: string | number;
  earned_at: Date;
  expires_at: Date | null;
}

/**
 * Selects a customer's consumable lots — `remaining_points > 0` and non-expired
 * — locked `FOR UPDATE` and ordered for FIFO consumption. Ordering is
 * `earned_at ASC` then `ctid ASC`; `ctid` reflects physical insertion order and
 * is used as the ascending lot-creation-order tie-break for lots sharing an
 * `earned_at` (Req 5.6). point_lots rows are only ever updated in place (the
 * remaining_points decrement), never moved, so ctid preserves creation order.
 *
 * NOTE: a fully migration-robust guarantee would add an explicit monotonic
 * creation sequence column; that schema change is deferred (live DB
 * verification deferred). The `creationOrder` returned here is the select's row
 * position, which preserves the SQL ordering for downstream planning.
 */
const SELECT_CONSUMABLE_LOTS_SQL = `
  SELECT id, remaining_points, earned_at, expires_at
  FROM point_lots
  WHERE customer_id = $1
    AND remaining_points > 0
    AND (expires_at IS NULL OR expires_at > $2)
  ORDER BY earned_at ASC, ctid ASC
  FOR UPDATE
`;

const DECREMENT_LOT_SQL = `
  UPDATE point_lots
  SET remaining_points = remaining_points - $1
  WHERE id = $2
`;

/**
 * The FIFO lot consumption primitive used later by redemption (task 5.2)
 * (Req 5.6). Within the caller's transaction it:
 *
 *   1. selects the customer's non-expired lots with `remaining_points > 0`,
 *      locked `FOR UPDATE` and ordered oldest-first (earned_at, then creation
 *      order);
 *   2. plans the consumption greedily;
 *   3. if the available lots cannot cover `amount`, throws
 *      {@link InsufficientPointsError} and applies NO decrement, leaving every
 *      lot unchanged (Req 5.7);
 *   4. otherwise decrements each consumed lot's `remaining_points` by exactly
 *      the amount taken and returns the applied plan.
 *
 * This primitive does NOT append a `spend` ledger entry or create a redemption
 * row — that is the redemption caller's responsibility (task 5.2). It must run
 * inside a transaction (pass the transaction's client as `executor`) so the
 * `FOR UPDATE` lock and the decrements are atomic with the caller's spend entry.
 *
 * @param customerId the customer whose lots to consume.
 * @param amount     the points to consume (positive integer, e.g. a reward cost).
 * @param executor   the transaction client (Pool/PoolClient) to run within.
 * @param asOf       the reference instant for expiry (defaults to now).
 */
export async function consumeLotsFifo(
  customerId: string,
  amount: number,
  executor: Queryable,
  asOf: Date = new Date(),
): Promise<ConsumptionPlan> {
  assertPositiveInteger(amount);

  const result = await executor.query<PointLotRow>(SELECT_CONSUMABLE_LOTS_SQL, [customerId, asOf]);

  const lots: FifoLot[] = result.rows.map((row, index) => ({
    id: row.id,
    remainingPoints: parseIntegerColumn(row.remaining_points, "remaining_points"),
    earnedAt: row.earned_at,
    expiresAt: row.expires_at,
    // Preserve the SQL FIFO ordering (earned_at, ctid) as the tie-break key.
    creationOrder: index,
  }));

  const plan = planFifoConsumption(lots, amount);

  if (!plan.sufficient) {
    // Reject before any write so the lots remain unchanged (Req 5.7).
    throw new InsufficientPointsError(amount, plan.totalConsumed);
  }

  for (const allocation of plan.allocations) {
    await executor.query(DECREMENT_LOT_SQL, [allocation.take, allocation.lotId]);
  }

  return plan;
}
