# Athoor Loyalty Platform — Release Candidate 1 (RC1) Handover

**Date:** 2026-07-27 · **Release candidate:** RC1 · **Commit:** `19bd763` (`main`, pushed)
**Service:** https://athoor-loyalty-platform.onrender.com · **Status:** backend/service implementation **FROZEN**

---

## 1. Executive summary

The Athoor Loyalty Platform replaces the store's metafield-based "rewards club" —
where points lived in Shopify customer metafields and redemption was a `mailto:`
link — with a standalone Node.js + PostgreSQL microservice whose **immutable
ledger is the single source of truth**. Balances are projections of that ledger,
never mutable counters, so every movement is auditable and reconstructable.

All service-side engineering is complete. 44 of 46 tasks are closed; the two open
tasks are blocked exclusively by **external storefront access**, not by missing
code. 1511 tests pass across 129 files, the TypeScript build is clean, all 15
migrations are applied, and staging matches its documented baseline exactly.

What distinguishes this release is that features were only accepted once a
**verified runtime path exercised them in staging** — static analysis was never
treated as sufficient. That discipline repeatedly paid off: it exposed a
cross-customer idempotency leak (task 38), four dormant subsystems that tests
passed over (tasks 30, 31, 44, 46), a transaction-read bug in the admin surface
(task 41), and the fact that Shopify only fires `orders/paid` on real payment
capture (task 45). Each was found by live verification, not by the test suite.

**One operational gap requires action before launch and is not a code defect:**
the disaster-recovery mechanism has never produced a backup. `/health` reports
`backups.stale: true` with `lastSuccessAt: null` and `backup_runs` is empty. The
machine check is working exactly as designed — it is telling us the mechanism is
not yet configured. See §9.

---

## 2. Completed phases

| Phase | Scope | Status |
|---|---|---|
| **1 — MVP** | Ledger core, webhook receiver (HMAC + idempotency), earning (signup / tiered order / first purchase), automated redemption with single-use codes, App Proxy dashboard wiring, metafield cache, data-safe M0–M2 migration | **Complete** |
| **2 — Integrity & lifecycle** | Refund and cancellation clawback, FIFO expiry + scheduler + pre-expiry notifications, referrals with self-referral guards, reconciliation and backup/recovery | **Complete** |
| **3 — Profile, VIP, portal, admin** | Off-ledger Profile/Preferences store, VIP benefits + Entitlement Resolver, luxury private-client portal, admin tooling and analytics | **Complete** |
| **4 — Mobile readiness, international, channels** | Device tokens, Membership-Credential service, market/rule-set configuration, channel attribution | **Complete** |
| **5 — Post-staging follow-ups** | 24 tasks raised by staging validation, the reachability audit, and successive live verifications | **Complete except tasks 27 and 43 (externally blocked)** |

---

## 3. Task register (1–46)

All 46 tasks, plus 18 optional property-test sub-tasks, are accounted for. Zero
unchecked sub-tasks remain.

### Phase 1 — MVP
| # | Task | Status |
|---|---|---|
| 1 | Project skeleton and ledger schema | Complete |
| 2 | Ledger core and balance projection | Complete |
| 3 | Webhook receiver (HMAC + idempotency) | Complete |
| 4 | Earning engine and tier model | Complete |
| 5 | Automated redemption and single-use discount codes | Complete |
| 6 | API gateway, identity, read endpoints, cache, dashboard wiring | Complete |
| 7 | Data-safe migration (M0–M2) | Complete |
| 8 | Checkpoint | Complete |

### Phase 2 — Integrity and lifecycle
| # | Task | Status |
|---|---|---|
| 9 | Refund and cancellation clawback | Complete |
| 10 | FIFO expiry, scheduler, pre-expiry notifications | Complete |
| 11 | Referrals | Complete |
| 12 | Reconciliation and backup/recovery | Complete |
| 13 | Checkpoint | Complete |

### Phase 3 — Profile, VIP, portal, admin
| # | Task | Status |
|---|---|---|
| 14 | Profile / Preferences store (off-ledger) | Complete |
| 15 | VIP benefits and Entitlement Resolver | Complete |
| 16 | Luxury private-client portal | Complete |
| 17 | Admin tooling and analytics | Complete |
| 18 | Checkpoint | Complete |

