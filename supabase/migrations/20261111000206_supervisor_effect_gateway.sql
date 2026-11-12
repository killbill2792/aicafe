-- Task 10: one service-only effect gateway for click approval and phone-MFA mandates.
-- The only standing-mandate capability in this release is goal tracking (leo.goal.v1).
-- No OTP code, phone number, provider credential, or external payload is persisted.
-- Bound schema-lock and statement windows; migrations are transactional.
set lock_timeout = '3s';
set statement_timeout = '30s';

create table public.supervisor_mandates (
  id uuid not null,
  revision bigint not null check (revision > 0),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  capability_id text not null check (capability_id = 'leo.goal.v1'),
  capability_version bigint not null check (capability_version = 1),
  policy_hash text not null check (policy_hash ~ '^[a-f0-9]{64}$'),
  limit_kind text not null check (limit_kind = 'count'),
  limit_value bigint not null check (limit_value = 5),
  currency text check (currency is null),
  period_kind text not null check (period_kind = 'cafe_day'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  superseded_at timestamptz,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (id, revision),
  check (expires_at > created_at)
);
create index supervisor_mandates_active_owner
  on public.supervisor_mandates (business_id, owner_user_id, capability_id, revision desc)
  where superseded_at is null and revoked_at is null;

create table public.supervisor_mandate_challenges (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('grant','revise')),
  mandate_id uuid not null,
  mandate_revision bigint not null check (mandate_revision >= 0),
  capability_id text not null check (capability_id = 'leo.goal.v1'),
  capability_version bigint not null check (capability_version = 1),
  policy_hash text not null check (policy_hash ~ '^[a-f0-9]{64}$'),
  limit_value bigint not null check (limit_value = 5),
  period_kind text not null check (period_kind = 'cafe_day'),
  mandate_expires_at timestamptz not null,
  factor_id text not null check (length(factor_id) between 1 and 200),
  provider_challenge_id text not null check (length(provider_challenge_id) between 1 and 200),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider_challenge_id),
  check ((action = 'grant' and mandate_revision = 0) or
         (action = 'revise' and mandate_revision > 0))
);
create index supervisor_mandate_challenges_pending
  on public.supervisor_mandate_challenges (business_id, owner_user_id, expires_at)
  where consumed_at is null;

create table public.supervisor_effect_attempts (
  id uuid primary key default gen_random_uuid(),
  attempt_key uuid not null unique default gen_random_uuid(),
  business_id uuid not null,
  proposal_id uuid not null,
  effect_hash text not null check (effect_hash ~ '^[a-f0-9]{64}$'),
  authorization_kind text not null check (authorization_kind in ('click','mandate')),
  mandate_id uuid,
  mandate_revision bigint,
  business_date date not null,
  state text not null check (state in ('reserved','executing','verified','uncertain','stale')),
  receipt_ref text,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  unique (business_id, proposal_id, effect_hash),
  foreign key (business_id, proposal_id)
    references public.supervisor_proposals(business_id, id) on delete cascade,
  foreign key (mandate_id, mandate_revision)
    references public.supervisor_mandates(id, revision),
  check ((authorization_kind = 'click' and mandate_id is null and mandate_revision is null) or
         (authorization_kind = 'mandate' and mandate_id is not null and mandate_revision is not null)),
  check ((state = 'verified' and verified_at is not null and receipt_ref is not null) or
         (state <> 'verified' and verified_at is null))
);
create index supervisor_effect_attempts_mandate_day
  on public.supervisor_effect_attempts (business_id, mandate_id, mandate_revision, business_date)
  where state in ('reserved','executing','verified','uncertain');

alter table public.supervisor_approvals
  add column authorization_kind text not null default 'click'
    check (authorization_kind in ('click','mandate')),
  add column mandate_id uuid,
  add column mandate_revision bigint;

-- Reason: Existing approvals have no mandate reference. Short timeout bounds this one-time verified foreign key on the existing click ledger.
-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
alter table public.supervisor_approvals add constraint supervisor_approvals_mandate_fk
  foreign key (mandate_id, mandate_revision)
  references public.supervisor_mandates(id, revision);

