-- Canonical incremental progress is distinct from the old staging-only cursor.
-- Reuse the existing health, progress, raw archive, and repair queue. No history deleted.
alter table public.toast_sync_health add column if not exists canonical_order_poll_at timestamptz;
alter table public.toast_sync_health add column if not exists canonical_live_day date;
alter table public.toast_order_poll_progress add column if not exists canonical boolean not null default false;
alter table public.toast_order_poll_progress add column if not exists bootstrap_day date;

create or replace function public.toast_archive_order(
 p_business_id uuid,p_restaurant_guid uuid,p_entity_guid uuid,p_business_date date,
 p_payload jsonb,p_sha text,p_run_id uuid,p_page integer,p_source_index integer,
 p_capture_key text,p_commit boolean
) returns text language plpgsql security definer set search_path=public as $order$
declare cur public.toast_raw_records%rowtype; diff jsonb; new_id uuid;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 for attempt in 1..2 loop
  select * into cur from public.toast_raw_records r
  where r.business_id=p_business_id and r.restaurant_guid is not distinct from p_restaurant_guid
   and r.business_date=p_business_date and r.entity='order' and r.entity_guid=p_entity_guid
  order by r.last_seen desc,r.id desc limit 1 for update;
  exit when found;
  -- Two writers can meet on a new order (the live job and a chat refresh).
  -- The loser of the race reads the winner's record and continues from it.
  insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,
   business_date,payload,payload_sha256,run_id,seen_run_id,source_page,source_index,capture_key)
  values(p_business_id,p_restaurant_guid,'order',p_entity_guid,p_business_date,p_payload,
   p_sha,p_run_id,p_run_id,p_page,p_source_index,p_capture_key)
  on conflict do nothing returning id into new_id;
  if new_id is not null then return 'inserted'; end if;
 end loop;
 if not found then raise exception 'toast archive: order record not readable'; end if;
 if p_run_id is null and (cur.run_id is not null or cur.seen_run_id is not null) then
  -- Live mode: an import already owns this record. The import is the authority.
  return 'skipped';
 end if;
 if cur.payload_sha256<>p_sha
  and p_payload->>'modifiedDate' is not null and cur.payload->>'modifiedDate' is not null
  and public.toast_time_or_null(p_payload->>'modifiedDate')<public.toast_time_or_null(cur.payload->>'modifiedDate') then
  -- An older version than the one stored: never replace newer data with older data.
  return 'older';
 elsif cur.payload_sha256<>p_sha then
  -- Real change (list order is already sorted by the app): log it, update in place.
  select coalesce(jsonb_agg(jsonb_build_object('path',d.path,'before',d.before,'after',d.after)
    order by d.path),'[]'::jsonb) into diff
  from public.toast_json_diff(public.toast_stable_json(cur.payload),
   public.toast_stable_json(p_payload)) d;
  if jsonb_array_length(diff)>0 then
   insert into public.toast_raw_changes(business_id,restaurant_guid,entity,entity_guid,
    business_date,run_id,changes)
   values(cur.business_id,cur.restaurant_guid,cur.entity,cur.entity_guid,cur.business_date,
    p_run_id,diff);
  end if;
  update public.toast_raw_records set payload=p_payload,payload_sha256=p_sha,
   seen_run_id=p_run_id,last_seen=now(),
   run_id=case when p_commit then p_run_id else run_id end,
   source_page=case when p_commit then p_page else source_page end,
   source_index=case when p_commit then p_source_index else source_index end
  where id=cur.id;
  delete from public.toast_order_typed_facts where raw_record_id=cur.id;
  perform public.toast_capture_typed_order(cur.id);
  return 'changed';
 elsif cur.seen_run_id is distinct from p_run_id
  or (p_commit and cur.run_id is distinct from p_run_id) then
  update public.toast_raw_records set seen_run_id=p_run_id,last_seen=now(),
   run_id=case when p_commit then p_run_id else run_id end,
   source_page=case when p_commit then p_page else source_page end,
   source_index=case when p_commit then p_source_index else source_index end
  where id=cur.id;
  if p_commit then
   update public.toast_order_typed_facts set run_id=p_run_id
   where raw_record_id=cur.id and run_id is distinct from p_run_id;
  end if;
 end if;
 return 'same';
end $order$;
revoke all on function public.toast_archive_order(uuid,uuid,uuid,date,jsonb,text,uuid,integer,integer,text,boolean)
 from public,anon,authenticated;
grant execute on function public.toast_archive_order(uuid,uuid,uuid,date,jsonb,text,uuid,integer,integer,text,boolean)
 to service_role;


-- Common raw archive path for signed event-triggered GET and incremental pages.
-- The whole-day writer still owns finalized normalized data. A changed historical
-- object enqueues one coalesced repair, never a recurring backfill.
create or replace function public.toast_ingest_order_revisions(
 p_business_id uuid,p_restaurant_guid uuid,p_rows jsonb)
