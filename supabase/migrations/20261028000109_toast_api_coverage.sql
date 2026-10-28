alter table public.toast_raw_samples add column if not exists doc_url text;
alter table public.toast_raw_samples add column if not exists error_code text;
alter table public.toast_raw_samples add column if not exists error_message text;
alter table public.toast_raw_samples add column if not exists page_number integer;
alter table public.toast_raw_samples add column if not exists capture_id uuid;
create index if not exists toast_raw_samples_capture_id_idx on public.toast_raw_samples(business_id,restaurant_guid,business_date,endpoint,capture_id);
alter table public.toast_raw_samples add column if not exists identifier_counts jsonb not null default '{}'::jsonb;
create or replace function public.toast_renew_raw_sample_lease(p_nonce uuid,p_seconds integer default 290)
returns boolean language plpgsql security definer set search_path=public as $fn$
begin
 if auth.role()<>'service_role' or p_seconds not between 241 and 300 then raise exception 'not allowed'; end if;
 update public.toast_automation_leases set lease_until=clock_timestamp()+make_interval(secs=>p_seconds)
 where nonce=p_nonce and lease_until>clock_timestamp();
 return found;
end $fn$;
revoke all on function public.toast_renew_raw_sample_lease(uuid,integer) from public,anon,authenticated;
grant execute on function public.toast_renew_raw_sample_lease(uuid,integer) to service_role;
-- One evidence record per endpoint, aggregated across all pages and chunks
-- of the latest run. Older captures remain queryable in toast_raw_samples.
create or replace view public.toast_api_coverage_v with (security_invoker=true) as
with latest as (
 select distinct on (business_id,restaurant_guid,business_date,endpoint)
 business_id,restaurant_guid,business_date,endpoint,capture_id
 from public.toast_raw_samples
 where endpoint<>'__capture__'
 order by business_id,restaurant_guid,business_date,endpoint,fetched_at desc
),
records as (
 select s.*
 from public.toast_raw_samples s join latest l
 on s.business_id=l.business_id and s.restaurant_guid=l.restaurant_guid
 and s.business_date is not distinct from l.business_date
 and s.endpoint=l.endpoint
 and s.capture_id is not distinct from l.capture_id
)
select business_id,restaurant_guid,business_date,endpoint,max(doc_url) as doc_url,
 coalesce(max(http_status) filter (where http_status between 200 and 299),
   (array_agg(http_status order by fetched_at desc))[1]) as status,
 bool_or(http_status between 200 and 299) as available,
 case when bool_or(error_code='not_ready') and not bool_or(http_status=200)
     then 'not_ready'
  when bool_or(error_code='page_cap') then 'page_cap'
  when bool_or(http_status=204) and not bool_or(http_status between 200 and 203 or http_status between 205 and 299)
     then 'no_content'
  when bool_or(http_status between 200 and 299) then 'available'
  else coalesce((array_remove(array_agg(error_message order by fetched_at desc),null))[1],
   'not_available') end as reason,
 sum(item_count)::bigint as item_count,
 max(fetched_at) as fetched_at
 from records
 group by business_id,restaurant_guid,business_date,endpoint;
revoke all on public.toast_api_coverage_v from public,anon,authenticated;
grant select on public.toast_api_coverage_v to authenticated,service_role;