-- Reason: Every existing row has default click and null mandate keys, so this check is valid; enforce it immediately under the short lock timeout.
-- squawk-ignore constraint-missing-not-valid
alter table public.supervisor_approvals add constraint supervisor_approvals_authorization_shape
  check (
    (authorization_kind = 'click' and mandate_id is null and mandate_revision is null) or
    (authorization_kind = 'mandate' and mandate_id is not null and mandate_revision is not null)
  );

-- Reason: This newly created private mandate table has no prior clients; enable RLS before granting read access.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_mandates enable row level security;
-- Reason: This is a new service-only table and must remain closed to authenticated clients.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_mandate_challenges enable row level security;
-- Reason: This new effect receipt table is owner-readable only under scoped select RLS.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_effect_attempts enable row level security;

create policy "owner private mandate read" on public.supervisor_mandates for select to authenticated
  using (owner_user_id = (select auth.uid()) and exists (
    select 1 from public.memberships m
    where m.business_id = supervisor_mandates.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner'
  ));
create policy "owner private effect attempt read" on public.supervisor_effect_attempts for select to authenticated
  using (exists (
    select 1 from public.supervisor_proposals p
    where p.business_id = supervisor_effect_attempts.business_id
      and p.id = supervisor_effect_attempts.proposal_id
      and p.owner_user_id = (select auth.uid())
  ) and exists (
    select 1 from public.memberships m
    where m.business_id = supervisor_effect_attempts.business_id
      and m.user_id = (select auth.uid()) and m.role = 'owner'
  ));

revoke all on public.supervisor_mandates, public.supervisor_mandate_challenges,
  public.supervisor_effect_attempts from public, anon, authenticated;
grant select on public.supervisor_mandates, public.supervisor_effect_attempts to authenticated;
grant all on public.supervisor_mandates, public.supervisor_mandate_challenges,
  public.supervisor_effect_attempts to service_role;
grant select, update on public.supervisor_approvals to service_role;

-- A challenge is inserted only after Supabase Auth has issued a phone MFA challenge.
-- Its provider identifiers are opaque references; OTP plaintext is never accepted by SQL.
create function public.supervisor_create_mandate_challenge(
  p_business_id uuid, p_owner_user_id uuid, p_challenge_id uuid,
  p_action text, p_mandate_id uuid, p_mandate_revision bigint,
  p_capability_id text, p_capability_version integer, p_policy_hash text,
  p_limit_value integer, p_period_kind text, p_mandate_expires_at timestamptz,
  p_factor_id text, p_provider_challenge_id text, p_challenge_expires_at timestamptz
) returns public.supervisor_mandate_challenges
language plpgsql security definer set search_path = public as $$
declare c public.supervisor_mandate_challenges;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.memberships m
    join public.businesses b on b.id = m.business_id
    where m.business_id = p_business_id and m.user_id = p_owner_user_id
      and m.role = 'owner' and b.is_demo = false)
  then raise exception 'mandate_owner_required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'supervisor-mandate:'||p_business_id::text||':'||p_owner_user_id::text||':leo.goal.v1',0));
  if p_capability_id is distinct from 'leo.goal.v1' or p_capability_version is distinct from 1
    or p_limit_value is distinct from 5
    or p_period_kind is distinct from 'cafe_day'
    or p_policy_hash is null or p_policy_hash !~ '^[a-f0-9]{64}$'
    or p_challenge_expires_at > now() + interval '10 minutes'
    or length(coalesce(p_factor_id,'')) not between 1 and 200
    or length(coalesce(p_provider_challenge_id,'')) not between 1 and 200
  then raise exception 'invalid_mandate_challenge' using errcode = '22023'; end if;
  if p_action = 'grant' then
    if p_mandate_revision <> 0 or exists (
      select 1 from public.supervisor_mandates m
      where m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.capability_id = p_capability_id
        and m.superseded_at is null and m.revoked_at is null and m.expires_at > now()
    ) then raise exception 'active_mandate_exists' using errcode = 'P0001'; end if;
  elsif p_action = 'revise' then
    if p_mandate_revision is null or p_mandate_revision <= 0 or not exists (
      select 1 from public.supervisor_mandates m
      where m.id = p_mandate_id and m.revision = p_mandate_revision
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.capability_id = p_capability_id and m.superseded_at is null
        and m.revoked_at is null and m.expires_at > now()
    ) then raise exception 'mandate_revision_conflict' using errcode = 'P0001'; end if;
  else raise exception 'invalid_mandate_action' using errcode = '22023'; end if;
  insert into public.supervisor_mandate_challenges(
    id,business_id,owner_user_id,action,mandate_id,mandate_revision,
    capability_id,capability_version,policy_hash,limit_value,period_kind,
    mandate_expires_at,factor_id,provider_challenge_id,expires_at
  ) values (
    p_challenge_id,p_business_id,p_owner_user_id,p_action,p_mandate_id,p_mandate_revision,
    p_capability_id,p_capability_version,p_policy_hash,p_limit_value,p_period_kind,
    p_mandate_expires_at,p_factor_id,p_provider_challenge_id,p_challenge_expires_at
  ) returning * into c;
  return c;
