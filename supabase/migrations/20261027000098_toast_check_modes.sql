-- PR H. Additive, replayable; renumber after E/F/G rebase before merge.
alter table public.toast_api_credentials
 add column if not exists toast_check_mode text not null default 'internal'
  check(toast_check_mode in ('official','internal')),
 add column if not exists mode_reason text not null default 'no_analytics_credentials'
  check(mode_reason in ('no_analytics_credentials','analytics_forbidden','analytics_auth_failed','analytics_timeout','ok')),
 add column if not exists mode_checked_at timestamptz;
alter table public.toast_location_mappings
 add column if not exists last_tick_started_at timestamptz,
 add column if not exists recheck_total integer not null default 0;
create index if not exists toast_fair_rotation on public.toast_location_mappings
 (last_tick_started_at asc nulls first,business_id,restaurant_guid) where verified_at is not null;
alter table public.toast_day_status
 add column if not exists internal_state text check(internal_state in ('matched','mismatch')),
 add column if not exists internal_reasons jsonb not null default '[]',
 add column if not exists paid_other_day integer not null default 0,
 add column if not exists rechecking_reason text,
 add column if not exists payment_repull_at timestamptz;
alter table public.toast_day_status drop constraint if exists toast_day_status_recon_state_check;
alter table public.toast_day_status add constraint toast_day_status_recon_state_check
 check(recon_state in ('pending','matched','mismatch','checked_internal','analytics_timeout','coverage_invalid'));
-- Re-run only unfinished checks. Never rewrite matched/mismatch evidence.
update public.toast_day_status d set recon_state='pending',last_recon_attempt_at=null
where recon_state='analytics_timeout' or (recon_state='pending' and not exists(
 select 1 from public.toast_analytics_jobs j where j.business_id=d.business_id
 and j.restaurant_guid=d.restaurant_guid and j.business_date=d.business_date));
-- The prior login-only verification cannot be used as proof of ERA access.
update public.toast_analytics_credentials set verified_at=null
where not exists(select 1 from public.toast_api_credentials c
 where c.business_id=toast_analytics_credentials.business_id and c.mode_reason='ok');

-- Serialize official-mode promotion against Analytics credential removal/rotation.
-- One database transaction owns verification, reactivation, and retirement of
-- suspended reports. Lock credentials in the same order as a downgrade.
create or replace function public.toast_enable_official_check(p_business_id uuid)
returns boolean language plpgsql security definer set search_path=public as $official$
declare was_internal boolean;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 select toast_check_mode='internal' into was_internal
 from public.toast_api_credentials where business_id=p_business_id for update;
 if not found then return false;end if;
 perform 1 from public.toast_analytics_credentials
 where business_id=p_business_id and verified_at is not null
  and last_error_category is null for share;
 if not found then return false;end if;
 update public.toast_api_credentials set toast_check_mode='official',
  mode_reason='ok',mode_checked_at=now() where business_id=p_business_id;

 -- When access was suspended, a report's old 48-hour timer is not fresh
 -- work. Invalidate ONLY affected imported-day reports before requeueing.
 -- This includes pending jobs whose day was set to 'missing' on a 403,
 -- and pending jobs left behind by a business-wide downgrade.
 delete from public.toast_analytics_jobs j
 using public.toast_day_status d
 where j.business_id=p_business_id and d.business_id=j.business_id
  and d.restaurant_guid=j.restaurant_guid and d.business_date=j.business_date
  and d.import_state='imported' and d.rechecking_reason is null
  and (d.analytics_state='missing' or
       (was_internal and d.analytics_state='pending') or
       (d.recon_state='checked_internal' and d.analytics_state is null));

 update public.toast_day_status d
 set analytics_state='pending',last_recon_attempt_at=null,
  last_error_category=case when d.last_error_category in
    ('authentication','missing_permissions','analytics_timeout')
    then null else d.last_error_category end
 where d.business_id=p_business_id and d.import_state='imported'
  and d.rechecking_reason is null
  and ((d.recon_state='checked_internal' and d.analytics_state is null)
       or d.analytics_state='missing'
       or (was_internal and d.analytics_state='pending'));
 return true;
end $official$;
revoke all on function public.toast_enable_official_check(uuid) from public,anon,authenticated;
grant execute on function public.toast_enable_official_check(uuid) to service_role;

