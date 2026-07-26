# Backup and recovery runbook

Task 29, Option B. How the loyalty database is protected on zero-cost hosting,
what that protection does and does not cover, and exactly how to restore.

## What is protected, and what is not

Supabase's free tier provides **no automated backups, no point-in-time recovery
and no WAL retention**. Nothing about this document changes that; it describes the
mechanism we added on top of it.

| | Status |
|---|---|
| Provider automated backups | **None** (free tier) |
| Point-in-time recovery | **None** (free tier) |
| WAL retention | **None** (free tier) |
| Daily encrypted logical dump | `.github/workflows/backup.yml`, 03:15 UTC |
| Artifact retention | 14 days (GitHub artifact), plus R2 if configured |
| Recovery point objective (RPO) | **~24 hours** — worst case, everything since the last dump is lost |
| Recovery time objective (RTO) | **Manual**, roughly 30–60 minutes for an operator who has the private key to hand |

What this buys: recovery from database loss, a bad migration, an accidental mass
delete, or a corrupted table — back to the state of the most recent nightly dump.

What it does **not** buy: recovery to an arbitrary moment. A mistake made at 14:00
cannot be undone as of 13:59. It can only be undone as of last night's dump, and
everything after that dump is gone. If that is unacceptable for the business, the
answer is PITR, not a better dump schedule (see [Deviation from Req 13.6](#deviation-from-requirement-136)).

The dump contains **customer PII** — `customers.email` is a CITEXT column — so it
is encrypted before it leaves the CI job, and is never committed to the
repository.

## One-time operator setup

Until these steps are done the workflow fails its first step with a clear error.
It deliberately refuses to write an unencrypted dump.

### 1. Generate the age keypair

On your own machine, not in CI:

```bash
brew install age          # or: apt install age
age-keygen -o loyalty-backup.key
```

The file contains both halves:

```
# created: 2025-03-10T12:00:00Z
# public key: age1qz...          <- the RECIPIENT, safe to publish
AGE-SECRET-KEY-1ABCD...          <- the PRIVATE key, protects all backups
```

### 2. Store the private key offline

The private key is the **only** thing that can read any backup. It must go
somewhere durable and out of band:

- **Do** store it in the company password manager (1Password / Bitwarden), as a
  secure note, with the creation date.
- **Do** keep a second copy somewhere independent — a sealed printed copy, or a
  second password manager. If this key is lost, every backup ever taken becomes
  permanently unreadable, including the ones taken before the loss.
- **Do not** put it in this repository, in `.env`, in a GitHub secret, in
  Supabase, or in any system whose compromise the backups are meant to survive.

That asymmetry is the point: CI holds only the public key, so it can **write**
backups it cannot **read**. Compromising the repository, the Actions runner, or
the artifact store yields encrypted blobs and nothing else.

### 3. Add the GitHub configuration

Repository → Settings → Secrets and variables → Actions.

| Type | Name | Value |
|---|---|---|
| Variable | `BACKUP_AGE_PUBLIC_KEY` | the `age1...` public key from step 1 |
| Secret | `BACKUP_DATABASE_URL` | the Postgres connection URL, including `?sslmode=require` |

Optional off-site copy to Cloudflare R2 — a different failure domain from both
Supabase and GitHub. All four must be present or the step skips with a notice, so
the workflow works before R2 exists:

| Type | Name |
|---|---|
| Secret | `R2_ACCOUNT_ID` |
| Secret | `R2_BUCKET` |
| Secret | `R2_ACCESS_KEY_ID` |
| Secret | `R2_SECRET_ACCESS_KEY` |

### 4. Verify

Run the workflow manually (Actions → *Daily encrypted database backup* → Run
workflow). A successful run logs the artifact name, its size and its SHA-256, and
inserts one row into `backup_runs`. `GET /health` should then report
`backups.stale: false`.

Then — and this is the step everyone skips — **do a restore rehearsal into a
scratch database** (below). An untested backup is a hypothesis.

## Restore procedure

Never restore into production first. Restore into a scratch database, validate,
then decide.

### 1. Fetch the artifact

From the Actions run summary, download the artifact (`loyalty-<timestamp>.sql.gz.age`),
or from R2:

```bash
aws s3 cp "s3://$R2_BUCKET/loyalty/loyalty-20250310T031500Z.sql.gz.age" . \
  --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
```

### 2. Verify the digest before spending time on it

Compare against the `sha256` recorded for that run:

```bash
sha256sum loyalty-20250310T031500Z.sql.gz.age

psql "$DATABASE_URL" -c \
  "SELECT completed_at, destination, size_bytes, sha256 FROM backup_runs ORDER BY completed_at DESC LIMIT 5;"
```

If the database is gone, the digest is also printed in the workflow run log.

### 3. Decrypt

```bash
age -d -i /path/to/loyalty-backup.key \
  -o loyalty-20250310T031500Z.sql.gz \
  loyalty-20250310T031500Z.sql.gz.age
```

The decrypted file is plaintext customer PII. Keep it on an encrypted disk, and
delete it when finished.

### 4. Restore into a SCRATCH database and validate

Create a throwaway database — a second Supabase project, or local Postgres 17:

```bash
createdb loyalty_restore_check
gunzip -c loyalty-20250310T031500Z.sql.gz | psql "postgresql://localhost/loyalty_restore_check"
```

The dump is plain SQL taken with `--no-owner --no-privileges`, so `psql` restores
it into any database without needing the original roles. (A custom-format archive
would be restored with `pg_restore --no-owner --no-privileges -d <db> <file>`; we
do not use one, so that recovery never depends on having a matching `pg_restore`.)

Validate before going near production:

```sql
-- Row counts in the ledger's core tables.
SELECT count(*) FROM ledger_entries;
SELECT count(*) FROM point_lots;
SELECT count(*) FROM customers;

-- How recent is this snapshot?
SELECT max(created_at) FROM ledger_entries;

-- The ledger is the source of truth. Spendable balance is the sum of unspent
-- point lots, and it must equal the signed sum of the ledger for each customer.
SELECT c.id,
       COALESCE(lots.remaining, 0) AS lot_balance,
       COALESCE(led.total, 0)      AS ledger_sum
  FROM customers c
  LEFT JOIN (SELECT customer_id, SUM(remaining_points) AS remaining
               FROM point_lots GROUP BY customer_id) lots ON lots.customer_id = c.id
  LEFT JOIN (SELECT customer_id, SUM(points) AS total
               FROM ledger_entries GROUP BY customer_id) led ON led.customer_id = c.id
 WHERE COALESCE(lots.remaining, 0) <> COALESCE(led.total, 0);
```

An empty result from the last query means the lot structure and the ledger agree.
If rows come back, restore anyway and then run reconciliation
(`POST /v1/admin/operations/reconciliation`), which recomputes the cached
balances/tiers from the ledger.

### 5. Restore into production

Only after the scratch restore validated.

1. **Stop the service** (Render → suspend) so nothing writes during the restore.
2. Take a dump of the current broken state first, if the database is reachable.
   You may need to compare against it later, and it costs a minute.
3. Restore into a **new, empty** database and repoint `DATABASE_URL`, rather than
   restoring over the live one. It is reversible, and it keeps the evidence.
4. Run `npm run migrate:up` in `loyalty-service/` to apply any migrations added
   after the dump was taken.
5. Resume the service, then run reconciliation to bring cached balances and the
   `loyalty.*` Shopify metafields back in line with the restored ledger.
6. Confirm `GET /health` and a `GET /v1/balance` for a known customer.

## What Shopify can and cannot rebuild

If the database is lost entirely and no usable dump exists, Shopify is a partial
fallback. Be clear about which half is which before promising anyone a recovery.

**Rebuildable from Shopify:**

- **Order-derived earning.** Order history is authoritative in Shopify, so
  purchase points are recomputable from paid orders using the same earning rules.
- **Issued discount codes.** Retrievable from the Admin API, so outstanding
  redemptions can be honoured and reconciled.
- **Approximate current balance and tier.** The `loyalty.*` customer metafields
  hold the display cache, and are now refreshed on **every** balance change
  (Req 13.5a) rather than only on a schedule — so they are close to current.
  The existing M0 export tooling (`src/migration/m0Export.ts`) reads them, and the
  M1 backfill (`src/migration/m1Backfill.ts`) seeds a fresh ledger from that
  export, exactly as it did for the original cutover. That is the recovery path.

**Not recoverable from Shopify — permanently lost:**

- Ledger history and the immutable audit trail (every individual entry, its
  reason and its timestamp).
- Manual admin adjustments and credits, and the reasons recorded for them.
- Referral attribution: who referred whom, and which referrals had paid out.
- FIFO lot structure and per-lot expiry dates. A backfill can only create one
  non-expiring lot per customer, so the 12-month expiry window restarts.
- Redemption-to-discount-code linkage, so a spend can no longer be traced to the
  code it produced.
- Fragrance profile preferences and portal visit history.

In short: balances survive, **history does not**. That is why the daily dump
matters even though Shopify holds the orders.

## The staleness watchdog

A backup mechanism that stops running silently is worthless — you find out at the
moment you need it. So each successful backup writes one row to `backup_runs`, and
the service publishes the newest one on `GET /health`:

```json
{
  "status": "ok",
  "version": "v1",
  "backups": { "lastSuccessAt": "2025-03-10T03:16:40.000Z", "ageHours": 8.7, "stale": false }
}
```

How to read it:

| Observation | Meaning | Action |
|---|---|---|
| `stale: false` | A dump completed within the last 26 hours | Nothing |
| `stale: true`, `lastSuccessAt` set | Backups worked and then stopped. A recovery point exists but is ageing | Check the workflow's recent runs; a failed run posts an `::error::`. Fix and run it manually |
| `stale: true`, `lastSuccessAt: null` | **No backup has ever been recorded.** There is no recovery point at all | Almost always missing configuration — check `BACKUP_DATABASE_URL` and `BACKUP_AGE_PUBLIC_KEY` |
| No `backups` key at all | The service could not read `backup_runs` (or the dependency is not wired). Reporting is best-effort and never fails the probe | Check the migration has been applied and the database is reachable |

The threshold is 26 hours: the 24-hour cadence plus a 2-hour grace, because
GitHub's scheduled workflows are explicitly best-effort and are routinely delayed
under load. An alarm that fires on ordinary delay is an alarm that gets ignored,
which would hand back the silent failure we are trying to remove.

## Deviation from Requirement 13.6

Requirement 13.6 as originally written asks for point-in-time recovery, automated
backups, **and** WAL retention of at least 7 days. On Supabase Free all three were
unmet. This mechanism meets two of the three clauses honestly and drops the other
two deliberately:

| Clause | Original | Now |
|---|---|---|
| Automated backups | Required | **Met** — daily, verified by evidence in `backup_runs` |
| Backup retention ≥ 7 days | Required | **Met** — 14-day artifact retention |
| Point-in-time recovery | Required | **Not met** — none available on the free tier |
| WAL retention ≥ 7 days | Required | **Not met** — a logical dump carries no WAL |

The deviation is not just written down here, it is **machine-checked**.
`LOGICAL_BACKUP_SPEC` in `src/reliability/backupRuns.ts` encodes the amended
standard, and `REQUIRED_BACKUP_SPEC` in `backupVerification.ts` is left untouched
as the aspirational one. `backupRuns.test.ts` asserts that the platform's real
posture passes the former and **fails the latter on exactly `PITR_DISABLED` and
`WAL_RETENTION_TOO_SHORT`** — so the gap cannot be quietly forgotten or papered
over by weakening a spec.

### When to adopt PITR

Move to a paid Postgres tier with PITR when any of these becomes true:

- Losing up to 24 hours of ledger activity would mean losing real, non-recomputable
  value — practically, once daily earning volume is high enough that a day of
  manual reconstruction is not feasible.
- Redemptions become frequent enough that "which code belongs to which spend"
  cannot be rebuilt by hand within a day.
- The service moves off free hosting for any other reason (an always-on instance,
  as `scheduled-jobs.md` originally recommended). At that point the marginal cost
  of PITR is small and the argument for deferring it disappears.

When that happens: enable PITR on the provider, verify the deployment against
`REQUIRED_BACKUP_SPEC` instead, and delete `LOGICAL_BACKUP_SPEC`. Keep the daily
dump anyway — it is cheap, and it is the only copy that lives outside the database
provider entirely.
