# Athoor Loyalty Platform — Staging Deployment Runbook

> Operational checklist to deploy and validate the loyalty-service + theme in a real Shopify **development/staging** store.
> Grounded strictly in the current implementation. Where a capability is **not** wired or **not** exposed, this runbook says so explicitly rather than assuming it exists.
>
> **Golden rules**
> - Deploy to a **staging/development** store only — never the live `myathoorlondon.myshopify.com` production store.
> - **Never** reuse the local MCP `shpat_` token. The service's config guard rejects a `shpat_` token when `NODE_ENV=production`.
> - No secrets in the repo or `.env` committed to git.

---

## 0. KNOWN LIMITATIONS AT BOOT (read first — these affect what can be validated)

These are true of the current code (`src/index.ts` wiring). They are **not** defects to fix in this runbook; they are constraints the operator must know before validating.

- **Authenticated customer reads ARE wired at boot (App Proxy path).** `index.ts` calls `buildApp(...)` injecting the Pg-backed `customerResolver` (`PgCustomerResolver`), `balanceSource` (`PgCustomerBalanceSource`), `historySource` (`PgLedgerHistorySource`), `fragranceProfileDataSource` (`PgFragranceProfileDataSource`), `portalVisitRecorder` (`PgPortalVisitRecorder`), `deviceTokenStore` (`PgDeviceTokenStore`), and the membership-credential service over `PgMembershipTierSource`. Consequence: for a request whose identity is resolved via a **signed App Proxy** request, `/v1/balance`, `/v1/history`, `/v1/profile`, `/v1/profile/journey`, `POST /v1/profile/visit`, `POST /v1/devices`, and `GET /v1/membership-card` return **live ledger-backed data**. The storefront dashboard is progressively enhanced from `/apps/loyalty/v1/*` and falls back to the Metafield_Cache only on API error/timeout.
- **Customer Account API bearer path (`tokenVerifier`) is intentionally NOT wired.** No Pg implementation of `CustomerAccountTokenVerifier` exists and the App Proxy dashboard path does not need one, so `index.ts` leaves it unset. Consequence: the **mobile/bearer-token** route to the same endpoints stays **fail-closed** by design. This is a deliberate scope boundary (mobile client not in this staging scope), not a defect — it must be provided before a mobile client ships.
- **`POST /v1/redeem` is fully implemented and wired.** The route no longer returns HTTP 501 when the service is booted from `index.ts`: it drives the existing `redeem()` engine over the injected `redeemDeps` (`{ repo: LedgerRepository, transactor, enqueuer: PgBossDiscountCodeEnqueuer }`), records the spend, and enqueues exactly one `generateDiscountCode` job (the queue is created unconditionally at boot). Typed engine outcomes/errors map to HTTP (200 redeemed/replayed, 409 insufficient, 400 invalid reward/idempotency key, 403 channel-not-allowed, 404 customer-not-found, 503 lock-timeout, 429 rate-limit). The **501 fallback survives only for tests/local runs** where `redeemDeps` is not injected. NOTE: whether the storefront theme exposes a button that calls `POST /apps/loyalty/v1/redeem` (vs the retained `mailto:` CTA) is a **theme wiring** item to verify on staging; the backend endpoint itself is live. The discount-code **worker** that consumes the enqueued job still requires `SHOPIFY_ADMIN_API_TOKEN` (Admin-gated, see below) to actually mint the Shopify code.
- **ESP is logging-only.** Pre-expiry notification infrastructure (queue, worker, dedupe table) is complete, but the default `EmailProvider` is `LoggingEmailProvider` — it logs instead of sending. No real email is dispatched until a real provider is implemented and configured.
- **Analytics order-derived metrics return 0.** Shopify per-order eligible totals are not mirrored in Postgres, so `clv`, `repeatPurchaseRate`, `royalVipGrowth`, and the order-only part of `engagement.activePct` resolve to zero. Ledger/redemption/enrolment metrics are fully served.
- **Boot wiring is not covered by tests.** `index.ts`/`worker.ts`/`scheduler.ts` are validated only by type-check + static review; first-run behavior must be smoke-tested on staging.
- **Data cutover (M0–M2) has no CLI.** `src/migration/*` (m0Export, m1Backfill, rollback, backupWriter) are library modules with unit tests, but there is no packaged CLI entrypoint. Running the metafield→ledger cutover requires an operator-provided invocation script.

