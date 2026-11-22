-- U4 voluntary PWA Web Push transport. Not an executor or scheduled agent.
-- No activation without new env configuration and separate production approval.
set lock_timeout='3s'; set statement_timeout='30s';
create table public.u4_push_subscriptions(
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  device_hash text not null check(device_hash~'^[a-f0-9]{64}$'),
  sealed_subscription text not null check(length(sealed_subscription) between 30 and 8192),
  consent_at timestamptz not null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(business_id,owner_user_id,device_hash)
);
-- Reason: This new private device-consent table must enforce RLS before any service-only grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.u4_push_subscriptions enable row level security;
revoke all on public.u4_push_subscriptions from public,anon,authenticated;
grant select,insert,update,delete on public.u4_push_subscriptions to service_role;

create table public.u4_push_receipts(
  business_id uuid not null,
  owner_user_id uuid not null,
  device_hash text not null,
  run_id uuid not null,
  status text not null default 'pending' check(status in('pending','sending','retry','sent','dead')),
  attempts bigint not null default 0 check(attempts between 0 and 4),
  next_retry_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  last_failure text,
  created_at timestamptz not null default now(),
  primary key(business_id,owner_user_id,device_hash,run_id),
  foreign key(business_id,owner_user_id,device_hash)
    references public.u4_push_subscriptions(business_id,owner_user_id,device_hash) on delete cascade,
  check((status='sending')=(lease_token is not null and lease_until is not null))
);
create index u4_push_receipts_pending_idx
  on public.u4_push_receipts(next_retry_at,created_at)
  where status in('pending','retry','sending');
-- Reason: This new private transport receipt table must enforce RLS before any service-only grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.u4_push_receipts enable row level security;
revoke all on public.u4_push_receipts from public,anon,authenticated;
grant select,insert,update,delete on public.u4_push_receipts to service_role;

-- Finish interrupted final attempts without another provider send. A claimed
-- fourth attempt whose worker vanished must not remain in 'sending' forever.
-- Service-only, bounded, SKIP LOCKED and idempotent across concurrent crons.
create function public.u4_reap_expired_push_receipts(
  p_now timestamptz,p_limit integer default 100
) returns integer language plpgsql security definer set search_path=''
as $u4_reap$
declare finished integer;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_now is null
    or p_limit is null or p_limit not between 1 and 100
  then raise exception 'push_reap_denied' using errcode='42501'; end if;
  with expired as materialized(
    select q.business_id,q.owner_user_id,q.device_hash,q.run_id
    from public.u4_push_receipts q
    where q.status='sending' and q.attempts>=4 and q.lease_until<=p_now
    order by q.lease_until,q.created_at,q.run_id
    limit p_limit
    for update of q skip locked
  )
  update public.u4_push_receipts q set
    status='dead',lease_token=null,lease_until=null,
    last_failure='final_attempt_lease_expired'
  from expired e
  where q.business_id=e.business_id and q.owner_user_id=e.owner_user_id
    and q.device_hash=e.device_hash and q.run_id=e.run_id;
  get diagnostics finished=row_count;
  return finished;
end
$u4_reap$;
revoke all on function public.u4_reap_expired_push_receipts(timestamptz,integer)
  from public,anon,authenticated;
grant execute on function public.u4_reap_expired_push_receipts(timestamptz,integer)
  to service_role;

