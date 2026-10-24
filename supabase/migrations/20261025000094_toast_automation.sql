-- PR2 foundation, installed manually after 093. No flag activation.
create table public.toast_automation_leases(
 business_id uuid not null,restaurant_guid uuid not null,
 nonce uuid,lease_until timestamptz,
 primary key(business_id,restaurant_guid),
 foreign key(business_id,restaurant_guid)
 references public.toast_location_mappings(business_id,restaurant_guid));
alter table public.toast_automation_leases enable row level security;
revoke all on public.toast_automation_leases from public,anon,authenticated;
grant select,insert,update,delete on public.toast_automation_leases to service_role;

create function public.toast_acquire_lease(p_business_id uuid,p_restaurant_guid uuid,p_seconds integer)
returns uuid language plpgsql security definer set search_path=public as $fn$
declare n uuid:=gen_random_uuid();acquired uuid;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_seconds not between 241 and 300 then raise exception 'invalid lease';end if;
 insert into public.toast_automation_leases(business_id,restaurant_guid,nonce,lease_until)
 select p_business_id,p_restaurant_guid,n,now()+make_interval(secs=>p_seconds)
 where exists(select 1 from public.toast_location_mappings
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null)
 on conflict(business_id,restaurant_guid) do update set
 nonce=excluded.nonce,lease_until=excluded.lease_until
 where toast_automation_leases.lease_until is null or toast_automation_leases.lease_until<now()
 returning nonce into acquired;
 return acquired;
end $fn$;
create function public.toast_release_lease(p_nonce uuid)
returns boolean language plpgsql security definer set search_path=public as $fn$
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 update public.toast_automation_leases set nonce=null,lease_until=null
 where nonce=p_nonce and lease_until is not null;
 return found;
end $fn$;
create function public.toast_checkpoint_day(p_run_id uuid,p_business_id uuid,
 p_restaurant_guid uuid,p_business_date date,p_page integer,p_category text,
 p_retry_at timestamptz default null)
returns void language plpgsql security definer set search_path=public as $fn$
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_page not between 1 and 300 then raise exception 'invalid page';end if;
 update public.toast_sync_runs set state='paused_rate_limited',
 last_error_category=p_category,
 resume_at=case when p_category='timeout' then now()
 when p_category='rate_limited' then greatest(now(),coalesce(p_retry_at,now()+interval '1 minute'))
 else now()+make_interval(mins=>case
 when coalesce((cursor->>'backoff_attempt')::integer,0)=0 then 1
 when coalesce((cursor->>'backoff_attempt')::integer,0)=1 then 5
 when coalesce((cursor->>'backoff_attempt')::integer,0)=2 then 15 else 60 end) end,
 cursor=jsonb_build_object('business_date',p_business_date,'page',p_page,
 'backoff_attempt',case when p_category='timeout' then 0
 else least(coalesce((cursor->>'backoff_attempt')::integer,0)+1,4) end),
 rate_limited_count=rate_limited_count+case when p_category='rate_limited' then 1 else 0 end
 where id=p_run_id and business_id=p_business_id and restaurant_guid=p_restaurant_guid
 and state in ('queued','running','paused_rate_limited');
 if not found then raise exception 'invalid run';end if;
end $fn$;
create function public.toast_queue_backfill(p_business_id uuid,p_restaurant_guid uuid,
 p_from date,p_to date)
returns uuid language plpgsql security definer set search_path=public as $fn$
declare result uuid;v_prior_start date;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_from<'2015-12-02'::date or p_to<p_from or p_to-p_from>=400
 or p_to>=current_date then raise exception 'invalid backfill range';end if;
 if not exists(select 1 from public.toast_location_mappings
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'unverified location';end if;
 -- Serialize date eligibility and the dependent stored coverage in this transaction.
 select toast_start_date into v_prior_start from public.toast_location_mappings
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid for update;
 if v_prior_start is not null and p_from<v_prior_start then
  update public.toast_location_mappings set toast_start_date=p_from
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
  update public.daily_rollups dr set sales_data_status='missing'
   where dr.business_id=p_business_id and dr.business_date>=p_from
    and dr.business_date<v_prior_start and dr.sales_data_status='actual'
    and exists (
     select 1 from public.toast_location_mappings m
     left join public.toast_day_status ds
      on ds.business_id=m.business_id and ds.restaurant_guid=m.restaurant_guid
      and ds.business_date=dr.business_date
     where m.business_id=dr.business_id and m.verified_at is not null
      and dr.business_date>=coalesce(m.toast_start_date,dr.business_date)
      and (ds.import_state is distinct from 'imported'
       or not coalesce(ds.coverage_complete,false))
    );
 end if;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
 requested_from,requested_to,days_total,cursor)
 values(p_business_id,p_restaurant_guid,'backfill',p_from,p_to,p_to-p_from+1,
 jsonb_build_object('next_date',p_from,'page',1)) returning id into result;
 return result;
