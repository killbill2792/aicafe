\set ON_ERROR_STOP on
-- Real migrated database, exact authenticated roles and source receipts.
begin;
select gen_random_uuid() biz,gen_random_uuid() other_biz, gen_random_uuid() owner_id,
 gen_random_uuid() other_owner,gen_random_uuid() coowner,gen_random_uuid() staff_user,
 gen_random_uuid() employee,gen_random_uuid() foreign_employee,gen_random_uuid() nonce,
 gen_random_uuid() assignment_nonce \gset
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,encrypted_password,created_at,updated_at)
select id,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 id::text||'@example.invalid',now(),'',now(),now()
from unnest(array[:'owner_id'::uuid,:'other_owner'::uuid,:'coowner'::uuid,:'staff_user'::uuid]) id;
insert into public.businesses(id,name,timezone,currency,is_demo)
 values (:'biz','Maintenance test café','America/Los_Angeles','USD',false),
 (:'other_biz','Other café','Europe/London','GBP',false);
insert into public.memberships(business_id,user_id,role)
 values (:'biz',:'owner_id','owner'),(:'other_biz',:'other_owner','owner');
insert into public.employees(id,business_id,display_name,active,wage_period,wage_amount_cents)
 values (:'employee',:'biz','Test worker',true,'hour',2000),
 (:'foreign_employee',:'other_biz','Other worker',true,'hour',2000);
select set_config('test.maintenance15b.biz',:'biz',true),set_config('test.maintenance15b.other_biz',:'other_biz',true),
 set_config('test.maintenance15b.owner',:'owner_id',true),set_config('test.maintenance15b.other_owner',:'other_owner',true),
 set_config('test.maintenance15b.employee',:'employee',true),set_config('test.maintenance15b.foreign_employee',:'foreign_employee',true),
 set_config('test.maintenance15b.staff',:'staff_user',true),set_config('test.maintenance15b.assignment_nonce',:'assignment_nonce',true);
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',:'owner_id',true);
select public.staff_link_existing_login(:'biz',:'employee',:'staff_user'||'@example.invalid');
select set_config('request.jwt.claim.sub',:'staff_user',true);
select public.staff_channel_submit(null,'report',E'Maintenance report v1\nEspresso machine\nhigh\nBoiler not heating',:'nonce')->>'id' as msg \gset
select set_config('test.maintenance15b.case','maintenance:'||:'msg',true);
select public.staff_channel_submit(null,'report',E'Maintenance report v1\nEspresso machine\nhigh\nBoiler not heating',:'nonce');
do $$
begin
 if exists(select 1 from public.operating_tasks where id=current_setting('test.maintenance15b.case')) then
  raise exception 'worker can read private maintenance case';
 end if;
 if exists(select 1 from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case')) then
  raise exception 'worker can read private maintenance ledger';
 end if;
end $$;
select set_config('request.jwt.claim.sub',:'owner_id',true);
do $$
declare b uuid:=current_setting('test.maintenance15b.biz')::uuid; t text:=current_setting('test.maintenance15b.case');
begin
 if (select count(*) from public.operating_tasks where business_id=b and id=t and
   kind='maintenance_issue' and payload->>'equipmentLabel'='Espresso machine' and
   payload->>'maintenanceStage'='reported')<>1 then raise exception 'canonical staff case missing';end if;
 if (select count(*) from public.maintenance_case_events where business_id=b and task_id=t
   and kind='report' and actor_kind='staff' and source_kind='staff_report')<>1 then
  raise exception 'staff report not recorded exactly once';end if;
 begin
  perform public.maintenance_assign_staff(b,t,current_setting('test.maintenance15b.foreign_employee')::uuid,
    gen_random_uuid(),'Check the machine');
  raise exception 'foreign employee accepted';
 exception when insufficient_privilege then null; end;
end $$;
select public.maintenance_assign_staff(:'biz','maintenance:'||:'msg',:'employee',
 :'assignment_nonce','Check whether the technician has arrived')->>'id' as req \gset
select set_config('test.maintenance15b.request',:'req',true);
select public.maintenance_assign_staff(:'biz','maintenance:'||:'msg',:'employee',
 :'assignment_nonce','Check whether the technician has arrived');
do $$
begin
 if (select count(*) from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case')
   and kind='staff_assignment' and source_id=current_setting('test.maintenance15b.request'))<>1 then
  raise exception 'assignment not recorded exactly once';end if;
end $$;
select set_config('request.jwt.claim.sub',:'staff_user',true);
select public.staff_channel_submit(:'req','complete','Technician says repaired',gen_random_uuid());
select set_config('request.jwt.claim.sub',:'owner_id',true);
do $$
begin
 if not exists(select 1 from public.operating_tasks where id=current_setting('test.maintenance15b.case')
   and status='needs_owner' and payload->>'maintenanceStage'='assigned'
   and payload->>'repairVerified'='false') then raise exception 'staff completion falsely closed case';end if;
 if (select count(*) from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case')
   and kind='follow_up' and source_kind='staff_report')<>1 then raise exception 'linked response missing';end if;
end $$;
select set_config('request.jwt.claim.sub',:'other_owner',true);
do $$
begin
 if exists(select 1 from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case'))
 then raise exception 'cross-café evidence leaked';end if;
 begin
  perform public.maintenance_assign_staff(current_setting('test.maintenance15b.biz')::uuid,
   current_setting('test.maintenance15b.case'),current_setting('test.maintenance15b.employee')::uuid,
   gen_random_uuid(),'Unauthorized work');
  raise exception 'foreign owner assigned';exception when insufficient_privilege then null;end;
end $$;
reset role;
insert into public.memberships(business_id,user_id,role) values (:'biz',:'coowner','owner');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'coowner',true);
do $$
begin
 if exists(select 1 from public.maintenance_case_events where task_id=current_setting('test.maintenance15b.case'))
 then raise exception 'co-owner private evidence leaked';end if;
end $$;
rollback;
