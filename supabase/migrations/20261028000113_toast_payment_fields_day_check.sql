-- Prompt D Follow-up, applied manually after 112. All service-side owner
-- actions remain atomic; no old migrations are edited.
alter table public.toast_day_status
 add column if not exists owner_confirmed_at timestamptz;

-- Durable bounded labor-history checkpoint. A chunk is marked complete ONLY
-- after staging and canonical copy both commit; retries may safely replay it.
create table if not exists public.toast_labor_backfill_progress (
 business_id uuid not null,restaurant_guid uuid not null,
 next_at timestamptz not null,updated_at timestamptz not null default now(),
 primary key(business_id,restaurant_guid),
 foreign key(business_id,restaurant_guid)
 references public.toast_location_mappings(business_id,restaurant_guid)
);
alter table public.toast_labor_backfill_progress enable row level security;
revoke all on public.toast_labor_backfill_progress from public,anon,authenticated;
grant select,insert,update on public.toast_labor_backfill_progress to service_role;



-- Owner acknowledgement never overwrites independent Toast financial evidence.
-- Re-import invalidates only the old acknowledgement, not historical raw facts.
create or replace function public.toast_owner_confirmation_on_reimport()
returns trigger language plpgsql set search_path=public as $owner$
begin
 if new.imported_at is distinct from old.imported_at then
  new.owner_confirmed_at=null;
 end if;
 return new;
end $owner$;
drop trigger if exists toast_owner_confirmation_on_reimport on public.toast_day_status;
create trigger toast_owner_confirmation_on_reimport
 before update of imported_at on public.toast_day_status
 for each row execute function public.toast_owner_confirmation_on_reimport();

-- A re-pull is a NEW one-day repull_modified run. The old backfill RPC is for
-- growing the historical range and can return a progressed active run unchanged.
-- Scheduler runDue processes repull_modified via importToastBusinessDay,
-- the SAME path that commits toast_import_day and resets reconciliation.
create unique index if not exists toast_one_active_owner_repull
 on public.toast_sync_runs(business_id,restaurant_guid,requested_from,requested_to)
 where kind='repull_modified' and state in ('queued','running','paused_rate_limited');

create or replace function public.toast_queue_owner_repull(
 p_business_id uuid,p_restaurant_guid uuid,p_date date)
returns uuid language plpgsql security definer set search_path=public as $repull$
declare v_id uuid;v_zone text;
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 select toast_time_zone into v_zone from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid
  and verified_at is not null for share;
 if v_zone is null or p_date<'2015-12-02'::date or
  p_date >= (now() at time zone v_zone)::date
 then raise exception 'invalid repull day';end if;
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,
  requested_from,requested_to,days_total,cursor)
 values(p_business_id,p_restaurant_guid,'repull_modified',p_date,p_date,1,'{}'::jsonb)
 on conflict(business_id,restaurant_guid,requested_from,requested_to)
 where kind='repull_modified' and state in ('queued','running','paused_rate_limited')
 do nothing returning id into v_id;
 if v_id is null then
  select id into v_id from public.toast_sync_runs
   where business_id=p_business_id and restaurant_guid=p_restaurant_guid
    and kind='repull_modified' and requested_from=p_date and requested_to=p_date
    and state in ('queued','running','paused_rate_limited')
   order by id limit 1;
 end if;
 if v_id is null then raise exception 'unable to queue repull';end if;
 return v_id;
end $repull$;
revoke all on function public.toast_queue_owner_repull(uuid,uuid,date)
 from public,anon,authenticated;
grant execute on function public.toast_queue_owner_repull(uuid,uuid,date)
 to service_role;

-- Replaces the original first-import answer RPC with an owner acknowledgement
-- of exactly the latest seven complete dates, retaining audit evidence.
create or replace function public.toast_answer_first_import_check(
 p_business_id uuid,p_answer text,p_days date[],p_note text)
