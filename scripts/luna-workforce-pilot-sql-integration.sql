-- Seeded disposable PostgreSQL only.
\set ON_ERROR_STOP on
begin;
select gen_random_uuid() as owner_id, gen_random_uuid() as cafe_id,
       gen_random_uuid() as other_id, gen_random_uuid() as general_thread \gset
insert into auth.users(id,aud,role,email) values
  (:'owner_id','authenticated','authenticated',:'owner_id'||'@example.invalid');
insert into public.businesses(id,name,is_demo) values
  (:'cafe_id','Disposable workforce café',false),(:'other_id','Disposable outside café',false);
insert into public.memberships(business_id,user_id,role) values
  (:'cafe_id',:'owner_id','owner'),(:'other_id',:'owner_id','owner');
insert into public.ai_threads(id,business_id,owner_user_id,client_request_id)
values (:'general_thread',:'cafe_id',:'owner_id',gen_random_uuid());
set local role service_role;
set local request.jwt.claim.role = 'service_role';
insert into public.luna_rollouts(business_id,enabled,scope) values (:'cafe_id',true,'workforce');
select public.luna_open_employee_thread(:'cafe_id',:'owner_id','finance') as employee_thread \gset

create function pg_temp.admit_pilot(p_cafe uuid,p_owner uuid,p_thread uuid)
returns jsonb language plpgsql as $$
declare input_id uuid:=gen_random_uuid();
begin
  insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id)
  values(input_id,p_cafe,p_owner,p_thread,p_owner,'owner','text','Reconcile the latest source evidence.',gen_random_uuid());
  return public.supervisor_admit_owner_run_v2(p_cafe,p_owner,p_thread,input_id,repeat('a',64),'en','{}');
end $$;
create function pg_temp.check(result boolean,description text) returns void language plpgsql as $$
begin
  if result is distinct from true then raise exception '%',description; end if;
end $$;

select pg_temp.admit_pilot(:'cafe_id',:'owner_id',:'employee_thread') as employee_run \gset
select pg_temp.check((:'employee_run'::jsonb->>'engine')='replacement' and
  (:'employee_run'::jsonb->>'employee_key')='finance','Workforce run did not pin replacement and employee');
select pg_temp.check((pg_temp.admit_pilot(:'cafe_id',:'owner_id',:'general_thread')->>'engine')='legacy',
  'General chat left the existing engine during the workforce pilot');

select set_config('test.cafe',:'cafe_id',true),set_config('test.other_cafe',:'other_id',true),
       set_config('test.owner',:'owner_id',true),set_config('test.employee_thread',:'employee_thread',true);
do $$
begin
  begin
    perform public.luna_open_employee_thread(current_setting('test.other_cafe')::uuid,current_setting('test.owner')::uuid,'finance');
    raise exception 'A second café with the same owner was incorrectly admitted';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;

update public.luna_rollouts set enabled=false where business_id=:'cafe_id';
select pg_temp.check(public.luna_open_employee_thread(:'cafe_id',:'owner_id','finance')=:'employee_thread'::uuid,
  'Rollback hid the existing workforce conversation');
select pg_temp.check((select engine='replacement' from public.supervisor_runs where id=(:'employee_run'::jsonb->>'id')::uuid),
  'Rollback switched an already admitted assignment');
do $$
begin
  begin
    perform pg_temp.admit_pilot(current_setting('test.cafe')::uuid,current_setting('test.owner')::uuid,current_setting('test.employee_thread')::uuid);
    raise exception 'Rollback admitted a new workforce assignment';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;
rollback;
