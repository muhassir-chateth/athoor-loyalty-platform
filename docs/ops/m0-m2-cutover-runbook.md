# M0–M2 migration / cutover runbook

Status: **rehearsed on staging, signed off with caveats** (task 26), then
**rerun end-to-end through the committed operator scripts and the real Admin
clients** (task 33 — see §3.5 and §4). The commands in §5 are the real ones.

This runbook covers the phased, data-safe cutover of the Athoor loyalty data from
the legacy `loyalty.*` customer metafields to the Loyalty_Service ledger, and the
rollback for each phase. It is written from an actual rehearsal, not from the
code comments — every "rehearsed" claim below has captured evidence.

Requirements exercised: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9,
10.7a.

Customers are referenced by Shopify customer id only. No email addresses appear
in this document.

---

## 1. Phases

| Phase | What it does | Touches Shopify? | Touches Postgres? |
|---|---|---|---|
| **M0** | Read-only export of every customer's `loyalty.*` metafields to a versioned JSON backup — the rollback anchor. Validates the legacy balance formula. | reads only | no |
| **M1** | Seeds the empty ledger from the M0 backup: one `migration` entry + one non-expiring lot per enrolled customer, tier recomputed. Reconciles. | no | writes |
| **M2** | Repoints the storefront dashboard's data source from the metafield cache to the App Proxy `/v1` endpoints. | theme only | no |
| **M3** | Cuts redemption over from the retained `mailto:` CTA to automated `/v1/redeem`. Out of scope for this runbook; its rollback is documented in §6.3. |  |  |

The store's own `loyalty.*` metafields are never deleted at any phase (Req 14.8).
The M0 export client and the rollback client both expose read/upsert methods
only — there is no delete path in the code.

---

## 2. Rehearsal environment and its differences from production

| | Production (real cutover) | Staging (this rehearsal) |
|---|---|---|
| Store | `myathoorlondon.myshopify.com` | `athoor-loyalty-staging.myshopify.com` |
| Customers | 39 | 9 |
| Enrolled | 8 | 7 |
| Legacy balance provenance | real, follows `50 + spend×1` | **synthetic** — seeded by the rehearsal |
| Paid orders | real order history | **none** (0 paid orders on staging) |
| Database for M1 | Supabase (live) | **isolated scratch Postgres in Docker on :55432** |
| Theme | Athoor theme present | **absent** — bare dev store behind a password page |

The live Supabase database was deliberately **not** used for the M1 rehearsal: M1
creates one `migration` entry and one lot per enrolled customer, which would
double-count balances already validated by tasks 25/28.

---

## 3. Rehearsal results, per phase

### 3.1 Phase M0 — export & snapshot

Driven through the real `runM0Export` (`src/migration/m0Export.ts`) with the real
`FileBackupWriter`, against staging, with `totalExpected: 9` /
`enrolledExpected: 7`.

**Happy path — PASS.**

- `status: "exported"`, `mismatches: []`.
- `totalExported: 9`, `enrolledExported: 7` — a complete record for every
  expected customer, each carrying a non-empty id and gid, and every enrolled
  record carrying a parseable `points_balance` (Req 14.1).
- Backup written to `m0-metafield-export-2026-07-26T15-20-23-665Z.json`; parsed
  back off disk cleanly and was byte-identical to the in-memory result. Anchor
  header:

  ```json
  {
    "schemaVersion": "1.0",
    "kind": "m0-metafield-export",
    "exportedAt": "2026-07-26T15:20:23.665Z",
    "storeDomain": "athoor-loyalty-staging.myshopify.com",
    "totalExpected": 9,
    "enrolledExpected": 7,
    "totalExported": 9,
    "enrolledExported": 7,
    "customers": [ /* 9 records, each: id, gid, email, enrolled,
                      lifetimeSpendGBP, metafields[] verbatim, loyalty{} */ ]
  }
  ```

- Balance validation passed for all 7 enrolled customers:

  | Shopify customer id | lifetime spend (GBP) | exported balance | `50 + ⌊spend⌋` | match |
  |---|---|---|---|---|
  | 9034269556935 | 0.00 | 50 | 50 | ✅ |
  | 9036662472903 | 125.40 | 175 | 175 | ✅ |
  | 9036685050055 | 300.00 | 350 | 350 | ✅ |
  | 9036755566791 | 749.99 | 799 | 799 | ✅ |
  | 9037379403975 | 1500.00 | 1550 | 1550 | ✅ |
  | 9037455327431 | 42.75 | 92 | 92 | ✅ |
  | 9037455425735 | 899.99 | 949 | 949 | ✅ |

  Non-enrolled: 9034269589703, 9034269622471 (zero `loyalty.*` metafields, so
  `isEnrolled` is false and they are excluded from the formula check).

- **No metafield modified or deleted by the export.** The store was re-read after
  the run and compared key-by-key against the pre-export snapshot: identical.
  The injected client's runtime surface was asserted to be exactly
  `["listCustomersWithLoyaltyMetafields"]` — there is structurally no write or
  delete path (Req 14.8).

