# Implementation Plan: Athoor Loyalty Platform

> **Status: PLANNING ONLY.** This is the coding task plan derived from the approved `design.md` and `requirements.md`. **No live changes** are made to the Shopify store, theme, customer metafields, discount codes, or customer data by producing this plan. Nothing here executes against the live store until the user runs a task. Implementation language is **TypeScript** (Node.js v24.x), matching the design's interfaces and its named property-testing library `fast-check`.

## Overview

The build follows the design's phased order. Each task is an incremental, test-driven coding step that builds on previous ones and wires into the running service, with no orphaned code.

- **Phase 1 (MVP, build first):** Node + Postgres ledger core, Shopify custom app + `customers/create` & `orders/paid` webhooks (HMAC + idempotency), earning (signup/tiered order/first-purchase), data-safe migration M0–M2 for the 8 enrolled, automated redemption with queued single-use discount codes, App Proxy wiring for the existing luxury dashboard (UI preserved), and the metafield cache writer.
- **Phase 2:** refund/cancellation clawback, FIFO expiry + scheduler + pre-expiry notifications, referrals with self-referral guards, reconciliation + backup/PITR.
- **Phase 3:** Profile/Preferences store, VIP Benefit model + Entitlement Resolver, luxury private-client portal, admin tooling + Admin Analytics.
- **Phase 4:** mobile-readiness (device tokens, Membership-Credential, wallet readiness), international/config readiness, channel attribution for app-exclusive rewards.

Correctness properties from the design (Properties 1–16) are implemented as `fast-check` property-based tests, placed close to the code they validate. All work respects the Basic-plan constraints: no Shopify Flow, no checkout customization, all automation in the external backend, Admin API called outbound via a queue, metafields as a display cache only.

Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; they are never implemented automatically.

## Tasks

### Phase 1 — MVP (build first)

- [x] 1. Project skeleton and ledger schema
  - [x] 1.1 Scaffold the Loyalty Service (Node.js + TypeScript)
    - Initialize a TypeScript service (web framework Express/Fastify), `zod` validation, `pg` + `node-pg-migrate` migration tooling, `pg-boss` job queue, and `fast-check` dev dependency
    - Load all secrets (Admin API token, webhook secret, App Proxy shared secret, DB credentials) from env/secrets manager; do NOT commit them; do NOT reuse the local MCP `shpat_` token; enforce HTTPS and configure the least-privilege Admin API scope list (`read_customers`, `read_orders`, `read_products`, `write_discounts`, `write_price_rules`, webhook scopes)
    - Establish the versioned `/v1` app structure with stateless request handling and a version identifier emitted on every JSON response
    - _Requirements: 9.1, 9.8, 11.5, 11.6, 11.7, 11.11, 13.1, 15.1_
  - [x] 1.2 Create the immutable ledger schema migration
    - Write the migration for `customers`, `ledger_entries`, `point_lots`, `redemptions`, `discount_codes`, `webhook_events`, `referrals` with indexes and CHECK constraints exactly as specified in the design
    - _Requirements: 1.1_

- [x] 2. Ledger core and balance projection
  - [x] 2.1 Implement the append-only ledger repository
    - Insert exactly one signed-integer entry per movement (earn/spend/clawback/expiry/adjust/migration) with type, amount, reason, customer id, timestamp; reject any attempt to update or delete an existing row; enforce positive amounts for earns and negative for spend/clawback/expiry; on append failure reject the originating operation leaving the ledger unchanged
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.8_
  - [x]* 2.2 Write property test for ledger integrity
    - **Property 1: Ledger integrity** — `balance(c) == SUM(ledger_entries.points WHERE customer=c)`; balance never independently mutable
    - **Validates: Requirements 1.2**
  - [x] 2.3 Implement balance, spendable balance, and FIFO lot consumption
    - Compute `Balance` as the sum of the customer's ledger entries (never stored authoritatively); compute `Spendable_Balance` as the sum of `remaining_points` over non-expired lots; consume lots oldest-first by earning date, tie-breaking by lot creation order, only from lots with `remaining_points > 0`
    - _Requirements: 1.2, 1.3, 5.6_
  - [x]* 2.4 Write property test for spendable-equals-lots
    - **Property 2: Spendable equals lots** — `spendableBalance(c) == SUM(point_lots.remaining_points WHERE customer=c AND not expired)`
    - **Validates: Requirements 1.3**

