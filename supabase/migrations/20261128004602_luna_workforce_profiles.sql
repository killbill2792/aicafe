set lock_timeout = '3s';
set statement_timeout = '30s';

create table public.luna_workforce_profiles (
  business_id uuid not null references public.businesses(id) on delete cascade,
  employee_key text not null check (employee_key in ('general_manager', 'growth', 'finance', 'operations', 'staffing')),
  display_name text check (display_name is null or (char_length(display_name) between 1 and 80 and display_name ~ '[^[:space:]]' and display_name !~ '[[:cntrl:]]')),
  job_title text check (job_title is null or (char_length(job_title) between 1 and 120 and job_title ~ '[^[:space:]]' and job_title !~ '[[:cntrl:]]')),
  primary key (business_id, employee_key)
);

-- Reason: this new tenant table must start with owner-only access.
-- squawk-ignore ban-alter-row-level-security
alter table public.luna_workforce_profiles enable row level security;
revoke all on public.luna_workforce_profiles from public, anon, authenticated, service_role;
grant select, insert on public.luna_workforce_profiles to authenticated;
grant update (display_name, job_title) on public.luna_workforce_profiles to authenticated;

create policy workforce_owner_read on public.luna_workforce_profiles
  for select to authenticated using (public.scheduling_is_owner(business_id));
create policy workforce_owner_create on public.luna_workforce_profiles
  for insert to authenticated with check (public.scheduling_is_owner(business_id));
create policy workforce_owner_edit on public.luna_workforce_profiles
  for update to authenticated using (public.scheduling_is_owner(business_id))
  with check (public.scheduling_is_owner(business_id));

create function public.luna_save_workforce_profile(
  p_business_id uuid, p_employee_key text, p_display_name text, p_job_title text
) returns void language sql security invoker set search_path = '' as $$
  insert into public.luna_workforce_profiles (business_id, employee_key, display_name, job_title)
  values (p_business_id, p_employee_key, p_display_name, p_job_title)
  on conflict (business_id, employee_key) do update
  set display_name = excluded.display_name, job_title = excluded.job_title;
$$;

revoke all on function public.luna_save_workforce_profile(uuid,text,text,text) from public, anon, service_role;
grant execute on function public.luna_save_workforce_profile(uuid,text,text,text) to authenticated;