**Abort path: incomplete export — PASS (Req 14.2).** Re-run with
`totalExpected: 12` against the real population of 9:

- `status: "aborted_incomplete_export"`,
  `detail.reason: "Expected 12 customers but exported 9."`, `found: 9`,
  `expected: 12`.
- **No backup file was written at all** — the target directory was never even
  created. A partial snapshot can therefore never be mistaken for the anchor.
- Store state before and after the aborted run was identical: it aborts before
  any change.

**Halt path: balance mismatch — PASS (Req 14.3).** Customer 9037455425735 was
seeded with `points_balance = 1234` while its spend of £899.99 requires 949:

- `status: "halted_balance_mismatch"`.
- Exactly one mismatch reported, and it is the offending customer:
  `{ id: "9037455425735", actualBalance: 1234, expectedBalance: 949, lifetimeSpendGBP: 899.99 }`.
- **The backup was still written first** (`m0-metafield-export-2026-07-26T15-21-12-233Z.json`,
  `schemaVersion 1.0`, 9 exported / 7 enrolled) and it captured the offending
  value `1234` verbatim, so a restore from it is faithful to what the store
  actually held.

### 3.2 Phase M1 — ledger backfill & reconciliation

Driven through the real `runM1Backfill` (`src/migration/m1Backfill.ts`) with the
real `LedgerRepository` and a real `pg` transactor (`BEGIN`/`COMMIT`/`ROLLBACK`),
against an isolated `postgres:17-alpine` container on port 55432 with the full
migration set applied (`node-pg-migrate up`, all migrations up to
`create-backup-runs`). Input: the M0 backup produced above.

Starting state: `customers 0`, `ledger_entries 0`, `point_lots 0`.

**PASS.** `status: "backfilled"`, `processed: 7`, `created: 7`, `skipped: 0`,
`nonEnrolledDeferred: 2`, `mismatches: []`.

Per enrolled customer, verified by direct SQL against the scratch database:

| Shopify customer id | exported balance | `migration` entries | `SUM(ledger_entries.points)` | sum == balance (14.6) | lots | non-expiring lots | lot original/remaining | tier in DB | tier from spend (14.4) |
|---|---|---|---|---|---|---|---|---|---|
| 9034269556935 | 50 | 1 | 50 | ✅ | 1 | 1 | 50 / 50 | bronze | bronze ✅ |
| 9036662472903 | 175 | 1 | 175 | ✅ | 1 | 1 | 175 / 175 | bronze | bronze ✅ |
| 9036685050055 | 350 | 1 | 350 | ✅ | 1 | 1 | 350 / 350 | silver | silver ✅ |
| 9036755566791 | 799 | 1 | 799 | ✅ | 1 | 1 | 799 / 799 | silver | silver ✅ |
| 9037379403975 | 1550 | 1 | 1550 | ✅ | 1 | 1 | 1550 / 1550 | royal_vip | royal_vip ✅ |
| 9037455327431 | 92 | 1 | 92 | ✅ | 1 | 1 | 92 / 92 | bronze | bronze ✅ |
| 9037455425735 | 949 | 1 | 949 | ✅ | 1 | 1 | 949 / 949 | gold | gold ✅ |

Totals: 7 ledger entries (all `entry_type='migration'`), 7 point lots, **7 with
`expires_at IS NULL` and 0 with a non-null `expires_at`** (Req 14.4 — legacy
points never expire).

**Lazy enrolment — PASS (Req 14.5).** The 2 non-enrolled customers in the backup
(9034269589703, 9034269622471) have **0** rows in `customers`. Total
`customers` rows = 7 = the enrolled cohort size exactly. M1 materialised nobody
outside the enrolled cohort; the rest enrol on their first qualifying event.

**Idempotency — PASS (Req 14.4).** Re-running M1 unchanged returned
`status: "backfilled"`, `created: 0`, `skipped: 7`, and the table counts stayed
at 7 entries / 7 lots. No double-apply.

**Mid-way failure — PASS (Req 14.7).** After truncating the scratch tables, a
fault was injected at the 3rd `INSERT INTO point_lots` (i.e. two customers had
already been fully backfilled inside the transaction). The error propagated after
rollback, and the state afterwards was `customers 0`, `ledger_entries 0`,
`migration entries 0`, `point_lots 0` — **no partial `migration` entry or lot was
retained.**

Note on how this was injected: the failure was injected at the harness's own
`Transactor`/`Queryable` seam, which is the module's declared injection point.
No production code was modified. The same seam was used to force a
reconciliation mismatch.

**Reconciliation mismatch — PASS (Req 14.6).** A stray `adjust` entry of +7 was
injected for the first customer so its ledger sum became 57 against an exported
balance of 50:

- `status: "aborted_reconciliation_mismatch"`, mismatch reported as
  `{ shopifyCustomerId: 9034269556935, expectedBalance: 50, actualLedgerSum: 57 }`.
- State afterwards: `customers 0`, `ledger_entries 0`, `point_lots 0` — the whole
  cohort's backfill was rolled back, not just the offending customer.