- [x] 3. Webhook receiver (HMAC + idempotency)
  - [x] 3.1 Implement HMAC-SHA256 verification over the raw body
    - Verify the signature with a constant-time compare against the raw request bytes; reject with HTTP 401 on mismatch, persisting nothing and changing no state
    - _Requirements: 11.1, 11.2_
  - [x] 3.2 Implement webhook idempotency, dedupe, and fast acknowledgement
    - Persist `X-Shopify-Webhook-Id` to `webhook_events` before handoff (retain ≥30 days); treat a repeated or concurrent duplicate id as a 200 no-op that changes no balance; reject a verified webhook with missing/empty id; respond 200 within 5 seconds and defer all Admin API/email work to the queue
    - Register `customers/create` and `orders/paid` topics for the Shopify custom app
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 13.8_
  - [x]* 3.3 Write property test for idempotent webhooks
    - **Property 6: Idempotent webhooks** — processing the same `X-Shopify-Webhook-Id` twice changes no balances
    - **Validates: Requirements 12.2**

- [x] 4. Earning engine and tier model
  - [x] 4.1 Implement signup earning
    - On a verified new-enrolled `customers/create`, create exactly one +50 signup earning; on HMAC failure create no earning; on a replayed already-earned event create no additional earning; affect only the target customer's balance
    - _Requirements: 2.1, 2.7, 2.8, 2.11_
  - [x] 4.2 Implement paid-order earning, first-purchase bonus, and point lots
    - On a verified `orders/paid` with `eligibleTotal > 0` (post-discount subtotal excluding shipping and tax), create exactly one order earning of `floor(eligibleTotal × tierMultiplier)`; create no earning when `eligibleTotal ≤ 0`; add a +100 first-purchase earning when no prior paid-order earning exists; create a matching `point_lot` expiring exactly 12 months after the earning
    - _Requirements: 2.2, 2.3, 2.5, 2.6, 2.11_
  - [x] 4.3 Implement tier derivation, advancement, and multiplier lookup
    - Derive tier from cumulative lifetime GBP spend (Bronze £0–299.99, Silver £300–749.99, Gold £750–1499.99, Royal_VIP £1500+); on order completion advance to the highest met tier and never lower it; apply multipliers Bronze 1x / Silver 1.5x / Gold 2x / Royal_VIP 3x defaulting to Bronze when undefined; retain highest achieved tier for account lifetime; expose current tier, lifetime spend (2dp), and progress-to-next-tier (or top-tier indicator for Royal_VIP)
    - _Requirements: 2.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [x]* 4.4 Write property test for earn correctness
    - **Property 7: Earn correctness** — `earned == floor(eligibleTotal(o) × multiplier(tier_at_time))` (+100 once if first purchase)
    - **Validates: Requirements 2.2**
  - [x]* 4.5 Write property test for tier monotonicity
    - **Property 11: Tier monotonic per order** — processing a paid order never lowers a customer's tier
    - **Validates: Requirements 7.3**
  - [x]* 4.6 Write unit tests for earning edge cases
    - Zero/negative eligible total (no earning), tier default fallback, floor rounding boundaries
    - _Requirements: 2.3, 2.4_