-- Claimed recipient, current membership and unchanged completed Work pointer
-- are reverified on each transport attempt. A restarted cron safely reclaims
-- expired sending leases; a separate process cannot claim the same receipt.
create function public.u4_claim_push_receipt(p_now timestamptz)
returns jsonb language plpgsql security definer set search_path=''
as $push_claim$
declare rec public.u4_push_receipts;sealed text;token uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_now is null
  then raise exception 'push_claim_denied' using errcode='42501'; end if;
  select q.* into rec from public.u4_push_receipts q
    join public.u4_push_subscriptions s
      on s.business_id=q.business_id and s.owner_user_id=q.owner_user_id
        and s.device_hash=q.device_hash and s.revoked_at is null
    join public.operating_tasks t on t.business_id=q.business_id
      and t.id='u4:'||q.run_id::text and t.kind='u4_report'
      and t.owner_user_id=q.owner_user_id
      and t.status='watching'
      and t.created_at>=p_now-interval '7 days'
      and not exists(
        select 1 from public.operating_tasks newer
        where newer.business_id=t.business_id
          and newer.owner_user_id=t.owner_user_id
          and newer.kind='u4_report'
          and newer.payload->>'routineId'=t.payload->>'routineId'
          and (newer.created_at,newer.id)>(t.created_at,t.id))
    join public.supervisor_routine_occurrences o on
      o.business_id=q.business_id and o.run_id=q.run_id
      and o.state='completed'
    where q.attempts<4
      and (q.status in ('pending','retry') and q.next_retry_at<=p_now
        or q.status='sending' and q.lease_until<=p_now)
      and exists(select 1 from public.memberships m
        where m.business_id=q.business_id and m.user_id=q.owner_user_id
          and m.role='owner')
    order by q.next_retry_at,q.created_at,q.run_id
    limit 1 for update of q skip locked;
  if not found then return null; end if;
  token:=gen_random_uuid();
  update public.u4_push_receipts set status='sending',
    attempts=attempts+1,lease_token=token,lease_until=p_now+interval '30 seconds'
    where business_id=rec.business_id and owner_user_id=rec.owner_user_id
      and device_hash=rec.device_hash and run_id=rec.run_id;
  select sealed_subscription into sealed from public.u4_push_subscriptions
    where business_id=rec.business_id and owner_user_id=rec.owner_user_id
      and device_hash=rec.device_hash and revoked_at is null;
  if sealed is null then return null; end if;
  return jsonb_build_object('businessId',rec.business_id,'ownerUserId',rec.owner_user_id,
    'deviceHash',rec.device_hash,'runId',rec.run_id,'leaseToken',token,
    'sealedSubscription',sealed);
end
$push_claim$;
revoke all on function public.u4_claim_push_receipt(timestamptz) from public,anon,authenticated;
grant execute on function public.u4_claim_push_receipt(timestamptz) to service_role;

create function public.u4_finish_push_receipt(
  p_business_id uuid,p_owner_user_id uuid,p_device_hash text,p_run_id uuid,
  p_lease_token uuid,p_delivered boolean,p_permanent boolean,p_now timestamptz
) returns boolean language plpgsql security definer set search_path=''
as $push_finish$
declare r public.u4_push_receipts;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_now is null
    or p_lease_token is null then
    raise exception 'push_finish_denied' using errcode='42501'; end if;
  select * into r from public.u4_push_receipts
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and device_hash=p_device_hash and run_id=p_run_id for update;
  if not found or r.status<>'sending' or r.lease_token is distinct from p_lease_token
    or r.lease_until<=p_now then return false; end if;
  update public.u4_push_receipts set
    status=case when p_delivered then 'sent'
      when p_permanent or r.attempts>=4 then 'dead' else 'retry' end,
    lease_token=null,lease_until=null,
    delivered_at=case when p_delivered then p_now else null end,
    next_retry_at=case when p_delivered then p_now
      else p_now+(interval '1 minute'*least(30,power(2,r.attempts)::integer)) end,
    last_failure=case when p_delivered then null
      when p_permanent then 'subscription_expired' else 'retryable_transport_failure' end
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and device_hash=p_device_hash and run_id=p_run_id;
  if p_permanent then
    update public.u4_push_subscriptions set revoked_at=p_now,updated_at=p_now
      where business_id=p_business_id and owner_user_id=p_owner_user_id
        and device_hash=p_device_hash;
  end if;
  return true;
end $push_finish$;
revoke all on function public.u4_finish_push_receipt(
  uuid,uuid,text,uuid,uuid,boolean,boolean,timestamptz)
  from public,anon,authenticated;
grant execute on function public.u4_finish_push_receipt(
  uuid,uuid,text,uuid,uuid,boolean,boolean,timestamptz) to service_role;

-- A device whose owner revoked consent must not leave an undeliverable active
-- retry queue behind. Only receipt status/lease is closed; the audit remains.
create function public.u4_close_revoked_push_receipts()
returns trigger language plpgsql security definer set search_path=''
as $u4_push_revoke$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    update public.u4_push_receipts set
      status='dead',lease_token=null,lease_until=null,
      last_failure='consent_revoked'
      where business_id=new.business_id and owner_user_id=new.owner_user_id
        and device_hash=new.device_hash and status<>'sent';
  end if;
  return new;
end
$u4_push_revoke$;
revoke all on function public.u4_close_revoked_push_receipts()
  from public,anon,authenticated;
create trigger u4_push_revoke_closes_receipts
after update of revoked_at on public.u4_push_subscriptions
for each row when(old.revoked_at is null and new.revoked_at is not null)
execute function public.u4_close_revoked_push_receipts();
