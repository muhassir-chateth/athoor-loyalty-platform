# Reachability audit — implemented but unreachable production paths

Triggered while starting task 28. Task 25 had already found the referral engine
implemented, tested, and never called; this audit checks systematically for the
same pattern rather than discovering cases one at a time.

**Status: findings only. No code, spec or infrastructure changed.**

## Method

1. Enumerated every symbol exported from a non-test file under `src/` (274) and
   flagged those referenced by no other production file (126).
2. Discarded the false positives that dominate that list: helpers called only
   within their own module, error classes thrown internally, in-memory test
   doubles, and operator-only entry points (the M0–M2 migration scripts and
   webhook registration are *meant* to be invoked by an operator, not at boot).
3. Enumerated every route actually registered in production, multiline-aware —
   a line-based grep silently misses `app.post(\n "/redeem"`, which is exactly
   how this class of gap hides.
4. For each remaining candidate, asked the only question that matters: **is
   there any runtime path by which a user or operator can reach this capability?**

## Confirmed findings

Ordered by impact.

### 1. Idempotency is in-memory in production — HIGH

`PgIdempotencyStore` exists and is never constructed. `index.ts` passes no
`idempotencyStore`, so `buildApp` falls back to `InMemoryIdempotencyStore`.

Consequence: the Req 9.6 **24-hour** replay window is process-local and lost on
every restart. On zero-cost hosting the service spins down after ~15 idle
minutes, so the effective replay window is *minutes*, not a day. A client
retrying `POST /v1/redeem` with the same `Idempotency-Key` after a spin-down
would not be replayed — it would be treated as a new request.

The redemption engine's own `(customer, idempotency_key)` UNIQUE constraint still
prevents a double spend, so this is not a points-integrity bug. It is a broken
API contract: the endpoint promises replay semantics it does not deliver, and any
future non-redemption state-changing endpoint would have no protection at all.

*Requirements affected: 9.6, 9.7.*

### 2. VIP benefits / entitlements are entirely unreachable — HIGH

No route exposes benefits, and `DbEntitlementResolver` is never constructed.
`GET /v1/balance` and `GET /v1/profile` return no benefits field — verified in the
staging responses captured earlier.

So Req 18 is unmet end to end: entitlements are never resolved, never included in
returned account data (18.2), and a qualifying member has no way to invoke a
benefit, so no `benefit_requests` row can ever be created (18.5). The `benefits`
table is seeded by migration and read by nothing.

Tasks 15.1 and 15.2 are both marked complete on the strength of the module and
its tests.

*Requirements affected: 18.2, 18.3, 18.5, 18.6, 7.8.*

### 3. Profile preferences are read-only — no way to write them — HIGH

`GET /v1/profile` returns `favourites`, `wishlist`, `recentlyViewed` and
`suggestions`, but there is **no endpoint to write any of them**. `setFavourite`,
`listFavourites`, `reconcileWishlist`, `RecentlyViewedStore` and
`RulesBasedSuggestionEngine` are all unreferenced, and `index.ts` constructs no
preference store.

So those arrays can only ever be empty, which matches what staging returned. Req
17.5 explicitly requires a rate-limited/sampled endpoint for recording views;
it does not exist. Req 17.4's wishlist union-reconciliation on authentication has
no trigger.

*Requirements affected: 17.2, 17.4, 17.5, 17.6.*

### 4. Market/rule-set configuration is dormant — MEDIUM

`DbMarketConfigProvider` and `StaticMarketConfigProvider` are never constructed.
The `markets`, `earning_rule_sets` and `reward_rule_sets` tables are seeded by
migration and read by nothing; the engine continues to use its hardcoded tier
thresholds, multipliers and reward map.

Behaviour today is correct — the seeded config matches the constants — so this is
latent rather than broken. But Req 21.2's intent was that the engine *reads*
config, so changing a threshold currently requires a code change and deploy, and
the per-market extension path is not actually exercised.

*Requirements affected: 21.2, 21.3, 21.6.*

### 5. Notification targeting is unreachable — LOW

`resolveNotificationTargets` is never called and nothing writes
`notification_events`. Device tokens can be registered via `POST /v1/devices`,
but no code path targets them. Expected while there is no push provider, and Req
19.2 asks only that events be *modelled* so they can target tokens — worth
recording so it is a known gap rather than an assumption.

*Requirements affected: 19.2.*

### 6. Backup verification helpers unused — LOW (already tracked)

`verifyBackupConfiguration` / `evaluateBackupStatus` are never called, consistent
with Req 13.6 being unmet on free-tier hosting. Already tracked as task 29; noted
here only for completeness.

## Not findings

For the record, these were flagged by the mechanical sweep and are correct as-is:

- **Operator entry points** — `runM0Export`, `runM1Backfill`, `runMetafieldRollback`, `registerAllWebhookTopics`. Deliberately invoked by an operator at deploy/cutover time, never at boot. Task 26 will exercise them.
- **In-memory doubles** — `InMemory*` classes and `Recording*` providers exist as documented fallbacks and test seams.
- **Internal helpers and error classes** — used within their own module or thrown/caught across the boundary.
- **`dispatchWebhookJob`** — now called via `dispatchWithOutcome` in the same file.

## Pattern

Four occurrences of the same failure mode, counting the ones already fixed:

| # | Capability | Found by |
|---|---|---|
| 1 | Fraud review, customer ledger, admin operations not Pg-wired | Staging validation (finding 4) |
| 2 | Analytics refresh registered but orphaned after redesign | Task 24 audit |
| 3 | Referral engine, no production call site | Task 25 |
| 4 | Idempotency store, benefits, profile writes, market config | This audit |

The common cause is that a task was marked complete once its module existed with
passing unit tests, with no check that anything reached it at runtime. Unit tests
inject their own fakes, so they pass identically whether or not boot wires the
real implementation — which is precisely why this class of gap survived a 1000+
test suite.

**Suggested guard going forward:** a task is only complete when a runtime path
reaches the new code — an endpoint, a webhook handler, a scheduled job or an
operator script — and that path has been exercised at least once against staging.
For the boot wiring specifically, a cheap regression is possible: assert that
`buildApp` receives the Pg-backed implementations in production configuration,
so an unwired dependency fails a test rather than silently degrading.

## Recommended handling

I would not fold these into task 28. Suggested split:

1. **Fix now, small and contained:** wire `PgIdempotencyStore` (finding 1). One line of boot wiring plus a test; it repairs a stated API contract and the fix is unambiguous.
2. **New task — VIP benefits surface** (finding 2): needs endpoint design, so it deserves its own scope.
3. **New task — profile preference writes** (finding 3): needs endpoints for favourites, wishlist and recently-viewed, including the rate-limited/sampled view endpoint of Req 17.5.
4. **New task — config-driven rules** (finding 4): decide whether to wire the provider or amend Req 21.2 to describe the constants as the MVP source of truth.
5. **Record findings 5 and 6** against the existing mobile-readiness and backup tasks rather than opening new ones.
6. **Then resume task 28**, which is unaffected: the expiry scan, pre-expiry sweep and ESP worker are all wired at boot and reachable.