- [x] 5. Automated redemption and single-use discount codes
  - [x] 5.1 Implement the reward catalog and `GET /v1/rewards`
    - Offer exactly `100→£5`, `250→£15`, `500→£35`, `1000→£75`; reject any reward tier outside this set with an invalid-reward error
    - _Requirements: 3.1, 3.10_
  - [x] 5.2 Implement concurrency-safe redemption
    - Acquire an exclusive `FOR UPDATE` lock within 5s (lock-timeout error otherwise); verify Spendable_Balance ≥ cost (409 insufficient-points with full rollback otherwise); record one negative spend and consume lots FIFO for exactly the cost; ensure resulting Spendable_Balance ≥ 0; reject a redemption requesting more than available leaving lots unchanged
    - _Requirements: 3.2, 3.3, 3.4, 3.11, 5.7_
  - [x] 5.3 Implement queued single-use discount-code generation via the Admin Gateway
    - Enqueue exactly one unique, customer-bound code (`usageLimit=1`, applies-once-per-customer, collision-checked) per redemption; use exponential backoff (1s doubling, cap 60s, ≤10 attempts) on throttling and never call the Admin API synchronously in a handler; on idempotency-key replay return the existing redemption producing at most one spend and one code; make the code visible in the account within 10s; on 3 consecutive failures within 60s after a spend, mark the redemption failed and record a compensating adjustment reversing the spend
    - _Requirements: 3.5, 3.6, 3.7, 3.8, 3.9, 13.2, 13.3, 13.4_
  - [x]* 5.4 Write property test for no-negative-spendable
    - **Property 3: No negative spendable** — post-redemption `spendableBalance >= 0`
    - **Validates: Requirements 3.4**
  - [x]* 5.5 Write property test for redemption/spend conservation
    - **Property 4: Redemption/spend conservation** — `abs(spend_entry.points) == reward.cost == SUM(lot decrements)`
    - **Validates: Requirements 3.2**
  - [x]* 5.6 Write property test for idempotent redeem
    - **Property 5: Idempotent redeem** — same `(customer, idempotencyKey)` yields exactly one spend and at most one code
    - **Validates: Requirements 3.7**
  - [x]* 5.7 Write property/integration test for single-use codes
    - **Property 10: Single-use codes** — exactly one code per redemption, `usageLimit=1`, bound to that customer
    - **Validates: Requirements 3.5**

- [x] 6. API gateway, identity, read endpoints, cache, and dashboard wiring
  - [x] 6.1 Implement the `/v1` router with idempotency and versioning
    - Route every loyalty operation under `/v1` only; accept a 1–128 char idempotency key on state-changing requests with a 24h dedupe window returning the stored result on repeat; reject missing/invalid idempotency keys; keep changes additive-only (breaking changes reserved for `/v2`); emit a version id and hold no session state
    - _Requirements: 9.1, 9.4, 9.5, 9.6, 9.7, 9.8_
  - [x] 6.2 Implement App Proxy signature verification and identity resolution
    - Verify Shopify's App Proxy signature before trusting the injected `logged_in_customer_id`; resolve every request (App Proxy or Customer Account API token) to a local `customers.id` before any handler; reject with an identity-resolution failure when identity cannot be resolved, performing no state change
    - _Requirements: 9.2, 9.3, 11.3, 11.4_
  - [x] 6.3 Implement `GET /v1/balance`
    - Return Spendable_Balance, current tier, lifetime spend, tier progress, and available rewards; return identical data regardless of App Proxy vs Customer Account API identity
    - _Requirements: 7.5, 7.6, 8.5_
  - [x] 6.4 Implement `GET /v1/history` with pagination
    - Return entries typed earned/spent/expired with reason, ISO 8601 date, and order reference; order most-recent-first; default page size 20 (max 100) with total count and next-page indicator; reject invalid pagination; return empty history for no entries; identical output across identity sources
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
  - [x] 6.5 Implement per-customer redemption rate limiting
    - Reject `/v1/redeem` beyond 10 requests per 60-second window per customer until the window elapses
    - _Requirements: 11.12_
  - [x] 6.6 Implement the metafield cache writer
    - After any balance change, enqueue an Admin API write of `loyalty.points_balance`, `tier`, etc. from the ledger; treat failures as non-fatal with retry (≤5 attempts, backoff 1s cap 60s; and the ≤3-retry preserve-last-known-good path); keep serving authoritative data from the ledger; write exclusively from the backend, never from storefront Liquid
    - _Requirements: 13.1, 13.5, 15.2, 15.5, 15.6_
  - [x] 6.7 Wire the existing luxury dashboard to `/v1` via App Proxy (UI preserved)
    - Repoint `sections/loyalty-dashboard.liquid` / `snippets/rewards-banner.liquid` data source from metafields to `/apps/loyalty/v1/*` (`balance`, `history`, `rewards`), reusing existing CSS/templates so there is no visual regression; fall back to Metafield_Cache values on API error/timeout so all sections still render
    - _Requirements: 8.2, 8.4, 8.5_