returns integer language plpgsql security invoker set search_path=public as $$
declare m record; item jsonb; payload jsonb; d date; current_day date;
 g uuid; prior public.toast_raw_records%rowtype; sha text; result text; changed integer:=0;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_rows) is distinct from 'array'
  or jsonb_array_length(p_rows)>100 then raise exception 'invalid order revision batch'; end if;
 select toast_time_zone,closeout_hour into m from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null for share;
 if not found or m.toast_time_zone is null or m.closeout_hour is null then raise exception 'unverified Toast location'; end if;
 current_day:=((now() at time zone m.toast_time_zone)-make_interval(hours=>m.closeout_hour))::date;
 -- Acquire date locks in stable order, matching the finalized importer.
 for d in select distinct (x->>'day')::date from jsonb_array_elements(p_rows) x order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('toast-day:'||p_business_id::text||':'||d::text,0));
 end loop;
 for item in select value from jsonb_array_elements(p_rows) loop
  d:=(item->>'day')::date; payload:=item->'payload'; g:=(payload->>'guid')::uuid;
  if d is null or g is null or jsonb_typeof(payload) is distinct from 'object'
   or public.toast_time_or_null(payload->>'modifiedDate') is null
   or (payload->>'businessDate' is not null and payload->>'businessDate'<>to_char(d,'YYYYMMDD'))
   then raise exception 'invalid order revision';end if;
  sha:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
  select * into prior from public.toast_raw_records
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid and business_date=d
    and entity='order' and entity_guid=g order by last_seen desc,id desc limit 1;
  if found and (prior.payload_sha256=sha or
   public.toast_time_or_null(prior.payload->>'modifiedDate')>public.toast_time_or_null(payload->>'modifiedDate')) then continue;end if;
  if d>=current_day and not exists(select 1 from public.toast_day_status s
    where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid and s.business_date=d and s.import_state='imported') then
   result:=public.toast_archive_order(p_business_id,p_restaurant_guid,g,d,payload,sha,null,null,null,
    'live:'||p_restaurant_guid::text||':'||d::text||':'||g::text,false);
   if result in ('inserted','changed') then changed:=changed+1;end if;
  else
   perform public.toast_queue_owner_repull(p_business_id,p_restaurant_guid,d);
  end if;
 end loop;
 return changed;
end $$;
revoke all on function public.toast_ingest_order_revisions(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.toast_ingest_order_revisions(uuid,uuid,jsonb) to service_role;

-- The existing lease fences both writes and the canonical page checkpoint.
-- A page commit is atomic; failed or stale workers cannot advance coverage.
create or replace function public.toast_commit_canonical_order_page(
 p_business_id uuid,p_restaurant_guid uuid,p_nonce uuid,
 p_since timestamptz,p_until timestamptz,p_page integer,p_rows jsonb,p_has_more boolean,
 p_bootstrap_day date)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare progress public.toast_order_poll_progress%rowtype; changed integer;
begin
 if auth.role() is distinct from 'service_role' or p_since is null or p_until is null
  or p_since>=p_until or p_until>now() or p_until-p_since>interval '30 days'
  or p_page<1 or p_page>1000 or p_has_more is null or jsonb_typeof(p_rows) is distinct from 'array'
  or jsonb_array_length(p_rows)>100 or (p_has_more and (p_page=1000 or jsonb_array_length(p_rows)<>100))
  then raise exception 'invalid canonical order page'; end if;
 perform 1 from public.toast_poll_leases where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and kind='orders' and lease_nonce=p_nonce and lease_until>clock_timestamp() for update;
 if not found then raise exception 'canonical order poll lease expired';end if;
 select * into progress from public.toast_order_poll_progress where business_id=p_business_id
  and restaurant_guid=p_restaurant_guid for update;
 if found and progress.canonical then
  if progress.window_since<>p_since or progress.window_until<>p_until or progress.next_page<>p_page
   or progress.bootstrap_day is distinct from p_bootstrap_day then raise exception 'canonical order checkpoint mismatch';end if;
 elsif p_page<>1 then raise exception 'canonical order first page required';end if;
 changed:=public.toast_ingest_order_revisions(p_business_id,p_restaurant_guid,p_rows);
 if p_has_more then
  insert into public.toast_order_poll_progress(business_id,restaurant_guid,window_since,window_until,next_page,is_recovery,canonical,bootstrap_day)
   values(p_business_id,p_restaurant_guid,p_since,p_until,p_page+1,false,true,p_bootstrap_day)
   on conflict(business_id,restaurant_guid) do update set window_since=excluded.window_since,
    window_until=excluded.window_until,next_page=excluded.next_page,is_recovery=false,canonical=true,
    bootstrap_day=excluded.bootstrap_day,updated_at=now();
 else
  delete from public.toast_order_poll_progress where business_id=p_business_id and restaurant_guid=p_restaurant_guid and canonical;
  insert into public.toast_sync_health(business_id,restaurant_guid,canonical_order_poll_at,canonical_live_day)
   values(p_business_id,p_restaurant_guid,case when p_bootstrap_day is null then p_until else p_since end,p_bootstrap_day)
   on conflict(business_id,restaurant_guid) do update set
    canonical_order_poll_at=case when p_bootstrap_day is null then greatest(toast_sync_health.canonical_order_poll_at,p_until)
     else coalesce(toast_sync_health.canonical_order_poll_at,p_since) end,
    canonical_live_day=coalesce(p_bootstrap_day,toast_sync_health.canonical_live_day);
 end if;
 return jsonb_build_object('changed',changed,'complete',not p_has_more);
end $$;
revoke all on function public.toast_commit_canonical_order_page(uuid,uuid,uuid,timestamptz,timestamptz,integer,jsonb,boolean,date) from public,anon,authenticated;
grant execute on function public.toast_commit_canonical_order_page(uuid,uuid,uuid,timestamptz,timestamptz,integer,jsonb,boolean,date) to service_role;