**Clean re-run after both aborts — PASS.** `created: 7`, ending at 7 customers /
7 entries / 7 lots. The aborts left nothing that blocks a retry.

### 3.3 Phase M2 — dashboard data-source cutover

**NOT REHEARSABLE ON STAGING. Not attempted.**

Two independent blockers, both verified:

1. The staging Admin token has no `read_themes` scope. `GET /admin/api/2024-10/themes.json`
   returns `403 {"errors":"[API] This action requires merchant approval for read_themes scope."}`,
   so the staging theme cannot even be enumerated, let alone modified.
2. The staging storefront is not running the Athoor theme. `GET /`,
   `GET /pages/loyalty` and `GET /pages/rewards` all return the Shopify
   password/"opening soon" page (`<title>athoor-loyalty-staging</title>`), with
   zero occurrences of `loyalty-dashboard` or `data-loyalty-config` in the
   markup.

The production theme was **not** touched to work around this.

What the production M2 step is (to be executed, not yet rehearsed):

1. Confirm `theme/sections/loyalty-dashboard.liquid`,
   `theme/snippets/rewards-banner.liquid` and `theme/assets/athoor-loyalty.js`
   in this repository match the live theme before changing anything.
2. Push the theme so the dashboard renders the Metafield_Cache values
   server-side as the fallback, and `assets/athoor-loyalty.js` fetches
   `/apps/loyalty/v1/balance` and `/apps/loyalty/v1/history` through the App
   Proxy and overwrites the same markup via the `data-loyalty-*` hooks. If the
   API is slow or unavailable the already-rendered metafield values remain
   (Req 8.4), which is what makes M2 low-risk.
3. Verify on the live dashboard: balance, tier, history and rewards match the
   `/v1` values; no visual regression; the page still renders with JavaScript
   disabled.

Rollback for M2 is a theme revert — see §6.2.

### 3.4 Rollback — metafield restore

Driven through the real `runMetafieldRollback` (`src/migration/rollback.ts`)
against staging, using the M0 backup from §3.1 as the only source of truth.

**Service-running guard — PASS (Req 14.9).** With a controller that reports the
service still running after `stop()`, the result was
`status: "aborted_service_running"` and **zero Shopify calls were made** — the
store was byte-identical before and after. Rollback refuses to race the ledger.

**Restore — PASS (Req 14.9).** All 7 enrolled customers' `points_balance`,
`lifetime_points` and `tier` were first drifted to `111` / `222` / `royal_vip` to
simulate post-M1/M2 state. Then:

- `status: "rolled_back"`, `serviceStopped: true`, `customersRestored: 9`,
  `metafieldsRestored: 42`, `mismatches: []`, every customer `verified: true`.
- Every customer's `loyalty.*` metafields, read back from Shopify, were **exactly
  equal to their exported values.** Before/after by Shopify id:

  | Shopify customer id | drifted (before rollback) | after rollback | == exported |
  |---|---|---|---|
  | 9034269556935 | 111 / 222 / royal_vip | 50 / 50 / bronze | ✅ |
  | 9034269589703 | (no loyalty metafields) | (no loyalty metafields) | ✅ |
  | 9034269622471 | (no loyalty metafields) | (no loyalty metafields) | ✅ |
  | 9036662472903 | 111 / 222 / royal_vip | 175 / 175 / bronze | ✅ |
  | 9036685050055 | 111 / 222 / royal_vip | 350 / 350 / silver | ✅ |
  | 9036755566791 | 111 / 222 / royal_vip | 799 / 799 / silver | ✅ |
  | 9037379403975 | 111 / 222 / royal_vip | 1550 / 1550 / royal_vip | ✅ |
  | 9037455327431 | 111 / 222 / royal_vip | 92 / 92 / bronze | ✅ |
  | 9037455425735 | 111 / 222 / royal_vip | 949 / 949 / gold | ✅ |

  (columns are `points_balance` / `lifetime_points` / `tier`; the other three
  keys — `lifetime_spend_gbp`, `updated_at`, `tier_progress_gbp` — were also
  restored and verified.)

- **Idempotent.** A second rollback run reached the same end state and verified
  clean again.

**No metafield deleted at any point in the whole rehearsal.** Per-customer
`loyalty.*` key counts were identical before the rehearsal began and after it
finished (6 / 0 / 0 / 6 / 6 / 6 / 6 / 6 / 6 across the 9 customers in id order).
The rehearsal deliberately overwrote only keys that already existed, so nothing
had to be removed to put the store back.

One behavioural note, by design and not a defect: `verifyRestored` asserts only
the keys present in the export. If a later phase were to ADD a new `loyalty.*`
key, rollback would leave that key in place (it cannot delete it, Req 14.8) and
would not report it. M1/M2 do not add keys, so this does not arise in this
cutover.

### 3.5 Rerun through the real implementations (task 33)

§3.1–3.4 were driven by a rehearsal harness. The whole sequence was then **rerun
against staging using the committed scripts and the real clients** from §4 — no
harness, no fake Shopify client, no fake service controller.

**Target-store guard — PASS.** Four refusals, each exit code 2, each before any
network call:

