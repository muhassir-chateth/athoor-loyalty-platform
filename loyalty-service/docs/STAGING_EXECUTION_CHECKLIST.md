# Athoor Loyalty Platform — Staging Execution Checklist

> **Operational handover document.** The codebase is FROZEN at the final code-complete checkpoint (build + typecheck + 990 tests green). This checklist covers **live staging validation only** — the items that cannot be proven from code and must be exercised against a real Shopify development/staging store + a fresh staging Postgres.
>
> **Golden rules**
> - Staging/development store only — never production `myathoorlondon.myshopify.com`.
> - Never reuse the local MCP `shpat_` token (the config guard rejects a `shpat_` token when `NODE_ENV=production`).
> - No secrets committed to git; env/secrets manager only.
> - This is an execution log — do not modify implementation to make a step pass. If a step fails, record it and raise a defect; the freeze holds.
>
> For infra sizing, env var reference, migration order, and Shopify app setup, see `docs/STAGING_RUNBOOK.md`. This checklist assumes that setup is done and focuses on the pass/fail validation runs.

**Run header (fill once per run):**
```
Date: ______  Operator: ______  Commit/SHA: ______  Store: ______.myshopify.com
NODE_ENV=production  REQUIRE_HTTPS=true  PGSSL=true  SHOPIFY_ADMIN_API_TOKEN set? [Y/N]
```

Legend: each item lists **Step**, **Expected**, **Evidence**, **Pass criteria**.

---

## 1. Fresh staging PostgreSQL migration run

### 1.1 Apply migrations on a clean database
- **Step:** On an empty staging DB: `npm ci && npm run build && npm run migrate:up`.
- **Expected:** All 9 migrations apply in timestamp order with no error.
- **Evidence:** Console output of `migrate:up`; `psql "$DATABASE_URL" -c "SELECT name, run_on FROM pgmigrations ORDER BY run_on;"`.
- **Pass criteria:** Exactly 9 rows in `pgmigrations`: create-ledger-core, create-benefits-schema, create-profile-preferences, create-admin-audit-log, create-device-tokens, create-market-config, add-redemption-channel, create-pre-expiry-notifications, create-analytics-aggregates.

### 1.2 Verify schema objects
- **Step:** `psql "$DATABASE_URL" -c "\dt"` and `-c "\dm"`.
- **Expected:** All core + additive tables present; 3 materialized views present; `analytics_aggregate_refresh` seeded with one row.
- **Evidence:** `\dt` / `\dm` output; `SELECT * FROM analytics_aggregate_refresh;`.
- **Pass criteria:** Tables customers, ledger_entries, point_lots, redemptions, discount_codes, webhook_events, referrals, benefits, benefit_requests, device_tokens, markets, earning_rule_sets, reward_rule_sets, portal_visits, pre_expiry_notifications (+ profile/preferences tables) exist; matviews analytics_customers, analytics_ledger, analytics_redemptions exist.

### 1.3 Rollback rehearsal (one migration)
- **Step:** `npm run migrate:down` then `npm run migrate:up` again.
- **Expected:** The last migration reverts cleanly and re-applies with no drift.
- **Evidence:** Both command outputs; `pgmigrations` count before/after (9 → 8 → 9).
- **Pass criteria:** Down + up complete without error; final count back to 9.

---

## 2. Application boot verification

### 2.1 pg-boss running
- **Step:** `npm start` (behind the HTTPS edge). Watch startup logs.
- **Expected:** `boss.start()` succeeds; pg-boss schema created on first boot; hand-off queues created (`webhook.process`, `generateDiscountCode`, pre-expiry notify).
- **Evidence:** Boot log excerpt; `psql -c "SELECT name FROM pgboss.queue;"` (or `\dn` showing pgboss schema).
- **Pass criteria:** Service reaches "listening" with no unhandled boot error; pgboss schema + queues present.

### 2.2 Health + public endpoints
- **Step:** `curl -fsS https://<host>/health`, `/v1/version`, `/v1/rewards`.
- **Expected:** `/health` → `{"status":"ok","version":...}`; `/v1/rewards` → 4 rewards (100→£5, 250→£15, 500→£35, 1000→£75).
- **Evidence:** Three curl transcripts.
- **Pass criteria:** All return 200 with expected bodies.