-- Both direction changes are atomic and lock the API credential before
-- Analytics credentials, avoiding a partial or deadlocked fallback.
create or replace function public.toast_disable_official_check(
 p_business_id uuid,p_reason text,p_expected_verified_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public as $downgrade$
declare actual_verified_at timestamptz;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_reason not in ('no_analytics_credentials','analytics_forbidden',
  'analytics_auth_failed','analytics_timeout') then
  raise exception 'invalid check mode reason';end if;
 perform 1 from public.toast_api_credentials
 where business_id=p_business_id for update;
 if not found then return false;end if;
 select verified_at into actual_verified_at from public.toast_analytics_credentials
 where business_id=p_business_id for update;
 if actual_verified_at is distinct from p_expected_verified_at then
  return false;end if;
 update public.toast_api_credentials set toast_check_mode='internal',
  mode_reason=p_reason,mode_checked_at=now() where business_id=p_business_id;
 update public.toast_analytics_credentials set verified_at=null
 where business_id=p_business_id;
 return true;
end $downgrade$;
revoke all on function public.toast_disable_official_check(uuid,text,timestamptz)
 from public,anon,authenticated;
grant execute on function public.toast_disable_official_check(uuid,text,timestamptz) to service_role;

create table if not exists public.toast_owner_summary_entries(
 business_id uuid not null,restaurant_guid uuid not null,business_date date not null,
 net_sales_cents bigint not null,orders_count integer check(orders_count>=0),
 discounts_cents bigint,refunds_cents bigint,voids_count integer check(voids_count>=0),
 source text not null check(source in ('typed','photo','csv')),
 entered_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 tolerance_cents integer not null default 5 check(tolerance_cents between 0 and 100),
 comparison text check(comparison in ('owner_summary_match','owner_summary_mismatch')),
 delta_net_cents bigint,delta_orders integer,
 primary key(business_id,restaurant_guid,business_date),
 foreign key(business_id,restaurant_guid) references public.toast_location_mappings(business_id,restaurant_guid)
);
alter table public.toast_owner_summary_entries enable row level security;
revoke all on public.toast_owner_summary_entries from public,anon,authenticated;
grant select on public.toast_owner_summary_entries to authenticated;
grant select,insert,update,delete on public.toast_owner_summary_entries to service_role;
-- Use a secured member check rather than granting direct reads of memberships.
-- The function runs as the migration owner, but the identity comes from auth.uid().
create or replace function public.toast_is_business_member(p_business_id uuid)
returns boolean language sql stable security definer set search_path=public as $member$
 select auth.uid() is not null and exists(
  select 1 from public.memberships m where m.business_id=p_business_id and m.user_id=auth.uid()
 );
$member$;
revoke all on function public.toast_is_business_member(uuid) from public,anon;
grant execute on function public.toast_is_business_member(uuid) to authenticated,service_role;
drop policy if exists "members read summary" on public.toast_owner_summary_entries;
create policy "members read summary" on public.toast_owner_summary_entries for select to authenticated
 using(public.toast_is_business_member(business_id));
drop policy if exists "service select summary" on public.toast_owner_summary_entries;
create policy "service select summary" on public.toast_owner_summary_entries for select to service_role using(true);
drop policy if exists "service insert summary" on public.toast_owner_summary_entries;
create policy "service insert summary" on public.toast_owner_summary_entries for insert to service_role with check(true);
drop policy if exists "service update summary" on public.toast_owner_summary_entries;
create policy "service update summary" on public.toast_owner_summary_entries for update to service_role using(true) with check(true);
drop policy if exists "service delete summary" on public.toast_owner_summary_entries;
create policy "service delete summary" on public.toast_owner_summary_entries for delete to service_role using(true);

-- Same day lock is taken by both the owner writer and imported-day comparison trigger.
create or replace function public.toast_refresh_owner_summary(p_business_id uuid,p_guid uuid,p_date date)
returns void language plpgsql security definer set search_path=public as $values$
declare s public.toast_day_status%rowtype;
begin
 select * into s from public.toast_day_status where business_id=p_business_id
 and restaurant_guid=p_guid and business_date=p_date for update;
 if not found then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('toast-summary:'||p_business_id::text||':'||p_guid::text||':'||p_date::text,0));
 update public.toast_owner_summary_entries e set
  comparison=case when s.import_state<>'imported' then null
   when abs(e.net_sales_cents-s.net_sales_cents)<=e.tolerance_cents
    and (e.orders_count is null or e.orders_count=s.order_count)
    and (e.discounts_cents is null or abs(e.discounts_cents-s.discounts_cents)<=e.tolerance_cents)
    and (e.refunds_cents is null or abs(e.refunds_cents-s.refunds_cents)<=e.tolerance_cents)
    and (e.voids_count is null or e.voids_count=(select count(distinct v.order_guid)
     from public.toast_void_facts v join public.toast_location_mappings m
      on m.business_id=v.business_id and m.location_id=v.location_id
     where m.business_id=s.business_id and m.restaurant_guid=s.restaurant_guid
      and v.order_business_date=s.business_date))
    then 'owner_summary_match' else 'owner_summary_mismatch' end,
  delta_net_cents=e.net_sales_cents-s.net_sales_cents,
  delta_orders=e.orders_count-s.order_count
 where e.business_id=s.business_id and e.restaurant_guid=s.restaurant_guid and e.business_date=s.business_date;
