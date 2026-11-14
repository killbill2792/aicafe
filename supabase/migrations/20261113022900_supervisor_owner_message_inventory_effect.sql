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
  -- The café's configured ISO currency is authoritative; do not assume USD.
  -- Common glyph aliases are selected by that currency, not by the model.
  select b.currency into currency_code from public.businesses b
    where b.id=p_business_id;
  if currency_code is null or currency_code !~ '^[A-Z]{3}
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(^|[^[:alnum:]])'||currency_pattern||'[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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
 then
    raise exception 'cafe_currency_unavailable' using errcode='42501';
  end if;
  currency_glyph:=case currency_code
    when 'USD' then '
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(\$|USD[[:space:]]*)[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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
 when 'GBP' then '£' when 'EUR' then '€'
    when 'CAD' then 'CA
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(\$|USD[[:space:]]*)[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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
 when 'AUD' then 'A
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(\$|USD[[:space:]]*)[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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
 when 'NZD' then 'NZ
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(\$|USD[[:space:]]*)[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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

    when 'JPY' then '¥' when 'INR' then '₹' when 'KRW' then '₩'
    when 'CNY' then 'CN¥' when 'BRL' then 'R
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(\$|USD[[:space:]]*)[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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
 else null end;
  currency_pattern:='('||currency_code
    ||case when currency_glyph is null then ''
      else '|'||replace(currency_glyph,'
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(\$|USD[[:space:]]*)[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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
, '\
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(\$|USD[[:space:]]*)[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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
) end||')';
  if p.canonical_effect_payload->>'costCents' is null and
     m.text_content ~* ('(^|[^[:alnum:]])'||currency_pattern||'[[:space:]]*[0-9]')
  then raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
  if p.canonical_effect_payload->>'costCents' is not null then
    claimed_cost:=(p.canonical_effect_payload->>'costCents')::bigint;
    if claimed_cost<0 then
      raise exception 'typed_purchase_cost_not_grounded' using errcode='42501'; end if;
    dollars:=claimed_cost/100;cents:=(claimed_cost%100)::integer;
    price_pattern:='(\$|USD[[:space:]]*)[[:space:]]*'||dollars::text||
      case when cents=0 then '(\.00)?'
           else '\.'||lpad(cents::text,2,'0') end||'([^0-9.]|$)';
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
