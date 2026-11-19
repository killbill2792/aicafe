-- 14E: owner-confirmed historical statement evidence in the existing upload table.
-- Not a bank connection, complete account inventory, payment authority or ledger.
set lock_timeout='3s';
set statement_timeout='30s';

alter table public.uploads
 add column financial_owner_user_id uuid,
 add column financial_source_sha256 text,
 add column financial_account_key text,
 add column financial_currency text,
 add column financial_from date,
 add column financial_to date,
 add column financial_opening_cents bigint,
 add column financial_closing_cents bigint,
 add column financial_transactions jsonb,
 add column financial_bill_payee text,
 add column financial_bill_payee_key text,
 add column financial_bill_reference text,
 add column financial_bill_revision bigint,
 add column financial_bill_issued_on date,
 add column financial_bill_due_on date,
 add column financial_bill_amount_cents bigint,
 add column financial_bill_source_kind text,
 add column financial_bill_source_ref text,
 add column financial_bill_proposal_id uuid;
-- Newly added columns are NULL for all old rows; NOT VALID enforces new writes immediately.
-- Do not scan old tables inside this lock-bounded transactional migration.
alter table public.uploads add constraint uploads_financial_owner_fk
 foreign key(financial_owner_user_id) references auth.users(id) on delete cascade not valid;
alter table public.uploads add constraint uploads_financial_evidence_shape check (
 ((kind<>'bill_claim' and num_nonnulls(financial_owner_user_id,financial_source_sha256,financial_account_key,
  financial_currency,financial_from,financial_to,financial_opening_cents,financial_closing_cents,
  financial_transactions,financial_bill_payee,financial_bill_payee_key,financial_bill_reference,financial_bill_revision,
  financial_bill_issued_on,financial_bill_due_on,financial_bill_amount_cents,financial_bill_source_kind,
  financial_bill_source_ref,financial_bill_proposal_id)=0)
 or (num_nonnulls(financial_owner_user_id,financial_source_sha256,financial_account_key,
  financial_currency,financial_from,financial_to,financial_opening_cents,financial_closing_cents,
  financial_transactions)=9 and kind='statement' and status='done'
  and num_nonnulls(financial_bill_payee,financial_bill_payee_key,financial_bill_reference,financial_bill_revision,
  financial_bill_issued_on,financial_bill_due_on,financial_bill_amount_cents,financial_bill_source_kind,
  financial_bill_source_ref,financial_bill_proposal_id)=0
  and financial_source_sha256 ~ '^[0-9a-f]{64}$' and financial_account_key ~ '^[0-9a-f]{64}$'
  and financial_currency ~ '^[A-Z]{3}$' and financial_from<=financial_to
  and financial_opening_cents between -9007199254740991 and 9007199254740991
  and financial_closing_cents between -9007199254740991 and 9007199254740991
  and jsonb_typeof(financial_transactions)='array'
  and jsonb_array_length(financial_transactions) between 2 and 10000)
 or (kind='bill_claim' and status='done'
  and num_nonnulls(financial_owner_user_id,financial_source_sha256,financial_currency,
   financial_bill_payee,financial_bill_payee_key,financial_bill_reference,financial_bill_revision,
   financial_bill_issued_on,financial_bill_amount_cents,financial_bill_source_kind,financial_bill_source_ref,
   financial_bill_proposal_id)=12
  and num_nonnulls(financial_account_key,financial_from,financial_to,financial_opening_cents,
   financial_closing_cents,financial_transactions)=0
  and financial_source_sha256 ~ '^[0-9a-f]{64}$' and financial_currency ~ '^[A-Z]{3}$'
  and length(financial_bill_payee) between 2 and 120
  and financial_bill_payee_key=lower(btrim(financial_bill_payee))
  and length(financial_bill_reference) between 1 and 160
  and financial_bill_reference=lower(btrim(financial_bill_reference))
  and financial_bill_revision between 1 and 9007199254740991
  and financial_bill_amount_cents between 1 and 9007199254740991
  and (financial_bill_due_on is null or financial_bill_due_on>=financial_bill_issued_on)
  and financial_bill_source_kind in ('owner_report','owner_attachment')
  and length(financial_bill_source_ref) between 1 and 400)) is true
) not valid;
-- Reason: widen the existing upload kind constraint by one documented, owner-only bill evidence kind; all prior kinds remain accepted and the finance shape independently forbids unscoped bill rows.
-- squawk-ignore ban-drop-constraint
alter table public.uploads drop constraint uploads_kind_check;
alter table public.uploads add constraint uploads_kind_check check(kind in
 ('statement','receipt','pos_csv','sales_csv','labor_csv','ingredients_csv','processing_fees_csv','bill_claim')) not valid;
create unique index uploads_financial_source_uq on public.uploads
 (business_id,financial_owner_user_id,financial_source_sha256) where kind='statement';
create unique index uploads_financial_bill_identity_uq on public.uploads
 (business_id,financial_bill_payee_key,financial_bill_reference,financial_bill_revision) where kind='bill_claim';
create unique index uploads_financial_bill_proposal_uq on public.uploads(business_id,financial_bill_proposal_id)
 where kind='bill_claim';
alter table public.uploads add constraint uploads_financial_bill_proposal_fk
 foreign key(business_id,financial_bill_proposal_id) references public.supervisor_proposals(business_id,id) not valid;
create index uploads_financial_account_idx on public.uploads
 (business_id,financial_owner_user_id,financial_account_key,financial_to desc)
 where financial_owner_user_id is not null;

-- Existing member upload policies must not expose or permit forged finance evidence.
create policy financial_upload_owner_read on public.uploads as restrictive for select to authenticated
 using(financial_owner_user_id is null or (financial_owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=uploads.business_id
  and m.user_id=(select auth.uid()) and m.role='owner')));
create policy financial_upload_no_direct_insert on public.uploads as restrictive for insert to authenticated
 with check(financial_owner_user_id is null);
