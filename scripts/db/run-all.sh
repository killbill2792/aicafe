#!/usr/bin/env bash
# Runs every SQL and database test script in this repository against throwaway
# local databases. CI runs it in the "db" job of the AI CAFE PR baseline workflow.
#
# How it works:
#   Supabase lane (in the foreground). Local Supabase must already be running
#   with every migration applied (`supabase start`); its database listens on
#   127.0.0.1:54322. Nearly every SQL file wraps itself in BEGIN ... ROLLBACK and
#   the concurrency tests use their own café IDs, so the first groups share one
#   database. The database is then rebuilt once (`supabase db reset`) so the Toast
#   group starts clean. The two groups that re-run old migrations go last: the
#   Toast group puts the newest importer back itself, then the Supervisor group
#   re-runs migration 102.
#   Plain PostgreSQL lane (in the background, at the same time). Tests that build
#   their own small schema each get a fresh, empty PostgreSQL 16 container on
#   127.0.0.1:5432, removed right after the test.
#   Every step runs even when an earlier one fails, unless it needs a setup step
#   that failed. The summary lists each step with its result and time, and the
#   script exits 1 when anything failed.
#
# Local use (Docker running), always on a fresh database:
#   supabase start (or supabase db reset) && bash scripts/db/run-all.sh
# It rebuilds the local Supabase database, so local data there is lost. It only
# ever connects to 127.0.0.1; these scripts create and delete test data.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 1

export PGPASSWORD=postgres
supabase_url="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
# The official postgres:16 image, from AWS's public mirror of Docker Hub (where
# the Supabase images come from too), which avoids Docker Hub's pull limits.
plain_image="public.ecr.aws/docker/library/postgres:16"
plain_container="aicafe-db-tests-plain-$$"
work="$(mktemp -d)"
results="$work/results.tsv"
: >"$results"