| Attempt | Outcome |
|---|---|
| `--store myathoorlondon.myshopify.com`, no confirmation | banner `⚠ TARGET IS THE PRODUCTION STORE`, then refused |
| production store, confirmation mistyped (`…myshopify.co`) | refused, quoting the value received |
| staging store with a stale production confirmation flag | refused (confirmation must match the target) |
| `--admin-token shpua_…` passed as an argument | refused, told to use the environment |

Also refused: `--database-url` as an argument, and an M1 run whose backup
`storeDomain` did not match `--store`.

**M0 — PASS, all three statuses reproduced through the real client.** Staging is
**USD with zero orders of any kind** (`shop.currencyCode = USD`, `orders(first:10)`
returns `[]`).

- Real derived lifetime spend: **£0.00 for all 9 customers.** Not rounded down,
  not approximated — there are no orders to derive anything from, so the number
  is zero and the derivation from real paid orders remains untested (§8.3).
- Runs with `--expected-currency GBP` and `--expected-currency USD` produced
  **byte-identical output**. The currency guard is per-order, and with zero
  orders no money field is ever read, so it cannot fire on this store. It is
  covered by unit tests instead (guard firing on the winning field, on a
  non-winning field, and on tier-3 line items), not by live evidence.
- `status: "halted_balance_mismatch"` (exit 3) on the store as found: the two
  enrolled balances that were not `50 + ⌊0⌋` were reported and only those two —
  `{9034269556935: 51 vs 50}` and `{9037455425735: 500 vs 50}`. The backup was
  still written first and captured `51`/`500` verbatim.
- `status: "aborted_incomplete_export"` (exit 3) with `--total-expected 12`
  against the real population of 9. **The backup directory was never created** —
  a partial snapshot cannot be mistaken for the anchor.
- `status: "exported"` (exit 0) after the two off-formula balances were set to
  `50` through the real restore client: `totalExported: 9`,
  `enrolledExported: 7`, `mismatches: []`.

**M1 — PASS** against an isolated `postgres:17-alpine` container on port 55432
with the full migration set applied, seeded from that real M0 backup:
`status: "backfilled"`, `processed: 7`, `created: 7`, `skipped: 0`,
`nonEnrolledDeferred: 2`, `mismatches: []`. Verified by SQL: 7 `customers`,
7 `ledger_entries` (all `migration`), 7 `point_lots`, **7 with
`expires_at IS NULL` and 0 expiring**, and per customer `ledger_sum = 50` with
`lot_original = lot_remaining = 50`. Re-run unchanged: `created: 0, skipped: 7`.
The live Supabase database was again not used.

**Rollback — PASS, including a genuine live service check.**

- With `--service-url https://athoor-loyalty-platform.onrender.com` (the deployed
  service, which was up): probe 1 answered `HTTP 200` →
  `status: "aborted_service_running"`, exit 3, **zero Shopify calls**. This is a
  real check against the live deployment, not a simulated one.
- The restore itself was then exercised by pointing `--service-url` at a genuinely
  dead endpoint (`http://127.0.0.1:59999`, nothing listening): three consecutive
  probes failed ~2s apart with a real connection failure, the controller concluded
  "stopped", and the restore ran: `status: "rolled_back"`, `serviceStopped: true`,
  `customersRestored: 9`, `metafieldsRestored: 42`, `skippedNullValued: 0`,
  `mismatches: []`, every customer `verified: true`. A second run reached the same
  end state and verified clean (idempotent).
  **What this does and does not prove:** it proves the restore, the read-back
  verification, and the consecutive-probe logic against a real socket. It does
  **not** prove a Render suspend — see §8.7.
- **Every touched value was recorded before the change and restored afterwards.**
  The only staging writes in this rerun were `loyalty.points_balance` on two
  customers (`9034269556935`: `51 → 50 → 51`, `9037455425735`: `500 → 50 → 500`).
  A post-rollback re-read of all 9 customers compared key-by-key against the
  anchor backup: **every key equal, no diffs.** Per-customer `loyalty.*` key
  counts were 6 / 0 / 0 / 6 / 6 / 6 / 6 / 6 / 6 before and after — no key added,
  **no metafield deleted at any point.**

### 3.6 API refusal (Req 10.7a) — PASS

Against the deployed service `https://athoor-loyalty-platform.onrender.com`:

```
POST /v1/admin/operations/migration        (admin bearer, body {})
→ 501 {"error":"migration_not_enabled",
        "message":"Data migration is not enabled via the API — run the M0–M2 cutover as an operator script so the M0 export exists as the rollback anchor.",
        "apiVersion":"v1"}
```

Same 501 with no `Content-Type` at all. Controls: the request without a bearer
returns `401 authorization_required`, and `POST /v1/admin/operations/reconciliation`
is a distinct route that does not 501. Migration over HTTP is genuinely refused,
not merely unimplemented.

---

## 4. The operator entrypoint (committed, task 33)

The task-26 rehearsal drove the real exported functions but had to supply the
production boundaries itself. Those boundaries are now committed, so §5 is a set
of real commands rather than a sketch. What exists:

| Component | File | What it does |
|---|---|---|
| `MigrationShopifyClient` | `src/migration/migrationShopifyClient.ts` | `ShopifyGraphqlMigrationClient` — paginates `customers`, captures every `loyalty` namespace metafield verbatim, and derives lifetime spend from the customer's orders. **Queries only**: no mutation, no write, no delete method (Req 14.8 structurally). A test asserts its runtime method surface is exactly `["listCustomersWithLoyaltyMetafields"]`. |
| `MetafieldRestoreClient` | `src/migration/metafieldRestoreClient.ts` | `ShopifyGraphqlMetafieldRestoreClient` — upsert via `metafieldsSet` (verbatim namespace/key/type/value, batched at 25) plus a paginated read-back for verification. **No delete method exists**; a test asserts the surface is exactly those two names. |
| `ServiceController` | `src/migration/serviceController.ts` | `OperatorSuspendedServiceController` — see the warning below. |
| Shared read-only support | `src/migration/shopifyMigrationSupport.ts` | Throttle-retry (reusing the existing `backoffDelayMs` / `DEFAULT_BACKOFF` policy: 1s, doubling, 60s cap, 10 attempts) and the one paginated verbatim metafield read both clients share. |
| Operator scripts | `scripts/migration/m0-export.mjs`, `m1-backfill.mjs`, `metafield-rollback.mjs` | The commands in §5. npm aliases: `cutover:m0`, `cutover:m1`, `cutover:rollback`. |

Properties of the scripts that matter operationally:

- They import the **compiled** service from `dist/`, so `npm run build` must run
  first.
- **Target-store guard.** `--store` is mandatory and never defaulted. If it is
  `myathoorlondon.myshopify.com`, the run also requires
  `--confirm-production-store=myathoorlondon.myshopify.com` (exact match). A
  missing, mistyped, or stale-and-mismatched confirmation refuses the run with
  exit code 2 before any network call. M1 and rollback additionally refuse when
  the backup file's `storeDomain` differs from `--store`, so one store's export
  can never be applied to another store.
- **Secrets from the environment only.** `SHOPIFY_ADMIN_API_TOKEN` and
  `DATABASE_URL` are read from the environment; passing them as arguments is
  refused with an explanatory error, so they never reach shell history or a `ps`
  listing.
- **A halt can never look like a success.** Exit 0 only for `exported` /
  `backfilled` / `rolled_back`; 3 for any abort/halt status; 2 for a usage or
  guard failure; 4 for an unexpected throw.
- **No emails, no tokens in output.** Customers are printed by Shopify id;
  everything printed passes through a redactor that strips `email` fields and
  masks token- and email-shaped strings.
- **Still no HTTP route.** `POST /v1/admin/operations/migration` returns 501
  (Req 10.7a), and a committed test asserts that neither `index.ts` nor `app.ts`
  imports any module under `src/migration/`, so the cutover cannot drift into
  boot wiring.

⚠️ **Two things still need a decision before the production run.**

1. **The order-inclusion policy determines real customers' tiers and needs the
   owner's sign-off.** Lifetime spend counts orders whose
   `displayFinancialStatus` is `PAID`, `PARTIALLY_REFUNDED` or `REFUNDED`
   ("was paid at some point" — a refund claws back points but does not reduce
   lifetime spend, Req 4.7), excluding cancelled orders and Shopify test orders.
   All of it is overridable (`--accepted-financial-statuses`,
   `--include-cancelled-orders`, `--include-test-orders`) without code changes.
2. **`read_all_orders` is required in production.** Shopify limits apps to the
   last 60 days of orders unless that scope is granted. Without it the derived
   lifetime spend is silently too low and tiers are placed too low with it.

⚠️ **`stop()` does not stop the service, by design.**
`OperatorSuspendedServiceController.stop()` records that suspension is a MANUAL
Render action and returns — there is no committed automation that could suspend a
Render Free service. What it *does* provide is verification:
`isRunning()` probes `GET /health` and reports the service as running until
**three consecutive probes fail, ~2s apart** (both configurable; any single
answer, including a 5xx, means "still running"). So rollback **fails closed** —
it keeps returning `aborted_service_running` without touching a metafield until
the operator has genuinely suspended the service. That is the intended
behaviour, and it turns "it's stopped" from an assertion into a checked fact.

---

## 5. Production cutover procedure

Prerequisite: the scripts from §4 are reviewed, `npm run build` has run on the
cutover commit, and the two open decisions in §4 (order-inclusion policy,
`read_all_orders`) are settled.

Environment for every command below. Note that secrets are exported into the
environment and **never passed as arguments** — the scripts refuse them as
arguments:

```bash
cd loyalty-service
export SHOPIFY_STORE_DOMAIN="myathoorlondon.myshopify.com"
export SHOPIFY_ADMIN_API_TOKEN="<production admin token: read_customers, read_orders, read_all_orders, write_metafields>"
export DATABASE_URL="<production Postgres URL, ?sslmode=require>"
export LOYALTY_SERVICE_URL="https://athoor-loyalty-platform.onrender.com"
export M0_BACKUP_DIR="$HOME/athoor-cutover/$(date -u +%Y%m%dT%H%M%SZ)"
npm ci && npm run build
```