### 2.3 Workers registered
- **Step:** Inspect boot logs for worker registration.
- **Expected:** Always-on: webhook-processing worker, daily expiry (scan + pre-expiry sweep), pre-expiry ESP worker, hourly analytics refresh. With `SHOPIFY_ADMIN_API_TOKEN` set: discount-code worker, metafield-cache worker. Without the token: an explicit `log.warn` that these were skipped (fail-safe boot).
- **Evidence:** Boot log excerpt showing each `work(...)` binding (or the skip warning).
- **Pass criteria:** All expected bindings present for the chosen token mode; token-absent mode shows the warning (not a silent skip).

### 2.4 Schedulers registered
- **Step:** `psql -c "SELECT name FROM pgboss.schedule;"`.
- **Expected:** Recurring schedules for expiry (daily), analytics-refresh (hourly), and — only with Admin token — reconciliation (daily).
- **Evidence:** Query output.
- **Pass criteria:** Expiry + analytics schedules present always; reconciliation present when token set. (Actual cron firing is validated in §5, observed over time.)

---

## 3. Shopify staging integration

### 3.1 Admin API authentication
- **Step:** With `SHOPIFY_ADMIN_API_TOKEN` set, trigger any Admin-gated path (e.g. run the webhook-registration step in 3.2, or a reconciliation).
- **Expected:** Admin GraphQL calls authenticate against the staging store; no `shpat_` token used; no token value in logs.
- **Evidence:** Successful Admin API response/log; grep logs for token substring returns nothing.
- **Pass criteria:** Auth succeeds; token never appears in logs.

### 3.2 Webhook registration
- **Step:** Run the registration step (operator script over `src/webhooks/registration.ts` / `ALL_WEBHOOK_TOPICS`) pointing all topics at `https://<host>/webhooks/shopify`, or register manually in the Shopify Admin.
- **Expected:** 4 topics registered: `customers/create`, `orders/paid`, `refunds/create`, `orders/cancelled`.
- **Evidence:** Shopify webhook list (Admin/API) showing 4 subscriptions → the service URL.
- **Pass criteria:** All 4 topics point at `/webhooks/shopify`.

### 3.3 Webhook delivery + HMAC + idempotency
- **Step:** Trigger a test event (e.g. create a staging customer). Then re-deliver the same event (same `X-Shopify-Webhook-Id`).
- **Expected:** First delivery: HTTP 200 within 5s, one `webhook_events` row, one `webhook.process` job enqueued. Duplicate: 200 no-op, no new job, no balance change. A tampered signature → 401, nothing persisted.
- **Evidence:** Service logs; `SELECT * FROM webhook_events;`; queue row; a 401 transcript for a bad-HMAC request.
- **Pass criteria:** 200 ≤5s; deduped; bad signature rejected 401 with no state change.

### 3.4 Discount-code generation (Admin token required)
- **Step:** Perform a redemption (see §4.4) for a customer with sufficient spendable balance.
- **Expected:** `redemptions` row moves `pending_code` → `issued`; discount-code worker mints exactly one single-use, customer-bound Shopify discount code (`usageLimit=1`, applies once per customer), format `ATH-XXXX-XXXX`; `discount_codes` row persisted.
- **Evidence:** `SELECT * FROM redemptions, discount_codes;`; the discount object in Shopify Admin; worker log.
- **Pass criteria:** Exactly one code per redemption, `usageLimit=1`, bound to that customer; re-running the job mints no second code.

### 3.5 Metafield synchronization (Admin token required)
- **Step:** Cause a balance change (paid order or admin adjustment) for a test customer.
- **Expected:** Metafield-cache job runs; `customer.metafields.loyalty.*` (`points_balance`, `tier`, …) updated from the ledger. Failure is non-fatal (ledger stays authoritative; last-known-good preserved).
- **Evidence:** Admin customer metafields screenshot before/after; worker log.
- **Pass criteria:** Metafields reflect ledger-derived values after the change.

---

## 4. Customer flow validation

> All authenticated customer reads resolve identity via a **signed App Proxy** request. The Customer Account API bearer path (`tokenVerifier`) is intentionally unwired and will fail closed — do not test the mobile/bearer path here.

### 4.1 App Proxy authentication
- **Step:** Call `GET /apps/loyalty/v1/rewards` (public) and a signed authenticated call (valid signature) plus one with a tampered signature.
- **Expected:** Valid signed request reaches `/v1` and resolves identity; invalid signature rejected.
- **Evidence:** curl transcripts (valid + tampered); service log.
- **Pass criteria:** Public 200; valid signature 200; invalid signature rejected (401/identity-resolution failure), no state change.

