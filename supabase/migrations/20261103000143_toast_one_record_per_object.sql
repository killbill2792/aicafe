-- Toast archive: one current record per POS object for the staged snapshots too
-- (AGENTS.md §4b, docs/plans/toast-storage.md step 4b).
--
-- Migration 111 copies every insert/update of our Toast tables (time entries, staff,
-- jobs, menu items, prices, voids, refunds…) into toast_raw_records, keyed by the
-- exact text. Our own bookkeeping times (fetched_at, last_seen…) change on every
-- download, so each download added a full new row: the first health check found
-- ~2,200 extra rows.
-- Now each snapshot is filed under its SOURCE TABLE'S OWN KEY (the same columns
-- that make a row unique there), so the existing unique (café, capture_key) rule
-- keeps exactly one current record per source row:
--  * same content again → nothing;
--  * only our bookkeeping times changed → the record is refreshed, no change line;
--  * a real change → the record is updated and a toast_raw_changes line is written;
--  * existing extra rows are collapsed once into change lines.
-- Sources without a known key keep the old behaviour. Nothing in the app or the AI
-- reads these snapshot rows (they read orders only).

-- 1. The source table's own key for a staged row (null when unknown or incomplete).
create or replace function public.toast_stage_object_key(p_origin text,p_row jsonb)
returns text language sql immutable set search_path=public as $key$
 select case when bool_and(nullif(p_row->>c,'') is not null)
  then string_agg(p_row->>c,'|' order by o) end
 from unnest(case p_origin
  when 'toast_labor_entries' then array['restaurant_guid','external_time_entry_id']
  when 'toast_employee_directory' then array['restaurant_guid','employee_guid']
  when 'toast_job_directory' then array['restaurant_guid','job_guid']
  when 'toast_catalog_facts' then array['restaurant_guid','kind','provider_guid']
  when 'toast_catalog_price_versions' then array['restaurant_guid','kind','provider_guid','price_fingerprint']
  when 'toast_payment_day_events' then array['restaurant_guid','payment_guid','kind','event_business_date']
  when 'toast_modified_orders_staging' then array['restaurant_guid','order_guid']
  when 'toast_pilot_days' then array['restaurant_guid','business_date']
  when 'toast_void_facts' then array['selection_guid']
  when 'toast_refund_facts' then array['restaurant_guid','order_guid','payment_guid']
  when 'toast_analytics_jobs' then array['restaurant_guid','business_date']
 end) with ordinality as k(c,o)
 having count(*)>0
$key$;

-- 2. What counts as a change: every field except our own bookkeeping times.
create or replace function public.toast_stage_comparable(p_row jsonb)
returns jsonb language sql immutable set search_path=public as $cmp$
 select public.toast_stable_json(p_row - array['fetched_at','first_seen','last_seen','checked_at',
  'last_checked_at','report_checked_at','observed_at','updated_at'])
$cmp$;

-- 2b. Display ID of a staged row (identity is the key above). Voids by item, refunds by payment.
create or replace function public.toast_stage_object_id(p_row jsonb)
returns uuid language sql immutable set search_path=public as $id$
 select case when v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v::uuid end
 from (select coalesce(
  nullif(p_row->>'external_time_entry_id',''),
  nullif(p_row->>'employee_guid',''),
  nullif(p_row->>'provider_guid',''),
  nullif(p_row->>'selection_guid',''),
  nullif(p_row->>'payment_guid',''),
  nullif(p_row->>'order_guid',''),
  nullif(p_row->>'job_guid',''),
  nullif(p_row->>'guid','')) v) x
$id$;

