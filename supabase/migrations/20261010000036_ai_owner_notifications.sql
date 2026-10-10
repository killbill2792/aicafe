-- Phase 7: opt-in owner WhatsApp alerts sourced ONLY from persisted Team tasks.
-- Apply after migrations 33–35; no changes to operating_tasks or finance tables.
create table if not exists ai_owner_notifications (
  business_id uuid not null references businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
  opted_in boolean not null default false,
  consent_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (business_id,owner_user_id),
  check ((opted_in and consent_at is not null) or (not opted_in))
);
alter table ai_owner_notifications enable row level security;
create policy "owners manage own notification opt in" on ai_owner_notifications
  for all to authenticated
  using (owner_user_id=(select auth.uid()) and exists (
   select 1 from memberships m where m.business_id=ai_owner_notifications.business_id
     and m.user_id=(select auth.uid()) and m.role='owner'))
  with check (owner_user_id=(select auth.uid()) and exists (
   select 1 from memberships m where m.business_id=ai_owner_notifications.business_id
     and m.user_id=(select auth.uid()) and m.role='owner'));
grant select,insert,update on ai_owner_notifications to authenticated;
revoke delete on ai_owner_notifications from authenticated;

-- Restricted to server cron, not an alternative operating_tasks inbox.
create table if not exists ai_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  owner_user_id uuid not null,
  task_id text not null,
  task_status text not null check(task_status='needs_owner'),
  business_date date not null,
  state text not null default 'reserved' check(state in ('reserved','sent','failed')),
  provider_message_id text,
  failure_code text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key(business_id,owner_user_id)
    references ai_owner_notifications(business_id,owner_user_id) on delete cascade,
  unique(business_id,owner_user_id,task_id,task_status,business_date)
);
create index if not exists ai_delivery_attempts_latest_idx on ai_delivery_attempts
  (business_id,owner_user_id,created_at desc);
alter table ai_delivery_attempts enable row level security;
-- Only the trusted service-role cron can reserve/mark deliveries.
