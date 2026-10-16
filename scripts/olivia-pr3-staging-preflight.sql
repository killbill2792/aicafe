\set ON_ERROR_STOP on
-- Olivia PR89 strictly READ-ONLY environment preflight.
-- Can be run against an owner-approved staging database with restricted read
-- credentials. Does NOT apply migrations, inspect secrets, alter flags or
-- create scheduling/attendance data. Keep the output anonymized for review.
BEGIN TRANSACTION READ ONLY;
WITH
required(version) AS (
 VALUES ('20261014000060'),('20261014000061'),('20261014000062'),
        ('20261014000063'),('20261015000064'),('20261016000065'),
        ('20261016000066'),('20261016000067')
),
migration_check AS (
 SELECT r.version, EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations m
                         WHERE m.version=r.version) AS present
 FROM required r
),
tables(name) AS (
 VALUES ('scheduling_plan_series'),('scheduling_plan_revisions'),
        ('scheduling_plan_assignments'),('scheduling_plan_audit'),
        ('scheduling_plan_request_receipts'),
        ('scheduling_foundation_audit_events'),
        ('scheduling_foundation_create_receipts'),
        ('scheduling_availability_batch_receipts'),
        ('scheduling_labor_rule_review_audit'),
        ('staff_availability_rules'),('staff_availability_exceptions'),
        ('staff_scheduling_preferences'),('staff_preference_windows'),
        ('scheduling_qualification_types'),('staff_qualifications'),
        ('scheduling_coverage_requirements'),
        ('staff_scheduling_compensation'),
        ('scheduling_labor_rule_reviews')
),
table_check AS (
 SELECT t.name,
   coalesce(c.oid IS NOT NULL,false) AS exists,
   coalesce(c.relrowsecurity,false) AS rls_enabled,
   coalesce(c.relforcerowsecurity,false) AS forced_rls
 FROM tables t
 LEFT JOIN pg_class c ON c.relnamespace='public'::regnamespace
   AND c.relname=t.name AND c.relkind IN ('r','p')
),
functions(name,args) AS (
 VALUES ('scheduling_pr3_approve','uuid,uuid,uuid,integer,text,text,uuid'),
        ('scheduling_pr3_publish','uuid,uuid,uuid,integer,text,text,uuid'),
        ('scheduling_owner_source_token','uuid'),
        ('scheduling_pr3_source_token_internal','uuid')
),
function_check AS (
 SELECT f.name, p.oid IS NOT NULL AS exists,
   coalesce(p.prosecdef,false) AS security_definer,
   CASE WHEN p.oid IS NULL THEN NULL
        ELSE has_function_privilege('anon',p.oid,'EXECUTE') END
     AS anonymous_execute,
   CASE WHEN p.oid IS NULL THEN NULL
        ELSE has_function_privilege('authenticated',p.oid,'EXECUTE') END
     AS authenticated_execute
 FROM functions f
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||f.name||'('||f.args||')')
)
SELECT jsonb_pretty(jsonb_build_object(
 'environment',jsonb_build_object(
   'database',current_database(),
   'transaction_read_only',current_setting('transaction_read_only')),
 'required_olivia_migrations',coalesce((SELECT jsonb_agg(
    jsonb_build_object('version',version,'present',present) ORDER BY version)
    FROM migration_check),'[]'::jsonb),
 'olivia_table_rls',coalesce((SELECT jsonb_agg(
    jsonb_build_object('name',name,'exists',exists,'rls_enabled',rls_enabled)
    ORDER BY name) FROM table_check),'[]'::jsonb),
 'olivia_rpc_permissions',coalesce((SELECT jsonb_agg(
    jsonb_build_object('name',name,'exists',exists,'security_definer',
     security_definer,'anonymous_execute',anonymous_execute,
     'authenticated_execute',authenticated_execute) ORDER BY name)
    FROM function_check),'[]'::jsonb)
)) AS olivia_staging_preflight_readonly,
-- Fail closed, not merely a diagnostic report: a missing migration, disabled
-- RLS or callable privileged RPC must make an ON_ERROR_STOP=1 run fail.
-- Division by zero is intentional here only when an unsafe state is detected.
1 / CASE WHEN
    (SELECT count(*) FROM migration_check WHERE present)=8
    AND (SELECT count(*) FROM table_check WHERE exists AND rls_enabled)=18
    AND (SELECT count(*) FROM function_check WHERE exists AND security_definer)=4
    AND (SELECT count(*) FROM function_check
         WHERE name IN ('scheduling_pr3_approve','scheduling_pr3_publish')
           AND anonymous_execute=false AND authenticated_execute=false)=2
    THEN 1 ELSE 0 END AS olivia_preflight_checks_pass;
ROLLBACK;
