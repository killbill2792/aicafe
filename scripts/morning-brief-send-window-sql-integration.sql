-- Migration 148 on a disposable database (never production).
-- Two cafés, three owners, café-local dates, one owner/day outbox identity,
-- retriable 429, five-attempt cap, terminal 4xx, lease-expiry uncertainty and durable run ledger.
-- Run after replaying every migration: psql -v ON_ERROR_STOP=1 -f this-file.
begin;
set local request.jwt.claim.role='service_role';
insert into auth.users(id,phone,phone_confirmed_at) values
  ('a0000000-0000-4000-8000-000000000001','+15556506570',now()),
  ('a0000000-0000-4000-8000-000000000002','+15556506571',now()),
  ('a0000000-0000-4000-8000-000000000003','+15556506572',now());
insert into public.businesses(id,name,timezone,currency) values
  ('b0000000-0000-4000-8000-000000000001','Brief Test West','America/Los_Angeles','USD'),
  ('b0000000-0000-4000-8000-000000000002','Brief Test East','America/New_York','CAD');
insert into public.memberships(business_id,user_id,role) values
  ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','owner'),
  ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','owner'),
  ('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000003','owner');
insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values
  ('c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001',gen_random_uuid()),
  ('c0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000002',gen_random_uuid()),
  ('c0000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000003',gen_random_uuid());
insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding)
values
  ('d0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
   'supervisor','blocks','[{"type":"text","text":"Good morning"}]'::jsonb,'{"status":"partial"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002',
   'supervisor','blocks','[{"type":"text","text":"Good morning"}]'::jsonb,'{"status":"partial"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000002',
   'c0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000003',
   'supervisor','blocks','[{"type":"text","text":"Good morning"}]'::jsonb,'{"status":"partial"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000004','b0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
   'supervisor','blocks','[{"type":"text","text":"Retry source"}]'::jsonb,'{"status":"partial"}'::jsonb);
-- The binding guard accepts only the matching authenticated owner and verified phone.
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='a0000000-0000-4000-8000-000000000001';
insert into public.whatsapp_owner_bindings(id,phone_number_id,wa_id,business_id,owner_user_id,thread_id,
  opted_in,consent_at) values
  ('e0000000-0000-4000-8000-000000000001','1322195347653883','15556506570',
   'b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001',true,now());
set local request.jwt.claim.sub='a0000000-0000-4000-8000-000000000002';
insert into public.whatsapp_owner_bindings(id,phone_number_id,wa_id,business_id,owner_user_id,thread_id,
  opted_in,consent_at) values
  ('e0000000-0000-4000-8000-000000000002','1322195347653883','15556506571',
   'b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002',
   'c0000000-0000-4000-8000-000000000002',true,now());
set local request.jwt.claim.sub='a0000000-0000-4000-8000-000000000003';
insert into public.whatsapp_owner_bindings(id,phone_number_id,wa_id,business_id,owner_user_id,thread_id,
  opted_in,consent_at) values
  ('e0000000-0000-4000-8000-000000000003','1322195347653883','15556506572',
   'b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000003',
   'c0000000-0000-4000-8000-000000000003',true,now());
set local request.jwt.claim.role='service_role';

do $$
declare
  la_day date := (now() at time zone 'America/Los_Angeles')::date;
  ny_day date := (now() at time zone 'America/New_York')::date;
  la_id uuid; la_retry jsonb; la_expired jsonb; ny_id uuid; ny_lease jsonb; west_two_id uuid; west_two jsonb;
  st text; code text; tries integer; attempt_no integer;
