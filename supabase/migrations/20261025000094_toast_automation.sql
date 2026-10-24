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