create policy financial_upload_no_direct_update on public.uploads as restrictive for update to authenticated
 using(financial_owner_user_id is null) with check(financial_owner_user_id is null);
create policy financial_upload_no_direct_delete on public.uploads as restrictive for delete to authenticated
 using(financial_owner_user_id is null);

-- Trusted server passes re-parsed original CSV (only normalized transaction facts, no descriptions).
-- The DB repeats scope/date/currency/chain checks and serializes replay with the source unique key.
create function public.supervisor_record_statement_evidence(
 p_business_id uuid,p_owner_user_id uuid,p_source_sha256 text,p_account_key text,
 p_currency text,p_from date,p_to date,p_opening_cents bigint,p_closing_cents bigint,p_transactions jsonb
) returns uuid language plpgsql security invoker set search_path=public as $$
declare v_id uuid; v_existing public.uploads; v_day date; v_currency text;
 v_row jsonb; v_date date; v_prior date; v_first date; v_running numeric:=p_opening_cents;
 v_amount bigint; v_balance bigint; v_indices integer[]:='{}'; v_index integer;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_only' using errcode='42501';end if;
 perform 1 from public.memberships m where m.business_id=p_business_id
  and m.user_id=p_owner_user_id and m.role='owner' for share;
 if not found then raise exception 'financial_owner_required' using errcode='42501';end if;
 select (now() at time zone b.timezone)::date,b.currency into v_day,v_currency
  from public.businesses b where b.id=p_business_id and not b.is_demo;
 if v_day is null or v_currency is null or p_currency is distinct from v_currency
  or p_source_sha256 is null or p_source_sha256 !~ '^[0-9a-f]{64}$'
  or p_account_key is null or p_account_key !~ '^[0-9a-f]{64}$'
  or p_from is null or p_to is null or p_to<p_from or p_to>v_day
  or p_opening_cents is null or p_closing_cents is null
  or abs(p_opening_cents::numeric)>9007199254740991 or abs(p_closing_cents::numeric)>9007199254740991
  or jsonb_typeof(p_transactions) is distinct from 'array'
 then raise exception 'financial_statement_invalid' using errcode='22023';end if;
 if jsonb_array_length(p_transactions) not between 2 and 10000 then
  raise exception 'financial_statement_size' using errcode='22023';end if;
 for v_row in select value from jsonb_array_elements(p_transactions) loop
  if jsonb_typeof(v_row) is distinct from 'object' or not (v_row ?& array['i','date','amountCents','balanceCents'])
   or jsonb_typeof(v_row->'i') is distinct from 'number'
   or jsonb_typeof(v_row->'amountCents') is distinct from 'number'
   or jsonb_typeof(v_row->'balanceCents') is distinct from 'number'
   or v_row->>'i' !~ '^[0-9]+$' or v_row->>'amountCents' !~ '^-?[0-9]+$'
   or v_row->>'balanceCents' !~ '^-?[0-9]+$' or v_row->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or (v_row-array['i','date','amountCents','balanceCents'])<>'{}'::jsonb
  then raise exception 'financial_statement_row_invalid' using errcode='22023';end if;
  v_index:=(v_row->>'i')::integer;v_date:=(v_row->>'date')::date;
  v_amount:=(v_row->>'amountCents')::bigint;v_balance:=(v_row->>'balanceCents')::bigint;
  if v_date is null or v_index=any(v_indices) or v_index>=jsonb_array_length(p_transactions)
   or (v_prior is not null and v_date<v_prior) or abs(v_amount::numeric)>9007199254740991
   or abs(v_balance::numeric)>9007199254740991
  then raise exception 'financial_statement_row_invalid' using errcode='22023';end if;
  v_indices:=array_append(v_indices,v_index);
  v_first:=coalesce(v_first,v_date);v_prior:=v_date;
  v_running:=v_running+v_amount;
  if v_running<>v_balance then raise exception 'financial_statement_balance_mismatch' using errcode='22023';end if;
 end loop;
 if v_first is distinct from p_from or v_prior is distinct from p_to or v_running<>p_closing_cents then
  raise exception 'financial_statement_balance_mismatch' using errcode='22023';end if;
 insert into public.uploads(business_id,kind,status,financial_owner_user_id,financial_source_sha256,
  financial_account_key,financial_currency,financial_from,financial_to,financial_opening_cents,
  financial_closing_cents,financial_transactions)
 values(p_business_id,'statement','done',p_owner_user_id,p_source_sha256,p_account_key,p_currency,
  p_from,p_to,p_opening_cents,p_closing_cents,p_transactions)
 on conflict(business_id,financial_owner_user_id,financial_source_sha256) where kind='statement' do nothing returning id into v_id;
 if v_id is not null then return v_id;end if;
 select * into v_existing from public.uploads where business_id=p_business_id
  and financial_owner_user_id=p_owner_user_id and financial_source_sha256=p_source_sha256 and kind='statement';
 if not found or v_existing.financial_account_key is distinct from p_account_key
  or v_existing.financial_currency is distinct from p_currency
  or v_existing.financial_from is distinct from p_from or v_existing.financial_to is distinct from p_to
  or v_existing.financial_opening_cents is distinct from p_opening_cents
  or v_existing.financial_closing_cents is distinct from p_closing_cents
  or v_existing.financial_transactions is distinct from p_transactions
 then raise exception 'financial_statement_source_conflict' using errcode='22023';end if;
 return v_existing.id;
end $$;
revoke all on function public.supervisor_record_statement_evidence(uuid,uuid,text,text,text,date,date,bigint,bigint,jsonb)
 from public,anon,authenticated;
grant execute on function public.supervisor_record_statement_evidence(uuid,uuid,text,text,text,date,date,bigint,bigint,jsonb) to service_role;


-- One stable money review episode per owner; source changes drive existing
-- investigations. A past due date alone never establishes overdue payment.
create policy financial_review_owner_read on public.operating_tasks as restrictive for select to authenticated
 using(id not like 'financial-review:%' or (owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=operating_tasks.business_id
   and m.user_id=(select auth.uid()) and m.role='owner')));