Every command targeting production must carry
`--confirm-production-store=myathoorlondon.myshopify.com`, or it refuses to run.

### Phase M0

```bash
node scripts/migration/m0-export.mjs \
  --store "$SHOPIFY_STORE_DOMAIN" \
  --confirm-production-store=myathoorlondon.myshopify.com \
  --backup-dir "$M0_BACKUP_DIR" \
  --total-expected 39 \
  --enrolled-expected 8 \
  --expected-currency GBP
```

Additional halt condition specific to the real client: if any order reports a
`shopMoney.currencyCode` other than `GBP`, M0 stops with the currency-guard error
(exit 3) naming the customer id, the order and both currencies, and **writes
nothing**. Do not "fix" this by passing `--expected-currency <other>` unless that
currency genuinely is the store's base currency — summing a second currency as
GBP would misplace every tier.

Halt conditions — **stop and do not continue** if:

- `status: "aborted_incomplete_export"` → fewer (or more) than 39 complete
  records. No backup was written. Reconcile the customer count against the
  Shopify admin, then re-run. Nothing has changed; there is nothing to undo.
- `status: "halted_balance_mismatch"` → at least one of the 8 enrolled balances
  is not `50 + ⌊spend⌋`. A backup **was** written and is the anchor. Review each
  reported customer by Shopify id with the business owner and decide per customer
  whether to correct the metafield or to accept the stored value, then re-run
  M0. Do not hand a halted export to M1.

Check before continuing:

- `status: "exported"`, `mismatches: []`.
- `totalExported == 39`, `enrolledExported == 8`.
- The backup file exists, parses as JSON, has `schemaVersion "1.0"` and
  `kind "m0-metafield-export"`, and its `storeDomain` is the production store.
- **Copy the backup file off the operator machine** before starting M1. Every
  later rollback depends on this one file.

### Phase M1

```bash
# DATABASE_URL is read from the environment. Passing --database-url is refused.
node scripts/migration/m1-backfill.mjs \
  --backup "$M0_BACKUP_DIR/<m0-metafield-export-….json>" \
  --store "$SHOPIFY_STORE_DOMAIN" \
  --confirm-production-store=myathoorlondon.myshopify.com
# add --db-ssl-no-verify if the pooler's certificate chain is not locally verifiable
```

`--store` is required even though M1 writes no Shopify data: the script asserts
the backup's `storeDomain` matches it, which is what stops a staging export being
backfilled into the production ledger.

Halt conditions — **stop** if:

- `status: "aborted_reconciliation_mismatch"` → at least one customer's
  `SUM(ledger_entries.points)` did not equal their exported balance. The whole
  transaction rolled back; the ledger is unchanged. Investigate the reported
  customers before retrying.
- `status: "aborted_backfill_error"` → an enrolled record could not be
  backfilled (non-integer / non-positive balance, unusable Shopify id). Rolled
  back; nothing retained.
- Any unexpected throw → the transaction rolled back first. Verify with the
  queries below that the ledger is empty, then investigate.

Check before continuing:

```sql
-- expect 8 / 8 / 8 / 8 / 0
SELECT count(*) FROM customers;
SELECT count(*) FROM ledger_entries WHERE entry_type = 'migration';
SELECT count(*) FROM point_lots;
SELECT count(*) FROM point_lots WHERE expires_at IS NULL;
SELECT count(*) FROM point_lots WHERE expires_at IS NOT NULL;

-- expect exactly one row per enrolled customer, migration_entries = 1
SELECT c.shopify_customer_id, c.tier, c.lifetime_spend_gbp,
       count(*) FILTER (WHERE l.entry_type = 'migration') AS migration_entries,
       coalesce(sum(l.points), 0) AS ledger_sum
FROM customers c LEFT JOIN ledger_entries l ON l.customer_id = c.id
GROUP BY c.id, c.shopify_customer_id, c.tier, c.lifetime_spend_gbp
ORDER BY c.shopify_customer_id;
```

Then compare `ledger_sum` against each customer's exported `points_balance` in
the M0 backup, customer by customer. Confirm no `customers` row exists for any of
the 31 non-enrolled ids (they enrol lazily).

The script is idempotent: a second run reports `created: 0`, `skipped: 8`.

### Phase M2

Theme change, applied through the normal version-control + theme-push workflow —
never from this service.

1. `git` diff the live theme against `theme/` and resolve any drift first.
2. Push `theme/sections/loyalty-dashboard.liquid`,
   `theme/snippets/rewards-banner.liquid`, `theme/assets/athoor-loyalty.js`,
   `theme/assets/athoor-loyalty.css`.
3. Verify on the live dashboard, logged in as a known enrolled customer:
   balance / tier / history / rewards match `/v1`; no visual regression;
   the page still renders with JavaScript disabled (metafield fallback).

Halt condition: any visible regression, or the dashboard rendering blank when the
API is unreachable. Roll back the theme (§6.2) — the ledger stays.

