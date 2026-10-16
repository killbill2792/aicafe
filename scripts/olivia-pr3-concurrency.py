#!/usr/bin/env python3
"""Olivia-only disposable PostgreSQL PR3 real-connection concurrency verification.

Uses two co-owner database connections, DIFFERENT request keys and held
transactions. Never connect to staging/production. Database port is deliberately
fixed to the Supabase CLI disposable local port.
"""
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

DB = ["psql", "-h", "127.0.0.1", "-p", "54322", "-U", "postgres",
      "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"]
ENV = {**os.environ, "PGPASSWORD": "postgres"}
business, other_business = str(uuid4()), str(uuid4())
owner, coowner, outsider = str(uuid4()), str(uuid4()), str(uuid4())
employee, location, other_location = str(uuid4()), str(uuid4()), str(uuid4())
series1, series2, revision1, revision2 = (str(uuid4()) for _ in range(4))
week1, week2 = "2099-03-02", "2099-03-09"
source = ""

def sql(statement):
    result = subprocess.run(DB, input=statement, text=True,
                            capture_output=True, env=ENV, timeout=90)
    if result.returncode:
        raise AssertionError(result.stderr + "\n" + result.stdout)
    return result.stdout.strip()

def transaction_rpc(function, actor, revision, key, hold=False):
    # Each invocation opens an independent Postgres connection. Waiting inside
    # the transaction after the effect holds all row/advisory locks to force
    # the other co-owner to race rather than execute sequentially.
    statement = f"""
BEGIN;
SELECT public.{function}('{business}'::uuid,'{actor}'::uuid,
 '{revision}'::uuid,1,repeat('a',64),'{source}', '{key}'::uuid);
{"SELECT pg_sleep(1.5);" if hold else ""}
COMMIT;
"""
    output = sql(statement)
    lines = [line for line in output.splitlines() if line.startswith("{")]
    assert len(lines) == 1, f"Unexpected RPC response: {output}"
    return json.loads(lines[0])