### Phase 4 — Mobile readiness, international, channels
| # | Task | Status |
|---|---|---|
| 19 | Mobile readiness | Complete |
| 20 | International / configuration readiness | Complete |
| 21 | Channel attribution for app-exclusive rewards | Complete |
| 22 | Final checkpoint | Complete |

### Phase 5 — Post-staging follow-ups
| # | Task | Status |
|---|---|---|
| 23 | Advance `webhook_events` processing state for traceability | Complete |
| 24 | Make scheduled jobs run reliably in production (A15) | Complete |
| 25 | Exercise the referral reward flow end to end on staging | Complete |
| 26 | Rehearse the M0–M2 migration/cutover runbook | Complete (M2 evidence pending task 27) |
| 27 | **Validate the storefront dashboard, performance and accessibility** | **PENDING — external blocker only** |
| 28 | Exercise FIFO expiry and pre-expiry notifications on staging | Complete |
| 29 | Decide the backup and disaster-recovery strategy (A17) | Complete (decision made; mechanism not yet run — §9) |
| 30 | Wire VIP benefits and entitlements end to end | Complete |
| 31 | Wire profile preference write endpoints | Complete |
| 32 | Configuration-driven earning and reward rules — decided: constants stay (A18) | Complete |
| 33 | Build the migration operator tooling | Complete |
| 34 | Wire the dashboard's referral code to `/v1/referral` | Complete |
| 35 | Refresh the metafield cache on referral credits | Complete |
| 36 | Assign referral codes to members who never got one | Complete |
| 37 | Implement the customer-facing referral claim flow | Complete |
| 38 | Scope idempotency keys per customer (**security**) | Complete |
| 39 | Prevent circular and collusive referrals — investigation | Complete |
| 40 | Enforce one accepted referral per customer | Complete |
| 41 | Give a recorded benefit request somewhere to go | Complete |
| 42 | Decide the fate of the `app` channel — documented unreachable (A19) | Complete |
| 43 | **Trigger wishlist reconciliation from the storefront; translate handles to product ids** | **PENDING — external blocker only** |
| 44 | Wire a real Shopify order source for purchased fragrances | Complete |
| 45 | Verify earning from a genuinely Shopify-fired `orders/paid` | Complete |
| 46 | Record a tier change when the earning engine advances a tier | Complete |

### Why 27 and 43 are pending

Neither is waiting on code.

- **Task 27** requires the rendered, authenticated dashboard to measure anything
  honestly: Lighthouse scores, Core Web Vitals, an axe run, a keyboard and
  screen-reader pass, and 320–1920px responsive checks. Re-probed 2026-07-27:
  `GET https://athoor-loyalty-staging.myshopify.com/` still returns `302` to
  `/password`, and `themes(first: 5)` still returns `ACCESS_DENIED` requiring
  `read_themes`. **No Lighthouse or axe figure has been invented.** A partial
  audit exists in `docs/ops/dashboard-audit.md`, which separates LIVE (observed)
  from STATIC (read from code) claims; every endpoint the dashboard consumes is
  verified live against the ledger. This task also owes the outstanding **M2
  evidence** for task 26.
- **Task 43** shares those blockers and additionally needs a product
  **handle → id** translation decision: the theme's device-local
  `shopify-wishlist` entry stores product handles, while
  `customer_wishlist.shopify_product_id` is `BIGINT`. Confirmed live:
  `deviceLocal: ["athoor-oud"]` → `400 profile_invalid_input`. The server side
  (`POST /v1/profile/wishlist/reconcile`) is implemented and verified.

---

