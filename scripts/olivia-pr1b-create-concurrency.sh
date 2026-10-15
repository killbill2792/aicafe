#!/usr/bin/env bash
set -euo pipefail
export PGPASSWORD=postgres
db=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq)
owner=eb911111-1111-4111-8111-111111111111
coowner=eb911111-1111-4111-8111-222222222222
business=eb922222-2222-4222-8222-222222222222
employee=eb933333-3333-4333-8333-333333333333
key=eb944444-4444-4444-8444-444444444444
"${db[@]}" <<SQL
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES ('$owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia1b-concurrent@example.invalid','',now(),now()),
 ('$coowner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','olivia1b-coowner-concurrent@example.invalid','',now(),now());
INSERT INTO businesses(id,name,is_demo) VALUES ('$business','PR1B Parallel Owners',false);
INSERT INTO memberships(business_id,user_id,role) VALUES
 ('$business','$owner','owner'),('$business','$coowner','owner');
INSERT INTO employees(id,business_id,display_name,active)
 VALUES ('$employee','$business','Parallel Test',true);
SQL
submit() {
 local actor="$1"
 "${db[@]}" <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','$actor',true);
SELECT public.scheduling_save_availability_batch(
 '$business'::uuid,'$employee'::uuid,NULL,'availability_rule',
 '{"effective_from":"2026-10-14","effective_to":null}'::jsonb,
 '[]'::jsonb,
 jsonb_build_array(
  jsonb_build_object('data',jsonb_build_object(
   'employee_id','$employee','day_of_week',3,
   'start_local','07:00','end_local','11:00','overnight',false,
   'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed')),
  jsonb_build_object('data',jsonb_build_object(
   'employee_id','$employee','day_of_week',3,
   'start_local','16:00','end_local','20:00','overnight',false,
   'effective_from','2026-10-14','source','owner_direct','confirmation','owner_confirmed'))
 ),'$key'::uuid);
COMMIT;
SQL
}
a="$(mktemp)";b="$(mktemp)"
trap 'rm -f "$a" "$b"' EXIT
submit "$owner" > "$a" &
p1=$!
submit "$coowner" > "$b" &
p2=$!
wait "$p1";wait "$p2"
grep -q '"replayed":' "$a"
grep -q '"replayed":' "$b"
# A unique (tenant,request-key) receipt protects both operations and audit.
counts=$("${db[@]}" -c "SELECT
 (SELECT count(*) FROM scheduling_availability_batch_receipts WHERE business_id='$business'),
 (SELECT count(*) FROM staff_availability_rules WHERE business_id='$business'),
 (SELECT count(*) FROM scheduling_foundation_audit_events
  WHERE business_id='$business' AND table_name='staff_availability_rules'
    AND operation='INSERT');")
if [[ "$counts" != '1|2|2' ]]; then
 echo "Concurrent co-owner batch duplicate/partial result: $counts" >&2;exit 1
fi
"${db[@]}" -c "DELETE FROM businesses WHERE id='$business';"
"${db[@]}" -c "DELETE FROM auth.users WHERE id IN ('$owner','$coowner');"
echo "Olivia PR1B concurrent co-owner full-set RPC: one receipt, two windows, two audits"
