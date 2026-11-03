-- Daily data health check (AGENTS.md §4b, docs/plans/toast-storage.md step 4).
-- One row per UTC day with the database size, the largest tables and any problems:
--  * database_near_limit  database above 70 % of the plan size;
--  * sudden_growth        grew more than max(50 MB, 20 %) since the previous check;
--  * repeated_pos_records more than one raw record for one POS object on one day;
--  * total_mismatch       a café-day (all its Toast locations, last 30 days) whose stored
--                         orders do not add up to the import total, or whose import total
--                         differs from Toast's own day total (when Toast gave one).
-- Shown on the admin page only (system problems a café owner cannot fix).
-- Counts and IDs only: never order contents or personal details.

create table if not exists public.data_health_checks(
 checked_on date primary key,
 checked_at timestamptz not null default now(),
 database_bytes bigint not null,
 plan_bytes bigint not null,
 largest_tables jsonb not null default '[]'::jsonb check (jsonb_typeof(largest_tables)='array'),
 findings jsonb not null default '[]'::jsonb check (jsonb_typeof(findings)='array')
);
alter table public.data_health_checks enable row level security;
revoke all on public.data_health_checks from public,anon,authenticated;
grant select,insert,update,delete on public.data_health_checks to service_role;

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
    where r.entity_guid is not null
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
