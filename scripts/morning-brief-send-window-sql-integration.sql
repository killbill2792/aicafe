-- Migration 148 on a disposable database (never production).
-- A morning brief leaves any time before its own café deadline (not 05:50–06:00),
-- expires after it, never needs the 24-hour window; free-text replies still do.
-- Run after replaying every migration: psql -v ON_ERROR_STOP=1 -f this-file.
begin;
set local request.jwt.claim.role='service_role';
insert into auth.users(id,phone,phone_confirmed_at) values
  ('a0000000-0000-4000-8000-000000000001','+15556506570',now());
-- Café-local "now" decides the day; use a timezone whose local date is today.
insert into public.businesses(id,name,timezone,currency) values
  ('b0000000-0000-4000-8000-000000000001','Brief Test Café','UTC','USD');
insert into public.memberships(business_id,user_id,role) values
  ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','owner');
insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values
  ('c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001',gen_random_uuid());
insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding)
  select m.id,'b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001','supervisor','blocks',
   '[{"type":"text","text":"Good morning"}]'::jsonb,'{"status":"partial"}'::jsonb
  from (values ('d0000000-0000-4000-8000-000000000001'::uuid),('d0000000-0000-4000-8000-000000000002'::uuid)) m(id);
-- The binding guard trigger accepts only the signed-in owner with a verified phone.
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='a0000000-0000-4000-8000-000000000001';
insert into public.whatsapp_owner_bindings(id,phone_number_id,wa_id,business_id,owner_user_id,thread_id,
  opted_in,consent_at) values ('e0000000-0000-4000-8000-000000000001','1322195347653883','15556506570',
  'b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',true,now());
set local request.jwt.claim.role='service_role';

do $$
declare v_id uuid; leased jsonb; st text; code text;
begin
  if not public.whatsapp_brief_send_window_ready() then raise exception 'marker missing'; end if;
  -- No owner message ever (last_owner_message_at null): a template still queues and leases.
  v_id:=public.whatsapp_enqueue_outbound('e0000000-0000-4000-8000-000000000001','daily-brief:test:today',
    'daily_brief',jsonb_build_object('fields',jsonb_build_array('a','b','c','d','e','f','g')),
    '{"source":"test","period":"x"}'::jsonb,'d0000000-0000-4000-8000-000000000001',null,
    (now() at time zone 'UTC')::date,now()+interval '20 minutes');
  if (select send_before from public.whatsapp_outbox where whatsapp_outbox.id=v_id) is null
    then raise exception 'send_before not stored'; end if;
  leased:=public.whatsapp_claim_outbound('daily_brief');
  if leased is null or (leased->>'id')::uuid<>v_id then
    raise exception 'brief before its own deadline was not claimed (time now %)',now();
  end if;
  update public.whatsapp_outbox set state='accepted' where whatsapp_outbox.id=v_id;

  -- A deadline in the past or more than a day ahead is refused at enqueue.
  begin
    perform public.whatsapp_enqueue_outbound('e0000000-0000-4000-8000-000000000001','daily-brief:test:past',
      'daily_brief','{"fields":[]}'::jsonb,'{"source":"t","period":"x"}'::jsonb,
      'd0000000-0000-4000-8000-000000000002',null,(now() at time zone 'UTC')::date,now()-interval '1 minute');
    raise exception 'past deadline accepted';
  exception when raise_exception then
    if sqlerrm<>'invalid_brief_deadline' then raise; end if;
  end;
  -- A reply never carries a brief deadline.
  begin
    perform public.whatsapp_enqueue_outbound('e0000000-0000-4000-8000-000000000001','reply:test:x',
      'reply','{"text":"hi"}'::jsonb,'{"source":"t","period":"x"}'::jsonb,
      'd0000000-0000-4000-8000-000000000002','wamid.none',null,now()+interval '5 minutes');
    raise exception 'reply with deadline accepted';
  exception when raise_exception then
    if sqlerrm not in ('invalid_reply_date','reply_not_ready') then raise; end if;
  end;

  -- A queued brief whose deadline passed is marked failed, never sent late.
  insert into public.whatsapp_outbox(dedupe_key,binding_id,business_id,owner_user_id,thread_id,kind,
    business_date,payload,source_message_id,send_before)
  values('daily-brief:test:expired','e0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','daily_brief',
    (now() at time zone 'UTC')::date - 1,'{"fields":[]}'::jsonb,'d0000000-0000-4000-8000-000000000002',now()-interval '1 minute')
  returning whatsapp_outbox.id into v_id;
  leased:=public.whatsapp_claim_outbound('daily_brief');
  select state,failure_code into st,code from public.whatsapp_outbox where whatsapp_outbox.id=v_id;
  if leased is not null or st<>'failed' or code<>'brief_deadline_expired' then
    raise exception 'expired brief not failed: % % %',leased,st,code;
  end if;
end $$;

-- Skip records: RLS on, service role only, one row per café/day/owner/channel/run kind.
do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.morning_brief_runs'::regclass)
    then raise exception 'RLS off on morning_brief_runs'; end if;
  if has_table_privilege('authenticated','public.morning_brief_runs','select')
    then raise exception 'authenticated can read morning_brief_runs'; end if;
  insert into public.morning_brief_runs(business_id,local_date,owner_key,channel,run_kind,step,outcome,reason)
    values('b0000000-0000-4000-8000-000000000001','2026-11-03','cafe','in_app','scheduled','pos_sync','waiting','yesterday_pos_data_not_complete')
    on conflict(business_id,local_date,owner_key,channel,run_kind)
    do update set step=excluded.step,outcome=excluded.outcome,reason=excluded.reason;
  insert into public.morning_brief_runs(business_id,local_date,owner_key,channel,run_kind,step,outcome,reason)
    values('b0000000-0000-4000-8000-000000000001','2026-11-03','cafe','in_app','scheduled','brief','sent','done')
    on conflict(business_id,local_date,owner_key,channel,run_kind)
    do update set step=excluded.step,outcome=excluded.outcome,reason=excluded.reason;
  if (select count(*) from public.morning_brief_runs)<>1 or
     (select outcome from public.morning_brief_runs)<>'sent' then raise exception 'run upsert broken'; end if;
  begin
    insert into public.morning_brief_runs(business_id,local_date,owner_key,channel,run_kind,step,outcome,reason)
      values('b0000000-0000-4000-8000-000000000001','2026-11-03','cafe','in_app','scheduled','x','maybe','r');
    raise exception 'bad outcome accepted';
  exception when check_violation then null;
  end;
end $$;
rollback;
\echo 'morning brief send window: all checks passed'
