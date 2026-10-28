alter table public.toast_raw_samples add column if not exists doc_url text;
alter table public.toast_raw_samples add column if not exists error_code text;
alter table public.toast_raw_samples add column if not exists error_message text;
alter table public.toast_raw_samples add column if not exists page_number integer;
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
create or replace view public.toast_api_coverage_v with (security_invoker=true) as
select distinct on (business_id,restaurant_guid,business_date,endpoint)
 business_id,restaurant_guid,business_date,endpoint,doc_url,http_status as status,
 (http_status between 200 and 299 and error_code is null) as available,
 coalesce(error_message,case when http_status between 200 and 299 then 'available' else 'not_available' end) as reason,
 item_count,fetched_at
 from public.toast_raw_samples where endpoint<>'__capture__'
 order by business_id,restaurant_guid,business_date,endpoint,fetched_at desc;
revoke all on public.toast_api_coverage_v from public,anon,authenticated;
grant select on public.toast_api_coverage_v to authenticated,service_role;
