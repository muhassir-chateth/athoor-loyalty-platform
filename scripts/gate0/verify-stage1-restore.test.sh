#!/usr/bin/env bash
#
# Focused tests for verify-stage1-restore.sh.
#
# Everything runs OFFLINE. `age` and `psql` are replaced by stubs placed first on
# PATH, so no database is contacted, nothing is decrypted for real, and no key is
# needed. The stubs also record whether they were called, which is how the
# "digest is verified BEFORE decryption" ordering is asserted rather than assumed.
#
# Run:  bash scripts/gate0/verify-stage1-restore.test.sh
set -uo pipefail

readonly HERE="$(cd "$(dirname "$0")" && pwd)"
readonly SUT="$HERE/verify-stage1-restore.sh"

TESTS=0
FAILURES=0

# --- harness ----------------------------------------------------------------
ok() { TESTS=$((TESTS + 1)); printf '  ok    %s\n' "$1"; }
no() {
  TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1))
  printf '  NOT OK %s\n' "$1"
  [ -n "${2:-}" ] && printf '         %s\n' "$2"
}

assert_status() {
  local label="$1" expected="$2" actual="$3" output="$4"
  if [ "$actual" -eq "$expected" ]; then ok "$label"
  else no "$label" "expected exit ${expected}, got ${actual}. Output: $(printf '%s' "$output" | tr '\n' '|' | cut -c1-220)"; fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) ok "$label" ;;
    *) no "$label" "expected to find '${needle}'. Output: $(printf '%s' "$haystack" | tr '\n' '|' | cut -c1-220)" ;;
  esac
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) no "$label" "did NOT expect '${needle}'" ;;
    *) ok "$label" ;;
  esac
}

# --- fixtures ---------------------------------------------------------------
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

readonly BIN="$SANDBOX/bin"
mkdir -p "$BIN"

# `age` stub: records invocation, then writes a valid gzip to --output.
cat > "$BIN/age" <<'STUB'
#!/usr/bin/env bash
echo "age called: $*" >> "$STUB_LOG"
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "--output" ] && out="$a"
  prev="$a"
done
if [ "${STUB_AGE_FAIL:-0}" = "1" ]; then
  echo "no identity matched any of the recipients" >&2
  exit 1
fi
if [ -n "$out" ]; then
  if [ "${STUB_AGE_PLAINTEXT:-0}" = "1" ]; then
    printf 'this is not gzip at all' > "$out"
  elif [ "${STUB_AGE_TRUNCATED:-0}" = "1" ]; then
    # Valid gzip magic, deliberately corrupt body, so gzip -t must reject it.
    printf '\037\213\010\000\000\000\000\000\000\003BROKEN' > "$out"
  else
    printf 'SELECT 1;\n' | gzip -c > "$out"
  fi
fi
exit 0
STUB

# `psql` stub: answers each query the script asks, by pattern.
cat > "$BIN/psql" <<'STUB'
#!/usr/bin/env bash
echo "psql called" >> "$STUB_LOG"
sql=""
prev=""
for a in "$@"; do
  [ "$prev" = "-c" ] && sql="$a"
  prev="$a"
done
# Restore path: reading the dump from stdin.
case " $* " in
  *" -f "*) cat > /dev/null; exit "${STUB_RESTORE_STATUS:-0}" ;;
esac
case "$sql" in
  *"DROP SCHEMA"*)            exit 0 ;;
  *"sha256 FROM backup_runs"*) echo "${STUB_RECORDED_SHA:-}" ;;
  *"information_schema.tables"*)
      case "$sql" in
        *"IN ('customers'"*) echo "${STUB_SCRATCH_EXISTING:-0}" ;;
        *)                   echo "${STUB_TABLE_FOUND:-1}" ;;
      esac ;;
  *"FROM pgmigrations"*)      echo "${STUB_MIGRATIONS:-15}" ;;
  *"pg_indexes"*)             echo "${STUB_INDEX_FOUND:-1}" ;;
  *"pg_constraint"*)          echo "${STUB_CONSTRAINT_FOUND:-1}" ;;
  *"count(*) FROM backup_runs"*)
      # First call is production, second is restored.
      n="$(cat "$STUB_RUNS_COUNTER" 2>/dev/null || echo 0)"
      n=$((n + 1)); echo "$n" > "$STUB_RUNS_COUNTER"
      if [ "$n" -eq 1 ]; then echo "${STUB_PROD_RUNS:-1}"; else echo "${STUB_REST_RUNS:-0}"; fi ;;
  *) echo "0" ;;
