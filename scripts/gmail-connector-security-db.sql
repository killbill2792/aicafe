\set ON_ERROR_STOP on
-- Task 11: disposable migrated-schema acceptance only (no live Gmail calls).
begin;
select gen_random_uuid() as ba, gen_random_uuid() as bb,
 gen_random_uuid() as oa, gen_random_uuid() as ob,
 gen_random_uuid() as ta, gen_random_uuid() as tb,
 gen_random_uuid() as pa, gen_random_uuid() as attempt \gset

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values (:'oa','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'gmail-test-a@example.invalid','',now(),now()),
 (:'ob','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'gmail-test-b@example.invalid','',now(),now());
insert into public.businesses(id,name,timezone,is_demo)
values (:'ba','Disposable Gmail A','UTC',false),
 (:'bb','Disposable Gmail B','America/Los_Angeles',false);
insert into public.memberships(business_id,user_id,role)
values (:'ba',:'oa','owner'),(:'bb',:'ob','owner');
insert into public.ai_threads(id,business_id,owner_user_id,client_request_id)
values (:'ta',:'ba',:'oa',gen_random_uuid()),(:'tb',:'bb',:'ob',gen_random_uuid());

-- Sensitive accounts, token storage, OAuth states and provider receipts are never Data API readable.
do $check$
declare t text;
begin
 foreach t in array array['connector_accounts','connector_credentials',
   'connector_oauth_states','connector_provider_receipts'] loop
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=t and c.relrowsecurity)
    then raise exception 'Gmail table % lacks RLS',t; end if;
  if has_table_privilege('authenticated','public.'||t,'SELECT')
    or has_table_privilege('authenticated','public.'||t,'INSERT')
    or has_table_privilege('authenticated','public.'||t,'UPDATE')
    or has_table_privilege('anon','public.'||t,'SELECT')
    then raise exception 'Gmail table % leaked through Data API privileges',t; end if;
 end loop;
 if has_function_privilege('authenticated',
   'public.supervisor_finish_gmail_effect_attempt(uuid,uuid,uuid,uuid,uuid,integer,text,text,date)',
   'EXECUTE') then raise exception 'Gmail finish RPC is publicly executable'; end if;
end $check$;

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
insert into public.connector_accounts(business_id,owner_user_id,provider,
 provider_subject,email,granted_scopes,enabled_operations,status)
values (:'ba',:'oa','gmail','google-A','gmail-test-a@example.invalid',
 array['https://www.googleapis.com/auth/gmail.modify']::text[],
 array['read','draft','send','organize']::text[],'active')
returning id as account_id \gset
insert into public.connector_accounts(business_id,owner_user_id,provider,
 provider_subject,email,granted_scopes,enabled_operations,status)
values (:'bb',:'ob','gmail','google-B','gmail-test-b@example.invalid',
 array['https://www.googleapis.com/auth/gmail.modify']::text[],
 array['read','draft','send','organize']::text[],'active');
insert into public.connector_credentials(account_id,access_token_enc,refresh_token_enc,token_expires_at)
values (:'account_id',repeat('a',64),repeat('b',64),now()+interval '1 hour');
insert into public.supervisor_proposals(id,business_id,owner_user_id,thread_id,request_key,
 capability_id,capability_version,canonical_effect_payload,effect_hash,baseline,monitor_spec,locale)
values (:'pa',:'ba',:'oa',:'ta',gen_random_uuid(),'alex.gmail_effect.v1',1,
 jsonb_build_object('accountId',:'account_id','generation',1,'operation','send'),
 repeat('c',64),'{}'::jsonb,'{"durationDays":1,"metricScope":"gmail_provider_receipt"}'::jsonb,'en');
update public.supervisor_proposals set status='executing',revision=revision+1
 where id=:'pa' returning revision as current_revision \gset
insert into public.supervisor_effect_attempts(attempt_key,business_id,proposal_id,effect_hash,
 authorization_kind,business_date,state)
values (:'attempt',:'ba',:'pa',repeat('c',64),'click',current_date,'executing');
insert into public.connector_provider_receipts(account_id,business_id,owner_user_id,
 proposal_id,effect_hash,account_generation,operation,rfc_message_id,state)
values (:'account_id',:'ba',:'oa',:'pa',repeat('c',64),1,'send',
 '<aicafe-test@example.invalid>','pending');

select set_config('test.ba',:'ba',true);
select set_config('test.bb',:'bb',true);
select set_config('test.oa',:'oa',true);
select set_config('test.ob',:'ob',true);
select set_config('test.ta',:'ta',true);
select set_config('test.pa',:'pa',true);
select set_config('test.attempt',:'attempt',true);
select set_config('test.revision',:'current_revision',true);
do $proof$
begin
 begin
  perform public.supervisor_finish_gmail_effect_attempt(
   current_setting('test.ba')::uuid,current_setting('test.oa')::uuid,
   current_setting('test.ta')::uuid,current_setting('test.pa')::uuid,
   current_setting('test.attempt')::uuid,current_setting('test.revision')::integer,
   'verified','committed',current_date);
  raise exception 'verified without a Gmail provider receipt';
 exception when sqlstate '42501' then null; end;
 if (select status from public.supervisor_proposals where id=current_setting('test.pa')::uuid)<>'executing'
   then raise exception 'failed receipt incorrectly marked committed'; end if;
 begin
  perform public.supervisor_finish_gmail_effect_attempt(
   current_setting('test.bb')::uuid,current_setting('test.ob')::uuid,
   current_setting('test.ta')::uuid,current_setting('test.pa')::uuid,
   current_setting('test.attempt')::uuid,current_setting('test.revision')::integer,
   'verified','committed',current_date);
  raise exception 'cross-cafe receipt completed';
 exception when sqlstate 'P0001' then null; end;
end $proof$;

update public.connector_provider_receipts set state='verified',
 provider_message_id='gmail-confirmed-unique-id',provider_accepted_at=now()
 where business_id=:'ba' and proposal_id=:'pa';
select (public.supervisor_finish_gmail_effect_attempt(
 :'ba',:'oa',:'ta',:'pa',:'attempt',:'current_revision','verified','committed',current_date)).status
 as result_status \gset
do $proof$
begin
 if current_setting('test.ba') is null then raise exception 'missing scoped input';end if;
 if (select status from public.supervisor_proposals where id=current_setting('test.pa')::uuid)<>'committed'
 then raise exception 'Gmail receipt failed to commit'; end if;
 if (select receipt_ref from public.supervisor_effect_attempts
   where attempt_key=current_setting('test.attempt')::uuid)<>'gmail:gmail-confirmed-unique-id'
 then raise exception 'Gmail receipt did not replace internal attempt key';end if;
end $proof$;

rollback;