end $$;
revoke all on function public.supervisor_create_mandate_challenge(
  uuid,uuid,uuid,text,uuid,bigint,text,integer,text,integer,text,timestamptz,text,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.supervisor_create_mandate_challenge(
  uuid,uuid,uuid,text,uuid,bigint,text,integer,text,integer,text,timestamptz,text,text,timestamptz
) to service_role;

-- Called only after auth.mfa.verify succeeds for the factor and challenge stored above.
create function public.supervisor_complete_mandate_challenge(
  p_business_id uuid, p_owner_user_id uuid, p_challenge_id uuid,
  p_factor_id text, p_provider_challenge_id text
) returns public.supervisor_mandates
language plpgsql security definer set search_path = public as $$
declare c public.supervisor_mandate_challenges; old_m public.supervisor_mandates;
  result_m public.supervisor_mandates; next_revision integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_only'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'supervisor-mandate:'||p_business_id::text||':'||p_owner_user_id::text||':leo.goal.v1',0));
  select * into c from public.supervisor_mandate_challenges
    where id = p_challenge_id and business_id = p_business_id
      and owner_user_id = p_owner_user_id for update;
  if c.id is null or c.consumed_at is not null or c.expires_at <= now()
    or c.factor_id is distinct from p_factor_id
    or c.provider_challenge_id is distinct from p_provider_challenge_id
  then raise exception 'mandate_challenge_expired_or_consumed' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships m
    join public.businesses b on b.id = m.business_id
    where m.business_id = p_business_id and m.user_id = p_owner_user_id
      and m.role = 'owner' and b.is_demo = false)
  then raise exception 'mandate_owner_required' using errcode = '42501'; end if;
  if c.mandate_expires_at <= now() then raise exception 'mandate_expired' using errcode = 'P0001'; end if;
  if c.action = 'grant' then
    if exists (select 1 from public.supervisor_mandates m
      where m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.capability_id = c.capability_id and m.superseded_at is null
        and m.revoked_at is null and m.expires_at > now())
    then raise exception 'active_mandate_exists' using errcode = 'P0001'; end if;
    next_revision := 1;
  else
    select * into old_m from public.supervisor_mandates
      where id = c.mandate_id and revision = c.mandate_revision
        and business_id = p_business_id and owner_user_id = p_owner_user_id
        and superseded_at is null and revoked_at is null for update;
    if old_m.id is null or old_m.expires_at <= now()
    then raise exception 'mandate_revision_conflict' using errcode = 'P0001'; end if;
    update public.supervisor_mandates set superseded_at = now()
      where id = old_m.id and revision = old_m.revision;
    next_revision := old_m.revision + 1;
  end if;
  update public.supervisor_mandate_challenges set consumed_at = now()
    where id = c.id and consumed_at is null;
  insert into public.supervisor_mandates(
    id,revision,business_id,owner_user_id,capability_id,capability_version,
    policy_hash,limit_kind,limit_value,currency,period_kind,expires_at,verified_at
  ) values (
    c.mandate_id,next_revision,c.business_id,c.owner_user_id,c.capability_id,c.capability_version,
    c.policy_hash,'count',c.limit_value,null,c.period_kind,c.mandate_expires_at,now()
  ) returning * into result_m;
  return result_m;
