# Tier-change history — live verification

**Date:** 2026-07-27 · **Store:** `athoor-loyalty-staging.myshopify.com` (staging) · **Task:** 46 · **Commit:** `720c540`

The defect: a tier promotion updated `customers.tier` but wrote no
`tier_change_history` row, so the Fragrance_Journey_Timeline's `tier_change`
milestone could never appear for any member (Req 17.8). Found by task 45's
genuine `orders/paid` delivery, not by tests — the table was created by a
migration and read by the profile data source, but had no writer at all.

## Audit: everywhere a tier is persisted

| Site | Persists tier? | Records history now? | Why |
|---|---|---|---|
| `earning/order.ts` — paid-order promotion | Yes | **Yes** | The defect; the only path a real member hits |
| `earning/clawback.ts` — downgrade branch | Yes, when `allowTierDowngradeOnClawback` is on | **Yes** | A downgrade is a real tier change. The policy is **off by default** (A4), so default behaviour is unchanged |
| `reconciliation/reconcile.ts` — cache repair | Yes | **No, deliberately** | Repairs drift between the cache and the ledger; it is not a member event, and reconciliation stays detect-only |
| `migration/m1Backfill.ts` — M1 initial tier | Yes | **No, deliberately** | Assigns a starting tier during cutover; writing history here would backfill invented milestones |

## Implementation

`src/tier/tierHistory.ts` is the single writer. `recordTierChange` takes the
caller's `executor`, so the row commits or rolls back with the tier `UPDATE` it
accompanies, and it returns early without issuing any SQL when the tier did not
change. `tier.ts` stays pure. Replay protection is inherited rather than
re-implemented: the callers only reach the tier update after webhook dedupe and
the per-order `earn_order` guard.

## Live evidence — genuine Shopify payment capture

Throwaway member enrolled through a real `customers/create`, then promoted by a
real `orders/paid` (`orderCreate` unpaid → `orderMarkAsPaid`).

| Check | Result |
|---|---|
| Genuine delivery processed | `webhook_events` `46f1895b-…852d`, topic `orders/paid`, `status = processed` |
| Tier advanced | `customers.tier` Bronze → **Gold**, `lifetime_spend_gbp` 949.95 |
| **History row written** | exactly **1** row: `bronze → gold`, reason `paid_order` |
| Atomic + consistent | SQL join confirms `customers.tier = tier_change_history.to_tier` |
| Earning unchanged | `earn_order` 949, `earn_first_purchase` 100 — identical to task 45 |
| **Milestone now appears** | `GET /v1/profile/journey` → `["first_purchase","tier_change"]`, the `tier_change` carrying `fromTier: "bronze"`, `toTier: "gold"`, `"Tier changed from bronze to gold"` |
| Same in the profile | `GET /v1/profile` embeds the identical journey |

### Live no-op case

A **second** genuine paid order (Gift Card, $10) that does not cross a threshold:

- earned a further `earn_order` of **20** = `floor(10.00 × 2.0)` on the new Gold
  multiplier, so earning kept working;
- `lifetime_spend_gbp` 959.95, tier still Gold;
- `tier_change_history` still **exactly 1 row**, still the original promotion.

## Cleanup

Both orders deleted before the customer, then local rows removed by primary key.
Shopify order count back to **0** and every table back to the recorded baseline:
customers 8, ledger_entries 35, point_lots 27, webhook_events 21, referrals 1,
idempotency_keys 2, **tier_change_history 0**, admin_audit_log 7,
benefit_requests 0. No positive ledger entry without a backing lot.

## Tests

1483 → **1511**, build clean. Unit tests for the writer, regression tests through
`earnOrder` (promotion, multi-threshold jump as one row, no-op, retained tier,
top tier, order replay, webhook redelivery, rollback on failure), clawback
assertions for both policy settings, and a source-level reachability guard
asserting the write exists where the tier is persisted and is not duplicated —
so this cannot go dormant again.
