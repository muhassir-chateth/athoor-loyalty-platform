# Athoor Loyalty Platform — Staging Deployment Handover

> **Operational document only.** The release candidate is FROZEN (code complete, docs complete, 990/990 tests, build + typecheck green). Nothing here changes source, tests, requirements, or architecture. This is the deploy-and-validate handover for the frozen RC on a Shopify **development/staging** store.
>
> Companion docs: `docs/STAGING_RUNBOOK.md` (full reference) and `docs/STAGING_EXECUTION_CHECKLIST.md` (detailed validation runs). This handover is the single-page operator path from bare infra to a validated staging environment.
>
> **Golden rules**
> - Staging/development store only — never production `myathoorlondon.myshopify.com`.
> - Never reuse the local MCP `shpat_` token — the config guard rejects a `shpat_` token when `NODE_ENV=production`.
> - No secrets in git; env/secrets manager only. Secrets are never logged.
> - Do not edit the frozen RC to make a step pass. A failure → log it with (step, expected, actual, evidence, component) and route through a new change cycle.

---

## 1. Required infrastructure

### PostgreSQL
- Dedicated staging Postgres, **PostgreSQL ≥ 13** (needs `gen_random_uuid()` / pgcrypto and `REFRESH MATERIALIZED VIEW CONCURRENTLY`).
- TLS enabled; connect with `PGSSL=true`.
- Backups + **PITR** enabled, **WAL retention ≥ 7 days** (design Req 13.6). Provisioning is infra-side.
- Sufficient connections for the app pool + pg-boss on the same database.

### pg-boss
- **No separate service.** `pg-boss` v10 runs on the **same** Postgres connection; `boss.start()` creates its schema (`pgboss`) on first boot. Ensure the DB role may create a schema and tables.

### HTTPS / service hosting
- A container/VM running a long-lived **Node ≥ 24.0.0** process (RC verified on v24.17.0) behind an **HTTPS-terminating** proxy/edge, publicly reachable (Shopify must POST webhooks + App Proxy requests to it).
- In production mode the service refuses to boot unless `REQUIRE_HTTPS=true`; it assumes the edge terminates TLS. `trustProxy` is enabled so protocol/IP come from forwarded headers.

### Required secrets / environment variables (source of truth: `src/config.ts`)
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
| `PGSSL` | **yes** | `true` to require TLS to Postgres. |

\* Without `SHOPIFY_ADMIN_API_TOKEN` the service still boots but **skips** the discount-code worker, metafield-cache worker, real-time metafield enqueue, and reconciliation scheduler (fail-safe boot). Set it for a full staging validation.

**Secrets to generate:** `MEMBERSHIP_SIGNING_KEY` (`openssl rand -hex 32`), `ADMIN_AUTH_SECRET` (`openssl rand -hex 32`), DB password.
**Secrets from Shopify:** Admin API token, webhook signing secret, App Proxy shared secret.

---

## 2. Deployment steps

| # | Action (command) | Expected | Evidence | Pass criteria |
|---|---|---|---|---|
| 2.1 | Install deps: `npm ci` | Clean install from lockfile, no errors | Command output | Exit 0 |
| 2.2 | Build verification: `npm run build` | `tsc` emits to `dist/` | Command output | Exit 0, `dist/index.js` present |
| 2.3 | (Optional confidence) `npm run typecheck` | No type errors | Command output | Exit 0 |
| 2.4 | Migrate DB: `npm run migrate:up` | 9 migrations applied in order | `SELECT name,run_on FROM pgmigrations ORDER BY run_on;` | 9 rows recorded |
| 2.5 | Start service: `npm start` (`node dist/index.js`) behind HTTPS edge | Boots, connects Postgres + pg-boss, listens on `PORT` | Boot log; process up | "listening" logged, no unhandled boot error |
| 2.6 | Health check | `curl -fsS https://<host>/health` | `{"status":"ok","version":...}` | curl transcript | HTTP 200 with body |
| 2.7 | Version + rewards | `curl -fsS https://<host>/v1/version` and `/v1/rewards` | version id; 4 rewards (100→£5,250→£15,500→£35,1000→£75) | curl transcripts | Both 200 with expected bodies |

Migration order applied by 2.4: create-ledger-core → create-benefits-schema → create-profile-preferences → create-admin-audit-log → create-device-tokens → create-market-config → add-redemption-channel → create-pre-expiry-notifications → create-analytics-aggregates.

