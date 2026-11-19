-- 14D receiving/invoice source facts, not a second inventory or expense ledger.
-- Draft additive schema. No write RPC or direct mutation grant in this slice;
-- later gateway integration must prove source authentication, CAS and readback.
set lock_timeout='3s';
set statement_timeout='30s';

-- The existing primary IDs are unique. These scoped indexes allow composite
-- foreign keys to enforce supplier, order, owner and ingredient lineage.
create unique index purchase_orders_receiving_scope_uq
 on public.purchase_orders(business_id,id,supplier_id,owner_user_id);
create unique index purchase_order_lines_receiving_scope_uq
 on public.purchase_order_lines(business_id,purchase_order_id,id,ingredient_id);
create unique index expenses_receiving_scope_uq on public.expenses(business_id,id);

create table public.purchase_receipts(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 supplier_id uuid not null,
 owner_user_id uuid not null,
 -- Stable verified semantic delivery reference, not a chat/attachment ID.
 receiving_reference text not null check(length(btrim(receiving_reference)) between 1 and 200),
 revision bigint not null check(revision between 1 and 9007199254740991),
 received_on date not null,
 source_ref text not null check(length(btrim(source_ref)) between 1 and 512),
 source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 -- Actual authenticated owner/receiving-side confirmation, never supplier
 -- invoice, shipment notice or unsigned supplier delivery document.
 verification_kind text not null check(verification_kind in ('owner_confirmed','authenticated_receiving_record')),
 verification_ref text not null check(length(btrim(verification_ref)) between 1 and 512),
 verified_at timestamptz not null,
 created_at timestamptz not null default now(),
 unique(business_id,purchase_order_id,id),
 unique(business_id,purchase_order_id,receiving_reference,revision),
 foreign key(business_id,purchase_order_id,supplier_id,owner_user_id)
  references public.purchase_orders(business_id,id,supplier_id,owner_user_id)
);
create table public.purchase_receipt_lines(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 receipt_id uuid not null,
 source_line_key text not null check(length(btrim(source_line_key)) between 1 and 160),
 order_line_id uuid,
 ingredient_id uuid,
 source_item_name text not null check(length(btrim(source_item_name)) between 1 and 200),
 -- Canonical base quantity scaled by 10,000. Unmapped product/unit remains
 -- null and must not enter the stock writer.
 received_base4 bigint check(received_base4 between 0 and 10000000000000),
 accepted_base4 bigint check(accepted_base4 between 0 and 10000000000000),
 damaged_base4 bigint check(damaged_base4 between 0 and 10000000000000),
 canonical_stock_line_id uuid,
 unique(business_id,receipt_id,source_line_key),
 foreign key(business_id,purchase_order_id,receipt_id)
  references public.purchase_receipts(business_id,purchase_order_id,id),
 foreign key(business_id,purchase_order_id,order_line_id,ingredient_id)
  references public.purchase_order_lines(business_id,purchase_order_id,id,ingredient_id),
 check((order_line_id is null)=(ingredient_id is null)),
 check((received_base4 is null and accepted_base4 is null and damaged_base4 is null)
    or (received_base4 is not null and accepted_base4 is not null
        and damaged_base4 is not null and received_base4=accepted_base4+damaged_base4)),
 check(canonical_stock_line_id is null or (order_line_id is not null and accepted_base4 is not null and accepted_base4>0))
);

create table public.supplier_invoices(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 supplier_id uuid not null,
 owner_user_id uuid not null,
 invoice_reference text not null check(length(btrim(invoice_reference)) between 1 and 200),
 revision bigint not null check(revision between 1 and 9007199254740991),
 issued_on date not null,
 due_on date,
 currency_code text not null check(currency_code ~ '^[A-Z]{3}$'),
 subtotal_cents bigint not null check(subtotal_cents between 0 and 9007199254740991),
 tax_cents bigint check(tax_cents between 0 and 9007199254740991),
 freight_cents bigint check(freight_cents between 0 and 9007199254740991),
 discount_cents bigint check(discount_cents between 0 and 9007199254740991),
 total_cents bigint not null check(total_cents between 0 and 9007199254740991),
 source_ref text not null check(length(btrim(source_ref)) between 1 and 512),
 source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 identity_verification_ref text not null check(length(btrim(identity_verification_ref)) between 1 and 512),
 created_at timestamptz not null default now(),
 canonical_expense_id uuid,
 recognized_expense_on date,
 recognized_expense_key text check(recognized_expense_key is null or recognized_expense_key ~ '^[a-f0-9]{64}$'),
 check((canonical_expense_id is null)=(recognized_expense_on is null) and
       (canonical_expense_id is null)=(recognized_expense_key is null)),
 unique(business_id,purchase_order_id,id),
 -- Invoice identity scoped to supplier, not just PO. A multi-PO invoice must
 -- stay unresolved until a verified allocation is supported; do not clone it.
 unique(business_id,supplier_id,invoice_reference,revision),
 foreign key(business_id,purchase_order_id,supplier_id,owner_user_id)
  references public.purchase_orders(business_id,id,supplier_id,owner_user_id),
 foreign key(business_id,canonical_expense_id) references public.expenses(business_id,id)
);
create index supplier_invoices_order_idx on public.supplier_invoices(business_id,purchase_order_id);
create table public.supplier_invoice_lines(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 invoice_id uuid not null,
 source_line_key text not null check(length(btrim(source_line_key)) between 1 and 160),
 order_line_id uuid,
 ingredient_id uuid,
 source_item_name text not null check(length(btrim(source_item_name)) between 1 and 200),
 quantity_base4 bigint check(quantity_base4 between 1 and 10000000000000),
 subtotal_cents bigint not null check(subtotal_cents between 0 and 9007199254740991),
 unique(business_id,invoice_id,source_line_key),
 foreign key(business_id,purchase_order_id,invoice_id)
  references public.supplier_invoices(business_id,purchase_order_id,id),
 foreign key(business_id,purchase_order_id,order_line_id,ingredient_id)
  references public.purchase_order_lines(business_id,purchase_order_id,id,ingredient_id),
 check((order_line_id is null)=(ingredient_id is null))
);

-- Append-only historical facts. This is procurement evidence, not an
-- alternative task/approval/financial system.
create table public.purchase_reconciliation_events(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 supplier_id uuid not null,
 owner_user_id uuid not null,
 event_key text not null check(length(btrim(event_key)) between 1 and 200),
 event_kind text not null check(event_kind in ('evidence_observed','discrepancy_opened',
  'receipt_verified','invoice_verified','correction_approved','effect_verified','closure_verified','followup_reserved')),
 source_ref text not null check(length(btrim(source_ref)) between 1 and 512),
 source_revision bigint not null check(source_revision between 1 and 9007199254740991),
 occurred_at timestamptz not null default now(),
 unique(business_id,purchase_order_id,event_key),
 foreign key(business_id,purchase_order_id,supplier_id,owner_user_id)
  references public.purchase_orders(business_id,id,supplier_id,owner_user_id)
);

-- All new evidence tables have the same owner/café boundary as the PO.
-- No owner, anonymous caller or general service role may mutate these facts
-- through the table API until the separately verified gateway RPC exists.
-- Reason: New tenant-scoped evidence table requires RLS before any authenticated read grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.purchase_receipts enable row level security;
-- Reason: New tenant-scoped evidence table requires RLS before any authenticated read grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.purchase_receipt_lines enable row level security;
-- Reason: New tenant-scoped evidence table requires RLS before any authenticated read grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.supplier_invoices enable row level security;
-- Reason: New tenant-scoped evidence table requires RLS before any authenticated read grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.supplier_invoice_lines enable row level security;
-- Reason: New tenant-scoped evidence table requires RLS before any authenticated read grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.purchase_reconciliation_events enable row level security;
create policy "owner reads purchase_receipts" on public.purchase_receipts for select to authenticated
 using(exists(select 1 from public.purchase_orders p
  where p.business_id=purchase_receipts.business_id and p.id=purchase_receipts.purchase_order_id
  and p.owner_user_id=(select auth.uid()) and exists(select 1 from public.memberships m
   where m.business_id=p.business_id and m.user_id=(select auth.uid()) and m.role='owner')));
