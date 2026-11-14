-- Task 14B: One Supervisor, owner-approved purchase-order proposals.
-- Additive only. Do NOT move stock, book an expense or send an external order.
set lock_timeout = '3s';
set statement_timeout = '30s';

-- Historic quote currency stays UNKNOWN, never inherited from today's business setting.
alter table public.ai_supplier_quotes
  add column currency_code text check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  add column ingredient_id uuid,
  add column valid_until date,
  add column available_status text not null default 'unknown'
    check (available_status in ('unknown','confirmed','unavailable')),
  add column available_checked_at date,
  add column delivery_on date,
  add constraint ai_supplier_quotes_availability_date_check
    check (available_status <> 'confirmed' or available_checked_at is not null),
  add constraint ai_supplier_quotes_quote_dates_check
    check (valid_until is null or valid_until >= quoted_on);
-- Reason: A new composite FK validates existing rows (which have NULL ingredient_id).
-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
create unique index if not exists ai_supplier_quotes_business_id_uq
  on public.ai_supplier_quotes(business_id,id);
-- Reason: Ingredients are already business-owned and unique by id; composite
-- uniqueness prevents a forged cross-café ingredient reference.
create unique index if not exists ingredients_business_id_supplier_uq
  on public.ingredients(business_id,id);
-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
alter table public.ai_supplier_quotes add constraint ai_supplier_quotes_ingredient_scope_fk
  foreign key (business_id,ingredient_id) references public.ingredients(business_id,id);
create index if not exists ai_supplier_quotes_business_source_idx
  on public.ai_supplier_quotes(business_id,item_name,created_at desc);

create table public.cafe_suppliers(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 display_name text not null check (length(btrim(display_name)) between 2 and 120),
 normalized_name text generated always as (lower(btrim(display_name))) stored,
 created_at timestamptz not null default now(),
 unique(business_id,id),
 unique(business_id,normalized_name)
);
-- One PO per APPROVED proposal, immutable snapshot of the commitment.
create table public.purchase_orders(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references public.businesses(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id),
 supplier_id uuid not null,
 supplier_name_snapshot text not null,
 proposal_id uuid not null,
 effect_hash text not null check (effect_hash ~ '^[a-f0-9]{64}$'),
 status text not null default 'approved_for_ordering'
   check (status in ('approved_for_ordering','cancelled','superseded')),
 revision integer not null default 1 check (revision>=1),
 currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
 needed_by date,
 subtotal_cents bigint not null check (subtotal_cents>0 and subtotal_cents<=1000000000),
 shipping_cents bigint check (shipping_cents is null or shipping_cents>=0),
 tax_cents bigint check (tax_cents is null or tax_cents>=0),
 total_cents bigint check (total_cents is null or total_cents>=subtotal_cents),
 approved_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 unique(business_id,id),
 unique(business_id,proposal_id),
 foreign key (business_id,supplier_id) references public.cafe_suppliers(business_id,id),
 foreign key (business_id,proposal_id) references public.supervisor_proposals(business_id,id),
 check ((shipping_cents is null or tax_cents is null) and total_cents is null or
        (shipping_cents is not null and tax_cents is not null and total_cents = subtotal_cents + shipping_cents + tax_cents))
);
create index purchase_orders_cafe_date_idx
 on public.purchase_orders(business_id,created_at desc);
