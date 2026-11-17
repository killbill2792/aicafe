-- Task 14C: Gmail-first, explicitly owner-authorized supplier communication.
-- Additive: apply only in a separately owner-approved release.
set lock_timeout='3s';
set statement_timeout='30s';

-- Owner-verified supplier channel, never guessed from email/web text.
create table public.cafe_supplier_order_contacts(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 supplier_id uuid not null,
 owner_user_id uuid not null references auth.users(id),
 channel text not null check(channel in ('gmail','phone','portal','in_person','other')),
 email text check(email is null or (length(email) between 3 and 320 and email !~ '[[:cntrl:][:space:]]')),
 details text check(details is null or length(details)<=600),
 verified_at timestamptz not null default now(),
 revoked_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(business_id,id),
 unique(business_id,supplier_id),
 foreign key(business_id,supplier_id) references public.cafe_suppliers(business_id,id),
 check ((channel='gmail' and email is not null) or (channel<>'gmail' and email is null))
);
-- Reason: New owner-scoped supplier communication table requires row-level policies from creation.
-- squawk-ignore ban-alter-row-level-security
alter table public.cafe_supplier_order_contacts enable row level security;
create policy "owner reads supplier ordering contacts" on public.cafe_supplier_order_contacts
 for select to authenticated using(owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=cafe_supplier_order_contacts.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner adds supplier ordering contacts" on public.cafe_supplier_order_contacts
 for insert to authenticated with check(owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=cafe_supplier_order_contacts.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner updates supplier ordering contacts" on public.cafe_supplier_order_contacts
 for update to authenticated using(owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=cafe_supplier_order_contacts.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'))
 with check(owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=cafe_supplier_order_contacts.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));
revoke all on public.cafe_supplier_order_contacts from public,anon,authenticated;
grant select,insert,update on public.cafe_supplier_order_contacts to authenticated;
grant all on public.cafe_supplier_order_contacts to service_role;

-- Exactly one vendor-send reservation per canonical approved PO. It is never
-- inferred from a Gmail draft or provider HTTP success alone.
create table public.purchase_order_dispatches(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 owner_user_id uuid not null references auth.users(id),
 contact_id uuid not null,
 proposal_id uuid not null,
 po_revision bigint not null check(po_revision>=1),
 po_effect_hash text not null check(po_effect_hash ~ '^[a-f0-9]{64}$'),
 recipient_email text not null,
 state text not null default 'prepared'
   check(state in ('prepared','reserved','provider_accepted')),
 reserved_at timestamptz,
 provider_receipt_id uuid,
 provider_accepted_at timestamptz,
 created_at timestamptz not null default now(),
 unique(business_id,purchase_order_id),
 unique(business_id,proposal_id),
 foreign key(business_id,purchase_order_id) references public.purchase_orders(business_id,id),
 foreign key(business_id,contact_id) references public.cafe_supplier_order_contacts(business_id,id),
 foreign key(business_id,proposal_id) references public.supervisor_proposals(business_id,id),
 foreign key(provider_receipt_id) references public.connector_provider_receipts(id),
 check ((state='prepared' and reserved_at is null and provider_accepted_at is null)
 or (state='reserved' and reserved_at is not null and provider_accepted_at is null)
 or (state='provider_accepted' and reserved_at is not null and provider_receipt_id is not null
  and provider_accepted_at is not null))
);
-- Reason: New owner-scoped supplier communication table requires row-level policies from creation.
-- squawk-ignore ban-alter-row-level-security
alter table public.purchase_order_dispatches enable row level security;
create policy "owner reads supplier dispatches" on public.purchase_order_dispatches for select to authenticated
 using(owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=purchase_order_dispatches.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));
revoke all on public.purchase_order_dispatches from public,anon,authenticated;
grant select on public.purchase_order_dispatches to authenticated;
grant all on public.purchase_order_dispatches to service_role;

-- An owner's reply about phone/portal/off-channel outcomes remains distinctly
-- owner-reported evidence; it is not a Gmail or supplier receipt.
create table public.purchase_order_channel_reports(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 owner_user_id uuid not null references auth.users(id),
 channel text not null check(channel in ('gmail','phone','portal','in_person','other')),
 outcome text not null check(outcome in ('unknown','not_contacted','supplier_contacted',
   'supplier_acknowledged','supplier_accepted','supplier_declined')),
 note text not null check(length(btrim(note)) between 1 and 1000),
 reported_at timestamptz not null default now(),
 foreign key(business_id,purchase_order_id) references public.purchase_orders(business_id,id)
);
create index purchase_order_channel_reports_recent on public.purchase_order_channel_reports
 (business_id,purchase_order_id,reported_at desc);
-- Reason: New owner-scoped supplier communication table requires row-level policies from creation.
-- squawk-ignore ban-alter-row-level-security
alter table public.purchase_order_channel_reports enable row level security;
create policy "owner reads own channel reports" on public.purchase_order_channel_reports for select to authenticated
 using(owner_user_id=(select auth.uid()) and exists(select 1 from public.memberships m
  join public.purchase_orders po on po.business_id=m.business_id
   and po.id=purchase_order_channel_reports.purchase_order_id
   and po.owner_user_id=m.user_id
  where m.business_id=purchase_order_channel_reports.business_id and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner adds own channel reports" on public.purchase_order_channel_reports for insert to authenticated
 with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.memberships m
  join public.purchase_orders po on po.business_id=m.business_id
   and po.id=purchase_order_channel_reports.purchase_order_id
   and po.owner_user_id=m.user_id
  where m.business_id=purchase_order_channel_reports.business_id and m.user_id=(select auth.uid()) and m.role='owner'));
revoke all on public.purchase_order_channel_reports from public,anon,authenticated;
grant select,insert on public.purchase_order_channel_reports to authenticated;
grant all on public.purchase_order_channel_reports to service_role;
-- Owner-reported SUPPLIER acceptance/decline closes only the matching
-- previously raised supplier-dispatch question. Gmail SENT alone never closes
-- this task. This is a source-verified update, not an AI-generated success.
create function public.supervisor_close_vendor_priority_on_report()
 returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.outcome in ('supplier_accepted','supplier_declined') then
  update public.operating_tasks t set
   status='handled',resolved_at=now(),updated_at=now()
  where t.business_id=new.business_id and t.owner_user_id=new.owner_user_id
    and t.kind='priority_notice' and t.status='needs_owner'
    and t.payload->>'sourceType'='supplier_dispatch'
    and t.payload->>'sourceId'=new.purchase_order_id::text;
 end if;
 return new;
end $$;
create trigger supplier_priority_close_on_owner_report
 after insert on public.purchase_order_channel_reports
 for each row execute function public.supervisor_close_vendor_priority_on_report();


-- This transaction is the one vendor-specific PRE-SEND gate, called from the
-- EXISTING Gmail provider. A second vendor proposal for one PO cannot send.
create function public.supervisor_reserve_supplier_gmail_send(
 p_business_id uuid,p_owner_user_id uuid,p_proposal_id uuid,p_effect_hash text
) returns boolean language plpgsql security definer set search_path=public as $$
declare d public.purchase_order_dispatches; p public.supervisor_proposals;
  po public.purchase_orders; c public.cafe_supplier_order_contacts;
  a public.supervisor_effect_attempts;
begin
 if coalesce(auth.role(),'')<>'service_role' then
   raise exception 'service_role_only' using errcode='42501';end if;
 if not exists(select 1 from public.memberships m
   where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
 then raise exception 'supplier_owner_revoked' using errcode='42501';end if;
 select * into d from public.purchase_order_dispatches where business_id=p_business_id
   and owner_user_id=p_owner_user_id and proposal_id=p_proposal_id for update;
 if d.id is null or d.state<>'prepared' then
   raise exception 'supplier_send_already_reserved_or_missing' using errcode='P0001';end if;
 select * into p from public.supervisor_proposals where business_id=p_business_id
   and owner_user_id=p_owner_user_id and id=p_proposal_id for share;
 select * into po from public.purchase_orders where business_id=p_business_id
   and owner_user_id=p_owner_user_id and id=d.purchase_order_id for share;
 select * into c from public.cafe_supplier_order_contacts where business_id=p_business_id
   and owner_user_id=p_owner_user_id and id=d.contact_id for share;
 select * into a from public.supervisor_effect_attempts where business_id=p_business_id
   and proposal_id=p_proposal_id for share;
 if p.id is null or p.status<>'executing' or p.capability_id<>'alex.gmail_effect.v1'
   or p.capability_version<>1 or p.effect_hash<>p_effect_hash
   or a.id is null or a.effect_hash<>p_effect_hash or a.state<>'executing'
   or a.authorization_kind<>'click'
   or p.canonical_effect_payload->>'operation' is distinct from 'send'
   or p.canonical_effect_payload->'to' is distinct from jsonb_build_array(d.recipient_email)
   or p.canonical_effect_payload->'cc' is distinct from '[]'::jsonb
   or p.canonical_effect_payload->'bcc' is distinct from '[]'::jsonb
   or po.id is null or po.status<>'approved_for_ordering'
   or po.revision<>d.po_revision or po.effect_hash<>d.po_effect_hash
   or po.supplier_id<>c.supplier_id
   or c.id is null or c.channel<>'gmail' or c.revoked_at is not null
   or lower(c.email)<>lower(d.recipient_email)
 then raise exception 'supplier_send_authorization_changed' using errcode='P0001';end if;
 update public.purchase_order_dispatches set state='reserved',reserved_at=now()
 where id=d.id and state='prepared';
 return true;
end $$;
revoke all on function public.supervisor_reserve_supplier_gmail_send(uuid,uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.supervisor_reserve_supplier_gmail_send(uuid,uuid,uuid,text) to service_role;

-- A prepared approval is NOT an attempted send. The owner may correct its
-- verified address or cancel its draft and request a NEW separate click. This
-- transaction replaces only a provably unsent draft, never a reserved,
-- uncertain, executing, approved or provider-accepted effect. Atomic locks
-- serialize a competing owner click and prevent two actionable approval cards.
create function public.supervisor_rebind_supplier_gmail_draft(
 p_business_id uuid,p_owner_user_id uuid,p_purchase_order_id uuid,
 p_new_proposal_id uuid
) returns boolean language plpgsql security definer set search_path=public as $$
declare d public.purchase_order_dispatches; old_p public.supervisor_proposals;
 new_p public.supervisor_proposals; po public.purchase_orders;
 c public.cafe_supplier_order_contacts;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 if not exists(select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=p_owner_user_id and m.role='owner')
 then raise exception 'supplier_owner_revoked' using errcode='42501';end if;
 select * into d from public.purchase_order_dispatches
  where business_id=p_business_id and owner_user_id=p_owner_user_id
    and purchase_order_id=p_purchase_order_id for update;
 if d.id is null or d.state<>'prepared' or d.reserved_at is not null
    or d.provider_receipt_id is not null or d.provider_accepted_at is not null
 then raise exception 'supplier_send_already_reserved_or_missing' using errcode='P0001';end if;
 select * into old_p from public.supervisor_proposals
  where business_id=p_business_id and owner_user_id=p_owner_user_id
    and id=d.proposal_id for update;
 if old_p.id is null or old_p.capability_id<>'alex.gmail_effect.v1'
    or old_p.capability_version<>1 or old_p.status not in ('draft','rejected')
    or exists(select 1 from public.supervisor_approvals a
      where a.business_id=p_business_id and a.proposal_id=d.proposal_id)
    or exists(select 1 from public.supervisor_effect_attempts a
      where a.business_id=p_business_id and a.proposal_id=d.proposal_id)
    or exists(select 1 from public.connector_provider_receipts r
      where r.business_id=p_business_id and r.proposal_id=d.proposal_id)
 then raise exception 'supplier_previous_send_not_proven_unsent' using errcode='P0001';end if;
 select * into po from public.purchase_orders
  where business_id=p_business_id and owner_user_id=p_owner_user_id
   and id=p_purchase_order_id for share;
 if po.id is null or po.status<>'approved_for_ordering'
 then raise exception 'supplier_po_no_longer_approved' using errcode='P0001';end if;
 select * into c from public.cafe_supplier_order_contacts
  where business_id=p_business_id and owner_user_id=p_owner_user_id
    and supplier_id=po.supplier_id for share;
 if c.id is null or c.channel<>'gmail' or c.revoked_at is not null
    or c.email is null or c.verified_at is null
 then raise exception 'supplier_ordering_contact_unverified' using errcode='P0001';end if;
 select * into new_p from public.supervisor_proposals
  where business_id=p_business_id and owner_user_id=p_owner_user_id
    and id=p_new_proposal_id for update;
 if new_p.id is null or new_p.status<>'draft'
   or new_p.capability_id<>'alex.gmail_effect.v1'
   or new_p.capability_version<>1
   or new_p.thread_id<>old_p.thread_id
   or new_p.canonical_effect_payload->>'operation' is distinct from 'send'
   or new_p.canonical_effect_payload->'to' is distinct from jsonb_build_array(c.email)
   or new_p.canonical_effect_payload->'cc' is distinct from '[]'::jsonb
   or new_p.canonical_effect_payload->'bcc' is distinct from '[]'::jsonb
   or exists(select 1 from public.supervisor_approvals a
     where a.business_id=p_business_id and a.proposal_id=p_new_proposal_id)
   or exists(select 1 from public.supervisor_effect_attempts a
     where a.business_id=p_business_id and a.proposal_id=p_new_proposal_id)
   or exists(select 1 from public.connector_provider_receipts r
     where r.business_id=p_business_id and r.proposal_id=p_new_proposal_id)
   or new_p.canonical_effect_payload->>'subject' is distinct from ('Purchase order '||po.id::text)
 then raise exception 'supplier_new_draft_invalid' using errcode='P0001';end if;
 if p_new_proposal_id=d.proposal_id then
   -- Idempotent replay of the SAME saved draft only when the contact/snapshot
   -- is unchanged. An updated recipient must use a new immutable effect.
   if d.contact_id=c.id and d.recipient_email=c.email and
     d.po_revision=po.revision and d.po_effect_hash=po.effect_hash
   then return true;end if;
   raise exception 'supplier_draft_replay_changed' using errcode='P0001';
 end if;
 if old_p.status='draft' then
  update public.supervisor_proposals set status='rejected',
    revision=old_p.revision+1,updated_at=now()
   where business_id=p_business_id and id=old_p.id;
 end if;
 update public.purchase_order_dispatches
  set proposal_id=new_p.id,contact_id=c.id,recipient_email=c.email,
    po_revision=po.revision,po_effect_hash=po.effect_hash
  where business_id=p_business_id and id=d.id and state='prepared';
 return true;
end $$;
revoke all on function public.supervisor_rebind_supplier_gmail_draft(uuid,uuid,uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.supervisor_rebind_supplier_gmail_draft(uuid,uuid,uuid,uuid)
 to service_role;


-- Independent Gmail readback is persisted by Task11. One trigger updates the
-- same dispatch ledger only after the connector provider receipt is verified.
create function public.supervisor_vendor_gmail_receipt_verified()
 returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.state='verified' and new.operation='send' and
    new.provider_message_id is not null and new.provider_accepted_at is not null then
   update public.purchase_order_dispatches d set state='provider_accepted',
     provider_receipt_id=new.id,provider_accepted_at=new.provider_accepted_at
   where d.business_id=new.business_id and d.owner_user_id=new.owner_user_id
    and d.proposal_id=new.proposal_id and d.state in ('reserved','provider_accepted');
 end if;
 return new;
end $$;
create trigger supplier_gmail_provider_receipt
 after insert or update of state on public.connector_provider_receipts
 for each row execute function public.supervisor_vendor_gmail_receipt_verified();

-- Keep the ONE priority-notice and owner-thread writer; extend its trusted
-- source set rather than adding a second cron/reminder system.
create or replace function public.post_supervisor_priority_notice(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,
  p_stable_key text,p_reason text,p_as_of timestamptz,
  p_routine_id uuid default null,p_run_id uuid default null,p_lease_token uuid default null
) returns boolean
language plpgsql security definer set search_path=public as $$
declare v_task_id text;v_msg_id uuid;v_hash text;v_found boolean;
        v_inserted_task_id text;v_o public.supervisor_routine_occurrences;
        v_r public.supervisor_routines;
begin
  if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'Service role required' using errcode='42501'; end if;
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then raise exception 'Owner or thread revoked' using errcode='42501'; end if;
  if p_source_type not in ('alert','operating_task','supplier_po','supplier_dispatch') or p_source_id is null
    or length(p_source_id) not between 1 and 256
    or p_revision_hash !~ '^[a-f0-9]{64}$' or p_stable_key !~ '^[a-f0-9]{64}$'
    or p_reason not in ('Overdue item needs review','Actionable café alert needs review',
      'Owner task needs review','Task response needs review',
      'Supplier purchase-order draft needs your approval',
       'Approved order unresolved: was the supplier contacted by Gmail, phone or portal, and what did they confirm?') or p_as_of is null
  then raise exception 'Invalid priority evidence' using errcode='22023'; end if;
  if p_routine_id is not null then
    if p_run_id is null or p_lease_token is null
    then raise exception 'Incomplete routine lease' using errcode='42501'; end if;
    select * into v_r from public.supervisor_routines
      where business_id=p_business_id and id=p_routine_id for update;
    select * into v_o from public.supervisor_routine_occurrences
      where business_id=p_business_id and routine_id=p_routine_id and run_id=p_run_id for update;
    if v_r.status<>'active' or v_o.state<>'running' or
      v_o.revision<>v_r.revision or v_o.lease_token is distinct from p_lease_token
      or v_o.lease_until<=p_as_of then
      raise exception 'Routine lease revoked or expired' using errcode='42501'; end if;
    if v_r.owner_user_id<>p_owner_user_id or v_r.thread_id<>p_thread_id
    then raise exception 'Routine owner mismatch' using errcode='42501'; end if;
  elsif p_run_id is not null or p_lease_token is not null
  then raise exception 'Invalid independent notice lease' using errcode='42501'; end if;
  if p_source_type='alert' then
    select exists(select 1 from public.alerts a where a.business_id=p_business_id
      and a.id::text=p_source_id and a.status in ('new','seen')) into v_found;
  elsif p_source_type='supplier_po' then
    select exists(select 1 from public.supervisor_proposals p
      where p.business_id=p_business_id and p.id::text=p_source_id
        and p.owner_user_id=p_owner_user_id and p.thread_id=p_thread_id
        and p.capability_id='maya.supplier_purchase_order.v1'
        and p.status='draft'
        and p.created_at<=p_as_of-interval '2 hours'
        for share) into v_found;
  elsif p_source_type='supplier_dispatch' then
    select exists(select 1 from public.purchase_orders po
      join public.supervisor_proposals origin on origin.business_id=po.business_id
        and origin.id=po.proposal_id
      where po.business_id=p_business_id and po.owner_user_id=p_owner_user_id
        and po.id::text=p_source_id and origin.thread_id=p_thread_id
        and po.status='approved_for_ordering'
        and po.approved_at<=p_as_of-interval '2 hours'
        and not exists(select 1 from public.purchase_order_channel_reports r
          where r.business_id=po.business_id and r.purchase_order_id=po.id
            and r.outcome in ('supplier_accepted','supplier_declined'))
      for share) into v_found;
  else
    select exists(select 1 from public.operating_tasks t where t.business_id=p_business_id
      and t.id=p_source_id and t.kind not in
        ('priority_notice','commitment','event_plan','event_change','event_report')
      and t.status in ('needs_owner','needs_response')
      and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)) into v_found;
  end if;
  if not v_found then return false; end if;
  v_task_id:='priority:'||p_stable_key;
  insert into public.operating_tasks
    (business_id,id,owner_user_id,agent_id,kind,status,payload,confidence,evidence,
      entity_type,dedupe_key)
  values(p_business_id,v_task_id,p_owner_user_id,
    case when p_source_type in ('supplier_po','supplier_dispatch') then 'maya' else 'leo' end,
    'priority_notice','needs_owner',
    jsonb_build_object('title',p_reason,'threadId',p_thread_id::text,
      'sourceType',p_source_type,'sourceId',p_source_id,
      'priorityReason',p_reason,'asOf',p_as_of::text),
    'high',jsonb_build_array(jsonb_build_object('source',p_source_type,
      'facts',jsonb_build_object('sourceId',p_source_id,
        'revisionHash',p_revision_hash,'asOf',p_as_of::text))),
    'priority_source',p_stable_key)
  on conflict do nothing returning id into v_inserted_task_id;
  v_hash:=md5('priority-notice:'||p_business_id::text||':'||p_owner_user_id::text||':'||v_task_id);
  v_msg_id:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
    substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
  insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
    content_type,structured_content,grounding)
  values(v_msg_id,p_business_id,p_thread_id,p_owner_user_id,'supervisor','blocks',
    jsonb_build_array(jsonb_build_object('type','text','text',p_reason)),
    jsonb_build_object('status','verified','intent','priority_notice',
      'evidence',jsonb_build_array(jsonb_build_object('source',p_source_type,
        'identifier',p_source_id,'asOf',p_as_of::text))))
  on conflict(id) do nothing;
  return v_inserted_task_id is not null;
end $$;
revoke all on function public.post_supervisor_priority_notice(uuid,uuid,uuid,text,text,text,text,text,timestamptz,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.post_supervisor_priority_notice(uuid,uuid,uuid,text,text,text,text,text,timestamptz,uuid,uuid,uuid)
  to service_role;
