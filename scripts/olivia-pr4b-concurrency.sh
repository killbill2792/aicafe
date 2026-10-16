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
INSERT INTO public.staff_availability_rules(
 business_id,employee_id,location_id,day_of_week,start_local,end_local,
 overnight,effective_from,effective_to,source,confirmation)
VALUES ('$business_b','$employee_b',NULL,1,'08:00','12:00',false,
 '2026-11-02',NULL,'owner_direct','unconfirmed');
UPDATE public.employees SET display_name='Test B updated' WHERE id='$employee_b';
COMMIT;
SQL

# Session C: ordinary same-café availability INSERT must not slip into the
# protected source window. A short lock_timeout fails deliberately.
if "${PSQL[@]}" >"$workdir/same.log" 2>&1 <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL lock_timeout='500ms';
SELECT set_config('request.jwt.claim.sub','$owner',true);
INSERT INTO public.staff_availability_rules(
 business_id,employee_id,location_id,day_of_week,start_local,end_local,
 overnight,effective_from,effective_to,source,confirmation)
VALUES ('$business_a','$employee_a',NULL,2,'08:00','12:00',false,
 '2026-11-02',NULL,'owner_direct','unconfirmed');
COMMIT;
SQL
then
  echo "Same-café write bypassed the source lock"; exit 1
fi
if ! grep -q 'lock timeout' "$workdir/same.log"; then
  echo "Same-café failure was not a lock timeout"; cat "$workdir/same.log"; exit 1
fi

wait "$holder_pid" || { cat "$workdir/holder.log"; exit 1; }
holder_pid=''
# Once the owner RPC transaction ends, previously blocked same-café writes
# succeed and are included in the next source token.
"${PSQL[@]}" <<SQL
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','$owner',true);
INSERT INTO public.staff_availability_rules(
 business_id,employee_id,location_id,day_of_week,start_local,end_local,
 overnight,effective_from,effective_to,source,confirmation)
VALUES ('$business_a','$employee_a',NULL,2,'08:00','12:00',false,
 '2026-11-02',NULL,'owner_direct','unconfirmed');
COMMIT;
SQL
echo 'Olivia PR4B-A concurrent two-session source locking: same café serialized, other café progressed'