end $fn$;
revoke all on function public.toast_acquire_lease(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.toast_release_lease(uuid) from public,anon,authenticated;
revoke all on function public.toast_checkpoint_day(uuid,uuid,uuid,date,integer,text,timestamptz) from public,anon,authenticated;
revoke all on function public.toast_queue_backfill(uuid,uuid,date,date) from public,anon,authenticated;
grant execute on function public.toast_acquire_lease(uuid,uuid,integer) to service_role;
grant execute on function public.toast_release_lease(uuid) to service_role;
grant execute on function public.toast_checkpoint_day(uuid,uuid,uuid,date,integer,text,timestamptz) to service_role;
grant execute on function public.toast_queue_backfill(uuid,uuid,date,date) to service_role;

-- The day RPC commits sales and advances days_done before TypeScript recomputes
-- costs. Queue a separate, durable post-commit rollup job INSIDE that transaction.
create table public.toast_rollup_refresh_jobs(
 business_id uuid not null references public.businesses(id),
 business_date date not null,
 generation uuid not null default gen_random_uuid(),
 requested_at timestamptz not null default now(),
 retry_at timestamptz not null default now(),
 attempts integer not null default 0,
 last_error_category text,
 primary key(business_id,business_date)
);
alter table public.toast_rollup_refresh_jobs enable row level security;
revoke all on public.toast_rollup_refresh_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.toast_rollup_refresh_jobs to service_role;

create function public.toast_enqueue_rollup_refresh()
returns trigger language plpgsql security definer set search_path=public as $enqueue$
begin
 if new.import_state='imported' then
  insert into public.toast_rollup_refresh_jobs(business_id,business_date)
  values(new.business_id,new.business_date)
  on conflict(business_id,business_date) do update set
   generation=gen_random_uuid(),requested_at=now(),retry_at=now(),
   attempts=0,last_error_category=null;
 end if;
 return new;
end $enqueue$;
create trigger toast_queue_costs_after_import
 after insert or update of imported_at on public.toast_day_status
 for each row execute function public.toast_enqueue_rollup_refresh();

-- Compare the job's generation so a later import can never be acknowledged by an
-- older worker that finished recomputing the same business day concurrently.
create function public.toast_ack_rollup_refresh(
 p_business_id uuid,p_business_date date,p_generation uuid)
returns boolean language plpgsql security definer set search_path=public as $ack$
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 delete from public.toast_rollup_refresh_jobs
 where business_id=p_business_id and business_date=p_business_date
  and generation=p_generation;
 return found;
end $ack$;

create function public.toast_defer_rollup_refresh(
 p_business_id uuid,p_business_date date,p_generation uuid,p_category text)
returns void language plpgsql security definer set search_path=public as $defer$
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 update public.toast_rollup_refresh_jobs
 set attempts=attempts+1,last_error_category=left(p_category,80),
  retry_at=now()+make_interval(mins=>case
   when attempts=0 then 1 when attempts=1 then 5
   when attempts=2 then 15 else 60 end)
 where business_id=p_business_id and business_date=p_business_date
  and generation=p_generation;
end $defer$;

revoke all on function public.toast_enqueue_rollup_refresh() from public,anon,authenticated;
revoke all on function public.toast_ack_rollup_refresh(uuid,date,uuid) from public,anon,authenticated;
revoke all on function public.toast_defer_rollup_refresh(uuid,date,uuid,text) from public,anon,authenticated;
grant execute on function public.toast_ack_rollup_refresh(uuid,date,uuid) to service_role;
grant execute on function public.toast_defer_rollup_refresh(uuid,date,uuid,text) to service_role;

alter table public.toast_sync_runs add column invalid_days integer not null default 0;

-- A bad late re-pull must not turn previously committed sales into missing data.
-- SQL holds the decisive row lock; the importer cannot safely infer this in JS.
create function public.toast_record_day_error(
 p_run_id uuid,p_business_id uuid,p_restaurant_guid uuid,p_business_date date,
 p_category text,p_run_fatal boolean,p_skip boolean)
returns void language plpgsql security definer set search_path=public as $dayerr$
declare was_imported boolean;v_run public.toast_sync_runs%rowtype;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 select * into v_run from public.toast_sync_runs where id=p_run_id
  and business_id=p_business_id and restaurant_guid=p_restaurant_guid for update;
 if not found or v_run.state not in ('queued','running','paused_rate_limited') then
  raise exception 'invalid Toast run';end if;
 if p_skip and v_run.requested_from is not null and v_run.kind='backfill'
    and v_run.requested_from+v_run.days_done<>p_business_date then
  raise exception 'out of order Toast day';end if;
 select import_state='imported' into was_imported from public.toast_day_status
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and business_date=p_business_date for update;
 if coalesce(was_imported,false) then
  update public.toast_day_status set last_error_category=p_category
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid
   and business_date=p_business_date;
 else
  insert into public.toast_day_status(business_id,restaurant_guid,business_date,
   import_state,recon_state,last_error_category)
  values(p_business_id,p_restaurant_guid,p_business_date,'failed','pending',p_category)
  on conflict(business_id,restaurant_guid,business_date) do update
   set import_state='failed',coverage_complete=false,last_error_category=excluded.last_error_category;
  -- Preserve other locations' raw sales, but their business-wide coverage is unknown.
  update public.daily_rollups set sales_data_status='missing'
   where business_id=p_business_id and business_date=p_business_date;
 end if;
 if p_run_fatal then
  update public.toast_sync_runs set state='failed',finished_at=now(),
   resume_at=null,last_error_category=p_category where id=p_run_id;
 elsif p_skip then
  update public.toast_sync_runs set invalid_days=invalid_days+1,days_done=days_done+1,
   state=case when days_total>0 and days_done+1>=days_total then 'completed' else 'running' end,
   finished_at=case when days_total>0 and days_done+1>=days_total then now() else null end,
   cursor='{}'::jsonb,resume_at=null,last_error_category=p_category where id=p_run_id;
 else
  update public.toast_sync_runs set last_error_category=p_category where id=p_run_id;
 end if;
 if p_skip or p_run_fatal then
  delete from public.toast_day_pages where run_id=p_run_id and business_date=p_business_date;
 end if;
end $dayerr$;
revoke all on function public.toast_record_day_error(uuid,uuid,uuid,date,text,boolean,boolean)
 from public,anon,authenticated;
grant execute on function public.toast_record_day_error(uuid,uuid,uuid,date,text,boolean,boolean)
 to service_role;

-- Defend callers of the PR1 RPC as well: imported rows must not be demoted.
create or replace function public.toast_mark_day_failed(
 p_business_id uuid,p_restaurant_guid uuid,p_business_date date,p_run_id uuid,p_category text)
returns void language plpgsql security definer set search_path=public as $safefail$
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 perform public.toast_record_day_error(p_run_id,p_business_id,p_restaurant_guid,
  p_business_date,p_category,true,false);
end $safefail$;

-- Reuse an active identical backfill; completed runs may be requested again.
create unique index toast_one_active_backfill_range on public.toast_sync_runs(
 business_id,restaurant_guid,requested_from,requested_to)
 where kind='backfill' and state in ('queued','running','paused_rate_limited');

create or replace function public.toast_queue_backfill(
 p_business_id uuid,p_restaurant_guid uuid,p_from date,p_to date)
returns uuid language plpgsql security definer set search_path=public as $queue$
declare v_prior date;v_id uuid;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_from<'2015-12-02'::date or p_to<p_from or p_to-p_from>=400
  or p_to>=current_date then raise exception 'invalid backfill range';end if;
 select m.toast_start_date into v_prior
 from public.toast_location_mappings m
 where m.business_id=p_business_id and m.restaurant_guid=p_restaurant_guid
 and m.verified_at is not null for update;
 if not found then raise exception 'unverified Toast location';end if;
 if v_prior is not null and p_from<v_prior then
  update public.toast_location_mappings set toast_start_date=p_from
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
  -- The stored business-wide total was computed before this location became
  -- applicable. Invalidate EVERY affected previously actual date atomically.
  update public.daily_rollups dr set sales_data_status='missing'
  where dr.business_id=p_business_id and dr.business_date>=p_from
   and dr.business_date<v_prior and dr.sales_data_status='actual'
   and exists(
    select 1 from public.toast_location_mappings m
    left join public.toast_day_status d on d.business_id=m.business_id
     and d.restaurant_guid=m.restaurant_guid and d.business_date=dr.business_date
    where m.business_id=dr.business_id and m.verified_at is not null
     and dr.business_date>=coalesce(m.toast_start_date,dr.business_date)
     and (d.import_state is distinct from 'imported'
      or not coalesce(d.coverage_complete,false))
   );
 end if;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
  requested_from,requested_to,days_total,cursor)
 values(p_business_id,p_restaurant_guid,'backfill',p_from,p_to,p_to-p_from+1,'{}'::jsonb)
 on conflict(business_id,restaurant_guid,requested_from,requested_to)
  where kind='backfill' and state in ('queued','running','paused_rate_limited')
 do update set last_error_category=public.toast_sync_runs.last_error_category
 returning id into v_id;
 return v_id;
