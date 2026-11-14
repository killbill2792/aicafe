-- Task 12: a single authenticated owner chat instruction may authorize only
-- the corresponding inventory purchase effect. Other capabilities still require
-- click approval or a narrowly registered mandate. No provider/browser writes.
set lock_timeout='3s';
set statement_timeout='30s';

alter table public.supervisor_effect_attempts add column if not exists owner_message_id uuid;
alter table public.supervisor_approvals add column if not exists owner_message_id uuid;

-- Replace the original type and shape constraints without assuming their
-- PostgreSQL-generated names; leave every other check in place.
do $$
declare item record;
begin
 for item in
  select c.conname, t.relname from pg_constraint c
   join pg_class t on t.oid=c.conrelid
   join pg_namespace n on n.oid=t.relnamespace
   where n.nspname='public' and t.relname in
    ('supervisor_effect_attempts','supervisor_approvals') and c.contype='c'
     and position('authorization_kind' in pg_get_constraintdef(c.oid))>0
 loop
  execute format('alter table public.%I drop constraint %I',item.relname,item.conname);
 end loop;
end $$;

alter table public.supervisor_approvals add constraint supervisor_approvals_authorization_v2
 check (
  (authorization_kind='click' and owner_message_id is null and mandate_id is null and mandate_revision is null)
  or (authorization_kind='mandate' and owner_message_id is null and mandate_id is not null and mandate_revision is not null)
  or (authorization_kind='owner_message' and owner_message_id is not null and mandate_id is null and mandate_revision is null)
 ) not valid;
alter table public.supervisor_effect_attempts add constraint supervisor_effect_attempts_authorization_v2
 check (
  (authorization_kind='click' and owner_message_id is null and mandate_id is null and mandate_revision is null)
  or (authorization_kind='mandate' and owner_message_id is null and mandate_id is not null and mandate_revision is not null)
  or (authorization_kind='owner_message' and owner_message_id is not null and mandate_id is null and mandate_revision is null)
 ) not valid;
alter table public.supervisor_effect_attempts add constraint supervisor_attempt_owner_message_fk
 foreign key(owner_message_id) references public.ai_messages(id) not valid;
alter table public.supervisor_approvals add constraint supervisor_approval_owner_message_fk
 foreign key(owner_message_id) references public.ai_messages(id) not valid;

