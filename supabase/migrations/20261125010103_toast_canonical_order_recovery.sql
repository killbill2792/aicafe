set lock_timeout = '5s';
set statement_timeout = '60s';
-- Canonical incremental progress is distinct from the old staging-only cursor.
-- Reuse the existing health, progress, raw archive, and repair queue. No history deleted.
alter table public.toast_raw_records add column if not exists live_projection jsonb;
alter table public.toast_sync_health add column if not exists canonical_order_poll_at timestamptz;
alter table public.toast_sync_health add column if not exists canonical_order_poll_from timestamptz;
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



-- A late order correction uses the existing durable repull run. Preserve the
-- complete redacted provider revision until a guarded import commits it.
-- Existing owner/full-day recovery remains full-day and can supersede this mode.
create or replace function public.toast_queue_order_revision(
 p_business_id uuid,p_restaurant_guid uuid,p_date date,p_payload jsonb,p_allow_local boolean)
returns uuid language plpgsql security invoker set search_path=public as $$
declare job uuid; cur jsonb; rev jsonb; old jsonb; g text;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_payload) is distinct from 'object'
  or public.toast_uuid_or_null(p_payload->>'guid') is null
  or public.toast_time_or_null(p_payload->>'modifiedDate') is null
  or p_allow_local is null then raise exception 'invalid source revision';end if;
 if not exists(select 1 from public.toast_location_mappings where business_id=p_business_id
  and restaurant_guid=p_restaurant_guid and verified_at is not null) then raise exception 'unverified Toast location';end if;
 perform pg_advisory_xact_lock(hashtextextended('toast-day:'||p_business_id::text||':'||p_date::text,0));
 g:=p_payload->>'guid';
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,requested_from,requested_to,days_total,cursor)
 values(p_business_id,p_restaurant_guid,'repull_modified',p_date,p_date,1,
  jsonb_build_object('revision',jsonb_build_object('only',p_allow_local,'orders',jsonb_build_object(g,p_payload))))
 on conflict(business_id,restaurant_guid,requested_from,requested_to)
 where kind='repull_modified' and state in ('queued','running','paused_rate_limited')
 do nothing returning id into job;
 if job is not null then return job;end if;
 select id,cursor into job,cur from public.toast_sync_runs where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and requested_from=p_date and requested_to=p_date and kind='repull_modified'
  and state in ('queued','running','paused_rate_limited') for update;
 if job is null then raise exception 'revision repair unavailable';end if;
 rev:=coalesce(cur->'revision','{"only":false,"orders":{}}'::jsonb);
 old:=rev->'orders'->g;
 if old is not null and (old=p_payload or
  public.toast_time_or_null(old->>'modifiedDate')>public.toast_time_or_null(p_payload->>'modifiedDate')) then return job;end if;
 rev:=jsonb_set(rev,'{orders}',coalesce(rev->'orders','{}'::jsonb)||jsonb_build_object(g,p_payload),true);
 if not p_allow_local then rev:=jsonb_set(rev,'{only}','false'::jsonb,true);end if;
 update public.toast_sync_runs set cursor=jsonb_set(coalesce(cur,'{}'::jsonb),'{revision}',rev,true) where id=job;
 return job;
