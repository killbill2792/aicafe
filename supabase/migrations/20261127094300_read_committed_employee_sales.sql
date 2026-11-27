-- Reason: Replace the application and governed SQL readers together.
-- squawk-ignore transaction-nesting
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.employee_sales_for_day(p_business uuid,p_day date)
returns table(employee_id uuid,net_sales_cents bigint,orders_count integer)
language plpgsql stable security invoker set search_path=pg_catalog,public
set jit=off as $$
begin
 if current_user not in ('postgres','service_role','supabase_admin')
    and not public.scheduling_is_owner(p_business) then return; end if;

 return query
 with complete_day as materialized (
  select d.business_id,d.business_date,d.orders_count,d.net_sales_cents
  from public.daily_rollups d
  where d.business_id=p_business and d.business_date=p_day
   and d.sales_data_status='actual' and d.orders_count>0
   and exists(select from public.toast_day_status c
    where c.business_id=d.business_id and c.business_date=d.business_date)
 ), originals as materialized (
  select r.pos_order_id,r.restaurant_guid,r.payload,
   coalesce(r.payload#>>'{server,guid}',r.payload#>>'{openedBy,guid}') as provider_employee
  from public.toast_committed_sales_orders(p_business,p_day) r
 ), orders as materialized (
  select e.id as employee_id,o.net_sales_cents as accepted_amount,
   public.toast_committed_order_net_cents(r.payload) as amount,
   -- Preserve existing accepted attribution. Directory-only or ambiguous
   -- historical links continue through the saved rollup.
   (o.employee_id is null and r.provider_employee is null)
    or coalesce(e.pos_team_member_id='toast:'||r.restaurant_guid::text||':'||r.provider_employee,false)
    as employee_matches
  from complete_day d join public.orders o using(business_id,business_date)
  left join originals r on r.pos_order_id=o.pos_order_id
  left join public.employees e on (e.business_id,e.id)=(o.business_id,o.employee_id)
  where o.toast_excluded is not true and o.superseded_by is null
 ), audited as (
  select from complete_day d
  join (select count(*) as order_count,sum(o.amount) as cents,
    bool_and(o.amount is not null and o.amount=o.accepted_amount and o.employee_matches) as complete
   from orders o) a on a.complete and a.order_count=d.orders_count and a.cents=d.net_sales_cents
 )
 select o.employee_id,sum(o.amount)::bigint,count(*)::integer
 from audited cross join orders o where o.employee_id is not null group by o.employee_id;
 if found then return; end if;

 return query
 select r.employee_id,r.net_sales_cents,r.orders_count
 from public.employee_sales_rollup r where r.business_id=p_business and r.business_date=p_day;
end $$;
revoke all on function public.employee_sales_for_day(uuid,date) from public,anon;
grant execute on function public.employee_sales_for_day(uuid,date) to authenticated,service_role;

create or replace view public.cv_employee_sales with (security_invoker=true) as
 select d.business_id,d.business_date,s.employee_id,s.net_sales_cents,s.orders_count
 from (
  select r.business_id,r.business_date from public.employee_sales_rollup r
  union select r.business_id,r.business_date from public.daily_rollups r where r.sales_data_status='actual'
 ) d cross join lateral public.employee_sales_for_day(d.business_id,d.business_date) s;
revoke all on public.cv_employee_sales from public,anon,authenticated;
grant select on public.cv_employee_sales to authenticated,service_role;

create or replace function u3_research_private.committed_employee_sales(p_day date)
returns table(employee_id uuid,net_sales_cents bigint,orders_count integer)
language sql stable security definer set search_path='' as $$
 select case when s.mode='owner' then r.employee_id end,r.net_sales_cents,r.orders_count
 from u3_research_private.scope() s
 cross join lateral public.employee_sales_for_day(s.business_id,p_day) r
$$;
revoke all on function u3_research_private.committed_employee_sales(date) from public,anon,authenticated,aicafe_research;
grant execute on function u3_research_private.committed_employee_sales(date)
 to aicafe_research_view_owner,aicafe_research;
alter policy "owners read" on public.employee_sales_rollup to authenticated,service_role;
alter policy "owners write" on public.employee_sales_rollup to authenticated,service_role;

grant aicafe_research_view_owner to postgres with set true;
set local role aicafe_research_view_owner;
create or replace view u3_research.employee_sales_rollup with (security_barrier=true) as
 select d.business_date,s.employee_id,s.net_sales_cents,s.orders_count
 from (
  select r.business_date from public.employee_sales_rollup r
  union select r.business_date from public.daily_rollups r where r.sales_data_status='actual'
 ) d cross join lateral u3_research_private.committed_employee_sales(d.business_date) s;
reset role;
revoke aicafe_research_view_owner from postgres;
-- Reason: Complete the role-scoped replacement together.
-- squawk-ignore transaction-nesting
commit;
