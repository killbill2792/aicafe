set lock_timeout = '5s';
set statement_timeout = '60s';

-- Match the existing Toast parser's half-away-from-zero rounding, including
-- its tolerance for provider values that sit on a floating-point half cent.
create function public.toast_provisional_dollars_to_cents(p_value jsonb)
returns bigint language sql immutable strict parallel safe security invoker as $cents$
 with amount as (
  select case when pg_catalog.jsonb_typeof(p_value)='number' then (p_value#>>'{}')::numeric end as dollars
 ), scaled as (
  select dollars,case when pg_catalog.abs(dollars)<0.004 then 0::double precision
   when pg_catalog.abs(dollars)<90071992547411 then pg_catalog.abs(dollars::double precision)*100+1e-9::double precision
   end as magnitude
  from amount
 ), rounded as (
  select dollars,pg_catalog.floor(magnitude)::bigint+
   (magnitude-pg_catalog.floor(magnitude)>=0.5)::integer as cents
  from scaled
 )
 select case when cents<=9007199254740991 then pg_catalog.sign(dollars)::integer*cents end from rounded
$cents$;
revoke all on function public.toast_provisional_dollars_to_cents(jsonb) from public,anon,authenticated;
grant execute on function public.toast_provisional_dollars_to_cents(jsonb) to service_role;

-- Reproduce the existing provisional check, discount, refund and item rules
-- from the admitted order body. The final import has its own coverage contract.
create function public.toast_provisional_order_values(
 p_payload jsonb,p_restaurant_guid uuid,p_parse_failed boolean
) returns jsonb language sql stable strict security invoker set search_path=pg_catalog,public
-- Small per-order array scans do not benefit from compiling the plan.
set jit=off set timezone='UTC' as $values$
 with checks as materialized (
  select c.raw,row_number() over(order by c.guid collate "C",c.position) as position
  from (
   select x.*,case when bool_and(jsonb_typeof(x.raw->'guid') is not distinct from 'string') over ()
    then x.raw->>'guid' end as guid
   from jsonb_array_elements(case when jsonb_typeof(p_payload->'checks')='array'
    then p_payload->'checks' else '[]'::jsonb end) with ordinality x(raw,position)
  ) c
 ), active_checks as materialized (
  select raw,position from checks
  where not p_parse_failed and p_payload->'deleted' is distinct from 'true'::jsonb
   and p_payload->'voided' is distinct from 'true'::jsonb and p_payload->'excessFood' is distinct from 'true'::jsonb
   and p_payload->'createdInTestMode' is distinct from 'true'::jsonb
   and raw->'deleted' is distinct from 'true'::jsonb and raw->'voided' is distinct from 'true'::jsonb
 ), selections as materialized (
  select c.position as check_position,s.position,s.raw,
   (s.raw->'deferred' is not distinct from 'true'::jsonb or
    s.raw->>'selectionType' is not distinct from 'HOUSE_ACCOUNT_PAY_BALANCE') as deferred
  from active_checks c
  cross join lateral (
   select picked.raw,row_number() over(order by picked.guid collate "C",picked.position) as position
   from (
    select x.*,case when bool_and(jsonb_typeof(x.raw->'guid') is not distinct from 'string') over ()
     then x.raw->>'guid' end as guid
    from jsonb_array_elements(case when jsonb_typeof(c.raw->'selections')='array'
     then c.raw->'selections' else '[]'::jsonb end) with ordinality x(raw,position)
   ) picked
  ) s
  where s.raw->'voided' is distinct from 'true'::jsonb
 ), adjustments as (
  select public.toast_provisional_dollars_to_cents(x.raw->'chargeAmount') as amount
  from active_checks c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'appliedServiceCharges')='array'
   then c.raw->'appliedServiceCharges' else '[]'::jsonb end) x(raw)
  where x.raw->>'serviceChargeCategory'='FUNDRAISING_CAMPAIGN'
  union all
  select public.toast_provisional_dollars_to_cents(s.raw->'price') from selections s where s.deferred
 ), discounts as (
  select d.raw->'discountAmount' as amount from active_checks c
  cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'appliedDiscounts')='array'
   then c.raw->'appliedDiscounts' else '[]'::jsonb end) d(raw)
  where d.raw->>'processingState' is distinct from 'VOID'
  union all
  select case when s.raw->>'taxInclusion'='INCLUDED'
   then coalesce(nullif(d.raw->'nonTaxDiscountAmount','null'::jsonb),d.raw->'discountAmount')
   else d.raw->'discountAmount' end
  from selections s cross join lateral jsonb_array_elements(case when jsonb_typeof(s.raw->'appliedDiscounts')='array'
   then s.raw->'appliedDiscounts' else '[]'::jsonb end) d(raw)
  where not s.deferred and d.raw->>'processingState' is distinct from 'VOID'
 ), payments as (
  select coalesce(sum(public.toast_provisional_dollars_to_cents(p.raw->'refund'->'refundAmount')),0) as refunds,
   coalesce(sum(coalesce(public.toast_provisional_dollars_to_cents(p.raw->'tipAmount'),0)-
    coalesce(public.toast_provisional_dollars_to_cents(p.raw->'refund'->'tipRefundAmount'),0)),0) as tips
  from active_checks c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'payments')='array'
   then c.raw->'payments' else '[]'::jsonb end) p(raw)
  where p.raw->'voided' is distinct from 'true'::jsonb
   and coalesce(p.raw->>'paymentStatus','') not in ('VOIDED','DENIED','CANCELLED','ERROR','ERROR_NETWORK')
 ), amounts as (
  select coalesce(sum(public.toast_provisional_dollars_to_cents(raw->'amount')),0)-
   (select coalesce(sum(amount),0) from adjustments) as before_refunds,
   (select coalesce(sum(public.toast_provisional_dollars_to_cents(amount)),0) from discounts) as discount,
   count(*) as checks_count,count(*) filter(where raw->>'paymentStatus' in ('OPEN','PAID')) as open_checks
  from active_checks
 ), items as (
  select coalesce(jsonb_agg(jsonb_build_object(
   'key',coalesce('toast:'||p_restaurant_guid::text||':'||(s.raw->'item'->>'guid'),'name:'||name.value),
   'name',name.value,
   'quantity',case when jsonb_typeof(s.raw->'quantity')='number' then s.raw->'quantity' else '0'::jsonb end,
   'netSalesCents',coalesce(public.toast_provisional_dollars_to_cents(s.raw->'price'),0)-
    coalesce(public.toast_provisional_dollars_to_cents(s.raw->'refundDetails'->'refundAmount'),0))
   order by s.check_position,s.position),'[]'::jsonb) as lines
  from selections s cross join lateral (
   select coalesce(nullif(btrim(s.raw->>'displayName',
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),''),'Menu item') as value
  ) name
  where not s.deferred
 )
 select jsonb_build_object(
  'netSalesCents',a.before_refunds-p.refunds,'grossSalesCents',a.before_refunds+a.discount,
  'discountsCents',a.discount,'refundsCents',p.refunds,'tipCents',p.tips,
  'orders',case when a.checks_count>0 then 1 else 0 end,'openChecks',a.open_checks,
  'unparsedOrders',case when p_parse_failed then 1 else 0 end,'items',i.lines,
  'observedAt',case when not p_parse_failed then to_char(coalesce(
   public.toast_time_or_null(p_payload->>'closedDate'),public.toast_time_or_null(p_payload->>'openedDate')
  ) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end)
 from amounts a cross join payments p cross join items i
$values$;
revoke all on function public.toast_provisional_order_values(jsonb,uuid,boolean) from public,anon,authenticated;
grant execute on function public.toast_provisional_order_values(jsonb,uuid,boolean) to service_role;

-- Preserve the same receipt for old live orders only when their saved
-- contribution is fully reproducible. Divergent historical evidence remains.
update public.toast_raw_records r
 set source_context=coalesce(r.source_context,'{}'::jsonb)||jsonb_build_object(
  'toastCanonicalOrder',jsonb_build_object('payloadSha256',r.payload_sha256)),
  live_projection=null
 where r.entity='order' and r.live_projection is not null
  and r.payload_origin in ('provider','historical_provider')
  and r.live_projection=public.toast_provisional_order_values(r.payload,r.restaurant_guid,false);

-- Bind every retained exception to the body present at cutover. Another writer
-- can change the body before canonical polling sees it.
update public.toast_raw_records r
 set source_context=coalesce(r.source_context,'{}'::jsonb)||jsonb_build_object(
  'toastLegacyProjectionBaseline',r.payload_sha256)
 where r.entity='order' and r.live_projection is not null
  and (r.source_context->>'toastLegacyProjectionBaseline') is null;

create or replace function public.toast_ingest_order_revisions(
 p_business_id uuid,p_restaurant_guid uuid,p_rows jsonb)
returns integer language plpgsql security invoker set search_path=public as $$
declare m record; item jsonb; payload jsonb; d date; current_day date;
 g uuid; prior public.toast_raw_records%rowtype; sha text; result text; changed integer:=0; old_day date; moved boolean;
 parse_failed boolean; receipt jsonb;
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
   or (item?'parseFailed' and jsonb_typeof(item->'parseFailed') is distinct from 'boolean')
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
    -- The digest binds canonical validation to this exact provider body even
    -- if another archive writer subsequently changes the same order.
    parse_failed:=coalesce((item->>'parseFailed')::boolean,item->'projection'->>'unparsedOrders'='1',false);
    receipt:=jsonb_strip_nulls(jsonb_build_object('payloadSha256',sha,'parseFailed',case when parse_failed then true end));
    -- A retained historical exception survives replays and later revisions.
    update public.toast_raw_records
     set source_context=coalesce(source_context,'{}'::jsonb)||jsonb_build_object('toastCanonicalOrder',receipt)
     where business_id=p_business_id and restaurant_guid=p_restaurant_guid and business_date=d
      and entity='order' and entity_guid=g and payload_sha256=sha
      and source_context->'toastCanonicalOrder' is distinct from receipt
      and (live_projection is null or result='changed' or source_context?'toastCanonicalOrder'
       or source_context->>'toastLegacyProjectionBaseline'<>sha);
    if found or result in ('inserted','changed') then changed:=changed+1;end if;
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

create or replace function public.toast_refresh_canonical_live(p_business_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare d date; zone text; source_at timestamptz; n integer; ready integer; observed integer; gap_count integer; result jsonb;
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
 select count(*) filter(where h.canonical_live_day=d and h.canonical_order_poll_at is not null),
  count(*) filter(where (h.canonical_live_day=d and h.canonical_order_poll_at is not null)
    or (q.bootstrap_day=d and q.unparsed_pages<>'{}'::jsonb)),
  min(case when h.canonical_live_day=d then h.canonical_order_poll_at else q.window_since end),
  coalesce(sum((select coalesce(sum(jsonb_array_length(e.value)),0) from jsonb_each(q.unparsed_pages) e)),0)
 into ready,observed,source_at,gap_count
 from public.toast_location_mappings m left join public.toast_sync_health h using(business_id,restaurant_guid)
 left join public.toast_order_poll_progress q on q.business_id=m.business_id and q.restaurant_guid=m.restaurant_guid and q.canonical
 where m.business_id=p_business_id and m.verified_at is not null
  and ((now() at time zone m.toast_time_zone)-make_interval(hours=>m.closeout_hour))::date=d;
 if observed<>n or source_at is null then return null;end if;
 with revisions as materialized (
  select case when evidence.canonical_sha is null and not proof.stale then r.live_projection else
    public.toast_provisional_order_values(r.payload,r.restaurant_guid,proof.stale
     or r.source_context#>'{toastCanonicalOrder,parseFailed}' is not distinct from 'true'::jsonb) end p,
   proof.stale
  from public.toast_raw_records r join public.toast_location_mappings m using(business_id,restaurant_guid)
  cross join lateral (values(r.source_context#>>'{toastCanonicalOrder,payloadSha256}',
   r.source_context->>'toastLegacyProjectionBaseline')) evidence(canonical_sha,legacy_sha)
  cross join lateral (values(coalesce(evidence.canonical_sha,evidence.legacy_sha,r.payload_sha256)<>r.payload_sha256)) proof(stale)
  where r.business_id=p_business_id and r.business_date=d and r.entity='order'
   and m.verified_at is not null
   and (r.live_projection is not null or evidence.canonical_sha is not null)
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
   coalesce(sum((p->>'unparsedOrders')::integer),0) unparsed,count(*) filter(where stale) stale_orders,
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
  'orders',orders,'openChecks',open_checks,'unparsedOrders',unparsed+gap_count,'locationsRead',ready,'locationsFailed',n-ready,
  'truncated',gap_count>0 or ready<>n or stale_orders>0,'hourlyUnassignedOrders',unassigned,
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
