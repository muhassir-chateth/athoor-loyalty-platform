# M0–M2 migration / cutover runbook

Status: **rehearsed on staging, signed off with caveats** (task 26).

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

### 3.5 API refusal (Req 10.7a) — PASS

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

## 4. Blocking gap: there is no committed operator entrypoint

The rehearsal drove the real exported functions, but it had to supply three
things that **do not exist in the repository**:

1. A concrete `MigrationShopifyClient` — an Admin GraphQL adapter that lists all
   customers with their `loyalty.*` metafields and their lifetime spend derived
   from paid orders. Only the interface and test fakes exist.
2. A concrete `MetafieldRestoreClient` for rollback (upsert + read-back via
   `metafieldsSet` / customer metafield query). Only the interface and test fakes
   exist.
3. An operator entrypoint script. There is nothing under `loyalty-service/scripts/`
   for M0/M1/rollback, no npm script, and — correctly — no HTTP route.

There is also no production `ServiceController`; stopping the service before a
rollback is a manual Render action today.

**These must be committed before the production cutover runs.** Until then the
"exact operator commands" in §5 are the shape of the commands, with the script
bodies still to be written from the rehearsal harness. Do not improvise them at
cutover time.

---

## 5. Production cutover procedure

Prerequisite: the scripts from §4 exist, are reviewed, and are pinned to the
production store domain with an explicit guard.

Environment for every command below:

```bash
cd loyalty-service
export SHOPIFY_STORE_DOMAIN="myathoorlondon.myshopify.com"
export SHOPIFY_ADMIN_TOKEN="<production admin token, read_customers + write_metafields>"
export DATABASE_URL="<production Postgres URL, ?sslmode=require>"
export M0_BACKUP_DIR="$HOME/athoor-cutover/$(date -u +%Y%m%dT%H%M%SZ)"
npm ci && npm run build
```

### Phase M0

```bash
node scripts/migration/m0-export.mjs \
  --store "$SHOPIFY_STORE_DOMAIN" \
  --backup-dir "$M0_BACKUP_DIR" \
  --total-expected 39 \
  --enrolled-expected 8
```

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
node scripts/migration/m1-backfill.mjs \
  --backup "$M0_BACKUP_DIR/<m0-metafield-export-….json>" \
  --database-url "$DATABASE_URL"
```

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
   the service → Suspend), or scale it to zero. This is currently a manual step;
   the code's `ServiceController` seam has no production implementation. Confirm
   `GET /health` no longer answers before proceeding. If the service cannot be
   stopped, **do not proceed** — the restore would race the metafield cache
   writer. The rollback code enforces this and returns
   `aborted_service_running` without touching a single metafield.
2. Revert the theme if M2 had been applied: `git revert` the theme commit and
   push the theme, so the dashboard reads the Metafield_Cache values again.
3. Restore the metafields from the M0 backup:

   ```bash
   node scripts/migration/metafield-rollback.mjs \
     --backup "$M0_BACKUP_DIR/<m0-metafield-export-….json>" \
     --store "$SHOPIFY_STORE_DOMAIN"
   ```

   Expect `status: "rolled_back"`, `customersRestored: 39`, `mismatches: []`. On
   `verification_failed`, the values were still written (nothing was deleted);
   inspect the reported namespace/key pairs and re-run — the operation is
   idempotent.
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
- [ ] The operator scripts and Admin clients from §4 exist, are reviewed, and
      guard against pointing at the wrong store.
- [ ] `npm ci && npm run build && npx vitest run` clean on the cutover commit.
- [ ] Production Admin token has `read_customers`, `read_orders` and
      `write_metafields`; confirm scopes before M0 rather than mid-run.
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

## 8. What this rehearsal did NOT prove

Read this before treating the cutover as de-risked.

1. **The staging population is synthetic and much smaller.** 9 customers / 7
   enrolled against production's 39 / 8. Nothing about pagination, Admin API rate
   limiting, or runtime at production scale was exercised — though 39 customers
   is a single page, so this is a small risk.
2. **The legacy balances were seeded by this rehearsal, not inherited.** Staging
   had no legacy loyalty data; its `loyalty.*` metafields were written by our own
   metafield cache writer, so they had the wrong provenance to test the
   `50 + spend×1` formula. The rehearsal overwrote `points_balance`,
   `lifetime_points`, `tier` and `lifetime_spend_gbp` on the 7 enrolled staging
   customers with values chosen to satisfy the formula, then restored them.
3. **The spend side of the formula is synthetic.** Staging has **zero paid
   orders**, so the store's own `amountSpent` is £0.00 for all 9 customers. The
   lifetime spend used for validation came from a declared fixture table in the
   rehearsal harness, in the place where the production client will compute it
   from paid orders. The check that ran was therefore "the balance stored in
   Shopify equals `50 + ⌊fixture spend⌋`" — a genuine store round-trip and a
   genuine arithmetic check, but **the derivation of lifetime spend from real
   paid orders is entirely untested.** That derivation is the part most likely to
   be wrong in production, and it does not exist as code yet (§4).
4. **Phase M2 was not rehearsed at all** (§3.3). No evidence exists that the
   dashboard cutover behaves as designed on a real storefront.
5. **The `mailto:` CTA rollback was verified only in version control**, not by
   rendering a page. The retained links and the git tracking were confirmed; the
   config flip to `redemptionMode: "mailto"` was never applied to a live theme.
6. **Only three legacy metafield keys were exercised.** `points_expiry_date`,
   `referral_code`, `referral_count` and `activity_log` were not seeded, because
   introducing a metafield key that did not previously exist on staging could not
   be undone without deleting it, which Req 14.8 forbids. The export and restore
   are generic over keys within the namespace, and unit tests cover these keys,
   but they were not round-tripped through a real store here.
7. **Stopping the service before rollback was simulated.** The
   `ServiceController` seam was exercised with a rehearsal controller (both the
   stops-cleanly and refuses-to-stop paths). The real Render suspend was not
   performed, and no production implementation of that seam exists.
8. **M1 ran against a scratch database, not production Postgres.** Schema was
   identical (the same migration set), but connection behaviour under Supabase's
   pooler, SSL, and statement timeouts was not exercised.
9. **Failure injection used the module's own injection seams.** Realistic, and no
   production code was modified, but a genuine infrastructure failure
   (connection drop mid-transaction, Shopify 5xx mid-export) was not induced.
10. **No concurrency was tested.** The rehearsal ran with no live traffic. A
    cutover overlapping real webhook processing is untested; hence the
    pause-the-queue item in §7.