end $values$;
revoke all on function public.toast_refresh_owner_summary(uuid,uuid,date) from public,anon,authenticated;
create or replace function public.toast_compare_owner_summary() returns trigger
language plpgsql security definer set search_path=public as $compare$
begin
 perform public.toast_refresh_owner_summary(new.business_id,new.restaurant_guid,new.business_date);
 return new;
end $compare$;
revoke all on function public.toast_compare_owner_summary() from public,anon,authenticated;
drop trigger if exists toast_compare_summary_after_import on public.toast_day_status;
create trigger toast_compare_summary_after_import after insert or update of imported_at
 on public.toast_day_status for each row execute function public.toast_compare_owner_summary();

create or replace function public.toast_save_owner_summary(p_business_id uuid,p_restaurant_guid uuid,
 p_date date,p_net bigint,p_orders integer,p_discounts bigint,p_refunds bigint,p_voids integer,
 p_source text,p_tolerance integer default 5) returns void
language plpgsql security definer set search_path=public as $owner$
declare s public.toast_day_status%rowtype; v_zone text;
begin
 if auth.uid() is null or not public.scheduling_is_owner(p_business_id)
  or not exists(select 1 from public.businesses where id=p_business_id and not is_demo)
 then raise exception 'owner only';end if;
 if p_net is null or abs(p_net)>9007199254740991 or p_source not in ('typed','photo','csv')
  or p_source is null or p_orders<0 or p_voids<0
  or abs(coalesce(p_discounts,0))>9007199254740991 or abs(coalesce(p_refunds,0))>9007199254740991 or p_tolerance is null or p_tolerance not between 0 and 100
 then raise exception 'invalid summary';end if;
 select toast_time_zone into v_zone from public.toast_location_mappings
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null;
 if not found or p_date is null or p_date>=(now() at time zone v_zone)::date then raise exception 'invalid day';end if;
 -- Lock the status row BEFORE the advisory lock, matching the import trigger lock order.
 select * into s from public.toast_day_status where business_id=p_business_id
 and restaurant_guid=p_restaurant_guid and business_date=p_date for update;
 if not found or s.import_state<>'imported' then raise exception 'day not imported';end if;
 perform pg_advisory_xact_lock(hashtextextended('toast-summary:'||p_business_id::text||':'||p_restaurant_guid::text||':'||p_date::text,0));
 insert into public.toast_owner_summary_entries(business_id,restaurant_guid,business_date,
 net_sales_cents,orders_count,discounts_cents,refunds_cents,voids_count,source,entered_by,tolerance_cents)
 values(p_business_id,p_restaurant_guid,p_date,p_net,p_orders,p_discounts,p_refunds,p_voids,p_source,auth.uid(),p_tolerance)
 on conflict(business_id,restaurant_guid,business_date) do update set
 net_sales_cents=excluded.net_sales_cents,orders_count=excluded.orders_count,
 discounts_cents=excluded.discounts_cents,refunds_cents=excluded.refunds_cents,voids_count=excluded.voids_count,
 source=excluded.source,entered_by=excluded.entered_by,updated_at=now(),tolerance_cents=excluded.tolerance_cents;
 -- Re-evaluate against the locked current import, without replacing owner values.
 perform public.toast_refresh_owner_summary(p_business_id,p_restaurant_guid,p_date);
end $owner$;
revoke all on function public.toast_save_owner_summary(uuid,uuid,date,bigint,integer,bigint,bigint,integer,text,integer) from public,anon;
grant execute on function public.toast_save_owner_summary(uuid,uuid,date,bigint,integer,bigint,bigint,integer,text,integer) to authenticated;