esac
exit 0
STUB

chmod +x "$BIN/age" "$BIN/psql"

# A stand-in "encrypted" artifact: must NOT start with gzip magic.
readonly GOOD_ARTIFACT="$SANDBOX/loyalty-test.sql.gz.age"
printf 'age-fake-binary-body-not-gzip' > "$GOOD_ARTIFACT"

# An artifact that IS gzip, i.e. encryption never happened.
readonly GZIP_ARTIFACT="$SANDBOX/unencrypted.sql.gz.age"
printf 'SELECT 1;\n' | gzip -c > "$GZIP_ARTIFACT"

readonly IDENTITY="$SANDBOX/fake.key"
printf 'AGE-SECRET-KEY-FAKE\n' > "$IDENTITY"

good_sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
readonly GOOD_SHA="$(good_sha "$GOOD_ARTIFACT")"

# Runs the script with stubs in front of PATH and a fresh stub log.
run_sut() {
  STUB_LOG="$SANDBOX/stub.log"; : > "$STUB_LOG"
  STUB_RUNS_COUNTER="$SANDBOX/runs.count"; : > "$STUB_RUNS_COUNTER"
  export STUB_LOG STUB_RUNS_COUNTER
  PATH="$BIN:$PATH" \
  DATABASE_URL="postgresql://u:p@prod.example/postgres" \
  SCRATCH_DATABASE_URL="postgresql://u:p@scratch.example/scratch" \
    bash "$SUT" "$@" 2>&1
}

stub_log() { cat "$SANDBOX/stub.log" 2>/dev/null || true; }

printf '\n=== verify-stage1-restore.sh ===\n\n'

# --- help and dry run -------------------------------------------------------
printf 'help and dry-run\n'

out="$(PATH="$BIN:$PATH" bash "$SUT" --help 2>&1)"; st=$?
assert_status "--help exits 0" 0 "$st" "$out"
assert_contains "--help documents the environment contract" "must be supplied through the environment" "$(PATH="$BIN:$PATH" bash "$SUT" --database-url x 2>&1 || true)"
assert_contains "--help lists the scratch variable" "SCRATCH_DATABASE_URL" "$out"

out="$(run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" --dry-run)"; st=$?
assert_status "--dry-run exits 0" 0 "$st" "$out"
assert_contains "--dry-run says nothing was contacted" "no database was contacted" "$out"
assert_not_contains "--dry-run does not call age" "age called" "$(stub_log)"
assert_not_contains "--dry-run does not call psql" "psql called" "$(stub_log)"

# --- credentials never leak -------------------------------------------------
printf '\ncredential hygiene\n'

out="$(run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" --dry-run)"
assert_not_contains "password never printed" "p@prod" "$out"
assert_not_contains "full URL never printed" "postgresql://" "$out"
assert_contains "target shown as host/db only" "prod.example/postgres" "$out"

out="$(PATH="$BIN:$PATH" bash "$SUT" --database-url 'postgresql://x' 2>&1)"; st=$?
assert_status "a URL passed as an argument is refused" 2 "$st" "$out"

# --- preflight guards -------------------------------------------------------
printf '\npreflight guards\n'

out="$(run_sut --artifact "$SANDBOX/nope.age" --identity-file "$IDENTITY" --dry-run)"; st=$?
assert_status "missing artifact fails" 1 "$st" "$out"
assert_contains "missing artifact explains itself" "artifact not found" "$out"

out="$(run_sut --artifact "$GZIP_ARTIFACT" --identity-file "$IDENTITY" --dry-run)"; st=$?
assert_status "gzip-magic artifact fails" 1 "$st" "$out"
assert_contains "gzip magic reported as unencrypted" "it is NOT encrypted" "$out"
assert_contains "gzip magic framed as an incident" "data-handling incident" "$out"

out="$(PATH="$BIN:$PATH" DATABASE_URL="postgresql://same" SCRATCH_DATABASE_URL="postgresql://same" \
        bash "$SUT" --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" --dry-run 2>&1)"; st=$?
assert_status "identical prod and scratch URLs fail" 1 "$st" "$out"
assert_contains "identical URLs explain the refusal" "refusing to restore over production" "$out"

# --- digest before decryption ----------------------------------------------
printf '\ndigest is verified before decryption\n'

