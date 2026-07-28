#!/usr/bin/env bash
#
# Gate 0 Stage 1 — verify an encrypted backup artifact decrypts and restores.
#
# WHAT THIS PROVES
#   The backup mechanism works and the schema restores: digest integrity of the
#   downloaded artifact, that it is genuinely age-encrypted rather than a bare
#   gzip, that it decrypts, that the decrypted stream is a valid gzip, that it
#   restores into an isolated scratch database, that all 15 migrations are
#   present with the required tables/indexes/constraints, and that the restored
#   database contains one FEWER backup_runs row than production.
#
#   It does NOT prove business-data fidelity. That is Stage 2, after M1.
#
# WHAT IT NEVER DOES
#   Never prints, logs or persists a connection URL, a password or key material.
#   Never touches production beyond two read-only COUNT queries. Never drops the
#   scratch database unless --confirm-drop-scratch is passed, and even then it
#   prints the exact target first. Never leaves decrypted PII behind: the
#   plaintext lives in a mode-700 mktemp directory removed by an EXIT trap on
#   success and on failure alike.
#
# WHY URLS COME FROM THE ENVIRONMENT ONLY
#   Arguments land in argv, `ps` output and shell history. Connection URLs
#   contain credentials, so they are accepted through the environment only. The
#   artifact path, expected digest and identity-file path are not secret and may
#   be passed either way.
#
# See docs/ops/gate0-stage1-audit.md for the audit this script was written from,
# including finding F1: a GitHub-downloaded artifact arrives wrapped in a ZIP, so
# extract it and point --artifact at the .age file inside.
set -euo pipefail

readonly SCRIPT_NAME="$(basename "$0")"

# --- defaults ---------------------------------------------------------------
EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS:-15}"
# Production minus restored. 1 because the row for a run is written only after
# its own artifact is stored, so an artifact never contains its own row.
EXPECTED_BACKUP_RUNS_DELTA="${EXPECTED_BACKUP_RUNS_DELTA:-1}"

ARTIFACT="${ARTIFACT_PATH:-}"
EXPECTED_SHA="${EXPECTED_SHA256:-}"
IDENTITY="${AGE_IDENTITY_FILE:-}"
DRY_RUN=0
CONFIRM_DROP=0
ALLOW_NONEMPTY=0

# Objects that must exist in a correctly restored database. Deliberately a
# curated list of the ledger-critical ones rather than every object, so a
# failure points at something meaningful.
readonly REQUIRED_TABLES=(
  customers ledger_entries point_lots redemptions discount_codes
  webhook_events referrals benefits benefit_requests tier_change_history
  admin_audit_log idempotency_keys scheduled_runs backup_runs markets
  device_tokens notification_events pre_expiry_notifications
  earning_rule_sets reward_rule_sets customer_wishlist customer_favourites
  customer_recently_viewed portal_visits
)
readonly REQUIRED_INDEXES=(
  idx_ledger_customer idx_lots_fifo idx_lots_expiry
  idx_tier_history_customer idx_benefit_requests_customer
  idx_benefit_requests_status backup_runs_completed_at_desc_idx
  referrals_one_referrer_per_referred
)
# constraint name : table
readonly REQUIRED_CONSTRAINTS=(
  "benefit_requests_status_check:benefit_requests"
)

PASSES=0

usage() {
  cat <<EOF
$SCRIPT_NAME — Gate 0 Stage 1 backup restore verification

USAGE
  DATABASE_URL=...  SCRATCH_DATABASE_URL=...  $SCRIPT_NAME [options]

REQUIRED ENVIRONMENT (never passed as arguments)
  DATABASE_URL           Production DB. Used for two read-only COUNT queries.
  SCRATCH_DATABASE_URL   Isolated throwaway DB. The ONLY write target.

REQUIRED INPUT (argument or environment)
  --artifact PATH        Encrypted .age artifact       (env ARTIFACT_PATH)
  --identity-file PATH   age private key file          (env AGE_IDENTITY_FILE)

OPTIONAL
  --expected-sha256 HEX  Digest to verify against      (env EXPECTED_SHA256)
                         If omitted, read from backup_runs via DATABASE_URL.
  --dry-run              Print the plan and the preflight results, then stop.
                         Touches no database and decrypts nothing.
  --allow-nonempty-scratch
                         Permit a scratch DB that already has our tables.
                         Off by default so you cannot overwrite a real database.
  --confirm-drop-scratch After a PASS, drop the restored objects from the
                         scratch database. Prints the exact target first.
  -h, --help             This text.

TUNABLES
  EXPECTED_MIGRATIONS            default 15
  EXPECTED_BACKUP_RUNS_DELTA     default 1  (production minus restored)

EXAMPLE — nothing secret appears on the command line
  export DATABASE_URL='...'          # paste, or read from your password manager
  export SCRATCH_DATABASE_URL='...'
  $SCRIPT_NAME \\
    --artifact ./loyalty-20260728T031500Z.sql.gz.age \\
    --identity-file ~/.secrets/loyalty-backup.key \\
    --dry-run

Then re-run without --dry-run. Exit status 0 means every assertion passed.
EOF
}