### 4.2 Dashboard balance / history / profile
- **Step:** As a signed-in staging customer with ledger activity, load the account dashboard; observe `/apps/loyalty/v1/balance`, `/v1/history`, `/v1/profile`, `/v1/profile/journey`.
- **Expected:** Live ledger-backed data: spendable balance, tier + progress, available rewards; paginated history typed earned/spent/expired most-recent-first; fragrance profile (purchased/favourites/wishlist/recently-viewed/suggestions) with empty categories returning empty (not errors). On forced API error/timeout, dashboard falls back to Metafield_Cache.
- **Evidence:** Dashboard screenshots; browser network tab showing `/apps/loyalty/v1/*` 200s; a forced-error screenshot showing cache fallback.
- **Pass criteria:** Live values render and match ledger; cache fallback still renders on error; only the requesting customer's data is returned.

### 4.3 Membership card
- **Step:** `GET /v1/membership-card` (signed App Proxy) and `GET /v1/membership-card/verify?credential=...` (public), plus a tampered credential.
- **Expected:** Issuance returns a signed non-PII member id + tier + QR payload; verify returns `{valid, tier}` only for a genuine credential and `{valid:false}` for a tampered one. Fails closed (503) only if `MEMBERSHIP_SIGNING_KEY` is unset.
- **Evidence:** curl transcripts (issue, verify-valid, verify-tampered).
- **Pass criteria:** Issuance succeeds with key set; verify correct for valid + tampered; no other customer's data ever returned.

### 4.4 Redemption flow
- **Step:** `POST /apps/loyalty/v1/redeem` (signed) with `{ rewardId, idempotencyKey }` and an `Idempotency-Key` header, for a customer with sufficient balance. Then repeat with the same idempotency key. Then attempt with insufficient balance and with an unknown reward id.
- **Expected:** First: 200 with `RedemptionResult`, one negative spend recorded, lots consumed FIFO for exactly the cost, one discount-code job enqueued. Replay (same key): 200 with the same redemption, no new spend, no new job. Insufficient: 409. Unknown reward: 400. Over rate limit (>10/60s per customer): 429.
- **Evidence:** curl transcripts for each case; `SELECT * FROM redemptions, ledger_entries, point_lots;`; queue rows.
- **Pass criteria:** Exactly one spend + at most one code per (customer, idempotency key); spendable never goes negative; error mapping correct (409/400/429); replay is idempotent.

---

## 5. Background jobs

### 5.1 Expiry (FIFO) + expiry-once
- **Step:** Seed a matured lot (`expires_at <= now`, `remaining_points > 0`) on staging; run the daily expiry scan; then run it again for the same scan date.
- **Expected:** One negative `expire` entry per matured lot equal to its remainder; remainder set to 0. Second run for the same date is a no-op.
- **Evidence:** `SELECT * FROM ledger_entries WHERE entry_type='expire';`; `point_lots` remainder before/after; second-run log.
- **Pass criteria:** Each lot expires exactly once; repeat run adds no entries.

### 5.2 Reconciliation (Admin token required)
- **Step:** Introduce a deliberate cache drift (e.g. stale metafield), run the reconciliation job, then run it again.
- **Expected:** Cached lifetime points, tier, lot remainders, and Metafield_Cache recomputed solely from the ledger; drift repaired; processed/repaired counts returned. Second run is a no-op.
- **Evidence:** Job log with counts; before/after cache query; Admin metafield screenshot.
- **Pass criteria:** Drift repaired to match ledger; second run reports no changes.

### 5.3 Analytics refresh
- **Step:** Trigger `refreshAnalyticsAggregates` (or wait for the hourly schedule); then `GET /v1/admin/analytics` with `Authorization: Bearer $ADMIN_AUTH_SECRET`.
- **Expected:** Materialized views refreshed; `analytics_aggregate_refresh.refreshed_at` bumped; response includes metrics + `computedAt`. Ledger/redemption/enrolment metrics populate; **order-derived metrics (clv, repeatPurchaseRate, royalVipGrowth) resolve to 0** (documented boundary — no Shopify order mirror). Admin auth required; end-before-start range rejected.
- **Evidence:** Admin analytics response; `SELECT refreshed_at FROM analytics_aggregate_refresh;`.
- **Pass criteria:** Ledger-derived metrics populate; `computedAt` present; order-derived = 0 as documented; unauth request → 401.

