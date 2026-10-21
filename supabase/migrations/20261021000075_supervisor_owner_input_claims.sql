-- One-shot claims for owner-confirmed Supervisor-provided facts.
-- No owner/browser access: all writes go through the authenticated Server route,
-- compiled write registry, and existing domain action. A crash after claiming
-- may leave 'started': it must never automatically repeat the domain write.
create table if not exists public.supervisor_owner_input_claims (
  question_id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'started' check (state in ('started','applied','uncertain')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists supervisor_owner_input_claims_owner_idx
  on public.supervisor_owner_input_claims(business_id,owner_user_id,created_at desc);
alter table public.supervisor_owner_input_claims enable row level security;
revoke all on public.supervisor_owner_input_claims from public,anon,authenticated;
grant select,insert,update on public.supervisor_owner_input_claims to service_role;
comment on table public.supervisor_owner_input_claims is
  'Private one-time claims; started/uncertain never grants automatic retry of a domain effect.';

-- Reviewed, tenant-authorized CAS extension for the EXISTING Menu ingredient
-- write action. The business-wide epoch row is locked BEFORE checking it and
-- inserting the price, making source validation + mutation one transaction.
-- Direct calls cannot impersonate another owner or choose a foreign ingredient.
create function public.menu_add_manual_ingredient_price_if_revision(
  p_business_id uuid, p_menu_item_id uuid, p_ingredient_id uuid,
  p_expected_revision text, p_expected_day date,
  p_package_cost_cents bigint, p_package_quantity numeric
) returns jsonb language plpgsql strict security definer
set search_path=pg_catalog,public as $owner_price$
declare
  v_revision bigint;
  v_timezone text;
  v_micro bigint;
  v_micro_numeric numeric;
begin
  if auth.uid() is null or p_expected_revision !~ '^[1-9][0-9]{0,18}$'
     or p_package_cost_cents <= 0 or p_package_cost_cents > 100000000
     or p_package_quantity <= 0 or p_package_quantity > 1000000 then
    return jsonb_build_object('ok',false,'reason','invalid_request');
  end if;
  select b.timezone into v_timezone
  from public.businesses b
  where b.id=p_business_id and b.is_demo=false and b.currency='USD'
    and exists(select 1 from public.memberships m
      where m.business_id=b.id and m.user_id=auth.uid() and m.role='owner');
  if v_timezone is null then
    return jsonb_build_object('ok',false,'reason','unauthorized');
  end if;
  -- Serialize CAS operations by business; P1 AFTER STATEMENT epoch bump reuses
  -- this row lock in the same transaction. Never lock whole tables or cafés.
  select revision into v_revision from public.p1_business_source_epochs
    where business_id=p_business_id for update;
  if v_revision is null or v_revision::text<>p_expected_revision or
    p_expected_day is distinct from (now() at time zone v_timezone)::date then
    return jsonb_build_object('ok',false,'reason','source_changed');
  end if;
  if not exists (
    select 1 from public.menu_items mi
    join public.recipe_lines rl on rl.menu_item_id=mi.id
    join public.ingredients i on i.id=rl.ingredient_id
    where mi.id=p_menu_item_id and mi.business_id=p_business_id
      and mi.is_active and i.id=p_ingredient_id and i.business_id=p_business_id
  ) or exists (
    select 1 from public.ingredient_prices ip
    where ip.ingredient_id=p_ingredient_id and ip.effective_from<=p_expected_day
  ) or exists (
    select 1 from public.menu_item_cost_fallbacks f
    where f.business_id=p_business_id and f.menu_item_id=p_menu_item_id
      and f.cost_cents>0
  ) then
    return jsonb_build_object('ok',false,'reason','source_changed');
  end if;
  -- Exactly the same canonical cents-to-microcents conversion used by the
  -- Menu action; SQL NUMERIC avoids float money and rounds once on storage.
  v_micro_numeric:=round((p_package_cost_cents::numeric/p_package_quantity)*1000000);
  if v_micro_numeric<=0 or v_micro_numeric>9223372036854775807 then
    return jsonb_build_object('ok',false,'reason','invalid_request');
  end if;
  v_micro:=v_micro_numeric::bigint;
  insert into public.ingredient_prices
    (ingredient_id,effective_from,cost_per_base_unit_micros,source)
    values (p_ingredient_id,p_expected_day,v_micro,'manual');
  return jsonb_build_object('ok',true,'effectiveDate',p_expected_day::text);
end;
$owner_price$;
revoke all on function public.menu_add_manual_ingredient_price_if_revision(
  uuid,uuid,uuid,text,date,bigint,numeric) from public,anon,authenticated;
grant execute on function public.menu_add_manual_ingredient_price_if_revision(
  uuid,uuid,uuid,text,date,bigint,numeric) to authenticated;


-- Durable owner-question consumption and retry payload. Ordinary messages
-- continue through ConversationService, but a structured card response is
-- atomically compare-and-appended under a PER-THREAD lock with its full shape.
alter table public.ai_messages
  add column owner_input_prompt_message_id uuid references public.ai_messages(id) on delete cascade,
  add column owner_input_response jsonb;
create unique index ai_messages_one_owner_answer_per_prompt
  on public.ai_messages(thread_id,owner_input_prompt_message_id)
  where owner_input_prompt_message_id is not null;
alter table public.ai_messages add constraint ai_messages_owner_input_columns
  check (
    (owner_input_prompt_message_id is null and owner_input_response is null)
    or (
      role='owner' and owner_input_prompt_message_id is not null
      and owner_input_response is not null
      and jsonb_typeof(owner_input_response)='object'
    )
  );
-- Existing authenticated clients may still append only the original,
-- validated owner text columns; ONLY this reviewed function can set
-- the new owner-input metadata, preventing direct PostgREST card forgery.
revoke insert on public.ai_messages from authenticated;
grant insert (business_id,thread_id,owner_user_id,author_user_id,role,
  content_type,text_content,structured_content,grounding,client_message_id)
  on public.ai_messages to authenticated;

create function public.supervisor_submit_owner_question(
  p_business_id uuid,p_thread_id uuid,p_client_message_id uuid,
  p_text text,p_response jsonb
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public as $submit_owner$
declare
  v_existing public.ai_messages%rowtype;
  v_last public.ai_messages%rowtype;
  v_inserted uuid;
  v_question_id text;
begin
  if auth.uid() is null or p_text is null or
    char_length(btrim(p_text)) not between 1 and 4000 or
    p_response is null or jsonb_typeof(p_response)<>'object' or
    (select count(*) from jsonb_object_keys(p_response)) not between 2 and 3 or
    p_response->>'action' is null or
    p_response->>'action' not in ('supply','confirm','dismiss') or
    coalesce(p_response->>'questionId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return jsonb_build_object('ok',false,'reason','invalid_response');
  end if;
  if p_response->>'action'='supply' and
      (jsonb_typeof(p_response->'value')<>'string' or
       char_length(p_response->>'value')>200) or
     p_response->>'action'<>'supply' and p_response ? 'value'
  then return jsonb_build_object('ok',false,'reason','invalid_response');
  end if;
  -- Serializes same-thread writes without table locks or cross-café blocking.
  perform 1 from public.ai_threads t
   where t.id=p_thread_id and t.business_id=p_business_id
     and t.owner_user_id=auth.uid()
     and exists(select 1 from public.memberships m where
       m.business_id=t.business_id and m.user_id=auth.uid() and m.role='owner')
   for update;
  if not found then return jsonb_build_object('ok',false,'reason','unauthorized');end if;

  select * into v_existing from public.ai_messages
    where thread_id=p_thread_id and business_id=p_business_id
      and owner_user_id=auth.uid() and client_message_id=p_client_message_id;
  if found then
    if v_existing.role='owner' and v_existing.text_content=p_text and
      v_existing.owner_input_response=p_response and
      v_existing.owner_input_prompt_message_id is not null
    then return jsonb_build_object('ok',true,'replayed',true);end if;
    return jsonb_build_object('ok',false,'reason','client_key_conflict');
  end if;

  select * into v_last from public.ai_messages
    where thread_id=p_thread_id and business_id=p_business_id
      and owner_user_id=auth.uid()
    order by created_at desc,id desc limit 1;
  if not found or v_last.role<>'supervisor' or
    v_last.grounding->'ownerInput'->>'businessId' is distinct from p_business_id::text or
    v_last.grounding->'ownerInput'->>'questionId' is distinct from p_response->>'questionId' or
    (p_response->>'action'='supply' and
      v_last.grounding->'ownerInput'->>'stage' is distinct from 'answer') or
    (p_response->>'action'='confirm' and
      v_last.grounding->'ownerInput'->>'stage' is distinct from 'confirm')
  then return jsonb_build_object('ok',false,'reason','owner_input_not_pending');end if;
  -- The unique prompt index is a second safeguard if another ingestion
  -- path somehow races this transaction.
  insert into public.ai_messages(business_id,thread_id,owner_user_id,
    author_user_id,role,content_type,text_content,structured_content,
    grounding,client_message_id,owner_input_prompt_message_id,owner_input_response)
  values(p_business_id,p_thread_id,auth.uid(),auth.uid(),'owner','text',
    p_text,null,null,p_client_message_id,v_last.id,p_response)
  returning id into v_inserted;
  return jsonb_build_object('ok',true,'ownerMessageId',v_inserted);
end;
$submit_owner$;
revoke all on function public.supervisor_submit_owner_question(
  uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_submit_owner_question(
  uuid,uuid,uuid,text,jsonb) to authenticated;


-- Extend the exact binding constraint introduced in migration 000039.
-- Do not drop or relax its role, provenance, bounds or grounding checks.
alter table public.ai_messages drop constraint ai_messages_supervisor_content_check;
alter table public.ai_messages add constraint ai_messages_supervisor_content_check check (
  (role = 'owner'
    and author_user_id is not null and author_user_id = owner_user_id
    and content_type = 'text' and text_content is not null
    and char_length(btrim(text_content)) between 1 and 4000
    and structured_content is null and grounding is null
    and client_message_id is not null)
  or
  (role = 'supervisor'
    and author_user_id is null and content_type = 'blocks'
    and text_content is null and structured_content is not null
    and grounding is not null
    and case when jsonb_typeof(structured_content) = 'array'
      then jsonb_array_length(structured_content) between 1 and 30
      else false end
    and jsonb_typeof(grounding) = 'object'
    and coalesce(grounding->>'status', '') in
      ('verified', 'estimated', 'partial', 'unavailable',
       'insufficient_evidence', 'requires_owner_input')
    and (coalesce(grounding->>'status','') <> 'requires_owner_input'
      or jsonb_typeof(grounding->'ownerInput') = 'object'))
);
