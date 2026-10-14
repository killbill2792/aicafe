#!/usr/bin/env bash
# Only run against the disposable local Supabase started by the PR workflow.
set -euo pipefail
export PGPASSWORD=postgres
db=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq)
owner="ed911111-1111-4111-8111-111111111111"
co_owner="ed911111-1111-4111-8111-222222222222"
business="ed922222-2222-4222-8222-222222222222"
employee="ed933333-3333-4333-8333-333333333333"
same_key="ed944444-4444-4444-8444-444444444444"
distinct_key="ed955555-5555-4555-8555-555555555555"

"${db[@]}" <<SQL
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES ('$owner','00000000-0000-0000-0000-000000000000','authenticated',
 'authenticated','olivia-pr1a-concurrency@example.invalid','',now(),now()),
 ('$co_owner','00000000-0000-0000-0000-000000000000','authenticated',
 'authenticated','olivia-pr1a-concurrent-coowner@example.invalid','',now(),now());
INSERT INTO businesses(id,name,is_demo) VALUES ('$business','Olivia Concurrent Create Test',false);
INSERT INTO memberships(business_id,user_id,role) VALUES
 ('$business','$owner','owner'),('$business','$co_owner','owner');
INSERT INTO employees(id,business_id,display_name,active)
VALUES ('$employee','$business','Concurrency staff',true);
SQL

# Both independent authenticated Postgres sessions try the SAME request key
# concurrently. Unique receipt serializes winner and replays its original ID.
create() {
 local key="$1" start="$2" actor="${3:-$owner}"
 "${db[@]}" <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','$actor',true);
SELECT public.scheduling_create_foundation(
 '$business'::uuid,'availability_rule','$key'::uuid,
 jsonb_build_object('employee_id','$employee','day_of_week',3,
   'start_local','$start','end_local','11:00','overnight',false,
   'effective_from','2026-10-14','source','owner_direct',
   'confirmation','owner_confirmed')
 )->>'id';
COMMIT;
SQL
}
tmp1="$(mktemp)"
tmp2="$(mktemp)"
trap 'rm -f "$tmp1" "$tmp2"' EXIT
create "$same_key" "07:00" > "$tmp1" &
p1=$!
create "$same_key" "07:00" "$co_owner" > "$tmp2" &
p2=$!
wait "$p1"
wait "$p2"
# set_config also emits the owner UUID. The final SELECT result is second line.
first="$(grep -E '^[-a-f0-9]{36}$' "$tmp1" | tail -n1)"
second="$(grep -E '^[-a-f0-9]{36}$' "$tmp2" | tail -n1)"
if [[ -z "$first" || "$first" != "$second" ]]; then
 echo "Concurrent same-key RPC created different IDs" >&2; exit 1
fi
counts=$("${db[@]}" -c "SELECT
 (SELECT count(*) FROM scheduling_foundation_create_receipts WHERE business_id='$business'),
 (SELECT count(*) FROM staff_availability_rules WHERE business_id='$business'),
 (SELECT count(*) FROM scheduling_foundation_audit_events
   WHERE business_id='$business' AND operation='INSERT');")
if [[ "$counts" != "1|1|1" ]]; then
 echo "Concurrent create duplicated receipt, record or audit: $counts" >&2; exit 1
fi

# Identical content with DIFFERENT request identity is legitimate distinct work.
create "$distinct_key" "07:00" > "$tmp1"
third="$(grep -E '^[-a-f0-9]{36}$' "$tmp1" | tail -n1)"
if [[ "$third" == "$first" || -z "$third" ]]; then
 echo "Distinct client operations were incorrectly deduplicated" >&2; exit 1
fi
counts=$("${db[@]}" -c "SELECT
 (SELECT count(*) FROM scheduling_foundation_create_receipts WHERE business_id='$business'),
 (SELECT count(*) FROM staff_availability_rules WHERE business_id='$business'),
 (SELECT count(*) FROM scheduling_foundation_audit_events
   WHERE business_id='$business' AND operation='INSERT');")
if [[ "$counts" != "2|2|2" ]]; then
 echo "Distinct-key create did not insert exactly once: $counts" >&2; exit 1
fi
"${db[@]}" -c "DELETE FROM businesses WHERE id='$business';"
"${db[@]}" -c "DELETE FROM auth.users WHERE id IN ('$owner','$co_owner');"
echo "Concurrent independent co-owner sessions: same-key replay, distinct-key create and one-audit invariant passed"