-- One attention predicate for page, badge and chat; timeout is informational after fallback.
create or replace view public.toast_owner_attention_days_v with(security_invoker=true) as
select business_id,restaurant_guid,business_date from public.toast_day_status
 where import_state='failed' or recon_state in ('mismatch','coverage_invalid') or unparsed_count>0
 or (last_error_category is not null and last_error_category not in
 ('analytics_timeout','closeout_changed'))
union select business_id,restaurant_guid,business_date from public.toast_day_owner_flags where cleared_at is null
union select business_id,restaurant_guid,business_date from public.toast_owner_summary_entries
 where comparison='owner_summary_mismatch';
revoke all on public.toast_owner_attention_days_v from public,anon,authenticated;
grant select on public.toast_owner_attention_days_v to service_role;
create or replace view public.toast_owner_attention_counts_v with(security_invoker=true) as
select m.business_id,count(distinct d.business_date)::integer as days_needing_look
from (select distinct business_id from public.toast_location_mappings) m
left join public.toast_owner_attention_days_v d on d.business_id=m.business_id group by m.business_id;
revoke all on public.toast_owner_attention_counts_v from public,anon,authenticated;
grant select on public.toast_owner_attention_counts_v to service_role;

create or replace view public.toast_sync_health_v with(security_invoker=true) as
select m.business_id,m.restaurant_guid,
 (select max(r.finished_at) from public.toast_sync_runs r where r.business_id=m.business_id
 and r.restaurant_guid=m.restaurant_guid and r.state='completed') as last_good_sync_at,
 (select min(s.business_date) from public.toast_day_status s where s.business_id=m.business_id
 and s.restaurant_guid=m.restaurant_guid and s.import_state='missing') as oldest_missing_day,
 (select count(*) from public.toast_owner_attention_days_v a where a.business_id=m.business_id
 and a.restaurant_guid=m.restaurant_guid) as days_needing_look,
 (select r.state from public.toast_sync_runs r where r.business_id=m.business_id
 and r.restaurant_guid=m.restaurant_guid order by r.started_at desc nulls last limit 1) as current_run_state,
 not exists(select 1 from public.toast_sync_runs r where r.business_id=m.business_id
 and r.restaurant_guid=m.restaurant_guid and r.state='completed' and r.finished_at>=now()-interval '36 hours') as stale,
 case when m.toast_time_zone is not null and m.toast_time_zone is distinct from b.timezone
 then jsonb_build_object('time_zone_mismatch',true,'toast_time_zone',m.toast_time_zone,'reporting_time_zone',b.timezone)
 else '{}'::jsonb end as warnings,
 (select count(*)::integer from public.toast_day_status s where s.business_id=m.business_id
 and s.restaurant_guid=m.restaurant_guid and s.unparsed_count>0) as days_with_unreadable_orders
from public.toast_location_mappings m join public.businesses b on b.id=m.business_id;
revoke all on public.toast_sync_health_v from public,anon,authenticated;
grant select on public.toast_sync_health_v to service_role;

alter table public.toast_sync_runs drop constraint if exists toast_sync_runs_state_check;
alter table public.toast_sync_runs add constraint toast_sync_runs_state_check
 check(state in ('queued','running','paused_rate_limited','completed','failed','cancelled'));
