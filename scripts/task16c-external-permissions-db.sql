-- Task 16C: disposable, migrated Supabase validation of revocable scope and CAS.
begin;
do $security$
declare t text; f text;
begin
 foreach t in array array[
  'supervisor_external_access','supervisor_external_access_audit',
  'connector_operation_change_receipts'
 ] loop
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relname=t and n.nspname='public' and c.relrowsecurity)
  then raise exception 'Missing RLS on %',t; end if;
  if has_table_privilege('authenticated','public.'||t,'SELECT') or
    has_table_privilege('authenticated','public.'||t,'INSERT') or
    has_table_privilege('authenticated','public.'||t,'UPDATE') or
    has_table_privilege('anon','public.'||t,'SELECT')
  then raise exception 'External permissions leaked to browser role: %',t; end if;
 end loop;
 foreach f in array array[
   'supervisor_change_external_access(uuid,uuid,text,text,boolean,bigint)',
   'supervisor_change_gmail_operations(uuid,uuid,uuid,bigint,text[])'
 ] loop
  if to_regprocedure('public.'||f) is null then raise exception 'Missing RPC %',f;end if;
  if has_function_privilege('authenticated','public.'||f,'EXECUTE') or
    has_function_privilege('anon','public.'||f,'EXECUTE')
  then raise exception 'Permission RPC callable from client: %',f; end if;
 end loop;
end $security$;

do $fixture$
declare cafe_a uuid:=gen_random_uuid(); cafe_b uuid:=gen_random_uuid();
 owner_a uuid:=gen_random_uuid();owner_b uuid:=gen_random_uuid();
 thread_a uuid:=gen_random_uuid();thread_b uuid:=gen_random_uuid();
 file_a uuid:=gen_random_uuid(); file_b uuid:=gen_random_uuid();
 gmail_a uuid; state jsonb; next_rev bigint; changed bigint;
begin
 insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 values(owner_a,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
    'task16c-a@example.invalid','',now(),now()),
       (owner_b,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
    'task16c-b@example.invalid','',now(),now());
 insert into public.businesses(id,name,timezone,is_demo)
 values(cafe_a,'Task16C test A','UTC',false),(cafe_b,'Task16C test B','UTC',false);
 insert into public.memberships(business_id,user_id,role)
 values(cafe_a,owner_a,'owner'),(cafe_b,owner_b,'owner');
 insert into public.ai_threads(id,business_id,owner_user_id,client_request_id)
 values(thread_a,cafe_a,owner_a,gen_random_uuid()),
       (thread_b,cafe_b,owner_b,gen_random_uuid());
 insert into public.ai_attachments(id,business_id,owner_user_id,thread_id,object_path,
   original_name,media_type,bytes)
 values(file_a,cafe_a,owner_a,thread_a,
   cafe_a::text||'/'||owner_a::text||'/'||thread_a::text||'/'||file_a::text||'/one.txt',
   'one.txt','text/plain',9),
   (file_b,cafe_b,owner_b,thread_b,
   cafe_b::text||'/'||owner_b::text||'/'||thread_b::text||'/'||file_b::text||'/two.txt',
   'two.txt','text/plain',9);
 insert into public.connector_accounts(business_id,owner_user_id,provider,
   provider_subject,email,granted_scopes,enabled_operations,status)
 values(cafe_a,owner_a,'gmail','test-google-sub','task16c-a@example.invalid',
  array['https://www.googleapis.com/auth/gmail.modify'],
  array['read','draft','send','organize'],'active') returning id into gmail_a;
 insert into public.connector_credentials(account_id,generation,access_token_enc,
  refresh_token_enc,token_expires_at)
 values(gmail_a,1,repeat('e',64),repeat('f',64),now()+interval '1 hour');

 perform set_config('request.jwt.claim.role','service_role',true);
 state:=public.supervisor_change_external_access(
   cafe_a,owner_a,'public_web','public',false,0);
 if state->>'allowed'<>'false' or state->>'revision'<>'1'
 then raise exception 'Failed explicit public web revocation'; end if;
 begin
  perform public.supervisor_change_external_access(cafe_a,owner_a,
    'public_web','public',true,0);
  raise exception 'Stale public web permission revision accepted';
 exception when sqlstate '40001' then null; end;
 begin
  perform public.supervisor_change_external_access(cafe_b,owner_b,
    'attachment',upper(file_a::text),false,0);
  raise exception 'Foreign café file revocation accepted';
 exception when sqlstate '42501' then null; end;
 state:=public.supervisor_change_external_access(
   cafe_a,owner_a,'file_read','all',false,0);
 if state->>'allowed'<>'false' then raise exception 'File reading still allowed'; end if;
 state:=public.supervisor_change_external_access(
   cafe_a,owner_a,'attachment',file_a::text,false,0);
 if state->>'revision'<>'1' then raise exception 'File-specific revoke not persisted'; end if;
 if not exists(select 1 from public.supervisor_external_access
   where business_id=cafe_a and owner_user_id=owner_a and kind='attachment'
     and resource_key=file_a::text and allowed=false)
 then raise exception 'Uppercase revoke did not block canonical attachment ID'; end if;
 begin
  perform public.supervisor_change_external_access(cafe_a,owner_a,
    'attachment',file_a::text,true,1);
  raise exception 'Revoked original file was reenabled';
 exception when sqlstate '22023' then null; end;
 if (select count(*) from public.supervisor_external_access_audit
     where business_id=cafe_a and owner_user_id=owner_a)<>3 then
   raise exception 'Missing external permission audit receipts'; end if;

 state:=public.supervisor_change_gmail_operations(
   cafe_a,owner_a,gmail_a,1,array['read','draft']);
 if (state->>'generation')::bigint<>2 or
   (select generation from public.connector_credentials where account_id=gmail_a)<>2 or
   (select generation from public.connector_accounts where id=gmail_a)<>2
 then raise exception 'Gmail permission generation not atomic'; end if;
 if (select enabled_operations from public.connector_accounts where id=gmail_a)
    @> array['send']::text[] then raise exception 'Gmail send not revoked'; end if;
 begin
  perform public.supervisor_change_gmail_operations(cafe_a,owner_a,gmail_a,
    1,array['read','send']);
  raise exception 'Old approval generation replay accepted';
 exception when sqlstate '40001' then null; end;
 begin
  perform public.supervisor_change_gmail_operations(cafe_b,owner_b,gmail_a,
    2,array['send']);
  raise exception 'Cross-café Gmail permission change accepted';
 exception when sqlstate '40001' then null; end;
 state:=public.supervisor_change_gmail_operations(
    cafe_a,owner_a,gmail_a,2,array['read','draft','send']);
 if (state->>'generation')::bigint<>3 then
    raise exception 'Gmail reenable did not invalidate old proposal generation'; end if;
 if (select count(*) from public.connector_operation_change_receipts
    where account_id=gmail_a and business_id=cafe_a)<>2
 then raise exception 'Gmail operation change receipts missing'; end if;
 if (select access_token_enc from public.connector_credentials
    where account_id=gmail_a)<>repeat('e',64)
 then raise exception 'Gmail operation grant modified provider credential';end if;
end $fixture$;
rollback;