end $queue$;

-- P1: transient re-import failures also retain an imported day's error category.
create or replace function public.toast_checkpoint_day(
 p_run_id uuid,p_business_id uuid,p_restaurant_guid uuid,p_business_date date,
 p_page integer,p_category text,p_retry_at timestamptz default null)
returns void language plpgsql security definer set search_path=public as $checkpoint$
begin
 if auth.role()<>'service_role' or p_page not between 1 and 300
 then raise exception 'invalid Toast checkpoint';end if;
 update public.toast_sync_runs set state='paused_rate_limited',
 last_error_category=p_category,
 resume_at=case when p_category='timeout' then now()
  when p_category='rate_limited' then greatest(now(),coalesce(p_retry_at,now()+interval '1 minute'))
  else now()+make_interval(mins=>case coalesce((cursor->>'backoff_attempt')::integer,0)
   when 0 then 1 when 1 then 5 when 2 then 15 else 60 end) end,
 cursor=jsonb_build_object('business_date',p_business_date,'page',p_page,
  'backoff_attempt',case when p_category='timeout' then 0
   else least(coalesce((cursor->>'backoff_attempt')::integer,0)+1,4) end),
 rate_limited_count=rate_limited_count+case when p_category='rate_limited' then 1 else 0 end
 where id=p_run_id and business_id=p_business_id and restaurant_guid=p_restaurant_guid
 and state in ('queued','running','paused_rate_limited');
 if not found then raise exception 'invalid Toast run';end if;
 update public.toast_day_status set last_error_category=p_category
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and business_date=p_business_date;
end $checkpoint$;

