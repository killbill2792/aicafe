-- Today's Toast orders are kept as they arrive, once (AGENTS.md §4b "Today counts").
--
-- The 15-minute "today so far" job already downloads every order of the day,
-- but it only kept a summary. Discount names, items and payments were thrown
-- away until the 5 AM import. Now the job files each finished order into the
-- SAME one-record-per-order archive the import uses, through the SAME writer:
--  * One record per order (the unique index from migration 140). The 5 AM
--    import finds the record already there: same content → nothing is saved
--    again; real change → the record is updated and one change-log line is
--    written. No second copy, no second pipeline.
--  * A record saved during the day has no import run yet. Every screen, the
--    day check, the card-fee trigger, the typed order details view and the
--    test-café copy read only records of an imported day's import run, so they
--    do not see these records until the 5 AM import confirms them.
--  * Only the AI's Toast records view (toast_records_for) shows them, while the
--    day is not imported yet, with status 'provisional'.
--  * The job never touches a record an import already owns, and never writes
--    to a day that is already imported.

-- 1. The archive writer for one order, shared by the import and the live job.
--    Import mode (p_run_id set) behaves exactly as toast_archive_page did
--    (migration 140). Live mode (p_run_id null) also leaves alone any record an
--    import has seen. Returns what happened: inserted, changed, same, older or
--    skipped.
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
  and (p_payload->>'modifiedDate')<(cur.payload->>'modifiedDate') then
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

-- 2. The import's page writer: same signature, callers and behaviour as
--    migration 140; each order now goes through the shared writer above.
create or replace function public.toast_archive_page(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb,p_commit boolean
) returns void language plpgsql security definer set search_path=public as $archive$
declare it record;
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
  perform public.toast_archive_order(it.business_id,it.restaurant_guid,it.entity_guid,
   p_business_date,it.payload,it.sha,p_run_id,p_page,it.source_index,it.capture_key,p_commit);
 end loop;
end $archive$;
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb,boolean) to service_role;

