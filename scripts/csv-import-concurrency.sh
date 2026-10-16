#!/usr/bin/env bash
# Only run against the disposable local Supabase started by the PR workflow.
set -euo pipefail
export PGPASSWORD=postgres
db=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq)
owner="ed9aaaaa-1111-4111-8111-111111111111"
business="ed9bbbbb-2222-4222-8222-222222222222"

"${db[@]}" <<SQL
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES ('$owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'csv-import-concurrency@example.invalid','',now(),now());
INSERT INTO businesses(id,name,is_demo) VALUES ('$business','CSV Import Concurrency Test',false);
INSERT INTO memberships(business_id,user_id,role) VALUES ('$business','$owner','owner');
SQL

# Two independent sessions race to start a 'sales' import job for the SAME business at the same
# time — the active-job partial unique index (csv_import_jobs_active_unique), not a disabled React
# button, must let exactly one succeed.
start_job() {
 local fingerprint="$1"
 "${db[@]}" <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','$owner',true);
INSERT INTO csv_import_jobs(business_id,kind,status,content_fingerprint,rows_in_file,group_count)
VALUES ('$business'::uuid,'sales','processing','$fingerprint',10,5)
RETURNING 'ok';
COMMIT;
SQL
}
tmp1="$(mktemp)"
tmp2="$(mktemp)"
trap 'rm -f "$tmp1" "$tmp2"' EXIT
( start_job "fp-race-1" > "$tmp1" 2>&1 ) &
p1=$!
( start_job "fp-race-2" > "$tmp2" 2>&1 ) &
p2=$!
wait "$p1" || true
wait "$p2" || true

ok_count=0
grep -q '^ok$' "$tmp1" && ok_count=$((ok_count + 1))
grep -q '^ok$' "$tmp2" && ok_count=$((ok_count + 1))
if [[ "$ok_count" != "1" ]]; then
  echo "Expected exactly one concurrent job start to succeed, got $ok_count" >&2
  cat "$tmp1" "$tmp2" >&2
  exit 1
fi

processing_count=$("${db[@]}" -c "SELECT count(*) FROM csv_import_jobs WHERE business_id='$business' AND status='processing';")
if [[ "$processing_count" != "1" ]]; then
  echo "Expected exactly one processing job to exist, found $processing_count" >&2
  exit 1
fi

# A job already finalized must be safely re-finalizable (idempotent) by two concurrent callers —
# csv_finalize_sales_job only ever acts on groups not yet marked promoted.
job_id=$("${db[@]}" -c "SELECT id FROM csv_import_jobs WHERE business_id='$business' AND status='processing' LIMIT 1;")
"${db[@]}" <<SQL
INSERT INTO csv_sales_import_groups(job_id,business_id,business_date,item_name,quantity,net_sales_cents,source_row_count)
VALUES ('$job_id','$business','2026-08-22','Latte',3,1500,3);
SQL

finalize() {
 "${db[@]}" <<SQL
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','$owner',true);
SELECT * FROM csv_finalize_sales_job('$job_id'::uuid);
SQL
}
finalize > "$tmp1" &
f1=$!
finalize > "$tmp2" &
f2=$!
wait "$f1" || true
wait "$f2" || true

order_count=$("${db[@]}" -c "SELECT count(*) FROM orders WHERE business_id='$business' AND pos_order_id='csv-2026-08-22-Latte';")
if [[ "$order_count" != "1" ]]; then
  echo "Expected exactly one order from concurrent finalize calls, found $order_count" >&2
  exit 1
fi
net_cents=$("${db[@]}" -c "SELECT net_sales_cents FROM orders WHERE business_id='$business' AND pos_order_id='csv-2026-08-22-Latte';")
if [[ "$net_cents" != "1500" ]]; then
  echo "Concurrent re-finalize corrupted the total: expected 1500, got $net_cents" >&2
  exit 1
fi

"${db[@]}" -c "DELETE FROM businesses WHERE id='$business';"
"${db[@]}" -c "DELETE FROM auth.users WHERE id='$owner';"
echo "Concurrent job-start exclusivity and idempotent re-finalize invariants passed"
