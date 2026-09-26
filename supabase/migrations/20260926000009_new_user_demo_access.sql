-- Every new signed-up user automatically gets read/write access to the shared "Demo café"
-- business (fixed id, seeded by scripts/db-reset.mjs) so the demo is explorable immediately
-- after magic-link login, with zero setup. Their own real business is created separately during
-- onboarding (S2) — the two never share rows. If db:reset hasn't seeded the demo business yet,
-- this silently does nothing rather than failing signup.
create or replace function handle_new_user_demo_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_business_id uuid := '11111111-1111-1111-1111-111111111111';
begin
  if exists (select 1 from businesses where id = demo_business_id) then
    insert into memberships (business_id, user_id, role, can_see_profit)
    values (demo_business_id, new.id, 'owner', true)
    on conflict (business_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_demo_access on auth.users;
create trigger on_auth_user_created_demo_access
  after insert on auth.users
  for each row execute function handle_new_user_demo_access();
