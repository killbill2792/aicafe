-- Task 16C: one owner-scoped access ledger for existing read-only external tools.
-- Existing Gmail scopes remain in connector_accounts; this does not copy credentials.
-- Absent rows inherit current behavior: public web enabled, file processing only
-- for explicitly selected owner attachments. A denial always wins.
set lock_timeout='3s';
set statement_timeout='30s';

create table public.supervisor_external_access (
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check(kind in ('public_web','file_read','attachment')),
  resource_key text not null,
  allowed boolean not null,
  revision bigint not null check(revision >= 1),
  updated_at timestamptz not null default now(),
  primary key(business_id,owner_user_id,kind,resource_key),
  check ((kind='public_web' and resource_key='public')
      or (kind='file_read' and resource_key='all')
      or (kind='attachment' and resource_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
-- New service-only authorization ledger: never grant authenticated direct writes.
-- Reason: New service-only permission or audit record, protect it with RLS before granting access.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_external_access enable row level security;
revoke all on public.supervisor_external_access from public,anon,authenticated;
grant select,insert,update,delete on public.supervisor_external_access to service_role;

create table public.supervisor_external_access_audit (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  resource_key text not null,
  previous_allowed boolean not null,
  allowed boolean not null,
  revision bigint not null,
  changed_at timestamptz not null default now()
);
create index supervisor_external_access_audit_scope
  on public.supervisor_external_access_audit (business_id,owner_user_id,changed_at desc);
-- New immutable service-only change receipts; no model text, file bodies or tokens.
-- Reason: New service-only permission or audit record, protect it with RLS before granting access.
-- squawk-ignore ban-alter-row-level-security
alter table public.supervisor_external_access_audit enable row level security;
revoke all on public.supervisor_external_access_audit from public,anon,authenticated;
grant select,insert on public.supervisor_external_access_audit to service_role;

create function public.supervisor_change_external_access (
  p_business_id uuid, p_owner_user_id uuid, p_kind text,
  p_resource_key text, p_allowed boolean, p_expected_revision bigint
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare current_row public.supervisor_external_access;
  default_allowed boolean := true;
  next_revision bigint;
  canonical_key text;
begin
  canonical_key:=case when p_kind='attachment' then lower(p_resource_key) else p_resource_key end;
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode='42501'; end if;
  if not exists(select 1 from public.memberships m
      where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
  then raise exception 'external_access_owner_required' using errcode='42501'; end if;
  if p_kind not in ('public_web','file_read','attachment')
    or (p_kind='public_web' and canonical_key<>'public')
    or (p_kind='file_read' and canonical_key<>'all')
    or (p_kind='attachment' and (
      canonical_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_allowed))
    or p_allowed is null or p_expected_revision is null or p_expected_revision<0
  then raise exception 'external_access_input_invalid' using errcode='22023'; end if;
  if p_kind='attachment' and not exists (
    select 1 from public.ai_attachments a
      where a.id=canonical_key::uuid and a.business_id=p_business_id
        and a.owner_user_id=p_owner_user_id
  ) then raise exception 'external_access_attachment_scope' using errcode='42501'; end if;
  select * into current_row from public.supervisor_external_access
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and kind=p_kind and resource_key=canonical_key for update;
  if current_row.revision is null then
    if p_expected_revision<>0 then raise exception 'external_access_stale' using errcode='40001'; end if;
    insert into public.supervisor_external_access
      (business_id,owner_user_id,kind,resource_key,allowed,revision)
    values (p_business_id,p_owner_user_id,p_kind,canonical_key,p_allowed,1);
    next_revision:=1;
  else
    if current_row.revision<>p_expected_revision then
      raise exception 'external_access_stale' using errcode='40001'; end if;
    if p_kind='attachment' and current_row.allowed=false then
      raise exception 'external_access_attachment_revoked' using errcode='42501'; end if;
    if current_row.allowed=p_allowed then
      return jsonb_build_object('allowed',p_allowed,'revision',current_row.revision);
    end if;
    update public.supervisor_external_access
      set allowed=p_allowed,revision=revision+1,updated_at=now()
      where business_id=p_business_id and owner_user_id=p_owner_user_id
        and kind=p_kind and resource_key=canonical_key
      returning revision into next_revision;
  end if;
  insert into public.supervisor_external_access_audit
    (business_id,owner_user_id,kind,resource_key,previous_allowed,allowed,revision)
  values (p_business_id,p_owner_user_id,p_kind,canonical_key,
    coalesce(current_row.allowed,default_allowed),p_allowed,next_revision);
  return jsonb_build_object('allowed',p_allowed,'revision',next_revision);
end $$;
revoke all on function public.supervisor_change_external_access(uuid,uuid,text,text,boolean,bigint)
  from public,anon,authenticated;
grant execute on function public.supervisor_change_external_access(uuid,uuid,text,text,boolean,bigint)
  to service_role;

-- Persist original Google subject on new provider receipts so read-only
-- reconciliation may survive a permission generation bump but NEVER verify a
-- receipt in a different linked mailbox. Old receipts remain nullable and
-- are still bound to the original account ID + effect sender address.
alter table public.connector_provider_receipts
  add column account_provider_subject text;

-- Gmail operation switches reuse Task 11's account/credential generation;
-- no duplicate connector registry and no stale proposal can become valid
-- after an owner disables and later re-enables a permission.
create table public.connector_operation_change_receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  owner_user_id uuid not null,
  account_id uuid not null,
  before_operations text[] not null,
  after_operations text[] not null,
  account_generation bigint not null,
  changed_at timestamptz not null default now(),
  foreign key(account_id,business_id,owner_user_id)
    references public.connector_accounts(id,business_id,owner_user_id) on delete cascade
);
create index connector_operation_change_receipts_owner
  on public.connector_operation_change_receipts (business_id,owner_user_id,changed_at desc);
-- Service-only permission-change audit; never stores a token.
-- Reason: New service-only permission or audit record, protect it with RLS before granting access.
-- squawk-ignore ban-alter-row-level-security
alter table public.connector_operation_change_receipts enable row level security;
revoke all on public.connector_operation_change_receipts from public,anon,authenticated;
grant select,insert on public.connector_operation_change_receipts to service_role;

create function public.supervisor_change_gmail_operations(
  p_business_id uuid,p_owner_user_id uuid,p_account_id uuid,
  p_expected_generation bigint,p_operations text[]
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a public.connector_accounts; next_generation bigint;
  normalized text[];
begin
 if auth.role() is distinct from 'service_role' then
   raise exception 'service_role_only' using errcode='42501'; end if;
 if not exists(select 1 from public.memberships m
   where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
 then raise exception 'gmail_operation_owner_required' using errcode='42501'; end if;
 if p_operations is null or
   not (p_operations <@ array['read','draft','send','organize']::text[]) or
   array_position(p_operations,null) is not null
 then raise exception 'gmail_operations_invalid' using errcode='22023'; end if;
 select array_agg(operation order by operation) into normalized
   from (select distinct unnest(p_operations) as operation) vals;
 normalized:=coalesce(normalized,array[]::text[]);
 select * into a from public.connector_accounts
   where id=p_account_id and business_id=p_business_id and owner_user_id=p_owner_user_id
     and provider='gmail' for update;
 if a.id is null or a.status<>'active' or a.generation<>p_expected_generation
 then raise exception 'gmail_operation_stale' using errcode='40001'; end if;
 if normalized = (select coalesce(array_agg(value order by value),array[]::text[])
   from unnest(a.enabled_operations) as v(value))
 then return jsonb_build_object('generation',a.generation,'operations',normalized); end if;
 next_generation:=a.generation+1;
 -- Bump BOTH copies atomically or roll back the entire grant/revocation.
 update public.connector_credentials set generation=next_generation,updated_at=now()
   where account_id=a.id and generation=a.generation;
 if not found then raise exception 'gmail_credentials_stale' using errcode='40001'; end if;
 update public.connector_accounts set enabled_operations=normalized,
   generation=next_generation,updated_at=now() where id=a.id;
 insert into public.connector_operation_change_receipts
   (business_id,owner_user_id,account_id,before_operations,after_operations,account_generation)
 values(p_business_id,p_owner_user_id,p_account_id,a.enabled_operations,normalized,next_generation);
 return jsonb_build_object('generation',next_generation,'operations',normalized);
end $$;
revoke all on function public.supervisor_change_gmail_operations(uuid,uuid,uuid,bigint,text[])
  from public,anon,authenticated;
grant execute on function public.supervisor_change_gmail_operations(uuid,uuid,uuid,bigint,text[])
  to service_role;