- [x] 7. Data-safe migration (M0–M2)
  - [x] 7.1 Implement M0 export and validation
    - Export all 39 customers' `loyalty.*` metafields to a versioned backup file as the rollback anchor; confirm a complete record for all 39 before proceeding (abort with error otherwise, metafields untouched); verify each of the 8 enrolled balances equals `50 + spend×1`, halting and recording any mismatch; never delete any metafield
    - _Requirements: 14.1, 14.2, 14.3, 14.8_
  - [x] 7.2 Implement M1 ledger backfill and reconciliation
    - For each of the 8 enrolled, create exactly one `migration` ledger entry equal to the current balance plus one matching non-expiring `point_lot`, and recompute tier from lifetime spend; enroll the 31 non-enrolled lazily (row created on first qualifying event, not eagerly); assert `SUM(ledger) == exported balance` for all 8, aborting and retaining no partial state on any mismatch or mid-way failure
    - _Requirements: 14.4, 14.5, 14.6, 14.7_
  - [x] 7.3 Implement rollback support for M0–M2
    - Provide a rollback that stops the service and restores every customer's metafields to their exported values, and (for cutover) repoints the theme redemption CTA back to the retained `mailto:` snippet in version control
    - _Requirements: 14.9_

- [x] 8. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

### Phase 2 — Integrity and lifecycle

- [x] 9. Refund and cancellation clawback
  - [x] 9.1 Implement clawback for `refunds/create` and `orders/cancelled`
    - Register both webhooks; on verified `refunds/create` create a negative clawback equal to the earn rate applied to the refunded eligible amount (nearest whole point, 0.5 up); on verified `orders/cancelled` reverse the order's earned points; bound cumulative absolute clawback per order to `[0, totalEarned]`; clamp to keep Spendable_Balance ≥ 0 when `allowNegative` is off; retain tier when `allowTierDowngradeOnClawback` is off; reject on signature failure and no-op on duplicate event ids
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_
  - [x]* 9.2 Write property test for refund conservation
    - **Property 8: Refund conservation** — `clawback(f) <= totalEarned(o)`; a full refund of a fully-earning order claws back exactly what it earned
    - **Validates: Requirements 4.3**

- [x] 10. FIFO expiry, scheduler, and pre-expiry notifications
  - [x] 10.1 Implement the idempotent FIFO expiry scan
    - For every lot with `expires_at <= scan date` and `remaining_points > 0`, create exactly one negative expiry entry equal to the lot's remainder and set the remainder to zero; treat repeat runs for the same scan date as a no-op
    - _Requirements: 5.2, 5.3_
  - [x] 10.2 Implement the scheduler and pre-expiry notification sweep
    - Set lot expiry to exactly 12 months after earning; run the daily expiry scan and a pre-expiry sweep that enqueues exactly one notification per qualifying lot within the configured window (1–90 days, default 30) via the pluggable ESP, including expiring amount and expiry date; never enqueue a duplicate notification for a lot already notified within its window
    - _Requirements: 5.1, 5.4, 5.5_
  - [x]* 10.3 Write property test for expiry-once
    - **Property 9: Expiry once** — each lot contributes to at most one expiry entry, equal to its remainder at maturity
    - **Validates: Requirements 5.2**

- [x] 11. Referrals
  - [x] 11.1 Implement referral code, staged rewards, and self-referral guards
    - Generate a referral code on signup and record a `referrals` row when `referred_by` is present; award the referrer +150 on friend signup and +250 on the friend's first paid purchase (exactly once, never if the friend had a prior paid purchase); reject any referral where referrer and referred are the same via the DB `CHECK` and `referred_by` guard, creating no earning
    - _Requirements: 2.9, 2.10, 11.8, 11.9_
  - [x]* 11.2 Write property test for no self-referral reward
    - **Property 12: No self-referral reward** — `referrer != referred`; a customer cannot earn referral points from their own signup
    - **Validates: Requirements 11.8**

- [x] 12. Reconciliation and backup/recovery
  - [x] 12.1 Implement the reconciliation job
    - Run at least every 24h; recompute cached lifetime points, tier, and lot remainders solely from the ledger and overwrite any diverging cached value, including the Metafield_Cache, so cache matches the ledger
    - _Requirements: 1.7, 13.7_
  - [x] 12.2 Implement backup/PITR verification
    - Enable and verify PostgreSQL point-in-time recovery, automated backups, and WAL retention of at least 7 days
    - _Requirements: 13.6_

- [x] 13. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

### Phase 3 — Profile, VIP, portal, and admin

