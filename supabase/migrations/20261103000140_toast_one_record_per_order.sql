-- Toast archive: one current record per order, plus a change log
-- (AGENTS.md §4b, docs/plans/toast-storage.md step 2).
--
-- Until now every distinct version of an order was a new full row, and "one row
-- per order" was a promise kept by code. Now:
--  * The database enforces it: one row per (café, restaurant, business date,
--    order GUID) via a unique index.
--  * Same content again (list order ignored) → the row is only marked seen /
--    moved to the committing run, exactly as before.
--  * Real change → the row is updated in place with every field Toast sent,
--    one toast_raw_changes line records what changed (path, before, after), and
--    the order's typed details are rebuilt.
--  * Existing extra versions are collapsed once: the row the latest import reads
--    is kept, older versions become change-log lines.
-- Readers keep working unchanged: the kept row carries run_id / seen_run_id of
-- the latest import, as before.
-- Records without a GUID and non-order entities keep today's behaviour.

-- 1. Change log. Closed to app users like toast_raw_records (RLS on, no policy).
create table if not exists public.toast_raw_changes(
 id bigint generated always as identity primary key,
 business_id uuid not null references public.businesses(id) on delete cascade,
 restaurant_guid uuid,
 entity text not null,
 entity_guid uuid not null,
 business_date date,
 run_id uuid,
 changed_at timestamptz not null default now(),
 changes jsonb not null check (jsonb_typeof(changes)='array')
);
create index if not exists toast_raw_changes_object_idx
 on public.toast_raw_changes(business_id,entity,entity_guid,changed_at);
alter table public.toast_raw_changes enable row level security;
revoke all on public.toast_raw_changes from public,anon,authenticated;
grant select,insert,update,delete on public.toast_raw_changes to service_role;

-- 2. Field-level difference between two stable (list-order-free) JSON values.
--    Lists whose items all carry a GUID are matched by GUID, others by position.
create or replace function public.toast_json_diff(a jsonb,b jsonb,p text default '')
returns table(path text,before jsonb,after jsonb)
language plpgsql immutable set search_path=public as $diff$
declare by_guid boolean;
begin
 if a is not distinct from b then return; end if;
 if jsonb_typeof(a)='object' and jsonb_typeof(b)='object' then
  return query select d.path,d.before,d.after
   from (select jsonb_object_keys(a) union select jsonb_object_keys(b)) ks(k)
   cross join lateral public.toast_json_diff(a->ks.k,b->ks.k,p||'.'||ks.k) d;
  return;
 end if;
 if jsonb_typeof(a)='array' and jsonb_typeof(b)='array' then
  by_guid:=not exists(select 1 from jsonb_array_elements(a||b) x
   where jsonb_typeof(x)<>'object' or jsonb_typeof(x->'guid') is distinct from 'string');
  if by_guid then
   return query select d.path,d.before,d.after
    from (select x->>'guid' g,x from jsonb_array_elements(a) x) l
    full join (select y->>'guid' g,y from jsonb_array_elements(b) y) r using(g)
    cross join lateral public.toast_json_diff(l.x,r.y,p||'['||g||']') d;
  else
   return query select d.path,d.before,d.after
    from generate_series(0,greatest(jsonb_array_length(a),jsonb_array_length(b))-1) i
    cross join lateral public.toast_json_diff(a->i,b->i,p||'['||i||']') d;
  end if;
  return;
 end if;
 path:=coalesce(nullif(p,''),'$');before:=a;after:=b;
 return next;
end $diff$;
revoke all on function public.toast_json_diff(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.toast_json_diff(jsonb,jsonb,text) to service_role;

-- 3. Archive writer: same signature and callers as migrations 128/129.
create or replace function public.toast_archive_page(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb,p_commit boolean
) returns void language plpgsql security definer set search_path=public as $archive$
declare it record; cur public.toast_raw_records%rowtype; diff jsonb;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 for it in select * from public.toast_archive_items(p_run_id,p_business_date,p_page,p_payload) loop
  continue when it.business_id is null;
  if it.entity_guid is null then
   -- Cannot be matched: kept as before.
   insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,
    business_date,payload,payload_sha256,run_id,seen_run_id,source_page,source_index,capture_key)
   values(it.business_id,it.restaurant_guid,it.entity,null,p_business_date,it.payload,it.sha,
    p_run_id,p_run_id,p_page,it.source_index,it.capture_key)
   on conflict (business_id,capture_key) do nothing;
   continue;
  end if;
  select * into cur from public.toast_raw_records r
  where r.business_id=it.business_id and r.restaurant_guid is not distinct from it.restaurant_guid
   and r.business_date=p_business_date and r.entity=it.entity and r.entity_guid=it.entity_guid
  order by r.last_seen desc,r.id desc limit 1 for update;
  if not found then
   insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,
    business_date,payload,payload_sha256,run_id,seen_run_id,source_page,source_index,capture_key)
   values(it.business_id,it.restaurant_guid,it.entity,it.entity_guid,p_business_date,it.payload,
    it.sha,p_run_id,p_run_id,p_page,it.source_index,it.capture_key);
   continue;
  end if;
  if cur.payload_sha256<>it.sha
   and it.payload->>'modifiedDate' is not null and cur.payload->>'modifiedDate' is not null
   and (it.payload->>'modifiedDate')<(cur.payload->>'modifiedDate') then
   -- An older version than the one stored (e.g. the same order twice on a page):
   -- never replace newer data with older data.
   continue;
  elsif cur.payload_sha256<>it.sha then
   -- Real change (list order is already sorted by the app): log it, update in place.
   select coalesce(jsonb_agg(jsonb_build_object('path',d.path,'before',d.before,'after',d.after)
     order by d.path),'[]'::jsonb) into diff
   from public.toast_json_diff(public.toast_stable_json(cur.payload),
    public.toast_stable_json(it.payload)) d;
   if jsonb_array_length(diff)>0 then
    insert into public.toast_raw_changes(business_id,restaurant_guid,entity,entity_guid,
     business_date,run_id,changes)
    values(cur.business_id,cur.restaurant_guid,cur.entity,cur.entity_guid,cur.business_date,
     p_run_id,diff);
   end if;
   update public.toast_raw_records set payload=it.payload,payload_sha256=it.sha,
    seen_run_id=p_run_id,last_seen=now(),
    run_id=case when p_commit then p_run_id else run_id end,
    source_page=case when p_commit then p_page else source_page end,
    source_index=case when p_commit then it.source_index else source_index end
   where id=cur.id;
   if cur.entity='order' then
    delete from public.toast_order_typed_facts where raw_record_id=cur.id;
    perform public.toast_capture_typed_order(cur.id);
   end if;
  elsif cur.seen_run_id is distinct from p_run_id
   or (p_commit and cur.run_id is distinct from p_run_id) then
   update public.toast_raw_records set seen_run_id=p_run_id,last_seen=now(),
    run_id=case when p_commit then p_run_id else run_id end,
    source_page=case when p_commit then p_page else source_page end,
    source_index=case when p_commit then it.source_index else source_index end
   where id=cur.id;
   if p_commit and cur.entity='order' then
    update public.toast_order_typed_facts set run_id=p_run_id
    where raw_record_id=cur.id and run_id is distinct from p_run_id;
   end if;
  end if;
 end loop;