-- A D-1 cron job can be queued only once, even across concurrent invocations.
create unique index toast_daily_once on public.toast_sync_runs(
 business_id,restaurant_guid,requested_from)
 where kind='daily';

create function public.toast_queue_daily(p_business_id uuid,p_restaurant_guid uuid,p_date date)
returns uuid language plpgsql security definer set search_path=public as $daily$
declare result uuid;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if not exists(select 1 from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and verified_at is not null) then raise exception 'unverified location';end if;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
  requested_from,requested_to,days_total)
 values(p_business_id,p_restaurant_guid,'daily',p_date,p_date,1)
 on conflict(business_id,restaurant_guid,requested_from)
  where kind='daily' do update
 set last_error_category=public.toast_sync_runs.last_error_category
 returning id into result;
 return result;
end $daily$;
revoke all on function public.toast_queue_daily(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.toast_queue_daily(uuid,uuid,date) to service_role;

-- Per-location modified-date scan marker, separate from individual full-day runs.
create table public.toast_repull_scan_state(
 business_id uuid not null,restaurant_guid uuid not null,
 last_local_day date,last_window_end timestamptz,updated_at timestamptz,
 primary key(business_id,restaurant_guid),
 foreign key(business_id,restaurant_guid)
 references public.toast_location_mappings(business_id,restaurant_guid));
alter table public.toast_repull_scan_state enable row level security;
revoke all on public.toast_repull_scan_state from public,anon,authenticated;
grant select,insert,update,delete on public.toast_repull_scan_state to service_role;
alter table public.toast_sync_runs add column scan_local_day date;
create unique index toast_one_repull_per_scan_day on public.toast_sync_runs(
 business_id,restaurant_guid,requested_from,scan_local_day)
 where kind='repull_modified';
create function public.toast_commit_repull_scan(
 p_business_id uuid,p_restaurant_guid uuid,p_local_day date,
 p_days jsonb,p_window_end timestamptz)
returns integer language plpgsql security definer set search_path=public as $repull$
declare d date;added integer:=0;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if jsonb_typeof(p_days)<>'array' or jsonb_array_length(p_days)>400
 then raise exception 'invalid modified dates';end if;
 if not exists(select 1 from public.toast_location_mappings where business_id=p_business_id
  and restaurant_guid=p_restaurant_guid and verified_at is not null)
 then raise exception 'unverified restaurant';end if;
 -- Commit the discovered dates and the watermark together.
 for d in select distinct value::date from jsonb_array_elements_text(p_days) loop
  if d<'2015-12-02'::date or d>=p_local_day then
   raise exception 'invalid modified business date';end if;
  insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
   requested_from,requested_to,scan_local_day,days_total)
  values(p_business_id,p_restaurant_guid,'repull_modified',d,d,p_local_day,1)
  on conflict(business_id,restaurant_guid,requested_from,scan_local_day)
   where kind='repull_modified' do nothing;
  if found then
   added:=added+1;
   -- A queued late edit makes previous reconciliation/void certification stale
   -- even before the complete-day re-pull commits. Never demote prior sales.
   update public.toast_day_status set recon_state='pending',
    last_recon_attempt_at=null
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid
    and business_date=d and import_state='imported';
   update public.daily_rollups set voids_status='unknown',voids_source=null
   where business_id=p_business_id and (
    business_date=d or business_date in (
     select f.void_business_date from public.toast_void_facts f
     where f.business_id=p_business_id and f.order_business_date=d));
  end if;
 end loop;
 insert into public.toast_repull_scan_state(
  business_id,restaurant_guid,last_local_day,last_window_end,updated_at)
 values(p_business_id,p_restaurant_guid,p_local_day,p_window_end,now())
 on conflict(business_id,restaurant_guid) do update
 set last_local_day=greatest(toast_repull_scan_state.last_local_day,excluded.last_local_day),
  last_window_end=greatest(toast_repull_scan_state.last_window_end,excluded.last_window_end),
  updated_at=now();
 return added;