begin
  if not public.whatsapp_brief_send_window_ready() then raise exception 'marker missing'; end if;
  if (select timezone from public.businesses where id='b0000000-0000-4000-8000-000000000001')
       <> 'America/Los_Angeles'
     or (select timezone from public.businesses where id='b0000000-0000-4000-8000-000000000002')
       <> 'America/New_York' then raise exception 'café timezones were not retained'; end if;

  -- West owner: exact local-day dedupe is idempotent, then 429 requeues under the attempt cap.
  la_id:=public.whatsapp_enqueue_outbound('e0000000-0000-4000-8000-000000000001',
    'daily-brief:b0000000-0000-4000-8000-000000000001:a0000000-0000-4000-8000-000000000001:'||la_day,
    'daily_brief','{"fields":["west"]}'::jsonb,'{"source":"test","period":"yesterday"}'::jsonb,
    'd0000000-0000-4000-8000-000000000001',null,la_day,now()+interval '20 minutes');
  if public.whatsapp_enqueue_outbound('e0000000-0000-4000-8000-000000000001',
    'daily-brief:b0000000-0000-4000-8000-000000000001:a0000000-0000-4000-8000-000000000001:'||la_day,
    'daily_brief','{"fields":["west"]}'::jsonb,'{"source":"test","period":"yesterday"}'::jsonb,
    'd0000000-0000-4000-8000-000000000001',null,la_day,now()+interval '20 minutes')<>la_id
    then raise exception 'same owner/day retry did not return its original outbox row'; end if;
  la_retry:=public.whatsapp_claim_outbound('daily_brief');
  if la_retry is null or (la_retry->>'id')::uuid<>la_id
    or (la_retry->>'business_date')::date<>la_day then
    raise exception 'west brief before its café deadline was not claimed'; end if;
  if not public.whatsapp_finish_outbound(la_id,(la_retry->>'lease_token')::uuid,'retry',null,'rate_limited')
    then raise exception 'rate-limited brief lease was not finished'; end if;
  select state,attempts into st,tries from public.whatsapp_outbox where id=la_id;
  if st<>'queued' or tries<>1 then raise exception '429 did not queue a capped retry: % %',st,tries; end if;
  la_expired:=public.whatsapp_claim_outbound('daily_brief');
  if la_expired is null or (la_expired->>'id')::uuid<>la_id then
    raise exception 'west brief retry was not claimable before its deadline'; end if;
  update public.whatsapp_outbox set leased_until=now()-interval '1 minute' where id=la_id;
  perform public.whatsapp_claim_outbound('daily_brief');
  select state,failure_code,attempts into st,code,tries from public.whatsapp_outbox where id=la_id;
  if st<>'uncertain' or code<>'lease_expired' or tries<>2 then
    raise exception 'expired lease was not held as uncertain: % % %',st,code,tries; end if;

  -- Second west owner: 429 retries stop at the database's five-attempt cap.
  west_two_id:=public.whatsapp_enqueue_outbound('e0000000-0000-4000-8000-000000000002',
    'daily-brief:b0000000-0000-4000-8000-000000000001:a0000000-0000-4000-8000-000000000002:'||la_day,
    'daily_brief','{"fields":["west-two"]}'::jsonb,'{"source":"test","period":"yesterday"}'::jsonb,
    'd0000000-0000-4000-8000-000000000002',null,la_day,now()+interval '20 minutes');
  for attempt_no in 1..5 loop
    west_two:=public.whatsapp_claim_outbound('daily_brief');
    if west_two is null or (west_two->>'id')::uuid<>west_two_id then
      raise exception 'second west owner retry % was not isolated',attempt_no; end if;
    if not public.whatsapp_finish_outbound(west_two_id,(west_two->>'lease_token')::uuid,
      'retry',null,'rate_limited') then raise exception 'rate-limit retry % was not finished',attempt_no; end if;
    select state,attempts into st,tries from public.whatsapp_outbox where id=west_two_id;
    if attempt_no<5 and st<>'queued' then raise exception 'retry stopped before the cap at %: %',attempt_no,st; end if;
    if attempt_no=5 and (st<>'failed' or tries<>5) then
      raise exception 'retry attempt cap was not terminal: % %',st,tries; end if;
  end loop;

  -- East café has its own owner and local date; a definitive 4xx is terminal and visible.
  ny_id:=public.whatsapp_enqueue_outbound('e0000000-0000-4000-8000-000000000003',
    'daily-brief:b0000000-0000-4000-8000-000000000002:a0000000-0000-4000-8000-000000000003:'||ny_day,
    'daily_brief','{"fields":["east"]}'::jsonb,'{"source":"test","period":"yesterday"}'::jsonb,
    'd0000000-0000-4000-8000-000000000003',null,ny_day,now()+interval '40 minutes');
  ny_lease:=public.whatsapp_claim_outbound('daily_brief');
  if ny_lease is null or (ny_lease->>'id')::uuid<>ny_id or
     (ny_lease->>'business_date')::date<>ny_day then raise exception 'east café local day was not claimed'; end if;
  if not public.whatsapp_finish_outbound(ny_id,(ny_lease->>'lease_token')::uuid,
    'failed',null,'provider_rejected:http400') then raise exception '4xx lease was not finished'; end if;
  select state,failure_code into st,code from public.whatsapp_outbox where id=ny_id;
  if st<>'failed' or code<>'provider_rejected:http400' then raise exception '4xx was not terminal/visible'; end if;

  -- A different source message cannot create a second brief for the same owner/café/local day.
  begin
    perform public.whatsapp_enqueue_outbound('e0000000-0000-4000-8000-000000000001',
      'daily-brief:second-key:'||la_day,'daily_brief','{"fields":["duplicate"]}'::jsonb,
      '{"source":"test","period":"yesterday"}'::jsonb,'d0000000-0000-4000-8000-000000000004',
      null,la_day,now()+interval '20 minutes');
    raise exception 'second owner/café/local-date brief was accepted';
  exception when unique_violation then null;
  end;
  if (select count(*) from public.whatsapp_outbox where kind='daily_brief'
      and business_id in ('b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002'))<>3
    then raise exception 'outbox did not preserve one row per owner/café/day'; end if;
  if public.whatsapp_claim_outbound('daily_brief') is not null then
    raise exception 'failed or uncertain rows were blindly claimed again'; end if;