create policy "owner reads purchase_receipt_lines" on public.purchase_receipt_lines for select to authenticated
 using(exists(select 1 from public.purchase_orders p
  where p.business_id=purchase_receipt_lines.business_id and p.id=purchase_receipt_lines.purchase_order_id
  and p.owner_user_id=(select auth.uid()) and exists(select 1 from public.memberships m
   where m.business_id=p.business_id and m.user_id=(select auth.uid()) and m.role='owner')));
create policy "owner reads supplier_invoices" on public.supplier_invoices for select to authenticated
 using(exists(select 1 from public.purchase_orders p
  where p.business_id=supplier_invoices.business_id and p.id=supplier_invoices.purchase_order_id
  and p.owner_user_id=(select auth.uid()) and exists(select 1 from public.memberships m
   where m.business_id=p.business_id and m.user_id=(select auth.uid()) and m.role='owner')));
create policy "owner reads supplier_invoice_lines" on public.supplier_invoice_lines for select to authenticated
 using(exists(select 1 from public.purchase_orders p
  where p.business_id=supplier_invoice_lines.business_id and p.id=supplier_invoice_lines.purchase_order_id
  and p.owner_user_id=(select auth.uid()) and exists(select 1 from public.memberships m
   where m.business_id=p.business_id and m.user_id=(select auth.uid()) and m.role='owner')));
create policy "owner reads purchase_reconciliation_events" on public.purchase_reconciliation_events for select to authenticated
 using(exists(select 1 from public.purchase_orders p
  where p.business_id=purchase_reconciliation_events.business_id and p.id=purchase_reconciliation_events.purchase_order_id
  and p.owner_user_id=(select auth.uid()) and exists(select 1 from public.memberships m
   where m.business_id=p.business_id and m.user_id=(select auth.uid()) and m.role='owner')));
revoke all on public.purchase_receipts,public.purchase_receipt_lines,
 public.supplier_invoices,public.supplier_invoice_lines,public.purchase_reconciliation_events
 from public,anon,authenticated,service_role;
grant select on public.purchase_receipts,public.purchase_receipt_lines,
 public.supplier_invoices,public.supplier_invoice_lines,public.purchase_reconciliation_events
 to authenticated,service_role;

-- Reuse the one operating task + leased investigation path. Source tasks are
-- not a second queue and cannot be manually closed through generic inbox edits.
create policy supplier_receiving_task_read on public.operating_tasks as restrictive
 for select to authenticated using(kind<>'supplier_receiving' or
 (owner_user_id=(select auth.uid()) and exists(select 1 from public.memberships m
 where m.business_id=operating_tasks.business_id and m.user_id=(select auth.uid()) and m.role='owner')));
create policy supplier_receiving_task_insert on public.operating_tasks as restrictive
 for insert to authenticated with check(kind<>'supplier_receiving');
create policy supplier_receiving_task_update on public.operating_tasks as restrictive
 for update to authenticated using(kind<>'supplier_receiving') with check(kind<>'supplier_receiving');
create policy supplier_receiving_task_delete on public.operating_tasks as restrictive
 for delete to authenticated using(kind<>'supplier_receiving');

-- Scope, due day and source counts come from actual persisted PO evidence.
-- A due date proves only that a receiving check is required. No closure or
-- physical receipt is inferred, and no provider operation is performed.
create function public.supervisor_sync_supplier_receiving_tasks(
 p_business_id uuid,p_owner_user_id uuid,p_now timestamptz
) returns integer language plpgsql security invoker set search_path=public as $$
declare v_day date;v_count integer;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';
 end if;
 if not exists(select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=p_owner_user_id and m.role='owner') then
  raise exception 'receiving_owner_required' using errcode='42501';
 end if;
 select (p_now at time zone b.timezone)::date into v_day from public.businesses b
  where b.id=p_business_id and not b.is_demo;
 if v_day is null then raise exception 'receiving_context_missing' using errcode='22023';end if;
 with evidence as (
  select p.id,p.revision,
   (select count(*) from public.purchase_receipts r where r.business_id=p.business_id
      and r.purchase_order_id=p.id and r.owner_user_id=p.owner_user_id) as receipt_versions,
   (select count(*) from public.supplier_invoices i where i.business_id=p.business_id
      and i.purchase_order_id=p.id and i.owner_user_id=p.owner_user_id) as invoice_versions,
   (select o.outcome from public.purchase_order_channel_reports o
      where o.business_id=p.business_id and o.purchase_order_id=p.id
       and o.owner_user_id=p.owner_user_id and o.outcome in ('supplier_accepted','supplier_declined')
      order by o.reported_at desc limit 1) as terminal_report,
   exists(select 1 from public.purchase_order_dispatches d where d.business_id=p.business_id
      and d.purchase_order_id=p.id and d.owner_user_id=p.owner_user_id
      and d.state='provider_accepted' and d.provider_receipt_id is not null) as gmail_accepted,
   (coalesce(p.needed_by<=v_day,false) or exists(select 1 from public.purchase_order_lines l
      where l.business_id=p.business_id and l.purchase_order_id=p.id and l.delivery_on<=v_day)) as delivery_due
  from public.purchase_orders p where p.business_id=p_business_id
    and p.owner_user_id=p_owner_user_id and p.status='approved_for_ordering'
 ), candidates as (
  select e.id,e.revision,
   jsonb_build_array(jsonb_build_object('source','purchase_orders',
    'facts',jsonb_build_object('poRevision',e.revision,'receiptVersions',e.receipt_versions,
     'invoiceVersions',e.invoice_versions,'deliveryDue',e.delivery_due,
     'gmailAccepted',e.gmail_accepted,'supplierReportedOutcome',e.terminal_report))) as facts
  from evidence e where e.receipt_versions>0 or e.invoice_versions>0 or
   (e.delivery_due and coalesce(e.terminal_report,'unknown')<>'supplier_declined'
    and (e.gmail_accepted or e.terminal_report='supplier_accepted'))
 ), changed as (
  select c.* from candidates c left join public.operating_tasks t
    on t.business_id=p_business_id and t.id='supplier-receiving:'||c.id::text
  where t.id is null or (t.kind='supplier_receiving' and t.owner_user_id=p_owner_user_id
    and t.status in ('watching','handled') and t.evidence is distinct from c.facts)
  order by c.id limit 100
 )
 insert into public.operating_tasks(business_id,id,owner_user_id,agent_id,kind,entity_type,
  entity_id,status,confidence,payload,evidence,created_at)
 select p_business_id,'supplier-receiving:'||c.id::text,p_owner_user_id,'maya','supplier_receiving',
  'purchase_order',c.id::text,'watching','high',
  jsonb_build_object('title','Supplier delivery and invoice review','purchaseOrderId',c.id),
  c.facts,p_now from changed c
 on conflict(business_id,id) do update set evidence=excluded.evidence,status='watching',resolved_at=null,updated_at=p_now
 where operating_tasks.kind='supplier_receiving' and operating_tasks.owner_user_id=p_owner_user_id
  and operating_tasks.status in ('watching','handled') and operating_tasks.evidence is distinct from excluded.evidence;
 get diagnostics v_count=row_count;
 return v_count;
end $$;
revoke all on function public.supervisor_sync_supplier_receiving_tasks(uuid,uuid,timestamptz)
 from public,anon,authenticated;
grant execute on function public.supervisor_sync_supplier_receiving_tasks(uuid,uuid,timestamptz) to service_role;