-- 3. Snapshot writer: same signature and trigger as migration 111.
create or replace function public.toast_archive_stage_snapshot(
 p_row jsonb,p_entity text,p_origin text
) returns void language plpgsql security definer set search_path=public as $archive$
declare v_guid uuid; v_biz uuid; v_rest uuid; v_day date; v_hash text; v_key text; v_capture text;
 cur public.toast_raw_records%rowtype; diff jsonb;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if nullif(p_row->>'business_id','') is null then return; end if;
 v_biz:=(p_row->>'business_id')::uuid;
 v_rest:=nullif(p_row->>'restaurant_guid','')::uuid;
 v_guid:=public.toast_stage_object_id(p_row);
 v_hash:=encode(sha256(convert_to(p_row::text,'UTF8')),'hex');
 if coalesce(p_row->>'business_date',p_row->>'order_business_date',p_row->>'event_business_date','')
   ~ '^\d{4}-\d{2}-\d{2}$'
 then v_day:=coalesce(p_row->>'business_date',p_row->>'order_business_date',
  p_row->>'event_business_date')::date; end if;
 v_key:=public.toast_stage_object_key(p_origin,p_row);
 v_capture:=case when v_key is null then 'stage:'||p_origin||':'||v_hash
  else 'stage:'||p_origin||':key:'||v_key end;
 if v_key is not null then
  select * into cur from public.toast_raw_records r
  where r.business_id=v_biz and r.capture_key=v_capture for update;
  if found then
   if cur.payload_sha256=v_hash then return; end if;
   select coalesce(jsonb_agg(jsonb_build_object('path',d.path,'before',d.before,'after',d.after)
     order by d.path),'[]'::jsonb) into diff
   from public.toast_json_diff(public.toast_stage_comparable(cur.payload),
    public.toast_stage_comparable(p_row)) d;
   if jsonb_array_length(diff)>0 and cur.entity_guid is not null then
    insert into public.toast_raw_changes(business_id,restaurant_guid,entity,entity_guid,business_date,changes)
    values(v_biz,cur.restaurant_guid,cur.entity,cur.entity_guid,cur.business_date,diff);
   end if;
   update public.toast_raw_records set payload=p_row,payload_sha256=v_hash,last_seen=now() where id=cur.id;
   return;
  end if;
 end if;
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,capture_key)
 values(v_biz,v_rest,p_entity,
  v_guid,v_day,p_row,v_hash,v_capture)
 on conflict (business_id,capture_key) do nothing;