- [x] 14. Profile / Preferences store (off-ledger)
  - [x] 14.1 Create the Profile/Preferences schema migration
    - Write the migration for `customer_favourites`, `customer_wishlist`, `customer_recently_viewed` (+ retention index), `tier_change_history`, `portal_visits`, kept entirely separate from `ledger_entries`
    - _Requirements: 17.3_
  - [x] 14.2 Implement favourites and wishlist with union reconciliation
    - Persist favourite set/unset reflected on the next profile read; own the account-level wishlist; on authentication reconcile the device-local `shopify-wishlist` localStorage entry as a union and retain the merged set as authoritative
    - _Requirements: 17.2, 17.3, 17.4_
  - [x] 14.3 Implement off-ledger recently-viewed ingestion
    - Record views via a rate-limited/sampled endpoint that never touches the ledger; exclude entries older than the 90-day retention window from the profile; prune recently-viewed to the retention window
    - _Requirements: 17.5, 11.10_
  - [x] 14.4 Implement rules-based suggestions behind a stable interface
    - Compute suggestions from purchase and view history, excluding already-purchased fragrances, behind a stable interface so richer logic can replace it without changing the `/v1` response contract
    - _Requirements: 17.6, 17.7_
  - [x] 14.5 Implement the Fragrance Profile composition and journey timeline
    - Return purchased fragrances derived solely from the customer's paid Shopify orders, plus favourites/wishlist/recently-viewed/suggestions; return the chronological journey timeline (first purchase, favourites added, tier changes); return empty results (not errors) for empty categories; source product/order data from Shopify and preference data from the service; return only the requesting customer's data
    - _Requirements: 17.1, 17.8, 17.9, 17.10_
  - [x] 14.6 Implement portal-visit state
    - Track first-visit vs returning-member state via `portal_visits` and expose it through `POST /v1/profile/visit`
    - _Requirements: 16.1, 16.2_
  - [x]* 14.7 Write property test for behavioural-data isolation
    - **Property 13: Behavioural data never affects ledger balances** — any sequence of favourite/wishlist/recently-viewed/visit operations leaves `balance(c)` and `spendableBalance(c)` unchanged and writes nothing to `ledger_entries`
    - **Validates: Requirements 17.3**

- [x] 15. VIP benefits and Entitlement Resolver
  - [x] 15.1 Create the benefits schema and seed configuration
    - Write the migration for `benefits` and `benefit_requests`; model tier-gated entitlements as config-driven definitions (each with a `min_qualifying_tier` and JSONB config) so new benefit types are added by configuration without schema redesign, additively under `/v1`
    - _Requirements: 18.1, 18.4, 18.7_
  - [x] 15.2 Implement the Entitlement Resolver and benefit requests
    - Given a customer's derived tier, return every benefit whose `min_qualifying_tier` is met and include it in returned account data; deny any benefit gated above the tier; record a `benefit_request` (e.g. private-consultation booking) when a qualifying member invokes an enabled benefit; on an unqualified invocation perform no state change and return the required tier; grant Royal_VIP-exclusive benefits to Royal_VIP members
    - _Requirements: 7.8, 18.2, 18.3, 18.5, 18.6_
  - [x]* 15.3 Write property test for entitlement gating
    - **Property 14: Entitlement gating correctness** — a benefit is granted iff `tier(c) >= b.min_qualifying_tier`; unqualified invocation performs no state change and returns the required tier
    - **Validates: Requirements 18.3**

- [x] 16. Luxury private-client portal
  - [x] 16.1 Implement the private-client presentation and personalised greeting
    - Render a first-visit welcome for customers with no recorded visit and a returning-member experience (omitting the welcome) otherwise; show a name+tier greeting when the name is available and a tier-aware safe fallback (no empty value or placeholder token) when it is not; present all sections in the bespoke/editorial Private_Client tone, not the default Shopify account UI; apply the LV-inspired typography, palette, and spacing with no visual regression
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.9_
  - [x] 16.2 Implement motion with reduced-motion support
    - Apply premium transitions each completing within 300ms when `prefers-reduced-motion` is not set; disable non-essential animation when it is set; restrict animated transitions to compositor-friendly transform/opacity so no layout shift is introduced
    - _Requirements: 16.6, 16.7, 16.8_
  - [x] 16.3 Implement accessibility, responsiveness, and Core Web Vitals
    - Deliver profile, orders, addresses, balance, tier/progress, rewards, and activity within 3s; render without horizontal scroll/overflow/overlap from 320px to 1920px; conform to WCAG 2.1 AA (keyboard nav, ARIA labels, ≥4.5:1 contrast); meet LCP < 2.5s, CLS < 0.1, FID < 100ms with no regression
    - _Requirements: 8.1, 8.3, 8.7, 8.8, 16.10, 16.11_
  - [x] 16.4 Implement API/cache fallback and error state
    - Fall back to Metafield_Cache values when the API is slow/errors so the dashboard keeps rendering; when both API and cache are unavailable, show a temporary-unavailable message while retaining already-rendered content
    - _Requirements: 8.4, 8.6_