cleanup() {
  docker rm -f "$plain_container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

now_ms() {
  local t="${EPOCHREALTIME:-}"
  if [[ -n "$t" ]]; then echo $((${t/[.,]/} / 1000)); else echo $(($(date +%s) * 1000)); fi
}
in_ci() { [[ "${GITHUB_ACTIONS:-}" == "true" ]]; }

# Each lane keeps its own counter, group name and "setup still fine" flags.
step_no=0
group_name=""
group_ok=true
lane_ok=true

group() {
  group_name="$1"
  group_ok="$lane_ok"
}

# run LANE NAME COMMAND... : runs one step with its output in a log file and
# records "lane, group, step, result, seconds" in the results file.
run() {
  local lane="$1" name="$2"
  shift 2
  step_no=$((step_no + 1))
  local log result seconds status
  log="$work/$lane-$(printf '%03d' "$step_no").log"
  if [[ "$group_ok" != true ]]; then
    echo "Skipped: a setup step it depends on failed (see above)." >"$log"
    result=SKIP seconds=- status=1
  else
    local start
    start="$(now_ms)"
    "$@" >"$log" 2>&1
    status=$?
    seconds="$(awk -v ms="$(($(now_ms) - start))" 'BEGIN { printf "%.1f", ms / 1000 }')"
    result=PASS
    [[ $status -eq 0 ]] || result=FAIL
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$lane" "$group_name" "$name" "$result" "$seconds" "$log" >>"$results"
  # The foreground lane prints as it goes; the background lane prints at the end
  # so the two never interleave.
  [[ "$lane" != supabase ]] || show "$lane" "$group_name" "$name" "$result" "$seconds" "$log"
  return $status
}

# A check failing is recorded and the group carries on. A setup step failing
# skips the rest of its group (lane_setup: the rest of the lane), because those
# checks would test the wrong state.
check() { run "$@"; }
setup() { run "$@" || group_ok=false; }
lane_setup() { run "$@" || { group_ok=false; lane_ok=false; }; }

# Prints one finished step: collapsed in CI when it passed, in full when not.
show() {
  local lane="$1" group="$2" name="$3" result="$4" seconds="$5" log="$6"
  local title="$result  $group / $name (${seconds}s)"
  if [[ "$result" == PASS ]]; then
    if in_ci; then echo "::group::$title"; cat "$log"; echo "::endgroup::"; else echo "$title"; fi
  else
    if in_ci; then echo "::error title=db $result::$group / $name"; fi
    echo "---- $title"
    cat "$log"
    echo "---- end of $name"
  fi
}

show_lane() {
  awk -F'\t' -v lane="$1" '$1 == lane' "$results" |
    while IFS=$'\t' read -r lane group name result seconds log; do
      show "$lane" "$group" "$name" "$result" "$seconds" "$log"
    done
}

summary_rows() {
  for lane in supabase plain; do
    awk -F'\t' -v lane="$lane" -v format="$1" '$1 == lane { printf format, $4, $1, $2, $3, $5 }' "$results"
  done
}

# ---------------------------------------------------------------- Supabase lane

psql_supabase() { psql -X -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
sql() { psql_supabase -f "scripts/$1"; }
migration() { psql_supabase -f "supabase/migrations/$1"; }
sql_step() { check supabase "$2" sql "$1"; }

# Was part of the Olivia 1B workflow: a lone "$" delimiter must never close a
# DO block in these files.
olivia_sql_delimiters() {
  python3 - <<'PY'
from pathlib import Path
bad = {'DO ' + chr(36), 'END ' + chr(36) + ';'}
paths = (
    'scripts/olivia-pr1b-rls.sql',
    'supabase/migrations/20261014000061_olivia_availability_batch.sql',
    'supabase/migrations/20261014000062_olivia_coverage_concurrency.sql',
    'supabase/migrations/20261014000063_olivia_qualification_concurrency.sql',
)
for path in paths:
    lines = Path(path).read_text().splitlines()
    assert all(line.strip() not in bad for line in lines), f'Bad SQL block in {path}'
print('No lone-dollar DO/END delimiters in', len(paths), 'files')
PY
}

restore_newest_toast_importer() {
  migration 20261103000141_toast_organized_keys.sql &&
    migration 20261103000145_toast_more_organized_fields.sql &&
    migration 20261103000146_toast_fill_in_steps.sql &&
    migration 20261104000147_toast_fill_hash_joins.sql
}

supabase_lane() {
  group "Static"
  check supabase "Olivia SQL block delimiters" olivia_sql_delimiters

  group "App and security checks"
  sql_step rls-all-public-tables.sql "Every public table has row level security"
  sql_step admin-access-migration-smoke.sql "Admin access codes: functions, trigger, privileges"
  sql_step olivia-pr1a-rls.sql "Olivia 1A scheduling: RLS, composite keys, audit"
  sql_step olivia-pr1b-rls.sql "Olivia 1B availability + Olivia 3 publication: RLS"
  sql_step olivia-pr4b-rls.sql "Olivia 4B-A scheduling command: tenant, CAS, replay"
  sql_step staff-person-input-guard-rls.sql "Staff person RPC input guard"
  sql_step staff-pr155-rls.sql "Staff workspace permissions and availability audit"
  sql_step staff-pr178-availability-rls.sql "Staff all-day availability and owner isolation"
  sql_step staff-approval-atomic.sql "Staff approvals: atomic, stale CAS, rollback"
  sql_step staff-approval-scoped.sql "Staff approvals: scoped CAS, independent approvals"
  sql_step ldi-e-db-contract.sql "Events (LDI E): canonical RPC and two-café RLS"
  sql_step morning-brief-send-window-sql-integration.sql "Morning brief per-café send window"
  sql_step whatsapp-owner-provenance-sql-integration.sql "WhatsApp owner provenance and insert RLS"
  sql_step csv-import-rls.sql "CSV import: RLS, atomic promotion, wage review"
  sql_step commitments-db-acceptance.sql "Owner reminders: scope, dedupe, recovery, due once, DST"

  group "Concurrent sessions"
  check supabase "Olivia 1A: concurrent same-key creates" bash scripts/olivia-pr1a-create-concurrency.sh
  check supabase "Olivia 1B: concurrent co-owner batches" bash scripts/olivia-pr1b-create-concurrency.sh
  check supabase "Olivia 1B: concurrent coverage creates" python3 scripts/olivia-pr1b-coverage-concurrency.py
  check supabase "Olivia 1B: concurrent qualifications" python3 scripts/olivia-pr1b-qualification-concurrency.py
  check supabase "Olivia 4B-A: two-session café locks" bash scripts/olivia-pr4b-concurrency.sh
  check supabase "CSV import: concurrent job start, re-finalize" bash scripts/csv-import-concurrency.sh
  check supabase "P1 source revisions: MVCC, rollback, RLS" env P1_DISPOSABLE_DB=1 node scripts/test-p1-source-epochs.mjs
  check supabase "P1 owner-confirmed ingredient price CAS" env P1_DISPOSABLE_DB=1 node scripts/test-supervisor-owner-input-cas.mjs
  check supabase "Supervisor durable runs across workers (Vitest)" env SUPERVISOR_RUN_DB_SANDBOX_ONLY=1 \
    SUPERVISOR_RUN_DB_URL="$supabase_url" npx vitest run lib/ai/supervisor/runs/runs.db.test.ts --reporter=verbose

  group "Toast"
  lane_setup supabase "Rebuild the database (supabase db reset)" supabase db reset --local --yes
  setup supabase "Re-apply migration 103 without dropping data" migration 20261028000103_toast_copy_backfill.sql
  sql_step toast-db-integration.sql "Isolation, rollback and lease"
  sql_step toast-pr1-sql-integration.sql "PR1 atomic import and RLS"
  sql_step toast-pr2-sql-integration.sql "PR2 atomic coverage and post-commit retry"
  sql_step toast-pr3-sql-integration.sql "PR3 owner flags and failed-run recovery"
  sql_step toast-pr-h-sql-integration.sql "H owner summary, modes, budgets, closeout"
  sql_step toast-pos-copy-sql-integration.sql "Migration 101 catalog and nullable wages"
  sql_step toast-raw-sample-sql-integration.sql "Raw sample RPC, isolation, cooldown"
  sql_step toast-archive-incremental-sql-integration.sql "Re-imports store only new or changed records"
  sql_step toast-archive-identical-copies-sql-integration.sql "Identical archive copies removed"
  sql_step toast-one-record-sql-integration.sql "One record per order and the change log"
  setup supabase "Restore the newest day importer (141, 145-147)" restore_newest_toast_importer
  sql_step toast-organized-keys-sql-integration.sql "Organized tables: one row per line and refund"
  sql_step data-health-sql-integration.sql "Daily data health check"
  sql_step toast-one-object-sql-integration.sql "One record per staged object"
  sql_step pos0b-staff-labor-sql-integration.sql "POS0b labor revisions, RLS and tenant isolation"
  sql_step toast-messy-import-sql-integration.sql "Messy days store one clean import"
  sql_step toast-organized-fields-sql-integration.sql "Item timing, payment server, service charges"
  sql_step ai-toast-records-sql-integration.sql "The AI can read every Toast field"
  sql_step toast-live-archive-sql-integration.sql "Today's orders kept once, hidden until import"
  sql_step toast-removed-discounts-sql-integration.sql "Removed discounts are not counted"
  sql_step ai-data-query-distinct-sql-integration.sql "Toast cents, counts and screen/query parity"
  check supabase "Test café copy against real PostgreSQL" env SYNC_TEST_DB_URL="$supabase_url" node scripts/sync-cafe-data-db-integration.mjs

  group "Supervisor migration 102"
  setup supabase "Re-apply migration 102 (idempotent)" migration 20261027000102_supervisor_all_data.sql
  sql_step toast-pos-copy-sql-integration.sql "Migration 101 invariants after the 102 re-run"
  sql_step supervisor-all-data-db-integration.sql "Financial columns, uniqueness, tenants, grants"
  sql_step supervisor-all-data-schema-check.sql "Read-only schema inventory"
}

# ------------------------------------------------------ Plain PostgreSQL lane

# plain_pg DATABASE COMMAND... : runs COMMAND against a new, empty PostgreSQL 16
# on 127.0.0.1:5432 (PG* variables set), then removes the container.
plain_pg() {
  local database="$1"
  shift
  docker rm -f "$plain_container" >/dev/null 2>&1 || true
  docker run -d --rm --name "$plain_container" -p 127.0.0.1:5432:5432 \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$database" \
    --tmpfs /var/lib/postgresql/data "$plain_image" >/dev/null || return 1
  local tries=0
  until pg_isready -q -h 127.0.0.1 -p 5432 -U postgres -d "$database"; do
    tries=$((tries + 1))
    if [[ $tries -gt 120 ]]; then
      echo "PostgreSQL 16 did not start"
      docker logs "$plain_container" 2>&1 | tail -20
      docker rm -f "$plain_container" >/dev/null 2>&1
      return 1
    fi
    sleep 0.25
  done
  local status=0
  PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres PGDATABASE="$database" "$@" || status=$?
  docker rm -f "$plain_container" >/dev/null 2>&1 || true
  return $status
}

pull_plain_image() {
  if docker image inspect "$plain_image" >/dev/null 2>&1; then
    echo "Already downloaded: $plain_image"
    return 0
  fi
  local attempt
  for attempt in 1 2 3; do
    docker pull -q "$plain_image" && return 0
    sleep $((attempt * 5))
  done
  return 1
}

plain_lane() {
  group "Plain PostgreSQL 16"
  lane_setup plain "Download PostgreSQL 16 image" pull_plain_image
  check plain "Menu price approval: transaction and concurrency" plain_pg postgres node scripts/test-approval-price-cas-db.mjs
  check plain "Revisioned approval edit and stale transactions" plain_pg postgres node scripts/test-approval-lifecycle-db.mjs
  check plain "Menu add-ons and combos" plain_pg postgres node scripts/test-menu-options-db.mjs
  check plain "Pantry migration and scoped writes" plain_pg postgres node scripts/test-pantry-db.mjs
  check plain "Inventory purchases (PR G) and tenant RLS" plain_pg pr_g_inventory node scripts/test-pr-g-inventory-db.mjs
  check plain "Team updates: owner-only read, status-only update" plain_pg postgres node scripts/test-team-updates-rls.mjs
  check plain "Owner notifications migration 36 security" plain_pg cafe_rls_test node scripts/test-ai-notifications-migration.mjs
  check plain "Supervisor conversations RLS" plain_pg cafe_rls_test node scripts/test-supervisor-conversation-rls.mjs
  check plain "Owner facts (migrations 110, 153) Vitest" plain_pg ownerfacts_test \
    env OWNER_FACTS_DB_URL="postgresql://postgres:postgres@127.0.0.1:5432/ownerfacts_test" npx vitest run lib/ownerFacts
}

# ----------------------------------------------------------------------- main

if ! pg_isready -q -h 127.0.0.1 -p 54322 -U postgres; then
  echo "Local Supabase is not running on 127.0.0.1:54322. Start it with: supabase start" >&2
  exit 1
fi
if pg_isready -q -h 127.0.0.1 -p 5432; then
  echo "Port 5432 is already in use; the plain PostgreSQL tests need it free." >&2
  exit 1
fi

started="$(now_ms)"
plain_lane &
plain_pid=$!
supabase_lane
wait "$plain_pid"
show_lane plain

total="$(awk -v ms="$(($(now_ms) - started))" 'BEGIN { printf "%.0f", ms / 1000 }')"
passed=$(awk -F'\t' '$4 == "PASS"' "$results" | wc -l | tr -d ' ')
failed=$(awk -F'\t' '$4 != "PASS"' "$results" | wc -l | tr -d ' ')
echo
echo "Database tests: $passed passed, $failed failed or skipped, ${total}s (both lanes run at the same time)"
summary_rows '%-5s %-8s %-26s %s (%ss)\n'
if in_ci && [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Database tests: $passed passed, $failed failed or skipped (${total}s)"
    echo
    echo "| Result | Lane | Group | Step | Seconds |"
    echo "| --- | --- | --- | --- | --- |"
    summary_rows '| %s | %s | %s | %s | %s |\n'
  } >>"$GITHUB_STEP_SUMMARY"
fi
[[ $failed -eq 0 ]]