### 5.4 Pre-expiry notification queue
- **Step:** With a lot inside the pre-expiry window (default 30 days), run the pre-expiry sweep; run it again for the same window.
- **Expected:** Exactly one `preExpiryEmail` job enqueued per qualifying lot (amount + expiry date); the default `LoggingEmailProvider` logs the send (no real email dispatched). No duplicate notification for a lot already notified in its window.
- **Evidence:** Queue rows; ESP worker log lines; `pre_expiry_notifications` dedupe rows.
- **Pass criteria:** One job per qualifying lot; no duplicates on re-run. **Note:** real email delivery is NOT expected (ESP is logging-only until a real provider is configured).

---

## 6. Theme validation

### 6.1 Desktop
- **Step:** Load the account dashboard on desktop widths up to 1920px.
- **Expected:** All sections render in the Private_Client editorial style; live data via App Proxy; no console/Liquid errors; no visual regression vs the preserved design.
- **Evidence:** Desktop screenshots; browser console (clean); Lighthouse run.
- **Pass criteria:** No layout break; LCP < 2.5s, CLS < 0.1, FID/INP within target (manual/Lighthouse); no errors.

### 6.2 Mobile
- **Step:** Load from 320px upward; verify reduced-motion behavior.
- **Expected:** No horizontal scroll/overflow/overlap 320–1920px; animations complete <300ms and are disabled under `prefers-reduced-motion`; transitions are transform/opacity only (no layout shift).
- **Evidence:** Mobile screenshots (320px, 375px, 768px); reduced-motion screenshot/recording.
- **Pass criteria:** No overflow at any width; reduced-motion honored; WCAG 2.1 AA (keyboard nav, ARIA labels, ≥4.5:1 contrast) spot-checked.

### 6.3 Checkout / redemption experience
- **Step:** Complete a redemption (from §4.4), then apply the minted discount code at checkout; attempt to reuse it a second time. Confirm the storefront redemption CTA path (button calling `/apps/loyalty/v1/redeem` vs the retained `mailto:` CTA).
- **Expected:** Code applies once and is single-use enforced (second use blocked). The storefront redemption trigger is wired to the live endpoint (or the `mailto:` fallback is present and intentional).
- **Evidence:** Checkout screenshots (applied + reuse-blocked); note which redemption CTA the theme uses.
- **Pass criteria:** Discount applies once; reuse blocked; redemption CTA behavior documented and matches intent.

---

## Sign-off

```
Section 1 Migrations:            [ ] PASS  [ ] FAIL   notes: ______
Section 2 Boot/workers/sched:    [ ] PASS  [ ] FAIL   notes: ______
Section 3 Shopify integration:   [ ] PASS  [ ] FAIL   notes: ______
Section 4 Customer flows:        [ ] PASS  [ ] FAIL   notes: ______
Section 5 Background jobs:       [ ] PASS  [ ] FAIL   notes: ______
Section 6 Theme:                 [ ] PASS  [ ] FAIL   notes: ______

Accepted limitations confirmed (not defects):
  [ ] Customer Account API bearer path (tokenVerifier) fail-closed by design
  [ ] ESP logging-only (no real email dispatched)
  [ ] Analytics order-derived metrics = 0 (no Shopify order mirror)
  [ ] Data cutover M0–M2 run via operator script (if in scope this run)

Prerequisites confirmed:
  [ ] Secrets via secrets manager; no shpat_ token in prod
  [ ] Backups/PITR verified (WAL ≥ 7 days)
  [ ] Schema + data rollback rehearsed on staging

PRODUCTION GO / NO-GO:  [ ] GO   [ ] NO-GO
Rationale: __________________________________________________
Operator sign-off: __________________________________________
```

**Decision rule:** GO only when Sections 1–5 pass live, Section 6.3 single-use enforcement passes, the accepted limitations are explicitly acknowledged by the product owner, and the prerequisites (secrets, backups/PITR, rollback rehearsal) are confirmed. Any failure in a customer-facing flow (Section 4), redemption/discount integrity (3.4 / 4.4 / 6.3), or migration apply (Section 1) is a NO-GO until resolved — and any resolution requires lifting the freeze through a new change cycle, not an in-place edit during validation.
