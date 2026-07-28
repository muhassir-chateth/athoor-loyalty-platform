# Gate 0 Stage 1 — code audit of the backup mechanism

Audited 2026-07-28 against the files as committed, not from memory:

- `.github/workflows/backup.yml`
- `loyalty-service/migrations/1785600000000_create-backup-runs.ts`
- `loyalty-service/migrations/1785800000000_rename-one-referrer-per-referred-index.ts`
- `docs/ops/backup-and-recovery.md`

**Nothing was executed.** No workflow was triggered, no keypair generated, no
credential handled, no GitHub setting changed, no row written anywhere. This is a
static read of the implementation, undertaken so the Stage 1 pass criteria rest on
verified behaviour rather than on assumption.

**GO/NO-GO is unchanged: production launch remains NO-GO pending Stage 1.**

## Verdict on the eight requested checks

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Dump is created before the `backup_runs` row | **CONFIRMED** | `Dump and encrypt` is step 3; `Record the successful run in backup_runs` is step 6 and last. GitHub Actions runs steps sequentially and aborts the job on the first failure. |
| 2 | Encryption happens before artifact upload | **CONFIRMED** | `age --recipient … --output "$cipher" "$plain"` runs inside step 3. The upload step is step 4 and uploads `$ARTIFACT`, which is `$cipher`. The plaintext is `rm -f`'d inside step 3, before the upload step begins, so no plaintext exists at upload time. |
| 3 | SHA-256 is computed on the encrypted `.age` artifact | **CONFIRMED** | `sha256="$(sha256sum "$cipher" \| awk '{print $1}')"` — argument is `$cipher`, and it runs after the `age` call. The same value is exported as `SHA256` and inserted into `backup_runs.sha256`. The migration header states the same intent: digest and size describe the **encrypted** artifact. |
| 4 | Upload completes before the success row is written | **CONFIRMED** | Step order 4 (`actions/upload-artifact@v4`) → 5 (optional R2) → 6 (record row). `if-no-files-found: error` turns a missing file into a failure. Step 6 carries no `if:`, so it inherits the default `success()` condition and cannot run after a failed upload. |
| 5 | A private `AGE-SECRET-KEY-*` value is rejected | **CONFIRMED** | Explicit `case` in step 1: `age1*` passes; `AGE-SECRET-KEY-*` exits 1 with an `::error::` telling the operator to rotate; anything else exits 1. The guard is closed by default — an unrecognised value fails rather than falling through. |
| 6 | A failed dump, encryption or upload cannot create a successful row | **CONFIRMED, with one residual risk** | Four independent reasons: `set -euo pipefail` in every `run:`; `docker run` is a simple command so its non-zero exit propagates under `set -e`; the record step is gated on `success()`; and two explicit guards reject a dump under 1 KiB and an empty ciphertext. See the residual risk below. |
| 7 | The minimum dump-size check behaves as documented | **CONFIRMED in code, DOCUMENTATION GAP** | Implementation: `plain_size -lt 1024` on the compressed plaintext, plus `size_bytes -le 0` on the ciphertext, plus `CHECK (size_bytes > 0)` in the table. The 1 KiB floor is documented only in the workflow's inline comment — `docs/ops/backup-and-recovery.md` never states a threshold. Finding **F2**. |
| 8 | The workflow uses only the public age recipient | **CONFIRMED** | Only `--recipient` appears. Grepping the workflow for `--identity`, `age -d`, `age --decrypt` and `--armor` returns nothing. The job can write backups it cannot read, which is the entire point of the public-key design. |

## Residual risk behind check 6

The guards catch a dump that is *empty or trivially small*. They cannot catch a
dump that is **truncated above 1 KiB** — a partial gzip stream would pass the size
floor, encrypt cleanly, upload, and be recorded as a successful backup.

`pg_dump` exiting non-zero is caught, so this requires pg_dump to exit 0 having
written incomplete output, which is unlikely but not impossible (for example a
connection reset late in a large dump that the client reports as success).

The only detection is decrypting and decompressing the artifact — which is exactly
what a restore rehearsal does. This does not weaken the case for Stage 1; it is
the strongest argument for it, and it is why "the upload succeeded" was correctly
rejected as sufficient evidence. The verification script therefore runs
`gzip -t` on the decrypted stream before attempting any restore.

## Mismatches against our agreed Stage 1 criteria

### F1 — Downloaded GitHub artifacts are wrapped in a ZIP (affects the digest check)

`actions/upload-artifact@v4` is given `name: ${{ env.ARTIFACT }}`, so the artifact
is *named* `loyalty-<stamp>.sql.gz.age`. Downloading it from the Actions run
summary yields **`loyalty-<stamp>.sql.gz.age.zip`**, containing the `.age` file.

`docs/ops/backup-and-recovery.md` step 2 says to run
`sha256sum loyalty-….sql.gz.age`, which is correct **only after extracting**. An
operator who hashes the downloaded file directly will compute the digest of a ZIP
and see a mismatch against `backup_runs.sha256`, then reasonably conclude the
backup is corrupt when it is fine.

