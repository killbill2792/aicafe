-- Preserve the existing owner's statement privacy and exact transaction facts
-- while moving the retained rows to the common source archive. File descriptions,
-- bank credentials and bytes have never been authorized for this SQL source.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.external_resources
  -- Reason: The new owner key is NULL on all prior rows. The bounded migration enforces the original upload retention rule by cascading owner deletion.
  -- squawk-ignore adding-foreign-key-constraint
  add column reader_owner_user_id uuid references auth.users(id) on delete cascade;
alter table public.external_records
  -- Reason: The new owner key is NULL on all prior rows. The bounded migration enforces the original upload retention rule by cascading owner deletion.
  -- squawk-ignore adding-foreign-key-constraint
  add column reader_owner_user_id uuid references auth.users(id) on delete cascade;
alter table public.external_record_changes
  -- Reason: The new owner key is NULL on all prior rows. The bounded migration enforces the original upload retention rule by cascading owner deletion.
  -- squawk-ignore adding-foreign-key-constraint
  add column reader_owner_user_id uuid references auth.users(id) on delete cascade;

alter policy owner_read on public.external_resources using (public.scheduling_is_owner(business_id)
  and (reader_owner_user_id is null or reader_owner_user_id=(select auth.uid())));
alter policy owner_read on public.external_records using (source_account is not null and public.scheduling_is_owner(business_id)
  and (reader_owner_user_id is null or reader_owner_user_id=(select auth.uid())));
alter policy owner_read on public.external_record_changes using (source_account is not null and public.scheduling_is_owner(business_id)
  and (reader_owner_user_id is null or reader_owner_user_id=(select auth.uid())));
alter policy owner_read on public.external_identifiers using (exists(select from public.external_records r
  where (r.business_id,r.provider,r.id)=(external_identifiers.business_id,external_identifiers.provider,external_identifiers.record_id)));
alter policy owner_read on public.external_record_links using (exists(select from public.external_records r
  where (r.business_id,r.provider,r.id)=(external_record_links.business_id,external_record_links.provider,external_record_links.record_id))
  and (target_id is null or exists(select from public.external_records t
  where (t.business_id,t.provider,t.id)=(external_record_links.business_id,external_record_links.target_provider,external_record_links.target_id))));

-- Connectors that are authorized to retain owner-private evidence must bind
-- their source before the first page. Existing source visibility is immutable.
create function public.external_register_owner_resource(
  p_business uuid,p_provider text,p_account text,p_resource text,p_owner uuid
) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if p_owner is null then raise exception 'Missing external source owner' using errcode='22023'; end if;
  insert into public.external_resources(business_id,provider,source_account,resource,reader_owner_user_id)
    values(p_business,p_provider,p_account,p_resource,p_owner) on conflict do nothing;
  perform 1 from public.external_resources e
    where (e.business_id,e.provider,e.source_account,e.resource,e.reader_owner_user_id)=
      (p_business,p_provider,p_account,p_resource,p_owner) for update;
  if not found then raise exception 'External source visibility mismatch' using errcode='42501'; end if;