---

## 6. Rollback procedure

### 6.1 M0

Nothing to roll back. M0 is read-only. If it aborted, no backup was written; if
it halted, discard the backup file or keep it for review.

### 6.2 M1 / M2 — metafield restore

Order matters.

1. **Stop the Loyalty_Service.** Suspend the Render service (Render dashboard →
   the service → Suspend), or scale it to zero. This is a MANUAL step: the
   committed `OperatorSuspendedServiceController` cannot suspend a Render Free
   service and does not pretend to — `stop()` only records that fact. You do not
   need to confirm `/health` by hand, though: the rollback script probes it three
   times ~2s apart and refuses to restore anything while it answers, returning
   `aborted_service_running` and exit 3. If the service cannot be stopped, the
   rollback simply cannot proceed — which is the intended fail-closed behaviour,
   because a restore racing the metafield-cache writer would undo itself.
2. Revert the theme if M2 had been applied: `git revert` the theme commit and
   push the theme, so the dashboard reads the Metafield_Cache values again.
3. Restore the metafields from the M0 backup:

   ```bash
   node scripts/migration/metafield-rollback.mjs \
     --backup "$M0_BACKUP_DIR/<m0-metafield-export-….json>" \
     --store "$SHOPIFY_STORE_DOMAIN" \
     --confirm-production-store=myathoorlondon.myshopify.com \
     --service-url "$LOYALTY_SERVICE_URL"
   ```

   Expect `status: "rolled_back"`, `customersRestored: 39`, `mismatches: []`, and
   `skippedNullValued: 0`. On `verification_failed`, the values were still written
   (nothing was deleted); inspect the reported namespace/key pairs and re-run —
   the operation is idempotent. On `aborted_service_running`, the health probe
   still answered: the service is not suspended and **nothing was written**.

   If the report lists `skippedNullValued > 0`, those metafields had a `null`
   value in the backup. `metafieldsSet` cannot write a null, and writing `""`
   instead would restore a *different* value than the store held, so the client
   skips and reports them rather than corrupting the restore. Set those keys by
   hand from the backup file if they matter.
4. Verify: for every customer id in the backup, the `loyalty.*` metafields read
   back from Shopify equal the exported values. The script asserts this itself
   and reports per-customer `verified`.
5. Decide on the ledger. The metafield restore does not touch Postgres. To retry
   the cutover later, keep the ledger and re-run M1 (idempotent). To abandon it,
   restore the pre-migration database backup from §7.

### 6.3 M3 — redemption CTA

The `mailto:` redemption CTA was deliberately retained in version control and is
present today at `theme/sections/loyalty-dashboard.liquid` (four `reward-btn`
links, 100/250/500/1000 points, all tracked by git — verified). The revert is
therefore a configuration flip, not a re-addition of deleted markup:

1. Set `"redemptionMode": "mailto"` in the `data-loyalty-config` JSON block in
   `theme/sections/loyalty-dashboard.liquid`.
2. Push the theme through the normal version-control workflow.
3. Confirm the `reward-btn` links resolve to the `mailto:` URLs and the
   `/v1/redeem` enhancement no longer activates.
4. Keep the ledger — M3 rollback reverts only the storefront CTA.

`writeThemeCtaRollbackArtifact` generates this as a machine-readable artifact and
was exercised in the rehearsal; it documents the steps, it does not push
anything.

---

## 7. Pre-flight checklist for the real cutover

- [ ] **Take a database backup first.** Run the `Daily encrypted database backup`
      workflow manually (Actions → *Daily encrypted database backup* →
      *Run workflow*; `.github/workflows/backup.yml` supports `workflow_dispatch`
      for exactly this). Confirm the run is green, note the artifact name and
      `sha256` from the log, and confirm a new `backup_runs` row exists.
- [ ] Confirm you hold the `age` **private** key needed to decrypt that backup.
      A backup you cannot read is not a backup.
- [ ] The operator scripts and Admin clients from §4 are reviewed on the cutover
      commit, and the store guard has been dry-run once against the production
      domain WITHOUT the confirmation flag to see it refuse (exit 2).
- [ ] The order-inclusion policy (§4) is signed off by the business owner — it
      decides real customers' tiers.
- [ ] `npm ci && npm run build && npx vitest run` clean on the cutover commit.
      `npm run build` is mandatory: the scripts import from `dist/`.
- [ ] Production Admin token has `read_customers`, `read_orders`,
      **`read_all_orders`** and `write_metafields`; confirm scopes before M0
      rather than mid-run. Without `read_all_orders`, orders older than 60 days
      are invisible and lifetime spend comes out too low.
- [ ] Confirm the production store's base currency is GBP (the export aborts on
      any other currency, by design).
- [ ] Confirm the production customer count is still 39 and the enrolled count 8,
      or update `--total-expected` / `--enrolled-expected` deliberately. A
      mismatch aborts M0 by design.
- [ ] Postgres is reachable and the full migration set is applied
      (`npx node-pg-migrate up`) with the ledger tables **empty**.