create or replace function public.toast_invalidate_on_closeout_change() returns trigger
language plpgsql security definer set search_path=public as $closeout$
declare d record; recovery_id uuid; recovery_dates date[];
begin
 if old.toast_time_zone is not distinct from new.toast_time_zone and
 coalesce(old.closeout_hour,0)=coalesce(new.closeout_hour,0) then return new;end if;
 update public.toast_day_status set
 recon_state=case when recon_state='mismatch' and recon_source='toast_analytics'
  then 'mismatch' else 'pending' end,last_recon_attempt_at=null,
 rechecking_reason='closeout_changed',last_error_category=case when last_error_category='closeout_changed' then null else last_error_category end
 where business_id=new.business_id and restaurant_guid=new.restaurant_guid and import_state='imported';
 update public.toast_location_mappings set recheck_total=(select count(*) from public.toast_day_status
 where business_id=new.business_id and restaurant_guid=new.restaurant_guid and rechecking_reason='closeout_changed')
 where business_id=new.business_id and restaurant_guid=new.restaurant_guid;
 -- Invalidating closeout coverage also invalidates its certified void totals.
 -- Imported sales and owner history remain visible; unknown is not zero.
 update public.daily_rollups set voids_status='unknown',voids_source=null
 where business_id=new.business_id and voids_source='toast'
  and business_date in (
   select s.business_date from public.toast_day_status s
    where s.business_id=new.business_id and s.restaurant_guid=new.restaurant_guid
     and s.import_state='imported'
   union select f.void_business_date from public.toast_void_facts f
    where f.business_id=new.business_id and f.location_id=new.location_id
  );
 delete from public.toast_void_repull_coverage where business_id=new.business_id and restaurant_guid=new.restaurant_guid;
 select array_agg(distinct dates.business_date) into recovery_dates from (
  select business_date from public.toast_day_status where business_id=new.business_id
   and restaurant_guid=new.restaurant_guid and import_state='imported'
  union select gs::date from public.toast_sync_runs r cross join lateral
   generate_series(r.requested_from::timestamp,r.requested_to::timestamp,interval '1 day') gs
   where r.business_id=new.business_id and r.restaurant_guid=new.restaurant_guid
   and r.state in ('queued','running','paused_rate_limited')
 ) dates;
 -- Old staged pages belong to the old closeout definition. Supersede their runs,
 -- preserving the audit trail, then queue bounded one-day jobs newest first.
 delete from public.toast_day_pages p using public.toast_sync_runs r
 where p.run_id=r.id and r.business_id=new.business_id and r.restaurant_guid=new.restaurant_guid
 and r.state in ('queued','running','paused_rate_limited');
 update public.toast_sync_runs set state='cancelled',finished_at=now()
 where business_id=new.business_id and restaurant_guid=new.restaurant_guid
 and state in ('queued','running','paused_rate_limited');
 for d in select unnest(recovery_dates) as business_date order by business_date desc loop
  insert into public.toast_sync_runs(business_id,restaurant_guid,kind,requested_from,requested_to,days_total,cursor)
  values(new.business_id,new.restaurant_guid,'backfill',d.business_date,d.business_date,1,'{}')
  on conflict(business_id,restaurant_guid,requested_from,requested_to)
  where kind='backfill' and state in ('queued','running','paused_rate_limited') do update set
  state='queued',days_done=0,cursor='{}',resume_at=null,started_at=null,finished_at=null
  returning id into recovery_id;
  delete from public.toast_day_pages where run_id=recovery_id;
 end loop;
 return new;
end $closeout$;
create or replace function public.toast_clear_recheck_after_import() returns trigger
language plpgsql set search_path=public as $clear$
begin
 if new.import_state='imported' then
  -- An import invalidates both internal proof and ALL external evidence from
  -- the previous snapshot. An old ERA report must not match a new import.
  new.rechecking_reason=null;
  -- The PR1 importer must remain fail-closed for missing/unparsed money.
  -- A new import discards the OLD reconciliation, not the NEW import's
  -- source-incompleteness verdict.
  new.recon_state=case when new.unparsed_count>0
   or coalesce((new.warnings->>'missing_check_amount')::integer,0)>0
   or coalesce((new.warnings->>'missing_deferred_price')::integer,0)>0
   or coalesce((new.warnings->>'missing_refund_amount')::integer,0)>0
   then 'mismatch' else 'pending' end;
  new.internal_state=null;
  new.internal_reasons='[]';new.paid_other_day=0;
  -- An import invalidates its proof, but must NOT restart an unresolved
  -- cross-day payment recovery timer. That deadline belongs to the payment
  -- discrepancy and survives repeated recovery imports until a verdict.
  new.analytics_state=null;
  new.recon_source=null;new.reconciled_at=null;new.last_recon_attempt_at=null;
  new.toast_net_sales_cents=null;new.toast_orders_count=null;
  new.toast_discount_cents=null;new.toast_refund_cents=null;
  new.delta_net_cents=null;new.delta_orders=null;
  new.delta_discount_cents=null;new.delta_refund_cents=null;
  new.delta_void_orders=null;new.void_amount_gap_cents=null;
  new.last_error_category=null;
  new.warnings=coalesce(new.warnings,'{}'::jsonb)-
   'reconciliation_mismatch'-'source_incomplete'-'analytics_timeout';
 end if;return new;