returns void language plpgsql security definer set search_path=public as $answer$
declare d date; loc record; n integer; v_compared date[];
begin
 if auth.role()<>'service_role' then raise exception 'service role only';end if;
 if p_answer not in ('looks_right','something_off') or
  cardinality(p_days)>100 or length(coalesce(p_note,''))>2000 or
  (p_answer='something_off' and cardinality(p_days)=0) or
  (p_answer='looks_right' and cardinality(p_days)<>0)
 then raise exception 'invalid answer';end if;
 select array_agg(day order by day desc) into v_compared from (
  select distinct s.business_date as day
  from public.toast_day_status s where s.business_id=p_business_id
   and public.toast_is_complete_business_day(p_business_id,s.business_date)
  order by day desc limit 7
 ) days;
 n:=coalesce(cardinality(v_compared),0);
 if n<7 then raise exception 'not ready';end if;
 insert into public.toast_first_import_check(business_id,answered_at,answer,flagged_dates,note)
 values(p_business_id,now(),p_answer,p_days,p_note)
 on conflict(business_id) do update set answered_at=excluded.answered_at,
 answer=excluded.answer,flagged_dates=excluded.flagged_dates,note=excluded.note
 where public.toast_first_import_check.answered_at is null;
 if not found then raise exception 'already answered';end if;
 if p_answer='looks_right' then
  update public.toast_day_status set owner_confirmed_at=now()
   where business_id=p_business_id and business_date=any(v_compared)
    and import_state='imported';
  update public.toast_day_owner_flags set cleared_at=now()
   where business_id=p_business_id and business_date=any(v_compared)
    and cleared_at is null;
 else
  foreach d in array p_days loop
   if not d=any(v_compared) or not public.toast_is_complete_business_day(p_business_id,d)
    then raise exception 'invalid flagged date';end if;
   for loc in select m.restaurant_guid from public.toast_location_mappings m
    where m.business_id=p_business_id and m.verified_at is not null
     and (m.toast_start_date is null or d>=m.toast_start_date) loop
    insert into public.toast_day_owner_flags(
      business_id,restaurant_guid,business_date,note)
    values(p_business_id,loc.restaurant_guid,d,p_note)
    on conflict(business_id,restaurant_guid,business_date) do update
    set flagged_at=now(),cleared_at=null,note=excluded.note;
   end loop;
   perform public.toast_certify_day_voids(p_business_id,d);
  end loop;
 end if;
end $answer$;
revoke all on function public.toast_answer_first_import_check(uuid,text,date[],text)
 from public,anon,authenticated;
grant execute on function public.toast_answer_first_import_check(uuid,text,date[],text)
 to service_role;

-- An owner-confirmed historical review is no longer a visible warning;
-- reopening on re-import is handled by the trigger above.
create or replace view public.toast_owner_attention_days_v with(security_invoker=true) as
 select business_id,restaurant_guid,business_date from public.toast_day_status
 where owner_confirmed_at is null and
 (import_state='failed' or recon_state in ('mismatch','coverage_invalid')
  or unparsed_count>0 or (last_error_category is not null and last_error_category not in
   ('analytics_timeout','closeout_changed')))
 union
 select f.business_id,f.restaurant_guid,f.business_date
 from public.toast_day_owner_flags f
 left join public.toast_day_status s
 on s.business_id=f.business_id and s.restaurant_guid=f.restaurant_guid
 and s.business_date=f.business_date
 where f.cleared_at is null and s.owner_confirmed_at is null
 union
 select e.business_id,e.restaurant_guid,e.business_date
 from public.toast_owner_summary_entries e
 left join public.toast_day_status s
 on s.business_id=e.business_id and s.restaurant_guid=e.restaurant_guid
 and s.business_date=e.business_date
 where e.comparison='owner_summary_mismatch' and s.owner_confirmed_at is null;
revoke all on public.toast_owner_attention_days_v from public,anon,authenticated;
grant select on public.toast_owner_attention_days_v to service_role;

-- Issue 9 already fixed by migration 101. Owner verification query:
-- select pg_get_constraintdef(oid) from pg_constraint
-- where conname='toast_sync_phase_errors_phase_check';
