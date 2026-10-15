#!/usr/bin/env python3
"""Disposable PostgreSQL: two real co-owners with distinct receipt request keys."""
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

DB = ["psql", "-h", "127.0.0.1", "-p", "54322", "-U", "postgres",
      "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"]
ENV = {**os.environ, "PGPASSWORD": "postgres"}
owner = "eaa11111-1111-4111-8111-111111111111"
coowner = "eaa11111-1111-4111-8111-222222222222"
business = "eaa22222-2222-4222-8222-222222222222"
employee = "eaa33333-3333-4333-8333-333333333333"

def sql(query, check=True):
    p = subprocess.run(DB, input=query, text=True, capture_output=True, env=ENV)
    if check and p.returncode:
        raise AssertionError(p.stderr + p.stdout)
    return p

sql(f"""
INSERT INTO auth.users(id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES ('{owner}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qual-race-1@example.invalid','',now(),now()),
       ('{coowner}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qual-race-2@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo) VALUES('{business}','Qualification concurrency disposable',false);
INSERT INTO public.memberships(business_id,user_id,role)
 VALUES('{business}','{owner}','owner'),('{business}','{coowner}','owner');
INSERT INTO public.employees(id,business_id,display_name,active)
 VALUES('{employee}','{business}','Qualification Test Employee',true);
""")

def create(actor, key, kind, record):
    return sql(f"""
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','{actor}',true);
SELECT public.scheduling_create_foundation('{business}'::uuid,'{kind}',
 '{key}'::uuid,'{record}'::jsonb);
SELECT pg_sleep(1);
COMMIT;
""", check=False)

def concurrent(left, right, constraint):
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(create, *left)
        b = pool.submit(create, *right)
        results = [a.result(), b.result()]
    winners = [x for x in results if x.returncode == 0]
    losers = [x for x in results if x.returncode != 0]
    assert len(winners) == len(losers) == 1, (
        f"Expected one winner and one conflict: {[(x.returncode,x.stderr) for x in results]}")
    assert constraint in losers[0].stderr, losers[0].stderr
    return winners[0]

kind_a = '{"code":"espresso_lead_a","display_name":"Espresso Lead","active":true}'
kind_b = '{"code":"espresso_lead_b","display_name":"espresso lead","active":true}'
winner = concurrent(
    (owner, "eaa44444-4444-4444-8444-111111111111", "qualification_type", kind_a),
    (coowner, "eaa44444-4444-4444-8444-222222222222", "qualification_type", kind_b),
    "scheduling_qualification_type_label_unique")
assert '"id"' in winner.stdout, winner.stdout
code = sql(f"""SELECT code FROM public.scheduling_qualification_types
 WHERE business_id='{business}';""").stdout.strip()
assert code in ("espresso_lead_a", "espresso_lead_b"), code

def assignment(source):
    return ('{"employee_id":"' + employee + '","location_id":null,'
            '"qualification_code":"' + code + '","valid_from":"2026-11-01",'
            '"valid_to":null,"source":"' + source + '","confirmation":"unconfirmed"}')

concurrent(
    (owner, "eaa55555-5555-4555-8555-111111111111", "qualification", assignment("owner_direct")),
    (coowner, "eaa55555-5555-4555-8555-222222222222", "qualification", assignment("worker_reported_by_owner")),
    "staff_qualification_assignment_unique")
counts = sql(f"""SELECT
 (SELECT count(*) FROM public.scheduling_qualification_types WHERE business_id='{business}'),
 (SELECT count(*) FROM public.staff_qualifications WHERE business_id='{business}'),
 (SELECT count(*) FROM public.scheduling_foundation_create_receipts WHERE business_id='{business}'),
 (SELECT count(*) FROM public.scheduling_foundation_audit_events WHERE business_id='{business}');""").stdout.strip()
assert counts == "1|1|2|2", counts

different = assignment("owner_direct").replace("2026-11-01", "2027-01-01")
added = create(owner, "eaa66666-6666-4666-8666-111111111111", "qualification", different)
assert added.returncode == 0, added.stderr
assert sql(f"SELECT count(*) FROM public.staff_qualifications WHERE business_id='{business}';").stdout.strip() == "2"

sql(f"DELETE FROM public.businesses WHERE id='{business}';")
sql(f"DELETE FROM auth.users WHERE id IN ('{owner}','{coowner}');")
print("PASS: distinct-key co-owners cannot duplicate qualification types or assignments; different date accepted")