end $clear$;
revoke all on function public.toast_clear_recheck_after_import() from public,anon,authenticated;
drop trigger if exists toast_clear_recheck on public.toast_day_status;
create trigger toast_clear_recheck before update of imported_at on public.toast_day_status
for each row execute function public.toast_clear_recheck_after_import();

-- Discard an ERA report tied to the replaced order snapshot. The new day
-- must request fresh official evidence; the previous GUID is not reusable.
create or replace function public.toast_expire_era_job_after_import() returns trigger
language plpgsql security definer set search_path=public as $era_reset$
begin
 if new.import_state='imported' then
  delete from public.toast_analytics_jobs where business_id=new.business_id
   and restaurant_guid=new.restaurant_guid and business_date=new.business_date;
 end if;
 return null;
end $era_reset$;
revoke all on function public.toast_expire_era_job_after_import() from public,anon,authenticated;
drop trigger if exists toast_expire_era_report_after_import on public.toast_day_status;
create trigger toast_expire_era_report_after_import
 after insert or update of imported_at on public.toast_day_status
 for each row execute function public.toast_expire_era_job_after_import();

-- A closeout change cancels old runs. Revalidate and SHARE-lock the exact
-- run at commit time, so an in-flight old-definition import cannot overwrite
-- already reclassified historical sales after its run was canceled.
create or replace function public.toast_reject_superseded_import() returns trigger
language plpgsql security definer set search_path=public as $run_guard$
begin
 if new.import_state='imported' and new.last_import_run_id is not null then
  perform 1 from public.toast_sync_runs r
  where r.id=new.last_import_run_id and r.business_id=new.business_id
    and r.restaurant_guid=new.restaurant_guid
    and r.state in ('queued','running','paused_rate_limited')
  for share;
  if not found then raise exception 'Toast import run was superseded';end if;
 end if;
 return new;
end $run_guard$;
revoke all on function public.toast_reject_superseded_import() from public,anon,authenticated;
drop trigger if exists toast_guard_import_run on public.toast_day_status;
create trigger toast_guard_import_run before insert or update of imported_at
 on public.toast_day_status for each row execute function public.toast_reject_superseded_import();

-- Operational budget is service-role only. Hash never exposes a client ID.
create table if not exists public.toast_client_budgets(
 client_hash text primary key check(length(client_hash)=64),
 calls timestamptz[] not null default '{}',blocked_until timestamptz
);
alter table public.toast_client_budgets enable row level security;
revoke all on public.toast_client_budgets from public,anon,authenticated;
grant select,insert,update,delete on public.toast_client_budgets to service_role;
drop policy if exists "service select budget" on public.toast_client_budgets;
create policy "service select budget" on public.toast_client_budgets for select to service_role using(true);
drop policy if exists "service insert budget" on public.toast_client_budgets;
create policy "service insert budget" on public.toast_client_budgets for insert to service_role with check(true);
drop policy if exists "service update budget" on public.toast_client_budgets;
create policy "service update budget" on public.toast_client_budgets for update to service_role using(true) with check(true);
drop policy if exists "service delete budget" on public.toast_client_budgets;
create policy "service delete budget" on public.toast_client_budgets for delete to service_role using(true);
create or replace function public.toast_claim_client_budget(p_hash text,p_block_until timestamptz default null)
returns timestamptz language plpgsql security definer set search_path=public as $budget$
declare b public.toast_client_budgets%rowtype; recent integer; v_now timestamptz:=clock_timestamp();
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 insert into public.toast_client_budgets(client_hash) values(p_hash) on conflict do nothing;
 select * into b from public.toast_client_budgets where client_hash=p_hash for update;
 if p_block_until is not null then
  update public.toast_client_budgets set blocked_until=greatest(blocked_until,p_block_until) where client_hash=p_hash;
  return p_block_until;
 end if;
 if b.blocked_until>v_now then return b.blocked_until;end if;
 select coalesce(array_agg(t order by t),'{}') into b.calls from unnest(b.calls) t where t>v_now-interval '15 minutes';
 if cardinality(b.calls)>=10000 then return b.calls[1]+interval '15 minutes';end if;
 select count(*) into recent from unnest(b.calls) t where t>v_now-interval '1 second';
 if recent>=20 then return (select min(t)+interval '1 second' from unnest(b.calls) t where t>v_now-interval '1 second');end if;
 update public.toast_client_budgets set calls=array_append(b.calls,v_now) where client_hash=p_hash;
 return null;