end $$;
revoke all on function public.external_register_owner_resource(uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.external_register_owner_resource(uuid,text,text,text,uuid) to service_role;

create or replace function public.external_commit_page(
  p_business_id uuid,p_provider text,p_account text,p_resource text,p_stream text,
  p_revision bigint,p_next jsonb,p_complete boolean,p_records jsonb
) returns bigint language plpgsql security invoker set search_path=pg_catalog,public as $$
declare state public.external_sync_checkpoints%rowtype; item jsonb; previous public.external_records%rowtype;
  identity_key text; object_key text; body jsonb; hash text; modified timestamptz; delta jsonb; receipt uuid; archive_reader uuid;
begin
  if nullif(p_provider,'') is null or nullif(p_account,'') is null or nullif(p_resource,'') is null
     or nullif(p_stream,'') is null or p_complete is null or p_revision is null
     or jsonb_typeof(p_records) is distinct from 'array' then raise exception 'Invalid external page'; end if;
  insert into public.external_resources(business_id,provider,source_account,resource)
    values(p_business_id,p_provider,p_account,p_resource) on conflict do nothing;
  select e.reader_owner_user_id into strict archive_reader from public.external_resources e
    where (e.business_id,e.provider,e.source_account,e.resource)=(p_business_id,p_provider,p_account,p_resource)
    for update;
  insert into public.external_sync_checkpoints(business_id,provider,source_account,resource,stream)
    values(p_business_id,p_provider,p_account,p_resource,p_stream) on conflict do nothing;
  select * into strict state from public.external_sync_checkpoints
    where business_id=p_business_id and provider=p_provider and source_account=p_account
      and resource=p_resource and stream=p_stream for update;
  if state.revision <> p_revision then raise exception 'Stale external page checkpoint' using errcode='40001'; end if;
  -- Null cursor on a non-final call explicitly discards an expired traversal.
  if p_next is null and not p_complete and jsonb_array_length(p_records)<>0 then
    raise exception 'Non-final external page needs a continuation';
  end if;
  receipt := coalesce(state.active_observation_id,gen_random_uuid());
  for item in select value from jsonb_array_elements(p_records) with ordinality order by value->>'key', ordinality loop
    object_key := item->>'key'; body := item->'payload'; modified := (item->>'updated_at')::timestamptz;
    if jsonb_typeof(item->'key') is distinct from 'string' or object_key='' or body is null then
      raise exception 'Missing external record identity or payload';
    end if;
    identity_key := coalesce(item->>'archive_key','external:'||encode(sha256(convert_to(jsonb_build_array(p_account,p_resource,object_key)::text,'UTF8')),'hex'));
    perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_business_id,p_provider,identity_key)::text,0));
    select * into previous from public.external_records
      where business_id=p_business_id and provider=p_provider and capture_key=identity_key for update;
    hash := encode(sha256(convert_to(body::text,'UTF8')),'hex');
    if found and (previous.entity<>p_resource or previous.reader_owner_user_id is distinct from archive_reader or
        coalesce(previous.source_account,previous.restaurant_guid::text) is distinct from p_account) then
      raise exception 'Existing external identity belongs to another resource';
    end if;
    if previous.id is null then
      insert into public.external_records(business_id,provider,source_account,entity,source_key,
        source_updated_at,payload,payload_sha256,capture_key,source_context,restaurant_guid,entity_guid,business_date,commit_id,reader_owner_user_id)
      values(p_business_id,p_provider,p_account,p_resource,object_key,modified,body,hash,identity_key,
        item->'context',(item->>'restaurant_guid')::uuid,(item->>'entity_guid')::uuid,(item->>'business_date')::date,receipt,archive_reader) returning id into previous.id;
    elsif previous.source_updated_at is null or modified >= previous.source_updated_at or
      (modified is null and previous.payload=body) then
      if previous.payload is distinct from body then
        select jsonb_agg(d order by d->'path') into delta from public.external_json_delta(previous.payload,body) d;
        insert into public.external_record_changes(business_id,provider,source_account,entity,source_key,record_id,changes,
          restaurant_guid,entity_guid,business_date,reader_owner_user_id)
          values(p_business_id,p_provider,previous.source_account,p_resource,object_key,previous.id,delta,
          previous.restaurant_guid,previous.entity_guid,previous.business_date,archive_reader);
      end if;
      update public.external_records set payload=body,payload_sha256=hash,last_seen=clock_timestamp(),
        source_account=p_account,source_key=object_key,source_context=item->'context',commit_id=receipt,
        business_date=coalesce((item->>'business_date')::date,business_date),
        source_updated_at=coalesce(modified,source_updated_at)
        where business_id=p_business_id and provider=p_provider and id=previous.id;
    else
      -- The provider returned this identity, even if a newer payload is known.
      insert into public.external_observation_members values(p_business_id,p_provider,receipt,previous.id)
        on conflict do nothing;
      continue;
    end if;
    if item ? 'identifiers' then
      perform public.external_observe_identifiers(p_business_id,p_provider,previous.id,item->'identifiers');
    end if;
    insert into public.external_observation_members values(p_business_id,p_provider,receipt,previous.id)
      on conflict do nothing;
  end loop;
  if p_complete or p_next is null then
    delete from public.external_observation_members
     where (business_id,provider,observation_id)=(p_business_id,p_provider,
       case when p_complete then state.last_complete_observation_id else state.active_observation_id end);
  end if;
  update public.external_sync_checkpoints set revision=revision+1,cursor_state=p_next,
    active_observation_id=case when not p_complete and p_next is not null then receipt end,
    last_complete_observation_id=case when p_complete then receipt else last_complete_observation_id end
    where business_id=p_business_id and provider=p_provider and source_account=p_account
      and resource=p_resource and stream=p_stream;
  update public.external_resources set status=case when p_complete then 'current' else 'syncing' end,
    last_attempt_at=clock_timestamp(),
    last_complete_at=case when p_complete then clock_timestamp() else last_complete_at end,
    last_complete_commit=case when p_complete then receipt else last_complete_commit end,
    last_complete_scope=case when p_complete then jsonb_build_object('stream',p_stream) ||
      coalesce(p_next->'scope','{}'::jsonb) else last_complete_scope end
    where business_id=p_business_id and provider=p_provider and source_account=p_account and resource=p_resource;
  return state.revision+1;