create function public.supervisor_claim_owner_purchase_effect(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,
 p_revision integer,p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare p public.supervisor_proposals; m public.ai_messages;
 local_day date; typed_day date; attempt_id uuid;
 claimed_cost bigint; dollars bigint; cents integer; price_pattern text;
 currency_code text; currency_glyph text; currency_pattern text;
 typed_source_quantities integer;
begin
 if auth.role() is distinct from 'service_role'
 then raise exception 'service_role_only' using errcode='42501'; end if;
 if not exists (select 1 from public.memberships x where x.business_id=p_business_id
  and x.user_id=p_owner_user_id and x.role='owner')
 then raise exception 'purchase_owner_required' using errcode='42501'; end if;
 select * into m from public.ai_messages
  where id=p_owner_message_id and business_id=p_business_id
  and owner_user_id=p_owner_user_id and author_user_id=p_owner_user_id
  and thread_id=p_thread_id and role='owner';
 if m.id is null or m.text_content is null
   or m.text_content !~* '(record|add|update|log|increase|save|post|put|enter|bought|purchased)'
   or m.text_content ~* '(what if|hypothetical|review only|do not|don.t|never|not yet|cancel)'
 then raise exception 'explicit_owner_purchase_instruction_required' using errcode='42501'; end if;
 select * into p from public.supervisor_proposals
  where id=p_proposal_id and business_id=p_business_id
   and owner_user_id=p_owner_user_id and thread_id=p_thread_id for update;
 if p.id is null or p.revision<>p_revision or p.status<>'draft'
  or p.capability_id<>'maya.inventory_purchase.v1' or p.capability_version<>1
  or p.canonical_effect_payload->>'ingredientId' is null
  or p.canonical_effect_payload->>'source' not in ('chat_text','receipt_chat')
  or p.created_at < m.created_at or p.created_at > m.created_at + interval '30 minutes'
 then raise exception 'purchase_effect_not_eligible' using errcode='42501'; end if;
 -- Serialize distinct proposal keys for one exact owner message, then reject an
 -- already-claimed identical source ingredient/quantity/unit/date. One LLM
 -- message retry must never turn into a second physical stock purchase.
 perform pg_advisory_xact_lock(hashtextextended(
  'owner-purchase-message:'||p_business_id::text||':'||p_owner_message_id::text,64));
 if exists (
  select 1 from public.supervisor_effect_attempts prev
  join public.supervisor_proposals existing
   on existing.business_id=prev.business_id and existing.id=prev.proposal_id
  where prev.business_id=p_business_id and prev.owner_message_id=p_owner_message_id
   and existing.capability_id='maya.inventory_purchase.v1'
   and existing.canonical_effect_payload->>'ingredientId'=p.canonical_effect_payload->>'ingredientId'
   and existing.canonical_effect_payload->>'quantity'=p.canonical_effect_payload->>'quantity'
   and existing.canonical_effect_payload->>'unit'=p.canonical_effect_payload->>'unit'
   and existing.canonical_effect_payload->>'date'=p.canonical_effect_payload->>'date'
   -- For typed purchases, dedupe the same quantified ingredient in one
   -- owner message. For photo-backed stock (source=chat_text) as well as
   -- reviewed receipts, distinguish physical receipt line ordinals.
   -- Two real receipt lines can have identical ingredient and quantities.
   and (
    (p.canonical_effect_payload->>'receiptGroupId' is null
     and existing.canonical_effect_payload->>'receiptGroupId' is null)
    or (p.canonical_effect_payload->>'receiptGroupId' is not null
     and existing.canonical_effect_payload->>'receiptGroupId'
       =p.canonical_effect_payload->>'receiptGroupId'
     and existing.canonical_effect_payload->>'receiptLineIndex'
       =p.canonical_effect_payload->>'receiptLineIndex')
   )
 ) then raise exception 'purchase_already_claimed_for_message' using errcode='42501'; end if;
 select (now() at time zone b.timezone)::date into local_day from public.businesses b
  where b.id=p_business_id and b.timezone is not null
   and exists(select 1 from pg_timezone_names z where z.name=b.timezone);
 if local_day is null then raise exception 'cafe_timezone_unavailable'; end if;
 -- For a typed owner utterance, the source of the date and cost must be the
 -- saved owner's words, never a model-filled JSON value. Photo-based lines
 -- have a non-null receipt group and use separate document-backed validation.
 if p.canonical_effect_payload->>'source'='chat_text'
    and p.canonical_effect_payload->>'receiptGroupId' is null then
  select (m.created_at at time zone b.timezone)::date into typed_day
    from public.businesses b where b.id=p_business_id;
  if p.canonical_effect_payload->>'date' is null
    or not (
      p.canonical_effect_payload->>'date'=typed_day::text
      or (m.text_content ~* 'yesterday'
          and p.canonical_effect_payload->>'date'=(typed_day-1)::text)
      or position(p.canonical_effect_payload->>'date' in m.text_content)>0
    )
  then raise exception 'typed_purchase_date_not_grounded' using errcode='42501'; end if;
  -- Business currency comes from the saved café setting, never the model.
  select b.currency into currency_code from public.businesses b
    where b.id=p_business_id;
  if currency_code is null or currency_code !~ '^[A-Z]{3}$' then
    raise exception 'cafe_currency_unavailable' using errcode='42501';
  end if;
  -- ISO glyph notation is selected by the configured currency; other ISO
  -- currencies remain supported by explicit alphabetic currency-code notation.
  currency_glyph:=case currency_code
    when 'USD' then '$' when 'GBP' then '£' when 'EUR' then '€'
    when 'CAD' then 'CA$' when 'AUD' then 'A$' when 'NZD' then 'NZ$'
    when 'JPY' then '¥' when 'INR' then '₹' when 'KRW' then '₩'
    when 'CNY' then 'CN¥' when 'BRL' then 'R$' else null end;
  currency_pattern:='('||currency_code
    ||case when currency_glyph is null then ''
      else '|'||replace(currency_glyph,'$', '\$') end||')';
  if p.canonical_effect_payload->>'costCents' is null and
     m.text_content ~* ('(^|[^[:alnum:]])'||currency_pattern||'[[:space:]]*[0-9]')
  then raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
  if p.canonical_effect_payload->>'costCents' is not null then
    -- Human source, NOT an LLM tool-call batch, determines whether the amount
    -- can belong to exactly one line. Split tool calls cannot double-count a
    -- shared receipt total. Unknown attribution must stay in owner review.
    select count(*) into typed_source_quantities from regexp_matches(
      m.text_content,
      '(^|[^[:alnum:]])[0-9]+(\.[0-9]+)?[[:space:]]*(gal(lon)?s?|lbs?|pounds?|oz|ounces?|kg|kilograms?|g|grams?|l|liters?|litres?|ml|milliliters?|ea|each|units?|pcs|pieces?|cases?)([^[:alnum:]]|$)',
      'gi');
    if typed_source_quantities<>1 or
       m.text_content ~* '(^|[[:space:]])(and|plus|also)[[:space:]]+[0-9]+'
    then raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(^|[^[:alnum:]])'||currency_pattern||'[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.,]|$)';
    if m.text_content !~* price_pattern then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
  end if;
 end if;

 insert into public.supervisor_approvals(
  business_id,proposal_id,owner_user_id,approved_revision,effect_hash,
  authorization_kind,owner_message_id
 ) values (
  p_business_id,p.id,p_owner_user_id,p.revision,p.effect_hash,
  'owner_message',p_owner_message_id
 );
 update public.supervisor_proposals set status='approved',approved_at=now(),
  approved_by=p_owner_user_id,revision=revision+1,updated_at=now()
  where id=p.id returning * into p;

 attempt_id:=gen_random_uuid();
 insert into public.supervisor_effect_attempts(
  attempt_key,business_id,proposal_id,effect_hash,authorization_kind,
  owner_message_id,business_date,state
 ) values (
  attempt_id,p_business_id,p.id,p.effect_hash,'owner_message',
  p_owner_message_id,local_day,'reserved'
 );
 update public.supervisor_proposals set status='executing',
  revision=revision+1,updated_at=now() where id=p.id returning * into p;
 update public.supervisor_effect_attempts set state='executing'
  where attempt_key=attempt_id and state='reserved';
 return jsonb_build_object('proposal',to_jsonb(p),'attempt_key',attempt_id,
  'business_date',local_day,'authorization_kind','owner_message');