end $budget$;
revoke all on function public.toast_claim_client_budget(text,timestamptz) from public,anon,authenticated;
grant execute on function public.toast_claim_client_budget(text,timestamptz) to service_role;

-- Safe evidence reader for ALL members; operational tables remain inaccessible.
create or replace function public.toast_check_evidence(p_business_id uuid) returns jsonb
language plpgsql security definer set search_path=public as $evidence$
begin
 if auth.role()<>'service_role' and (auth.uid() is null or not exists(select 1 from public.memberships
 where business_id=p_business_id and user_id=auth.uid())) then raise exception 'not authorized';end if;
 return (select jsonb_build_object('mode',c.toast_check_mode,'reason',c.mode_reason,
 'compared',(select count(distinct business_date) from public.toast_owner_summary_entries where business_id=p_business_id and comparison is not null),
 'matched',(select count(*) from (select business_date from public.toast_owner_summary_entries
  where business_id=p_business_id group by business_date having bool_and(comparison='owner_summary_match')) matched_dates))
 from public.toast_api_credentials c where c.business_id=p_business_id);
end $evidence$;
revoke all on function public.toast_check_evidence(uuid) from public,anon;
grant execute on function public.toast_check_evidence(uuid) to authenticated,service_role;
create or replace function public.toast_attention_days(p_business_id uuid,p_from date,p_to date)
returns table(business_date date,restaurant_guid uuid)
language plpgsql security definer set search_path=public as $attention$
begin
 if auth.role()<>'service_role' and (auth.uid() is null or not exists(select 1 from public.memberships
 where business_id=p_business_id and user_id=auth.uid())) then raise exception 'not authorized';end if;
 return query select a.business_date,a.restaurant_guid from public.toast_owner_attention_days_v a
 where a.business_id=p_business_id and a.business_date between p_from and p_to
 order by a.business_date,a.restaurant_guid;
end $attention$;
revoke all on function public.toast_attention_days(uuid,date,date) from public,anon;
grant execute on function public.toast_attention_days(uuid,date,date) to authenticated,service_role;

create table if not exists public.toast_internal_check_cache(
 business_id uuid not null,restaurant_guid uuid not null,business_date date not null,
 snapshot_tag text not null,cache_key text not null,payload jsonb not null,
 created_at timestamptz not null default now(),
 primary key(business_id,restaurant_guid,business_date,snapshot_tag,cache_key),
 foreign key(business_id,restaurant_guid) references public.toast_location_mappings(business_id,restaurant_guid)
);
alter table public.toast_internal_check_cache enable row level security;
revoke all on public.toast_internal_check_cache from public,anon,authenticated;
grant select,insert,update,delete on public.toast_internal_check_cache to service_role;
drop policy if exists "service select proof" on public.toast_internal_check_cache;
create policy "service select proof" on public.toast_internal_check_cache for select to service_role using(true);
drop policy if exists "service insert proof" on public.toast_internal_check_cache;
create policy "service insert proof" on public.toast_internal_check_cache for insert to service_role with check(true);
drop policy if exists "service update proof" on public.toast_internal_check_cache;
create policy "service update proof" on public.toast_internal_check_cache for update to service_role using(true) with check(true);
drop policy if exists "service delete proof" on public.toast_internal_check_cache;
create policy "service delete proof" on public.toast_internal_check_cache for delete to service_role using(true);

create or replace function public.toast_clear_internal_check_cache() returns trigger
language plpgsql security definer set search_path=public as $cache$
begin
 delete from public.toast_internal_check_cache where business_id=new.business_id
 and restaurant_guid=new.restaurant_guid and business_date=new.business_date;
 return new;
end $cache$;
revoke all on function public.toast_clear_internal_check_cache() from public,anon,authenticated;
drop trigger if exists toast_clear_internal_proof_after_import on public.toast_day_status;
create trigger toast_clear_internal_proof_after_import after insert or update of imported_at
on public.toast_day_status for each row execute function public.toast_clear_internal_check_cache();

-- Durable, per-page modified-order scan checkpoints. One scan can span multiple
-- 60s ticks; only the last terminal page certifies complete window coverage.
alter table public.toast_repull_scan_state
 add column if not exists scan_local_day date,
 add column if not exists scan_start timestamptz,
 add column if not exists scan_end timestamptz,
 add column if not exists scan_window_start timestamptz,
 add column if not exists scan_page integer;