end $archive$;
revoke all on function public.toast_archive_stage_snapshot(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.toast_archive_stage_snapshot(jsonb,text,text) to service_role;

-- 4. One-time: group existing staged rows by their source key, keep the newest version
--    (filed under the key), turn older real versions into change lines, drop the rest.
create or replace function public.toast_archive_collapse_snapshots()
returns integer language plpgsql security definer set search_path=public as $collapse$
declare g record; v record; prev jsonb; has_prev boolean; keep uuid; n integer:=0; k integer; diff jsonb;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 create temp table if not exists toast_stage_keyed(id uuid primary key,business_id uuid,new_key text,
  first_seen timestamptz,last_seen timestamptz) on commit drop;
 truncate toast_stage_keyed;
 insert into toast_stage_keyed
 select r.id,r.business_id,
  'stage:'||split_part(r.capture_key,':',2)||':key:'||
   public.toast_stage_object_key(split_part(r.capture_key,':',2),r.payload),
  r.first_seen,r.last_seen
 from public.toast_raw_records r
 where r.capture_key like 'stage:%' and r.capture_key not like 'stage:%:key:%'
  and public.toast_stage_object_key(split_part(r.capture_key,':',2),r.payload) is not null;
 for g in
  select s.business_id,s.new_key from toast_stage_keyed s group by 1,2
 loop
  select s.id into keep from toast_stage_keyed s
  where s.business_id=g.business_id and s.new_key=g.new_key
  order by s.first_seen desc,s.last_seen desc,s.id desc limit 1;
  has_prev:=false;
  for v in
   select r.* from public.toast_raw_records r join toast_stage_keyed s on s.id=r.id
   where s.business_id=g.business_id and s.new_key=g.new_key
   order by r.first_seen,r.id
  loop
   if has_prev and public.toast_stage_object_id(v.payload) is not null then
    select coalesce(jsonb_agg(jsonb_build_object('path',d.path,'before',d.before,'after',d.after)
      order by d.path),'[]'::jsonb) into diff
    from public.toast_json_diff(public.toast_stage_comparable(prev),public.toast_stage_comparable(v.payload)) d;
    if jsonb_array_length(diff)>0 then
     insert into public.toast_raw_changes(business_id,restaurant_guid,entity,entity_guid,business_date,
      changed_at,changes)
     values(v.business_id,v.restaurant_guid,v.entity,public.toast_stage_object_id(v.payload),
      v.business_date,v.first_seen,diff);
    end if;
   end if;
   prev:=v.payload;has_prev:=true;
  end loop;
  delete from public.toast_raw_records r using toast_stage_keyed s
  where s.id=r.id and s.business_id=g.business_id and s.new_key=g.new_key and r.id<>keep;
  get diagnostics k=row_count;
  n:=n+k;
  -- A row already filed under this key (written after this migration) would win; keep it.
  if exists(select 1 from public.toast_raw_records r where r.business_id=g.business_id
    and r.capture_key=g.new_key) then
   delete from public.toast_raw_records where id=keep;
   n:=n+1;
  else
   update public.toast_raw_records set capture_key=g.new_key,
    entity_guid=public.toast_stage_object_id(payload) where id=keep;
  end if;
 end loop;
 return n;
end $collapse$;
revoke all on function public.toast_archive_collapse_snapshots() from public,anon,authenticated;
grant execute on function public.toast_archive_collapse_snapshots() to service_role;

do $collapse_all$
begin
 set local statement_timeout=0;
 perform public.toast_archive_collapse_snapshots();
end $collapse_all$;

-- 5. Health check (migration 142): staged rows filed under their source key are unique
--    by (café, capture_key), so repeats are counted among orders and older text-keyed
--    rows only. Only the repeated-records filter differs from migration 142.
create or replace function public.run_data_health_check(p_plan_bytes bigint,p_days integer default 30)
returns public.data_health_checks
language plpgsql security definer set search_path=public as $health$
declare
 v_today date:=(now() at time zone 'utc')::date;
 v_bytes bigint:=pg_database_size(current_database());
 v_prev bigint; v_tables jsonb; v_findings jsonb:='[]'::jsonb; v_row public.data_health_checks;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if p_plan_bytes is null or p_plan_bytes<=0 or p_days not between 1 and 366
 then raise exception 'invalid health check settings'; end if;

 select coalesce(jsonb_agg(jsonb_build_object('table',t.relname,'bytes',t.bytes) order by t.bytes desc),'[]')
 into v_tables
 from (select c.relname,pg_total_relation_size(c.oid) bytes from pg_class c
  join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
  where c.relkind='r' order by 2 desc limit 8) t;

 if v_bytes>p_plan_bytes*0.7 then
  v_findings:=v_findings||jsonb_build_object('kind','database_near_limit',
   'database_bytes',v_bytes,'plan_bytes',p_plan_bytes);
 end if;

 select h.database_bytes into v_prev from public.data_health_checks h
 where h.checked_on<v_today order by h.checked_on desc limit 1;
 if v_prev is not null and v_bytes-v_prev>greatest(50*1024*1024,v_prev*0.2) then
  v_findings:=v_findings||jsonb_build_object('kind','sudden_growth',
   'database_bytes',v_bytes,'previous_bytes',v_prev);
 end if;

 v_findings:=v_findings||coalesce((
  select jsonb_agg(jsonb_build_object('kind','repeated_pos_records','business_id',x.business_id,
    'entity',x.entity,'objects',x.objects,'extra_rows',x.extra_rows) order by x.business_id,x.entity)
  from (select g.business_id,g.entity,count(*) objects,sum(g.n-1) extra_rows
   from (select r.business_id,r.entity,count(*) n from public.toast_raw_records r
    where r.entity_guid is not null and coalesce(r.capture_key,'') not like 'stage:%:key:%'
    group by r.business_id,r.restaurant_guid,r.entity,r.entity_guid,r.business_date
    having count(*)>1) g
   group by g.business_id,g.entity) x),'[]'::jsonb);

 v_findings:=v_findings||coalesce((
  select jsonb_agg(jsonb_build_object('kind','total_mismatch','business_id',m.business_id,
    'business_date',m.business_date,'import_net_cents',m.import_net,'stored_net_cents',m.stored_net,
    'toast_net_cents',m.toast_net) order by m.business_id,m.business_date)
  from (select d.business_id,d.business_date,sum(d.net_sales_cents) import_net,
    case when count(d.toast_net_sales_cents)=count(*) then sum(d.toast_net_sales_cents) end toast_net,
    (select coalesce(sum(o.net_sales_cents),0) from public.orders o
     where o.business_id=d.business_id and o.business_date=d.business_date and not o.toast_excluded
      and o.pos_order_id like 'toast:%') stored_net
   from public.toast_day_status d join public.businesses b on b.id=d.business_id and not b.is_demo
   where d.import_state='imported' and d.business_date>=v_today-p_days
   group by d.business_id,d.business_date
  ) m
  where m.stored_net is distinct from m.import_net
   or (m.toast_net is not null and m.toast_net is distinct from m.import_net)),'[]'::jsonb);

 insert into public.data_health_checks(checked_on,checked_at,database_bytes,plan_bytes,largest_tables,findings)
 values(v_today,now(),v_bytes,p_plan_bytes,v_tables,v_findings)
 on conflict(checked_on) do update set checked_at=excluded.checked_at,
  database_bytes=excluded.database_bytes,plan_bytes=excluded.plan_bytes,
  largest_tables=excluded.largest_tables,findings=excluded.findings
 returning * into v_row;
 return v_row;
end $health$;
revoke all on function public.run_data_health_check(bigint,integer) from public,anon,authenticated;
grant execute on function public.run_data_health_check(bigint,integer) to service_role;
