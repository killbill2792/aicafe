-- Never automatically attach a new login to the shared Sunrise demo.
-- Replacing the trigger FUNCTION is non-destructive, preserves deployed
-- dependencies, and avoids a signup window with a missing trigger.
set lock_timeout='2s';
set statement_timeout='20s';
create or replace function public.handle_new_user_demo_access()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  -- Private café onboarding creates its own membership explicitly.
  return new;
end $$;
revoke all on function public.handle_new_user_demo_access()
  from public, anon, authenticated;
