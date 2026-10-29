-- businesses was the only public table without row level security. Its "members read"
-- and "members write" policies (20260926000008_rls.sql) existed but had no effect, so any
-- caller with the anon or authenticated key could read and change every café's row
-- (name, currency, margins, payroll settings). Enabling RLS makes those policies apply:
-- members see and update only their own café. The service role (sign-up in
-- lib/actions/onboarding.ts, account deletion, admin pages) bypasses RLS as before.
alter table public.businesses enable row level security;