end $$;
revoke all on function public.toast_queue_order_revision(uuid,uuid,date,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.toast_queue_order_revision(uuid,uuid,date,jsonb,boolean) to service_role;

-- Existing full-day repair/manual requests must never be narrowed to a local patch.
CREATE OR REPLACE FUNCTION public.toast_queue_owner_repull(p_business_id uuid, p_restaurant_guid uuid, p_date date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;v_zone text;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 select toast_time_zone into v_zone from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and verified_at is not null for share;
 if v_zone is null or p_date<'2015-12-02'::date or
  p_date >= (now() at time zone v_zone)::date
 then raise exception 'invalid repull day';end if;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
  requested_from,requested_to,days_total,cursor)
 values(p_business_id,p_restaurant_guid,'repull_modified',p_date,p_date,1,'{}'::jsonb)
 on conflict(business_id,restaurant_guid,requested_from,requested_to)
 where kind='repull_modified' and state in ('queued','running','paused_rate_limited')
 do nothing returning id into v_id;
 if v_id is null then
  select id into v_id from public.toast_sync_runs
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid
    and kind='repull_modified' and requested_from=p_date and requested_to=p_date
    and state in ('queued','running','paused_rate_limited')
   order by id limit 1;
 end if;
 if v_id is null then raise exception 'unable to queue repull';end if;
 update public.toast_sync_runs set cursor=jsonb_set(cursor,'{revision,only}','false'::jsonb,true)
  where id=v_id and cursor->'revision'->>'only'='true';
 return v_id;
end $function$
;

-- Capture the exact revision generation before reading the old complete archive.
-- If another event arrived while pages were staged, resume from a clean source.
create or replace function public.toast_begin_revision_import(
 p_business_id uuid,p_restaurant_guid uuid,p_date date,p_run_id uuid,p_force_full boolean default false)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare cur jsonb; rev jsonb; token text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service role only';end if;
 perform pg_advisory_xact_lock(hashtextextended('toast-day:'||p_business_id::text||':'||p_date::text,0));
 select cursor into cur from public.toast_sync_runs where id=p_run_id and business_id=p_business_id
  and restaurant_guid=p_restaurant_guid and requested_from=p_date and requested_to=p_date
  and kind='repull_modified' and state in ('queued','running','paused_rate_limited') for update;
 if not found then raise exception 'invalid revision run';end if;
 rev:=coalesce(cur->'revision','{"only":false,"orders":{}}'::jsonb);
 if p_force_full then rev:=jsonb_set(rev,'{only}','false'::jsonb,true);end if;
 token:=encode(sha256(convert_to(rev::text,'UTF8')),'hex');
 if (cur->>'revision_snapshot') is distinct from token and
    (cur ? 'revision_snapshot' or cur ? 'revision' or p_force_full) then
  delete from public.toast_day_pages where run_id=p_run_id and business_date=p_date;
 end if;
 update public.toast_sync_runs set cursor=coalesce(cur,'{}'::jsonb)||
  jsonb_build_object('revision',rev,'revision_snapshot',token) where id=p_run_id;
 return jsonb_build_object('revision',rev,'token',token);
end $$;
revoke all on function public.toast_begin_revision_import(uuid,uuid,date,uuid,boolean) from public,anon,authenticated;
grant execute on function public.toast_begin_revision_import(uuid,uuid,date,uuid,boolean) to service_role;

-- Preserve revision work through the existing page and retry checkpoints.
CREATE OR REPLACE FUNCTION public.toast_stage_day_page(p_business_id uuid, p_restaurant_guid uuid, p_run_id uuid, p_business_date date, p_page integer, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if auth.role()<>'service_role' or p_page not between 1 and 300
  or jsonb_typeof(p_payload)<>'array' or jsonb_array_length(p_payload)>100
  or not exists(select 1 from public.toast_sync_runs r where r.id=p_run_id
   and r.business_id=p_business_id and r.restaurant_guid=p_restaurant_guid
   and r.state in ('queued','running','paused_rate_limited'))
 then raise exception 'invalid Toast page';end if;
 insert into public.toast_day_pages(run_id,business_date,page,payload)
 values(p_run_id,p_business_date,p_page,p_payload)
 on conflict do nothing;
 update public.toast_sync_runs set cursor=coalesce(cursor,'{}'::jsonb)||jsonb_build_object('business_date',p_business_date,'page',p_page+1),
  api_calls=api_calls+1,orders_seen=orders_seen+jsonb_array_length(p_payload),state='running',
  started_at=coalesce(started_at,now()) where id=p_run_id;
end $function$
;
CREATE OR REPLACE FUNCTION public.toast_checkpoint_day(p_run_id uuid, p_business_id uuid, p_restaurant_guid uuid, p_business_date date, p_page integer, p_category text, p_retry_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if auth.role()<>'service_role' or p_page not between 1 and 300
 then raise exception 'invalid Toast checkpoint';end if;
 update public.toast_sync_runs set state='paused_rate_limited',
 last_error_category=p_category,
 resume_at=case when p_category='timeout' then now()
  when p_category='rate_limited' then greatest(now(),coalesce(p_retry_at,now()+interval '1 minute'))
  else now()+make_interval(mins=>case coalesce((cursor->>'backoff_attempt')::integer,0)
   when 0 then 1 when 1 then 5 when 2 then 15 else 60 end) end,
 cursor=coalesce(cursor,'{}'::jsonb)||jsonb_build_object('business_date',p_business_date,'page',p_page,
  'backoff_attempt',case when p_category='timeout' then 0
   else least(coalesce((cursor->>'backoff_attempt')::integer,0)+1,4) end),
 rate_limited_count=rate_limited_count+case when p_category='rate_limited' then 1 else 0 end
 where id=p_run_id and business_id=p_business_id and restaurant_guid=p_restaurant_guid
 and state in ('queued','running','paused_rate_limited');
 if not found then raise exception 'invalid Toast run';end if;
 update public.toast_day_status set last_error_category=p_category
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and business_date=p_business_date;
end $function$
;

-- Use exactly the established financial day writer. For a verified local patch,
-- stage the reconstructed pages and commit in ONE transaction, so no mixed
-- source generation or transient uncommitted archive can be accepted.
create or replace function public.toast_commit_revision_day(
 p_business_id uuid,p_location_id uuid,p_restaurant_guid uuid,p_business_date date,
 p_orders jsonb,p_summary jsonb,p_run_id uuid,p_revision_token text,p_base_run_id uuid,p_local_pages jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare cur jsonb; rev jsonb; token text; item record;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service role only';end if;
 perform pg_advisory_xact_lock(hashtextextended('toast-day:'||p_business_id::text||':'||p_business_date::text,0));
 select cursor into cur from public.toast_sync_runs where id=p_run_id and business_id=p_business_id
  and restaurant_guid=p_restaurant_guid and requested_from=p_business_date and requested_to=p_business_date
  and kind='repull_modified' and state in ('queued','running','paused_rate_limited') for update;
 if not found then raise exception 'invalid revision run';end if;
 rev:=coalesce(cur->'revision','{"only":false,"orders":{}}'::jsonb);
 token:=encode(sha256(convert_to(rev::text,'UTF8')),'hex');
 if p_revision_token is distinct from token or cur->>'revision_snapshot' is distinct from token then
  raise exception 'new source revision arrived during repair' using errcode='40001';end if;
 if p_local_pages is not null then
  if rev->>'only' is distinct from 'true' or p_base_run_id is null
   or not exists(select 1 from public.toast_day_status where business_id=p_business_id
    and restaurant_guid=p_restaurant_guid and business_date=p_business_date and import_state='imported'
    and coverage_complete and unparsed_count=0 and last_import_run_id=p_base_run_id)
   or jsonb_typeof(p_local_pages) is distinct from 'array'
   or jsonb_array_length(p_local_pages) not between 1 and 300
   then raise exception 'local revision base no longer valid' using errcode='40001';end if;
  if exists(select 1 from jsonb_array_elements(p_local_pages) with ordinality x(payload,idx)
   where jsonb_typeof(x.payload) is distinct from 'array' or jsonb_array_length(x.payload)>100
    or (x.idx<jsonb_array_length(p_local_pages) and jsonb_array_length(x.payload)<>100)
    or (x.idx=jsonb_array_length(p_local_pages) and jsonb_array_length(x.payload)=100))
   then raise exception 'incomplete local revision pages';end if;
  delete from public.toast_day_pages where run_id=p_run_id and business_date=p_business_date;
  for item in select payload,idx from jsonb_array_elements(p_local_pages) with ordinality x(payload,idx) loop
   insert into public.toast_day_pages(run_id,business_date,page,payload)
    values(p_run_id,p_business_date,item.idx::integer,item.payload);
  end loop;
  update public.toast_sync_runs set state='running',started_at=coalesce(started_at,now()) where id=p_run_id;
 elsif rev->>'only'='true' then raise exception 'local source proof required';end if;
 return public.toast_import_day(p_business_id,p_location_id,p_restaurant_guid,p_business_date,p_orders,p_summary,p_run_id);
end $$;
revoke all on function public.toast_commit_revision_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.toast_commit_revision_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid,text,uuid,jsonb) to service_role;

-- Common raw archive path for signed event-triggered GET and incremental pages.
-- The guarded day writer owns finalized normalized data. A changed historical
-- object patches a proven local snapshot; incomplete/moved orders use source repair.
create or replace function public.toast_ingest_order_revisions(
 p_business_id uuid,p_restaurant_guid uuid,p_rows jsonb)
returns integer language plpgsql security invoker set search_path=public as $$
declare m record; item jsonb; payload jsonb; d date; current_day date;
 g uuid; prior public.toast_raw_records%rowtype; sha text; result text; changed integer:=0; old_day date; moved boolean;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_rows) is distinct from 'array'
  or jsonb_array_length(p_rows)>100 then raise exception 'invalid order revision batch'; end if;
 select toast_time_zone,closeout_hour into m from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null for share;
 if not found or m.toast_time_zone is null or m.closeout_hour is null then raise exception 'unverified Toast location'; end if;
 current_day:=((now() at time zone m.toast_time_zone)-make_interval(hours=>m.closeout_hour))::date;
 -- Acquire date locks in stable order, matching the finalized importer.
 for d in
  select day from (
   select (x->>'day')::date as day from jsonb_array_elements(p_rows) x
   union
   select o.business_date from public.orders o join jsonb_array_elements(p_rows) x
    on o.pos_order_id='toast:'||p_restaurant_guid::text||':'||(x->'payload'->>'guid')
    where o.business_id=p_business_id and not o.toast_excluded
  ) affected where day is not null order by day
 loop
  perform pg_advisory_xact_lock(hashtextextended('toast-day:'||p_business_id::text||':'||d::text,0));
 end loop;
 for item in select value from jsonb_array_elements(p_rows) loop
  d:=(item->>'day')::date; payload:=item->'payload'; g:=(payload->>'guid')::uuid;
  if d is null or g is null or jsonb_typeof(payload) is distinct from 'object'
   or jsonb_typeof(item->'projection') is distinct from 'object'
   or public.toast_time_or_null(payload->>'modifiedDate') is null
   or (payload->>'businessDate' is not null and payload->>'businessDate'<>to_char(d,'YYYYMMDD'))
   then raise exception 'invalid order revision';end if;
  sha:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
  select * into prior from public.toast_raw_records
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid and business_date=d
    and entity='order' and entity_guid=g order by last_seen desc,id desc limit 1;
  if found and public.toast_time_or_null(prior.payload->>'modifiedDate')>public.toast_time_or_null(payload->>'modifiedDate') then continue;end if;
  -- An order can change provider business date. Preserve independent proof for
  -- both affected days instead of pretending the old archived day is complete.
  moved:=false;
  for old_day in select distinct o.business_date from public.orders o where o.business_id=p_business_id
   and o.pos_order_id='toast:'||p_restaurant_guid::text||':'||g::text
   and o.business_date<>d and not o.toast_excluded
  loop
   moved:=true;
   if old_day<current_day then perform public.toast_queue_owner_repull(p_business_id,p_restaurant_guid,old_day);end if;
  end loop;
  if d>=current_day-1 and not exists(select 1 from public.toast_day_status s
    where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid and s.business_date=d and s.import_state='imported') then
   result:=public.toast_archive_order(p_business_id,p_restaurant_guid,g,d,payload,sha,null,null,null,
    'live:'||p_restaurant_guid::text||':'||d::text||':'||g::text,false);
   if result in ('inserted','changed','same') then
    update public.toast_raw_records set live_projection=item->'projection'
     where business_id=p_business_id and restaurant_guid=p_restaurant_guid and business_date=d
      and entity='order' and entity_guid=g and payload_sha256=sha
      and live_projection is distinct from item->'projection';
    if found then changed:=changed+1;end if;
   end if;
  elsif prior.id is null or prior.payload_sha256<>sha then
   perform public.toast_queue_order_revision(p_business_id,p_restaurant_guid,d,payload,
    not moved and exists(select 1 from public.toast_day_status s
     where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid and s.business_date=d
      and s.import_state='imported' and s.coverage_complete and s.unparsed_count=0 and s.last_import_run_id is not null));
   update public.toast_day_status set recon_state='pending',last_recon_attempt_at=null,internal_state=null
    where business_id=p_business_id and restaurant_guid=p_restaurant_guid and business_date=d
     and import_state='imported' and recon_state<>'pending';
   update public.daily_rollups set voids_status='unknown',voids_source=null
    where business_id=p_business_id and voids_status is distinct from 'unknown' and (business_date=d or business_date in (
     select f.void_business_date from public.toast_void_facts f where f.business_id=p_business_id and f.order_business_date=d));
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
declare progress public.toast_order_poll_progress%rowtype; changed integer; prior_cursor timestamptz; legacy_cursor timestamptz;
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
 select canonical_order_poll_at into prior_cursor from public.toast_sync_health where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 if p_bootstrap_day is null and prior_cursor is not null and p_since>prior_cursor then raise exception 'canonical order coverage gap';end if;
 changed:=public.toast_ingest_order_revisions(p_business_id,p_restaurant_guid,p_rows);
 if p_has_more then
  insert into public.toast_order_poll_progress(business_id,restaurant_guid,window_since,window_until,next_page,is_recovery,canonical,bootstrap_day)
   values(p_business_id,p_restaurant_guid,p_since,p_until,p_page+1,false,true,p_bootstrap_day)
   on conflict(business_id,restaurant_guid) do update set window_since=excluded.window_since,
    window_until=excluded.window_until,next_page=excluded.next_page,is_recovery=false,canonical=true,
    bootstrap_day=excluded.bootstrap_day,updated_at=now();
 else
  delete from public.toast_order_poll_progress where business_id=p_business_id and restaurant_guid=p_restaurant_guid and canonical;
  select last_window_end into legacy_cursor from public.toast_repull_scan_state where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
  insert into public.toast_sync_health(business_id,restaurant_guid,canonical_order_poll_at,canonical_order_poll_from,canonical_live_day)
   values(p_business_id,p_restaurant_guid,case when p_bootstrap_day is null then p_until else least(p_since,coalesce(legacy_cursor,p_since)) end,
    case when p_bootstrap_day is null then p_since end,p_bootstrap_day)
   on conflict(business_id,restaurant_guid) do update set
    canonical_order_poll_at=case when p_bootstrap_day is null then greatest(toast_sync_health.canonical_order_poll_at,p_until)
     else coalesce(toast_sync_health.canonical_order_poll_at,excluded.canonical_order_poll_at) end,
    canonical_order_poll_from=case when p_bootstrap_day is null then least(coalesce(toast_sync_health.canonical_order_poll_from,p_since),p_since)
     else toast_sync_health.canonical_order_poll_from end,
    canonical_live_day=coalesce(p_bootstrap_day,toast_sync_health.canonical_live_day);
 end if;
 return jsonb_build_object('changed',changed,'complete',not p_has_more);
end $$;
revoke all on function public.toast_commit_canonical_order_page(uuid,uuid,uuid,timestamptz,timestamptz,integer,jsonb,boolean,date) from public,anon,authenticated;
grant execute on function public.toast_commit_canonical_order_page(uuid,uuid,uuid,timestamptz,timestamptz,integer,jsonb,boolean,date) to service_role;

-- Refresh the existing one-row-per-café live summary entirely within Postgres.
-- No provider calls, raw payload transfer, new report or new order table.
create or replace function public.toast_refresh_canonical_live(p_business_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare d date; zone text; source_at timestamptz; n integer; ready integer; result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service role only';end if;
 perform pg_advisory_xact_lock(hashtextextended('toast-live:'||p_business_id::text,0));
 select b.timezone into zone from public.businesses b where b.id=p_business_id and not b.is_demo;
 if zone is null then return null;end if;
 select min(((now() at time zone m.toast_time_zone)-make_interval(hours=>m.closeout_hour))::date),
  count(*) into d,n
 from public.toast_location_mappings m where m.business_id=p_business_id and m.verified_at is not null
  and m.toast_time_zone is not null and m.closeout_hour is not null;
 if n=0 or d is null or n<>(select count(*) from public.toast_location_mappings m where m.business_id=p_business_id and m.verified_at is not null) then return null;end if;
 select count(*),min(h.canonical_order_poll_at) into ready,source_at
 from public.toast_location_mappings m join public.toast_sync_health h using(business_id,restaurant_guid)
 where m.business_id=p_business_id and m.verified_at is not null and h.canonical_live_day=d
  and h.canonical_order_poll_at is not null
  and ((now() at time zone m.toast_time_zone)-make_interval(hours=>m.closeout_hour))::date=d;
 if ready<>n then return null;end if;
 with revisions as materialized (
  select r.live_projection p
  from public.toast_raw_records r join public.toast_location_mappings m using(business_id,restaurant_guid)
  where r.business_id=p_business_id and r.business_date=d and r.entity='order'
   and m.verified_at is not null and r.live_projection is not null
   and not exists(select 1 from public.toast_raw_records newer
    where newer.business_id=r.business_id and newer.restaurant_guid=r.restaurant_guid
     and newer.entity='order' and newer.entity_guid=r.entity_guid and newer.business_date<>r.business_date
     and public.toast_time_or_null(newer.payload->>'modifiedDate')>public.toast_time_or_null(r.payload->>'modifiedDate'))
 ), amounts as (
  select coalesce(sum((p->>'netSalesCents')::bigint),0) net,
   coalesce(sum((p->>'grossSalesCents')::bigint),0) gross,
   coalesce(sum((p->>'discountsCents')::bigint),0) discounts,
   coalesce(sum((p->>'refundsCents')::bigint),0) refunds,
   coalesce(sum((p->>'tipCents')::bigint),0) tips,
   coalesce(sum((p->>'orders')::integer),0) orders,
   coalesce(sum((p->>'openChecks')::integer),0) open_checks,
   coalesce(sum((p->>'unparsedOrders')::integer),0) unparsed,
   coalesce(sum((p->>'orders')::integer) filter(where public.toast_time_or_null(p->>'observedAt') is null),0) unassigned
  from revisions
 ), hours as (
  select extract(hour from public.toast_time_or_null(p->>'observedAt') at time zone zone)::integer h,
   sum((p->>'netSalesCents')::bigint) net,sum((p->>'orders')::integer) orders
  from revisions where (p->>'orders')::integer>0 and public.toast_time_or_null(p->>'observedAt') is not null group by 1
 ), items as (
  select min(x->>'name') name,sum((x->>'quantity')::numeric) quantity,sum((x->>'netSalesCents')::bigint) net
  from revisions cross join lateral jsonb_array_elements(p->'items') x
  group by x->>'key' order by quantity desc,net desc,min(x->>'name') limit 5
 )
 select jsonb_build_object('provisional',true,'businessDate',d,'readAt',source_at,
  'netSalesCents',net,'grossSalesCents',gross,'discountsCents',discounts,'refundsCents',refunds,'tipCents',tips,
  'orders',orders,'openChecks',open_checks,'unparsedOrders',unparsed,'locationsRead',ready,'locationsFailed',0,
  'truncated',false,'hourlyUnassignedOrders',unassigned,
  'hourlySales',coalesce((select jsonb_agg(jsonb_build_object('hourLocal',h,'netSalesCents',hours.net,'ordersCount',hours.orders) order by h) from hours),'[]'::jsonb),
  'topItems',coalesce((select jsonb_agg(jsonb_build_object('name',name,'quantity',quantity,'netSalesCents',items.net) order by quantity desc,items.net desc,name) from items),'[]'::jsonb))
 into result from amounts;
 insert into public.toast_today_live(business_id,business_date,read_at,net_sales_cents,orders,reading)
 values(p_business_id,d,source_at,(result->>'netSalesCents')::bigint,(result->>'orders')::integer,result)
 on conflict(business_id) do update set business_date=excluded.business_date,read_at=excluded.read_at,
  net_sales_cents=excluded.net_sales_cents,orders=excluded.orders,reading=excluded.reading,updated_at=now()
 where (toast_today_live.business_date<excluded.business_date or
   (toast_today_live.business_date=excluded.business_date and toast_today_live.read_at<=excluded.read_at))
  and toast_today_live.reading is distinct from excluded.reading;
 return result;
end $$;
revoke all on function public.toast_refresh_canonical_live(uuid) from public,anon,authenticated;
grant execute on function public.toast_refresh_canonical_live(uuid) to service_role;

-- Imported days are only re-queued by a real changed order, never by its
-- appearance in an overlapping modification scan. Keep the scan's independent
-- completeness evidence and associate actual repair jobs with that evidence.
create or replace function public.toast_changed_order_days(p_business_id uuid,p_restaurant_guid uuid,p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>100 then raise exception 'invalid revision comparison';end if;
 select coalesce(jsonb_agg(distinct x->>'day'),'[]'::jsonb) into result
 from jsonb_array_elements(p_rows) x
 where not exists(select 1 from public.toast_raw_records r
  where r.business_id=p_business_id and r.restaurant_guid=p_restaurant_guid and r.entity='order'
   and r.business_date=(x->>'day')::date and r.entity_guid=(x->'payload'->>'guid')::uuid
   and (r.payload_sha256=encode(sha256(convert_to((x->'payload')::text,'UTF8')),'hex')
    or public.toast_time_or_null(r.payload->>'modifiedDate')>public.toast_time_or_null(x->'payload'->>'modifiedDate')))
 and not exists(select 1 from public.toast_sync_runs s
   where s.business_id=p_business_id and s.restaurant_guid=p_restaurant_guid
     and s.kind='repull_modified' and s.requested_from=(x->>'day')::date
     and s.requested_to=s.requested_from and s.state in ('queued','running','paused_rate_limited')
     and (s.cursor->'revision'->'orders'->(x->'payload'->>'guid')=x->'payload'
       or public.toast_time_or_null(s.cursor->'revision'->'orders'->(x->'payload'->>'guid')->>'modifiedDate')
          >public.toast_time_or_null(x->'payload'->>'modifiedDate')));
 return result;
end $$;
revoke all on function public.toast_changed_order_days(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.toast_changed_order_days(uuid,uuid,jsonb) to service_role;

-- Reuse continuous incremental coverage for the daily void completeness
-- check. Only an uncovered day needs the legacy historical scan.
create or replace function public.toast_use_canonical_order_coverage(p_business_id uuid,p_restaurant_guid uuid,p_local_day date)
returns boolean language plpgsql security invoker set search_path=public as $$
declare m record; h record; s record; start_at timestamptz; end_at timestamptz;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service role only';end if;
 select toast_time_zone,closeout_hour into m from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null;
 if not found or m.toast_time_zone is null or m.closeout_hour is null then return false;end if;
 select last_local_day,scan_local_day into s from public.toast_repull_scan_state where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 if s.scan_local_day is not null then return false;end if;
 if s.last_local_day>=p_local_day then return true;end if;
 select canonical_order_poll_from,canonical_order_poll_at into h from public.toast_sync_health
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 if not found or h.canonical_order_poll_from is null or h.canonical_order_poll_at is null then return false;end if;
 start_at:=((p_local_day-1)::timestamp+make_interval(hours=>m.closeout_hour)) at time zone m.toast_time_zone;
 end_at:=(p_local_day::timestamp+make_interval(hours=>m.closeout_hour)) at time zone m.toast_time_zone;
 if (start_at-interval '1 hour') at time zone m.toast_time_zone=((p_local_day-1)::timestamp+make_interval(hours=>m.closeout_hour)) then start_at:=start_at-interval '1 hour';end if;
 if (end_at-interval '1 hour') at time zone m.toast_time_zone=(p_local_day::timestamp+make_interval(hours=>m.closeout_hour)) then end_at:=end_at-interval '1 hour';end if;
 if h.canonical_order_poll_from>start_at or h.canonical_order_poll_at<end_at then return false;end if;
 -- A late order repair must finish before the daily completeness certificate.
 if exists(select 1 from public.toast_sync_runs where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and kind='repull_modified' and state in ('queued','running','paused_rate_limited')) then return true;end if;
 perform public.toast_commit_repull_scan_window(p_business_id,p_restaurant_guid,p_local_day,'[]'::jsonb,start_at,h.canonical_order_poll_at);
 perform public.toast_certify_day_voids(p_business_id,p_local_day-1);
 return true;
end $$;
revoke all on function public.toast_use_canonical_order_coverage(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.toast_use_canonical_order_coverage(uuid,uuid,date) to service_role;

-- A scheduled scan can meet an already queued canonical repair. Coalesce on
-- either unique constraint and retain conservative void-completeness status.
CREATE OR REPLACE FUNCTION public.toast_checkpoint_repull_scan_page(p_business_id uuid, p_restaurant_guid uuid, p_local_day date, p_scan_start timestamp with time zone, p_scan_end timestamp with time zone, p_window_start timestamp with time zone, p_window_end timestamp with time zone, p_page integer, p_last_page boolean, p_days jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_state public.toast_repull_scan_state%rowtype;
 v_day date;v_added boolean;v_zone text;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_scan_start is null or p_scan_end is null or
  p_scan_end<=p_scan_start or p_scan_end-p_scan_start>interval '30 days' or
  p_window_start<p_scan_start or p_window_start>=p_scan_end or
  p_window_end<>least(p_scan_end,p_window_start+interval '7 days') or
  mod(extract(epoch from p_window_start-p_scan_start)::bigint,604800)<>0 or
  p_page not between 1 and 300 or p_last_page is null or
  jsonb_typeof(p_days)<>'array' or jsonb_array_length(p_days)>100 or
  (not p_last_page and p_page=300) then
  raise exception 'invalid modified scan page';end if;
 select toast_time_zone into v_zone from public.toast_location_mappings
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid
 and verified_at is not null for share;
 if v_zone is null then raise exception 'unverified restaurant';end if;
 insert into public.toast_repull_scan_state(business_id,restaurant_guid)
 values(p_business_id,p_restaurant_guid) on conflict do nothing;
 select * into v_state from public.toast_repull_scan_state
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid for update;
 if v_state.scan_local_day is null then
  if p_page<>1 or p_window_start<>p_scan_start or
   v_state.last_local_day>=p_local_day then
   raise exception 'invalid scan restart';end if;
  update public.toast_repull_scan_state set
   scan_local_day=p_local_day,scan_start=p_scan_start,
   scan_end=p_scan_end,scan_window_start=p_window_start,scan_page=1
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 elsif v_state.scan_local_day is distinct from p_local_day or
  v_state.scan_start is distinct from p_scan_start or
  v_state.scan_end is distinct from p_scan_end or
  v_state.scan_window_start is distinct from p_window_start or
  v_state.scan_page is distinct from p_page then
  raise exception 'stale modified scan checkpoint';end if;

 for v_day in select distinct value::date from jsonb_array_elements_text(p_days) loop
  if v_day<'2015-12-02'::date or v_day>=p_local_day then
   raise exception 'invalid modified order day';end if;
  insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
   requested_from,requested_to,scan_local_day,days_total)
  values(p_business_id,p_restaurant_guid,'repull_modified',v_day,v_day,p_local_day,1)
  on conflict do nothing;
  v_added:=found;
  if v_added then
   update public.toast_day_status set recon_state='pending',last_recon_attempt_at=null
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid
    and business_date=v_day and import_state='imported';
   update public.daily_rollups set voids_status='unknown',voids_source=null
   where business_id=p_business_id and (business_date=v_day or business_date in(
    select f.void_business_date from public.toast_void_facts f
    where f.business_id=p_business_id and f.order_business_date=v_day));
  end if;
 end loop;

 if p_last_page and p_window_end=p_scan_end then
  -- Retain the historical certification contract, without repeating per-page
  -- jobs. This RPC atomically stamps the completed scan and covered void days.
  perform public.toast_commit_repull_scan_window(p_business_id,
   p_restaurant_guid,p_local_day,'[]'::jsonb,p_scan_start,p_scan_end);
  update public.toast_repull_scan_state set scan_local_day=null,scan_start=null,
   scan_end=null,scan_window_start=null,scan_page=null
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 elsif p_last_page then
  update public.toast_repull_scan_state set scan_window_start=p_window_end,
   scan_page=1 where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 else
  update public.toast_repull_scan_state set scan_page=p_page+1
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 end if;
 return true;
end $function$
;
CREATE OR REPLACE FUNCTION public.toast_certify_day_voids(p_business_id uuid, p_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare eligible integer;complete_count integer;unknown_amounts integer;v_total bigint;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 perform pg_advisory_xact_lock(hashtextextended(
  'toast-void:'||p_business_id::text||':'||p_date::text,0));
 select count(*),
  count(*) filter(where s.import_state='imported'
   and s.unparsed_count=0 and s.coverage_complete
   and s.recon_state in ('matched','checked_internal')
   and c.scanned_at is not null
   and not exists(select 1 from public.toast_day_owner_flags f
    where f.business_id=m.business_id and f.restaurant_guid=m.restaurant_guid
     and f.business_date=p_date and f.cleared_at is null)
   and not exists(select 1 from public.toast_sync_runs pending
    where pending.business_id=m.business_id
     and pending.restaurant_guid=m.restaurant_guid
     and pending.kind='repull_modified'
     and ((pending.scan_local_day=c.scan_local_day and pending.state<>'completed')
       or (pending.state in ('queued','running','paused_rate_limited') and pending.requested_from<=p_date))))
 into eligible,complete_count
 from public.toast_location_mappings m
 left join public.toast_day_status s on s.business_id=m.business_id
  and s.restaurant_guid=m.restaurant_guid and s.business_date=p_date
 left join public.toast_void_repull_coverage c on c.business_id=m.business_id
  and c.restaurant_guid=m.restaurant_guid and c.business_date=p_date
 where m.business_id=p_business_id and m.verified_at is not null
  and p_date>=coalesce(m.toast_start_date,p_date);
 select count(*) into unknown_amounts from public.toast_void_facts
  where business_id=p_business_id and void_business_date=p_date
   and (amount_cents is null or amount_basis='amount_missing');
 if eligible=0 or complete_count<>eligible or unknown_amounts>0 then
  update public.daily_rollups set voids_status='unknown',voids_source=null
   where business_id=p_business_id and business_date=p_date;
  return false;
 end if;
 select coalesce(sum(amount_cents),0) into v_total
 from public.toast_void_facts where business_id=p_business_id
  and void_business_date=p_date;
 update public.daily_rollups set voids_status='complete',voids_source='toast',
  voids_cents=v_total where business_id=p_business_id and business_date=p_date;
 return found;
end $function$
;
create or replace function public.toast_constrained_stock_guids(p_business_id uuid,p_restaurant_guid uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service role only';end if;
 return (select coalesce(jsonb_agg(distinct entity_guid),'[]'::jsonb)
  from public.toast_raw_records where business_id=p_business_id and restaurant_guid=p_restaurant_guid
   and entity='stock/v1/inventory' and entity_guid is not null and payload->>'status' in ('OUT_OF_STOCK','QUANTITY'));
end $$;
revoke all on function public.toast_constrained_stock_guids(uuid,uuid) from public,anon,authenticated;
grant execute on function public.toast_constrained_stock_guids(uuid,uuid) to service_role;


-- Cheap closeout eligibility: completed days do not acquire a location lease
-- or run another provider reconciliation. Unfinished historical work keeps its
-- existing retry cadence and remains visible rather than being discarded.
create or replace function public.toast_closeout_due(
 p_business_id uuid,p_restaurant_guid uuid,p_day date,p_now timestamptz)
returns boolean language sql stable security invoker set search_path=public as $$
 select auth.role()='service_role' and exists(
 select 1 from public.toast_location_mappings m
 where m.business_id=p_business_id and m.restaurant_guid=p_restaurant_guid
   and m.verified_at is not null
   and (not exists(select 1 from public.toast_day_status d where d.business_id=m.business_id
     and d.restaurant_guid=m.restaurant_guid and d.business_date=p_day and d.import_state='imported')
   or exists(select 1 from public.toast_day_status d where d.business_id=m.business_id
     and d.restaurant_guid=m.restaurant_guid and d.business_date<=p_day
     and d.import_state='imported' and d.rechecking_reason is null
     and (d.recon_state in ('pending','mismatch','analytics_timeout') or
        (d.recon_state='checked_internal' and d.analytics_state='pending' and exists(
         select 1 from public.toast_api_credentials c where c.business_id=m.business_id and c.toast_check_mode='official')))
     and (d.last_recon_attempt_at is null or d.last_recon_attempt_at<=p_now-
       case when d.last_error_category='unverified_payment_order' or d.warnings->>'payment_recovery_exhausted'='1'
           then interval '24 hours'
         when d.payment_repull_at is not null and d.business_date<p_day then interval '1 hour'
         else interval '15 minutes' end))))
$$;
revoke all on function public.toast_closeout_due(uuid,uuid,date,timestamptz) from public,anon,authenticated;
grant execute on function public.toast_closeout_due(uuid,uuid,date,timestamptz) to service_role;