end $$;
revoke all on function public.supervisor_complete_mandate_challenge(uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.supervisor_complete_mandate_challenge(uuid,uuid,uuid,text,text)
  to service_role;

create function public.supervisor_revoke_mandate(
  p_business_id uuid, p_owner_user_id uuid, p_mandate_id uuid, p_revision integer
) returns public.supervisor_mandates
language plpgsql security definer set search_path = public as $$
declare old_m public.supervisor_mandates; result_m public.supervisor_mandates;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_only'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'supervisor-mandate:'||p_business_id::text||':'||p_owner_user_id::text||':leo.goal.v1',0));
  if not exists (select 1 from public.memberships m
    where m.business_id = p_business_id and m.user_id = p_owner_user_id and m.role = 'owner')
  then raise exception 'mandate_owner_required' using errcode = '42501'; end if;
  select * into old_m from public.supervisor_mandates
    where id = p_mandate_id and business_id = p_business_id
      and owner_user_id = p_owner_user_id and revision = p_revision
      and superseded_at is null and revoked_at is null for update;
  if old_m.id is null then raise exception 'mandate_revision_conflict' using errcode = 'P0001'; end if;
  update public.supervisor_mandates set superseded_at = now()
    where id = old_m.id and revision = old_m.revision;
  insert into public.supervisor_mandates(
    id,revision,business_id,owner_user_id,capability_id,capability_version,
    policy_hash,limit_kind,limit_value,currency,period_kind,expires_at,
    revoked_at,verified_at
  ) values (
    old_m.id,old_m.revision+1,old_m.business_id,old_m.owner_user_id,
    old_m.capability_id,old_m.capability_version,old_m.policy_hash,
    old_m.limit_kind,old_m.limit_value,old_m.currency,old_m.period_kind,
    old_m.expires_at,now(),old_m.verified_at
  ) returning * into result_m;
  return result_m;
end $$;
revoke all on function public.supervisor_revoke_mandate(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.supervisor_revoke_mandate(uuid,uuid,uuid,integer)
  to service_role;

-- The proposal row lock, authorization provenance, quota debit and attempt
-- reservation are one transaction. A retry cannot pass an existing attempt.
create function public.supervisor_claim_effect(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_proposal_id uuid, p_revision integer, p_authorization_kind text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.supervisor_proposals; approved_row public.supervisor_approvals;
  m public.supervisor_mandates; attempt_id uuid; local_day date; used_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_only'; end if;
  if p_authorization_kind not in ('click','mandate') then raise exception 'invalid_authorization_kind'; end if;
  if not exists (select 1 from public.memberships x
    where x.business_id = p_business_id and x.user_id = p_owner_user_id and x.role = 'owner')
  then raise exception 'proposal_owner_required' using errcode = '42501'; end if;
  select (now() at time zone b.timezone)::date into local_day
    from public.businesses b where b.id = p_business_id
      and b.timezone is not null
      and exists (select 1 from pg_timezone_names z where z.name = b.timezone);
  if local_day is null then raise exception 'cafe_timezone_unavailable' using errcode = 'P0001'; end if;
  select * into p from public.supervisor_proposals
    where business_id = p_business_id and owner_user_id = p_owner_user_id
      and thread_id = p_thread_id and id = p_proposal_id for update;
  if p.id is null or p.revision <> p_revision then
    raise exception 'proposal_revision_conflict' using errcode = 'P0001';
  end if;
  if p_authorization_kind = 'click' then
    if p.status <> 'approved' then raise exception 'individual_approval_required' using errcode = '42501'; end if;
    select * into approved_row from public.supervisor_approvals
      where business_id = p_business_id and proposal_id = p.id
        and owner_user_id = p_owner_user_id and approved_revision = p.revision-1
        and effect_hash = p.effect_hash and authorization_kind = 'click'
        and mandate_id is null and mandate_revision is null for update;
    if approved_row.id is null then raise exception 'individual_approval_missing' using errcode = '42501'; end if;
  else
    if p.status <> 'draft' or p.capability_id <> 'leo.goal.v1' or p.capability_version <> 1
    then raise exception 'standing_mandate_action_not_eligible' using errcode = '42501'; end if;
    select * into m from public.supervisor_mandates
      where business_id = p_business_id and owner_user_id = p_owner_user_id
        and capability_id = p.capability_id and capability_version = p.capability_version
        and superseded_at is null and revoked_at is null and expires_at > now()
      order by revision desc limit 1 for update;
    if m.id is null or m.verified_at is null or m.limit_kind <> 'count'
      or m.period_kind <> 'cafe_day' or m.limit_value <> 5
    then raise exception 'active_standing_mandate_required' using errcode = '42501'; end if;
    -- A café-local-day cap is shared by every owner of the same café.
    -- Serialize claims across distinct owner mandates as well as revisions.
    perform pg_advisory_xact_lock(hashtextextended(
      'supervisor-goal-day:'||p_business_id::text||':'||local_day::text,0));
    select count(*)::integer into used_count from public.supervisor_effect_attempts a
      where a.business_id = p_business_id and a.business_date = local_day
        and a.state in ('reserved','executing','verified','uncertain')
        and exists (select 1 from public.supervisor_mandates history
          where history.id = a.mandate_id and history.business_id = p_business_id
            and history.capability_id = p.capability_id);
    if used_count >= m.limit_value then raise exception 'mandate_daily_limit_reached' using errcode = '42501'; end if;
    insert into public.supervisor_approvals(
      business_id,proposal_id,owner_user_id,approved_revision,effect_hash,
      authorization_kind,mandate_id,mandate_revision
    ) values (
      p_business_id,p.id,p_owner_user_id,p.revision,p.effect_hash,
      'mandate',m.id,m.revision
    );
    update public.supervisor_proposals set status = 'approved',
      approved_at = now(), approved_by = p_owner_user_id,
      revision = revision + 1, updated_at = now()
      where id = p.id returning * into p;
  end if;
  attempt_id := gen_random_uuid();
  insert into public.supervisor_effect_attempts(
    attempt_key,business_id,proposal_id,effect_hash,authorization_kind,
    mandate_id,mandate_revision,business_date,state
  ) values (
    attempt_id,p_business_id,p.id,p.effect_hash,p_authorization_kind,
    case when p_authorization_kind='mandate' then m.id else null end,
    case when p_authorization_kind='mandate' then m.revision else null end,
    local_day,'reserved'
  );
  update public.supervisor_proposals set status = 'executing',
    revision = revision + 1, updated_at = now()
    where id = p.id returning * into p;
  update public.supervisor_effect_attempts set state = 'executing'
    where attempt_key = attempt_id and state = 'reserved';
  return jsonb_build_object('proposal',to_jsonb(p),'attempt_key',attempt_id,
    'business_date',local_day,'authorization_kind',p_authorization_kind);
end $$;
revoke all on function public.supervisor_claim_effect(uuid,uuid,uuid,uuid,integer,text)
  from public, anon, authenticated;
grant execute on function public.supervisor_claim_effect(uuid,uuid,uuid,uuid,integer,text)
  to service_role;

create function public.supervisor_finish_effect_attempt(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_proposal_id uuid, p_attempt_key uuid, p_revision integer,
  p_state text, p_next_status text default null, p_monitoring_start_date date default null
) returns public.supervisor_proposals
language plpgsql security definer set search_path = public as $$
declare p public.supervisor_proposals; a public.supervisor_effect_attempts;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_only'; end if;
  select * into p from public.supervisor_proposals
    where business_id = p_business_id and owner_user_id = p_owner_user_id
      and thread_id = p_thread_id and id = p_proposal_id for update;
  select * into a from public.supervisor_effect_attempts
    where business_id = p_business_id and proposal_id = p_proposal_id
      and attempt_key = p_attempt_key for update;
  if p.id is null or p.revision <> p_revision or p.status <> 'executing'
    or a.id is null or a.effect_hash <> p.effect_hash or a.state <> 'executing'
  then raise exception 'effect_attempt_conflict' using errcode = 'P0001'; end if;
  if p_state = 'uncertain' then
    update public.supervisor_effect_attempts set state = 'uncertain'
      where id = a.id returning * into a;
    return p;
  elsif p_state = 'stale' then
    update public.supervisor_effect_attempts set state = 'stale'
      where id = a.id returning * into a;
    update public.supervisor_proposals set status = 'stale',
      revision = revision + 1, updated_at = now()
      where id = p.id returning * into p;
    return p;
  end if;
  if p_state <> 'verified' or p_next_status is null
    or p_next_status not in ('committed','manual_pending')
  then raise exception 'invalid_effect_completion' using errcode = '22023'; end if;
  update public.supervisor_effect_attempts set state = 'verified',
    receipt_ref = p_attempt_key::text, verified_at = now()
    where id = a.id;
  update public.supervisor_proposals set status = p_next_status,
    revision = revision + 1,
    committed_at = case when p_next_status = 'committed' then now() else null end,
    monitoring_start_date = case when p_next_status = 'committed'
      then p_monitoring_start_date else null end,
    updated_at = now()
    where id = p.id returning * into p;
  return p;
end $$;
revoke all on function public.supervisor_finish_effect_attempt(
  uuid,uuid,uuid,uuid,uuid,integer,text,text,date
) from public, anon, authenticated;
grant execute on function public.supervisor_finish_effect_attempt(
  uuid,uuid,uuid,uuid,uuid,integer,text,text,date
) to service_role;

-- Staff writes keep their existing source-token CAS and one-transaction SQL
-- executor; this wrapper reserves the same gateway attempt in that transaction.
create function public.supervisor_gateway_commit_staff(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_proposal_id uuid, p_revision integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.supervisor_proposals; approved_row public.supervisor_approvals;
  attempt_id uuid; local_day date; result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.memberships m
    where m.business_id = p_business_id and m.user_id = p_owner_user_id and m.role = 'owner')
  then raise exception 'staff_owner_required' using errcode = '42501'; end if;
  select (now() at time zone b.timezone)::date into local_day
    from public.businesses b where b.id = p_business_id and b.timezone is not null
      and exists (select 1 from pg_timezone_names z where z.name = b.timezone);
  if local_day is null then raise exception 'cafe_timezone_unavailable' using errcode = 'P0001'; end if;
  select * into p from public.supervisor_proposals
    where business_id = p_business_id and owner_user_id = p_owner_user_id
      and thread_id = p_thread_id and id = p_proposal_id for update;
  if p.id is null or p.revision <> p_revision or p.status <> 'approved'
    or left(p.capability_id,13) <> 'olivia.staff_'
  then raise exception 'staff_proposal_revision_conflict' using errcode = 'P0001'; end if;
  select * into approved_row from public.supervisor_approvals
    where business_id = p_business_id and proposal_id = p.id
      and owner_user_id = p_owner_user_id and approved_revision = p.revision-1
      and effect_hash = p.effect_hash and authorization_kind = 'click'
      and mandate_id is null and mandate_revision is null for update;
  if approved_row.id is null then raise exception 'individual_approval_missing' using errcode = '42501'; end if;
  attempt_id := gen_random_uuid();
  insert into public.supervisor_effect_attempts(
    attempt_key,business_id,proposal_id,effect_hash,authorization_kind,
    business_date,state
  ) values (attempt_id,p_business_id,p.id,p.effect_hash,'click',local_day,'reserved');
  result := public.supervisor_commit_staff_proposal(
    p_business_id,p_owner_user_id,p_thread_id,p_proposal_id,p_revision
  );
  update public.supervisor_effect_attempts set
    state = case when result->>'state' = 'applied' then 'verified' else 'stale' end,
    receipt_ref = case when result->>'state' = 'applied' then attempt_id::text else null end,
    verified_at = case when result->>'state' = 'applied' then now() else null end
    where attempt_key = attempt_id;
  return result || jsonb_build_object('attempt_key',attempt_id);
end $$;
revoke all on function public.supervisor_gateway_commit_staff(uuid,uuid,uuid,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.supervisor_gateway_commit_staff(uuid,uuid,uuid,uuid,integer)
  to service_role;

-- Replace only the existing non-effectful transition contract in place:
-- no second callable legacy execution path can bypass effect claims/receipts.
create or replace function public.supervisor_transition_proposal(
  p_business_id uuid, p_owner_user_id uuid, p_proposal_id uuid, p_revision integer,
  p_action text, p_monitoring_start_date date default null
) returns public.supervisor_proposals
language plpgsql security definer set search_path = public as $$
declare proposal_row public.supervisor_proposals;
begin
  if auth.role() is distinct from 'service_role'
  then raise exception 'service_role_only' using errcode = '42501'; end if;
  if p_action in ('claim_commit','manual_pending','committed')
  then raise exception 'effect_gateway_required' using errcode = '42501'; end if;

  select * into proposal_row from public.supervisor_proposals
    where business_id = p_business_id and owner_user_id = p_owner_user_id
      and id = p_proposal_id for update;
  if proposal_row.id is null or proposal_row.revision <> p_revision
  then raise exception 'proposal_revision_conflict' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.memberships m
    where m.business_id = p_business_id and m.user_id = p_owner_user_id
      and m.role = 'owner')
  then raise exception 'proposal_owner_required' using errcode = '42501'; end if;

  if p_action = 'approve' and proposal_row.status = 'draft' then
    insert into public.supervisor_approvals
      (business_id,proposal_id,owner_user_id,approved_revision,effect_hash)
      values (p_business_id,proposal_row.id,p_owner_user_id,
        proposal_row.revision,proposal_row.effect_hash);
    update public.supervisor_proposals set status = 'approved',
      approved_at = now(), approved_by = p_owner_user_id,
      revision = revision + 1, updated_at = now()
      where id = proposal_row.id;
  elsif p_action = 'reject' and proposal_row.status in ('draft','approved') then
    update public.supervisor_proposals set status = 'rejected',
      revision = revision + 1, updated_at = now()
      where id = proposal_row.id;
  elsif p_action = 'finish_monitor'
    and proposal_row.status in ('manual_confirmed','committed')
    and proposal_row.monitoring_start_date is not null
    and current_date > proposal_row.monitoring_start_date
      + ((proposal_row.monitor_spec->>'durationDays')::integer + 13)
    and exists (select 1 from public.supervisor_reports r
      where r.business_id = proposal_row.business_id
        and r.proposal_id = proposal_row.id
        and r.status in ('complete','insufficient_evidence')) then
    update public.supervisor_proposals set status = 'monitored',
      revision = revision + 1, updated_at = now()
      where id = proposal_row.id;
  elsif p_action = 'manual_confirmed' and proposal_row.status = 'manual_pending'
    and p_monitoring_start_date is not null
    and p_monitoring_start_date between current_date and current_date + 3 then
    update public.supervisor_proposals set status = 'manual_confirmed',
      manual_confirmed_at = now(), monitoring_start_date = p_monitoring_start_date,
      revision = revision + 1, updated_at = now()
      where id = proposal_row.id;
  else
    raise exception 'invalid_supervisor_proposal_transition' using errcode = 'P0001';
  end if;

  select * into proposal_row from public.supervisor_proposals
    where business_id = p_business_id and owner_user_id = p_owner_user_id
      and id = p_proposal_id;
  return proposal_row;
end $$;
revoke all on function public.supervisor_transition_proposal(uuid,uuid,uuid,integer,text,date)
  from public, anon, authenticated;
grant execute on function public.supervisor_transition_proposal(uuid,uuid,uuid,integer,text,date)
  to service_role;