-- 3. The live job's writer: one page of today's finished orders (already
--    cleaned of personal details and list-order-stable, exactly as the import
--    prepares them, so an unchanged order has the same hash at 5 AM).
--    Returns how many orders were new or changed.
create or replace function public.toast_archive_live_orders(
 p_business_id uuid,p_restaurant_guid uuid,p_business_date date,p_payload jsonb
) returns integer language plpgsql security definer set search_path=public as $live$
declare o record; v_guid uuid; v_sha text; v_result text; n integer:=0;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if jsonb_typeof(p_payload) is distinct from 'array' or jsonb_array_length(p_payload)>100 then
  raise exception 'toast live archive: a page is an array of at most 100 orders';
 end if;
 if not exists(select 1 from public.toast_location_mappings m
  where m.business_id=p_business_id and m.restaurant_guid=p_restaurant_guid
   and m.verified_at is not null) then
  raise exception 'toast live archive: not a verified Toast location of this café';
 end if;
 -- Only the café's current days. Older days belong to the import alone.
 if p_business_date is null or p_business_date<current_date-2 or p_business_date>current_date+1 then
  raise exception 'toast live archive: only the current business day';
 end if;
 -- An imported day is final: the live job never writes to it.
 if exists(select 1 from public.toast_day_status d
  where d.business_id=p_business_id and d.restaurant_guid=p_restaurant_guid
   and d.business_date=p_business_date and d.import_state='imported') then
  return 0;
 end if;
 for o in select x.v from jsonb_array_elements(p_payload) x(v) loop
  continue when jsonb_typeof(o.v)<>'object'
   or coalesce(o.v->>'guid','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_guid:=(o.v->>'guid')::uuid;
  -- Same hash rule as toast_archive_items, so the import recognises the record.
  v_sha:=encode(sha256(convert_to(o.v::text,'UTF8')),'hex');
  v_result:=public.toast_archive_order(p_business_id,p_restaurant_guid,v_guid,p_business_date,
   o.v,v_sha,null,null,null,
   'live:'||p_restaurant_guid::text||':'||p_business_date::text||':'||v_guid::text,false);
  if v_result in ('inserted','changed') then n:=n+1; end if;
 end loop;
 return n;
end $live$;
revoke all on function public.toast_archive_live_orders(uuid,uuid,date,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_live_orders(uuid,uuid,date,jsonb) to service_role;

-- 4. The AI's Toast records: as migration 130, plus today's orders saved by the
--    live job while their day is not imported yet, marked 'provisional'.
--    Imported days are unchanged ('actual', latest import only).
create or replace function public.toast_records_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 record_type text,record_ref text,order_ref text,check_ref text,counts_in_sales boolean,data jsonb)
language sql stable security definer set search_path=public as $records$
with orders as not materialized (
 select r.business_id,r.business_date,r.id,r.payload o,
  case when d.business_id is null then 'provisional' else 'actual' end st,
  -- Same exclusions as the importer (lib/pos/toast/dayParser.ts): deleted, voided,
  -- excess-food and test-mode orders are kept here but never count in sales.
  (r.payload->'voided') is not distinct from 'true'::jsonb or (r.payload->'deleted') is not distinct from 'true'::jsonb
   or (r.payload->'excessFood') is not distinct from 'true'::jsonb or (r.payload->'createdInTestMode') is not distinct from 'true'::jsonb o_void
 from public.toast_raw_records r
 left join public.toast_day_status d on d.business_id=r.business_id
  and d.restaurant_guid=r.restaurant_guid and d.business_date=r.business_date
  and d.import_state='imported'
 where r.entity='order' and jsonb_typeof(r.payload)='object'
  and (
   -- An imported day: only its latest import's records.
   (d.business_id is not null and (r.run_id=d.last_import_run_id or r.seen_run_id=d.last_import_run_id))
   -- A day not imported yet: the orders the live job saved so far.
   or (d.business_id is null and r.run_id is null and r.seen_run_id is null and r.capture_key like 'live:%'))
  and (p_business_id is null or r.business_id=p_business_id)
  and (p_from is null or r.business_date>=p_from) and (p_to is null or r.business_date<=p_to)
  and case when p_business_id is not null then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(r.business_id) end),
checks as not materialized (
 select o.*,c.v c,c.n cn,
  o.o_void or (c.v->'voided') is not distinct from 'true'::jsonb or (c.v->'deleted') is not distinct from 'true'::jsonb c_void
 from orders o cross join lateral jsonb_array_elements(case when jsonb_typeof(o.o->'checks')='array'
  then o.o->'checks' else '[]'::jsonb end) with ordinality c(v,n)
 where jsonb_typeof(c.v)='object'),
items as not materialized (
 -- Gift card and house-account items are deferred: the importer leaves them out of sales.
 select k.*,s.v s,s.n sn,k.c_void or (s.v->'voided') is not distinct from 'true'::jsonb or (s.v->'deferred') is not distinct from 'true'::jsonb
  or (s.v->>'selectionType') is not distinct from 'HOUSE_ACCOUNT_PAY_BALANCE' s_void
 from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'selections')='array'
  then k.c->'selections' else '[]'::jsonb end) with ordinality s(v,n)
 where jsonb_typeof(s.v)='object'),
samples as not materialized (
 select s.*,
  s.endpoint not in ('labor/v1/shifts','labor/v1/timeEntries','cashmgmt/v1/deposits',
   'cashmgmt/v1/entries','kitchen/v1/export/itemFulfillments') and s.endpoint not like 'era/%' setup
 from public.toast_raw_samples s
 where s.http_status between 200 and 299 and s.error_code is null
  and s.endpoint not like 'orders/%' and s.endpoint not like '%{%'
  and (p_business_id is null or s.business_id=p_business_id)
  and case when p_business_id is not null then (select public.toast_records_allowed(p_business_id))
   else public.toast_records_allowed(s.business_id) end
  and coalesce(s.capture_id::text,'row:'||s.id::text)=(
   select coalesce(t.capture_id::text,'row:'||t.id::text) from public.toast_raw_samples t
   where t.business_id=s.business_id and t.restaurant_guid=s.restaurant_guid
    and t.endpoint=s.endpoint and t.http_status between 200 and 299 and t.error_code is null
    and (t.business_date is not distinct from s.business_date or
     s.endpoint not in ('labor/v1/shifts','labor/v1/timeEntries','cashmgmt/v1/deposits',
      'cashmgmt/v1/entries','kitchen/v1/export/itemFulfillments') and s.endpoint not like 'era/%')
   order by t.fetched_at desc,t.id desc limit 1))