---

## 3. Shopify staging setup

### Custom app configuration
- Create a **development store** (Partner dashboard), separate from production.
- Create a **custom app** on that store. Capture: **Admin API access token** → `SHOPIFY_ADMIN_API_TOKEN`; **API secret** (App Proxy) → `SHOPIFY_APP_PROXY_SECRET`; **webhook signing secret** → `SHOPIFY_WEBHOOK_SECRET`.

### Required API scopes (least privilege — `ADMIN_API_SCOPES` in `config.ts`)
- `read_customers`, `read_orders`, `read_products`, `write_discounts`, `write_price_rules` (+ the webhook scopes Shopify requires to subscribe).

### Webhook topics (`WEBHOOK_TOPICS` in `config.ts`)
- `customers/create`, `orders/paid`, `refunds/create`, `orders/cancelled`.
- Registration is a **separate deploy step** (never at startup), driven by `src/webhooks/registration.ts` (`buildAllWebhookRegistrations` / `ALL_WEBHOOK_TOPICS`). No packaged CLI ships — invoke the registration module with the live Admin client via an operator script, or register the four topics manually. Point all at `https://<host>/webhooks/shopify`.

### App Proxy configuration
- Subpath prefix `/apps/loyalty` → `https://<host>` so storefront calls to `/apps/loyalty/v1/*` reach the service's `/v1/*`. The shared secret must equal `SHOPIFY_APP_PROXY_SECRET`.

### Staging-only token requirements
- Use a **dedicated staging** Admin token — never the MCP `shpat_` token (rejected in production by the config guard). Store all secrets in the secrets manager; confirm none are echoed in logs.

---

## 4. Validation sequence

Run in order; each row assumes the previous passed. Detailed variants live in `docs/STAGING_EXECUTION_CHECKLIST.md`.

| # | Action | Expected | Evidence | Pass criteria |
|---|---|---|---|---|
| 4.1 | Run migrations on clean DB (`npm run migrate:up`) | 9 migrations; tables + 3 matviews present | `pgmigrations`; `\dt`; `\dm` | 9 rows; all objects present |
| 4.2 | Confirm worker registration (read boot logs) | Always-on: webhook-processing, daily expiry (scan+sweep), pre-expiry ESP, hourly analytics. With Admin token: discount-code, metafield-cache. Without token: explicit skip warning | Boot log excerpt | Expected bindings present for token mode |
| 4.3 | Confirm scheduler registration | `SELECT name FROM pgboss.schedule;` | expiry + analytics always; reconciliation with token | Query output | Expected schedules present |
| 4.4 | Customer earning flow | Place a **real paid test order** → `orders/paid` | one `earn_order = floor(eligibleTotal × tierMultiplier)`; +100 first-purchase once; matching `point_lot` (12-mo expiry) | `SELECT * FROM ledger_entries, point_lots`; webhook + worker logs | Exact expected points; lot created; bonus once |
| 4.5 | Redemption flow | `POST /apps/loyalty/v1/redeem` (signed) `{rewardId,idempotencyKey}` + `Idempotency-Key`; replay same key; insufficient; unknown reward | 200 `RedemptionResult` + one spend + FIFO lot consumption + one job; replay → same redemption, no new spend/job; insufficient → 409; unknown → 400; >10/60s → 429 | curl transcripts; `redemptions`/`ledger_entries`/`point_lots`; queue rows | One spend + ≤1 code per (customer,key); spendable ≥ 0; error mapping correct |
| 4.6 | Discount-code generation (Admin token) | Worker consumes the job | `redemptions` `pending_code`→`issued`; one single-use, customer-bound `ATH-XXXX-XXXX` code; `discount_codes` row | `SELECT * FROM redemptions,discount_codes`; Shopify Admin discount; worker log | Exactly one code, `usageLimit=1`, bound to customer |
| 4.7 | Metafield sync (Admin token) | Cause a balance change | `customer.metafields.loyalty.*` updated from ledger; non-fatal on failure (last-known-good) | Admin metafields before/after; worker log | Metafields reflect ledger values |
| 4.8 | Dashboard / customer endpoints (signed App Proxy) | Load dashboard; hit `/v1/balance`,`/history`,`/profile`,`/profile/journey`,`/membership-card`(+ public `/verify`) | Live ledger-backed balance/tier/rewards; paginated typed history; profile (empty categories empty, not error); membership issue + verify `{valid,tier}`; cache fallback on forced API error | Screenshots; network tab `/apps/loyalty/v1/*` 200s; curl transcripts | Live data matches ledger; only requester's data; fallback works; bearer path fail-closed (by design) |
| 4.9 | Expiry / reconciliation / analytics jobs | Seed matured lot → run expiry; introduce cache drift → run reconciliation (token); trigger analytics refresh → `GET /v1/admin/analytics` (Bearer) | Expiry: one `expire` per lot, repeat=no-op. Reconciliation: caches+metafields recomputed from ledger, repeat=no-op. Analytics: matviews refreshed, `refreshed_at` bumped, metrics+`computedAt`; **order-derived (clv/repeatPurchaseRate/royalVipGrowth)=0** (documented) | ledger `expire` rows; job logs w/ counts; analytics response; `analytics_aggregate_refresh` | Each lot expires once; drift repaired; ledger metrics populate; order-derived=0 as documented; unauth analytics → 401 |
| 4.10 | Pre-expiry notification queue | Lot inside window (default 30d) → run sweep; repeat | one `preExpiryEmail` job per qualifying lot (amount+date); `LoggingEmailProvider` logs (no real email); no duplicate for already-notified lot | queue rows; ESP worker log; `pre_expiry_notifications` | One job/lot; no duplicates; real email NOT expected (ESP logging-only) |
| 4.11 | Theme behaviour | Load dashboard desktop (→1920px) + mobile (320px→); apply minted code at checkout + attempt reuse | No overflow/overlap; reduced-motion honored; transitions transform/opacity; code applies once, reuse blocked; WCAG 2.1 AA spot-check | Screenshots (desktop/mobile/checkout applied+blocked); Lighthouse | No layout break; LCP<2.5s/CLS<0.1; single-use enforced |