-- Owner explicitly attests the exact physical quantities through a click on
-- the immutable receiving card. No model-generated source flag can authorize
-- this transaction. It reuses the canonical Pantry RPC and existing gateway.
create function public.supervisor_commit_supplier_receiving(
 p_business_id uuid,p_thread_id uuid,p_proposal_id uuid,p_effect_hash text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_owner uuid:=auth.uid(); p public.supervisor_proposals; a public.supervisor_effect_attempts;
 po public.purchase_orders; prior public.purchase_receipts; receipt public.purchase_receipts;
 old_line public.purchase_receipt_lines; ordered public.purchase_order_lines;
 stock public.pantry_stock_purchases; l jsonb; e jsonb; v_ref text; v_rev bigint;
 v_date date; v_day date; v_received bigint; v_accepted bigint; v_damaged bigint;
 v_stock_id uuid; v_prev_stock_rev bigint; v_line_key text; v_source text;
begin
 if v_owner is null or not exists(select 1 from public.memberships m
  join public.businesses b on b.id=m.business_id where m.business_id=p_business_id
  and m.user_id=v_owner and m.role='owner' and not b.is_demo)
 then raise exception 'receiving_owner_required' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where id=p_proposal_id
  and business_id=p_business_id and owner_user_id=v_owner and thread_id=p_thread_id for update;
 if p.id is null or p.capability_id<>'maya.supplier_receiving.v1' or p.capability_version<>1
  or p.status<>'executing' or p.effect_hash is distinct from p_effect_hash
 then raise exception 'receiving_claim_required' using errcode='42501';end if;
 select * into a from public.supervisor_effect_attempts where business_id=p_business_id
  and proposal_id=p.id and effect_hash=p.effect_hash and authorization_kind='click'
  and state='executing' for update;
 if a.id is null or not exists(select 1 from public.supervisor_approvals x
  where x.business_id=p_business_id and x.proposal_id=p.id and x.owner_user_id=v_owner
  and x.effect_hash=p.effect_hash and x.authorization_kind='click'
  and x.approved_revision=p.revision-2)
 then raise exception 'receiving_click_required' using errcode='42501';end if;
 e:=p.canonical_effect_payload;
 select * into po from public.purchase_orders where business_id=p_business_id
  and owner_user_id=v_owner and id=(e->>'purchaseOrderId')::uuid for update;
 if po.id is null or po.status<>'approved_for_ordering'
  or po.revision is distinct from (e->>'poRevision')::bigint
  or po.supplier_id is distinct from (e->>'supplierId')::uuid
 then raise exception 'receiving_po_changed' using errcode='P0001';end if;
 v_ref:=e->>'receivingReference';v_rev:=(e->>'expectedReceiptRevision')::bigint;
 v_date:=(e->>'receivedOn')::date;
 select (now() at time zone b.timezone)::date into v_day from public.businesses b where b.id=p_business_id;
 if v_ref is null or v_ref<>lower(btrim(v_ref)) or length(v_ref) not between 1 and 160
  or v_rev is null or v_rev<0 or v_date is null or v_date>v_day
  or jsonb_typeof(e->'lines') is distinct from 'array'
  or jsonb_array_length(e->'lines') not between 1 and 10
 then raise exception 'receiving_invalid_effect' using errcode='22023';end if;
 v_source:='supervisor-proposal:'||p.id::text;
 -- Serialize all receipts for the same PO by its locked row. Existing exact
 -- proposal proof can be read on retry, but never replay a successful write.
 select * into receipt from public.purchase_receipts where business_id=p_business_id
  and purchase_order_id=po.id and source_ref=v_source and source_sha256=p.effect_hash;
 if receipt.id is not null then
  return jsonb_build_object('receiptId',receipt.id,'purchaseOrderId',po.id,'revision',receipt.revision);
 end if;
 select * into prior from public.purchase_receipts where business_id=p_business_id and purchase_order_id=po.id
  and receiving_reference=v_ref order by revision desc limit 1;
 if coalesce(prior.revision,0)<>v_rev then
  raise exception 'receiving_revision_changed' using errcode='P0001';end if;
 -- Correction is a full replacement of the previously attested line set:
 -- omission cannot silently leave a previous stock increment active.
 if prior.id is not null and exists(select 1 from public.purchase_receipt_lines x
  where x.business_id=p_business_id and x.receipt_id=prior.id
    and not exists(select 1 from jsonb_array_elements(e->'lines') y
       where y->>'orderLineId'=x.order_line_id::text))
 then raise exception 'receiving_correction_omits_line' using errcode='22023';end if;
 if (select count(distinct x->>'orderLineId') from jsonb_array_elements(e->'lines') x)
    <>jsonb_array_length(e->'lines')
 then raise exception 'receiving_duplicate_line' using errcode='22023';end if;
 insert into public.purchase_receipts(business_id,purchase_order_id,supplier_id,owner_user_id,
  receiving_reference,revision,received_on,source_ref,source_sha256,verification_kind,verification_ref,verified_at)
 values(p_business_id,po.id,po.supplier_id,v_owner,v_ref,v_rev+1,v_date,v_source,p.effect_hash,
  'owner_confirmed','approval:'||p.id::text,now()) returning * into receipt;
 for l in select value from jsonb_array_elements(e->'lines') loop
  select * into ordered from public.purchase_order_lines where business_id=p_business_id
   and purchase_order_id=po.id and id=(l->>'orderLineId')::uuid;
  v_received:=(l->>'receivedBase4')::bigint;v_accepted:=(l->>'acceptedBase4')::bigint;
  v_damaged:=(l->>'damagedBase4')::bigint;
  if ordered.id is null or ordered.ingredient_id is distinct from (l->>'ingredientId')::uuid
   or ordered.base_unit is distinct from l->>'baseUnit'
   or v_received is null or v_accepted is null or v_damaged is null
   or v_received not between 0 and 10000000000000 or v_accepted<0 or v_damaged<0
   or v_received<>v_accepted+v_damaged or (v_rev=0 and v_received=0)
  then raise exception 'receiving_line_invalid' using errcode='22023';end if;
  v_line_key:=ordered.id::text;
  select * into old_line from public.purchase_receipt_lines where business_id=p_business_id
   and receipt_id=prior.id and source_line_key=v_line_key;
  v_stock_id:=old_line.canonical_stock_line_id;
  v_prev_stock_rev:=null;
  if v_stock_id is not null then
   select * into stock from public.pantry_stock_purchases
    where business_id=p_business_id and line_id=v_stock_id for update;
   -- The exact old canonical record must still agree with the last approved
   -- receiving fact. Manual edits cannot silently be overwritten.
   if stock.id is null or stock.voided_at is not null
    or stock.ingredient_id<>ordered.ingredient_id
    or stock.quantity_base is distinct from old_line.accepted_base4::numeric/10000
    or stock.purchase_date is distinct from prior.received_on
    or stock.source is distinct from 'chat_text'
    or stock.source_ref is distinct from 'supplier-receiving:'||po.id::text||':'||v_stock_id::text
    or stock.cost_cents is not null or stock.expense_line_id is not null
   then raise exception 'receiving_stock_changed' using errcode='P0001';end if;
   v_prev_stock_rev:=stock.revision;
  end if;
  if v_accepted>0 then
   if v_stock_id is null then
    -- Stable semantic installment/PO-line identity. A previously voided
    -- line is not silently resurrected; a verified later revision uses its
    -- own stable identity and the old void stays auditable.
    v_stock_id:=substr(encode(pg_catalog.sha256(convert_to('supplier-receiving:'||p_business_id::text||':'||po.id::text||
      ':'||v_ref||':'||v_line_key||':'||(v_rev+1)::text,'UTF8')),'hex'),1,32)::uuid;
    -- Conservative cross-channel duplicate fence: an existing same-day,
    -- same-product, same-quantity manual/receipt/import line needs matching
    -- review instead of a second increment. Distinct already-linked
    -- installments are excluded from this legacy ambiguity check.
    if exists(select 1 from public.pantry_stock_purchases s where s.business_id=p_business_id
      and s.ingredient_id=ordered.ingredient_id and s.purchase_date=v_date
      and s.quantity_base=v_accepted::numeric/10000 and s.voided_at is null
      and not exists(select 1 from public.purchase_receipt_lines linked
       where linked.business_id=p_business_id and linked.canonical_stock_line_id=s.line_id))
    then raise exception 'receiving_possible_existing_stock_requires_match' using errcode='P0001';end if;
   end if;
   -- The same canonical quantity and source path that existing Pantry uses.
   -- Receipt without independent cost evidence must not invent a price or bill.
   perform public.pantry_write_purchase_line(p_business_id,v_stock_id,ordered.ingredient_id,
    v_date,v_accepted::numeric/10000,ordered.base_unit,v_accepted::numeric/10000,
    null,null,'chat_text','supplier-receiving:'||po.id::text||':'||v_stock_id::text,
    null,v_prev_stock_rev);
  elsif v_stock_id is not null then
   if not public.pantry_void_purchase_line(p_business_id,v_stock_id)
    then raise exception 'receiving_void_unverified' using errcode='P0001';end if;
   v_stock_id:=null;
  end if;
  insert into public.purchase_receipt_lines(business_id,purchase_order_id,receipt_id,source_line_key,
   order_line_id,ingredient_id,source_item_name,received_base4,accepted_base4,damaged_base4,
   canonical_stock_line_id)
  values(p_business_id,po.id,receipt.id,v_line_key,ordered.id,ordered.ingredient_id,
   ordered.item_name_snapshot,v_received,v_accepted,v_damaged,v_stock_id);
 end loop;
 insert into public.purchase_reconciliation_events(business_id,purchase_order_id,supplier_id,owner_user_id,
  event_key,event_kind,source_ref,source_revision)
 values(p_business_id,po.id,po.supplier_id,v_owner,v_source,'receipt_verified',v_source,receipt.revision);
 return jsonb_build_object('receiptId',receipt.id,'purchaseOrderId',po.id,'revision',receipt.revision);
end $$;
revoke all on function public.supervisor_commit_supplier_receiving(uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.supervisor_commit_supplier_receiving(uuid,uuid,uuid,text) to authenticated;

-- Read-only proof of the exact approved receipt and current canonical stock.
-- This function can be used by the gateway after a lost response; it never
-- invokes the writer again. Later revisions cannot prove an older quantity.
create function public.supervisor_supplier_receiving_effect_proof(
 p_business_id uuid,p_proposal_id uuid,p_effect_hash text
) returns uuid language sql stable security invoker set search_path=public as $$
 select r.id from public.purchase_receipts r
 join public.supervisor_proposals p on p.business_id=r.business_id
  and p.id=p_proposal_id and p.owner_user_id=r.owner_user_id
 where r.business_id=p_business_id and p.capability_id='maya.supplier_receiving.v1'
  and p.effect_hash=p_effect_hash and r.source_sha256=p_effect_hash
  and r.source_ref='supervisor-proposal:'||p.id::text
  and r.purchase_order_id::text=p.canonical_effect_payload->>'purchaseOrderId'
  and r.receiving_reference=p.canonical_effect_payload->>'receivingReference'
  and r.revision=(p.canonical_effect_payload->>'expectedReceiptRevision')::bigint+1
  and r.received_on::text=p.canonical_effect_payload->>'receivedOn'
  and r.verification_kind='owner_confirmed' and r.verification_ref='approval:'||p.id::text
  and not exists(select 1 from public.purchase_receipts newer where newer.business_id=r.business_id
    and newer.purchase_order_id=r.purchase_order_id and newer.receiving_reference=r.receiving_reference
    and newer.revision>r.revision)
  and (select count(*) from public.purchase_receipt_lines l
    where l.business_id=r.business_id and l.receipt_id=r.id)=jsonb_array_length(p.canonical_effect_payload->'lines')
  and not exists(
    select 1 from jsonb_array_elements(p.canonical_effect_payload->'lines') x
    where not exists(select 1 from public.purchase_receipt_lines l
      where l.business_id=r.business_id and l.receipt_id=r.id
       and l.order_line_id::text=x->>'orderLineId' and l.ingredient_id::text=x->>'ingredientId'
       and l.received_base4=(x->>'receivedBase4')::bigint
       and l.accepted_base4=(x->>'acceptedBase4')::bigint
       and l.damaged_base4=(x->>'damagedBase4')::bigint
       and ((l.accepted_base4=0 and l.canonical_stock_line_id is null) or
        (l.accepted_base4>0 and exists(select 1 from public.pantry_stock_purchases s
          where s.business_id=r.business_id and s.line_id=l.canonical_stock_line_id
           and s.ingredient_id=l.ingredient_id and s.purchase_date=r.received_on
           and s.quantity_base=l.accepted_base4::numeric/10000 and s.voided_at is null
           and s.source='chat_text' and s.cost_cents is null and s.expense_line_id is null
           and s.source_ref='supplier-receiving:'||r.purchase_order_id::text||':'||s.line_id::text))))
  )
 limit 1
$$;
revoke all on function public.supervisor_supplier_receiving_effect_proof(uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.supervisor_supplier_receiving_effect_proof(uuid,uuid,text) to service_role;

create function public.supervisor_reconcile_supplier_receiving(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,p_revision integer
) returns public.supervisor_proposals language plpgsql security definer set search_path=public as $$
declare p public.supervisor_proposals;a public.supervisor_effect_attempts;proof uuid;
begin
 if auth.role() is distinct from 'service_role' or not exists(select 1 from public.memberships m
  where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
 then raise exception 'receiving_owner_required' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where id=p_proposal_id
  and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if p.id is null or p.revision<>p_revision or p.capability_id not in ('maya.supplier_receiving.v1','maya.supplier_invoice.v1')
  or p.capability_version<>1 then raise exception 'receiving_claim_required' using errcode='42501';end if;
 select * into a from public.supervisor_effect_attempts where business_id=p_business_id
  and proposal_id=p.id and effect_hash=p.effect_hash and authorization_kind='click' for update;
 if a.state='verified' and p.status='committed' then return p;end if;
 if a.id is null or p.status<>'executing' or a.state not in ('executing','uncertain')
 then raise exception 'receiving_claim_required' using errcode='42501';end if;
 -- A live attempt is never taken over. Only the existing proof can settle.
 if a.state='executing' and a.created_at>now()-interval '5 minutes' then return p;end if;
 if p.capability_id='maya.supplier_invoice.v1' then
  proof:=public.supervisor_supplier_invoice_effect_proof(p_business_id,p.id,p.effect_hash);
 else
  proof:=public.supervisor_supplier_receiving_effect_proof(p_business_id,p.id,p.effect_hash);
 end if;
 if proof is null then
  update public.supervisor_effect_attempts set state='uncertain' where id=a.id and state='executing';
  return p;
 end if;
 update public.supervisor_effect_attempts set state='verified',receipt_ref=(case when p.capability_id='maya.supplier_invoice.v1' then 'supplier_invoices:' else 'purchase_receipts:' end)||proof::text,
  verified_at=now() where id=a.id;
 update public.supervisor_proposals set status='committed',revision=revision+1,committed_at=now(),
  monitoring_start_date=a.business_date+1,updated_at=now() where id=p.id returning * into p;
 return p;
end $$;
revoke all on function public.supervisor_reconcile_supplier_receiving(uuid,uuid,uuid,uuid,integer)
 from public,anon,authenticated;
grant execute on function public.supervisor_reconcile_supplier_receiving(uuid,uuid,uuid,uuid,integer) to service_role;

-- The invoice path has NO Pantry call. Owner confirms documentary identity and
-- optionally explicitly recognizes an actual incurred expense (not payment).
-- It uses the existing expenses/expense_lines and canonical legacy dedupe key.
create function public.supervisor_commit_supplier_invoice(
 p_business_id uuid,p_thread_id uuid,p_proposal_id uuid,p_effect_hash text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_owner uuid:=auth.uid();p public.supervisor_proposals;a public.supervisor_effect_attempts;
 po public.purchase_orders;prior public.supplier_invoices;invoice public.supplier_invoices;
 expense public.expenses;ordered public.purchase_order_lines;e jsonb;l jsonb;
 v_ref text;v_rev bigint;v_date date;v_expense_date date;v_due date;v_day date;
 v_sub bigint;v_tax bigint;v_freight bigint;v_discount bigint;v_total bigint;
 v_sum numeric:=0;v_key text;v_reason text;v_source text;v_hash text;
 v_expense_id uuid;v_ingredient uuid;v_order_line uuid;v_qty bigint;v_line_cents bigint;
 v_index integer:=0;v_all_matched boolean:=true;v_msg uuid;v_current_invoice_id uuid;
begin
 if v_owner is null or not exists(select 1 from public.memberships m
  join public.businesses b on b.id=m.business_id where m.business_id=p_business_id
  and m.user_id=v_owner and m.role='owner' and not b.is_demo)
 then raise exception 'invoice_owner_required' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where id=p_proposal_id
  and business_id=p_business_id and owner_user_id=v_owner and thread_id=p_thread_id for update;
 if p.id is null or p.capability_id<>'maya.supplier_invoice.v1' or p.capability_version<>1
  or p.status<>'executing' or p.effect_hash is distinct from p_effect_hash
 then raise exception 'invoice_claim_required' using errcode='42501';end if;
 select * into a from public.supervisor_effect_attempts where business_id=p_business_id
  and proposal_id=p.id and effect_hash=p.effect_hash and authorization_kind='click'
  and state='executing' for update;
 if a.id is null or not exists(select 1 from public.supervisor_approvals x
  where x.business_id=p_business_id and x.proposal_id=p.id and x.owner_user_id=v_owner
  and x.effect_hash=p.effect_hash and x.authorization_kind='click' and x.approved_revision=p.revision-2)
 then raise exception 'invoice_click_required' using errcode='42501';end if;
 e:=p.canonical_effect_payload;
 select * into po from public.purchase_orders where business_id=p_business_id and owner_user_id=v_owner
  and id=(e->>'purchaseOrderId')::uuid for update;
 if po.id is null or po.status<>'approved_for_ordering' or po.revision is distinct from (e->>'poRevision')::bigint
  or po.supplier_id is distinct from (e->>'supplierId')::uuid
 then raise exception 'invoice_po_changed' using errcode='P0001';end if;
 v_ref:=e->>'invoiceReference';v_rev:=(e->>'expectedInvoiceRevision')::bigint;
 v_date:=(e->>'issuedOn')::date;v_due:=(e->>'dueOn')::date;
 v_expense_date:=(e->>'expenseDate')::date;
 v_sub:=(e->>'subtotalCents')::bigint;v_tax:=(e->>'taxCents')::bigint;
 v_freight:=(e->>'freightCents')::bigint;v_discount:=(e->>'discountCents')::bigint;
 v_total:=(e->>'totalCents')::bigint;
 v_source:=e->>'sourceRef';v_hash:=e->>'sourceSha256';
 select (now() at time zone b.timezone)::date into v_day from public.businesses b where b.id=p_business_id;
 if v_ref is null or v_ref<>lower(btrim(v_ref)) or length(v_ref) not between 1 and 160
  or v_rev is null or v_rev<0 or v_date is null or v_date>v_day
  or v_sub is null or v_total is null or v_sub<0 or v_total<0
  or v_tax<0 or v_freight<0 or v_discount<0
  or v_hash is null or v_hash !~ '^[a-f0-9]{64}$'
  or v_source is null or length(v_source) not between 1 and 400
  or jsonb_typeof(e->'lines') is distinct from 'array'
  or jsonb_array_length(e->'lines') not between 1 and 50
 then raise exception 'invoice_invalid_effect' using errcode='22023';end if;
 -- Owner chat/upload provenance is bound by the server, not an arbitrary
 -- source identifier supplied by the model. Gmail references have a current
 -- scoped account and read grant even at approval time.
 if e->>'sourceKind' in ('owner_report','owner_attachment') then
  v_msg:=split_part(v_source,':',2)::uuid;
  if split_part(v_source,':',1) not in ('owner-message','owner-attachment') or not exists(
   select 1 from public.ai_messages m where m.id=v_msg and m.business_id=p_business_id
    and m.owner_user_id=v_owner and m.thread_id=p_thread_id and m.role='owner'
    and m.author_user_id=v_owner)
  then raise exception 'invoice_source_unverified' using errcode='42501';end if;
 elsif e->>'sourceKind'='gmail_message' then
  if split_part(v_source,':',1)<>'gmail' or not exists(
   select 1 from public.connector_accounts g where g.id=split_part(v_source,':',2)::uuid
    and g.business_id=p_business_id and g.owner_user_id=v_owner and g.provider='gmail'
    and g.status='active' and g.generation=split_part(v_source,':',3)::bigint
    and 'read'=any(g.enabled_operations)
    and 'https://www.googleapis.com/auth/gmail.modify'=any(g.granted_scopes))
  then raise exception 'invoice_gmail_authorization_changed' using errcode='42501';end if;
 else raise exception 'invoice_source_unverified' using errcode='42501';end if;
 -- Supplier-wide semantic invoice key (not file hash or chat ID).
 perform pg_advisory_xact_lock(hashtextextended('supplier-invoice:'||p_business_id::text||
  ':'||po.supplier_id::text||':'||v_ref,91));
 select * into invoice from public.supplier_invoices where business_id=p_business_id
  and supplier_id=po.supplier_id and identity_verification_ref='approval:'||p.id::text;
 if invoice.id is not null then
  return jsonb_build_object('invoiceId',invoice.id,'purchaseOrderId',po.id,'revision',invoice.revision);
 end if;
 select * into prior from public.supplier_invoices where business_id=p_business_id
  and supplier_id=po.supplier_id and invoice_reference=v_ref order by revision desc limit 1;
 if coalesce(prior.revision,0)<>v_rev or (prior.id is not null and prior.purchase_order_id<>po.id)
 then raise exception 'invoice_identity_or_revision_changed' using errcode='P0001';end if;
 -- Validate mapped items and exact amounts; an unknown product may be stored
 -- as an unresolved supplier claim, but cannot create a canonical expense.
 for l in select value from jsonb_array_elements(e->'lines') loop
  v_order_line:=(l->>'orderLineId')::uuid;v_ingredient:=(l->>'ingredientId')::uuid;
  v_qty:=(l->>'quantityBase4')::bigint;v_line_cents:=(l->>'subtotalCents')::bigint;
  if v_line_cents is null or v_line_cents<0 or (v_qty is not null and v_qty<=0)
  then raise exception 'invoice_line_invalid' using errcode='22023';end if;
  if v_order_line is null then
   if v_ingredient is not null then raise exception 'invoice_line_invalid' using errcode='22023';end if;
   v_all_matched:=false;
  else
   select * into ordered from public.purchase_order_lines where business_id=p_business_id
    and purchase_order_id=po.id and id=v_order_line;
   if ordered.id is null or v_ingredient is distinct from ordered.ingredient_id
    or v_qty is null or ordered.base_unit is distinct from l->>'baseUnit'
   then raise exception 'invoice_line_scope_invalid' using errcode='22023';end if;
  end if;
  v_sum:=v_sum+v_line_cents;
 end loop;
 -- If an earlier revision recognized an expense, a correction cannot hide
 -- or abandon it. The owner must explicitly authorize a corrected recognition.
 if prior.canonical_expense_id is not null and v_expense_date is null
 then raise exception 'invoice_prior_expense_requires_reconciliation' using errcode='P0001';end if;
 if v_expense_date is not null then
  if not v_all_matched or v_sum<>v_sub or v_tax is null or v_freight is null or v_discount is null
   or v_sub::numeric+v_tax+v_freight-v_discount<>v_total
   or e->>'currency' is distinct from po.currency_code or v_expense_date>v_day
  then raise exception 'invoice_expense_evidence_incomplete' using errcode='P0001';end if;
  -- Same canonical legacy key used by receipt page, statements and manual
  -- expenses. Never make a second expense on a matching key.
  v_key:=encode(pg_catalog.sha256(convert_to(p_business_id::text||'|'||v_expense_date::text||'|'||
    v_total::text||'|'||btrim(regexp_replace(lower(po.supplier_name_snapshot),'[^a-z0-9]+',' ','g')),
    'UTF8')),'hex');
  if v_key is distinct from e->>'expenseDedupeKey'
  then raise exception 'invoice_expense_key_invalid' using errcode='22023';end if;
  v_reason:='supplier-invoice:'||encode(pg_catalog.sha256(convert_to(
   p_business_id::text||':'||po.supplier_id::text||':'||v_ref,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':receipt:'||v_key,53));
  if prior.canonical_expense_id is not null then
   select * into expense from public.expenses where business_id=p_business_id
    and id=prior.canonical_expense_id for update;
   if expense.id is null or expense.amount_cents is distinct from prior.total_cents
    or expense.spent_on is distinct from prior.recognized_expense_on
    or expense.dedupe_key is distinct from prior.recognized_expense_key or expense.status<>'actual'
   then raise exception 'invoice_prior_expense_changed' using errcode='P0001';end if;
   if expense.reason is distinct from v_reason then
    -- A matched legacy expense is not ours to rewrite. Existing canonical
    -- history remains intact until its own authorized correction.
    if expense.dedupe_key<>v_key then
     raise exception 'invoice_linked_legacy_expense_requires_review' using errcode='P0001';end if;
   else
    if exists(select 1 from public.expense_lines el join public.pantry_stock_purchases sp
     on sp.expense_line_id=el.id where el.expense_id=expense.id)
     or exists(select 1 from public.expense_lines el join public.ingredient_prices ip
      on ip.source_expense_line_id=el.id where el.expense_id=expense.id)
    then raise exception 'invoice_expense_stock_link_requires_review' using errcode='P0001';end if;
    update public.expenses set spent_on=v_expense_date,amount_cents=v_total,dedupe_key=v_key
     where id=expense.id and business_id=p_business_id returning * into expense;
    -- Only invoice-owned projection rows are replaced. Historical invoice
    -- revisions remain immutable; no Pantry/price lines can reference them.
    delete from public.expense_lines where expense_id=expense.id;
   end if;
   v_expense_id:=expense.id;
  else
   select * into expense from public.expenses where business_id=p_business_id and dedupe_key=v_key for update;
   if expense.id is null then
    insert into public.expenses(business_id,spent_on,amount_cents,vendor,category_code,
     source,status,dedupe_key,reason)
    values(p_business_id,v_expense_date,v_total,po.supplier_name_snapshot,'ingredients',
     'manual','actual',v_key,v_reason)
    on conflict(business_id,dedupe_key) do nothing returning * into expense;
    if expense.id is null then
     select * into expense from public.expenses where business_id=p_business_id and dedupe_key=v_key for update;
    end if;
   end if;
   if expense.id is not null and expense.reason is distinct from v_reason
     and expense.id is distinct from (e->>'existingExpenseId')::uuid
   then raise exception 'invoice_existing_expense_requires_explicit_match' using errcode='P0001';end if;
   if expense.id is null or expense.status<>'actual' or expense.spent_on<>v_expense_date
    or expense.amount_cents<>v_total or
    btrim(regexp_replace(lower(coalesce(expense.vendor,'')),'[^a-z0-9]+',' ','g'))<>
    btrim(regexp_replace(lower(po.supplier_name_snapshot),'[^a-z0-9]+',' ','g'))
    or exists(select 1 from public.supplier_invoices linked where linked.business_id=p_business_id
     and linked.canonical_expense_id=expense.id and
      (linked.supplier_id<>po.supplier_id or linked.invoice_reference<>v_ref))
   then raise exception 'invoice_possible_duplicate_expense_requires_review' using errcode='P0001';end if;
   v_expense_id:=expense.id;
  end if;
 end if;
 insert into public.supplier_invoices(business_id,purchase_order_id,supplier_id,owner_user_id,
  invoice_reference,revision,issued_on,due_on,currency_code,subtotal_cents,tax_cents,freight_cents,
  discount_cents,total_cents,source_ref,source_sha256,identity_verification_ref,
  canonical_expense_id,recognized_expense_on,recognized_expense_key)
 values(p_business_id,po.id,po.supplier_id,v_owner,v_ref,v_rev+1,v_date,v_due,e->>'currency',
  v_sub,v_tax,v_freight,v_discount,v_total,v_source,v_hash,'approval:'||p.id::text,
  v_expense_id,v_expense_date,v_key) returning * into invoice;
 for l in select value from jsonb_array_elements(e->'lines') loop
  v_order_line:=(l->>'orderLineId')::uuid;v_ingredient:=(l->>'ingredientId')::uuid;
  v_qty:=(l->>'quantityBase4')::bigint;v_line_cents:=(l->>'subtotalCents')::bigint;
  insert into public.supplier_invoice_lines(business_id,purchase_order_id,invoice_id,source_line_key,
   order_line_id,ingredient_id,source_item_name,quantity_base4,subtotal_cents)
  values(p_business_id,po.id,invoice.id,v_index::text,v_order_line,v_ingredient,
    l->>'sourceItemName',v_qty,v_line_cents);
  if v_expense_id is not null and expense.reason=v_reason then
   insert into public.expense_lines(expense_id,receipt_line_index,description,quantity,unit,amount_cents,ingredient_id)
   values(v_expense_id,v_index,l->>'sourceItemName',v_qty::numeric/10000,
     l->>'baseUnit',v_line_cents,v_ingredient);
  end if;
  v_index:=v_index+1;
 end loop;
 insert into public.purchase_reconciliation_events(business_id,purchase_order_id,supplier_id,owner_user_id,
  event_key,event_kind,source_ref,source_revision)
 values(p_business_id,po.id,po.supplier_id,v_owner,'supervisor-proposal:'||p.id::text,
  'invoice_verified',v_source,invoice.revision);
 return jsonb_build_object('invoiceId',invoice.id,'purchaseOrderId',po.id,'revision',invoice.revision);
end $$;
revoke all on function public.supervisor_commit_supplier_invoice(uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.supervisor_commit_supplier_invoice(uuid,uuid,uuid,text) to authenticated;

create function public.supervisor_supplier_invoice_effect_proof(
 p_business_id uuid,p_proposal_id uuid,p_effect_hash text
) returns uuid language sql stable security invoker set search_path=public as $$
 select i.id from public.supplier_invoices i
 join public.supervisor_proposals p on p.business_id=i.business_id
  and p.id=p_proposal_id and p.owner_user_id=i.owner_user_id
 where i.business_id=p_business_id and p.capability_id='maya.supplier_invoice.v1'
  and p.effect_hash=p_effect_hash and i.identity_verification_ref='approval:'||p.id::text
  and i.purchase_order_id::text=p.canonical_effect_payload->>'purchaseOrderId'
  and i.invoice_reference=p.canonical_effect_payload->>'invoiceReference'
  and i.revision=(p.canonical_effect_payload->>'expectedInvoiceRevision')::bigint+1
  and i.source_ref=p.canonical_effect_payload->>'sourceRef'
  and i.source_sha256=p.canonical_effect_payload->>'sourceSha256'
  and i.issued_on::text=p.canonical_effect_payload->>'issuedOn'
  and i.due_on::text is not distinct from p.canonical_effect_payload->>'dueOn'
  and i.currency_code=p.canonical_effect_payload->>'currency'
  and i.subtotal_cents=(p.canonical_effect_payload->>'subtotalCents')::bigint
  and i.tax_cents is not distinct from (p.canonical_effect_payload->>'taxCents')::bigint
  and i.freight_cents is not distinct from (p.canonical_effect_payload->>'freightCents')::bigint
  and i.discount_cents is not distinct from (p.canonical_effect_payload->>'discountCents')::bigint
  and i.total_cents=(p.canonical_effect_payload->>'totalCents')::bigint
  and not exists(select 1 from public.supplier_invoices newer where newer.business_id=i.business_id
   and newer.supplier_id=i.supplier_id and newer.invoice_reference=i.invoice_reference
   and newer.revision>i.revision)
  and (select count(*) from public.supplier_invoice_lines l where l.business_id=i.business_id
   and l.invoice_id=i.id)=jsonb_array_length(p.canonical_effect_payload->'lines')
  and not exists(select 1 from jsonb_array_elements(p.canonical_effect_payload->'lines') with ordinality x(value,ordinal)
   where not exists(select 1 from public.supplier_invoice_lines l where l.business_id=i.business_id
    and l.invoice_id=i.id and l.source_line_key=(x.ordinal-1)::text
    and l.order_line_id::text is not distinct from x.value->>'orderLineId'
    and l.ingredient_id::text is not distinct from x.value->>'ingredientId'
    and l.source_item_name=x.value->>'sourceItemName'
    and l.quantity_base4 is not distinct from (x.value->>'quantityBase4')::bigint
    and l.subtotal_cents=(x.value->>'subtotalCents')::bigint))
  and (
   (p.canonical_effect_payload->>'expenseDate' is null and i.canonical_expense_id is null)
   or (p.canonical_effect_payload->>'expenseDate' is not null and exists(
    select 1 from public.expenses e where e.business_id=i.business_id
    and e.id=i.canonical_expense_id and e.status='actual' and e.amount_cents=i.total_cents
    and e.spent_on=i.recognized_expense_on and e.spent_on::text=p.canonical_effect_payload->>'expenseDate'
    and e.dedupe_key=i.recognized_expense_key and e.dedupe_key=p.canonical_effect_payload->>'expenseDedupeKey'))
  )
 limit 1
$$;
revoke all on function public.supervisor_supplier_invoice_effect_proof(uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.supervisor_supplier_invoice_effect_proof(uuid,uuid,text) to service_role;


-- A service-only closure follows an actual finished investigation checkpoint.
-- The existing canonical comparison in the worker has to pass, then this
-- transaction verifies the same source revisions and every approved effect
-- against canonical Pantry/expense readback. No model assertion closes work.
create function public.supervisor_verify_supplier_reconciliation_closure(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_purchase_order_id uuid,
 p_episode_id uuid,p_step_version bigint,p_po_revision bigint,
 p_receipt_versions bigint,p_invoice_versions bigint
) returns boolean language plpgsql security definer set search_path=public as $$
declare po public.purchase_orders;t public.operating_tasks;
 v public.supervisor_investigations;r public.purchase_receipts;i public.supplier_invoices;
 p public.supervisor_proposals;v_key text;
begin
 if auth.role() is distinct from 'service_role' or not public.supervisor_routine_owner_authorized(
  p_business_id,p_owner_user_id,p_thread_id)
 then raise exception 'receiving_closure_owner_required' using errcode='42501';end if;
 if p_receipt_versions not between 1 and 100 or p_invoice_versions not between 1 and 100
 then return false;end if;
 -- Serialize against invoice/receiving effect commits. Lock canonical rows
 -- while testing their readback so a concurrent edit cannot win before closure.
 select * into po from public.purchase_orders where business_id=p_business_id
  and owner_user_id=p_owner_user_id and id=p_purchase_order_id for update;
 if po.id is null or po.revision<>p_po_revision or po.status<>'approved_for_ordering'
 then return false;end if;
 select * into t from public.operating_tasks where business_id=p_business_id
  and owner_user_id=p_owner_user_id and id='supplier-receiving:'||po.id::text
  and kind='supplier_receiving' and entity_id=po.id::text for update;
 if t.id is null or t.status not in ('watching','handled') then return false;end if;
 select * into v from public.supervisor_investigations where business_id=p_business_id
  and owner_user_id=p_owner_user_id and thread_id=p_thread_id and source_type='operating_task'
  and source_id=t.id for update;
 if v.episode_id is distinct from p_episode_id or v.step_version is distinct from p_step_version
  or v.phase not in ('awaiting_owner','resolved') or v.lease_token is not null
  or not coalesce(v.evidence->'modelTools' ? 'inspect_purchase_reconciliation',false)
  or not coalesce(v.evidence->'modelTools' ?| array['get_inventory','get_expenses','get_bills'],false)
  or v.evidence->'receivingClosureEvidence' is distinct from
   jsonb_build_object('poRevision',p_po_revision,'receiptVersions',p_receipt_versions,'invoiceVersions',p_invoice_versions)
 then return false;end if;
 if (select count(*) from public.purchase_receipts where business_id=p_business_id and purchase_order_id=po.id)<>p_receipt_versions
  or (select count(*) from public.supplier_invoices where business_id=p_business_id and purchase_order_id=po.id)<>p_invoice_versions
 then return false;end if;
 perform 1 from public.pantry_stock_purchases s where s.business_id=p_business_id and exists(
  select 1 from public.purchase_receipt_lines l where l.business_id=p_business_id
    and l.purchase_order_id=po.id and l.canonical_stock_line_id=s.line_id) for share;
 perform 1 from public.expenses e where e.business_id=p_business_id and exists(
  select 1 from public.supplier_invoices x where x.business_id=p_business_id and x.purchase_order_id=po.id
   and x.canonical_expense_id=e.id) for share;
 for r in select distinct on (receiving_reference) * from public.purchase_receipts
  where business_id=p_business_id and purchase_order_id=po.id order by receiving_reference,revision desc
 loop
  select * into p from public.supervisor_proposals where business_id=p_business_id
   and owner_user_id=p_owner_user_id and 'approval:'||id::text=r.verification_ref;
  if p.id is null or p.status<>'committed' or not exists(select 1 from public.supervisor_effect_attempts a
   where a.business_id=p_business_id and a.proposal_id=p.id and a.state='verified' and a.effect_hash=p.effect_hash)
   or public.supervisor_supplier_receiving_effect_proof(p_business_id,p.id,p.effect_hash) is distinct from r.id
  then return false;end if;
 end loop;
 for i in select distinct on (invoice_reference) * from public.supplier_invoices
  where business_id=p_business_id and purchase_order_id=po.id order by invoice_reference,revision desc
 loop
  select * into p from public.supervisor_proposals where business_id=p_business_id
   and owner_user_id=p_owner_user_id and 'approval:'||id::text=i.identity_verification_ref;
  if p.id is null or p.status<>'committed' or not exists(select 1 from public.supervisor_effect_attempts a
   where a.business_id=p_business_id and a.proposal_id=p.id and a.state='verified' and a.effect_hash=p.effect_hash)
   or public.supervisor_supplier_invoice_effect_proof(p_business_id,p.id,p.effect_hash) is distinct from i.id
  then return false;end if;
 end loop;
 v_key:='closure:'||po.revision::text||':'||p_receipt_versions::text||':'||p_invoice_versions::text;
 if t.status='handled' then
  return exists(select 1 from public.purchase_reconciliation_events e where e.business_id=p_business_id
   and e.purchase_order_id=po.id and e.event_key=v_key and e.event_kind='closure_verified');
 end if;
 insert into public.purchase_reconciliation_events(business_id,purchase_order_id,supplier_id,owner_user_id,
  event_key,event_kind,source_ref,source_revision)
 values(p_business_id,po.id,po.supplier_id,p_owner_user_id,v_key,'closure_verified',
  'investigation:'||p_episode_id::text||':'||p_step_version::text,po.revision)
 on conflict(business_id,purchase_order_id,event_key) do nothing;
 -- Existing task status trigger settles the associated investigation and
 -- closes its priority notices. No second queue or notification mechanism.
 update public.operating_tasks set status='handled',resolved_at=now(),updated_at=now()
  where business_id=p_business_id and id=t.id and owner_user_id=p_owner_user_id;
 return true;
end $$;
revoke all on function public.supervisor_verify_supplier_reconciliation_closure(uuid,uuid,uuid,uuid,uuid,bigint,bigint,bigint,bigint)
 from public,anon,authenticated;
grant execute on function public.supervisor_verify_supplier_reconciliation_closure(uuid,uuid,uuid,uuid,uuid,bigint,bigint,bigint,bigint)
 to service_role;


-- Additional source-specific reservation on the EXISTING Gmail receipt
-- gateway, never a second sender. Consent and live source versions are
-- checked before reservation and immediately before the provider POST.
create function public.supervisor_guard_supplier_followup_send(
 p_business_id uuid,p_owner_user_id uuid,p_proposal_id uuid,p_effect_hash text,p_reserve boolean
) returns boolean language plpgsql security definer set search_path=public as $$
declare p public.supervisor_proposals; po public.purchase_orders; v jsonb;e jsonb;
 contact public.cafe_supplier_order_contacts;v_key text;v_source text;v_changed integer;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where business_id=p_business_id
  and owner_user_id=p_owner_user_id and id=p_proposal_id for update;
 if p.id is null or p.capability_id<>'alex.gmail_effect.v1' or p.capability_version<>1
  or p.status<>'executing' or p.effect_hash is distinct from p_effect_hash
  or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p.thread_id)
  or not exists(select 1 from public.supervisor_effect_attempts a where a.business_id=p_business_id
    and a.proposal_id=p.id and a.effect_hash=p_effect_hash and a.authorization_kind='click' and a.state='executing')
 then return false;end if;
 e:=p.canonical_effect_payload;v:=e->'supplierFollowup';
 if jsonb_typeof(v) is distinct from 'object' or e->>'operation'<>'send'
   or jsonb_array_length(e->'to')<>1 or jsonb_array_length(e->'cc')<>0 or jsonb_array_length(e->'bcc')<>0
 then return false;end if;
 select * into po from public.purchase_orders where business_id=p_business_id
  and owner_user_id=p_owner_user_id and id=(v->>'purchaseOrderId')::uuid for update;
 if po.id is null or po.status<>'approved_for_ordering' or po.revision is distinct from (v->>'poRevision')::bigint
  or e->>'subject' is distinct from 'Purchase order follow-up '||po.id::text
  or (select count(*) from public.purchase_receipts r where r.business_id=p_business_id and r.purchase_order_id=po.id)
     is distinct from (v->>'receiptVersions')::bigint
  or (select count(*) from public.supplier_invoices i where i.business_id=p_business_id and i.purchase_order_id=po.id)
     is distinct from (v->>'invoiceVersions')::bigint
 then return false;end if;
 select * into contact from public.cafe_supplier_order_contacts where business_id=p_business_id
   and owner_user_id=p_owner_user_id and supplier_id=po.supplier_id and id=(v->>'contactId')::uuid for share;
 if contact.id is null or contact.verified_at is null or contact.revoked_at is not null
   or contact.channel<>'gmail' or contact.email is null
   or lower(contact.email) is distinct from lower(e->'to'->>0)
   or not exists(select 1 from public.connector_accounts g where g.business_id=p_business_id
    and g.owner_user_id=p_owner_user_id and g.id=(e->>'accountId')::uuid and g.provider='gmail'
    and g.status='active' and g.generation=(e->>'generation')::bigint and 'send'=any(g.enabled_operations)
    and 'https://www.googleapis.com/auth/gmail.modify'=any(g.granted_scopes)
    and lower(g.email)=lower(e->>'from'))
 then return false;end if;
 v_key:=po.revision::text||':'||(v->>'receiptVersions')||':'||(v->>'invoiceVersions');
 if exists(select 1 from public.purchase_reconciliation_events x where x.business_id=p_business_id
  and x.purchase_order_id=po.id and x.event_key='closure:'||v_key and x.event_kind='closure_verified')
 then return false;end if;
 v_source:='supervisor-proposal:'||p.id::text;
 if p_reserve then
  insert into public.purchase_reconciliation_events(business_id,purchase_order_id,supplier_id,owner_user_id,
   event_key,event_kind,source_ref,source_revision)
  values(p_business_id,po.id,po.supplier_id,p_owner_user_id,'followup:'||v_key,'followup_reserved',v_source,po.revision)
  on conflict(business_id,purchase_order_id,event_key) do nothing;
  get diagnostics v_changed=row_count;
  return v_changed=1;
 end if;
 return exists(select 1 from public.purchase_reconciliation_events x where x.business_id=p_business_id
  and x.purchase_order_id=po.id and x.event_key='followup:'||v_key and x.event_kind='followup_reserved'
  and x.source_ref=v_source);
end $$;
revoke all on function public.supervisor_guard_supplier_followup_send(uuid,uuid,uuid,text,boolean)
 from public,anon,authenticated;
grant execute on function public.supervisor_guard_supplier_followup_send(uuid,uuid,uuid,text,boolean) to service_role;

-- Extend the existing fenced checkpoint; no additional message writer.
create or replace function public.supervisor_finish_investigation(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,
  p_lease_token uuid,p_outcome text,p_evidence jsonb,p_narrative text,
  p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_phase text;v_hash text;v_msg uuid;v_blocks jsonb;v_proposal public.supervisor_proposals;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  -- The source is the authority for who may see this result right NOW.
  -- Acquire its FOR SHARE lock BEFORE the investigation lease row: source
  -- status triggers already lock source -> investigation in that order.
  -- FOR SHARE blocks concurrent updates to status/owner and deletions until
  -- this transaction atomically commits the checkpoint, inbox and chat.
  -- A prior model read cannot authorize a later report after reassignment.
  if p_source_type='alert' then
    perform 1 from public.alerts a
      where a.business_id=p_business_id and a.id::text=p_source_id
        and a.status in ('new','seen') for share;
  elsif p_source_type='operating_task' then
    perform 1 from public.operating_tasks t
      where t.business_id=p_business_id and t.id=p_source_id
        and t.kind not in ('priority_notice','commitment','event_plan',
          'event_change','event_report')
        and t.status in ('needs_owner','needs_response','watching')
        and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)
      for share;
  else
    return false;
  end if;
  if not found then return false; end if;
  select * into v from public.supervisor_investigations
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id for update;
  if not found or v.thread_id<>p_thread_id or v.revision_hash<>p_revision_hash
    or v.lease_token is distinct from p_lease_token or v.lease_until<=p_now
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then return false; end if;
  if p_outcome='collected' and v.phase='collect' then v_phase:='investigate';
  elsif p_outcome='investigated' and v.phase='investigate' then v_phase:='awaiting_owner';
  elsif p_outcome='followed_up' and v.phase='awaiting_owner' then v_phase:='awaiting_owner';
  elsif p_outcome='rechecked' and v.phase='awaiting_owner' then v_phase:='awaiting_owner';
  else raise exception 'Invalid investigation transition' using errcode='23514'; end if;
  if p_evidence is null or jsonb_typeof(p_evidence)<>'object'
    or octet_length(p_evidence::text)>8192 then
    raise exception 'Invalid investigation evidence' using errcode='22023'; end if;
  if p_outcome not in ('collected','rechecked') and
    (p_narrative is null or length(btrim(p_narrative)) not between 1 and 1800) then
    raise exception 'Investigation needs a grounded next step' using errcode='22023'; end if;
  update public.supervisor_investigations set phase=v_phase,evidence=p_evidence,
    narrative=case when p_outcome in ('collected','rechecked') then narrative else btrim(p_narrative) end,
    step_version=step_version+1,failure_count=0,lease_token=null,lease_until=null,
    next_retry_at=case when p_outcome='collected' then p_now
      else p_now+interval '6 hours' end,
    last_error=null,updated_at=p_now
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id;
  if p_outcome in ('investigated','followed_up') then
    -- Reuse the shared operating_tasks inbox. This insertion and the chat
    -- message below commit atomically from the single fenced SQL checkpoint.
    -- An episode+step key is different for each real follow-up, but stable
    -- for retries of that exact report. It is an owner-private priority notice.
    insert into public.operating_tasks
      (business_id,id,owner_user_id,agent_id,kind,status,payload,confidence,
       evidence,entity_type,dedupe_key)
    values (
      p_business_id,
      'investigation:'||v.stable_key||':'||v.episode_id::text||':'||(v.step_version+1)::text,
      p_owner_user_id,'leo','priority_notice','needs_owner',
      jsonb_build_object('title',left(btrim(p_narrative),180),
        'threadId',p_thread_id::text,'sourceType',p_source_type,
        'sourceId',p_source_id,'revisionHash',p_revision_hash,
        'episodeId',v.episode_id::text,'stepVersion',v.step_version+1,
        'ownerNoticeDate',(p_now at time zone
          (select timezone from public.businesses where id=p_business_id))::date::text,
        'asOf',p_now::text,'intent','priority_investigation',
        'externalEffects','not_attempted'),
      case when p_evidence->'source'->>'quality' in ('partial','missing','stale')
        or (p_evidence ? 'missing' and p_evidence->'missing'<>'[]'::jsonb)
        then 'low' else 'high' end,
      jsonb_build_array(jsonb_build_object('source',p_source_type,
        'facts',jsonb_build_object('sourceId',p_source_id,
          'revisionHash',p_revision_hash,'episodeId',v.episode_id::text,
          'asOf',p_now::text))),
      'priority_source',
      'investigation:'||v.stable_key||':'||v.episode_id::text||':'||(v.step_version+1)::text
    ) on conflict do nothing;
    v_hash:=md5('investigation:'||p_business_id::text||':'||p_owner_user_id::text||
      ':'||p_source_type||':'||p_source_id||':'||p_revision_hash||':'||
      v.episode_id::text||':'||(v.step_version+1)::text);
    v_msg:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
      substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
    v_blocks:=jsonb_build_array(jsonb_build_object('type','text','text',btrim(p_narrative)));
    -- Only an inert, owner-scoped follow-up draft for this exact claimed
    -- receiving source can be attached to the existing atomic owner update.
    if p_evidence ? 'receivingFollowupProposalId' and p_source_type='operating_task'
      and p_source_id like 'supplier-receiving:%' then
      select * into v_proposal from public.supervisor_proposals where business_id=p_business_id
        and owner_user_id=p_owner_user_id and thread_id=p_thread_id
        and id=(p_evidence->>'receivingFollowupProposalId')::uuid
        and status='draft' and capability_id='alex.gmail_effect.v1'
        and 'supplier-receiving:'||(canonical_effect_payload->'supplierFollowup'->>'purchaseOrderId')=p_source_id;
      if v_proposal.id is not null then
        v_blocks:=v_blocks||jsonb_build_array(jsonb_build_object('type','proposal_card','proposalId',v_proposal.id::text));
      end if;
    end if;
    insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
      content_type,structured_content,grounding)
    values(v_msg,p_business_id,p_thread_id,p_owner_user_id,'supervisor','blocks',
      v_blocks,
      jsonb_build_object('status',case
          when p_evidence->'source'->>'quality' in ('partial','missing','stale')
            or (p_evidence ? 'missing' and p_evidence->'missing'<>'[]'::jsonb)
          then 'partial' else 'verified' end,
        'intent','priority_investigation',
        'evidence',jsonb_build_array(jsonb_build_object('source',p_source_type,
          'identifier',p_source_id,'revisionHash',p_revision_hash,
          'asOf',p_now::text)),
        'agentMetadata',jsonb_build_object('phase',v_phase,'stepVersion',v.step_version+1,
          'externalEffects','not_attempted','effectReceipt',null)))
    on conflict(id) do nothing;
  end if;
  return true;
end $$;