- [x] 17. Admin tooling and analytics
  - [x] 17.1 Implement admin auth, adjustments, manual credit, and audit trail
    - Deny any admin tool access without an authenticated admin role (no data change); create one adjustment entry for a signed point delta with a 1–500 char reason, acting admin id, and timestamp; reject missing/empty/over-length reasons; grant manual credit for non-automatable actions (and only via manual credit — reject automated grants for unverifiable actions); write an immutable audit record for every adjustment/credit/migration/reconciliation
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.8, 10.9, 15.3, 15.4_
  - [x] 17.2 Implement admin customer view, fraud review, and migration/reconcile operations
    - Show a selected customer's complete ledger/history (most-recent-first with type, amount, reason, acting party, timestamp); show referrals and redemptions with status, customer id, amount, timestamp for fraud review; run migration/reconciliation operations returning processed and failed counts
    - _Requirements: 10.5, 10.6, 10.7_
  - [x] 17.3 Implement Admin Analytics from cached aggregates
    - Compute CLV, repeat purchase rate, engagement (enrolled % and active %), most-rewarded customers, redemption behaviour (rate and reward-tier popularity), and Royal_VIP growth for a selectable date range, derived solely from the ledger + Shopify order data via hourly-refreshed cached aggregates/materialized views; require admin auth; reject an end-before-start range; apply and report a default range when none is given; include the `computedAt` timestamp
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6_
  - [x]* 17.4 Write property test for analytics derivation
    - **Property 16: Analytics derive solely from the ledger + Shopify orders** — every metric is a pure function of `ledger_entries` + Shopify order data; recomputing reproduces the reported values as of `computedAt`
    - **Validates: Requirements 20.3**

- [x] 18. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

### Phase 4 — Mobile readiness, international, and channels

- [x] 19. Mobile readiness
  - [x] 19.1 Implement device-token registration
    - Add `device_tokens` and register/de-register endpoints as additive `/v1` changes without altering any existing web contract; model notification events so they can target registered device tokens without requiring a web client to consume them
    - _Requirements: 19.1, 19.2, 19.7_
  - [x] 19.2 Implement the Membership-Credential service
    - Issue a signed, opaque, non-PII-bearing member identifier + QR payload using a dedicated signing key from secrets management; expose `GET /v1/membership-card` (member id + tier for wallet-pass readiness) and a verification endpoint confirming membership + tier only
    - _Requirements: 19.5, 19.6_
  - [x]* 19.3 Write unit tests for credential verification isolation
    - Verify a presented identifier resolves to membership + tier only and never returns any other customer's data
    - _Requirements: 19.5_

- [x] 20. International / configuration readiness
  - [x] 20.1 Implement market and rule-set configuration
    - Add `markets`, `earning_rule_sets`, `reward_rule_sets` with Base_Currency GBP (single UK market at MVP); move tier thresholds, multipliers, and the reward map out of hardcoded constants into config the engine reads; keep the ledger currency-agnostic while money-bearing config carries explicit currency; apply the GBP rule set to all customers when only the base market is configured; structure everything so per-market currency/rule-sets are additive with no ledger redesign
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.6, 21.7_
  - [x] 20.2 Externalize portal copy for localization
    - Structure all user-facing portal copy for localization so additional languages can be added without changes to portal logic
    - _Requirements: 21.5_

- [x] 21. Channel attribution for app-exclusive rewards
  - [x] 21.1 Implement channel attribution and app-exclusive gating
    - Add the `channel` attribution (`web`/`app`) to redemptions/reward context; attribute rewards and entitlements to their originating channel; grant an app-exclusive reward only when the attributed channel is `app`; introduce these additively under `/v1`
    - _Requirements: 19.3, 19.4, 19.7_
  - [x]* 21.2 Write property test for app-exclusive channel gating
    - **Property 15: App-exclusive channel gating** — an app-exclusive reward is granted iff `channel == 'app'`
    - **Validates: Requirements 19.4**