## 4. Production readiness checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Ledger is the single source of truth; balance never independently mutable | **Pass** | Properties 1–2 property-tested; staging invariants clean |
| 2 | Every credit backed by a point lot (Property 17) | **Pass** | Staging: 0 unbacked credits, 0 lot overdraw, 0 non-positive earns |
| 3 | Webhook HMAC verification fails closed | **Pass** | Tampered body → `401 invalid_hmac`, nothing persisted (task 45) |
| 4 | Webhook dedupe on Shopify's own id | **Pass** | Genuine id replay → `200 {"duplicate":true}`, no state change |
| 5 | Order-level replay guard | **Pass** | New webhook id, same order → no additional earning (Req 2.8) |
| 6 | Earning correct on a **genuine** Shopify payload | **Pass** | `earn_order` 949 = `floor(949.95 × 1.0)` + 100 first purchase (task 45) |
| 7 | Tier advancement monotonic, and now recorded | **Pass** | Bronze → Gold with exactly one `tier_change_history` row (task 46) |
| 8 | Redemption concurrency-safe, idempotent, single-use codes | **Pass** | Properties 3–5, 10; live verified |
| 9 | Clawback bounded by points earned | **Pass** | Property 8 |
| 10 | FIFO expiry idempotent per scan date | **Pass** | Property 9; live verified (task 28) |
| 11 | Referral abuse bounded: one accepted referral per customer | **Pass** | Partial unique index; both exploits re-run live and refused (task 40) |
| 12 | Idempotency keys scoped per customer | **Pass** | Security fix, task 38 |
| 13 | Admin surface authenticated, fails closed | **Pass** | Unauthenticated admin call → `401` |
| 14 | Immutable audit trail on admin state changes | **Pass** | Task 41; two audit records per transition chain |
| 15 | Benefit requests have an operator lifecycle | **Pass** | Queue + transitions, idempotent, terminal-state refusal `409` |
| 16 | Display cache derived from the ledger, non-authoritative | **Pass** | Metafields correct after genuine order (1099 / gold) |
| 17 | Scheduled work survives host sleep (catch-up semantics) | **Pass** | A15 due-work scheduling; `/health` `scheduling.overdue: []` |
| 18 | Config drift between constants and DB rule sets machine-checked | **Pass** | `/health` `marketConfig.drifted: false` |
| 19 | Channel reachability machine-checked | **Pass** | `/health` `channels.ungrantable: []` |
| 20 | No dormant subsystems, dead routes, TODO/FIXME in service code | **Pass** | Final audit: 508 runtime exports swept; all documented routes registered |
| 21 | Migrations all applied, none orphaned | **Pass** | 15/15 (§5) |
| 22 | Tests and build | **Pass** | 1511 tests, 129 files; `tsc` clean (§6) |
| 23 | Staging matches documented baseline | **Pass** | 13 tables verified (§8) |
| 24 | Spec ↔ mirror ↔ implementation aligned | **Pass** | `requirements/design/tasks.md` byte-identical to `docs/specs/` mirror |
| 25 | **Disaster recovery mechanism has produced a usable backup** | **NOT MET** | `backup_runs` empty; `/health` `backups.stale: true` (§9) |
| 26 | Storefront validation (Lighthouse, axe, responsive, Meta Pixel) | **NOT MET** | Task 27 — external blocker |
| 27 | Wishlist reconciliation triggered from the storefront | **NOT MET** | Task 43 — external blocker |
| 28 | Production M0 dry run executed and approved | **NOT MET** | Requires owner approval (§9) |

---

## 5. Database migration status

**15 migration files, 15 applied on staging. Zero unapplied. Zero applied-but-missing.**

Most recent six:

```
1785400000000_create-scheduled-runs
1785500000000_create-idempotency-keys
1785600000000_create-backup-runs
1785700000000_referrals-one-accepted-per-customer
1785800000000_rename-one-referrer-per-referred-index
1785900000000_benefit-request-lifecycle
```

Schema objects the most recent tasks depend on, all verified present on staging:

| Object | Present |
|---|---|
| `tier_change_history` table | Yes |
| `benefit_requests` table | Yes |
| `benefit_requests.status_changed_at` column | Yes |
| `idx_benefit_requests_status` index | Yes |
| `benefit_requests_status_check` constraint (5 statuses) | Yes |
| `admin_audit_log_operation_type_check` (incl. `benefit_request`) | Yes |
| `referrals_one_referrer_per_referred` unique index | Yes |
| `redemptions.channel` column | Yes |

