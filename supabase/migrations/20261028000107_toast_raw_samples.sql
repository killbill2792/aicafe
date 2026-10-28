-- Owner-visible, redacted Toast diagnostics. Apply manually in Supabase SQL Editor.
create table if not exists public.toast_raw_samples (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  restaurant_guid text not null,
  endpoint text not null,
  business_date date,
  fetched_at timestamptz not null default now(),
  http_status int,
  item_count int,
  sample jsonb not null,
  field_paths text[] not null
);
create index if not exists toast_raw_samples_business_endpoint_fetched_idx
  on public.toast_raw_samples (business_id, endpoint, fetched_at desc);
alter table public.toast_raw_samples enable row level security;
drop policy if exists "toast raw owner read" on public.toast_raw_samples;
create policy "toast raw owner read" on public.toast_raw_samples
  for select to authenticated using (
    exists (select 1 from public.memberships m
      where m.business_id=toast_raw_samples.business_id
        and m.user_id=auth.uid() and m.role='owner')
  );
revoke all on public.toast_raw_samples from public, anon, authenticated;
grant select on public.toast_raw_samples to authenticated;
grant select, insert, update, delete on public.toast_raw_samples to service_role;

-- Atomic, database-backed ten-minute limiter; only the service role can claim.
-- Remove the old text overload if this draft migration was applied early.
drop function if exists public.toast_claim_raw_sample(uuid,text,date);
-- The marker also makes a failed/aborted capture count towards the cooldown.
create or replace function public.toast_claim_raw_sample(
  p_business_id uuid, p_restaurant_guid uuid, p_business_date date
) returns boolean language plpgsql security invoker
set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('toast-raw-sample:' || p_business_id::text, 0));
  if not exists (
    select 1 from public.toast_location_mappings
    where business_id=p_business_id and restaurant_guid=p_restaurant_guid
      and verified_at is not null
  ) then
    return false;
  end if;
  if exists (
    select 1 from public.toast_raw_samples
    where business_id=p_business_id and endpoint='__capture__'
      and fetched_at > now() - interval '10 minutes'
  ) then
    return false;
  end if;
  insert into public.toast_raw_samples
    (business_id,restaurant_guid,endpoint,business_date,http_status,item_count,sample,field_paths)
  values (p_business_id,p_restaurant_guid::text,'__capture__',p_business_date,202,0,'{}'::jsonb,array[]::text[]);
  return true;
end;
$$;
revoke all on function public.toast_claim_raw_sample(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.toast_claim_raw_sample(uuid,uuid,date) to service_role;