end $$;
revoke all on function public.supervisor_claim_owner_purchase_effect(uuid,uuid,uuid,uuid,integer,uuid)
 from public,anon,authenticated;
grant execute on function public.supervisor_claim_owner_purchase_effect(uuid,uuid,uuid,uuid,integer,uuid)
 to service_role;


-- Source-backed Task12 purchase identity. Uses the same original SHA-256
-- bytes and RFC4122 variant/version layout as receiptStockLineId in TypeScript.
-- pg_catalog.sha256 is built into PostgreSQL 16: no extension/schema dependency.
create or replace function public.supervisor_receipt_stock_line_id(p_group uuid,p_index integer)
returns uuid language plpgsql immutable strict set search_path=public as $$
declare h text; digit integer;
begin
 if p_index<0 or p_index>=100 then
   raise exception 'invalid_receipt_line_index' using errcode='22023';
 end if;
 h:=substr(encode(pg_catalog.sha256(convert_to(
   'aicafe-receipt-evidence-v1:'||p_group::text||':line:'||p_index::text,
   'UTF8')),'hex'),1,32);
 digit:=strpos('0123456789abcdef',substr(h,17,1))-1;
 h:=substr(h,1,12)||'5'||substr(h,14,3)||
   substr('89ab',(digit & 3)+1,1)||substr(h,18);
 return (substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||
   substr(h,17,4)||'-'||substr(h,21,12))::uuid;