**Production note:** production has never had these migrations applied. The
cutover applies them as part of M1, per `docs/ops/m0-m2-cutover-runbook.md`.

---

## 6. Test and build summary

| Metric | Result |
|---|---|
| Test files | **129 passed / 129** |
| Tests | **1511 passed / 1511** |
| Failures, skips | 0 |
| Property-based tests | Properties 1–17 via `fast-check` |
| Build | `tsc -p tsconfig.json` — **clean**, exit 0 |
| Working tree | Clean (only untracked `shopify-mcp-local/`, a local MCP tooling dir) |
| Unpushed commits | None |

Test growth across the final tasks: 1265 → 1278 (task 40) → 1320 (30) → 1349
(31) → 1381 (32) → 1415 (44) → 1432 (42) → 1483 (41) → **1511** (46).

Boot-wiring and reachability guards are part of the suite specifically so the
"implemented but never reachable" class of defect cannot recur silently.

---

## 7. Deployment status

| Item | Value |
|---|---|
| Host | Render (free tier), auto-deploy on push to `main` |
| Deployed commit | `19bd763` |
| Service URL | https://athoor-loyalty-platform.onrender.com |
| `GET /health` | `200`, `status: ok`, `version: v1` |
| Database | Supabase Postgres (staging), pooler `aws-1-eu-west-2` |
| Cold start | ~20–25s after idle spin-down (accepted, A15) |
| Keep-alive | GitHub Actions workflow pinging `/health` |

Current `/health` payload:

```json
{
  "status": "ok",
  "version": "v1",
  "scheduling":   { "overdue": [] },
  "backups":      { "lastSuccessAt": null, "ageHours": null, "stale": true },
  "marketConfig": { "source": "constants", "drifted": false, "differences": [] },
  "channels":     { "attributed": "web", "reachable": { "web": true, "app": false }, "ungrantable": [] }
}
```

Three of four blocks are green. `backups.stale: true` is the outstanding item in §9.

---

## 8. Staging baseline verification

Verified 2026-07-27 after the final task. **All 13 tables match the documented baseline.**

| Table | Documented | Actual |
|---|---|---|
| `customers` | 8 | 8 |
| `ledger_entries` | 35 | 35 |
| `point_lots` | 27 | 27 |
| `webhook_events` | 21 | 21 |
| `referrals` | 1 | 1 |
| `idempotency_keys` | 2 | 2 |
| `tier_change_history` | 0 | 0 |
| `admin_audit_log` | 7 | 7 |
| `benefit_requests` | 0 | 0 |
| `customer_favourites` | 0 | 0 |
| `customer_wishlist` | 0 | 0 |
| `customer_recently_viewed` | 0 | 0 |
| `portal_visits` | 0 | 0 |

Supporting state:

- Tier distribution: **5 bronze, 3 silver**.
- Benefits: **0 active, 0 app-exclusive** — all six seeded perks remain
  `active = false` per A13. Enabling one is a business decision, not an
  engineering step.
- Ledger invariants: 0 unbacked credits, 0 lot overdraw, 0 non-positive earns.
- Shopify staging: **0 orders**, 9 customers.

Two reconciled discrepancies, both expected and neither a defect:

1. **9 Shopify customers vs 8 enrolled locally.** Two dev-store seed customers
   (`ayumu.hirano@example.com`, `karine.ruby@example.com`, created 2026-07-24)
   predate the webhook subscription and were never enrolled. This is **A3 lazy
   enrolment behaving correctly** — a row is created on the first qualifying
   event, not eagerly.
2. **One local row with no Shopify counterpart:** `validation.signup@example.com`,
   synthetic id `9900000000001`, from the original release-candidate validation.
   It carries the historical data-repair adjustment from the pre-fix
   duplicate-reversal defect. Its arithmetic is sound (balance 520 = spendable
   520). Staging-only; it has no bearing on production.

---

## 9. Remaining external prerequisites

None of these is engineering work. All require the store owner or an operator.

