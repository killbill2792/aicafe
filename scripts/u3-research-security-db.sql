-- U3 production-boundary proof: fully migrated disposable Supabase only.
-- Separate actual PostgreSQL role, two cafés, authentic owner identity/lease.
-- Transactions roll back all fixtures. No paid model or production rows.
\set ON_ERROR_STOP on
BEGIN;
-- Transactional test-only membership, rolled back with fixtures; no durable research login grant.
GRANT aicafe_research TO postgres WITH INHERIT FALSE, SET TRUE;
SELECT gen_random_uuid() AS a,gen_random_uuid() AS b,
       gen_random_uuid() AS oa,gen_random_uuid() AS ob,
       gen_random_uuid() AS ta,gen_random_uuid() AS tb,
       gen_random_uuid() AS lease,
       gen_random_uuid() AS order_a,gen_random_uuid() AS order_b,
       gen_random_uuid() AS line_a,gen_random_uuid() AS line_b
\gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES(:'oa','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'u3-a-'||:'oa'||'@example.invalid','',now(),now()),
 (:'ob','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'u3-b-'||:'ob'||'@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo,timezone,currency)
VALUES (:'a','Disposable U3 A',false,'UTC','CAD'),
       (:'b','Disposable U3 B',false,'UTC','CAD');
INSERT INTO public.memberships(business_id,user_id,role)
VALUES (:'a',:'oa','owner'),(:'b',:'ob','owner');
INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id)
VALUES (:'ta',:'a',:'oa',gen_random_uuid()),(:'tb',:'b',:'ob',gen_random_uuid());
INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,
  gross_sales_cents,net_sales_cents)
VALUES (:'order_a',:'a','u3-disposable-a',now(),current_date,1100,1100),
       (:'order_b',:'b','u3-disposable-b',now(),current_date,4200,4200);
INSERT INTO public.order_lines(id,order_id,name,quantity,net_sales_cents)
VALUES (:'line_a',:'order_a','test item A',1,1100),
       (:'line_b',:'order_b','test item B',1,4200);

-- The canonical Toast reader must read a permitted, current retained nested
-- field with the original café scope, never the diagnostic sample archive.
INSERT INTO public.toast_raw_records(
 business_id,restaurant_guid,entity,entity_guid,business_date,
 payload,payload_sha256,capture_key
) VALUES
 (:'a',gen_random_uuid(),'employee',gen_random_uuid(),current_date,
  '{"guid":"99999999-9999-4999-8999-999999999991","role":"barista","properties":{"verified":{"quantity":3}}}'::jsonb,
  repeat('a',64),'current:u3-test'),
 (:'b',gen_random_uuid(),'employee',gen_random_uuid(),current_date,
  '{"guid":"99999999-9999-4999-8999-999999999992","role":"manager","properties":{"verified":{"quantity":9}}}'::jsonb,
  repeat('b',64),'current:u3-test');

-- Two independent supplier records exercise a newly admitted business
-- relation, not just the original order/order-line fixtures.
-- normalized_name is database-generated; do not specify its value.
INSERT INTO public.cafe_suppliers(id,business_id,display_name)
VALUES (gen_random_uuid(),:'a','Synthetic supplier A'),
       (gen_random_uuid(),:'b','Synthetic supplier B');

-- One genuine observed scalar change and two forbidden paths in café A;
-- café B has a different value. This is the existing operational delta log.
INSERT INTO public.toast_raw_changes(
 business_id,restaurant_guid,entity,entity_guid,business_date,changes)
VALUES
 (:'a',NULL,'employee',gen_random_uuid(),current_date,
  '[{"path":".properties.verified.quantity","before":1,"after":3},
    {"path":".authToken","before":"forbidden-one","after":"forbidden-two"},
    {"path":".notes","before":"not permitted","after":"still not permitted"}]'::jsonb),
 (:'b',NULL,'employee',gen_random_uuid(),current_date,
  '[{"path":".properties.verified.quantity","before":2,"after":9}]'::jsonb);

