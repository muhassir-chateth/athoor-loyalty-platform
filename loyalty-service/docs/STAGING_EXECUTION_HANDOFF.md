# Athoor Loyalty Platform — Final Staging Execution Handoff

> **Operational handoff only.** The release candidate is FROZEN and remains the baseline. Nothing in the RC (source, tests, migrations, requirements/design, architecture) is changed by this document. This is the single starting point for whoever runs live staging validation.
>
> Companion docs: `docs/STAGING_DEPLOYMENT_HANDOVER.md` (infra + deploy steps), `docs/STAGING_EXECUTION_CHECKLIST.md` (detailed per-item validation), `docs/STAGING_RUNBOOK.md` (full reference).

---

## Current validation state (as of this handoff)

| Track | Status | Basis |
|---|---|---|
| Code-level validation | **PASS ✅** | `npm run build` exit 0; `npm run typecheck` exit 0; `npm test` → 990/990 across 93 files; Node v24.17.0 |
| Live staging validation | **BLOCKED ⏳** | Environment unavailable: no `psql`, no `docker`, `DATABASE_URL`/`PG*` unset, Shopify secrets unset, no `.env`. Live items cannot be executed and MUST NOT be fabricated. |

**Production decision to date: NO-GO — validation incomplete** (code-level PASS is necessary but not sufficient; live staging items are outstanding).

This is an environment capability gap, not a defect. No change cycle is warranted; the freeze stays.

---

## Preconditions before starting (all must be true)

- Staging PostgreSQL ≥ 13, TLS on, PITR + WAL retention ≥ 7 days, reachable via `DATABASE_URL` or `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`; `PGSSL=true`.
- Node ≥ 24 host behind an HTTPS-terminating edge, publicly reachable by Shopify.
- Shopify **development/staging** store + custom app.
- Secrets set (env/secrets manager, never committed): `SHOPIFY_ADMIN_API_TOKEN` (dedicated staging token, NOT `shpat_`), `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_APP_PROXY_SECRET`, `ADMIN_AUTH_SECRET`, `MEMBERSHIP_SIGNING_KEY`; `NODE_ENV=production`, `REQUIRE_HTTPS=true`.
- Deploy the exact frozen RC commit (record the SHA in the run header).

---

## Execution order (run strictly in sequence; stop on first failure)

### Phase 1 — Database migration & schema verification
- **Actions:** `npm ci && npm run build && npm run migrate:up`; then verify via `pgmigrations`, `\dt`, `\dm`; rehearse `migrate:down` then `migrate:up`.
- **Expected:** 9 migrations applied in order; all core/additive tables + 3 matviews present; `analytics_aggregate_refresh` seeded; down/up clean.
- **Detail ref:** Checklist §1.1–1.3.

### Phase 2 — Application boot & worker/scheduler verification
- **Actions:** `npm start` behind HTTPS; read boot logs; `curl /health`, `/v1/version`, `/v1/rewards`; inspect `pgboss.queue` and `pgboss.schedule`.
- **Expected:** pg-boss schema/queues created; always-on workers (webhook-processing, daily expiry scan+sweep, pre-expiry ESP, hourly analytics) registered; Admin-gated workers (discount-code, metafield-cache) + reconciliation scheduler registered when the Admin token is set (or the explicit skip warning when not); health/version/rewards 200.
- **Detail ref:** Checklist §2.1–2.4.

### Phase 3 — Shopify Admin API, webhook, discount-code & metafield tests
- **Actions:** Admin auth check; register 4 webhook topics → `/webhooks/shopify`; trigger + re-deliver a webhook (idempotency) + a bad-HMAC request; perform a redemption to exercise discount-code minting; cause a balance change to exercise metafield sync.
- **Expected:** Admin auth succeeds (no token in logs); 4 topics registered; first delivery 200 ≤5s + one `webhook_events` row + one job, duplicate = 200 no-op, bad signature = 401; exactly one single-use, customer-bound `ATH-XXXX-XXXX` code per redemption; `customer.metafields.loyalty.*` updated from ledger.
- **Detail ref:** Checklist §3.1–3.5.