---

## 5. Evidence collection standard

For every validation item (§4), record:
- **Command/action** — exact command, URL, or UI action performed.
- **Expected result** — from the Expected column above.
- **Evidence to capture** — SQL output, curl/response transcript, log excerpt, screenshot, or Shopify Admin view as listed.
- **Pass/fail criteria** — from the Pass criteria column; mark PASS/FAIL with a one-line note.

Suggested per-item log block:
```
Item: 4.__  ______________________
Command/action: ______________________
Expected: ______________________
Actual: ______________________
Evidence ref: ______________________ (file/screenshot/log id)
Result: [ ] PASS  [ ] FAIL
```

---

## 6. Handover sign-off

```
Date: ______  Operator: ______  Commit/SHA (frozen RC): ______  Store: ______.myshopify.com

Infrastructure ready:     [ ] Postgres ≥13 + TLS + PITR(WAL≥7d)   [ ] Node ≥24 host + HTTPS edge   [ ] secrets provisioned
Deployment (§2):          [ ] install  [ ] build  [ ] migrate  [ ] start  [ ] health/version/rewards
Shopify setup (§3):       [ ] custom app  [ ] scopes  [ ] 4 webhooks  [ ] App Proxy  [ ] staging token (no shpat_)
Validation (§4):          [ ] 4.1  [ ] 4.2  [ ] 4.3  [ ] 4.4  [ ] 4.5  [ ] 4.6  [ ] 4.7  [ ] 4.8  [ ] 4.9  [ ] 4.10  [ ] 4.11

Accepted limitations acknowledged (not defects):
  [ ] Customer Account API bearer path (tokenVerifier) fail-closed by design
  [ ] ESP logging-only (no real email)
  [ ] Analytics order-derived metrics = 0 (no Shopify order mirror)
  [ ] Data cutover M0–M2 via operator script (if in scope)

Prerequisites for GO:
  [ ] Backups/PITR verified   [ ] Schema + data rollback rehearsed   [ ] No secret in logs

PRODUCTION GO / NO-GO:  [ ] GO   [ ] NO-GO
Rationale: ______________________________________________
Sign-off: ______________________________________________
```

**Decision rule:** GO only when §2, §3, and §4 items pass live (customer flows 4.4–4.8 and single-use redemption 4.6/4.11 are mandatory), the accepted limitations are explicitly acknowledged by the product owner, and the GO prerequisites are confirmed. Any failure in migration apply (4.1), a customer-facing flow (4.4–4.8), or redemption/discount integrity (4.5/4.6/4.11) is a NO-GO — resolve via a new change cycle; the frozen RC is not edited in place during validation.
