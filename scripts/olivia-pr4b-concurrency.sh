#!/usr/bin/env bash
# PR4B-A disposable Postgres inter-session test. No production connections.
set -euo pipefail
export PGPASSWORD="${PGPASSWORD:-postgres}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres)
uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
business_a=$(uuid)
business_b=$(uuid)
owner=$(uuid)
employee_a=$(uuid)
employee_c=$(uuid)
employee_b=$(uuid)
workdir=$(mktemp -d)
holder_pid=''
cleanup() {
  if [[ -n "$holder_pid" ]]; then kill "$holder_pid" 2>/dev/null || true; wait "$holder_pid" 2>/dev/null || true; fi
  rm -rf "$workdir"
}
trap cleanup EXIT

"${PSQL[@]}" <<SQL
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES ('$owner','00000000-0000-0000-0000-000000000000','authenticated',
'authenticated','pr4b-concurrency-$owner@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo,timezone)
VALUES ('$business_a','PR4B A',false,'America/Los_Angeles'),
       ('$business_b','PR4B B',false,'America/Los_Angeles');
INSERT INTO public.memberships(business_id,user_id,role)
VALUES ('$business_a','$owner','owner'),('$business_b','$owner','owner');
INSERT INTO public.employees(id,business_id,display_name,active)
VALUES ('$employee_a','$business_a','Test A',true),
       ('$employee_c','$business_a','Test A other worker',true),
       ('$employee_b','$business_b','Test B',true);
SQL

# Session A: run the actual owner-only Olivia RPC and keep its transaction open.
# Its café-scoped advisory lock must outlive the RPC result through COMMIT.
"${PSQL[@]}" >"$workdir/holder.log" 2>&1 <<SQL &
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','$owner',true);
SELECT public.scheduling_olivia_commit_availability(
 '$business_a'::uuid,public.scheduling_owner_source_token('$business_a'::uuid),
 gen_random_uuid(),jsonb_build_array(jsonb_build_object(
 'kind','availability_exception','employeeId','$employee_a',
 'locationId',NULL,'scope',jsonb_build_object('local_date','2026-11-02'),
 'expected','[]'::jsonb,'desired','[]'::jsonb,'requestKey',gen_random_uuid()
 )));
\! touch "$workdir/locked"
SELECT pg_sleep(9);
COMMIT;
SQL
holder_pid=$!
for i in {1..60}; do
  if [[ -f "$workdir/locked" ]]; then break; fi
  if ! kill -0 "$holder_pid" 2>/dev/null; then cat "$workdir/holder.log"; exit 1; fi
  sleep 0.1
done
if [[ ! -f "$workdir/locked" ]]; then echo "Olivia holder did not acquire lock"; cat "$workdir/holder.log"; exit 1; fi
if grep -q '"error"' "$workdir/holder.log"; then cat "$workdir/holder.log"; exit 1; fi

# Session B: a normal INSERT in another café must finish before A commits.
timeout 5s "${PSQL[@]}" >"$workdir/other.log" 2>&1 <<SQL || { cat "$workdir/other.log"; exit 1; }
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','$owner',true);
SELECT public.scheduling_save_availability_batch(
 '$business_b'::uuid,'$employee_b'::uuid,NULL::uuid,
 'availability_rule',
 jsonb_build_object('effective_from','2026-11-02','effective_to',NULL),
 '[]'::jsonb,
 jsonb_build_array(jsonb_build_object('data',jsonb_build_object(
   'employee_id','$employee_b','location_id',NULL,'day_of_week',1,
   'start_local','08:00','end_local','12:00','overnight',false,
   'effective_from','2026-11-02','effective_to',NULL,
   'source','owner_direct','confirmation','unconfirmed'))),
 gen_random_uuid());
COMMIT;
SQL

# Session C: normal PR1B batch for a DIFFERENT worker in the same café
# must fail fast rather than deadlocking on PR3-style lock ordering.
if "${PSQL[@]}" >"$workdir/same.log" 2>&1 <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL lock_timeout='1000ms';
SELECT set_config('request.jwt.claim.sub','$owner',true);
SELECT public.scheduling_save_availability_batch(
 '$business_a'::uuid,'$employee_c'::uuid,NULL::uuid,
 'availability_rule',
 jsonb_build_object('effective_from','2026-11-02','effective_to',NULL),
 '[]'::jsonb,
 jsonb_build_array(jsonb_build_object('data',jsonb_build_object(
   'employee_id','$employee_c','location_id',NULL,'day_of_week',2,
   'start_local','08:00','end_local','12:00','overnight',false,
   'effective_from','2026-11-02','effective_to',NULL,
   'source','owner_direct','confirmation','unconfirmed'))),
 gen_random_uuid());
COMMIT;
SQL
then
  echo "Same-café write bypassed the source lock"; exit 1
fi
if ! grep -q 'Olivia scheduling source is busy; retry' "$workdir/same.log"; then
  echo "Same-café guard did not reject overlapping source write"; cat "$workdir/same.log"; exit 1
fi

wait "$holder_pid" || { cat "$workdir/holder.log"; exit 1; }
holder_pid=''
# Once the owner RPC transaction ends, previously blocked same-café writes
# succeed and are included in the next source token.
"${PSQL[@]}" <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','$owner',true);
SELECT public.scheduling_save_availability_batch(
 '$business_a'::uuid,'$employee_c'::uuid,NULL::uuid,
 'availability_rule',
 jsonb_build_object('effective_from','2026-11-02','effective_to',NULL),
 '[]'::jsonb,
 jsonb_build_array(jsonb_build_object('data',jsonb_build_object(
   'employee_id','$employee_c','location_id',NULL,'day_of_week',2,
   'start_local','08:00','end_local','12:00','overnight',false,
   'effective_from','2026-11-02','effective_to',NULL,
   'source','owner_direct','confirmation','unconfirmed'))),
 gen_random_uuid());
COMMIT;
SQL
echo 'Olivia PR4B-A concurrent sessions: same café rejected safely, other café progressed, retry succeeded'