### Phase 4 — Customer dashboard & redemption flows
- **Actions:** Signed App Proxy: `/v1/balance`, `/v1/history`, `/v1/profile`, `/v1/profile/journey`, `/v1/membership-card` (+ public `/verify`); `POST /v1/redeem` for success, idempotent replay, insufficient, unknown reward, rate-limit; earning flow via a real paid order.
- **Expected:** Live ledger-backed data; only requester's data; cache fallback on forced API error; redemption → one spend + ≤1 code per (customer, key), spendable ≥ 0, correct error mapping (409/400/429); earning = `floor(eligibleTotal × tierMultiplier)` + one-time +100 first purchase + 12-month lot.
- **Detail ref:** Checklist §4.1–4.4.

### Phase 5 — Background jobs (expiry, reconciliation, analytics, pre-expiry)
- **Actions:** Seed a matured lot → run expiry (twice); introduce cache drift → run reconciliation (twice, Admin token); trigger analytics refresh → `GET /v1/admin/analytics` (Bearer); lot in pre-expiry window → run sweep (twice).
- **Expected:** One `expire` entry per lot, repeat = no-op; caches/metafields recomputed from ledger, repeat = no-op; matviews refreshed + `refreshed_at` bumped, metrics + `computedAt`, order-derived metrics = 0 (documented), unauth = 401; one `preExpiryEmail` job per qualifying lot, no duplicates, ESP logging-only (no real email expected).
- **Detail ref:** Checklist §5.1–5.4.

### Phase 6 — Theme / mobile / checkout QA
- **Actions:** Load dashboard desktop (→1920px) + mobile (320px→), reduced-motion; apply minted code at checkout + attempt reuse; confirm the storefront redemption CTA path.
- **Expected:** No overflow/overlap; reduced-motion honored; transitions transform/opacity only; code applies once and reuse is blocked; WCAG 2.1 AA spot-check; LCP < 2.5s / CLS < 0.1.
- **Detail ref:** Checklist §6.1–6.3.

---

## Evidence & failure recording rules

**Record only REAL evidence.** Do not mark any item PASS without captured proof (SQL output, curl/response transcript, log excerpt, screenshot, or Shopify Admin view). Never infer or fabricate a live result.

Per-item block:
```
Item: Phase _._  ____________________
Action: ____________________
Expected: ____________________
Actual: ____________________
Evidence: ____________________ (log id / screenshot / SQL output)
Result: [ ] PASS  [ ] FAIL
```

**On any failure: STOP.** Do not proceed to later phases. Report with exactly these fields:
- **Step** — the phase/item that failed
- **Expected** — the documented expected result
- **Actual** — what actually happened
- **Evidence/logs** — captured proof
- **Affected component** — e.g. migration `<name>`, `index.ts` boot wiring, discount-code worker, App Proxy auth, theme section, etc.

**No code changes** are permitted until a separate change request is approved. The frozen RC remains the baseline; any fix goes through a new change cycle, never an in-place edit during validation.

---

## Final GO / NO-GO template (complete after all phases)

```
Date: ______  Operator: ______  Frozen RC SHA: ______  Store: ______.myshopify.com

Code-level (pre-verified):   PASS ✅  (build/typecheck/990 tests)
Phase 1 Migrations:          [ ] PASS  [ ] FAIL
Phase 2 Boot/workers/sched:  [ ] PASS  [ ] FAIL
Phase 3 Shopify integration: [ ] PASS  [ ] FAIL
Phase 4 Customer flows:      [ ] PASS  [ ] FAIL
Phase 5 Background jobs:     [ ] PASS  [ ] FAIL
Phase 6 Theme/mobile/checkout:[ ] PASS  [ ] FAIL

Accepted limitations acknowledged (not defects):
  [ ] tokenVerifier bearer path fail-closed by design
  [ ] ESP logging-only (no real email)
  [ ] Analytics order-derived metrics = 0 (no Shopify order mirror)
  [ ] Data cutover M0–M2 via operator script (if in scope)

GO prerequisites:
  [ ] Backups/PITR verified   [ ] Rollback (schema+data) rehearsed   [ ] No secret in logs

PRODUCTION GO / NO-GO:  [ ] GO   [ ] NO-GO
Rationale: ____________________________________________
Sign-off: ____________________________________________
```

**Decision rule:** GO only when Phases 1–5 pass live (customer flows in Phase 4 and single-use redemption in Phases 3/4/6 are mandatory), accepted limitations are acknowledged by the product owner, and the GO prerequisites are confirmed. Any failure in migrations (Phase 1), a customer-facing flow (Phase 4), or redemption/discount integrity (Phase 3/4/6) is a NO-GO until resolved through a new change cycle.
```