# --- output helpers ---------------------------------------------------------
pass() {
  PASSES=$((PASSES + 1))
  printf 'PASS  %s\n' "$1"
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  printf '\nSTAGE 1 VERIFICATION FAILED after %d passing assertion(s).\n' "$PASSES" >&2
  exit 1
}

info() { printf '      %s\n' "$1"; }
head1() { printf '\n=== %s ===\n' "$1"; }

# Host and database name only. Never the user, never the password.
url_target() {
  local url="$1" rest hostport db
  rest="${url#*://}"
  rest="${rest#*@}"          # drop any user:password@
  hostport="${rest%%/*}"
  db="${rest#*/}"
  db="${db%%\?*}"            # drop query string
  printf '%s/%s' "$hostport" "${db:-<none>}"
}

# --- argument parsing -------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --artifact) ARTIFACT="${2:?--artifact needs a path}"; shift 2 ;;
    --expected-sha256) EXPECTED_SHA="${2:?--expected-sha256 needs a value}"; shift 2 ;;
    --identity-file) IDENTITY="${2:?--identity-file needs a path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --confirm-drop-scratch) CONFIRM_DROP=1; shift ;;
    --allow-nonempty-scratch) ALLOW_NONEMPTY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    # Refuse a URL on the command line rather than silently accepting it.
    --database-url|--scratch-url)
      printf 'FAIL  %s must be supplied through the environment, not as an argument, so it stays out of argv and shell history.\n' "$1" >&2
      exit 2 ;;
    *) printf 'FAIL  unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
done

# --- portable primitives ----------------------------------------------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "no sha256sum or shasum available; cannot verify the digest"
  fi
}

size_of() { wc -c < "$1" | tr -d ' '; }

first_two_bytes() { od -An -tx1 -N2 < "$1" | tr -d ' \n'; }

psql_scalar() {
  local url="$1" sql="$2" out
  if ! out="$(psql "$url" --no-psqlrc --quiet --tuples-only --no-align \
                 -v ON_ERROR_STOP=1 -c "$sql" 2>&1)"; then
    # Surface that it failed without echoing anything that may embed the URL.
    fail "query failed against $(url_target "$url") — check reachability and permissions"
  fi
  printf '%s' "$out" | tr -d '[:space:]'
}

# ---------------------------------------------------------------------------
head1 "Preflight"

[ -n "$ARTIFACT" ]  || fail "no artifact given (--artifact or ARTIFACT_PATH)"
[ -n "$IDENTITY" ]  || fail "no identity file given (--identity-file or AGE_IDENTITY_FILE)"
[ -f "$ARTIFACT" ]  || fail "artifact not found: $ARTIFACT"
[ -f "$IDENTITY" ]  || fail "identity file not found: $IDENTITY"
pass "artifact and identity file exist"

for tool in age gzip psql od awk; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool not on PATH: $tool"
done
pass "required tools present (age, gzip, psql, od, awk)"

: "${DATABASE_URL:?DATABASE_URL must be set in the environment}"
: "${SCRATCH_DATABASE_URL:?SCRATCH_DATABASE_URL must be set in the environment}"

# The single most important guard in this script.
if [ "$DATABASE_URL" = "$SCRATCH_DATABASE_URL" ]; then
  fail "SCRATCH_DATABASE_URL is identical to DATABASE_URL — refusing to restore over production"
fi
pass "scratch target is distinct from production"

artifact_size="$(size_of "$ARTIFACT")"
[ "$artifact_size" -gt 0 ] || fail "artifact is empty"
pass "artifact is non-empty (${artifact_size} bytes)"

# A bare gzip here means the age step did not take effect and PII is in the clear.
magic="$(first_two_bytes "$ARTIFACT")"
if [ "$magic" = "1f8b" ]; then
  fail "artifact begins with gzip magic 1f 8b — it is NOT encrypted. Treat as a data-handling incident: do not distribute it, and fix BACKUP_AGE_PUBLIC_KEY before re-running."
fi
pass "artifact does not begin with gzip magic (first bytes: ${magic})"