end $repull$;
revoke all on function public.toast_commit_repull_scan(uuid,uuid,date,jsonb,timestamptz)
 from public,anon,authenticated;
grant execute on function public.toast_commit_repull_scan(uuid,uuid,date,jsonb,timestamptz)
 to service_role;

-- Expire abandoned pages only. Do not delete checkpoint pages of active,
-- recently paused or resumable runs.
create function public.toast_cleanup_abandoned_pages()
returns integer language plpgsql security definer set search_path=public as $cleanup$
declare n integer;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 delete from public.toast_day_pages p using public.toast_sync_runs r
 where r.id=p.run_id and (r.state='failed' or
  (coalesce(r.started_at,r.finished_at,now())<now()-interval '7 days'
   and r.state<>'paused_rate_limited'));
 get diagnostics n=row_count;
 return n;
end $cleanup$;
revoke all on function public.toast_cleanup_abandoned_pages() from public,anon,authenticated;
grant execute on function public.toast_cleanup_abandoned_pages() to service_role;

-- Cache optional menu/labor refresh stamps without editing canonical recipes or wages.
create table public.toast_optional_sync_state(
 business_id uuid not null,restaurant_guid uuid not null,
 menu_last_updated text,menu_checked_local_day date,
 roster_local_day date,labor_local_day date,jobs_local_day date,
 primary key(business_id,restaurant_guid),
 foreign key(business_id,restaurant_guid)
 references public.toast_location_mappings(business_id,restaurant_guid));