| # | Prerequisite | Blocks | How to confirm it is cleared |
|---|---|---|---|
| 1 | **Storefront password removal or bypass link** on `athoor-loyalty-staging.myshopify.com` | Tasks 27, 43 | `GET /` returns `200` rather than `302 → /password` |
| 2 | **Authenticated staging customer session** for a member with ledger data | Tasks 27, 43 | Logged-in dashboard renders (measurement must not run on the logged-out join branch) |
| 3 | **`read_themes`** on the staging app (plus **`write_themes`** if fixes must be deployed) | Tasks 27, 43 | `themes(first: 5)` returns a theme list rather than `ACCESS_DENIED` |
| 4 | **Production M0 dry run approval** | Cutover | Owner approves; M0 export produced and reconciled as the rollback anchor |
| 5 | **Canonical storefront template confirmation** — `page.rewards` vs `page.loyalty` | Task 27 | Owner states which template is authoritative |
| 6 | **Meta Pixel confirmation on staging** — is the channel installed? | Task 27 | Owner confirms; then ViewContent / AddToCart / InitiateCheckout / Purchase can be verified |
| 7 | **Disaster-recovery mechanism must produce its first backup** | Launch readiness | `backup_runs` gains a row and `/health` reports `backups.stale: false` |

### Detail on prerequisite 7 (found during this audit)

The DR standard accepted under A17 is a daily encrypted logical dump. The
mechanism is built and committed (`.github/workflows/backup.yml`, daily at
`03:15` plus `workflow_dispatch`), and it **fails closed**: it refuses to write
an unencrypted dump and rejects a key that looks like an `age` private key. But
`backup_runs` is empty and `/health` reports `lastSuccessAt: null`, so no
successful run has ever been recorded.

It needs, in the GitHub repository:

- secret **`BACKUP_DATABASE_URL`**
- variable **`BACKUP_AGE_PUBLIC_KEY`** (an `age1...` recipient key; the private
  half must never enter CI or the repo)
- optionally, for the off-site copy, all four of `R2_ACCOUNT_ID`, `R2_BUCKET`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — the step skips cleanly if absent

Then trigger the workflow manually once and confirm `/health` flips
`backups.stale` to `false`. **Recommendation: do not launch until this is
green.** Until then the effective recovery position is worse than the documented
RPO of ~24 hours, because there is no dump at all. Runbook:
`docs/ops/backup-and-recovery.md`.

---

## 10. Accepted design assumptions (A17–A20)

These are deliberate, documented deviations. Each is machine-checked where a
silent-drift hazard exists, so it cannot be quietly forgotten.

**A17 — Daily encrypted logical backups instead of point-in-time recovery.**
The zero-cost database tier provides no automated backups, no PITR and no WAL
retention, so Requirement 13.6 was unmet on every clause as originally written.
The delivered standard is a daily logical dump encrypted to a public key whose
private half never enters CI, retained off-site ≥7 days. **RPO ≈ 24 hours, RTO
manual** — a mistake can be undone only as of the previous dump. The stricter
PITR standard remains encoded and is asserted to *fail*, so the deviation stays
visible. Total database loss without a usable dump leaves balances approximately
reconstructable from Shopify orders and the `loyalty.*` metafields, but **ledger
history, audit trail, manual adjustments, referral attribution, FIFO lot
structure and spend-to-code linkage would be permanently lost.**

**A18 — Hardcoded rule constants are the MVP source of truth.**
The `markets` / `earning_rule_sets` / `reward_rule_sets` tables and
`DbMarketConfigProvider` exist, are seeded and tested, and are the forward path
for a second market — but the engine reads the GBP constants. Wiring the provider
into the money paths was evaluated and declined: ~eleven call sites including the
redemption engine, a cache with a refresh policy, and a new failure mode where a
malformed config row aborts an earning or redemption transaction — all to make
four numbers editable without a deploy, for a single market. Cost: a threshold,
multiplier or reward change requires a deploy. The two-representations hazard is
machine-checked and published on `/health` (criterion 21.6a).