info "artifact:   $(basename "$ARTIFACT")"
info "production: $(url_target "$DATABASE_URL")"
info "scratch:    $(url_target "$SCRATCH_DATABASE_URL")"
info "expect:     ${EXPECTED_MIGRATIONS} migrations, backup_runs delta ${EXPECTED_BACKUP_RUNS_DELTA}"

if [ "$DRY_RUN" -eq 1 ]; then
  head1 "Dry run"
  cat <<'PLAN'
Would then, in order:
  1. resolve the expected SHA-256 (argument, else backup_runs on production)
  2. verify the artifact digest BEFORE decrypting
  3. decrypt with age into a mode-700 temporary directory
  4. verify the decrypted stream is valid gzip (gzip -t)
  5. confirm the scratch database has none of our tables
  6. restore into the scratch database only, with ON_ERROR_STOP=1
  7. assert the migration count, required tables, indexes and constraints
  8. compare production and restored backup_runs counts
  9. remove the decrypted plaintext (also on failure)
Nothing was decrypted and no database was contacted.
PLAN
  printf '\nDRY RUN OK — %d preflight assertion(s) passed.\n' "$PASSES"
  exit 0
fi

# --- temp workspace, cleaned unconditionally --------------------------------
WORKDIR="$(mktemp -d)"
chmod 700 "$WORKDIR"
cleanup() {
  local status=$?
  if [ -n "${WORKDIR:-}" ] && [ -d "$WORKDIR" ]; then
    find "$WORKDIR" -type f -exec rm -f {} + 2>/dev/null || true
    rm -rf "$WORKDIR"
    printf '      decrypted plaintext removed from the temporary directory\n'
  fi
  exit "$status"
}
trap cleanup EXIT

# --- digest, BEFORE decryption ---------------------------------------------
head1 "Digest"

if [ -z "$EXPECTED_SHA" ]; then
  info "no --expected-sha256 given; reading the newest backup_runs row from production"
  EXPECTED_SHA="$(psql_scalar "$DATABASE_URL" \
    "SELECT sha256 FROM backup_runs ORDER BY completed_at DESC LIMIT 1")"
  [ -n "$EXPECTED_SHA" ] || fail "production backup_runs has no rows, so there is no digest to verify against"
fi

actual_sha="$(sha256_of "$ARTIFACT")"
if [ "$actual_sha" != "$EXPECTED_SHA" ]; then
  printf 'FAIL  digest mismatch\n' >&2
  printf '      expected %s\n' "$EXPECTED_SHA" >&2
  printf '      actual   %s\n' "$actual_sha" >&2
  printf '      If you downloaded from GitHub Actions, the artifact arrives as a ZIP.\n' >&2
  printf '      Extract it and hash the .age file inside (audit finding F1).\n' >&2
  fail "refusing to decrypt an artifact that does not match its recorded digest"
fi
pass "artifact digest matches the recorded SHA-256 (verified before decryption)"

# --- decrypt ----------------------------------------------------------------
head1 "Decrypt"

plain="$WORKDIR/restore.sql.gz"
if ! age --decrypt --identity "$IDENTITY" --output "$plain" "$ARTIFACT" 2>"$WORKDIR/age.err"; then
  info "age reported: $(tr -d '\r' < "$WORKDIR/age.err" | head -3)"
  fail "age --decrypt failed — wrong identity, or the artifact is not age-encrypted"
fi
pass "age --decrypt succeeded"

[ -s "$plain" ] || fail "decrypted output is empty"

dmagic="$(first_two_bytes "$plain")"
[ "$dmagic" = "1f8b" ] || fail "decrypted output does not begin with gzip magic 1f 8b (got ${dmagic}); the artifact is not the expected .sql.gz"
pass "decrypted output begins with gzip magic 1f 8b"

gzip -t "$plain" 2>/dev/null || fail "decrypted gzip stream is corrupt or truncated (gzip -t failed) — this is the truncated-dump case the size floor cannot catch"
pass "decrypted gzip stream is intact (gzip -t)"

# --- scratch must be empty of our schema ------------------------------------
head1 "Scratch database"

existing="$(psql_scalar "$SCRATCH_DATABASE_URL" \
  "SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public'
      AND table_name IN ('customers','ledger_entries','point_lots')")"
if [ "$existing" != "0" ]; then
  if [ "$ALLOW_NONEMPTY" -eq 1 ]; then
    info "scratch already has ${existing} of our core tables; continuing because --allow-nonempty-scratch was given"
  else
    fail "scratch database already contains ${existing} of our core tables. Refusing to restore over it. Use a genuinely empty database, or pass --allow-nonempty-scratch if you are certain."
  fi
