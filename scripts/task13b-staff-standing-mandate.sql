\set ON_ERROR_STOP on
-- Task13B standing staff mandate; synthetic, disposable-only, rolled back.
-- Fake Auth challenge identifiers here exercise SQL isolation; the separate
-- server test proves actual verified-phone-factor and MFA.verify are mandatory.
begin;
select gen_random_uuid() cafe,gen_random_uuid() foreign_cafe,
 gen_random_uuid() owner,gen_random_uuid() foreign_owner,
 gen_random_uuid() thread,gen_random_uuid() staff_a,gen_random_uuid() staff_b,
 gen_random_uuid() proposal,gen_random_uuid() mandate,gen_random_uuid() challenge \gset
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values (:'owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','staff-mandate-owner@example.invalid','',now(),now()),
(:'foreign_owner','00000000-0000-0000-0000-000000000000','authenticated','authenticated','staff-mandate-foreign@example.invalid','',now(),now());
insert into public.businesses(id,name,timezone,is_demo)
values (:'cafe','Mandate test café','America/Los_Angeles',false),
 (:'foreign_cafe','Foreign test café','America/Los_Angeles',false);
insert into public.memberships(business_id,user_id,role)
values(:'cafe',:'owner','owner'),(:'foreign_cafe',:'foreign_owner','owner');
insert into public.ai_threads(id,business_id,owner_user_id,client_request_id)
values (:'thread',:'cafe',:'owner',gen_random_uuid());
insert into public.employees(id,business_id,display_name,active,wage_period,
 wage_amount_cents,phone_e164,whatsapp_opt_in,preferred_schedule_channel,preferred_language)
values (:'staff_a',:'cafe','A',true,'hour',1800,'+14155550123',true,'whatsapp','en'),
 (:'staff_b',:'cafe','B',true,'hour',1800,'+14155550124',true,'whatsapp','en');
select date_trunc('week',current_date+interval '14 days')::date as week \gset
insert into public.scheduled_shifts(business_id,employee_id,local_date,
 start_local,end_local,status,source)
values(:'cafe',:'staff_a',:'week','09:00','15:00','draft','olivia'),
(:'cafe',:'staff_b',:'week','10:00','16:00','draft','olivia');
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('test.mandate.cafe',:'cafe',true);
select set_config('test.mandate.foreign_cafe',:'foreign_cafe',true);
select set_config('test.mandate.owner',:'owner',true);
select set_config('test.mandate.foreign_owner',:'foreign_owner',true);
select set_config('test.mandate.thread',:'thread',true);
select set_config('test.mandate.staff_a',:'staff_a',true);
select set_config('test.mandate.staff_b',:'staff_b',true);
select set_config('test.mandate.proposal',:'proposal',true);
select set_config('test.mandate.mandate',:'mandate',true);
select set_config('test.mandate.challenge',:'challenge',true);
select set_config('test.mandate.week',:'week',true);
do $mandate$
declare scope jsonb; token text; proposal_id uuid:=current_setting('test.mandate.proposal')::uuid;
begin
 scope:=jsonb_build_object('version',2,'kind','send_schedule',
 'weekStart',current_setting('test.mandate.week')::date,'staffIds',jsonb_build_array(current_setting('test.mandate.staff_a')::text,current_setting('test.mandate.staff_b')::text));
 -- Actual source token must be computed from saved canonical staff data.
 token:=public.supervisor_staff_scoped_token(current_setting('test.mandate.cafe')::uuid,scope);
 insert into public.supervisor_proposals(
 id,business_id,owner_user_id,thread_id,request_key,capability_id,
 capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale,status)
 values(proposal_id,current_setting('test.mandate.cafe')::uuid,current_setting('test.mandate.owner')::uuid,current_setting('test.mandate.thread')::uuid,gen_random_uuid(),
 'olivia.staff_propose_send_schedule.v2',2,jsonb_build_object(
 'operation','propose_send_schedule','scopeVersion',2,'dependencyScope',scope,
 'expectedToken',token,'preview',jsonb_build_array(jsonb_build_object(
 'field','schedule:notify','label','Notify prepared staff',
 'before',jsonb_build_object('kind','text','text','Unpublished'),
 'after',jsonb_build_object('kind','text','text','Owner mandate scope'))),
 'payload',jsonb_build_object('week_start',current_setting('test.mandate.week')::date,'publish_and_notify',true)),
 repeat('a',64),'{}','{}','en','draft');
end $mandate$;
-- No manager, unrelated owner, nonexistent or unverified mandate may trigger.
do $mandate$
declare denied boolean:=false;
begin
 begin perform public.supervisor_gateway_commit_staff_mandate(
  current_setting('test.mandate.cafe')::uuid,current_setting('test.mandate.owner')::uuid,current_setting('test.mandate.thread')::uuid,current_setting('test.mandate.proposal')::uuid,1);
 exception when others then denied:=true; end;
 if not denied then raise exception '13B draft executed before phone-MFA grant'; end if;
end $mandate$;
-- Grant challenge after Auth MFA is verified by the real server (service-role fixture).
select public.supervisor_create_staff_mandate_challenge(
 :'cafe',:'owner',:'challenge','grant',:'mandate',0,repeat('b',64),2,
 :'week'::date,(:'week'::date+interval '6 days'), 'factor-verified',
 'provider-test-challenge',now()+interval '5 minutes') as challenge_row;
