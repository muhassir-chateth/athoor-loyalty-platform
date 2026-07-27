/**
 * Tier-change history persistence (task 46).
 *
 * `tier_change_history` is created by the profile migration (task 14.1) and READ
 * by `PgFragranceProfileDataSource` to build the `tier_change` milestones of the
 * Fragrance_Journey_Timeline (Req 17.8, 17.9). Until this module existed nothing
 * ever wrote a row, so that milestone type — though defined, typed and ranked in
 * the timeline sort — could never appear for a real member. The gap was found by
 * task 45's genuine Shopify `orders/paid` delivery: the order advanced a member
 * Bronze → Gold and the table stayed empty.
 *
 * `tier.ts` deliberately stays pure (it maps numbers to tiers and touches no
 * database); persisting a change is the caller's job, which is what this module
 * provides. It is intentionally the ONLY writer, so every tier-persisting path
 * records history the same way and the milestone cannot go dormant again.
 *
 * Design contract:
 *   - a row is written ONLY when the tier actually changes. A no-op update (an
 *     order that does not cross a threshold) writes nothing, so the timeline
 *     never shows a "change" that did not happen;
 *   - the INSERT takes the caller's `executor`, so it is ATOMIC with the tier
 *     UPDATE it accompanies — a committed promotion always has its history row,
 *     and a rolled-back one leaves none;
 *   - replay safety is inherited, not re-implemented: the callers reach the tier
 *     update only after their own idempotency guards (webhook dedupe, then the
 *     per-order `earn_order` guard), so a redelivered webhook never produces a
 *     second row.
 *
 * SAFETY: pure SQL against the caller's executor; no Shopify API, no ledger
 * mutation, and no effect on Balance or Spendable_Balance.
 */
import type { Queryable } from "../ledger/repository.js";
import { normalizeTier, type Tier } from "./tier.js";

/** `reason` recorded when a paid order advances the tier (Req 7.2, 7.3). */
export const TIER_CHANGE_REASON_PAID_ORDER = "paid_order" as const;

/**
 * `reason` recorded when a clawback lowers the tier. Only reachable while the
 * `allowTierDowngradeOnClawback` policy is enabled; it is OFF by default (A4),
 * so by default a clawback retains the tier and writes nothing.
 */
export const TIER_CHANGE_REASON_CLAWBACK = "clawback" as const;

const INSERT_TIER_CHANGE_SQL = `
  INSERT INTO tier_change_history (customer_id, from_tier, to_tier, reason)
  VALUES ($1, $2, $3, $4)
`;

/**
 * Records a tier transition for a customer, but ONLY when the tier actually
 * changed.
 *
 * Runs on the caller's `executor` so it commits or rolls back with the tier
 * update it accompanies. Pass the transaction client, never the pool.
 *
 * @param executor   the transaction client performing the tier update
 * @param customerId local `customers.id`
 * @param fromTier   the tier held before the change
 * @param toTier     the tier held after the change
 * @param reason     why the tier moved (e.g. {@link TIER_CHANGE_REASON_PAID_ORDER})
 * @returns `true` when a history row was written, `false` when the tier was
 *          unchanged and nothing was written.
 */
export async function recordTierChange(
  executor: Queryable,
  customerId: string,
  fromTier: string | null | undefined,
  toTier: string | null | undefined,
  reason: string,
): Promise<boolean> {
  const from: Tier = normalizeTier(fromTier);
  const to: Tier = normalizeTier(toTier);

  // No-op guard: an order that does not cross a threshold, or a clawback that
  // retains the tier, is not a tier change and must leave no trace.
  if (from === to) {
    return false;
  }

  await executor.query(INSERT_TIER_CHANGE_SQL, [customerId, from, to, reason]);
  return true;
}
