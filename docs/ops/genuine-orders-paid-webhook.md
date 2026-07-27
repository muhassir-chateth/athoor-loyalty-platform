# Genuine Shopify `orders/paid` delivery — captured and verified

**Date:** 2026-07-27 · **Store:** `athoor-loyalty-staging.myshopify.com` (staging) · **Task:** 45

Every earlier live validation of earning (tasks 25, 28, 40, 44) used **hand-signed**
webhook posts. This run is the first time a webhook **Shopify itself generated and
delivered** was captured and checked against the service's expectations. The
order and customer used were throwaway and have both been deleted; staging was
restored to its measured baseline.

## What triggers a delivery

| Action | `orders/paid` delivered? |
|---|---|
| `orderCreate` with `financialStatus: PAID` (task 44) | **No** — declares a status, captures no payment |
| `orderCreate` unpaid, then **`orderMarkAsPaid`** | **Yes** |

This closes the task 44 finding. Shopify fires `orders/paid` on **payment
capture**, not on an order being labelled paid at creation. `orderCreate` is also
**asynchronous**: `orderMarkAsPaid` immediately afterwards returns
`Order is temporarily unavailable to be modified`, so the caller must poll.

## How the payload was captured

No code change and no diagnostic endpoint were needed. The webhook receiver hands
the **parsed body** to pg-boss (`PgBossWebhookEnqueuer`), and pg-boss persists job
data as JSONB, so the delivered payload is readable from
`pgboss.job.data` / `pgboss.archive.data` for `name = 'webhook.process'`.
Note pg-boss archives completed jobs on its own retention schedule, so the read
has to happen reasonably soon after the delivery.

## Verified chain, end to end

| Step | Evidence |
|---|---|
| Delivered + HMAC verified | `webhook_events` row, id `3cd0dad8-…36f`, topic `orders/paid` |
| Processing state advanced | `status = processed`, `processed_at` set ~1.7s after receipt (task 23 confirmed against a real delivery) |
| Eligible total derived | `current_subtotal_price` present → precedence rule 1 applied, `949.95` |
| Order earning | `earn_order` **949** = `floor(949.95 × 1.0)` at the Bronze multiplier held before the order |
| First-purchase bonus | `earn_first_purchase` **100**, once |
| Point lots | one lot per credit, expiring exactly 12 months later (A1) |
| Lifetime spend + tier | `lifetime_spend_gbp = 949.95`, tier advanced Bronze → **Gold** |
| Balance invariants | balance 1099, spendable 1099, no unbacked credit (Property 17) |
| Display cache | `loyalty.*` metafields refreshed from the ledger: `points_balance` 1099, `tier` gold, `tier_progress_gbp` 550.05 |

## Dedupe and replay, exercised on the real payload

| Case | Result |
|---|---|
| Replay with the **genuine** webhook id | `200 {"duplicate":true}`, no state change (Req 12.2) |
| Replay with a **new** webhook id, same order | `200 {"duplicate":false}` at the receiver, but the order-level guard created **no additional earning** (Req 2.8) |
| Tampered body, original signature | `401 invalid_hmac`, nothing persisted (Req 11.1/11.2) |

Ledger entries stayed at 3 and the balance at 1099 across all three.

## Real payload vs the hand-signed fixtures

**No field-name or shape difference was found.** The fixtures are a faithful
minimal subset: money arrives as decimal **strings** (`"949.95"`) and ids as JSON
**numbers**, exactly as the tests assume. Differences worth recording:

1. **All three money sources arrive together** and agreed here
   (`current_subtotal_price`, `subtotal_price`, `total_line_items_price` −
   `total_discounts` all resolved to 949.95). So this order confirms precedence
   rule 1 is the one that fires in production, but it does **not** discriminate
   between the three — a discounted or partially-refunded order would, and that
   remains unexercised against a real payload.
2. **94 top-level keys** are delivered; the service reads 6 and ignores the rest,
   including every nested `*_set` shop/presentment money object.
3. **`currency` is delivered and ignored.** The staging store is USD, and the
   949.95 was folded into `lifetime_spend_gbp` unconverted. Harmless for the
   production store (GBP, per A8) but it means a non-GBP store would be silently
   mis-scaled — the config-readiness limitation already recorded as A18.
4. **`test: false`** even on a development store, so that flag cannot be used to
   filter non-real orders.
5. The subscriptions are registered at API version **2026-07** while the tooling
   scripts call 2024-10; the delivered body is the flat snake_case REST shape the
   parser expects.

Field-level extract: [evidence-genuine-orders-paid-fields.md](./evidence-genuine-orders-paid-fields.md)