end $$;

-- Connector-specific identity and admitted shape, shared page writer.
create function public.archive_statement_evidence(p_upload public.uploads,p_transactions jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_record uuid;
begin
  perform public.external_register_owner_resource(p_upload.business_id,'owner_upload',
    p_upload.financial_owner_user_id::text,'financial_statement',p_upload.financial_owner_user_id);
  perform public.external_commit_page(p_upload.business_id,'owner_upload',p_upload.financial_owner_user_id::text,
    'financial_statement',p_upload.id::text,0,
    jsonb_build_object('scope',jsonb_build_object('as_of',p_upload.financial_to)),true,
    jsonb_build_array(jsonb_build_object('key',p_upload.id::text,'payload',p_transactions,
      'updated_at',p_upload.created_at,'business_date',p_upload.financial_to)));
  select id into strict v_record from public.external_records where business_id=p_upload.business_id
    and provider='owner_upload' and source_account=p_upload.financial_owner_user_id::text
    and entity='financial_statement' and source_key=p_upload.id::text;
  insert into public.external_record_links(business_id,provider,record_id,relation,evidence,native_relation,native_key)
    values(p_upload.business_id,'owner_upload',v_record,'source_document',jsonb_build_object('sha256',p_upload.financial_source_sha256),
      'public.uploads',jsonb_build_object('id',p_upload.id)) on conflict do nothing;
end $$;
revoke all on function public.archive_statement_evidence(public.uploads,jsonb) from public,anon,authenticated;
grant execute on function public.archive_statement_evidence(public.uploads,jsonb) to service_role;

-- Preserve existing upload IDs and exact row JSON, including its order. The
-- existing upload row continues to own the source hash and the approval trail.
lock table public.uploads in share row exclusive mode;
do $$
declare evidence public.uploads;
begin
  for evidence in select * from public.uploads where financial_transactions is not null loop
    perform public.archive_statement_evidence(evidence,evidence.financial_transactions);
  end loop;
  if exists(select from public.uploads u where u.financial_transactions is not null and not exists(
    select from public.external_records r where (r.business_id,r.provider,r.source_account,r.entity,r.source_key)=
      (u.business_id,'owner_upload',u.financial_owner_user_id::text,'financial_statement',u.id::text)
      and r.reader_owner_user_id=u.financial_owner_user_id and r.payload=u.financial_transactions)) then
    raise exception 'Statement archive parity failed';
  end if;
end $$;

create or replace function public.supervisor_record_statement_evidence(
 p_business_id uuid,p_owner_user_id uuid,p_source_sha256 text,p_account_key text,
 p_currency text,p_from date,p_to date,p_opening_cents bigint,p_closing_cents bigint,p_transactions jsonb
) returns uuid language plpgsql security invoker set search_path=public as $$
declare v_existing public.uploads; v_day date; v_currency text;
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
  financial_closing_cents)
 values(p_business_id,'statement','done',p_owner_user_id,p_source_sha256,p_account_key,p_currency,
  p_from,p_to,p_opening_cents,p_closing_cents)
 on conflict(business_id,financial_owner_user_id,financial_source_sha256) where kind='statement' do nothing returning * into v_existing;
 if v_existing.id is not null then
  perform public.archive_statement_evidence(v_existing,p_transactions);
  return v_existing.id;
 end if;
 select * into v_existing from public.uploads where business_id=p_business_id
  and financial_owner_user_id=p_owner_user_id and financial_source_sha256=p_source_sha256 and kind='statement';
 if not found or v_existing.financial_account_key is distinct from p_account_key
  or v_existing.financial_currency is distinct from p_currency
  or v_existing.financial_from is distinct from p_from or v_existing.financial_to is distinct from p_to
  or v_existing.financial_opening_cents is distinct from p_opening_cents
  or v_existing.financial_closing_cents is distinct from p_closing_cents
  or not exists(select from public.external_records r where
   (r.business_id,r.provider,r.source_account,r.entity,r.source_key)=(p_business_id,'owner_upload',
    p_owner_user_id::text,'financial_statement',v_existing.id::text) and r.payload=p_transactions)
 then raise exception 'financial_statement_source_conflict' using errcode='22023';end if;
 return v_existing.id;