**A19 — The `app` channel is unreachable until a native app exists.**
`channel: "app"` needs a Customer Account API bearer token and no verifier is
wired, so every production request is `web`. Deliberate: Requirement 19 is
future-scoped, no native app exists, and criterion 11.5 forbids building custom
authentication. A real verifier would need the shop's issuer configuration *and*
an authenticated storefront session — the same access blocking tasks 27 and 43 —
and would grant nothing, since nothing is configured app-exclusive. Consequence:
the app-exclusive gate (19.4, Property 15) is exercised by tests only. The
hazard — an app-exclusive item grantable to *nobody* after a config edit — is
machine-checked on `/health` (criterion 19.7a).

**A20 — The recorded booking request gains an operator lifecycle, and `declined`
is an addition.** Requirement 18.5 required only that a consultation request be
*recorded*, which is why one sat operationally invisible. The delivered lifecycle
(criteria 18.5a–18.5d) is `requested | confirmed | fulfilled | declined |
cancelled`, with the last three terminal, transitions idempotent and mutually
exclusive under concurrency, and every real status change writing an immutable
audit record. `declined` goes beyond design.md's four statuses because an
operator closing a request that will not be honoured must otherwise leave it
indefinitely `requested` or misrepresent it as `fulfilled`. Audit operation types
were correspondingly extended with `benefit_request`. **Enables no seeded perk** —
A13 still holds.

---

## 11. Known non-blocking limitations

1. **Earning precedence not discriminated by a real discounted order.** The
   genuine `orders/paid` payload delivered all three money sources in agreement
   (`current_subtotal_price`, `subtotal_price`, `total_line_items_price` −
   `total_discounts` all 949.95), confirming rule 1 is what fires in production
   but not distinguishing the three. A discounted or partially-refunded order
   would. Watch the first live discounted order.
2. **`currency` is delivered and ignored.** The staging store is USD and the
   amount was folded into `lifetime_spend_gbp` unconverted. Correct for the GBP
   production store (A8), but a non-GBP store would be silently mis-scaled.
3. **`test: false` arrives even on a development store**, so that flag cannot be
   used to filter non-real orders.
4. **`customers.lifetime_points` is stale between reconciliation runs.** The
   earning path does not update it; reconciliation is its sole writer. Not
   user-visible — verified live, since the metafield cache derives the value from
   the ledger and showed the correct 1099 while the column read 0.
5. **Six unused declarations remain in `src/`**, retained deliberately to avoid
   pre-release churn: `createLedgerAdminAdjustmentService`,
   `createPgAnalyticsDataSource` (convenience wrappers around classes `index.ts`
   instantiates directly), `ANALYTICS_REFRESH_SCHEDULE` (labelled doc/config),
   `ORDER_ATTRIBUTABLE_EARN_TYPES`, `nonEnrolledCustomers`, and
   `MEMBERSHIP_VERIFY_ROUTE`. All inert. Note that `MEMBERSHIP_VERIFY_ROUTE`'s
   comment claims it keeps the auth allowlist in sync; it does not, because
   nothing references it. The allowlist in `plugins/auth.ts` is correct today
   (both `/v1/membership-card/verify` and `/membership-card/verify` are present).
6. **Notification of a new benefit request is deferred.** No notifier is
   configured; the admin queue is the operational surface.
7. **Free-tier cold starts** of ~20–25s after idle, and best-effort scheduling
   with catch-up rather than guaranteed execution times (A15).
8. **Instagram-follow points cannot be automated** (no verifying API); manual
   admin credit only. Review points need a reviews app that emits webhooks.

---

## 12. Rollback plan

### 12.1 Service rollback (fast, low risk)

Revert to the previous commit and let Render auto-deploy:

```bash
git revert --no-commit <bad-commit> && git commit && git push origin main
# or redeploy the prior commit from the Render dashboard
```

The service is stateless; no data changes. Confirm `GET /health` returns `200`
and the four blocks read as expected. Allow ~2 minutes for deploy plus cold start.

### 12.2 Migration rollback

Every migration has a `down`. To reverse the most recent:

```bash
cd loyalty-service
NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL='<url>?sslmode=no-verify' npm run migrate:down
```

**Two reversals carry consequences, not just schema changes:**

- `1785700000000_referrals-one-accepted-per-customer` — dropping the partial
  unique index **reopens both confirmed referral exploits** (multi-claim fan-out
  and the concurrent duplicate pair). Application-level checks are not a
  substitute; a read-then-write is exactly what failed.
