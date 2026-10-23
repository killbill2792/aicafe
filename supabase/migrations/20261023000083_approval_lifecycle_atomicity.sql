-- Approval-card lifecycle corrections. No new ledger/table and no autonomous retry.
-- (1) Record a definitively NO-WRITE stale CAS outcome, rather than leaving
--     claimed approvals in executing forever.
-- (2) Replace an owner's editable draft and reject the prior revision in ONE
--     database transaction, under the same proposal row lock used by Approve.
-- These functions may only be invoked by the authenticated API through the
-- existing service-role repository; owner clients retain read-only ledger RLS.

alter table public.supervisor_proposals
  drop constraint if exists supervisor_proposals_status_check;
alter table public.supervisor_proposals
  add constraint supervisor_proposals_status_check
  check (status in ('draft','approved','executing','committed',
    'manual_pending','manual_confirmed','monitored','rejected','expired','stale'));

create function public.supervisor_mark_stale_menu_price(
  p_business_id uuid,
  p_owner_user_id uuid,
  p_thread_id uuid,
  p_proposal_id uuid,
  p_revision int
) returns public.supervisor_proposals
language plpgsql security definer set search_path=public as $$
declare
  p public.supervisor_proposals;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into p from public.supervisor_proposals
   where business_id=p_business_id and owner_user_id=p_owner_user_id
     and thread_id=p_thread_id and id=p_proposal_id
   for update;
  if p.id is null or p.revision <> p_revision or p.status <> 'executing'
     or p.capability_id <> 'alex.menu_price_change.v1'
  then raise exception 'proposal_revision_conflict'; end if;
  if not exists (
    select 1 from public.memberships m
     where m.business_id=p_business_id and m.user_id=p_owner_user_id
       and m.role='owner'
  ) then raise exception 'proposal_owner_required'; end if;
  if not exists (
    select 1 from public.supervisor_approvals a
     where a.business_id=p_business_id and a.proposal_id=p.id
       and a.owner_user_id=p_owner_user_id and a.effect_hash=p.effect_hash
       and a.approved_revision=p.revision-2
  ) then raise exception 'approval_missing_or_changed'; end if;
  update public.supervisor_proposals
    set status='stale', revision=revision+1, updated_at=now()
    where id=p.id
    returning * into p;
  return p;
end $$;
revoke all on function public.supervisor_mark_stale_menu_price(
  uuid,uuid,uuid,uuid,int
) from public, anon, authenticated;
grant execute on function public.supervisor_mark_stale_menu_price(
  uuid,uuid,uuid,uuid,int
) to service_role;

create function public.supervisor_replace_menu_price_draft(
  p_business_id uuid,
  p_owner_user_id uuid,
  p_thread_id uuid,
  p_proposal_id uuid,
  p_revision int,
  p_request_key uuid,
  p_effect jsonb,
  p_effect_hash text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  old_row public.supervisor_proposals;
  new_row public.supervisor_proposals;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  select * into old_row from public.supervisor_proposals
   where business_id=p_business_id and owner_user_id=p_owner_user_id
     and thread_id=p_thread_id and id=p_proposal_id
   for update;
  if old_row.id is null or old_row.revision <> p_revision
     or old_row.status <> 'draft'
     or old_row.capability_id <> 'alex.menu_price_change.v1'
     or old_row.capability_version <> 1
  then raise exception 'proposal_revision_conflict'; end if;
  if not exists (
    select 1 from public.memberships m
     where m.business_id=p_business_id and m.user_id=p_owner_user_id
       and m.role='owner'
  ) then raise exception 'proposal_owner_required'; end if;
  if jsonb_typeof(p_effect) is distinct from 'object'
     or p_effect->>'productId' is distinct from old_row.canonical_effect_payload->>'productId'
     or p_effect->>'oldPriceCents' is distinct from old_row.canonical_effect_payload->>'oldPriceCents'
     or p_effect->>'currency' is distinct from old_row.canonical_effect_payload->>'currency'
     or (p_effect->>'newPriceCents') !~ '^[0-9]{1,6}$'
     or (p_effect->>'newPriceCents')::bigint not between 1 and 100000
     or p_effect->>'newPriceCents' is not distinct from old_row.canonical_effect_payload->>'oldPriceCents'
     or p_effect_hash !~ '^[a-f0-9]{64}$'
  then raise exception 'invalid_edited_menu_price_effect'; end if;

  -- The immutability trigger permits only the revisioned status transition.
  -- If the INSERT fails for any reason (including uniqueness/DB outage), the
  -- entire transaction rolls back and the original draft stays actionable.
  update public.supervisor_proposals
    set status='rejected',revision=revision+1,updated_at=now()
    where id=old_row.id
    returning * into old_row;

  insert into public.supervisor_proposals(
    business_id,owner_user_id,thread_id,request_key,
    capability_id,capability_version,canonical_effect_payload,effect_hash,
    baseline,monitor_spec,locale
  ) values (
    old_row.business_id,old_row.owner_user_id,old_row.thread_id,p_request_key,
    old_row.capability_id,old_row.capability_version,p_effect,p_effect_hash,
    old_row.baseline || jsonb_build_object(
      'editedByOwner',true,'editedFrom',old_row.id::text),
    old_row.monitor_spec,old_row.locale
  ) returning * into new_row;
  return jsonb_build_object('replaced',to_jsonb(old_row),'proposal',to_jsonb(new_row));
end $$;
revoke all on function public.supervisor_replace_menu_price_draft(
  uuid,uuid,uuid,uuid,int,uuid,jsonb,text
) from public, anon, authenticated;
grant execute on function public.supervisor_replace_menu_price_draft(
  uuid,uuid,uuid,uuid,int,uuid,jsonb,text
) to service_role;