end $$;

create or replace function public.supervisor_commit_financial_settlement(
 p_business_id uuid,p_thread_id uuid,p_proposal_id uuid,p_effect_hash text
) returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_owner uuid:=auth.uid();p public.supervisor_proposals;a public.supervisor_effect_attempts;
 inv public.supplier_invoices;u public.uploads;original public.purchase_reconciliation_events;
 original_upload public.uploads;existing public.purchase_reconciliation_events;
 e jsonb;tx jsonb;v_transactions jsonb;v_count bigint;v_index bigint;v_amount bigint;v_balance bigint;
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
 select r.payload into v_transactions from public.external_records r where
   (r.business_id,r.provider,r.source_account,r.entity,r.source_key,r.reader_owner_user_id)=
    (p_business_id,'owner_upload',v_owner::text,'financial_statement',u.id::text,v_owner);
 if v_transactions is null then raise exception 'financial_settlement_source_changed' using errcode='P0001';end if;
 select count(*) into v_count from jsonb_array_elements(v_transactions) x where (x->>'i')::bigint=v_index;
 if v_count<>1 then raise exception 'financial_settlement_row_ambiguous' using errcode='22023';end if;
 select x into tx from jsonb_array_elements(v_transactions) x where (x->>'i')::bigint=v_index;
 v_date:=(tx->>'date')::date;v_amount:=(tx->>'amountCents')::bigint;v_balance:=(tx->>'balanceCents')::bigint;
 if v_date::text is distinct from e->>'transactionDate' or v_amount is distinct from (e->>'transactionAmountCents')::bigint
  or v_balance is distinct from (e->>'transactionBalanceCents')::bigint or v_alloc>abs(v_amount::numeric)
  or (v_kind='settlement_evidence_linked' and v_amount>=0) or (v_kind='settlement_evidence_reversed' and v_amount<=0)
 then raise exception 'financial_settlement_transaction_changed' using errcode='22023';end if;
 -- Same date, signed movement and ending balance is a conservative stable
 -- transaction identity across overlapping exports and alternate nicknames.
 -- Ambiguous repeated tuples inside a source cannot be allocated.
 select count(*) into v_count from jsonb_array_elements(v_transactions) x where
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

