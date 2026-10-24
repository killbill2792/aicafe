-- Toast PR3: owner evidence and recoverable import work; flags remain disabled.
-- Owner intent is independent of automated reconciliation evidence.
create table public.toast_day_owner_flags (
 business_id uuid not null, restaurant_guid uuid not null,
 business_date date not null, flagged_at timestamptz not null default now(),
 note text, cleared_at timestamptz,
 primary key(business_id,restaurant_guid,business_date),
 foreign key(business_id,restaurant_guid)
  references public.toast_location_mappings(business_id,restaurant_guid),
 check (note is null or length(note)<=2000)
);
alter table public.toast_day_owner_flags enable row level security;
revoke all on public.toast_day_owner_flags from public,anon,authenticated;
create policy "owner reads own flags" on public.toast_day_owner_flags
 for select to authenticated using (public.scheduling_is_owner(business_id));
grant select on public.toast_day_owner_flags to authenticated;
grant select,insert,update,delete on public.toast_day_owner_flags to service_role;

create table public.toast_first_import_check (
 business_id uuid primary key references public.businesses(id),
 shown_at timestamptz not null default now(),
 answered_at timestamptz,
 answer text check(answer in ('looks_right','something_off')),
 flagged_dates date[] not null default '{}'::date[],
 note text,
 check ((answer is null and answered_at is null) or
        (answer is not null and answered_at is not null)),
 check (cardinality(flagged_dates)<=100),
 check (note is null or length(note)<=2000)
);
alter table public.toast_first_import_check enable row level security;
revoke all on public.toast_first_import_check from public,anon,authenticated;
create policy "owner reads first check" on public.toast_first_import_check
 for select to authenticated using (public.scheduling_is_owner(business_id));
grant select on public.toast_first_import_check to authenticated;
grant select,insert,update,delete on public.toast_first_import_check to service_role;

-- Existing legacy owner_flagged rows came exclusively from automated paths.
alter table public.toast_day_status
 drop constraint if exists toast_day_status_recon_state_check;
update public.toast_day_status
 set recon_state=case when coalesce(warnings->>'analytics_timeout','') not in ('','0','false')
  then 'analytics_timeout' else 'coverage_invalid' end
 where recon_state='owner_flagged';
alter table public.toast_day_status
 add constraint toast_day_status_recon_state_check
 check (recon_state in ('pending','matched','mismatch','checked_internal',
                       'analytics_timeout','coverage_invalid'));

-- Keep failed historical run metadata; a new run resumes ONLY the unfinished dates.
alter table public.toast_sync_runs
 add column retry_run_id uuid references public.toast_sync_runs(id);
create index toast_retry_failed_run on public.toast_sync_runs
 (business_id,restaurant_guid,kind,state) where state='failed';

create function public.toast_requeue_failed(p_business_id uuid,p_restaurant_guid uuid)
returns integer language plpgsql security definer set search_path=public as $retry$
declare r public.toast_sync_runs%rowtype; v_new uuid; v_count integer:=0;
begin
 if auth.role()<>'service_role' then raise exception 'service role only'; end if;
 -- Location lock serializes competing owner/test retries and the queue_backfill RPC.
 perform 1 from public.toast_location_mappings
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid
 and verified_at is not null for update;
 if not found then raise exception 'unverified location'; end if;
 for r in select * from public.toast_sync_runs
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid
    and state='failed' and retry_run_id is null
    and kind in ('backfill','daily') for update loop
  if r.kind='backfill' and r.days_done<r.days_total then
    v_new:=public.toast_queue_backfill(p_business_id,p_restaurant_guid,
       r.requested_from+r.days_done,r.requested_to);
    update public.toast_sync_runs set retry_run_id=v_new where id=r.id;
    v_count:=v_count+1;
  elsif r.kind='daily' then
    update public.toast_sync_runs set state='queued',cursor='{}'::jsonb,
      days_done=0,resume_at=null,finished_at=null,started_at=null,
      last_error_category=null,invalid_days=0,orders_seen=0,orders_unparsed=0
    where id=r.id;
    delete from public.toast_day_pages where run_id=r.id;
    v_count:=v_count+1;
  end if;
 end loop;
 return v_count;
end $retry$;
revoke all on function public.toast_requeue_failed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.toast_requeue_failed(uuid,uuid) to service_role;

-- "Owner flagged" must never be a system state again. Preserve canonical rows
-- but mark an invalid coverage proof with its own distinct reason.
create or replace function public.toast_mark_day_failed(
 p_business_id uuid,p_restaurant_guid uuid,p_business_date date,p_run_id uuid,p_category text)
returns void language plpgsql security definer set search_path=public as $safefail$
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 perform public.toast_record_day_error(p_run_id,p_business_id,p_restaurant_guid,
  p_business_date,p_category,true,false);
 update public.toast_day_status set coverage_complete=false,
  recon_state='coverage_invalid',last_error_category=p_category
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and business_date=p_business_date and import_state='imported';
 update public.daily_rollups dr set sales_data_status='missing'
 where dr.business_id=p_business_id and dr.business_date=p_business_date
  and exists(select 1 from public.toast_day_status d
   where d.business_id=dr.business_id and d.business_date=dr.business_date
    and d.import_state='imported');
end $safefail$;