end $$;

-- Skip records: RLS on, service role only, one row per café/day/owner/channel/run kind.
do $$
declare
  la_day date := (now() at time zone 'America/Los_Angeles')::date;
  ny_day date := (now() at time zone 'America/New_York')::date;
begin
  if not (select relrowsecurity from pg_class where oid='public.morning_brief_runs'::regclass)
    then raise exception 'RLS off on morning_brief_runs'; end if;
  if has_table_privilege('authenticated','public.morning_brief_runs','select')
    then raise exception 'authenticated can read morning_brief_runs'; end if;
  if not has_table_privilege('service_role','public.morning_brief_runs','insert')
    then raise exception 'service_role cannot record brief outcomes'; end if;
  insert into public.morning_brief_runs(business_id,local_date,owner_key,channel,run_kind,step,outcome,reason)
    values
      ('b0000000-0000-4000-8000-000000000001',la_day,'a0000000-0000-4000-8000-000000000001','in_app','scheduled','pos_sync','waiting','yesterday_pos_data_not_complete'),
      ('b0000000-0000-4000-8000-000000000002',ny_day,'a0000000-0000-4000-8000-000000000003','in_app','scheduled','pos_sync','waiting','yesterday_pos_data_not_complete')
    on conflict(business_id,local_date,owner_key,channel,run_kind)
    do update set step=excluded.step,outcome=excluded.outcome,reason=excluded.reason;
  insert into public.morning_brief_runs(business_id,local_date,owner_key,channel,run_kind,step,outcome,reason)
    values('b0000000-0000-4000-8000-000000000001',la_day,'a0000000-0000-4000-8000-000000000001',
      'in_app','scheduled','schedule','skipped','missed_send_window')
    on conflict(business_id,local_date,owner_key,channel,run_kind)
    do update set step=excluded.step,outcome=excluded.outcome,reason=excluded.reason;
  if (select count(*) from public.morning_brief_runs where business_id in
      ('b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002'))<>2
     or (select outcome from public.morning_brief_runs where business_id='b0000000-0000-4000-8000-000000000001')<>'skipped'
    then raise exception 'run ledger lost café/owner/day identity or final missed state'; end if;
  begin
    insert into public.morning_brief_runs(business_id,local_date,owner_key,channel,run_kind,step,outcome,reason)
      values('b0000000-0000-4000-8000-000000000001',la_day,'a0000000-0000-4000-8000-000000000001',
        'in_app','scheduled','x','maybe','r');
    raise exception 'bad outcome accepted';
  exception when check_violation then null;
  end;
end $$;
rollback;
\echo 'morning brief send window: all checks passed'