create or replace function public.toast_checkpoint_repull_scan_page(
 p_business_id uuid,p_restaurant_guid uuid,p_local_day date,
 p_scan_start timestamptz,p_scan_end timestamptz,
 p_window_start timestamptz,p_window_end timestamptz,
 p_page integer,p_last_page boolean,p_days jsonb)
returns boolean language plpgsql security definer set search_path=public as $checkpoint$
declare v_state public.toast_repull_scan_state%rowtype;
 v_day date;v_added boolean;v_zone text;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_scan_start is null or p_scan_end is null or
  p_scan_end<=p_scan_start or p_scan_end-p_scan_start>interval '30 days' or
  p_window_start<p_scan_start or p_window_start>=p_scan_end or
  p_window_end<>least(p_scan_end,p_window_start+interval '7 days') or
  mod(extract(epoch from p_window_start-p_scan_start)::bigint,604800)<>0 or
  p_page not between 1 and 300 or p_last_page is null or
  jsonb_typeof(p_days)<>'array' or jsonb_array_length(p_days)>100 or
  (not p_last_page and p_page=300) then
  raise exception 'invalid modified scan page';end if;
 select toast_time_zone into v_zone from public.toast_location_mappings
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid
 and verified_at is not null for share;
 if v_zone is null then raise exception 'unverified restaurant';end if;
 insert into public.toast_repull_scan_state(business_id,restaurant_guid)
 values(p_business_id,p_restaurant_guid) on conflict do nothing;
 select * into v_state from public.toast_repull_scan_state
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid for update;
 if v_state.scan_local_day is null then
  if p_page<>1 or p_window_start<>p_scan_start or
   v_state.last_local_day>=p_local_day then
   raise exception 'invalid scan restart';end if;
  update public.toast_repull_scan_state set
   scan_local_day=p_local_day,scan_start=p_scan_start,
   scan_end=p_scan_end,scan_window_start=p_window_start,scan_page=1
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 elsif v_state.scan_local_day is distinct from p_local_day or
  v_state.scan_start is distinct from p_scan_start or
  v_state.scan_end is distinct from p_scan_end or
  v_state.scan_window_start is distinct from p_window_start or
  v_state.scan_page is distinct from p_page then
  raise exception 'stale modified scan checkpoint';end if;

 for v_day in select distinct value::date from jsonb_array_elements_text(p_days) loop
  if v_day<'2015-12-02'::date or v_day>=p_local_day then
   raise exception 'invalid modified order day';end if;
  insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
   requested_from,requested_to,scan_local_day,days_total)
  values(p_business_id,p_restaurant_guid,'repull_modified',v_day,v_day,p_local_day,1)
  on conflict(business_id,restaurant_guid,requested_from,scan_local_day)
   where kind='repull_modified' do nothing;
  v_added:=found;
  if v_added then
   update public.toast_day_status set recon_state='pending',last_recon_attempt_at=null
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid
    and business_date=v_day and import_state='imported';
   update public.daily_rollups set voids_status='unknown',voids_source=null
   where business_id=p_business_id and (business_date=v_day or business_date in(
    select f.void_business_date from public.toast_void_facts f
    where f.business_id=p_business_id and f.order_business_date=v_day));
  end if;
 end loop;

 if p_last_page and p_window_end=p_scan_end then
  -- Retain the historical certification contract, without repeating per-page
  -- jobs. This RPC atomically stamps the completed scan and covered void days.
  perform public.toast_commit_repull_scan_window(p_business_id,
   p_restaurant_guid,p_local_day,'[]'::jsonb,p_scan_start,p_scan_end);
  update public.toast_repull_scan_state set scan_local_day=null,scan_start=null,
   scan_end=null,scan_window_start=null,scan_page=null
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 elsif p_last_page then
  update public.toast_repull_scan_state set scan_window_start=p_window_end,
   scan_page=1 where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 else
  update public.toast_repull_scan_state set scan_page=p_page+1
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid;
 end if;
 return true;
end $checkpoint$;
revoke all on function public.toast_checkpoint_repull_scan_page(
 uuid,uuid,date,timestamptz,timestamptz,timestamptz,timestamptz,integer,boolean,jsonb)
 from public,anon,authenticated;
grant execute on function public.toast_checkpoint_repull_scan_page(
 uuid,uuid,date,timestamptz,timestamptz,timestamptz,timestamptz,integer,boolean,jsonb)
 to service_role;
