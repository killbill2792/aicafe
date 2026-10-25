\set ON_ERROR_STOP on
-- All data is disposable and rolls back. V2 cards for independent staff must
-- commit in sequence, while a competing edit of the SAME staff row goes stale.
BEGIN;
SELECT gen_random_uuid() AS business,gen_random_uuid() AS owner,
 gen_random_uuid() AS thread_id,gen_random_uuid() AS e1,gen_random_uuid() AS e2,
 gen_random_uuid() AS e3,gen_random_uuid() AS p1,gen_random_uuid() AS p2,
 gen_random_uuid() AS p3,gen_random_uuid() AS stale_first,gen_random_uuid() AS stale_second \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES(:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'scoped-approval-owner@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,timezone,currency,is_demo)
VALUES(:'business','Scoped CAS verification','America/Los_Angeles','USD',false);
INSERT INTO public.memberships(business_id,user_id,role)
VALUES(:'business',:'owner','owner');
INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id)
VALUES(:'thread_id',:'business',:'owner',gen_random_uuid());
INSERT INTO public.employees(id,business_id,display_name,role,wage_period,
 wage_amount_cents,default_hourly_wage_cents,active,whatsapp_opt_in)
VALUES(:'e1',:'business','Amy','Barista','hour',1800,1800,true,false),
 (:'e2',:'business','Bob','Barista','hour',1700,1700,true,false),
 (:'e3',:'business','Carla','Barista','hour',1600,1600,true,false);