This matters because we agreed the digest match is one of the two decisive
positives. **Unzip first, hash the extracted `.age` file.** The R2 path is not
affected — `aws s3 cp` retrieves the raw object.

Not fixed. Documentation-only change, and the repository is frozen pending your
instruction.

### F2 — The 1 KiB minimum is not in the runbook

Stated only in `backup.yml`'s inline comment. An operator reading
`backup-and-recovery.md` alone cannot know why a small dump failed. Recorded, not
fixed.

### F3 — The runbook's restore example omits `--no-psqlrc` and error stopping

`docs/ops/backup-and-recovery.md` step 4 pipes `gunzip -c … | psql "$URL"` with no
`ON_ERROR_STOP=1`. Without it, `psql` reports errors and continues, exiting 0 — so
a partially restored database can look like a successful restore. The verification
script uses `ON_ERROR_STOP=1`. Recorded, not fixed.

### F4 — The artifact is binary age, so there is no armour header

The workflow does not pass `--armor`, so the artifact will **not** begin with
`age-encryption.org/v1`. Our agreed criteria already anticipated this: absence of
that header is **not** a failure for binary output, and the decisive positives
remain the digest match and a successful decrypt. Confirming it here so the
expectation is settled before the run rather than argued during it.

Correspondingly, `file` reporting `data` is expected and acceptable. What must
**not** appear is `gzip compressed data` or any text/ASCII identification on the
**encrypted** artifact — that would mean the `age` step did not take effect.

### F5 — `completed_at` is a default, not a second write

`backup_runs.completed_at TIMESTAMPTZ NOT NULL DEFAULT now()` and the INSERT
supplies only `started_at`. So `completed_at` is the moment the row was written,
which is after upload. This is consistent with `/health` treating it as "the most
recent recoverable point", and it means there is no window where a row exists with
a null completion. Recording it because "the row is written only after storage"
and "completed_at is when storage finished" are subtly different claims, and only
the first is strictly true — `completed_at` is when the *row* was written, a few
seconds after the upload returned.

### F6 — No failed-backup rows, by design

The table stores successes only. So "production `backup_runs` = 1" after the first
run is the expected evidence, and a failed first attempt followed by a successful
one still yields exactly 1. The count is not an attempt counter. Confirmed
deliberate in the migration header.

## Confirmation of the off-by-one expectation

We agreed to treat "production 1 / restored 0" as *positive* evidence. The audit
confirms the mechanism that produces it:

1. `pg_dump` runs in step 3 and captures `backup_runs` as it stands at that moment.
2. The row for *this* run is inserted in step 6, after the dump was taken.

So the artifact can never contain its own `backup_runs` row. First run: production
1, restored 0. Second run (Stage 2): production 2, restored 1. Both match what we
agreed. The verification script asserts the **delta**, defaulting to 1, rather
than hard-coding either count, so it works unchanged for Stage 2.

## Two operational notes for the run

**Postgres major version.** The workflow pins `postgres:17-alpine` because
`pg_dump` refuses to dump from a server newer than itself, with the comment
recording that the live server reported 17.6. If the new production database is
provisioned on Postgres 18, the dump step will fail with a version mismatch and
`PG_IMAGE` must be bumped deliberately. Worth checking `SHOW server_version` on
the new database before the first run.

**Scratch database version.** The restore target should be Postgres 17 or newer.
Restoring a 17 dump into an older server can fail on unsupported syntax.

## Verification script

`scripts/gate0/verify-stage1-restore.sh`, with tests in
`verify-stage1-restore.test.sh`. See `--help` for usage. Design constraints, all
of which are asserted by the tests where they are testable offline:

- Connection URLs are read from the **environment only**, never from arguments, so
  they stay out of `argv`, `ps` output and shell history.
- The digest is verified **before** any decryption is attempted.
- gzip magic `1f 8b` on the *encrypted* artifact is a hard failure.
- The decrypted stream must be valid gzip (`gzip -t`) before any restore.
- Decrypted plaintext goes to a `mktemp -d` directory with mode 700 and is removed
  by an `EXIT` trap on success **and** on failure.
- Restore targets `SCRATCH_DATABASE_URL` only, and the script aborts if it equals
  `DATABASE_URL`.
- The scratch database is never cleaned automatically: it requires
  `--confirm-drop-scratch`, and the exact host and database name are printed first.
- No credential, URL or key material is ever printed. Output is PASS/FAIL lines.

One accepted limitation, stated rather than hidden: `psql "$URL"` places the URL
in `argv`, visible to other processes of the same user on that machine. The
workflow avoids this by expanding the URL inside a container because CI process
listings are shared; on the operator's own machine the exposure is local. Noted so
it is a known trade-off rather than an oversight.

## What this audit does and does not establish

Establishes: the ordering, encryption, digest and refusal behaviour of the backup
mechanism are as specified, and the Stage 1 pass criteria we agreed are consistent
with the implementation.

Does not establish: that a backup has ever run, that an artifact exists, that it
decrypts, or that it restores. No production database exists yet. Stage 1 remains
entirely unexecuted, and the launch blocker stands.