- `1785900000000_benefit-request-lifecycle` — dropping it removes
  `status_changed_at` and the status constraint, returning recorded benefit
  requests to being operationally invisible.

### 12.3 Cutover rollback (M0–M3)

Per `docs/ops/m0-m2-cutover-runbook.md`. **The M0 export is the rollback anchor
and must exist before M1 begins.**

| Phase | Rollback |
|---|---|
| **M0** (export, read-only) | Nothing to undo; no Shopify or DB writes occur |
| **M1** (ledger backfill) | Non-destructive to Shopify. Stop the service; the ledger can be truncated and rebuilt from the M0 export. Metafields untouched |
| **M2** (webhooks connected, parallel run) | Delete the webhook subscriptions; restore metafields from the M0 export via `ShopifyGraphqlMetafieldRestoreClient` (upsert only — **no delete method exists**, so Req 14.8 holds structurally) |
| **M3** (dashboard + redemption cutover) | Re-point the theme's redemption CTA to the retained `mailto:` snippet held in version control, and revert the dashboard fetch. Ledger data is retained for a later retry |

Guarantees: no metafield is ever deleted; migration entries are typed
`entry_type = 'migration'` and auditable; the M0 export remains the source of
truth for restoration.

### 12.4 Data-level rollback

The ledger is append-only, so an erroneous movement is corrected by a
**compensating `adjust` entry**, never by editing or deleting rows. Reconciliation
recomputes cached tier, lifetime points and lot remainders solely from the ledger
and repairs drift, including the metafield cache.

---

## 13. Final release recommendation

**Recommendation: APPROVE RC1 for release readiness on the engineering axis, but
do not launch to production until prerequisite 7 (§9) is green.**

The backend and service implementation are complete, frozen, and verified.
Nothing in the loyalty, earning, redemption, refund, expiry, referral or admin
paths is known to be defective or dormant. The money paths have been exercised
against genuine Shopify deliveries rather than hand-signed fixtures.

Conditions for go-live, in order:

1. **Configure and run the daily encrypted backup once**, and confirm `/health`
   reports `backups.stale: false`. This is the only item I would treat as
   blocking, because it concerns irreversible data loss.
2. **Execute the production M0 dry run** with owner approval, and reconcile all
   39 customers (8 enrolled) against the `50 + spend × 1` formula before M1.
3. **Clear the storefront access prerequisites** and close tasks 27 and 43. These
   gate confidence in the customer-facing surface — performance, accessibility,
   Meta Pixel — but not the correctness of the ledger. A staged launch that
   defers them is defensible if the owner accepts unmeasured storefront quality;
   launching without item 1 is not.

After launch, watch: the first live **discounted** order (limitation 1), the
first `refunds/create` from real Shopify traffic, and `/health` for
`scheduling.overdue`, `marketConfig.drifted` and `backups.stale`.

---

## Appendix — Evidence index

| Document | Covers |
|---|---|
| `docs/ops/reachability-audit.md` | Original dormancy audit (findings 1–4) |
| `docs/ops/dashboard-audit.md` | Storefront audit, LIVE vs STATIC claims; task 27 blockers |
| `docs/ops/m0-m2-cutover-runbook.md` | Migration/cutover procedure and rehearsal |
| `docs/ops/backup-and-recovery.md` | A17 standard, runbook, PITR adoption triggers |
| `docs/ops/zero-cost-architecture.md` | Hosting evaluation |
| `docs/ops/scheduled-jobs.md` | A15 scheduling decision |
| `docs/ops/referral-cycle-analysis.md` | Task 39 analysis |
| `docs/ops/referral-claim-proposal.md` | Task 37 design |
| `docs/ops/genuine-orders-paid-webhook.md` | Task 45 — genuine webhook capture and analysis |
| `docs/ops/evidence-genuine-orders-paid-fields.md` | Task 45 — redacted payload field extract |
| `docs/ops/tier-change-history-verification.md` | Task 46 — tier-change milestone live verification |
| `docs/specs/athoor-loyalty-platform/` | Requirements, design, tasks (mirror of `~/.kiro/specs/`) |