create or replace view public.toast_sync_health_v with (security_invoker=true) as
select m.business_id,m.restaurant_guid,
 (select max(r.finished_at) from public.toast_sync_runs r
  where r.business_id=m.business_id and r.restaurant_guid=m.restaurant_guid
   and r.state='completed' and r.orders_unparsed=0 and r.invalid_days=0) as last_good_sync_at,
 (select min(s.business_date) from public.toast_day_status s
  where s.business_id=m.business_id and s.restaurant_guid=m.restaurant_guid
   and s.import_state='missing') as oldest_missing_day,
 (select count(*) from (
  select s.business_date from public.toast_day_status s
   where s.business_id=m.business_id and s.restaurant_guid=m.restaurant_guid
    and (s.import_state='failed' or s.recon_state in
      ('mismatch','analytics_timeout','coverage_invalid'))
  union
  select f.business_date from public.toast_day_owner_flags f
   where f.business_id=m.business_id and f.restaurant_guid=m.restaurant_guid
    and f.cleared_at is null) dates) as days_needing_look,
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

-- Owner flags block void certification even when automated numbers match.
create or replace function public.toast_certify_day_voids(p_business_id uuid,p_date date)
returns boolean language plpgsql security definer set search_path=public as $cert$
declare eligible integer;complete_count integer;unknown_amounts integer;v_total bigint;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 perform pg_advisory_xact_lock(hashtextextended(
  'toast-void:'||p_business_id::text||':'||p_date::text,0));
 select count(*),
  count(*) filter(where s.import_state='imported'
   and s.unparsed_count=0 and s.coverage_complete
   and s.recon_state in ('matched','checked_internal')
   and c.scanned_at is not null
   and not exists(select 1 from public.toast_day_owner_flags f
    where f.business_id=m.business_id and f.restaurant_guid=m.restaurant_guid
     and f.business_date=p_date and f.cleared_at is null)
   and not exists(select 1 from public.toast_sync_runs pending
    where pending.business_id=m.business_id
     and pending.restaurant_guid=m.restaurant_guid
     and pending.kind='repull_modified'
     and pending.scan_local_day=c.scan_local_day
     and pending.state<>'completed'))
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


-- Keep the first answer, flags, and visibility guard in one transaction.
create function public.toast_answer_first_import_check(
 p_business_id uuid,p_answer text,p_days date[],p_note text)
returns void language plpgsql security definer set search_path=public as $answer$
declare d date; loc record; n integer;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_answer not in ('looks_right','something_off')
  or cardinality(p_days)>100 or length(coalesce(p_note,''))>2000
  or (p_answer='something_off' and cardinality(p_days)=0)
  or (p_answer='looks_right' and cardinality(p_days)<>0)
 then raise exception 'invalid answer';end if;
 select count(distinct business_date) into n from public.toast_day_status
 where business_id=p_business_id and import_state='imported' and coverage_complete;
 if n<7 then raise exception 'not ready';end if;
 insert into public.toast_first_import_check(business_id,answered_at,answer,flagged_dates,note)
 values(p_business_id,now(),p_answer,p_days,p_note)
 on conflict(business_id) do update set
 answered_at=excluded.answered_at,answer=excluded.answer,
 flagged_dates=excluded.flagged_dates,note=excluded.note
 where toast_first_import_check.answered_at is null;
 if not found then raise exception 'already answered';end if;
 foreach d in array p_days loop
  for loc in select distinct s.restaurant_guid from public.toast_day_status s
   where s.business_id=p_business_id and s.business_date=d
    and s.import_state='imported' and s.coverage_complete loop
   insert into public.toast_day_owner_flags(business_id,restaurant_guid,business_date,note)
   values(p_business_id,loc.restaurant_guid,d,p_note)
   on conflict(business_id,restaurant_guid,business_date) do update
   set flagged_at=now(),cleared_at=null,note=excluded.note;
  end loop;
  if not found then raise exception 'unimported flagged date';end if;
  perform public.toast_certify_day_voids(p_business_id,d);
 end loop;
end $answer$;
revoke all on function public.toast_answer_first_import_check(uuid,text,date[],text)
 from public,anon,authenticated;
grant execute on function public.toast_answer_first_import_check(uuid,text,date[],text) to service_role;


create function public.toast_set_day_owner_flag(
 p_business_id uuid,p_restaurant_guid uuid,p_date date,p_flag boolean,p_note text)
returns void language plpgsql security definer set search_path=public as $flag$
declare v_zone text;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if length(coalesce(p_note,''))>2000 then raise exception 'note too long';end if;
 select toast_time_zone into v_zone from public.toast_location_mappings
 where business_id=p_business_id and restaurant_guid=p_restaurant_guid
 and verified_at is not null for update;
 if not found or v_zone is null then raise exception 'unverified location';end if;
 if p_date>= (now() at time zone v_zone)::date then raise exception 'future day';end if;
 if p_flag then
  insert into public.toast_day_owner_flags(
   business_id,restaurant_guid,business_date,flagged_at,note,cleared_at)
  values(p_business_id,p_restaurant_guid,p_date,now(),p_note,null)
  on conflict(business_id,restaurant_guid,business_date) do update
  set flagged_at=excluded.flagged_at,note=excluded.note,cleared_at=null;
 else
  update public.toast_day_owner_flags set cleared_at=now()
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid
   and business_date=p_date and cleared_at is null;
 end if;
 perform public.toast_certify_day_voids(p_business_id,p_date);
end $flag$;
revoke all on function public.toast_set_day_owner_flag(uuid,uuid,date,boolean,text)
 from public,anon,authenticated;
grant execute on function public.toast_set_day_owner_flag(uuid,uuid,date,boolean,text) to service_role;