try:
    sql(f"""
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES
 ('{owner}','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'olivia-parallel-owner@example.invalid','',now(),now()),
 ('{coowner}','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'olivia-parallel-coowner@example.invalid','',now(),now()),
 ('{outsider}','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'olivia-parallel-outsider@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo,timezone) VALUES
 ('{business}','Olivia parallel disposable',false,'America/Los_Angeles'),
 ('{other_business}','Olivia other disposable',false,'America/Los_Angeles');
INSERT INTO public.memberships(business_id,user_id,role) VALUES
 ('{business}','{owner}','owner'),('{business}','{coowner}','owner'),
 ('{other_business}','{outsider}','owner');
INSERT INTO public.locations(id,business_id,name,timezone) VALUES
 ('{location}','{business}','Location A','America/Los_Angeles'),
 ('{other_location}','{other_business}','Location B','America/Los_Angeles');
INSERT INTO public.employees(id,business_id,display_name,active) VALUES
 ('{employee}','{business}','Parallel employee',true);
INSERT INTO public.scheduling_labor_rule_reviews
 (business_id,revision,profile,reviewed_by) VALUES
 ('{business}',1,jsonb_build_object('verified',true,
 'source','Reviewed disposable concurrency rule profile',
 'minRestBetweenShiftsMinutes',600,
 'overtime',jsonb_build_object('verified',true),
 'jurisdictionByLocationId',jsonb_build_object('{location}','Test region'),
 'classificationByEmployeeId',jsonb_build_object('{employee}','Hourly')),
 '{owner}');
INSERT INTO public.scheduling_plan_series
 (id,business_id,horizon_start,current_revision,created_by) VALUES
 ('{series1}','{business}','{week1}',1,'{owner}'),
 ('{series2}','{business}','{week2}',1,'{owner}');
INSERT INTO public.scheduling_plan_revisions
 (id,business_id,series_id,revision,source_digest,planner_input,scenario,created_by)
 VALUES
 ('{revision1}','{business}','{series1}',1,repeat('a',64),
  '{{"horizonStart":"{week1}"}}'::jsonb,
  '{{"objective":"balanced","completeCoverage":true,
    "hardConstraintsSatisfied":true,"legalReview":"verified_profile","shifts":[]}}'::jsonb,
  '{owner}'),
 ('{revision2}','{business}','{series2}',1,repeat('a',64),
  '{{"horizonStart":"{week2}"}}'::jsonb,
  '{{"objective":"balanced","completeCoverage":true,
    "hardConstraintsSatisfied":true,"legalReview":"verified_profile","shifts":[]}}'::jsonb,
  '{owner}');
INSERT INTO public.scheduling_plan_assignments
 (business_id,plan_revision_id,employee_id,location_id,
  starts_at,ends_at,paid_minutes,breaks,pinned) VALUES
 ('{business}','{revision1}','{employee}','{location}',
  '2099-03-09T07:00:00Z','2099-03-09T09:00:00Z',120,'[]',false),
 ('{business}','{revision2}','{employee}','{location}',
  '2099-03-09T15:00:00Z','2099-03-09T17:00:00Z',120,'[]',false);
""")
    source = sql(
        f"SELECT public.scheduling_pr3_source_token_internal('{business}'::uuid);")
    assert len(source) == 32, "Missing authoritative source token"

    # Cross-tenant forgery must be denied even to an owner of another café.
    forged = transaction_rpc("scheduling_pr3_approve", outsider, revision1,
                             str(uuid4()))
    assert forged.get("error") == "unauthorized", forged

    # Two co-owners independently approve the same exact revision.
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(transaction_rpc, "scheduling_pr3_approve",
                                owner, revision1, str(uuid4()), True)
        second = executor.submit(transaction_rpc, "scheduling_pr3_approve",
                                 coowner, revision1, str(uuid4()), True)
        approvals = [first.result(), second.result()]
    assert [r.get("status") for r in approvals] == ["approved", "approved"], approvals
    assert sorted(r.get("replayed") for r in approvals) == [False, True], approvals
    assert sql(f"""SELECT count(*) FROM public.scheduling_plan_audit
       WHERE business_id='{business}' AND revision_id='{revision1}' AND event='approved';""") == "1"

    next_approval = transaction_rpc("scheduling_pr3_approve", owner, revision2,
                                     str(uuid4()))
    assert next_approval.get("status") == "approved", next_approval

    # Both versions are approved, but cannot BOTH become official: the shifts
    # fall in different weeks with only six hours rest instead of ten.
    key_a, key_b = str(uuid4()), str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(transaction_rpc, "scheduling_pr3_publish",
                                owner, revision1, key_a, True)
        second = executor.submit(transaction_rpc, "scheduling_pr3_publish",
                                 coowner, revision2, key_b, True)
        publications = [first.result(), second.result()]
    statuses = sorted(r.get("status") or r.get("error") for r in publications)
    assert statuses == ["published", "published_overlap"], publications
    winner = revision1 if publications[0].get("status") == "published" else revision2
    winner_actor = owner if winner == revision1 else coowner
    winner_key = key_a if winner == revision1 else key_b
    winner_series = series1 if winner == revision1 else series2
    loser_series = series2 if winner == revision1 else series1

    # The response can be lost after COMMIT. A same-key or different-key retry
    # must recover the single official publication, never repeat its effect.
    for retry_key in (winner_key, str(uuid4())):
        replay = transaction_rpc("scheduling_pr3_publish", winner_actor,
                                 winner, retry_key)
        assert replay.get("status") == "published" and replay.get("replayed"), replay

    counters = sql(f"""SELECT
       (SELECT count(*) FROM public.scheduling_plan_audit
         WHERE business_id='{business}' AND event='published'),
       (SELECT count(*) FROM public.scheduling_plan_request_receipts
         WHERE business_id='{business}' AND result->>'status'='published'),
       (SELECT count(*) FROM public.timecards WHERE business_id='{business}'),
       (SELECT count(*) FROM public.staff_schedules WHERE business_id='{business}'),
       (SELECT published_revision FROM public.scheduling_plan_series
         WHERE id='{winner_series}'),
       (SELECT published_revision FROM public.scheduling_plan_series
         WHERE id='{loser_series}') IS NULL;""")
    assert counters == "1|1|0|0|1|t", f"Duplicate or non-atomic publication: {counters}"

    # A valid café owner sees their own schedule, not a different tenant's.
    tenant_read = sql(f"""
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','{outsider}',true);
SELECT count(*) FROM public.scheduling_plan_series WHERE business_id='{business}';
COMMIT;""")
    assert tenant_read.splitlines()[-1] == "0", f"Cross-tenant schedule leak: {tenant_read}"
    print("PASS: concurrent co-owner approvals, cross-week publication race, "
          "different-key and timeout retries, exactly-once audit, tenant RLS, "
          "no payroll or legacy writes")
finally:
    # Each test creates unique disposable identities; deleting the businesses
    # cascades Olivia fixtures and its audits before deleting those users.
    sql(f"""DELETE FROM public.businesses WHERE id IN ('{business}','{other_business}');
DELETE FROM auth.users WHERE id IN ('{owner}','{coowner}','{outsider}');""")