- [x] 22. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

### Phase 5 — Post-staging follow-ups

> Raised by the staging validation of the deployed release candidate. Findings 1–4 from that validation are already fixed, verified on staging, and deployed (duplicate reversal, unbacked point lots, cache refresh on every balance change, Pg-wired admin surfaces). The tasks below are the remaining low-severity item plus the flows staging could not exercise. Each is INDEPENDENT of the others and carries no dependency on tasks 1–22, so they can be picked up and tracked separately in any order.
>
> Tasks 24–27 are validation/operational rather than feature work: they exercise existing behaviour and produce evidence, and 24 and 27 need infrastructure or a browser session that the free-tier staging environment cannot provide.

- [ ] 23. Advance webhook_events processing state for traceability
  - Set `webhook_events.status` to `processed` and stamp `processed_at` when the worker finishes dispatching an event, and to `failed` when dispatch raises, so the dedupe table records outcome as well as receipt. Staging observed 8 of 8 rows stuck at `received` with `processed_at` null even after successful processing. Keep the transition idempotent (a replayed event must not overwrite a recorded terminal state) and non-fatal (a status write failure must not fail an already-committed ledger append, mirroring the metafield-cache writer's contract).
  - _Requirements: 12.1, 12.3, 13.8_

- [ ] 24. Make scheduled jobs run reliably in production
  - Decide and document how `runExpiryScan`, `reconcileCaches` and `refreshAnalyticsAggregates` fire dependably. All three are registered in `pgboss.schedule`, but the free-tier host spins down on inactivity so they only run while the instance is awake — staging saw a stale pre-fix analytics failure for this reason. Compare an always-on paid instance against an external scheduler pinging a trigger endpoint, cover what happens to a missed window (pg-boss cron semantics on wake), and record the operational decision with its cost and monitoring implications. No behaviour change to the jobs themselves.
  - _Requirements: 5.2, 5.4, 13.6, 13.7, 20.3_

- [ ] 25. Exercise the referral reward flow end to end on staging
  - Drive a real referral: generate a referrer's code, sign a friend up carrying `referred_by`, then complete the friend's first paid order. Verify the referrer receives +150 on signup and +250 on that first purchase, exactly once each, that each earning now carries its matching 12-month Point_Lot (Property 17, added after the staging run), that no reward is granted when the friend already had a prior paid purchase, and that a self-referral is refused by both the `referred_by` guard and the DB `CHECK`. Capture ledger, lot and referral-row evidence.
  - _Requirements: 2.9, 2.10, 11.8, 11.9_

- [ ] 26. Rehearse the M0–M2 migration/cutover runbook
  - Perform a full dry run of the data cutover against staging: M0 export of every customer's `loyalty.*` metafields as the rollback anchor, M1 ledger backfill asserting `SUM(ledger) == exported balance` for each enrolled customer with a matching non-expiring lot, M2 dashboard cutover, then rehearse the rollback that restores the exported metafields and repoints the theme CTA. Confirm the operator-script path works now that migration is refused over the API (Req 10.7a) and that no metafield is ever deleted. Produce the signed-off runbook with per-step evidence.
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 10.7_

- [ ] 27. Validate the storefront dashboard, performance and accessibility
  - Load the live luxury dashboard through App Proxy on staging and verify the sections render from `/apps/loyalty/v1/*` with no visual regression, that the Metafield_Cache fallback renders when the API is forced to error and the temporarily-unavailable state shows when both are down, and that a minted single-use code applies once at checkout and is blocked on reuse. Measure Core Web Vitals against LCP < 2.5s, CLS < 0.1, FID < 100ms via Lighthouse, check 320px–1920px for overflow/overlap, confirm `prefers-reduced-motion` disables non-essential animation, and spot-check WCAG 2.1 AA (keyboard navigation, ARIA labels, ≥4.5:1 contrast). Needs a browser session; note that full accessibility conformance also requires manual assistive-technology testing and expert review.
  - _Requirements: 8.1, 8.3, 8.4, 8.6, 8.7, 8.8, 16.6, 16.7, 16.8, 16.10, 16.11_

- [ ] 28. Exercise FIFO expiry and pre-expiry notifications on staging
  - Seed a matured lot and a lot inside the pre-expiry window, then verify the scan creates exactly one negative expiry entry per matured lot equal to its remainder and zeroes it, that a repeat run is a no-op (Property 9), and that the sweep enqueues exactly one notification per qualifying lot carrying the expiring amount and expiry date with no duplicate for an already-notified lot. The ESP is logging-only, so assert on the queued jobs and provider log rather than a delivered email. Task 24 replaced cron with due-work catch-up, so the scan can now be driven deterministically by ageing `scheduled_runs.last_run_at` instead of waiting for a schedule.
  - _Requirements: 5.2, 5.2a, 5.3, 5.4, 5.5_

- [ ] 29. Decide the backup and disaster-recovery strategy
  - **The current deployment does not satisfy Req 13.6.** Free-tier Postgres provides no backup retention and no point-in-time recovery, and free projects are paused after a week of inactivity. The ledger is the authoritative record of what members are owed, so this is a data-loss exposure rather than an inconvenience. Evaluate the options — accept a documented deviation, add periodic logical backups from a free runner (recovery to the last dump, so RPO equals the dump interval, and note that this places a database credential in CI), or move to the cheapest paid database that includes retention and PITR. Decide deliberately, then either amend Req 13.6 to match what is delivered or implement what it already requires. Req 13.6 is deliberately left unchanged until this decision is made.
  - _Requirements: 13.6_

## Notes

- Tasks marked with `*` are optional test sub-tasks (unit, property, integration) and can be skipped for a faster MVP; they are never implemented automatically. Core implementation tasks are never optional.
- Property-based tests use `fast-check` (TypeScript) and each references a specific correctness property (1–16) and the requirement clause it validates.
- Each task references specific requirement sub-clauses for traceability, and builds on prior tasks so nothing is left orphaned — every component is wired into the running `/v1` service.
- Checkpoints (tasks 8, 13, 18, 22) provide incremental validation at phase boundaries.
- Phase 5 (tasks 23–28) tracks post-staging follow-ups. Each is independent and can be run on its own; only task 28 has a prerequisite (task 24, since expiry runs on a schedule). Tasks 24, 26 and 27 are operational/validation work producing evidence and documentation rather than service code.
- Basic-plan constraints are honored throughout: all automation lives in the external backend (no Shopify Flow), the checkout page is never customized, the Admin API is called only outbound via a queue with backoff, and metafields remain a display cache only.
- The migration tasks (7.1–7.3) are strictly data-safe: no metafield is ever deleted, the M0 export is the rollback anchor, and rollback is supported at every phase.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.2"] },
    { "id": 4, "tasks": ["2.4", "3.3", "4.1", "4.3"] },
    { "id": 5, "tasks": ["4.2", "4.4", "4.5", "4.6"] },
    { "id": 6, "tasks": ["5.1", "5.2"] },
    { "id": 7, "tasks": ["5.3", "5.4", "5.5", "5.6"] },
    { "id": 8, "tasks": ["5.7", "6.1", "6.2"] },
    { "id": 9, "tasks": ["6.3", "6.4", "6.5", "6.6"] },
    { "id": 10, "tasks": ["6.7", "7.1"] },
    { "id": 11, "tasks": ["7.2"] },
    { "id": 12, "tasks": ["7.3"] },
    { "id": 13, "tasks": ["9.1", "10.1", "11.1", "12.1", "12.2"] },
    { "id": 14, "tasks": ["9.2", "10.2", "11.2"] },
    { "id": 15, "tasks": ["10.3"] },
    { "id": 16, "tasks": ["14.1", "15.1"] },
    { "id": 17, "tasks": ["14.2", "14.3", "14.4", "14.6", "15.2"] },
    { "id": 18, "tasks": ["14.5", "14.7", "15.3"] },
    { "id": 19, "tasks": ["16.1", "16.2", "16.4", "17.1"] },
    { "id": 20, "tasks": ["16.3", "17.2", "17.3"] },
    { "id": 21, "tasks": ["17.4"] },
    { "id": 22, "tasks": ["19.1", "20.1"] },
    { "id": 23, "tasks": ["19.2", "19.3", "20.2", "21.1"] },
    { "id": 24, "tasks": ["21.2"] },
    { "id": 25, "tasks": ["23", "24", "25", "26", "27", "29"] },
    { "id": 26, "tasks": ["28"] }
  ]
}
```
