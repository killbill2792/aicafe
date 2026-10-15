#!/usr/bin/env python3
"""Disposable PostgreSQL coverage concurrency: two co-owner sessions/different keys."""
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

DB = ["psql", "-h", "127.0.0.1", "-p", "54322", "-U", "postgres",
      "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"]
ENV = {**os.environ, "PGPASSWORD": "postgres"}
owner = "eb955555-5555-4555-8555-111111111111"
coowner = "eb955555-5555-4555-8555-222222222222"
business = "eb966666-6666-4666-8666-666666666666"
location = "eb977777-7777-4777-8777-777777777777"
key1 = "eb988888-8888-4888-8888-111111111111"
key2 = "eb988888-8888-4888-8888-222222222222"

def sql(code, check=True):
    result = subprocess.run(DB, input=code, text=True, capture_output=True, env=ENV)
    if check and result.returncode:
        raise AssertionError(result.stderr + result.stdout)
    return result

sql(f"""
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES ('{owner}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','coverage-1@example.invalid','',now(),now()),
       ('{coowner}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','coverage-2@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo) VALUES('{business}','Coverage concurrency disposable',false);
INSERT INTO public.memberships(business_id,user_id,role)
 VALUES('{business}','{owner}','owner'),('{business}','{coowner}','owner');
INSERT INTO public.locations(id,business_id,name) VALUES('{location}','{business}','Disposable Location');
""")

def create(actor, key, provenance, headcount=1, day=3):
    return sql(f"""
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','{actor}',true);
SELECT public.scheduling_create_foundation('{business}'::uuid,'coverage','{key}'::uuid,
 jsonb_build_object('location_id','{location}','day_of_week',{day},
 'effective_from','2026-11-01','start_local','08:00','end_local','12:00',
 'overnight',false,'min_headcount',{headcount},'min_overlap_minutes',0,
 'priority','required','source','{provenance}','confirmation','unconfirmed'));
-- Hold the winning row/index key lock while the second real connection
-- attempts its INSERT; do not merely run two sequential requests.
SELECT pg_sleep(2);
COMMIT;
""", check=False)

with ThreadPoolExecutor(max_workers=2) as pool:
    a = pool.submit(create, owner, key1, "owner_direct")
    b = pool.submit(create, coowner, key2, "worker_reported_by_owner")
    first, second = a.result(), b.result()
success = [x for x in (first, second) if x.returncode == 0]
failure = [x for x in (first, second) if x.returncode != 0]
assert len(success) == len(failure) == 1, (
    f"Expected exactly one winner: {first.returncode}/{second.returncode}\n"
    f"{first.stderr}{second.stderr}")
assert "scheduling_coverage_identity_unique" in failure[0].stderr, failure[0].stderr
assert '"id"' in success[0].stdout, success[0].stdout

def counts():
    return sql(f"""SELECT
     (SELECT count(*) FROM public.scheduling_coverage_requirements WHERE business_id='{business}'),
     (SELECT count(*) FROM public.scheduling_foundation_create_receipts WHERE business_id='{business}'),
     (SELECT count(*) FROM public.scheduling_foundation_audit_events WHERE business_id='{business}'
       AND table_name='scheduling_coverage_requirements' AND operation='INSERT');""").stdout.strip()

assert counts() == "1|1|1", counts()
winner = (owner, key1, "owner_direct") if first.returncode == 0 else (
    coowner, key2, "worker_reported_by_owner")
retry = create(*winner)
assert retry.returncode == 0 and '"replayed": true' in retry.stdout, retry.stderr + retry.stdout
assert counts() == "1|1|1", counts()

assert create(owner, "eb988888-8888-4888-8888-333333333333",
              "owner_direct", headcount=2).returncode == 0
assert create(owner, "eb988888-8888-4888-8888-444444444444",
              "owner_direct", day=4).returncode == 0
assert counts() == "3|3|3", counts()

sql(f"DELETE FROM public.businesses WHERE id='{business}';")
sql(f"DELETE FROM auth.users WHERE id IN ('{owner}','{coowner}');")
print("PASS: two real connections; one winner, one duplicate rejection, correct audit/replay/distinct coverage")