else
  pass "scratch database contains none of our core tables"
fi

# --- restore ----------------------------------------------------------------
head1 "Restore"

if ! gunzip -c "$plain" | psql "$SCRATCH_DATABASE_URL" --no-psqlrc --quiet \
       -v ON_ERROR_STOP=1 -f - >"$WORKDIR/restore.log" 2>&1; then
  info "last lines of the restore log:"
  tail -5 "$WORKDIR/restore.log" | sed 's/^/      /'
  fail "restore into the scratch database failed"
fi
pass "dump restored into the scratch database with ON_ERROR_STOP=1"

# --- schema assertions ------------------------------------------------------
head1 "Schema"

migrations="$(psql_scalar "$SCRATCH_DATABASE_URL" "SELECT count(*) FROM pgmigrations")"
[ "$migrations" = "$EXPECTED_MIGRATIONS" ] \
  || fail "restored migration count is ${migrations}, expected ${EXPECTED_MIGRATIONS}"
pass "restored pgmigrations count is ${migrations}"

missing_tables=""
for t in "${REQUIRED_TABLES[@]}"; do
  found="$(psql_scalar "$SCRATCH_DATABASE_URL" \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}'")"
  [ "$found" = "1" ] || missing_tables="${missing_tables} ${t}"
done
[ -z "$missing_tables" ] || fail "missing table(s):${missing_tables}"
pass "all ${#REQUIRED_TABLES[@]} required tables present"

missing_indexes=""
for i in "${REQUIRED_INDEXES[@]}"; do
  found="$(psql_scalar "$SCRATCH_DATABASE_URL" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='${i}'")"
  [ "$found" = "1" ] || missing_indexes="${missing_indexes} ${i}"
done
[ -z "$missing_indexes" ] || fail "missing index(es):${missing_indexes}"
pass "all ${#REQUIRED_INDEXES[@]} required indexes present"

missing_constraints=""
for pair in "${REQUIRED_CONSTRAINTS[@]}"; do
  cname="${pair%%:*}"
  found="$(psql_scalar "$SCRATCH_DATABASE_URL" \
    "SELECT count(*) FROM pg_constraint WHERE conname='${cname}'")"
  [ "$found" = "1" ] || missing_constraints="${missing_constraints} ${cname}"
done
[ -z "$missing_constraints" ] || fail "missing constraint(s):${missing_constraints}"
pass "all ${#REQUIRED_CONSTRAINTS[@]} required constraint(s) present"

# --- backup_runs off-by-one -------------------------------------------------
head1 "backup_runs"

prod_runs="$(psql_scalar "$DATABASE_URL" "SELECT count(*) FROM backup_runs")"
rest_runs="$(psql_scalar "$SCRATCH_DATABASE_URL" "SELECT count(*) FROM backup_runs")"
delta=$((prod_runs - rest_runs))

info "production ${prod_runs}, restored ${rest_runs}, delta ${delta}"
if [ "$delta" -ne "$EXPECTED_BACKUP_RUNS_DELTA" ]; then
  fail "backup_runs delta is ${delta}, expected ${EXPECTED_BACKUP_RUNS_DELTA}. A delta of 0 would mean the row was written BEFORE the artifact was stored, which breaks the guarantee that /health never advertises a backup that does not exist."
fi
pass "backup_runs delta is ${delta} — the artifact does not contain its own row, as designed"

# --- optional scratch teardown ---------------------------------------------
head1 "Scratch teardown"

if [ "$CONFIRM_DROP" -eq 1 ]; then
  printf '      target: %s\n' "$(url_target "$SCRATCH_DATABASE_URL")"
  printf '      dropping and recreating schema "public" in the SCRATCH database above\n'
  if ! psql "$SCRATCH_DATABASE_URL" --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
         -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null 2>&1; then
    fail "failed to drop the scratch schema — remove the scratch database manually"
  fi
  pass "scratch schema dropped and recreated"
  info "this does NOT run DROP DATABASE. Delete the scratch database yourself:"
  info "  the database named in the target above"
else
  info "scratch left intact (no --confirm-drop-scratch)."
  info "Inspect it, then remove it yourself. Stage 1 requires the scratch database to be gone."
fi

head1 "Result"
printf 'STAGE 1 VERIFICATION PASSED — %d assertion(s).\n' "$PASSES"
printf 'Proves: the backup mechanism and a clean SCHEMA restore.\n'
printf 'Does NOT prove: business-data fidelity. That is Stage 2, after M1.\n'