alter table public.toast_optional_sync_state enable row level security;
revoke all on public.toast_optional_sync_state from public,anon,authenticated;
grant select,insert,update,delete on public.toast_optional_sync_state to service_role;
alter table public.toast_catalog_facts add column
 price_known boolean generated always as (
  price_cents is not null and pricing_strategy in ('BASE_PRICE','MENU_SPECIFIC_PRICE')
 ) stored;

create table public.toast_job_directory(
 business_id uuid not null,restaurant_guid uuid not null,
 job_guid uuid not null,name text,deleted boolean not null default false,
 fetched_at timestamptz not null default now(),
 primary key(business_id,restaurant_guid,job_guid),
 foreign key(business_id,restaurant_guid)
 references public.toast_location_mappings(business_id,restaurant_guid));
alter table public.toast_job_directory enable row level security;
revoke all on public.toast_job_directory from public,anon,authenticated;
grant select,insert,update,delete on public.toast_job_directory to service_role;

-- A completed modified-date scan proves coverage for the business dates
-- actually within its fully paged window. Unknown is never silently zero.
create table public.toast_void_repull_coverage(
 business_id uuid not null,restaurant_guid uuid not null,business_date date not null,
 scanned_at timestamptz not null,last_window_end timestamptz not null,
 primary key(business_id,restaurant_guid,business_date),
 foreign key(business_id,restaurant_guid)
 references public.toast_location_mappings(business_id,restaurant_guid));
alter table public.toast_void_repull_coverage enable row level security;
revoke all on public.toast_void_repull_coverage from public,anon,authenticated;
grant select,insert,update,delete on public.toast_void_repull_coverage to service_role;

create function public.toast_commit_repull_scan_window(
 p_business_id uuid,p_restaurant_guid uuid,p_local_day date,p_days jsonb,
 p_window_start timestamptz,p_window_end timestamptz)
returns integer language plpgsql security definer set search_path=public as $window$
declare inserted integer;d date;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_window_end<=p_window_start or
  p_window_end-p_window_start>interval '30 days' or
  jsonb_typeof(p_days)<>'array' then raise exception 'invalid scan window';end if;
 -- The existing helper adds affected whole-day repulls and the scan marker.
 inserted:=public.toast_commit_repull_scan(p_business_id,p_restaurant_guid,
  p_local_day,p_days,p_window_end);
 -- A proven modified-date window covers all days fully contained in it.
 for d in select gs::date from generate_series(
  (p_window_start+interval '2 days')::date,
  (p_window_end-interval '2 days')::date,'1 day'::interval) gs loop
  if d<p_local_day then
   insert into public.toast_void_repull_coverage(
    business_id,restaurant_guid,business_date,scanned_at,last_window_end)
   values(p_business_id,p_restaurant_guid,d,now(),p_window_end)
   on conflict(business_id,restaurant_guid,business_date) do update
    set scanned_at=excluded.scanned_at,last_window_end=excluded.last_window_end;
  end if;
 end loop;
 return inserted;