SET LOCAL ROLE service_role;
SELECT set_config('test.scoped.business',:'business',true);
SELECT set_config('test.scoped.e1',:'e1',true);
SELECT set_config('test.scoped.e2',:'e2',true);
SELECT set_config('test.scoped.e3',:'e3',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT
 public.supervisor_staff_scoped_token(:'business'::uuid,
  jsonb_build_object('version',2,'kind','staff_change','employeeId',:'e1')) AS t1,
 public.supervisor_staff_scoped_token(:'business'::uuid,
  jsonb_build_object('version',2,'kind','staff_change','employeeId',:'e2')) AS t2,
 public.supervisor_staff_scoped_token(:'business'::uuid,
  jsonb_build_object('version',2,'kind','staff_change','employeeId',:'e3')) AS t3 \gset
INSERT INTO public.supervisor_proposals(
 id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,
 canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
SELECT row.id,:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_staff_change.v2',2,
 jsonb_build_object('operation','propose_staff_change','scopeVersion',2,
  'dependencyScope',jsonb_build_object('version',2,'kind','staff_change','employeeId',row.employee_id),
  'expectedToken',row.token,'currency','USD','subjectName',row.name,
  'preview',jsonb_build_array(jsonb_build_object('field','wage','label','Hourly wage',
    'before',jsonb_build_object('kind','moneyRate','cents',row.old_wage,'per','hour'),
    'after',jsonb_build_object('kind','moneyRate','cents',row.new_wage,'per','hour'))),
  'payload',jsonb_build_object('employee_id',row.employee_id,'name',row.name,'role','Barista',
     'wage_cents',row.new_wage,'phone',NULL,'active',true)),
 row.effect_hash,'{}','{"durationDays":1,"metricScope":"staff"}','en'
FROM (VALUES
 (:'p1'::uuid,:'e1'::uuid,:'t1'::text,'Amy',1800,2000,repeat('a',64)),
 (:'p2'::uuid,:'e2'::uuid,:'t2'::text,'Bob',1700,1900,repeat('b',64)),
 (:'p3'::uuid,:'e3'::uuid,:'t3'::text,'Carla',1600,1800,repeat('c',64))
) AS row(id,employee_id,token,name,old_wage,new_wage,effect_hash);
SELECT public.supervisor_transition_proposal(:'business'::uuid,:'owner'::uuid,:'p1'::uuid,1,'approve',NULL);
SELECT public.supervisor_commit_staff_proposal(:'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'p1'::uuid,2);
SELECT public.supervisor_transition_proposal(:'business'::uuid,:'owner'::uuid,:'p2'::uuid,1,'approve',NULL);
SELECT public.supervisor_commit_staff_proposal(:'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'p2'::uuid,2);
SELECT public.supervisor_transition_proposal(:'business'::uuid,:'owner'::uuid,:'p3'::uuid,1,'approve',NULL);
SELECT public.supervisor_commit_staff_proposal(:'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'p3'::uuid,2);
DO $verify$
BEGIN
 IF (SELECT count(*) FROM public.supervisor_proposals
   WHERE business_id=current_setting('test.scoped.business')::uuid AND status='committed') <> 3
 OR NOT EXISTS(SELECT 1 FROM public.employees
   WHERE id=current_setting('test.scoped.e1')::uuid AND wage_amount_cents=2000)
 OR NOT EXISTS(SELECT 1 FROM public.employees
   WHERE id=current_setting('test.scoped.e2')::uuid AND wage_amount_cents=1900)
 OR NOT EXISTS(SELECT 1 FROM public.employees
   WHERE id=current_setting('test.scoped.e3')::uuid AND wage_amount_cents=1800)
 THEN RAISE EXCEPTION 'independent staff approvals failed to persist'; END IF;
END $verify$;
SELECT public.supervisor_staff_scoped_token(:'business'::uuid,
 jsonb_build_object('version',2,'kind','staff_change','employeeId',:'e1')) AS same_token \gset
INSERT INTO public.supervisor_proposals(
 id,business_id,owner_user_id,thread_id,request_key,capability_id,capability_version,
 canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
SELECT row.id,:'business',:'owner',:'thread_id',gen_random_uuid(),
 'olivia.staff_propose_staff_change.v2',2,
 jsonb_build_object('operation','propose_staff_change','scopeVersion',2,
  'dependencyScope',jsonb_build_object('version',2,'kind','staff_change','employeeId',:'e1'),
  'expectedToken',:'same_token','currency','USD','subjectName','Amy',
  'preview',jsonb_build_array(jsonb_build_object('field','wage','label','Hourly wage',
    'before',jsonb_build_object('kind','moneyRate','cents',2000,'per','hour'),
    'after',jsonb_build_object('kind','moneyRate','cents',row.new_wage,'per','hour'))),
  'payload',jsonb_build_object('employee_id',:'e1','name','Amy','role','Barista',
    'wage_cents',row.new_wage,'phone',NULL,'active',true)),
 row.effect_hash,'{}','{"durationDays":1,"metricScope":"staff"}','en'
FROM (VALUES(:'stale_first'::uuid,2100,repeat('d',64)),
            (:'stale_second'::uuid,2200,repeat('e',64))) AS row(id,new_wage,effect_hash);
SELECT public.supervisor_transition_proposal(:'business'::uuid,:'owner'::uuid,:'stale_first'::uuid,1,'approve',NULL);
SELECT public.supervisor_commit_staff_proposal(:'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'stale_first'::uuid,2);
SELECT public.supervisor_transition_proposal(:'business'::uuid,:'owner'::uuid,:'stale_second'::uuid,1,'approve',NULL);
SELECT public.supervisor_commit_staff_proposal(:'business'::uuid,:'owner'::uuid,:'thread_id'::uuid,:'stale_second'::uuid,2);
SELECT set_config('test.scoped.same_second',:'stale_second',true);
DO $verify$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.supervisor_proposals
   WHERE id=current_setting('test.scoped.same_second')::uuid AND status='stale')
 OR (SELECT wage_amount_cents FROM public.employees
   WHERE id=current_setting('test.scoped.e1')::uuid)<>2100
 THEN RAISE EXCEPTION 'same-employee competing approval did not go stale'; END IF;
END $verify$;
ROLLBACK;