end $archive$;
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb,boolean) to service_role;

-- 4. One-time collapse of extra versions, one café-day per call.
create or replace function public.toast_archive_collapse_day(
 p_business_id uuid,p_business_date date
) returns integer language plpgsql security definer set search_path=public as $collapse$
declare g record; v record; prev record; has_prev boolean; keep uuid; last_run uuid; n integer:=0; k integer; diff jsonb;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 for g in
  select r.restaurant_guid,r.entity_guid from public.toast_raw_records r
  where r.business_id=p_business_id and r.business_date=p_business_date
   and r.entity='order' and r.entity_guid is not null
  group by 1,2 having count(*)>1
 loop
  select d.last_import_run_id into last_run from public.toast_day_status d
  where d.business_id=p_business_id and d.restaurant_guid is not distinct from g.restaurant_guid
   and d.business_date=p_business_date;
  select r.id into keep from public.toast_raw_records r
  where r.business_id=p_business_id and r.business_date=p_business_date and r.entity='order'
   and r.restaurant_guid is not distinct from g.restaurant_guid and r.entity_guid=g.entity_guid
  order by coalesce(r.run_id=last_run or r.seen_run_id=last_run,false) desc,
   r.last_seen desc,r.first_seen desc,r.id desc limit 1;
  -- A record is NULL-tested field by field ("prev is not null" is false when any
  -- column is null), so track the previous version explicitly.
  has_prev:=false;
  for v in
   select r.* from public.toast_raw_records r
   where r.business_id=p_business_id and r.business_date=p_business_date and r.entity='order'
    and r.restaurant_guid is not distinct from g.restaurant_guid and r.entity_guid=g.entity_guid
   order by r.first_seen,r.id
  loop
   if has_prev then
    select coalesce(jsonb_agg(jsonb_build_object('path',d.path,'before',d.before,'after',d.after)
      order by d.path),'[]'::jsonb) into diff
    from public.toast_json_diff(public.toast_stable_json(prev.payload),
     public.toast_stable_json(v.payload)) d;
    if jsonb_array_length(diff)>0 then
     insert into public.toast_raw_changes(business_id,restaurant_guid,entity,entity_guid,
      business_date,run_id,changed_at,changes)
     values(p_business_id,g.restaurant_guid,'order',g.entity_guid,p_business_date,v.run_id,
      v.first_seen,diff);
    end if;
   end if;
   prev:=v;has_prev:=true;
  end loop;
  delete from public.toast_raw_records r
  where r.business_id=p_business_id and r.business_date=p_business_date and r.entity='order'
   and r.restaurant_guid is not distinct from g.restaurant_guid and r.entity_guid=g.entity_guid
   and r.id<>keep;
  get diagnostics k=row_count;
  n:=n+k;
 end loop;
 return n;
end $collapse$;
revoke all on function public.toast_archive_collapse_day(uuid,date) from public,anon,authenticated;
grant execute on function public.toast_archive_collapse_day(uuid,date) to service_role;

do $collapse_all$
declare d record;
begin
 set local statement_timeout=0;
 for d in
  select business_id,business_date from public.toast_raw_records
  where entity='order' and entity_guid is not null
  group by business_id,business_date
  having count(*)>count(distinct (restaurant_guid,entity_guid))
 loop
  perform public.toast_archive_collapse_day(d.business_id,d.business_date);
 end loop;
end $collapse_all$;

-- 5. From now on the database refuses a second row for the same order.
create unique index if not exists toast_raw_records_one_order
 on public.toast_raw_records(business_id,restaurant_guid,business_date,entity_guid)
 nulls not distinct
 where entity='order' and entity_guid is not null;
