-- Diagnostics are isolated from the scheduled sync lease and its RLS policies.
alter table public.toast_raw_samples add column if not exists doc_url text;
alter table public.toast_raw_samples add column if not exists error_code text;
alter table public.toast_raw_samples add column if not exists error_message text;
alter table public.toast_raw_samples add column if not exists page_number integer;
alter table public.toast_raw_samples add column if not exists capture_id uuid;
alter table public.toast_raw_samples add column if not exists identifier_counts jsonb not null default '{}'::jsonb;
create index if not exists toast_raw_samples_capture_id_idx
 on public.toast_raw_samples (business_id,restaurant_guid,business_date,endpoint,capture_id);

create table if not exists public.toast_raw_sample_leases (
 business_id uuid not null references public.businesses(id) on delete cascade,
 restaurant_guid uuid not null,
 nonce uuid,
 lease_until timestamptz,
 primary key (business_id,restaurant_guid)
);
alter table public.toast_raw_sample_leases enable row level security;
revoke all on public.toast_raw_sample_leases from public,anon,authenticated;
grant select,insert,update,delete on public.toast_raw_sample_leases to service_role;

create or replace function public.toast_acquire_raw_sample_lease(
 p_business_id uuid,p_restaurant_guid uuid,p_seconds integer default 290
) returns uuid language plpgsql security definer set search_path=public as $fn$
declare n uuid:=gen_random_uuid(); acquired uuid;
begin
 if auth.role()<>'service_role' or p_seconds not between 241 and 300 then raise exception 'not allowed'; end if;
 insert into public.toast_raw_sample_leases(business_id,restaurant_guid,nonce,lease_until)
 select p_business_id,p_restaurant_guid,n,clock_timestamp()+make_interval(secs=>p_seconds)
 where exists(select 1 from public.toast_location_mappings
  where business_id=p_business_id and restaurant_guid=p_restaurant_guid and verified_at is not null)
 on conflict(business_id,restaurant_guid) do update
 set nonce=excluded.nonce,lease_until=excluded.lease_until
 where toast_raw_sample_leases.lease_until is null
   or toast_raw_sample_leases.lease_until<clock_timestamp()
 returning nonce into acquired;
 return acquired;
end $fn$;
revoke all on function public.toast_acquire_raw_sample_lease(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.toast_acquire_raw_sample_lease(uuid,uuid,integer) to service_role;

create or replace function public.toast_renew_raw_sample_lease(p_nonce uuid,p_seconds integer default 290)
returns boolean language plpgsql security definer set search_path=public as $fn$
begin
 if auth.role()<>'service_role' or p_seconds not between 241 and 300 then raise exception 'not allowed'; end if;
 update public.toast_raw_sample_leases set lease_until=clock_timestamp()+make_interval(secs=>p_seconds)
 where nonce=p_nonce and lease_until>clock_timestamp();
 return found;
end $fn$;
revoke all on function public.toast_renew_raw_sample_lease(uuid,integer) from public,anon,authenticated;
grant execute on function public.toast_renew_raw_sample_lease(uuid,integer) to service_role;

create or replace function public.toast_release_raw_sample_lease(p_nonce uuid)
returns boolean language plpgsql security definer set search_path=public as $fn$
begin
 if auth.role()<>'service_role' then raise exception 'not allowed'; end if;
 update public.toast_raw_sample_leases set nonce=null,lease_until=null where nonce=p_nonce;
 return found;
end $fn$;
revoke all on function public.toast_release_raw_sample_lease(uuid) from public,anon,authenticated;
grant execute on function public.toast_release_raw_sample_lease(uuid) to service_role;

-- Seed rows at capture start guarantee one row even after an unexpected process exit.
-- The entire latest capture is selected, never a mixture of stale endpoints.
create or replace view public.toast_api_coverage_v with (security_invoker=true) as
with latest as (
 select distinct on (business_id,restaurant_guid,business_date)
  business_id,restaurant_guid,business_date,capture_id
 from public.toast_raw_samples
 where capture_id is not null and endpoint<>'__capture__'
 order by business_id,restaurant_guid,business_date,fetched_at desc,id desc
), records as (
 select s.* from public.toast_raw_samples s join latest l
 on s.business_id=l.business_id and s.restaurant_guid=l.restaurant_guid
 and s.business_date is not distinct from l.business_date and s.capture_id=l.capture_id
 where s.endpoint<>'__capture__'
)
select business_id,restaurant_guid,business_date,endpoint,max(doc_url) as doc_url,
 (array_agg(http_status order by fetched_at desc,id desc)
  filter (where http_status is not null))[1] as status,
 coalesce(bool_or(http_status between 200 and 299),false) as available,
 case
  when bool_or(error_code='skipped_time_budget') then 'skipped_time_budget'
  when bool_or(error_code='skipped_endpoint_budget') then 'skipped_endpoint_budget'
  when bool_or(error_code='skipped_lease_lost') then 'skipped_lease_lost'
  when bool_or(error_code='sample_write_failed') then 'sample_write_failed'
  when bool_or(error_code='page_cap') then 'page_cap'
  when bool_or(error_code='not_ready') and not coalesce(bool_or(http_status=200),false) then 'not_ready'
  when bool_or(http_status=204) and not coalesce(bool_or(http_status between 200 and 203 or http_status between 205 and 299),false) then 'no_content'
  when bool_or(http_status between 200 and 299) then 'available'
  else coalesce((array_agg(error_message order by fetched_at desc,id desc)
    filter (where error_code is distinct from 'not_attempted' and error_message is not null))[1],'not_attempted')
 end as reason,
 sum(item_count)::bigint as item_count,max(fetched_at) as fetched_at
from records group by business_id,restaurant_guid,business_date,endpoint;
revoke all on public.toast_api_coverage_v from public,anon,authenticated;
grant select on public.toast_api_coverage_v to authenticated,service_role;
