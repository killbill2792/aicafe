-- Task 11: disposable migrated-database security acceptance (never use production).
-- RLS, SQL grants, unique receipt identities and service-only finalization.
begin;
do $check$
declare relation_name text;
  fully_qualified text;
  receipt_rpc text:='public.supervisor_finish_gmail_effect_attempt(uuid,uuid,uuid,uuid,uuid,integer,text,text,date)';
begin
  foreach relation_name in array array[
    'connector_accounts','connector_credentials','connector_oauth_states',
    'connector_provider_receipts'
  ] loop
    fully_qualified:='public.'||relation_name;
    if not exists(
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=relation_name and c.relkind='r'
        and c.relrowsecurity
    ) then raise exception 'Gmail RLS missing: %',relation_name; end if;
    if has_table_privilege('anon',fully_qualified,'SELECT') or
      has_table_privilege('authenticated',fully_qualified,'SELECT') or
      has_table_privilege('anon',fully_qualified,'INSERT') or
      has_table_privilege('authenticated',fully_qualified,'INSERT') or
      has_table_privilege('authenticated',fully_qualified,'UPDATE') or
      has_table_privilege('authenticated',fully_qualified,'DELETE')
    then raise exception 'Gmail table is not service-only: %',relation_name; end if;
    if not has_table_privilege('service_role',fully_qualified,'SELECT') then
      raise exception 'Gmail service read missing: %',relation_name; end if;
  end loop;
  if to_regprocedure(receipt_rpc) is null then
    raise exception 'Gmail-specific gateway finalizer missing'; end if;
  if has_function_privilege('anon',receipt_rpc,'EXECUTE') or
    has_function_privilege('authenticated',receipt_rpc,'EXECUTE') then
    raise exception 'Gmail effect finalization exposed to browser'; end if;
  if not has_function_privilege('service_role',receipt_rpc,'EXECUTE') then
    raise exception 'Gmail effect finalization unavailable to gateway'; end if;
  if not exists(
    select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid
    where t.relname='connector_provider_receipts' and c.contype='u'
      and pg_get_constraintdef(c.oid) like '%business_id, proposal_id, effect_hash%'
  ) then raise exception 'Gmail duplicate attempt ledger uniqueness missing'; end if;
  if not exists(
    select 1 from pg_indexes i
    where i.schemaname='public' and i.tablename='connector_provider_receipts'
      and i.indexname='connector_provider_receipts_rfc_id'
  ) then raise exception 'Gmail outbound Message-ID deduplication missing'; end if;
end
$check$;

-- Two isolated cafés, one provider send. All data stays inside this rollback.
do $fixture$
declare ba uuid:=gen_random_uuid();bb uuid:=gen_random_uuid();
 oa uuid:=gen_random_uuid();ob uuid:=gen_random_uuid();
 ta uuid:=gen_random_uuid();tb uuid:=gen_random_uuid();
 pid uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();
 account_id uuid; p public.supervisor_proposals; got public.supervisor_proposals;
begin
 insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 values (oa,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
         'gmail-fixture-a@example.invalid','',now(),now()),
        (ob,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
         'gmail-fixture-b@example.invalid','',now(),now());
 insert into public.businesses(id,name,timezone,is_demo)
 values (ba,'Gmail disposable café A','UTC',false),(bb,'Gmail disposable café B','UTC',false);
 insert into public.memberships(business_id,user_id,role)
 values (ba,oa,'owner'),(bb,ob,'owner');
 insert into public.ai_threads(id,business_id,owner_user_id,client_request_id)
 values (ta,ba,oa,gen_random_uuid()),(tb,bb,ob,gen_random_uuid());
 insert into public.connector_accounts(business_id,owner_user_id,provider,
   provider_subject,email,granted_scopes,enabled_operations,status)
 values (ba,oa,'gmail','fake-google-A','gmail-fixture-a@example.invalid',
   array['https://www.googleapis.com/auth/gmail.modify'],
   array['read','draft','send','organize'],'active') returning id into account_id;
 insert into public.connector_accounts(business_id,owner_user_id,provider,
   provider_subject,email,granted_scopes,enabled_operations,status)
 values (bb,ob,'gmail','fake-google-B','gmail-fixture-b@example.invalid',
   array['https://www.googleapis.com/auth/gmail.modify'],
   array['read','draft','send','organize'],'active');
 insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
   capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
 values (pid,ba,oa,ta,gen_random_uuid(),'alex.gmail_effect.v1',1,
   jsonb_build_object('accountId',account_id::text,'generation',1,'operation','send'),
   repeat('c',64),'{}'::jsonb,'{"durationDays":1,"metricScope":"gmail_provider_receipt"}'::jsonb,'en');
 update public.supervisor_proposals set status='executing',revision=revision+1
   where id=pid returning * into p;
 insert into public.supervisor_effect_attempts(attempt_key,business_id,proposal_id,
   effect_hash,authorization_kind,business_date,state)
 values (aid,ba,pid,repeat('c',64),'click',current_date,'executing');
 insert into public.connector_provider_receipts(account_id,business_id,owner_user_id,proposal_id,
   effect_hash,account_generation,operation,rfc_message_id,state)
 values (account_id,ba,oa,pid,repeat('c',64),1,'send',
   '<aicafe-durable-fixture@example.invalid>','pending');
 perform set_config('request.jwt.claim.role','service_role',true);
 begin
   perform public.supervisor_finish_gmail_effect_attempt(
     ba,oa,ta,pid,aid,p.revision,'verified','committed',current_date);
   raise exception 'Gmail incorrectly committed without provider receipt';
 exception when sqlstate '42501' then null; end;
 if (select status from public.supervisor_proposals where id=pid) <> 'executing' then
   raise exception 'Unverified Gmail effect changed proposal status'; end if;
 begin
   perform public.supervisor_finish_gmail_effect_attempt(
     bb,ob,tb,pid,aid,p.revision,'verified','committed',current_date);
   raise exception 'Cross-café Gmail effect was accepted';
 exception when sqlstate 'P0001' then null; end;
 update public.connector_provider_receipts set state='verified',
   provider_message_id='gmail-verified-message-id',provider_accepted_at=now()
   where proposal_id=pid and business_id=ba;
 got:=public.supervisor_finish_gmail_effect_attempt(
    ba,oa,ta,pid,aid,p.revision,'verified','committed',current_date);
 if got.status <> 'committed' or (select receipt_ref from public.supervisor_effect_attempts
   where attempt_key=aid)<>'gmail:gmail-verified-message-id' then
     raise exception 'Gmail receipt was not authoritative';end if;
 begin
   perform public.supervisor_finish_gmail_effect_attempt(
    ba,oa,ta,pid,aid,p.revision,'verified','committed',current_date);
   raise exception 'Duplicate Gmail provider effect was committed twice';
 exception when sqlstate 'P0001' then null; end;
end $fixture$;
rollback;