end $window$;
revoke all on function public.toast_commit_repull_scan_window(
 uuid,uuid,date,jsonb,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.toast_commit_repull_scan_window(
 uuid,uuid,date,jsonb,timestamptz,timestamptz) to service_role;

-- Invalidate the EXACT void business date when a selection's void status,
-- amount, origin or attribution changes (which may differ from order date).
create function public.toast_invalidate_changed_void_day()
returns trigger language plpgsql security definer set search_path=public as $invalidate$
begin
 if tg_op='DELETE' or tg_op='UPDATE' then
  update public.daily_rollups set voids_status='unknown',voids_source=null
   where business_id=old.business_id and business_date=old.void_business_date;
 end if;
 if tg_op='INSERT' or tg_op='UPDATE' then
  update public.daily_rollups set voids_status='unknown',voids_source=null
   where business_id=new.business_id and business_date=new.void_business_date;
 end if;
 return null;
end $invalidate$;
create trigger toast_void_amount_changed
 after insert or delete or update of amount_cents,void_business_date,amount_basis,order_guid
 on public.toast_void_facts for each row execute function public.toast_invalidate_changed_void_day();
revoke all on function public.toast_invalidate_changed_void_day() from public,anon,authenticated;

-- Certification is all-or-nothing across ALL applicable locations.
create function public.toast_certify_day_voids(p_business_id uuid,p_date date)
returns boolean language plpgsql security definer set search_path=public as $cert$
declare eligible integer;complete_count integer;unknown_amounts integer;
 v_total bigint;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 perform pg_advisory_xact_lock(hashtextextended(
  'toast-void:'||p_business_id::text||':'||p_date::text,0));
 select count(*),
  count(*) filter(where s.import_state='imported'
   and s.unparsed_count=0 and s.coverage_complete
   and s.recon_state in ('matched','checked_internal')
   and c.scanned_at is not null)
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
end $cert$;
revoke all on function public.toast_certify_day_voids(uuid,date) from public,anon,authenticated;
grant execute on function public.toast_certify_day_voids(uuid,date) to service_role;

-- RMS Pro has separate read-only credentials, not the Standard API secret.
create table public.toast_analytics_credentials(
 business_id uuid primary key references public.businesses(id),
 management_group_guid uuid not null,api_origin text not null,
 client_id text not null,client_secret_enc text not null,
 bearer_token_enc text,bearer_expires_at timestamptz,
 verified_at timestamptz,last_error_category text,
 updated_at timestamptz not null default now());
alter table public.toast_analytics_credentials enable row level security;
revoke all on public.toast_analytics_credentials from public,anon,authenticated;
grant select,insert,update,delete on public.toast_analytics_credentials to service_role;

create table public.toast_analytics_jobs(
 business_id uuid not null,restaurant_guid uuid not null,business_date date not null,
 report_request_guid uuid,requested_at timestamptz,
 state text not null default 'pending' check(state in ('pending','available','missing')),
 checked_at timestamptz,last_error_category text,
 primary key(business_id,restaurant_guid,business_date),
 foreign key(business_id,restaurant_guid)
 references public.toast_location_mappings(business_id,restaurant_guid));
alter table public.toast_analytics_jobs enable row level security;
revoke all on public.toast_analytics_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.toast_analytics_jobs to service_role;

alter table public.toast_day_status
 add column analytics_state text check(analytics_state in ('pending','available','missing')),
 add column delta_discount_cents bigint,
 add column delta_refund_cents bigint,
 add column delta_void_orders bigint,
 add column void_amount_gap_cents bigint,
 add column last_recon_attempt_at timestamptz;

-- Rate limits are enforced across isolated Vercel invocations.
create table public.toast_analytics_rate_calls(
 id bigint generated always as identity primary key,
 business_id uuid not null references public.businesses(id),
 requested_at timestamptz not null default clock_timestamp(),
 kind text not null check(kind in ('post','get')));
alter table public.toast_analytics_rate_calls enable row level security;
revoke all on public.toast_analytics_rate_calls from public,anon,authenticated;
grant select,insert,update,delete on public.toast_analytics_rate_calls to service_role;
create index toast_era_requests_clock on public.toast_analytics_rate_calls(
 business_id,kind,requested_at);
create function public.toast_claim_era_request(p_business_id uuid,p_kind text)
returns boolean language plpgsql security definer set search_path=public as $era$
declare n integer;one_second integer;instant timestamptz:=clock_timestamp();
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_kind not in ('get','post') then raise exception 'invalid operation';end if;
 perform pg_advisory_xact_lock(hashtextextended('toast-era:'||p_business_id::text,0));
 select count(*),count(*) filter(where requested_at>instant-interval '1 second')
 into n,one_second from public.toast_analytics_rate_calls
 where business_id=p_business_id and kind=p_kind
  and requested_at>instant-interval '1 minute';
 if p_kind='get' and (n>=30 or one_second>=5) then return false;end if;
 if p_kind='post' and n>=10 then return false;end if;
 insert into public.toast_analytics_rate_calls(business_id,kind,requested_at)
 values(p_business_id,p_kind,instant);
 return true;
end $era$;
revoke all on function public.toast_claim_era_request(uuid,text) from public,anon,authenticated;
grant execute on function public.toast_claim_era_request(uuid,text) to service_role;

-- Health is only read by the service role. The stale threshold is 36 hours,
-- and a mismatch between Toast closeout zone and café reporting zone is visible.
create or replace view public.toast_sync_health_v with (security_invoker=true) as
select m.business_id,m.restaurant_guid,
 (select max(r.finished_at) from public.toast_sync_runs r
  where r.business_id=m.business_id and r.restaurant_guid=m.restaurant_guid
   and r.state='completed' and r.orders_unparsed=0 and r.invalid_days=0) as last_good_sync_at,
 (select min(s.business_date) from public.toast_day_status s
  where s.business_id=m.business_id and s.restaurant_guid=m.restaurant_guid
  and s.import_state='missing') as oldest_missing_day,
 (select count(*) from public.toast_day_status s
  where s.business_id=m.business_id and s.restaurant_guid=m.restaurant_guid
   and (s.import_state='failed' or s.recon_state in ('mismatch','owner_flagged'))) as days_needing_look,
 (select r.state from public.toast_sync_runs r
  where r.business_id=m.business_id and r.restaurant_guid=m.restaurant_guid
  order by r.started_at desc nulls last limit 1) as current_run_state,
 not exists(
  select 1 from public.toast_sync_runs r
   where r.business_id=m.business_id and r.restaurant_guid=m.restaurant_guid
   and r.state='completed' and r.orders_unparsed=0 and r.invalid_days=0
   and r.finished_at>=now()-interval '36 hours') as stale,
 case when m.toast_time_zone is not null
    and m.toast_time_zone is distinct from b.timezone
  then jsonb_build_object('time_zone_mismatch',true,
   'toast_time_zone',m.toast_time_zone,'reporting_time_zone',b.timezone)
  else '{}'::jsonb end as warnings
from public.toast_location_mappings m join public.businesses b on b.id=m.business_id;
revoke all on public.toast_sync_health_v from public,anon,authenticated;
grant select on public.toast_sync_health_v to service_role;

-- A changed Toast closeout configuration invalidates prior date attribution.
-- It must not leave stale business-wide sales or voids marked actual/complete.
create function public.toast_invalidate_on_closeout_change()
returns trigger language plpgsql security definer set search_path=public as $mapping$
declare first_day date;last_day date;
begin
 if old.toast_time_zone is not distinct from new.toast_time_zone
  and old.closeout_hour is not distinct from new.closeout_hour then return new;end if;
 select min(business_date),max(business_date) into first_day,last_day
 from public.toast_day_status
 where business_id=new.business_id and restaurant_guid=new.restaurant_guid
  and import_state='imported';
 if first_day is null then return new;end if;
 update public.toast_day_status set recon_state='pending',coverage_complete=false,
  last_error_category='closeout_changed'
 where business_id=new.business_id and restaurant_guid=new.restaurant_guid
  and business_date between first_day and last_day;
 update public.daily_rollups set sales_data_status='missing',
  voids_status='unknown',voids_source=null
 where business_id=new.business_id and business_date between first_day and last_day;
 -- A long history is queued as bounded chunks. Existing facts remain visible
 -- but cannot be certified until new Toast business-date grouping is pulled.
 for first_day in select gs::date from generate_series(first_day,last_day,
  interval '400 days') gs loop
  insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
   requested_from,requested_to,days_total)
  values(new.business_id,new.restaurant_guid,'backfill',first_day,
   least(first_day+399,last_day),least(first_day+399,last_day)-first_day+1)
  on conflict(business_id,restaurant_guid,requested_from,requested_to)
   where kind='backfill' and state in ('queued','running','paused_rate_limited')
  do nothing;
 end loop;
 return new;
end $mapping$;
create trigger toast_closeout_configuration_changed
 after update of toast_time_zone,closeout_hour on public.toast_location_mappings
 for each row execute function public.toast_invalidate_on_closeout_change();
revoke all on function public.toast_invalidate_on_closeout_change()
 from public,anon,authenticated;

-- A fresh imported business day invalidates an older ERA report ID.
-- This trigger runs inside the exact same transaction as toast_import_day.
create function public.toast_invalidate_era_report_on_import()
returns trigger language plpgsql security definer set search_path=public as $erareset$
begin
 if new.import_state='imported' then
  update public.toast_analytics_jobs set report_request_guid=null,
   requested_at=null,checked_at=null,state='pending',last_error_category=null
  where business_id=new.business_id and restaurant_guid=new.restaurant_guid
   and business_date=new.business_date;
 end if;
 return new;
end $erareset$;
create trigger toast_era_report_stale_after_import
 after insert or update of imported_at on public.toast_day_status
 for each row execute function public.toast_invalidate_era_report_on_import();
revoke all on function public.toast_invalidate_era_report_on_import()
 from public,anon,authenticated;