out="$(run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "0000000000000000000000000000000000000000000000000000000000000000")"; st=$?
assert_status "digest mismatch fails" 1 "$st" "$out"
assert_contains "digest mismatch names the cause" "digest mismatch" "$out"
assert_contains "digest mismatch mentions the ZIP trap" "arrives as a ZIP" "$out"
assert_not_contains "NO decryption attempted on mismatch" "age called" "$(stub_log)"
assert_contains "temp plaintext cleaned up on failure" "decrypted plaintext removed" "$out"

out="$(STUB_RECORDED_SHA="$GOOD_SHA" run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY")"; st=$?
assert_status "digest read from backup_runs passes end to end" 0 "$st" "$out"
assert_contains "digest verified before decryption" "verified before decryption" "$out"

# --- decrypted stream validation -------------------------------------------
printf '\ndecrypted stream validation\n'

out="$(STUB_AGE_FAIL=1 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "age failure fails the run" 1 "$st" "$out"
assert_contains "age failure explains the likely cause" "wrong identity" "$out"

out="$(STUB_AGE_PLAINTEXT=1 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "non-gzip decrypted output fails" 1 "$st" "$out"
assert_contains "non-gzip output names gzip magic" "gzip magic" "$out"

out="$(STUB_AGE_TRUNCATED=1 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "corrupt gzip fails" 1 "$st" "$out"
assert_contains "corrupt gzip cites the truncated-dump case" "truncated-dump case" "$out"

# --- scratch protection -----------------------------------------------------
printf '\nscratch protection\n'

out="$(STUB_SCRATCH_EXISTING=3 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "non-empty scratch fails by default" 1 "$st" "$out"
assert_contains "non-empty scratch refuses to overwrite" "Refusing to restore over it" "$out"

out="$(STUB_SCRATCH_EXISTING=3 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA" --allow-nonempty-scratch)"; st=$?
assert_status "non-empty scratch allowed with the override" 0 "$st" "$out"

out="$(run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" --expected-sha256 "$GOOD_SHA")"
assert_contains "scratch left intact without the flag" "scratch left intact" "$out"
assert_not_contains "no drop without the flag" "schema dropped" "$out"

out="$(run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA" --confirm-drop-scratch)"
assert_contains "drop prints the exact target first" "target: scratch.example/scratch" "$out"
assert_contains "drop happens only with the flag" "scratch schema dropped" "$out"
assert_contains "drop states it is not DROP DATABASE" "does NOT run DROP DATABASE" "$out"

# --- schema and backup_runs assertions -------------------------------------
printf '\nschema and backup_runs assertions\n'

out="$(STUB_MIGRATIONS=14 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "wrong migration count fails" 1 "$st" "$out"
assert_contains "migration count reported" "expected 15" "$out"

out="$(STUB_TABLE_FOUND=0 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "missing tables fail" 1 "$st" "$out"
assert_contains "missing tables are named" "missing table(s)" "$out"

out="$(STUB_INDEX_FOUND=0 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "missing indexes fail" 1 "$st" "$out"

out="$(STUB_CONSTRAINT_FOUND=0 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "missing constraints fail" 1 "$st" "$out"

out="$(STUB_PROD_RUNS=1 STUB_REST_RUNS=1 run_sut --artifact "$GOOD_ARTIFACT" \
        --identity-file "$IDENTITY" --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "delta 0 fails (row written before storage)" 1 "$st" "$out"
assert_contains "delta 0 explains the guarantee it breaks" "BEFORE the artifact was stored" "$out"

out="$(STUB_PROD_RUNS=2 STUB_REST_RUNS=1 run_sut --artifact "$GOOD_ARTIFACT" \
        --identity-file "$IDENTITY" --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "Stage 2 shape (2 vs 1) also passes" 0 "$st" "$out"

out="$(STUB_RESTORE_STATUS=1 run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" \
        --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "failed restore fails the run" 1 "$st" "$out"
assert_contains "failed restore is named" "restore into the scratch database failed" "$out"

# --- happy path -------------------------------------------------------------
printf '\nhappy path\n'

out="$(run_sut --artifact "$GOOD_ARTIFACT" --identity-file "$IDENTITY" --expected-sha256 "$GOOD_SHA")"; st=$?
assert_status "full run passes" 0 "$st" "$out"
assert_contains "reports PASSED" "STAGE 1 VERIFICATION PASSED" "$out"
assert_contains "scopes the claim honestly" "Does NOT prove: business-data fidelity" "$out"
assert_contains "cleans up the plaintext on success" "decrypted plaintext removed" "$out"

# --- summary ----------------------------------------------------------------
printf '\n=== %d assertion(s), %d failure(s) ===\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
