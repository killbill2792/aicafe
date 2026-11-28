set lock_timeout = '5s';
set statement_timeout = '60s';

-- Share the exact multiset comparison with the existing rollup retirement
-- routine. Missing source evidence or divergent historical snapshots survive.
create function public.hourly_sales_snapshot_matches_accepted(p_business uuid,p_day date)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  with saved as materialized (
    select h.location_id,h.hour_local,h.net_sales_cents,h.orders_count from public.hourly_sales_rollup h
    where h.business_id=p_business and h.business_date=p_day
  ), computed as materialized (
    select * from public.accepted_sales_hours_for_day(p_business,p_day) where exists(select from saved)
  )
  select exists(select from saved) and not exists(
    (select * from saved except all select * from computed)
    union all
    (select * from computed except all select * from saved)
  )
$$;

create function public.employee_sales_snapshot_matches_accepted(p_business uuid,p_day date)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  with saved as materialized (
    select e.employee_id,e.net_sales_cents,e.orders_count from public.employee_sales_rollup e
    where e.business_id=p_business and e.business_date=p_day
  ), computed as materialized (
    select * from public.accepted_employee_sales_for_day(p_business,p_day) where exists(select from saved)
  )
  select exists(select from saved) and not exists(
    (select * from saved except all select * from computed)
    union all
    (select * from computed except all select * from saved)
  )
$$;

revoke all on function public.hourly_sales_snapshot_matches_accepted(uuid,date),
  public.employee_sales_snapshot_matches_accepted(uuid,date) from public,anon;
grant execute on function public.hourly_sales_snapshot_matches_accepted(uuid,date),
  public.employee_sales_snapshot_matches_accepted(uuid,date) to authenticated,service_role;

create or replace function public.pos_rebuild_sales_fact_rollups_v1(
  p_business_id uuid,p_business_date date
) returns void language plpgsql security invoker set search_path=public as $$
begin
  if p_business_id is null or p_business_date is null then raise exception 'Missing day'; end if;
  if auth.role() is distinct from 'service_role' and not public.scheduling_is_owner(p_business_id)
    then raise exception 'Not allowed'; end if;
  if not exists(select from public.businesses b where b.id=p_business_id and b.timezone is not null)
    then raise exception 'Missing timezone'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'pos-sales-rollup:'||p_business_id::text||':'||p_business_date::text,0));

  delete from public.hourly_sales_rollup h where h.business_id=p_business_id and h.business_date=p_business_date
    and (select public.hourly_sales_snapshot_matches_accepted(p_business_id,p_business_date));
  delete from public.employee_sales_rollup e where e.business_id=p_business_id and e.business_date=p_business_date
    and (select public.employee_sales_snapshot_matches_accepted(p_business_id,p_business_date));
end $$;