create policy financial_review_no_direct_insert on public.operating_tasks as restrictive for insert to authenticated
 with check(id not like 'financial-review:%');
create policy financial_review_no_direct_update on public.operating_tasks as restrictive for update to authenticated
 using(id not like 'financial-review:%') with check(id not like 'financial-review:%');
create policy financial_review_no_direct_delete on public.operating_tasks as restrictive for delete to authenticated
 using(id not like 'financial-review:%');
create function public.supervisor_sync_financial_review(p_business_id uuid,p_owner_user_id uuid,p_now timestamptz)
 returns integer language plpgsql security invoker set search_path=public as $$
declare v_day date;v_facts jsonb;v_count integer;v_invoice_count bigint;v_statement_count bigint;
 v_invoice_version text;v_statement_version text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_only' using errcode='42501';end if;
 perform 1 from public.memberships m where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner' for share;
 if not found then raise exception 'financial_owner_required' using errcode='42501';end if;
 select (p_now at time zone b.timezone)::date into v_day from public.businesses b where b.id=p_business_id and not b.is_demo;
 if v_day is null then raise exception 'financial_context_missing';end if;
 -- Current revisions only. Digests track material source changes, not the tick timestamp.
 with current_claims as (
  select distinct on(supplier_id,invoice_reference) id,revision,issued_on,due_on
  from public.supplier_invoices where business_id=p_business_id and owner_user_id=p_owner_user_id
  order by supplier_id,invoice_reference,revision desc
 )
 select count(*),md5(coalesce(string_agg(id::text||':'||revision::text||':'||
  case when due_on is null then 'undated' when due_on<v_day then 'past_date' else 'coming_due' end,
  ',' order by id),''))
 into v_invoice_count,v_invoice_version from current_claims where issued_on<=v_day and (due_on is null or due_on<=v_day+7);
 select count(*),md5(coalesce(string_agg(id::text,',' order by id),''))
 into v_statement_count,v_statement_version from public.uploads
 where business_id=p_business_id and financial_owner_user_id=p_owner_user_id
 and financial_to<=v_day and kind='statement' and status='done';
 if v_invoice_count=0 and v_statement_count=0 then return 0;end if;
 v_facts:=jsonb_build_array(jsonb_build_object('source','financial_evidence','facts',jsonb_build_object(
  'invoiceClaimsNeedingReview',v_invoice_count,'statementDocuments',v_statement_count,
  'invoiceSourceVersion',v_invoice_version,'statementSourceVersion',v_statement_version,
  'paymentStatusKnown',false,'liveCashKnown',false)));
 insert into public.operating_tasks(business_id,id,owner_user_id,agent_id,kind,entity_type,
  entity_id,status,confidence,payload,evidence,created_at)
 values(p_business_id,'financial-review:'||p_owner_user_id::text,p_owner_user_id,'leo','money_update',
  'financial_review',p_owner_user_id::text,'watching','low',
  jsonb_build_object('title','Financial evidence review','paymentStatusKnown',false,'liveCashKnown',false),v_facts,p_now)
 on conflict(business_id,id) do update set evidence=excluded.evidence,status='watching',resolved_at=null,updated_at=p_now
 where operating_tasks.kind='money_update' and operating_tasks.owner_user_id=p_owner_user_id
  and operating_tasks.evidence is distinct from excluded.evidence;
 get diagnostics v_count=row_count;return v_count;