-- Verify strict object and function privileges before checking actual rows.
DO $checks$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aicafe_research'
   AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin AND NOT rolinherit)
 THEN RAISE EXCEPTION 'U3 research role is not isolated'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aicafe_research_view_owner'
   AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin AND NOT rolinherit)
 THEN RAISE EXCEPTION 'U3 view owner bypasses RLS'; END IF;
 IF has_table_privilege('aicafe_research','public.orders','SELECT') OR
   has_table_privilege('aicafe_research','public.connector_credentials','SELECT') OR
   has_table_privilege('aicafe_research','public.toast_raw_records','SELECT') OR
   has_schema_privilege('aicafe_research','u3_research_private','USAGE')
 THEN RAISE EXCEPTION 'U3 research role can access forbidden source'; END IF;
 -- The logical views need function EXECUTE while the private schema itself
 -- remains inaccessible to the model SQL connection. Never grant USAGE.
 IF NOT has_function_privilege('aicafe_research',
     'u3_research_private.toast_operational_records()','EXECUTE')
    OR NOT has_function_privilege('aicafe_research',
     'u3_research_private.toast_change_rows()','EXECUTE')
 THEN RAISE EXCEPTION 'U3 scoped research wrappers cannot execute through views'; END IF;
 IF has_function_privilege('anon','public.u3_issue_research_scope(uuid,uuid,uuid,text,text,text,uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.u3_issue_research_scope(uuid,uuid,uuid,text,text,text,uuid,uuid)','EXECUTE')
    OR has_function_privilege('aicafe_research','public.u3_issue_research_scope(uuid,uuid,uuid,text,text,text,uuid,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'U3 ticket issuance exposed'; END IF;
END
$checks$;

-- Generated policy invariant for every logical research relation. The
-- onboarding manifest may grow without writing a new permission test per view.
DO $u3_all_views$
DECLARE v record; view_count integer:=0;
BEGIN
 FOR v IN SELECT c.oid,c.relname,c.relowner,c.reloptions
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='u3_research' AND c.relkind='v'
 LOOP
  view_count:=view_count+1;
  IF pg_catalog.pg_get_userbyid(v.relowner)<>'aicafe_research_view_owner'
    OR NOT ('security_barrier=true'=ANY(coalesce(v.reloptions,ARRAY[]::text[])))
    OR has_table_privilege('anon',v.oid,'SELECT')
    OR has_table_privilege('authenticated',v.oid,'SELECT')
    OR NOT has_table_privilege('aicafe_research',v.oid,'SELECT')
   THEN RAISE EXCEPTION 'U3 logical source authorization failed: %',v.relname;
  END IF;
 END LOOP;
 IF view_count<2 THEN RAISE EXCEPTION 'U3 source admission missing'; END IF;
END
$u3_all_views$;

-- An actual service-role call must attest the *original* owner and thread.
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT public.u3_issue_research_scope(
 :'a'::uuid,:'oa'::uuid,:'ta'::uuid,'owner') AS ticket
\gset
SELECT public.u3_issue_research_scope(
 :'b'::uuid,:'ob'::uuid,:'tb'::uuid,'owner') AS other_ticket
\gset

-- A superuser who sets the local role no longer bypasses RLS.
SET LOCAL ROLE aicafe_research;
SELECT set_config('aicafe.u3_research_scope',:'ticket',true);
SELECT set_config('aicafe.u3_date_from',current_date::text,true),
 set_config('aicafe.u3_date_to',current_date::text,true);
SELECT (SELECT count(*) FROM u3_research.toast_records
  WHERE record_type='employee')=1 AS toast_current_same_cafe,
 (SELECT data #>> '{properties,verified,quantity}'
  FROM u3_research.toast_records WHERE record_type='employee')='3' AS toast_nested_value;
SELECT (SELECT count(*) FROM u3_research.toast_changes)=1 AS change_tenant_scope,
 (SELECT after_scalar FROM u3_research.toast_changes
   WHERE field_path='data.properties.verified.quantity')='3' AS change_scalar_correct,
 (SELECT count(*) FROM u3_research.toast_changes
   WHERE field_path LIKE '%authToken%' OR field_path LIKE '%notes%')=0 AS change_privacy,
 (SELECT count(*) FROM u3_research.cafe_suppliers)=1 AS supplier_isolation,
 (SELECT min(display_name) FROM u3_research.cafe_suppliers)='Synthetic supplier A' AS supplier_identity,
 (SELECT count(*) FROM u3_research.orders)=1 AS only_owner_cafe_orders,
 (SELECT sum(net_sales_cents) FROM u3_research.orders)=1100 AS correct_owner_amount,
 (SELECT count(*) FROM u3_research.order_lines)=1 AS indirect_child_tenant_scope,
 (SELECT sum(net_sales_cents) FROM u3_research.order_lines)=1100 AS correct_child_amount
\gset
SELECT (SELECT count(*) FROM u3_research.toast_records WHERE record_type='employee')=1 AS toast_tenant_count,
 (SELECT data #>> '{properties,verified,quantity}' FROM u3_research.toast_records
  WHERE record_type='employee')='3' AS toast_nested_cafe_value
\gset
\if :toast_tenant_count
\else
 \echo 'U3 current Toast records cross-café leak or unavailable'
 SELECT 1/0;
\endif
\if :toast_nested_cafe_value
\else
 \echo 'U3 retained nested Toast field unreadable or wrong'
 SELECT 1/0;
\endif
\if :change_tenant_scope
\else
 \echo 'U3 historical change rows leaked foreign café or forbidden paths'
 SELECT 1/0;
\endif
\if :change_scalar_correct
\else
 \echo 'U3 true observed Toast before/after scalar unavailable'
 SELECT 1/0;
\endif
\if :change_privacy
\else
 \echo 'U3 historical credentials or free-text notes exposed'
 SELECT 1/0;
\endif
\if :supplier_isolation
\else
 \echo 'U3 newly admitted supplier source leaked cross-café data'
 SELECT 1/0;
\endif
\if :supplier_identity
\else
 \echo 'U3 synthetic supplier identity scope mismatch'
 SELECT 1/0;
\endif
\if :only_owner_cafe_orders
\else
 \echo 'U3 tenant test failed: owner café order count'
 SELECT 1/0;
\endif
\if :correct_owner_amount
\else
 \echo 'U3 tenant test failed: foreign café amount leaked'
 SELECT 1/0;
\endif
\if :indirect_child_tenant_scope
\else
 \echo 'U3 indirect child test failed'
 SELECT 1/0;
\endif
\if :correct_child_amount
\else
 \echo 'U3 indirect child amount leaked'
 SELECT 1/0;
\endif

-- The scope GUC itself is not authority; HMAC integrity is mandatory.
SELECT set_config('aicafe.u3_research_scope','',true);
SELECT (SELECT count(*) FROM u3_research.orders)=0 AS no_ticket_denied
\gset
\if :no_ticket_denied
\else
 \echo 'U3 unsigned GUC unexpectedly admitted rows'
 SELECT 1/0;
\endif
SELECT set_config('aicafe.u3_research_scope',:'ticket'||'tamper',true);
SELECT (SELECT count(*) FROM u3_research.orders)=0 AS altered_ticket_denied
\gset
\if :altered_ticket_denied
\else
 \echo 'U3 tampered ticket unexpectedly admitted rows'
 SELECT 1/0;
\endif
SELECT set_config('aicafe.u3_research_scope',:'other_ticket',true);
SELECT (SELECT count(*) FROM u3_research.orders)=1
  AND (SELECT sum(net_sales_cents) FROM u3_research.orders)=4200 AS other_scope_correct
\gset
\if :other_scope_correct
\else
 \echo 'U3 second original owner/tenant scope incorrect'
 SELECT 1/0;
\endif

-- Revoking original café owner membership must revoke an already minted,
-- not-yet-expired token without trusting the app's stale cached membership.
RESET ROLE;
DELETE FROM public.memberships WHERE business_id=:'a' AND user_id=:'oa';
SET LOCAL ROLE aicafe_research;
SELECT set_config('aicafe.u3_research_scope',:'ticket',true);
SELECT (SELECT count(*) FROM u3_research.orders)=0 AS revoked_owner_denied
\gset
\if :revoked_owner_denied
\else
 \echo 'U3 revoked owner can still read rows'
 SELECT 1/0;
\endif
ROLLBACK;
\echo 'U3 migrated role/cafe/indirect-child/tamper/revocation security checks passed'
