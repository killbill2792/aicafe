-- PR 11: verification freshness is separate from discovery freshness.
-- Existing cafe_events owner-read RLS and service-role-only writes still apply.
alter table public.cafe_events
  add column last_verification_attempt_at timestamptz,
  add column last_verified_at timestamptz,
  add column verification_failed_at timestamptz,
  add column verification_details jsonb not null default '{}'::jsonb;