end $$;
revoke all on function public.supervisor_sync_financial_review(uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.supervisor_sync_financial_review(uuid,uuid,timestamptz) to service_role;

-- Extend the existing document identity rather than synthesize a PO or another ledger.
-- Reason: approved standalone document support; existing PO-specific foreign keys and readers remain, new standalone owner policies and parent validation below.
-- squawk-ignore ban-drop-not-null
alter table public.supplier_invoices alter column purchase_order_id drop not null;
-- Reason: approved standalone document support; existing PO-specific foreign keys and readers remain, new standalone owner policies and parent validation below.
-- squawk-ignore ban-drop-not-null
alter table public.supplier_invoice_lines alter column purchase_order_id drop not null;
-- Reason: approved standalone document support; existing PO-specific foreign keys and readers remain, new standalone owner policies and parent validation below.
-- squawk-ignore ban-drop-not-null
alter table public.purchase_reconciliation_events alter column purchase_order_id drop not null;
-- Old PO-linked rows already satisfy the transitive supplier/parent identity.
-- New standalone writes are constrained immediately; no in-transaction validation scan.
alter table public.supplier_invoices add constraint supplier_invoice_cafe_supplier
 foreign key(business_id,supplier_id) references public.cafe_suppliers(business_id,id) not valid;
alter table public.supplier_invoices add constraint supplier_invoice_standalone_claim_only
 check(purchase_order_id is not null or canonical_expense_id is null) not valid;
create unique index supplier_invoice_cafe_id on public.supplier_invoices(business_id,id);
alter table public.supplier_invoice_lines add constraint supplier_invoice_line_parent
 foreign key(business_id,invoice_id) references public.supplier_invoices(business_id,id) not valid;
alter table public.supplier_invoice_lines add constraint supplier_invoice_line_standalone
 check(purchase_order_id is not null or (order_line_id is null and ingredient_id is null)) not valid;
alter table public.purchase_reconciliation_events add constraint supplier_event_cafe_supplier
 foreign key(business_id,supplier_id) references public.cafe_suppliers(business_id,id) not valid;
create unique index supplier_standalone_event_key on public.purchase_reconciliation_events(business_id,supplier_id,event_key)
 where purchase_order_id is null;
create policy standalone_invoice_owner_read on public.supplier_invoices for select to authenticated
 using(purchase_order_id is null and owner_user_id=(select auth.uid()) and exists(
 select 1 from public.memberships m where m.business_id=supplier_invoices.business_id and m.user_id=(select auth.uid()) and m.role='owner'));
create policy standalone_invoice_line_owner_read on public.supplier_invoice_lines for select to authenticated
 using(purchase_order_id is null and exists(select 1 from public.supplier_invoices i
  where i.business_id=supplier_invoice_lines.business_id and i.id=supplier_invoice_lines.invoice_id
   and i.purchase_order_id is null and i.owner_user_id=(select auth.uid())));
create policy standalone_invoice_event_owner_read on public.purchase_reconciliation_events for select to authenticated
 using(purchase_order_id is null and owner_user_id=(select auth.uid()) and exists(
 select 1 from public.memberships m where m.business_id=purchase_reconciliation_events.business_id and m.user_id=(select auth.uid()) and m.role='owner'));
create or replace function public.supervisor_commit_supplier_invoice(
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
 perform 1 from public.memberships where business_id=p_business_id and user_id=v_owner and role='owner' for share;
 if not found then raise exception 'invoice_owner_required' using errcode='42501';end if;
 -- Serialize invoice revisions and documentary settlement allocations for the same café.
 perform pg_advisory_xact_lock(hashtextextended('financial-invoice:'||p_business_id::text,0));
 e:=p.canonical_effect_payload;
 if e->>'purchaseOrderId' is null then
  if e->>'poRevision' is not null or e->>'expenseDate' is not null
   or e->>'existingExpenseId' is not null or e->>'expenseDedupeKey' is not null
   or e->>'sourceKind' not in ('owner_report','owner_attachment')
   or e->>'standaloneSupplierName' is null or not (e ? 'purchaseOrderId')
  then raise exception 'standalone_invoice_claim_only' using errcode='22023';end if;
  select s.id,s.display_name into po.supplier_id,po.supplier_name_snapshot
   from public.cafe_suppliers s where s.business_id=p_business_id
   and s.id=(e->>'supplierId')::uuid
   and s.normalized_name=lower(btrim(e->>'standaloneSupplierName'))
   and s.display_name=e->>'supplierName' for share;
  if po.supplier_id is null then raise exception 'standalone_invoice_supplier_changed' using errcode='P0001';end if;
 else
 select * into po from public.purchase_orders where business_id=p_business_id and owner_user_id=v_owner
  and id=(e->>'purchaseOrderId')::uuid for update;
 if po.id is null or po.status<>'approved_for_ordering' or po.revision is distinct from (e->>'poRevision')::bigint
  or po.supplier_id is distinct from (e->>'supplierId')::uuid
 then raise exception 'invoice_po_changed' using errcode='P0001';end if;
 end if;
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
 if coalesce(prior.revision,0)<>v_rev or (prior.id is not null and (prior.purchase_order_id is distinct from po.id or prior.owner_user_id<>v_owner))
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

create or replace function public.supervisor_supplier_invoice_effect_proof(
 p_business_id uuid,p_proposal_id uuid,p_effect_hash text
) returns uuid language sql stable security invoker set search_path=public as $$
 select i.id from public.supplier_invoices i
 join public.supervisor_proposals p on p.business_id=i.business_id
  and p.id=p_proposal_id and p.owner_user_id=i.owner_user_id
 where i.business_id=p_business_id and p.capability_id='maya.supplier_invoice.v1'
  and p.effect_hash=p_effect_hash and i.identity_verification_ref='approval:'||p.id::text
  and i.purchase_order_id::text is not distinct from p.canonical_effect_payload->>'purchaseOrderId'
  and i.supplier_id::text=p.canonical_effect_payload->>'supplierId'
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


-- Documentary allocation evidence, not a second payment ledger. Existing
-- reconciliation events remain append-only; only the click-gated RPC can insert.
alter table public.purchase_reconciliation_events
 add column financial_kind text,
 add column financial_invoice_id uuid,
 add column financial_upload_id uuid,
 add column financial_row_index bigint,
 add column financial_tx_date date,
 add column financial_tx_amount_cents bigint,
 add column financial_tx_balance_cents bigint,
 add column financial_allocation_cents bigint,
 add column financial_reverses_id uuid;
create unique index financial_upload_cafe_id on public.uploads(business_id,id);
create unique index financial_event_cafe_id on public.purchase_reconciliation_events(business_id,id);
alter table public.purchase_reconciliation_events add constraint financial_event_invoice_fk
 foreign key(business_id,financial_invoice_id) references public.supplier_invoices(business_id,id) not valid;
alter table public.purchase_reconciliation_events add constraint financial_event_upload_fk
 foreign key(business_id,financial_upload_id) references public.uploads(business_id,id) not valid;
alter table public.purchase_reconciliation_events add constraint financial_event_reverse_fk
 foreign key(business_id,financial_reverses_id) references public.purchase_reconciliation_events(business_id,id) not valid;
alter table public.purchase_reconciliation_events add constraint financial_event_shape check (
 (num_nonnulls(financial_kind,financial_invoice_id,financial_upload_id,financial_row_index,financial_tx_date,
 financial_tx_amount_cents,financial_tx_balance_cents,financial_allocation_cents,financial_reverses_id)=0)
 or ((num_nonnulls(financial_kind,financial_invoice_id,financial_upload_id,financial_row_index,financial_tx_date,
 financial_tx_amount_cents,financial_tx_balance_cents,financial_allocation_cents)=8
 and event_kind='evidence_observed' and event_key like 'financial-settlement:%'
 and financial_row_index between 0 and 9999
 and financial_allocation_cents between 1 and 9007199254740991
 and abs(financial_tx_amount_cents::numeric)<=9007199254740991
 and abs(financial_tx_balance_cents::numeric)<=9007199254740991
 and financial_allocation_cents<=abs(financial_tx_amount_cents::numeric)
 and ((financial_kind='settlement_evidence_linked' and financial_tx_amount_cents<0 and financial_reverses_id is null)
 or (financial_kind='settlement_evidence_reversed' and financial_tx_amount_cents>0 and financial_reverses_id is not null))) is true)
) not valid;
create unique index financial_event_proposal_uq on public.purchase_reconciliation_events(business_id,event_key)
 where financial_kind is not null;
create index financial_event_transaction_idx on public.purchase_reconciliation_events
 (business_id,financial_tx_date,financial_tx_amount_cents,financial_tx_balance_cents) where financial_kind is not null;
create index financial_event_invoice_idx on public.purchase_reconciliation_events(business_id,financial_invoice_id)
 where financial_kind is not null;
create policy financial_event_owner_scope on public.purchase_reconciliation_events as restrictive for select to authenticated
 using(financial_kind is null or (owner_user_id=(select auth.uid()) and exists(
 select 1 from public.memberships m where m.business_id=purchase_reconciliation_events.business_id
 and m.user_id=(select auth.uid()) and m.role='owner')));

create function public.supervisor_commit_financial_settlement(
 p_business_id uuid,p_thread_id uuid,p_proposal_id uuid,p_effect_hash text
) returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_owner uuid:=auth.uid();p public.supervisor_proposals;a public.supervisor_effect_attempts;
 inv public.supplier_invoices;u public.uploads;original public.purchase_reconciliation_events;
 original_upload public.uploads;existing public.purchase_reconciliation_events;
 e jsonb;tx jsonb;v_count bigint;v_index bigint;v_amount bigint;v_balance bigint;
 v_date date;v_alloc bigint;v_total numeric;v_remaining numeric;v_kind text;v_id uuid;
begin
 if v_owner is null then raise exception 'financial_owner_required' using errcode='42501';end if;
 perform 1 from public.memberships m join public.businesses b on b.id=m.business_id
 where m.business_id=p_business_id and m.user_id=v_owner and m.role='owner' and not b.is_demo for share of m;
 if not found then raise exception 'financial_owner_required' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where business_id=p_business_id and owner_user_id=v_owner
  and thread_id=p_thread_id and id=p_proposal_id for update;
 if p.id is null or p.capability_id<>'leo.financial_settlement.v1' or p.capability_version<>1
  or p.status<>'executing' or p.effect_hash is distinct from p_effect_hash
 then raise exception 'financial_settlement_claim_required' using errcode='42501';end if;
 select * into a from public.supervisor_effect_attempts where business_id=p_business_id and proposal_id=p.id
  and effect_hash=p_effect_hash and authorization_kind='click' and state='executing' for update;
 if a.id is null or not exists(select 1 from public.supervisor_approvals x
  where x.business_id=p_business_id and x.proposal_id=p.id and x.owner_user_id=v_owner
  and x.effect_hash=p_effect_hash and x.authorization_kind='click' and x.approved_revision=p.revision-2)
 then raise exception 'financial_settlement_click_required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('financial-invoice:'||p_business_id::text,0));
 e:=p.canonical_effect_payload;
 v_kind:=e->>'financialKind';v_index:=(e->>'rowIndex')::bigint;v_alloc:=(e->>'allocationCents')::bigint;
 if v_kind is null or v_kind not in ('settlement_evidence_linked','settlement_evidence_reversed')
  or v_index is null or v_index not between 0 and 9999 or v_alloc is null or v_alloc not between 1 and 9007199254740991
 then raise exception 'financial_settlement_invalid' using errcode='22023';end if;
 select * into existing from public.purchase_reconciliation_events where business_id=p_business_id
  and event_key='financial-settlement:'||p.id::text and owner_user_id=v_owner;
 if existing.id is not null then
  if existing.financial_invoice_id::text is distinct from e->>'invoiceId' or existing.financial_kind<>v_kind
   or existing.financial_upload_id::text is distinct from e->>'uploadId' or existing.financial_row_index<>v_index
   or existing.financial_allocation_cents<>v_alloc or existing.financial_reverses_id::text is distinct from e->>'reversesId'
  then raise exception 'financial_settlement_replay_conflict';end if;
  return existing.id;
 end if;
 select * into inv from public.supplier_invoices where business_id=p_business_id and owner_user_id=v_owner
  and id=(e->>'invoiceId')::uuid;
 if inv.id is null or inv.revision is distinct from (e->>'invoiceRevision')::bigint
  or inv.supplier_id::text is distinct from e->>'supplierId' or inv.invoice_reference is distinct from e->>'invoiceReference'
  or inv.currency_code is distinct from e->>'currency' or inv.total_cents is distinct from (e->>'invoiceTotalCents')::bigint
 then raise exception 'financial_settlement_invoice_changed' using errcode='P0001';end if;
 if v_kind='settlement_evidence_linked' and exists(select 1 from public.supplier_invoices i
  where i.business_id=p_business_id and i.supplier_id=inv.supplier_id and i.invoice_reference=inv.invoice_reference
   and i.revision>inv.revision)
 then raise exception 'financial_settlement_invoice_revision_changed' using errcode='P0001';end if;
 select * into u from public.uploads where business_id=p_business_id and financial_owner_user_id=v_owner
  and id=(e->>'uploadId')::uuid and kind='statement' and status='done';
 if u.id is null or u.financial_source_sha256 is distinct from e->>'sourceHash'
  or u.financial_currency is distinct from inv.currency_code or u.financial_account_key is distinct from e->>'accountKey'
 then raise exception 'financial_settlement_source_changed' using errcode='P0001';end if;
 select count(*) into v_count from jsonb_array_elements(u.financial_transactions) x where (x->>'i')::bigint=v_index;
 if v_count<>1 then raise exception 'financial_settlement_row_ambiguous' using errcode='22023';end if;
 select x into tx from jsonb_array_elements(u.financial_transactions) x where (x->>'i')::bigint=v_index;
 v_date:=(tx->>'date')::date;v_amount:=(tx->>'amountCents')::bigint;v_balance:=(tx->>'balanceCents')::bigint;
 if v_date::text is distinct from e->>'transactionDate' or v_amount is distinct from (e->>'transactionAmountCents')::bigint
  or v_balance is distinct from (e->>'transactionBalanceCents')::bigint or v_alloc>abs(v_amount::numeric)
  or (v_kind='settlement_evidence_linked' and v_amount>=0) or (v_kind='settlement_evidence_reversed' and v_amount<=0)
 then raise exception 'financial_settlement_transaction_changed' using errcode='22023';end if;
 -- Same date, signed movement and ending balance is a conservative stable
 -- transaction identity across overlapping exports and alternate nicknames.
 -- Ambiguous repeated tuples inside a source cannot be allocated.
 select count(*) into v_count from jsonb_array_elements(u.financial_transactions) x where
  x->>'date'=v_date::text and (x->>'amountCents')::bigint=v_amount and (x->>'balanceCents')::bigint=v_balance;
 if v_count<>1 then raise exception 'financial_settlement_row_ambiguous' using errcode='22023';end if;
 select coalesce(sum(f.financial_allocation_cents),0) into v_total from public.purchase_reconciliation_events f
 where f.business_id=p_business_id and f.financial_kind=v_kind and f.financial_tx_date=v_date
 and f.financial_tx_amount_cents=v_amount and f.financial_tx_balance_cents=v_balance;
 if v_total+v_alloc>abs(v_amount::numeric) then raise exception 'financial_settlement_transaction_overallocated' using errcode='P0001';end if;
 if v_kind='settlement_evidence_linked' then
  if e->>'reversesId' is not null then raise exception 'financial_settlement_unexpected_reversal' using errcode='22023';end if;
  -- An invoice correction cannot silently inherit earlier allocations.
  -- Until the older documented links are explicitly reversed review is required.
  if exists(select 1 from public.supplier_invoices prev
   join public.purchase_reconciliation_events f on f.business_id=prev.business_id and f.financial_invoice_id=prev.id
   where prev.business_id=p_business_id and prev.supplier_id=inv.supplier_id and prev.invoice_reference=inv.invoice_reference
    and prev.revision<inv.revision and f.financial_kind='settlement_evidence_linked'
    and f.financial_allocation_cents>(select coalesce(sum(rev.financial_allocation_cents),0)
       from public.purchase_reconciliation_events rev where rev.business_id=p_business_id and rev.financial_reverses_id=f.id))
  then raise exception 'financial_settlement_previous_revision_unresolved' using errcode='P0001';end if;
  select coalesce(sum(case when f.financial_kind='settlement_evidence_linked' then f.financial_allocation_cents
    else -f.financial_allocation_cents end),0) into v_total from public.purchase_reconciliation_events f
   where f.business_id=p_business_id and f.financial_invoice_id=inv.id and f.financial_kind is not null;
  if v_total<0 or v_total+v_alloc>inv.total_cents then raise exception 'financial_settlement_invoice_overallocated' using errcode='P0001';end if;
 else
  select * into original from public.purchase_reconciliation_events f where f.business_id=p_business_id
   and f.owner_user_id=v_owner and f.id=(e->>'reversesId')::uuid and f.financial_kind='settlement_evidence_linked'
   and f.financial_invoice_id=inv.id;
  select * into original_upload from public.uploads where business_id=p_business_id
   and financial_owner_user_id=v_owner and id=original.financial_upload_id;
  if original.id is null or original_upload.id is null or original_upload.financial_account_key<>u.financial_account_key
   or original_upload.financial_currency<>u.financial_currency or v_date<original.financial_tx_date
  then raise exception 'financial_settlement_reversal_source_mismatch' using errcode='22023';end if;
  select original.financial_allocation_cents-coalesce(sum(f.financial_allocation_cents),0) into v_remaining
   from public.purchase_reconciliation_events f where f.business_id=p_business_id and f.financial_reverses_id=original.id;
  if v_alloc>v_remaining then raise exception 'financial_settlement_reversal_overallocated' using errcode='P0001';end if;
 end if;
 insert into public.purchase_reconciliation_events(business_id,purchase_order_id,supplier_id,owner_user_id,
  event_key,event_kind,source_ref,source_revision,financial_kind,financial_invoice_id,financial_upload_id,
  financial_row_index,financial_tx_date,financial_tx_amount_cents,financial_tx_balance_cents,
  financial_allocation_cents,financial_reverses_id)
 values(p_business_id,inv.purchase_order_id,inv.supplier_id,v_owner,'financial-settlement:'||p.id::text,
  'evidence_observed','statement:'||u.id::text||':'||v_index::text,inv.revision,v_kind,inv.id,u.id,
  v_index,v_date,v_amount,v_balance,v_alloc,original.id)
 returning id into v_id;
 return v_id;
end $$;
revoke all on function public.supervisor_commit_financial_settlement(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.supervisor_commit_financial_settlement(uuid,uuid,uuid,text) to authenticated;

-- Receipt readback is documentary only, even if the current invoice was
-- subsequently corrected; a changed invoice does not erase a past event.
create function public.supervisor_financial_settlement_proof(p_business_id uuid,p_proposal_id uuid,p_effect_hash text)
 returns uuid language sql stable security invoker set search_path=public as $$
 select f.id from public.purchase_reconciliation_events f
 join public.supervisor_proposals p on p.business_id=f.business_id and p.id=p_proposal_id and p.owner_user_id=f.owner_user_id
 join public.supplier_invoices i on i.business_id=f.business_id and i.id=f.financial_invoice_id
 join public.uploads u on u.business_id=f.business_id and u.id=f.financial_upload_id and u.financial_owner_user_id=f.owner_user_id
 where f.business_id=p_business_id and p.capability_id='leo.financial_settlement.v1'
 and p.effect_hash=p_effect_hash and f.event_key='financial-settlement:'||p.id::text
 and f.financial_invoice_id::text=p.canonical_effect_payload->>'invoiceId'
 and f.source_revision=(p.canonical_effect_payload->>'invoiceRevision')::bigint
 and f.financial_kind=p.canonical_effect_payload->>'financialKind'
 and f.financial_upload_id::text=p.canonical_effect_payload->>'uploadId'
 and f.financial_row_index=(p.canonical_effect_payload->>'rowIndex')::bigint
 and f.financial_tx_date::text=p.canonical_effect_payload->>'transactionDate'
 and f.financial_tx_amount_cents=(p.canonical_effect_payload->>'transactionAmountCents')::bigint
 and f.financial_tx_balance_cents=(p.canonical_effect_payload->>'transactionBalanceCents')::bigint
 and f.financial_allocation_cents=(p.canonical_effect_payload->>'allocationCents')::bigint
 and f.financial_reverses_id::text is not distinct from p.canonical_effect_payload->>'reversesId'
 and i.owner_user_id=f.owner_user_id and u.financial_source_sha256=p.canonical_effect_payload->>'sourceHash'
 and exists(select 1 from jsonb_array_elements(u.financial_transactions) tx where
   (tx->>'i')::bigint=f.financial_row_index and tx->>'date'=f.financial_tx_date::text
   and (tx->>'amountCents')::bigint=f.financial_tx_amount_cents and (tx->>'balanceCents')::bigint=f.financial_tx_balance_cents)
 limit 1
$$;
revoke all on function public.supervisor_financial_settlement_proof(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_financial_settlement_proof(uuid,uuid,text) to service_role;

-- Separate documentary bills, not recurring configuration, invoices or expenses.
-- The exact owner click captures the dated claim under its real source identity.
create function public.supervisor_commit_financial_bill(
 p_business_id uuid,p_thread_id uuid,p_proposal_id uuid,p_effect_hash text
) returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_owner uuid:=auth.uid();p public.supervisor_proposals;a public.supervisor_effect_attempts;
 prev public.uploads;old public.uploads;e jsonb;v_msg uuid;v_day date;v_ref text;v_payee text;
 v_key text;v_date date;v_due date;v_rev bigint;v_amount bigint;v_id uuid;
begin
 if v_owner is null then raise exception 'financial_owner_required' using errcode='42501';end if;
 perform 1 from public.memberships m join public.businesses b on b.id=m.business_id
 where m.business_id=p_business_id and m.user_id=v_owner and m.role='owner' and not b.is_demo for share of m;
 if not found then raise exception 'financial_owner_required' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where business_id=p_business_id and owner_user_id=v_owner
  and thread_id=p_thread_id and id=p_proposal_id for update;
 if p.id is null or p.capability_id<>'leo.financial_bill.v1' or p.capability_version<>1
  or p.status<>'executing' or p.effect_hash is distinct from p_effect_hash
 then raise exception 'financial_bill_claim_required' using errcode='42501';end if;
 select * into a from public.supervisor_effect_attempts where business_id=p_business_id and proposal_id=p.id
  and effect_hash=p_effect_hash and authorization_kind='click' and state='executing' for update;
 if a.id is null or not exists(select 1 from public.supervisor_approvals x
  where x.business_id=p_business_id and x.proposal_id=p.id and x.owner_user_id=v_owner
  and x.effect_hash=p_effect_hash and x.authorization_kind='click' and x.approved_revision=p.revision-2)
 then raise exception 'financial_bill_click_required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('financial-invoice:'||p_business_id::text,0));
 e:=p.canonical_effect_payload;
 v_payee:=btrim(e->>'payee');v_key:=lower(v_payee);v_ref:=e->>'reference';
 v_date:=(e->>'issuedOn')::date;v_due:=(e->>'dueOn')::date;
 v_rev:=(e->>'expectedRevision')::bigint;v_amount:=(e->>'amountCents')::bigint;
 select (now() at time zone b.timezone)::date into v_day from public.businesses b where b.id=p_business_id;
 if v_payee is null or length(v_payee) not between 2 and 120 or v_ref is null or length(v_ref) not between 1 and 160
  or v_ref<>lower(btrim(v_ref)) or v_day is null or v_date is null or v_date>v_day or v_due<v_date
  or v_rev is null or v_rev not between 0 and 9007199254740990
  or v_amount is null or v_amount not between 1 and 9007199254740991
  or e->>'currency' is null or e->>'currency' !~ '^[A-Z]{3}$'
  or e->>'sourceSha256' is null or e->>'sourceSha256' !~ '^[a-f0-9]{64}$'
  or e->>'sourceKind' is null or e->>'sourceKind' not in ('owner_report','owner_attachment')
  or e->>'sourceRef' is null
 then raise exception 'financial_bill_invalid' using errcode='22023';end if;
 v_msg:=split_part(e->>'sourceRef',':',2)::uuid;
 if split_part(e->>'sourceRef',':',1) is distinct from case when e->>'sourceKind'='owner_report' then 'owner-message' else 'owner-attachment' end
  or not exists(select 1 from public.ai_messages m where m.id=v_msg and m.business_id=p_business_id
   and m.owner_user_id=v_owner and m.thread_id=p_thread_id and m.role='owner' and m.author_user_id=v_owner)
 then raise exception 'financial_bill_source_unverified' using errcode='42501';end if;
 -- A known supplier uses the existing supplier-invoice path to prevent
 -- creating two claims from the same invoice in different sources.
 if exists(select 1 from public.cafe_suppliers s where s.business_id=p_business_id and s.normalized_name=v_key)
 then raise exception 'financial_bill_use_supplier_invoice' using errcode='P0001';end if;
 select * into old from public.uploads where business_id=p_business_id and financial_owner_user_id=v_owner
  and kind='bill_claim' and financial_bill_proposal_id=p.id;
 if old.id is not null then return old.id;end if;
 select * into prev from public.uploads where business_id=p_business_id and kind='bill_claim'
  and financial_bill_payee_key=v_key and financial_bill_reference=v_ref order by financial_bill_revision desc limit 1;
 if coalesce(prev.financial_bill_revision,0)<>v_rev or
  (prev.id is not null and (prev.financial_owner_user_id<>v_owner or prev.financial_currency<>e->>'currency'))
 then raise exception 'financial_bill_revision_changed' using errcode='P0001';end if;
 if exists(select 1 from public.uploads u where u.business_id=p_business_id and u.kind='bill_claim'
  and u.financial_source_sha256=e->>'sourceSha256'
  and (u.financial_bill_payee_key<>v_key or u.financial_bill_reference<>v_ref))
 then raise exception 'financial_bill_source_duplicate_review' using errcode='P0001';end if;
 insert into public.uploads(business_id,kind,status,financial_owner_user_id,financial_source_sha256,financial_currency,
  financial_bill_payee,financial_bill_payee_key,financial_bill_reference,financial_bill_revision,financial_bill_issued_on,
  financial_bill_due_on,financial_bill_amount_cents,financial_bill_source_kind,financial_bill_source_ref,financial_bill_proposal_id)
 values(p_business_id,'bill_claim','done',v_owner,e->>'sourceSha256',e->>'currency',v_payee,v_key,v_ref,v_rev+1,
  v_date,v_due,v_amount,e->>'sourceKind',e->>'sourceRef',p.id)
 returning id into v_id;
 return v_id;
end $$;
revoke all on function public.supervisor_commit_financial_bill(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.supervisor_commit_financial_bill(uuid,uuid,uuid,text) to authenticated;
create function public.supervisor_financial_bill_proof(p_business_id uuid,p_proposal_id uuid,p_effect_hash text)
 returns uuid language sql stable security invoker set search_path=public as $$
 select u.id from public.uploads u join public.supervisor_proposals p on p.business_id=u.business_id
 and p.id=u.financial_bill_proposal_id and p.owner_user_id=u.financial_owner_user_id
 where u.business_id=p_business_id and p.id=p_proposal_id and p.effect_hash=p_effect_hash
 and p.capability_id='leo.financial_bill.v1' and u.kind='bill_claim' and u.status='done'
 and u.financial_bill_payee=p.canonical_effect_payload->>'payee'
 and u.financial_bill_reference=p.canonical_effect_payload->>'reference'
 and u.financial_bill_revision=(p.canonical_effect_payload->>'expectedRevision')::bigint+1
 and u.financial_bill_issued_on::text=p.canonical_effect_payload->>'issuedOn'
 and u.financial_bill_due_on::text is not distinct from p.canonical_effect_payload->>'dueOn'
 and u.financial_bill_amount_cents=(p.canonical_effect_payload->>'amountCents')::bigint
 and u.financial_currency=p.canonical_effect_payload->>'currency'
 and u.financial_source_sha256=p.canonical_effect_payload->>'sourceSha256'
 and u.financial_bill_source_kind=p.canonical_effect_payload->>'sourceKind'
 and u.financial_bill_source_ref=p.canonical_effect_payload->>'sourceRef'
 limit 1
$$;
revoke all on function public.supervisor_financial_bill_proof(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.supervisor_financial_bill_proof(uuid,uuid,text) to service_role;

create or replace function public.supervisor_reconcile_supplier_receiving(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,p_revision integer
) returns public.supervisor_proposals language plpgsql security definer set search_path=public as $$
declare p public.supervisor_proposals;a public.supervisor_effect_attempts;proof uuid;
begin
 if auth.role() is distinct from 'service_role' or not exists(select 1 from public.memberships m
  where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner')
 then raise exception 'receiving_owner_required' using errcode='42501';end if;
 select * into p from public.supervisor_proposals where id=p_proposal_id
  and business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if p.id is null or p.revision<>p_revision or p.capability_id not in ('maya.supplier_receiving.v1','maya.supplier_invoice.v1','leo.financial_settlement.v1','leo.financial_bill.v1')
  or p.capability_version<>1 then raise exception 'receiving_claim_required' using errcode='42501';end if;
 select * into a from public.supervisor_effect_attempts where business_id=p_business_id
  and proposal_id=p.id and effect_hash=p.effect_hash and authorization_kind='click' for update;
 if a.state='verified' and p.status='committed' then return p;end if;
 if a.id is null or p.status<>'executing' or a.state not in ('executing','uncertain')
 then raise exception 'receiving_claim_required' using errcode='42501';end if;
 -- A live attempt is never taken over. Only the existing proof can settle.
 if a.state='executing' and a.created_at>now()-interval '5 minutes' then return p;end if;
 if p.capability_id='leo.financial_bill.v1' then
  proof:=public.supervisor_financial_bill_proof(p_business_id,p.id,p.effect_hash);
 elsif p.capability_id='leo.financial_settlement.v1' then
  proof:=public.supervisor_financial_settlement_proof(p_business_id,p.id,p.effect_hash);
 elsif p.capability_id='maya.supplier_invoice.v1' then
  proof:=public.supervisor_supplier_invoice_effect_proof(p_business_id,p.id,p.effect_hash);
 else
  proof:=public.supervisor_supplier_receiving_effect_proof(p_business_id,p.id,p.effect_hash);
 end if;
 if proof is null then
  update public.supervisor_effect_attempts set state='uncertain' where id=a.id and state='executing';
  return p;
 end if;
 update public.supervisor_effect_attempts set state='verified',receipt_ref=(case when p.capability_id='leo.financial_bill.v1' then 'uploads:' when p.capability_id='leo.financial_settlement.v1' then 'purchase_reconciliation_events:' when p.capability_id='maya.supplier_invoice.v1' then 'supplier_invoices:' else 'purchase_receipts:' end)||proof::text,
  verified_at=now() where id=a.id;
 update public.supervisor_proposals set status='committed',revision=revision+1,committed_at=now(),
  monitoring_start_date=a.business_date+1,updated_at=now() where id=p.id returning * into p;
 return p;
end $$;
revoke all on function public.supervisor_reconcile_supplier_receiving(uuid,uuid,uuid,uuid,integer)
 from public,anon,authenticated;
grant execute on function public.supervisor_reconcile_supplier_receiving(uuid,uuid,uuid,uuid,integer) to service_role;