- [ ] Backup directory is outside the repository and is copied off-machine as
      soon as M0 succeeds.
- [ ] Know how to suspend the Render service, and have the dashboard open.
- [ ] Pause or drain the webhook queue if the cutover window overlaps trading, so
      earning events do not interleave with the backfill.
- [ ] Agree the halt/abort decision owner in advance — every halt in this runbook
      requires a business decision, not a retry.

---

## 8. What is still unproven after the task-33 rerun

Read this before treating the cutover as de-risked. This list is stated as of the
rerun through the real implementations (§3.5), which closed the "no committed
operator entrypoint" gap but changed little else about what is *evidenced*.

1. **THE BIGGEST ONE: lifetime spend has never been derived from a real order.**
   Staging has **zero orders of any status**, so the real client returned
   **£0.00 for all 9 customers** — a genuine run, but one that exercised the
   customer/metafield paths and *no* money path. Untested against live data:
   the precedence chain (`currentSubtotalPriceSet` → `subtotalPriceSet` →
   `max(0, Σ lineItems.originalTotalSet − discounts)`), the accepted-status
   policy, cancelled/test exclusion, the pence arithmetic across many orders, and
   `read_all_orders` behaviour for orders older than 60 days. All of it is covered
   by unit tests with a scripted fake Shopify, and the derivation mirrors
   `deriveEligibleTotal` in `earning/order.ts` field-for-field — but a unit test
   agreeing with itself is not evidence about production data. **This remains the
   part most likely to be wrong in production, and it feeds tier placement
   directly.** Mitigation before cutover: run M0 against production with
   `--total-expected`/`--enrolled-expected` set correctly and review the derived
   spend per customer against Shopify's own reporting BEFORE running M1.
2. **The currency guard has never fired against a live store.** Staging is USD,
   which should trigger it — but the guard is per-order, and with zero orders no
   money field is read, so GBP and USD runs were byte-identical (§3.5). Only unit
   tests prove it fires.
3. **The staging population is synthetic and much smaller.** 9 customers / 7
   enrolled against production's 39 / 8. Customer pagination past one page,
   metafield pagination past one page, order pagination, and Admin API rate
   limiting at production scale were **not** exercised live — every paginating
   loop and the throttle-retry path are covered by unit tests only. 39 customers
   is a single page, so the pagination risk is small; the throttle risk grows with
   the number of orders per customer.
4. **The legacy balances are still not inherited legacy data.** Staging's
   `loyalty.*` values were written by our own metafield cache writer in earlier
   tasks, so the `50 + spend×1` check that passed was arithmetic against values we
   had put there (this rerun set two of them to `50` to obtain a clean
   `exported`, then restored them). The production run is the first time the
   formula meets real legacy provenance.
5. **Phase M2 was not rehearsed at all** (§3.3), and no code changed that. No
   evidence exists that the dashboard cutover behaves as designed on a real
   storefront; the staging store has no Athoor theme and the token lacks
   `read_themes`.
6. **The `mailto:` CTA rollback was verified only in version control**, not by
   rendering a page.
7. **The Render suspend itself is still not proven, and cannot be automated.**
   `OperatorSuspendedServiceController.stop()` deliberately stops nothing. What
   the rerun DID prove live: with the deployed service up, the probe answered
   HTTP 200 and rollback aborted without touching a metafield; and against a
   genuinely dead endpoint, three consecutive real connection failures ~2s apart
   were required before the restore was allowed to run. What it did not prove: a
   real Render suspend, and therefore that `/health` goes quiet when an operator
   suspends the service. Do that step manually and watch the probe output.
8. **Null-valued metafields have never been round-tripped.** The restore client
   skips and reports a `null` backup value rather than writing `""` — every
   staging run reported `skippedNullValued: 0`, so that branch is unit-tested
   only.
9. **Only three legacy metafield keys have ever been exercised through a real
   store.** `points_expiry_date`, `referral_code`, `referral_count` and
   `activity_log` were not seeded, because adding a key that did not previously
   exist could not be undone without deleting it (Req 14.8 forbids that). Export
   and restore are generic over the namespace and unit-tested across these types
   (`json`, empty string, `null`), but not round-tripped live.
10. **M1 has still never run against production Postgres.** The scratch container
    used the identical migration set, but Supabase's pooler, SSL, and statement
    timeouts were not exercised. The `--db-ssl-no-verify` flag exists for that
    case and has not been used against Supabase.
11. **M1's abort paths were not re-exercised in this rerun.** The mid-way failure
    and reconciliation-mismatch paths were proven in §3.2 via the module's own
    injection seams; the rerun only covered the happy path and idempotency,
    because the committed script has no fault-injection hook (deliberately).
12. **A genuine infrastructure failure was never induced** — no connection drop
    mid-transaction, no Shopify 5xx mid-export, no real 429. Hard-failure and
    throttle handling are unit-tested against a fake `fetch`.
13. **No concurrency was tested.** Both rehearsals ran with no live traffic; a
    cutover overlapping real webhook processing is untested. Hence the
    pause-the-queue item in §7.