---

## 1. Infrastructure setup

| Requirement | Value / Note |
|---|---|
| Hosting | A container/VM able to run a long-lived Node process behind an **HTTPS-terminating** proxy/edge, reachable publicly (Shopify must POST webhooks + App Proxy requests to it). |
| Node | **>= 24.0.0** (engines pin). Verified locally: v24.17.0. |
| PostgreSQL | A dedicated staging Postgres. Must support `gen_random_uuid()` (pgcrypto/pg ≥ 13) and `REFRESH MATERIALIZED VIEW CONCURRENTLY`. TLS enabled. |
| pg-boss | No separate service — `pg-boss` (v10) runs on the **same** Postgres connection; `boss.start()` creates its schema on first boot. |
| HTTPS | Mandatory. In production mode the service refuses to boot unless `REQUIRE_HTTPS=true`, and it assumes an HTTPS edge terminates TLS. |
| Backup / PITR | Enable automated backups + point-in-time recovery, WAL retention ≥ 7 days (design requirement 13.6). `src/reliability/backupVerification.ts` documents the expectation; provisioning is infra-side. |

---

## 2. Environment configuration

Copy `.env.example` → `.env` (do not commit) and populate. Source of truth: `src/config.ts`.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` for a real staging deploy. |
| `PORT` | no (3000) | Listen port. |
| `LOG_LEVEL` | no (`info`) | fatal\|error\|warn\|info\|debug\|trace. |
| `REQUIRE_HTTPS` | **yes** | Must be `true` in production or boot fails. |
| `SHOPIFY_SHOP_DOMAIN` | yes | The **staging** store, e.g. `athoor-staging.myshopify.com`. |
| `SHOPIFY_ADMIN_API_TOKEN` | yes* | Dedicated staging custom-app token. NOT a `shpat_` MCP token in prod. |
| `SHOPIFY_WEBHOOK_SECRET` | yes | HMAC verification of inbound webhooks. |
| `SHOPIFY_APP_PROXY_SECRET` | yes | App Proxy signature verification. |
| `ADMIN_AUTH_SECRET` | yes | Bearer for `/v1/admin/*`; unset ⇒ admin surface fails closed. |
| `MEMBERSHIP_SIGNING_KEY` | yes | Dedicated key for membership card sign/verify; unset ⇒ membership surface fails closed. |
| `DATABASE_URL` **or** `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` | yes | Connection. |
| `PGSSL` | **yes** | `true` to require TLS to Postgres in staging/prod. |

\* Without `SHOPIFY_ADMIN_API_TOKEN` the service still boots but **skips** the discount-code worker, metafield-cache worker, real-time metafield enqueue, and reconciliation scheduler (fail-safe boot). For a full staging validation, set it.

**Secrets to generate:** `MEMBERSHIP_SIGNING_KEY` (`openssl rand -hex 32`), `ADMIN_AUTH_SECRET` (`openssl rand -hex 32`), DB password. **Secrets from Shopify:** Admin API token, webhook secret, App Proxy shared secret.

**Security requirements:** HTTPS everywhere; `PGSSL=true`; secrets only via env/secrets manager; least-privilege Admin scopes (§4); never reuse the MCP token; do not log secrets (the Admin client is asserted not to leak the token).

---

## 3. Database deployment

Migrations use `node-pg-migrate` (dev dependency). They read the same `DATABASE_URL`/`PG*` env.

**Apply (clean DB), exact order (by timestamp):**
```bash
npm ci
npm run build
npm run migrate:up
```
`migrate:up` applies, in order:
1. `1784817408986_create-ledger-core`
2. `1784818000000_create-benefits-schema`
3. `1784904000000_create-profile-preferences`
4. `1784990000000_create-admin-audit-log`
5. `1785000000000_create-device-tokens`
6. `1785000000000_create-market-config`  *(shares timestamp with #5; filenames differ, tables independent — order is safe)*
7. `1785100000000_add-redemption-channel`
8. `1785200000000_create-pre-expiry-notifications`
9. `1785300000000_create-analytics-aggregates`

**Verify:**
```bash
# 9 rows expected in the migration ledger:
psql "$DATABASE_URL" -c "SELECT name, run_on FROM pgmigrations ORDER BY run_on;"
# spot-check key objects:
psql "$DATABASE_URL" -c "\dt"    # customers, ledger_entries, point_lots, redemptions, discount_codes, webhook_events, referrals, benefits, benefit_requests, device_tokens, markets, earning_rule_sets, reward_rule_sets, pre_expiry_notifications, analytics_aggregate_refresh ...
psql "$DATABASE_URL" -c "\dm"    # analytics_customers, analytics_ledger, analytics_redemptions (materialized views)
```
Pass criteria: 9 migrations recorded; all tables + 3 matviews present; `analytics_aggregate_refresh` has one seeded row.

**Rollback:**
```bash
npm run migrate:down            # reverts exactly ONE migration (repeat to unwind further)
# or, to unwind N:
npx node-pg-migrate down <N>
```
Each migration has a `down`. Roll back in reverse order. The **data cutover** (M0 metafield export → M1 ledger backfill) is NOT a schema migration: it lives in `src/migration/*` as library modules with no CLI. Its rollback (`src/migration/rollback.ts`) restores exported metafields and repoints the theme redemption CTA to the `mailto:` snippet — both require an operator-provided invocation script.

---

## 4. Shopify staging setup

1. **Create a development store** in your Shopify Partner dashboard (separate from production).
2. **Create a custom app** on that store; generate an **Admin API access token** → `SHOPIFY_ADMIN_API_TOKEN`. Capture the **API secret** for App Proxy → `SHOPIFY_APP_PROXY_SECRET`, and the **webhook signing secret** → `SHOPIFY_WEBHOOK_SECRET`.
3. **Admin API scopes** (least privilege, from `config.ts`): `read_customers`, `read_orders`, `read_products`, `write_discounts`, `write_price_rules` (+ the webhook scopes Shopify requires to subscribe).
4. **Webhooks** — topics the service consumes: `customers/create`, `orders/paid`, `refunds/create`, `orders/cancelled`. Registration is a **separate deploy step** (never at startup); it is driven by `src/webhooks/registration.ts` (`buildAllWebhookRegistrations` / `ALL_WEBHOOK_TOPICS`). Point all topics at `https://<service-host>/webhooks/shopify`. NOTE: no packaged CLI ships — invoke the registration module with the live Admin client via an operator script, or register the four topics manually in the Admin/API pointing at that URL.
5. **App Proxy** — configure subpath prefix `/apps/loyalty` → `https://<service-host>` so storefront calls to `/apps/loyalty/v1/*` reach the service's `/v1/*`. The shared secret must equal `SHOPIFY_APP_PROXY_SECRET`.
6. **Theme installation** — deploy the theme assets to an **unpublished/duplicate** staging theme first:
   - `theme/sections/loyalty-dashboard.liquid`
   - `theme/snippets/rewards-banner.liquid`
   - `theme/assets/athoor-loyalty.js`
   - `theme/assets/athoor-loyalty.css`
   - `theme/locales/en.default.json`
   Preview before publishing. The dashboard is server-rendered from Metafield_Cache and progressively enhanced from `/apps/loyalty/v1/*`.

---

## 5. Application deployment

```bash
# Build & checks (run in CI or on the host)
npm ci
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit
npm test               # full vitest suite (expected: all passing)

# Start (long-lived process behind HTTPS)
npm start              # node dist/index.js
```

**Health checks**
```bash
curl -fsS https://<host>/health         # {"status":"ok","version":"..."}
curl -fsS https://<host>/v1/version      # {"version":"..."}
curl -fsS https://<host>/v1/rewards      # 4 rewards: 100→£5,250→£15,500→£35,1000→£75 (public)
```

**Worker verification (from logs on boot):**
- Always: `webhook.process` worker; daily expiry (scan + pre-expiry sweep); `preExpiryEmail` ESP worker; hourly analytics refresh.
- Only when `SHOPIFY_ADMIN_API_TOKEN` is set: discount-code worker (`generateDiscountCode`), metafield-cache worker (`writeMetafieldCache`), reconciliation scheduler. If the token is absent you will see the explicit `app.log.warn` that these were skipped — expected for a token-less boot.

**Scheduler verification:** confirm pg-boss `schedule` entries exist for the reconciliation (daily 03:00), expiry (daily 02:00), and analytics-refresh (hourly) job names, and that each backing queue was created. Cron firing can only be observed over time on the live host.

---

## 6 & 7. Live validation checklist (with evidence & pass/fail)

For every test: record **Expected**, **Actual**, **Evidence** (screenshot/log/DB row/SQL output), **Pass/Fail**. Use a fresh staging test customer. Where a row references a boot limitation from §0, the workaround is noted.

| # | Validation | How to exercise | Expected result | Evidence to capture | Pass criteria |
|---|---|---|---|---|---|
| 1 | Migrations apply | `npm run migrate:up` on clean DB | 9 migrations applied, no error | `pgmigrations` query; `\dt`/`\dm` | 9 rows; all tables+matviews exist |
| 2 | Workers start | Boot service, read logs | Workers registered (see §5) | Boot log excerpt | All expected `work(...)` bindings present |
| 3 | Schedulers running | Inspect pg-boss schedules | reconciliation/expiry/analytics scheduled | `SELECT name FROM pgboss.schedule;` | 3 schedules present (reconciliation only with token) |
| 4 | Webhook registration | Run registration step (§4.4) | 4 topics registered → service URL | Shopify webhook list / API response | 4 topics point at `/webhooks/shopify` |
| 5 | Webhook delivery | Trigger a test event | 200 within 5s; one `webhook_events` row; one `webhook.process` job | Service log; `SELECT * FROM webhook_events`; queue row | 200 + deduped + job enqueued |
| 6 | Order earning | Place a **real paid test order** for the customer | `orders/paid` → `earn_order = floor(eligibleTotal × tierMultiplier)`; matching `point_lot` (12-mo expiry) | `SELECT * FROM ledger_entries WHERE customer_id=... AND entry_type='earn_order'`; `point_lots` row | Exact expected points; lot created |
| 7 | First-purchase bonus | First paid order for a customer | one `earn_first_purchase = +100`, exactly once | ledger rows | +100 present once; not repeated on 2nd order |
| 8 | Refund clawback | Refund the order in Admin | `refunds/create` → negative `clawback` within `[0,totalEarned]`; spendable stays ≥0 | ledger `clawback` row; balance query | Clawback bounded; balance ≥ 0 |
| 9 | Redemption + discount-code creation | Call `POST /apps/loyalty/v1/redeem` (signed App Proxy request) with `{ rewardId, idempotencyKey }` and an `Idempotency-Key` header, for a customer with sufficient spendable balance (Admin token set) | 200 with the `RedemptionResult`; `redemptions` row `pending_code`; one `generateDiscountCode` job enqueued → discount-code worker mints a single-use, customer-bound Shopify code → status `issued` | curl/response transcript; `SELECT * FROM redemptions, discount_codes`; queue row; Shopify discount in Admin | 200 + exactly one code, `usageLimit=1`, bound to customer; replayed key returns same redemption with no new job |
| 10 | Code works in checkout | Apply the minted code at checkout (human) | Discount applied; single-use enforced | Checkout screenshots (applied + reused-blocked) | Applies once; second use blocked |
| 11 | Metafield sync | After a balance change with Admin token set | metafield-cache job runs; `customer.metafields.loyalty.*` updated | Admin customer metafields screenshot; worker log | `points_balance`/`tier`/… updated |
| 12 | App Proxy auth | `GET /apps/loyalty/v1/rewards` (public) and a signed authenticated call | Signed request reaches `/v1`; bad signature rejected | curl transcripts; service log | Public 200; invalid signature 401 |
| 13 | Loyalty dashboard data | Open the account dashboard as the customer (signed App Proxy) | Live `/v1/balance` + `/v1/history` are served from the injected Pg sources → dashboard shows **live ledger-backed** values, progressively enhanced over the server-rendered Metafield_Cache; on API error/timeout it falls back to the cache | Dashboard screenshot; network tab showing `/apps/loyalty/v1/*` 200s | Live API data renders; cache fallback still works when the API is forced to error |
| 14 | Membership card & QR | `GET /v1/membership-card` (auth via signed App Proxy) and `GET /v1/membership-card/verify?...` (public) | issuance returns a signed non-PII member id + tier + QR payload for the resolved customer; verify returns `{valid,tier}` only; tampered → `{valid:false}` | curl transcripts | Issuance works over the App Proxy path (fails closed only if `MEMBERSHIP_SIGNING_KEY` unset); public verify correct; bearer-token issuance still fails closed (no `tokenVerifier`, see §0) |
| 15 | Reconciliation | Trigger the reconciliation job (token set) | caches recomputed from ledger; metafield cache converged; processed/repaired counts | job log; before/after cache query | Drift repaired; second run no-op |
| 16 | Expiry jobs | Run daily expiry (can seed a matured lot in staging) | matured lots → one `expire` entry each; pre-expiry sweep enqueues `preExpiryEmail` jobs | ledger `expire` rows; queue rows; ESP worker log | Each lot expires once; notifications enqueued |
| 17 | Analytics refresh | Trigger `refreshAnalyticsAggregates` or wait for hourly | matviews refreshed; `analytics_aggregate_refresh.refreshed_at` bumped; `GET /v1/admin/analytics` returns metrics + `computedAt` | admin analytics response; SQL | Ledger/redemption/enrolment metrics populate; order-derived = 0 (documented) |
| 18 | Theme desktop & mobile | Load dashboard 320px→1920px | No overflow/overlap; reduced-motion honored; sections render | Screenshots (mobile+desktop); Lighthouse | No layout break; LCP/CLS/FID within targets (manual) |
| 19 | Performance & logs | Observe under light load | 200s < targets; no unhandled errors; no secret in logs | log sample; latency numbers; queue depth | No errors/secret leakage; acceptable latency |

**Admin tools (bonus):** `POST /v1/admin/adjustments`, `/v1/admin/credits`, `GET /v1/admin/customers/:id/ledger`, `/v1/admin/fraud-review`, `/v1/admin/analytics` with `Authorization: Bearer $ADMIN_AUTH_SECRET` → 200; without → 401 (fail closed). Capture both.

**Signup points (bonus):** create a customer in the staging store → `customers/create` → one `earn_signup = +50`; replay → no double credit.

---

## 8. Final staging sign-off template

```
ATHOOR LOYALTY — STAGING SIGN-OFF
Date: __________   Operator: __________   Commit/SHA: __________   Store: __________.myshopify.com

Build status:            [ ] PASS  (npm run build → exit 0)
Typecheck status:        [ ] PASS  (npm run typecheck → exit 0)
Test results:            [ ] PASS  (npm test → ___/___ passing)
Migration status:        [ ] PASS  (9/9 applied on clean DB; verified via pgmigrations)
Worker status:           [ ] PASS  webhook[ ] discount-code[ ] metafield[ ] pre-expiry-ESP[ ]
Scheduler status:        [ ] PASS  reconciliation[ ] expiry[ ] analytics-refresh[ ]
Shopify integration:     [ ] PASS  Admin auth[ ] webhook reg[ ] webhook delivery[ ] discount mint[ ] metafield write[ ] App Proxy[ ]
Queue status:            [ ] PASS  no stuck/failed jobs (pgboss.job inspected)
Security status:         [ ] PASS  HTTPS[ ] PGSSL[ ] no shpat_ token[ ] admin fail-closed[ ] membership fail-closed[ ] no secret in logs[ ]
Performance status:      [ ] PASS  latency ____ ms; no unhandled errors
Theme status:            [ ] PASS  desktop[ ] mobile[ ] no visual regression[ ]

Open items / known limitations acknowledged (from §0):
  [ ] Customer Account API bearer path unwired (no tokenVerifier) — mobile/bearer endpoints fail closed by design (App Proxy path serves live data)
  [ ] Storefront theme redemption CTA wiring to POST /v1/redeem to be verified (backend endpoint is live; mailto: CTA may still be present)
  [ ] ESP logging-only (no real email)
  [ ] Analytics order-derived metrics = 0 (no Shopify order mirror)
  [ ] Data cutover (M0–M2) requires operator invocation script

PRODUCTION GO / NO-GO:  [ ] GO   [ ] NO-GO
Rationale: ______________________________________________________
Sign-off: _______________________________________________________
```

**Recommended decision rule:** GO to production only when items 1–8, 11–12, 15–17, 19 pass live, the §0 limitations are either resolved or explicitly accepted by the product owner, secrets are provisioned, backups/PITR are verified, and a rollback (schema + data) has been rehearsed on staging.