end $$;
revoke all on function public.supervisor_receipt_stock_line_id(uuid,integer)
 from public,anon,authenticated;
grant execute on function public.supervisor_receipt_stock_line_id(uuid,integer)
 to service_role;

-- Recreate only the existing reconciliation function in the unmerged Task12
-- migration. Keep every other capability and original Task10 migration intact.

create or replace function public.supervisor_reconcile_effect_attempt(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid,
  p_proposal_id uuid, p_revision integer
) returns public.supervisor_proposals
language plpgsql security definer set search_path = public as $$
declare
  p public.supervisor_proposals;
  a public.supervisor_effect_attempts;
  stock public.pantry_stock_purchases;
  price_record public.menu_price_history;
  next_status text := null;
  next_start date := null;
  proof_ref text := null;
begin
  if auth.role() is distinct from 'service_role'
  then raise exception 'service_role_only' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships m
    where m.business_id = p_business_id and m.user_id = p_owner_user_id and m.role = 'owner')
  then raise exception 'proposal_owner_required' using errcode = '42501'; end if;
  select * into p from public.supervisor_proposals
    where business_id = p_business_id and owner_user_id = p_owner_user_id
      and thread_id = p_thread_id and id = p_proposal_id for update;
  if p.id is null or p.revision <> p_revision
  then raise exception 'proposal_revision_conflict' using errcode = 'P0001'; end if;
  select * into a from public.supervisor_effect_attempts
    where business_id = p_business_id and proposal_id = p_proposal_id
      and effect_hash = p.effect_hash for update;
  if a.id is null
  then raise exception 'effect_attempt_missing' using errcode = 'P0001'; end if;
  if a.state = 'verified' and p.status in ('committed','manual_pending')
  then return p; end if; -- idempotent read: no second commit
  if p.status <> 'executing' or a.state not in ('executing','uncertain')
  then raise exception 'effect_attempt_conflict' using errcode = 'P0001'; end if;
  -- Never take over a live claim. A stale claim with no evidence becomes uncertain.
  if a.state = 'executing' and a.created_at > now() - interval '5 minutes'
  then return p; end if;

  -- These three capabilities have no external write. The proposal transition
  -- itself is the only effect; do not call the capability commit function again.
  if p.capability_version = 1 and p.capability_id = 'leo.goal.v1' then
    next_status := 'committed';
    next_start := a.business_date + 1;
    proof_ref := 'inert-goal:' || p.id::text;
  elsif p.capability_version = 1 and p.capability_id = 'alex.drink_price_experiment.v1' then
    next_status := 'manual_pending';
    proof_ref := 'inert-price-experiment:' || p.id::text;
  elsif p.capability_version = 1 and p.capability_id = 'alex.event_readiness.v1'
      and p.canonical_effect_payload->>'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    next_status := 'committed';
    next_start := (p.canonical_effect_payload->>'startDate')::date;
    proof_ref := 'inert-event-readiness:' || p.id::text;
  elsif p.capability_version = 1 and p.capability_id = 'maya.inventory_purchase.v1' then
    -- Typed lines and earlier approval cards have proposal ID as line ID.
    -- Photo-backed chat_text uses deterministic original receipt group/ordinal.
    -- Verify the exact source line identity AND immutable purchase facts after
    -- a lost response; never invoke recordPurchases again during recovery.
    select * into stock from public.pantry_stock_purchases s
      where s.business_id = p.business_id
        and (
          (p.canonical_effect_payload->>'source'='chat_text'
           and p.canonical_effect_payload->>'receiptGroupId' is not null
           and (p.canonical_effect_payload->>'receiptLineIndex') ~ '^(0|[1-9][0-9]?)$'
           and s.line_id = public.supervisor_receipt_stock_line_id(
             (p.canonical_effect_payload->>'receiptGroupId')::uuid,
             (p.canonical_effect_payload->>'receiptLineIndex')::integer)
           and s.source_ref = (p.canonical_effect_payload->>'receiptGroupId')||':'||
             (p.canonical_effect_payload->>'receiptLineIndex'))
          or
          ((p.canonical_effect_payload->>'source'<>'chat_text'
            or p.canonical_effect_payload->>'receiptGroupId' is null)
           and s.line_id = p.id)
        )
        and s.voided_at is null
        and s.ingredient_id::text = p.canonical_effect_payload->>'ingredientId'
        and s.purchase_date::text = p.canonical_effect_payload->>'date'
        and s.entered_quantity = (p.canonical_effect_payload->>'quantity')::numeric
        and s.entered_unit = p.canonical_effect_payload->>'unit'
        and s.cost_cents is not distinct from
          (p.canonical_effect_payload->>'costCents')::bigint
        and s.source = p.canonical_effect_payload->>'source';
    if stock.id is not null then
      next_status := 'committed';
      next_start := a.business_date + 1;
      proof_ref := 'pantry_stock_purchases:' || stock.id::text;
    end if;
  elsif p.capability_version = 1 and p.capability_id = 'alex.menu_price_change.v1' then
    -- This exact proposal-scoped history marker is written by the existing
    -- canonical price CAS writer, in its same transaction. A matching current
    -- price without this durable receipt is deliberately not sufficient.
    select * into price_record from public.menu_price_history h
      where h.business_id = p.business_id
        and h.menu_item_id::text = p.canonical_effect_payload->>'productId'
        and h.old_price_cents = (p.canonical_effect_payload->>'oldPriceCents')::bigint
        and h.new_price_cents = (p.canonical_effect_payload->>'newPriceCents')::bigint
        and h.source_type = 'owner_manual'
        and h.source_provider = 'Alex (owner approved; proposal ' || p.id::text || ')'
        and h.changed_at >= a.created_at
        and exists (select 1 from public.menu_items m
          where m.business_id = p.business_id and m.id = h.menu_item_id
            and m.price_cents = h.new_price_cents)
      order by h.changed_at desc limit 1;
    if price_record.id is not null then
      next_status := 'committed';
      next_start := a.business_date + 1;
      proof_ref := 'menu_price_history:' || price_record.id::text;
    elsif a.receipt_ref = 'inert-toast-claim:' || a.attempt_key::text then
      -- Keep Task 8a's source-sealed Toast price handoff after recreating
      -- the shared reconciler for receipt-derived inventory identities.
      -- This confirms only the inert handoff; never replay a price write.
      next_status := 'manual_pending';
      proof_ref := 'inert-toast-price-handoff:' || a.attempt_key::text;
    end if;
  end if;

  if next_status is null then
    -- No authoritative receipt: keep the proposal blocked and never resend.
    update public.supervisor_effect_attempts set state = 'uncertain'
      where id = a.id and state = 'executing';
    return p;
  end if;
  update public.supervisor_effect_attempts
    set state = 'verified', receipt_ref = proof_ref, verified_at = now()
    where id = a.id and state in ('executing','uncertain');
  update public.supervisor_proposals set status = next_status,
    revision = revision + 1,
    committed_at = case when next_status = 'committed' then now() else null end,
    monitoring_start_date = next_start, updated_at = now()
    where id = p.id returning * into p;
  return p;
end $$;

revoke all on function public.supervisor_reconcile_effect_attempt(
  uuid,uuid,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.supervisor_reconcile_effect_attempt(
  uuid,uuid,uuid,uuid,integer) to service_role;
