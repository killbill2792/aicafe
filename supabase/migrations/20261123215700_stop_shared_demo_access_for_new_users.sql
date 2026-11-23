-- New registrants must own a separate café and connect their own POS.
-- Never grant owner access to shared demonstration data on auth signup.
-- Existing memberships are preserved; onboarding already creates a unique
-- real-café UUID for an authenticated new owner.
set lock_timeout='2s';
set statement_timeout='20s';
drop trigger if exists on_auth_user_created_demo_access on auth.users;
drop function if exists public.handle_new_user_demo_access();