create table public.purchase_order_lines(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 quote_id uuid not null,
 ingredient_id uuid not null,
 ordinal integer not null check(ordinal between 1 and 10),
 item_name_snapshot text not null,
 needed_base_quantity numeric not null check (needed_base_quantity>0),
 base_unit text not null check(base_unit in ('g','ml','each')),
 packs integer not null check(packs between 1 and 100000),
 pack_quantity integer not null check(pack_quantity between 1 and 100000),
 pack_unit text not null,
 unit_price_cents bigint not null check(unit_price_cents between 1 and 100000000),
 subtotal_cents bigint not null check(subtotal_cents=packs*unit_price_cents),
 quoted_on date not null,
 delivery_on date,
 unique(business_id,purchase_order_id,ordinal),
 foreign key (business_id,purchase_order_id) references public.purchase_orders(business_id,id) on delete restrict,
 foreign key (business_id,quote_id) references public.ai_supplier_quotes(business_id,id),
 foreign key (business_id,ingredient_id) references public.ingredients(business_id,id)
);
create table public.purchase_order_events(
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null,
 purchase_order_id uuid not null,
 event_sequence integer not null check(event_sequence>=1),
 event_kind text not null check(event_kind in ('approved_for_ordering','cancelled','superseded')),
 actor_user_id uuid not null references auth.users(id),
 proposal_id uuid not null,
 effect_hash text not null check(effect_hash ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz not null default now(),
 unique(business_id,purchase_order_id,event_sequence),
 foreign key (business_id,purchase_order_id) references public.purchase_orders(business_id,id) on delete restrict
);

-- Only café owners see orders; every mutation is service-role only via gateway.
-- squawk-ignore ban-alter-row-level-security
alter table public.cafe_suppliers enable row level security;
-- squawk-ignore ban-alter-row-level-security
alter table public.purchase_orders enable row level security;
-- squawk-ignore ban-alter-row-level-security
alter table public.purchase_order_lines enable row level security;
-- squawk-ignore ban-alter-row-level-security
alter table public.purchase_order_events enable row level security;
create policy "owner reads suppliers" on public.cafe_suppliers for select to authenticated
 using (exists (select 1 from public.memberships m where m.business_id=cafe_suppliers.business_id
  and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner reads purchase orders" on public.purchase_orders for select to authenticated
 using (owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=purchase_orders.business_id
    and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner reads purchase order lines" on public.purchase_order_lines for select to authenticated
 using (exists(select 1 from public.purchase_orders p where p.business_id=purchase_order_lines.business_id
   and p.id=purchase_order_lines.purchase_order_id and p.owner_user_id=(select auth.uid())));
create policy "owner reads purchase order events" on public.purchase_order_events for select to authenticated
 using (exists(select 1 from public.purchase_orders p where p.business_id=purchase_order_events.business_id
   and p.id=purchase_order_events.purchase_order_id and p.owner_user_id=(select auth.uid())));
revoke all on public.cafe_suppliers,public.purchase_orders,public.purchase_order_lines,
  public.purchase_order_events from public,anon,authenticated;
grant select on public.cafe_suppliers,public.purchase_orders,public.purchase_order_lines,
  public.purchase_order_events to authenticated;
grant all on public.cafe_suppliers,public.purchase_orders,public.purchase_order_lines,
  public.purchase_order_events to service_role;

-- The ONLY purchase-order writer. Requires the existing gateway's *click*
-- attempt, scoped owner, immutable effect, and every source quote. An uncertain
-- HTTP response can only be reconciled from the resulting durable PO record.
create function public.supervisor_commit_supplier_po(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,
 p_effect_hash text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
 p public.supervisor_proposals;
 a public.supervisor_effect_attempts;
 existing public.purchase_orders;
 q public.ai_supplier_quotes;
 ingredient public.ingredients;
 supplier_id uuid;
 new_order_id uuid;
 line jsonb;
 i integer:=0;
 computed_subtotal bigint:=0;
 line_subtotal bigint;
 local_day date;
 business_currency text;
 supplier_name text;
 fx text;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';
 end if;
 if not exists(select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=p_owner_user_id and m.role='owner') then
  raise exception 'proposal_owner_required' using errcode='42501';
 end if;
 select (now() at time zone b.timezone)::date,b.currency into local_day,business_currency
 from public.businesses b where b.id=p_business_id
   and exists(select 1 from pg_timezone_names z where z.name=b.timezone);
 if local_day is null or business_currency is null then
  raise exception 'cafe_context_unavailable' using errcode='P0001';
 end if;
 select * into p from public.supervisor_proposals
 where business_id=p_business_id and owner_user_id=p_owner_user_id
   and thread_id=p_thread_id and id=p_proposal_id for update;
 if p.id is null or p.capability_id<>'maya.supplier_purchase_order.v1'
   or p.capability_version<>1 or p.effect_hash<>p_effect_hash then
  raise exception 'purchase_proposal_invalid' using errcode='42501';
 end if;
 select * into existing from public.purchase_orders
 where business_id=p_business_id and proposal_id=p_proposal_id;
 if existing.id is not null then
  if existing.effect_hash<>p_effect_hash then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('orderId',existing.id,'status',existing.status,
    'subtotalCents',existing.subtotal_cents,'currency',existing.currency_code);
 end if;
 if p.status<>'executing' then
  raise exception 'gateway_click_required' using errcode='42501';
 end if;
 select * into a from public.supervisor_effect_attempts
 where business_id=p_business_id and proposal_id=p_proposal_id
   and effect_hash=p_effect_hash and authorization_kind='click'
   and state='executing' for update;
 if a.id is null then raise exception 'gateway_attempt_missing' using errcode='42501'; end if;
 fx:=p.canonical_effect_payload->>'currency';
 supplier_name:=p.canonical_effect_payload->>'supplierName';
 if fx is distinct from business_currency or fx !~ '^[A-Z]{3}$'
   or supplier_name is null or length(btrim(supplier_name)) not between 2 and 120
 then raise exception 'supplier_currency_or_name_changed' using errcode='P0001'; end if;
 if p.canonical_effect_payload->'lines' is null
   or jsonb_typeof(p.canonical_effect_payload->'lines')<>'array'
   or jsonb_array_length(p.canonical_effect_payload->'lines') not between 1 and 10
 then raise exception 'supplier_lines_missing' using errcode='P0001'; end if;
 if (p.canonical_effect_payload->>'neededBy') is not null
   and (p.canonical_effect_payload->>'neededBy')::date<local_day
 then raise exception 'delivery_date_stale' using errcode='P0001'; end if;
 for line in select value from jsonb_array_elements(p.canonical_effect_payload->'lines')
 loop
  i:=i+1;
  select * into q from public.ai_supplier_quotes
   where business_id=p_business_id and id=(line->>'quoteId')::uuid;
  select * into ingredient from public.ingredients
   where business_id=p_business_id and id=(line->>'ingredientId')::uuid
    and archived_at is null;
  if q.id is null or ingredient.id is null
     or q.currency_code is distinct from fx
     or q.source_kind='public_listing' or q.available_status<>'confirmed'
     or q.available_checked_at is null
     or q.available_checked_at>local_day or q.available_checked_at<local_day-7
     or q.quoted_on>local_day or q.valid_until<local_day
     or lower(btrim(q.supplier_name))<>lower(btrim(supplier_name))
     or lower(btrim(q.item_name))<>lower(btrim(ingredient.name))
     or q.ingredient_id is distinct from ingredient.id and q.ingredient_id is not null
     or q.price_cents::bigint is distinct from (line->>'priceCents')::bigint
     or q.package_count is distinct from (line->>'packQuantity')::integer
     or q.package_unit is distinct from line->>'packUnit'
     or ingredient.base_unit is distinct from line->>'baseUnit'
     or q.quoted_on::text is distinct from line->>'quotedOn'
     or q.delivery_on::text is distinct from line->>'deliveryOn'
  then raise exception 'supplier_source_stale_or_mismatched' using errcode='P0001'; end if;
  if (p.canonical_effect_payload->>'neededBy') is not null
     and (q.delivery_on is null or q.delivery_on>(p.canonical_effect_payload->>'neededBy')::date)
  then raise exception 'supplier_delivery_unverified' using errcode='P0001'; end if;
  if (line->>'packs')::integer not between 1 and 100000
     or (line->>'neededBaseQuantity')::numeric<=0
     or (line->>'lineSubtotalCents')::bigint <>
        (line->>'packs')::bigint*q.price_cents::bigint
  then raise exception 'supplier_line_math_invalid' using errcode='P0001'; end if;
  line_subtotal:=(line->>'lineSubtotalCents')::bigint;
  computed_subtotal:=computed_subtotal+line_subtotal;
 end loop;
 if computed_subtotal<>(p.canonical_effect_payload->>'subtotalCents')::bigint
    or computed_subtotal>1000000000
 then raise exception 'supplier_subtotal_invalid' using errcode='P0001'; end if;
 insert into public.cafe_suppliers(business_id,display_name) values(p_business_id,supplier_name)
 on conflict(business_id,normalized_name) do nothing;
 select id into supplier_id from public.cafe_suppliers where business_id=p_business_id
   and normalized_name=lower(btrim(supplier_name));
 insert into public.purchase_orders(business_id,owner_user_id,supplier_id,supplier_name_snapshot,
  proposal_id,effect_hash,currency_code,needed_by,subtotal_cents)
 values(p_business_id,p_owner_user_id,supplier_id,supplier_name,p_proposal_id,p_effect_hash,
  fx,(p.canonical_effect_payload->>'neededBy')::date,computed_subtotal)
 returning id into new_order_id;
 i:=0;
 for line in select value from jsonb_array_elements(p.canonical_effect_payload->'lines')
 loop
  i:=i+1;
  insert into public.purchase_order_lines(
   business_id,purchase_order_id,quote_id,ingredient_id,ordinal,
   item_name_snapshot,needed_base_quantity,base_unit,packs,pack_quantity,
   pack_unit,unit_price_cents,subtotal_cents,quoted_on,delivery_on
  ) values(p_business_id,new_order_id,(line->>'quoteId')::uuid,(line->>'ingredientId')::uuid,i,
   line->>'itemName',(line->>'neededBaseQuantity')::numeric,line->>'baseUnit',
   (line->>'packs')::integer,(line->>'packQuantity')::integer,
   line->>'packUnit',(line->>'priceCents')::bigint,
   (line->>'lineSubtotalCents')::bigint,(line->>'quotedOn')::date,
   (line->>'deliveryOn')::date);
 end loop;
 insert into public.purchase_order_events(business_id,purchase_order_id,event_sequence,
   event_kind,actor_user_id,proposal_id,effect_hash)
 values(p_business_id,new_order_id,1,'approved_for_ordering',p_owner_user_id,
   p_proposal_id,p_effect_hash);
 return jsonb_build_object('orderId',new_order_id,'status','approved_for_ordering',
   'subtotalCents',computed_subtotal,'currency',fx);
end $$;
revoke all on function public.supervisor_commit_supplier_po(uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.supervisor_commit_supplier_po(uuid,uuid,uuid,uuid,text) to service_role;


-- Recovery is purely proof-based: it never invokes the writer a second time.
-- Extend the ONE Supervisor effect gateway with the supplier PO receipt.
create function public.supervisor_reconcile_supplier_po(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
 p_proposal_id uuid,p_revision integer
) returns public.supervisor_proposals
language plpgsql security definer set search_path=public as $$
declare
 p public.supervisor_proposals;
 a public.supervisor_effect_attempts;
 po public.purchase_orders;
 n integer;
 sum_lines bigint;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';
 end if;
 if not exists(select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=p_owner_user_id and m.role='owner') then
  raise exception 'proposal_owner_required' using errcode='42501';
 end if;
 select * into p from public.supervisor_proposals
 where business_id=p_business_id and owner_user_id=p_owner_user_id
   and thread_id=p_thread_id and id=p_proposal_id for update;
 if p.id is null or p.revision<>p_revision
   or p.capability_id<>'maya.supplier_purchase_order.v1' or p.capability_version<>1
 then raise exception 'po_reconciliation_scope_conflict' using errcode='P0001'; end if;
 select * into a from public.supervisor_effect_attempts where
   business_id=p_business_id and proposal_id=p_proposal_id
   and effect_hash=p.effect_hash and authorization_kind='click' for update;
 if a.id is null then raise exception 'po_gateway_attempt_missing' using errcode='P0001'; end if;
 if a.state='verified' and p.status='committed' then return p; end if;
 if p.status<>'executing' or a.state not in ('executing','uncertain')
 then raise exception 'po_reconciliation_state_conflict' using errcode='P0001'; end if;
 if a.state='executing' and a.created_at>now()-interval '5 minutes'
 then return p; end if;
 select * into po from public.purchase_orders where
   business_id=p_business_id and owner_user_id=p_owner_user_id
   and proposal_id=p.id and effect_hash=p.effect_hash;
 if po.id is not null then
  select count(*)::integer,coalesce(sum(subtotal_cents),0) into n,sum_lines
  from public.purchase_order_lines where business_id=p_business_id and purchase_order_id=po.id;
 end if;
 if po.id is null or po.status<>'approved_for_ordering'
   or po.subtotal_cents is distinct from (p.canonical_effect_payload->>'subtotalCents')::bigint
   or po.currency_code is distinct from p.canonical_effect_payload->>'currency'
   or n is distinct from jsonb_array_length(p.canonical_effect_payload->'lines')
   or sum_lines is distinct from po.subtotal_cents then
  update public.supervisor_effect_attempts set state='uncertain'
  where id=a.id and state='executing';
  return p; -- Uncertain, no automatic retry, never claim approval without receipt.
 end if;
 update public.supervisor_effect_attempts set state='verified',
  receipt_ref='purchase_orders:'||po.id::text,verified_at=now()
 where id=a.id;
 update public.supervisor_proposals set status='committed',
  revision=revision+1,committed_at=now(),
  monitoring_start_date=a.business_date+1,updated_at=now()
 where id=p.id returning * into p;
 return p;
end $$;
revoke all on function public.supervisor_reconcile_supplier_po(uuid,uuid,uuid,uuid,integer)
 from public,anon,authenticated;
grant execute on function public.supervisor_reconcile_supplier_po(uuid,uuid,uuid,uuid,integer)
 to service_role;
