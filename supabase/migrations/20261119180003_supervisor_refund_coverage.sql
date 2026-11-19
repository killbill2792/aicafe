set lock_timeout = '1s';
set statement_timeout = '5s';
-- Order-cohort refund totals are not payment-settlement-day refund totals.
-- Use the existing late-edit certified day, per-location coverage, checked
-- imported amounts and currently effective order rows. Empty evidence is not 0.
create function public.supervisor_checked_order_refunds(p_business_id uuid,p_from date,p_to date)
returns table(business_date date,refund_cents bigint)
language plpgsql stable security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or p_business_id is null or
   p_from is null or p_to is null or p_to<p_from or p_to-p_from>30 then
   raise exception 'refund_coverage_scope_invalid' using errcode='42501';
 end if;
 return query
 with days as (
  select d.business_date,d.orders_count,d.net_sales_cents
  from public.daily_rollups d where d.business_id=p_business_id
    and d.business_date between p_from and p_to and d.sales_data_status='actual'
    and d.voids_status='complete' and d.voids_source='toast'
 ), coverage as (
  select d.business_date,count(*) eligible,
    count(*) filter(where s.import_state='imported' and s.coverage_complete
      and s.unparsed_count=0 and s.recon_state in ('matched','checked_internal')
      and s.rechecking_reason is null and s.refunds_cents is not null
      and s.refunds_cents>=0 and s.net_sales_cents is not null and s.order_count is not null
      and not exists(select 1 from public.toast_day_owner_flags f
        where f.business_id=p_business_id and f.restaurant_guid=m.restaurant_guid
        and f.business_date=d.business_date and f.cleared_at is null)) proven,
    sum(s.refunds_cents)::bigint as refunds,sum(s.order_count) as orders,sum(s.net_sales_cents) as net
  from days d join public.toast_location_mappings m on m.business_id=p_business_id
    and m.verified_at is not null and d.business_date>=coalesce(m.toast_start_date,d.business_date)
  left join public.toast_day_status s on s.business_id=m.business_id
    and s.restaurant_guid=m.restaurant_guid and s.business_date=d.business_date
  group by d.business_date
 ), canonical as (
  select o.business_date,count(*) as orders,sum(o.net_sales_cents) as net,
    sum(o.refunds_cents)::bigint as refunds,
    count(*) filter(where o.pos_order_id not like 'toast:%' or o.refunds_cents is null or o.refunds_cents<0) as invalid
  from public.orders o where o.business_id=p_business_id and o.business_date between p_from and p_to
    and not o.toast_excluded and o.superseded_by is null
  group by o.business_date
 )
 select d.business_date,c.refunds from days d join coverage c on c.business_date=d.business_date
 left join canonical o on o.business_date=d.business_date
 where c.eligible>0 and c.proven=c.eligible and coalesce(o.invalid,0)=0
   and c.orders=d.orders_count and c.net=d.net_sales_cents
   and c.orders=coalesce(o.orders,0) and c.net=coalesce(o.net,0)
   and c.refunds=coalesce(o.refunds,0)
 order by d.business_date;
end $$;
revoke all on function public.supervisor_checked_order_refunds(uuid,date,date) from public,anon,authenticated;
grant execute on function public.supervisor_checked_order_refunds(uuid,date,date) to service_role;