create or replace function public.supervisor_financial_settlement_proof(p_business_id uuid,p_proposal_id uuid,p_effect_hash text)
 returns uuid language sql stable security invoker set search_path=public as $$
 select f.id from public.purchase_reconciliation_events f
 join public.supervisor_proposals p on p.business_id=f.business_id and p.id=p_proposal_id and p.owner_user_id=f.owner_user_id
 join public.supplier_invoices i on i.business_id=f.business_id and i.id=f.financial_invoice_id
 join public.uploads u on u.business_id=f.business_id and u.id=f.financial_upload_id and u.financial_owner_user_id=f.owner_user_id
 join public.external_records r on (r.business_id,r.provider,r.source_account,r.entity,r.source_key,r.reader_owner_user_id)=
   (u.business_id,'owner_upload',u.financial_owner_user_id::text,'financial_statement',u.id::text,u.financial_owner_user_id)
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
 and exists(select 1 from jsonb_array_elements(r.payload) tx where
   (tx->>'i')::bigint=f.financial_row_index and tx->>'date'=f.financial_tx_date::text
   and (tx->>'amountCents')::bigint=f.financial_tx_amount_cents and (tx->>'balanceCents')::bigint=f.financial_tx_balance_cents)
 limit 1
$$;

-- The only transaction payload lives in the common archive after parity.
-- Reason: The transaction replaces this constraint after verifying the archive owns the exact statement rows. All remaining upload metadata checks are retained.
-- squawk-ignore ban-drop-constraint
alter table public.uploads drop constraint uploads_financial_evidence_shape;

alter table public.uploads add constraint uploads_financial_evidence_shape check (
 ((kind<>'bill_claim' and num_nonnulls(financial_owner_user_id,financial_source_sha256,financial_account_key,
  financial_currency,financial_from,financial_to,financial_opening_cents,financial_closing_cents,
  financial_bill_payee,financial_bill_payee_key,financial_bill_reference,financial_bill_revision,
  financial_bill_issued_on,financial_bill_due_on,financial_bill_amount_cents,financial_bill_source_kind,
  financial_bill_source_ref,financial_bill_proposal_id)=0)
 or (num_nonnulls(financial_owner_user_id,financial_source_sha256,financial_account_key,
  financial_currency,financial_from,financial_to,financial_opening_cents,financial_closing_cents)=8 and kind='statement' and status='done'
  and num_nonnulls(financial_bill_payee,financial_bill_payee_key,financial_bill_reference,financial_bill_revision,
  financial_bill_issued_on,financial_bill_due_on,financial_bill_amount_cents,financial_bill_source_kind,
  financial_bill_source_ref,financial_bill_proposal_id)=0
  and financial_source_sha256 ~ '^[0-9a-f]{64}$' and financial_account_key ~ '^[0-9a-f]{64}$'
  and financial_currency ~ '^[A-Z]{3}$' and financial_from<=financial_to
  and financial_opening_cents between -9007199254740991 and 9007199254740991
  and financial_closing_cents between -9007199254740991 and 9007199254740991)
 or (kind='bill_claim' and status='done'
  and num_nonnulls(financial_owner_user_id,financial_source_sha256,financial_currency,
   financial_bill_payee,financial_bill_payee_key,financial_bill_reference,financial_bill_revision,
   financial_bill_issued_on,financial_bill_amount_cents,financial_bill_source_kind,financial_bill_source_ref,
   financial_bill_proposal_id)=12
  and num_nonnulls(financial_account_key,financial_from,financial_to,financial_opening_cents,
   financial_closing_cents)=0
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

-- Reason: The same transaction verifies source-row equality and switches the capture, settlement and readback paths to the owner-scoped archive.
-- squawk-ignore ban-drop-column
alter table public.uploads drop column financial_transactions;