select business_id,'toast'::text,'toast-order:'||id::text,st,business_date,
 'order'::text,o->>'guid',o->>'guid',null::text,not o_void,o-'checks'
from orders
union all
select business_id,'toast','toast-check:'||id::text||':'||cn,st,business_date,
 'check',c->>'guid',o->>'guid',c->>'guid',not c_void,
 c-'selections'-'payments'-'appliedDiscounts'-'appliedServiceCharges'
from checks
union all
select business_id,'toast','toast-item:'||id::text||':'||cn||':'||sn,st,business_date,
 'item',s->>'guid',o->>'guid',c->>'guid',not s_void,s-'modifiers'-'appliedDiscounts'
from items
union all
select i.business_id,'toast','toast-modifier:'||i.id::text||':'||i.cn||':'||i.sn||':'||m.n,i.st,
 i.business_date,'modifier',m.v->>'guid',i.o->>'guid',i.c->>'guid',
 not i.s_void and (m.v->'voided') is distinct from 'true'::jsonb,
 m.v||jsonb_build_object('item_ref',i.s->>'guid')
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'modifiers')='array'
 then i.s->'modifiers' else '[]'::jsonb end) with ordinality m(v,n)
where jsonb_typeof(m.v)='object'
union all
select i.business_id,'toast','toast-item-discount:'||i.id::text||':'||i.cn||':'||i.sn||':'||d.n,i.st,
 i.business_date,'item_discount',d.v->>'guid',i.o->>'guid',i.c->>'guid',not i.s_void,
 d.v||jsonb_build_object('item_ref',i.s->>'guid')
from items i cross join lateral jsonb_array_elements(case when jsonb_typeof(i.s->'appliedDiscounts')='array'
 then i.s->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-payment:'||k.id::text||':'||k.cn||':'||p.n,k.st,k.business_date,
 'payment',p.v->>'guid',k.o->>'guid',k.c->>'guid',
 not k.c_void and (p.v->'voided') is distinct from 'true'::jsonb
  and coalesce(p.v->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK'),p.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'payments')='array'
 then k.c->'payments' else '[]'::jsonb end) with ordinality p(v,n)
where jsonb_typeof(p.v)='object'
union all
select k.business_id,'toast','toast-check-discount:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'check_discount',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,d.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedDiscounts')='array'
 then k.c->'appliedDiscounts' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select k.business_id,'toast','toast-service-charge:'||k.id::text||':'||k.cn||':'||d.n,k.st,k.business_date,
 'service_charge',d.v->>'guid',k.o->>'guid',k.c->>'guid',not k.c_void,d.v
from checks k cross join lateral jsonb_array_elements(case when jsonb_typeof(k.c->'appliedServiceCharges')='array'
 then k.c->'appliedServiceCharges' else '[]'::jsonb end) with ordinality d(v,n)
where jsonb_typeof(d.v)='object'
union all
select s.business_id,'toast','toast-capture:'||s.id::text||':'||x.n,'actual',
 case when s.setup then null::date else s.business_date end,
 s.endpoint,x.v->>'guid',null,null,null::boolean,x.v
from samples s cross join lateral jsonb_array_elements(case when jsonb_typeof(s.sample)='array' then s.sample
 when jsonb_typeof(s.sample->'data')='array' then s.sample->'data'
 when jsonb_typeof(s.sample->'results')='array' then s.sample->'results'
 when jsonb_typeof(s.sample->'menus')='array' then s.sample->'menus'
 else jsonb_build_array(s.sample) end) with ordinality x(v,n)
where jsonb_typeof(x.v)='object'
 and (s.setup or ((p_from is null or s.business_date>=p_from) and (p_to is null or s.business_date<=p_to)))
$records$;
revoke all on function public.toast_records_for(uuid,date,date) from public,anon;
grant execute on function public.toast_records_for(uuid,date,date) to authenticated,service_role;
