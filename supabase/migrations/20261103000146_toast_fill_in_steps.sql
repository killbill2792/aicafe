-- Plan step 6 follow-up: the history fill from migration 145 timed out in the SQL editor.
-- The planner had stale row counts for the new (all-empty) columns and re-read a whole
-- day of archived orders for every payment. Each part now unpacks the archive once
-- (materialized) and matches with a hash join. Same rules and results as 145.
-- The fill runs as four separate statements (about 10 seconds each in production):
--   select public.toast_fill_organized_fields(1);  -- payments: server and paid time
--   select public.toast_fill_organized_fields(2);  -- Toast line ID for older item lines
--   select public.toast_fill_organized_fields(3);  -- item timing and kitchen status (after 2)
--   select public.toast_fill_organized_fields(4);  -- order service charges and gratuity
-- Each step only fills empty fields, so any step is safe to re-run.

create or replace function public.toast_fill_organized_fields(p_step integer)
returns integer language plpgsql security definer set search_path=public as $fill$
declare n integer:=0;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 if p_step not between 1 and 4 then raise exception 'step must be 1 to 4'; end if;

 if p_step=1 then
  with pay as materialized (
   select r.business_id,r.restaurant_guid,r.business_date,p.value->>'guid' ref,
    public.toast_uuid_or_null(p.value->'server'->>'guid') server_guid,
    public.toast_time_or_null(p.value->>'paidDate') paid_at
   from public.toast_raw_records r
   cross join lateral jsonb_array_elements(case when jsonb_typeof(r.payload->'checks')='array'
    then r.payload->'checks' else '[]'::jsonb end) c
   cross join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'payments')='array'
    then c.value->'payments' else '[]'::jsonb end) p
   where r.entity='order')
  update public.toast_payment_summaries s set server_guid=pay.server_guid,paid_at=pay.paid_at
  from pay
  where s.business_id=pay.business_id and s.restaurant_guid=pay.restaurant_guid
   and s.business_date=pay.business_date and s.payment_ref=pay.ref
   and s.server_guid is null and s.paid_at is null;
  get diagnostics n=row_count;

 elsif p_step=2 then
  -- Lines written before migration 141 have no Toast line ID. Give it to them where the
  -- match is certain: same order, and the order's lines and countable Toast items pair
  -- up one-to-one on name, quantity, void flag and net amount (the parser's own rules:
  -- active checks only, deferred and house-account items excluded). Identical items in
  -- one order are interchangeable. Orders that do not pair up exactly are left alone.
  with o as materialized (
   select o.id order_id,r.payload p from public.toast_raw_records r
   join public.orders o on o.business_id=r.business_id
    and o.pos_order_id='toast:'||r.restaurant_guid::text||':'||r.entity_guid::text
    and o.business_date=r.business_date
   where r.entity='order' and r.entity_guid is not null and not o.toast_excluded
    and not exists(select 1 from public.order_lines x where x.order_id=o.id and x.pos_line_id is not null)
  ), sk as materialized (
   select o.order_id,s.value->>'guid' guid,
    coalesce(nullif(trim(s.value->>'displayName'),''),'Menu item') name,
    coalesce((s.value->>'quantity')::numeric,0) qty,coalesce((s.value->>'voided')::boolean,false) voided,
    case when coalesce((s.value->>'voided')::boolean,false) then 0
     else round(coalesce((s.value->>'price')::numeric,0)*100)
      -round(coalesce((s.value->'refundDetails'->>'refundAmount')::numeric,0)*100) end net
   from o
   cross join lateral jsonb_array_elements(case when jsonb_typeof(o.p->'checks')='array' then o.p->'checks' else '[]'::jsonb end) c
   cross join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'selections')='array' then c.value->'selections' else '[]'::jsonb end) s
   where not coalesce((c.value->>'deleted')::boolean,false) and not coalesce((c.value->>'voided')::boolean,false)
    and not coalesce((s.value->>'deferred')::boolean,false)
    and coalesce(s.value->>'selectionType','')<>'HOUSE_ACCOUNT_PAY_BALANCE'
    and public.toast_uuid_or_null(s.value->>'guid') is not null
  ), lk as materialized (
   select l.id,l.order_id,l.name,l.quantity qty,l.voided,l.net_sales_cents net
   from public.order_lines l join o using(order_id)
  ), a as (
   select sk.*,row_number() over (partition by order_id,name,qty,voided,net order by guid) rn from sk
  ), b as (
   select lk.*,row_number() over (partition by order_id,name,qty,voided,net order by id) rn from lk
  ), pairs as materialized (
   select b.id line_id,a.guid,b.order_id from b join a using(order_id,name,qty,voided,net,rn)
  ), nl as (select order_id,count(*) n from lk group by 1
  ), ns as (select order_id,count(*) n from sk group by 1
  ), pc as (select order_id,count(*) n from pairs group by 1
  ), whole as (
   select pc.order_id from pc join nl using(order_id) join ns using(order_id)
   where pc.n=nl.n and pc.n=ns.n
  )
  update public.order_lines l set pos_line_id=p.guid
  from pairs p where l.id=p.line_id and p.order_id in (select order_id from whole);
  get diagnostics n=row_count;

 elsif p_step=3 then
  with sel as materialized (
   select r.business_id,r.business_date,
    'toast:'||r.restaurant_guid::text||':'||r.entity_guid::text pos_order_id,
    s.value->>'guid' guid,public.toast_time_or_null(s.value->>'createdDate') ordered_at,
    nullif(left(s.value->>'fulfillmentStatus',40),'') fulfillment_status
   from public.toast_raw_records r
   cross join lateral jsonb_array_elements(case when jsonb_typeof(r.payload->'checks')='array'
    then r.payload->'checks' else '[]'::jsonb end) c
   cross join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'selections')='array'
    then c.value->'selections' else '[]'::jsonb end) s
   where r.entity='order' and r.entity_guid is not null)
  update public.order_lines l set ordered_at=sel.ordered_at,fulfillment_status=sel.fulfillment_status
  from public.orders o, sel
  where l.order_id=o.id and o.pos_order_id like 'toast:%' and l.pos_line_id is not null
   and o.business_id=sel.business_id and o.business_date=sel.business_date
   and o.pos_order_id=sel.pos_order_id and l.pos_line_id=sel.guid
   and l.ordered_at is null and l.fulfillment_status is null;
  get diagnostics n=row_count;

 else
  -- Same rule as the parser: only checks that count (order and check not voided or
  -- deleted, not test mode or excess food); fundraising is not a service charge.
  with charges as materialized (
   select r.business_id,r.business_date,'toast:'||r.restaurant_guid::text||':'||r.entity_guid::text pos_order_id,
    coalesce(sum(round((sc.value->>'chargeAmount')::numeric*100)) filter (where
     coalesce(sc.value->>'serviceChargeCategory','')<>'FUNDRAISING_CAMPAIGN'
     and coalesce((sc.value->>'gratuity')::boolean,false)=false),0)::bigint services,
    coalesce(sum(round((sc.value->>'chargeAmount')::numeric*100)) filter (where
     coalesce(sc.value->>'serviceChargeCategory','')<>'FUNDRAISING_CAMPAIGN'
     and coalesce((sc.value->>'gratuity')::boolean,false)),0)::bigint gratuity
   from public.toast_raw_records r
   cross join lateral jsonb_array_elements(case when jsonb_typeof(r.payload->'checks')='array'
    then r.payload->'checks' else '[]'::jsonb end) c
   left join lateral jsonb_array_elements(case when jsonb_typeof(c.value->'appliedServiceCharges')='array'
    then c.value->'appliedServiceCharges' else '[]'::jsonb end) sc
    on jsonb_typeof(sc.value->'chargeAmount')='number'
   where r.entity='order' and r.entity_guid is not null
    and not coalesce((r.payload->>'deleted')::boolean,false) and not coalesce((r.payload->>'voided')::boolean,false)
    and not coalesce((r.payload->>'excessFood')::boolean,false)
    and not coalesce((r.payload->>'createdInTestMode')::boolean,false)
    and not coalesce((c.value->>'deleted')::boolean,false) and not coalesce((c.value->>'voided')::boolean,false)
   group by 1,2,3
  )
  update public.orders o set service_charges_cents=ch.services,gratuity_cents=ch.gratuity
  from charges ch
  -- An order Toast moved to another day can be archived under both dates: use only
  -- the record filed under the order's own business date.
  where o.business_id=ch.business_id and o.pos_order_id=ch.pos_order_id
   and o.business_date=ch.business_date
   and o.service_charges_cents is null and o.gratuity_cents is null;
  get diagnostics n=row_count;
 end if;
 return n;
end $fill$;
revoke all on function public.toast_fill_organized_fields(integer) from public,anon,authenticated;
grant execute on function public.toast_fill_organized_fields(integer) to service_role;

-- The no-argument version runs all four steps in order (tests and small databases).
create or replace function public.toast_fill_organized_fields()
returns void language plpgsql security definer set search_path=public as $all$
begin
 for s in 1..4 loop perform public.toast_fill_organized_fields(s); end loop;
end $all$;
revoke all on function public.toast_fill_organized_fields() from public,anon,authenticated;
grant execute on function public.toast_fill_organized_fields() to service_role;