select to_jsonb(public.supervisor_complete_mandate_challenge(
 :'cafe',:'owner',:'challenge','factor-verified','provider-test-challenge'))->>'revision'
 as verified_revision \gset
select set_config('test.mandate.verified_revision',:'verified_revision',true);
do $mandate$
declare denied boolean:=false;
begin
 if current_setting('test.mandate.verified_revision')::int<>1 then raise exception '13B MFA grant not persisted'; end if;
 begin perform public.supervisor_complete_mandate_challenge(
  current_setting('test.mandate.cafe')::uuid,current_setting('test.mandate.owner')::uuid,current_setting('test.mandate.challenge')::uuid,'factor-verified','provider-test-challenge');
 exception when others then denied:=true; end;
 if not denied then raise exception '13B MFA challenge replay authorized duplicate mandate'; end if;
 denied:=false;
 begin perform public.supervisor_gateway_commit_staff_mandate(
  current_setting('test.mandate.foreign_cafe')::uuid,current_setting('test.mandate.foreign_owner')::uuid,current_setting('test.mandate.thread')::uuid,current_setting('test.mandate.proposal')::uuid,1);
 exception when others then denied:=true; end;
 if not denied then raise exception '13B foreign cafe executed staff mandate'; end if;
end $mandate$;
-- One original Supervisor gateway transaction grants AND commits the exact
-- pre-existing staff send proposal, recording both staff and effect receipts.
select public.supervisor_gateway_commit_staff_mandate(
 :'cafe',:'owner',:'thread',:'proposal',1)->>'state' as applied_state \gset
select set_config('test.mandate.applied_state',:'applied_state',true);
do $mandate$
declare count_attempts integer; 
begin
 if current_setting('test.mandate.applied_state')<>'applied' then raise exception '13B mandated staff proposal did not commit'; end if;
 select count(*) into count_attempts from public.supervisor_effect_attempts
 where proposal_id=current_setting('test.mandate.proposal') and authorization_kind='mandate'
   and state='verified' and mandate_id=current_setting('test.mandate.mandate') and mandate_revision=1;
 if count_attempts<>1 then raise exception '13B mandate effect audit missing'; end if;
 if not exists(select 1 from public.supervisor_approvals
  where proposal_id=current_setting('test.mandate.proposal') and authorization_kind='mandate' and
    mandate_id=current_setting('test.mandate.mandate') and mandate_revision=1) then
    raise exception '13B mandate approval provenance missing'; end if;
end $mandate$;
select public.staff_schedule_publish(:'cafe',:'owner',:'proposal')->>'id' as publication \gset
select set_config('test.mandate.publication',:'publication',true);
select public.staff_schedule_claim_delivery(:'publication',:'staff_a')->>'deliveryId' as delivery \gset
select set_config('test.mandate.delivery',:'delivery',true);
select attempt_token as token from public.staff_schedule_deliveries where id=:'delivery' \gset
select set_config('test.mandate.token',:'token',true);
do $mandate$
begin
 if not public.staff_schedule_can_send(current_setting('test.mandate.delivery')::uuid,current_setting('test.mandate.token')::uuid) then
  raise exception '13B authorized scoped staff delivery was blocked'; end if;
 if not exists(select 1 from public.staff_schedule_publications
  where id=current_setting('test.mandate.publication') and business_id=current_setting('test.mandate.cafe') and owner_user_id=current_setting('test.mandate.owner')) then
  raise exception '13B mandated publication receipt missing'; end if;
end $mandate$;
-- Revocation is immediate even AFTER publication and AFTER a send claim:
-- no new provider HTTP may happen without this last-moment SQL check.
select public.supervisor_revoke_mandate(:'cafe',:'owner',:'mandate',1)::text as revoked \gset
do $mandate$
declare denied boolean:=false;
begin
 if public.staff_schedule_can_send(current_setting('test.mandate.delivery')::uuid,current_setting('test.mandate.token')::uuid) then
  raise exception '13B revoked mandate allowed in-flight external send'; end if;
 if public.staff_schedule_claim_delivery(current_setting('test.mandate.publication')::uuid,current_setting('test.mandate.staff_b')::uuid) is not null then
  raise exception '13B revoked mandate allowed a fresh worker send'; end if;
 if not exists(select 1 from public.supervisor_mandates
  where id=current_setting('test.mandate.mandate') and revision=2 and revoked_at is not null) then
  raise exception '13B revocation did not persist immutable policy revision'; end if;
 begin perform public.staff_schedule_publish(current_setting('test.mandate.cafe')::uuid,current_setting('test.mandate.owner')::uuid,current_setting('test.mandate.proposal')::uuid);
 exception when others then denied:=true; end;
 if not denied then raise exception '13B replay after mandate revocation was allowed'; end if;
end $mandate$;
-- Authenticated owners cannot mint, finish or revoke service-only approvals
-- through direct SQL, even with their own business IDs.
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',:'owner',true);
do $mandate$
declare denied boolean:=false;
begin
 begin perform public.supervisor_create_staff_mandate_challenge(
  current_setting('test.mandate.cafe')::uuid,current_setting('test.mandate.owner')::uuid,gen_random_uuid(),'grant',gen_random_uuid(),0,
  repeat('a',64),2,current_setting('test.mandate.week')::date,current_setting('test.mandate.week')::date+interval '6 days',
  'factor-id','forged',now()+interval '5 minutes');
 exception when insufficient_privilege or undefined_function then denied:=true; end;
 if not denied then raise exception '13B authenticated forged staff mandate'; end if;
end $mandate$;
rollback;
