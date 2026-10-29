-- Prompt C: durable, versioned owner-provided business facts.
-- Apply manually after migration 109 and before migrations 111/112.
create table public.owner_facts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  fact_key text not null check (fact_key ~ '^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$'),
  value_json jsonb not null check (jsonb_typeof(value_json) in ('string','number','boolean','object','array')),
  unit text,
  period_scope text,
  source text not null default 'owner' check (source = 'owner'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  superseded_at timestamptz,
  check (unit is null or length(unit) <= 40),
  check (period_scope is null or length(period_scope) <= 120),
  check (octet_length(value_json::text) <= 4096)
);
create unique index owner_facts_current_unique
  on public.owner_facts(business_id, fact_key) where superseded_at is null;
create index owner_facts_history_idx
  on public.owner_facts(business_id, fact_key, created_at desc);

alter table public.owner_facts enable row level security;
create policy "owner facts member read" on public.owner_facts
  for select to authenticated using (exists (
    select 1 from public.memberships m where m.business_id = owner_facts.business_id
      and m.user_id = (select auth.uid()) and m.role in ('owner','manager')));
create policy "owner facts member insert" on public.owner_facts
  for insert to authenticated with check (created_by = (select auth.uid()) and exists (
    select 1 from public.memberships m where m.business_id = owner_facts.business_id
      and m.user_id = (select auth.uid()) and m.role in ('owner','manager')));
create policy "owner facts member update" on public.owner_facts
  for update to authenticated using (exists (
    select 1 from public.memberships m where m.business_id = owner_facts.business_id
      and m.user_id = (select auth.uid()) and m.role in ('owner','manager')))
  with check (exists (
    select 1 from public.memberships m where m.business_id = owner_facts.business_id
      and m.user_id = (select auth.uid()) and m.role in ('owner','manager')));
-- Mutations must use the transactional RPC: otherwise a client could edit
-- history in place, defeating the supersession/audit guarantee.
grant select on public.owner_facts to authenticated;
revoke insert, update, delete on public.owner_facts from authenticated;
revoke all on public.owner_facts from anon;

-- Preserve existing recurrent costs; only new owner-reported entries are tagged.
alter table public.recurring_costs
  add column if not exists source text not null default 'app';
alter table public.recurring_costs
  add constraint recurring_costs_source_allowed
  check (source in ('toast','owner','app'));

-- Atomic versioning; serializes concurrent submissions on a single café.
-- A total bill must NOT silently create another cost when existing cost lines
-- are present: that would double count in the shared screens and calculations.
create or replace function public.save_owner_fact(
 p_business_id uuid, p_fact_key text, p_value_json jsonb,
 p_unit text default null, p_period_scope text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
 v_uid uuid := auth.uid();
 v_now timestamptz := now();
 v_written boolean := false;
 v_other_monthly bigint;
 v_remainder bigint;
 v_rate integer;
 v_plan public.processing_fee_rate_plans%rowtype;
 v_rules jsonb;
 v_count integer;
 v_amount bigint;
 v_day date;
 v_id uuid;
begin
 if v_uid is null or not exists (
   select 1 from public.memberships m where m.business_id=p_business_id
    and m.user_id=v_uid and m.role in ('owner','manager')
 ) then raise exception 'owner_fact_forbidden' using errcode='42501'; end if;
 if p_fact_key is null or p_fact_key !~ '^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$'
    or p_value_json is null or octet_length(p_value_json::text)>4096
 then raise exception 'invalid_owner_fact'; end if;
 select (v_now at time zone timezone)::date into v_day
   from public.businesses where id=p_business_id for update;
 if v_day is null then raise exception 'business_timezone_required'; end if;
 select id into v_id from public.owner_facts
   where business_id=p_business_id and fact_key=p_fact_key and superseded_at is null
     and value_json=p_value_json and unit is not distinct from p_unit
     and period_scope is not distinct from p_period_scope;
 if v_id is not null then
   -- Retries are idempotent, but must never claim screen write-through
   -- succeeded when an earlier owner answer was saved only as a fact.
   if p_fact_key='monthly_bills_cents' then
     -- Check that the current shared-screen rows still reconcile to this total.
     select coalesce(sum(case rc.frequency
       when 'weekly' then round(rc.amount_cents::numeric*52/12)
       when 'quarterly' then round(rc.amount_cents::numeric/3)
       when 'yearly' then round(rc.amount_cents::numeric/12)
       else rc.amount_cents end),0)::bigint into v_other_monthly
     from public.recurring_costs rc
     where rc.business_id=p_business_id and rc.active_from<=v_day
       and (rc.active_to is null or rc.active_to>=v_day)
       and not (rc.source='owner' and rc.label='Owner reported monthly bills');
     select exists(select 1 from public.recurring_costs rc
       where rc.business_id=p_business_id and rc.source='owner'
         and rc.label='Owner reported monthly bills'
         and rc.amount_cents+v_other_monthly=(p_value_json #>> '{}')::bigint
         and rc.active_from<=v_day and (rc.active_to is null or rc.active_to>=v_day))
       into v_written;
   elsif p_fact_key='payroll_extras_monthly_cents' then
     select coalesce(b.owner_monthly_payroll_extras_cents=
       (p_value_json #>> '{}')::bigint,false) into v_written
       from public.businesses b where b.id=p_business_id;
   elsif p_fact_key='card_fee_rate_percent' then
     v_rate := round(((p_value_json #>> '{}')::numeric)*100);
     select exists(select 1 from public.processing_fee_rate_plans p
       where p.business_id=p_business_id
         and p.effective_from<=v_day
         and (p.effective_to is null or p.effective_to>=v_day)
         and jsonb_array_length(p.rules)=1
         and (p.rules->0->>'percentageBps')::integer=v_rate)
       into v_written;
   end if;
   if coalesce(v_written,false) then
     return jsonb_build_object('id',v_id,'writeThroughApplied',true);
   end if;
   -- Same saved answer, but a previously incomplete screen write-through
   -- may now be safe. Retry it without creating a duplicate fact/version.
 end if;
 if v_id is null then
   update public.owner_facts set superseded_at=v_now,updated_at=v_now
     where business_id=p_business_id and fact_key=p_fact_key and superseded_at is null;
   insert into public.owner_facts (business_id,fact_key,value_json,unit,period_scope,created_by)
   values (p_business_id,p_fact_key,p_value_json,p_unit,p_period_scope,v_uid) returning id into v_id;
 end if;
 if p_fact_key='payroll_extras_monthly_cents' and jsonb_typeof(p_value_json)='number' then
   v_amount := (p_value_json #>> '{}')::bigint;
   if v_amount < 0 then raise exception 'negative_owner_amount'; end if;
   update public.businesses set owner_monthly_payroll_extras_cents=v_amount,
    owner_monthly_payroll_extras_updated_at=v_now where id=p_business_id;
   v_written := true;
 elsif p_fact_key='monthly_bills_cents' and jsonb_typeof(p_value_json)='number' then
   v_amount := (p_value_json #>> '{}')::bigint;
   if v_amount < 0 then raise exception 'negative_owner_amount'; end if;
   -- Preserve all itemized source lines. Store the owner-reported TOTAL
   -- as the unitemized remainder, never as a duplicated running cost.
   select coalesce(sum(case rc.frequency
     when 'weekly' then round(rc.amount_cents::numeric*52/12)
     when 'quarterly' then round(rc.amount_cents::numeric/3)
     when 'yearly' then round(rc.amount_cents::numeric/12)
     else rc.amount_cents end),0)::bigint into v_other_monthly
   from public.recurring_costs rc
   where rc.business_id=p_business_id and rc.active_from<=v_day
     and (rc.active_to is null or rc.active_to>=v_day)
     and not (rc.source='owner' and rc.label='Owner reported monthly bills');
   v_written := false;
   if v_amount >= v_other_monthly then
     v_remainder := v_amount-v_other_monthly;
     update public.recurring_costs set active_to=v_day - 1
       where business_id=p_business_id and label='Owner reported monthly bills'
         and source='owner' and active_from<v_day
         and (active_to is null or active_to>=v_day);
     update public.recurring_costs set amount_cents=v_remainder,
       frequency='monthly',is_estimate=false
       where business_id=p_business_id and label='Owner reported monthly bills'
         and source='owner' and active_from=v_day;
     get diagnostics v_count = row_count;
     if v_count=0 then
       insert into public.recurring_costs(business_id,category_code,label,amount_cents,
         frequency,is_estimate,source,active_from)
       values(p_business_id,'other','Owner reported monthly bills',v_remainder,
         'monthly',false,'owner',v_day);
     end if;
     v_written := true;
   end if;
 elsif p_fact_key like 'card_%' and p_fact_key<>'card_fee_rate_percent' then
   -- These fields are retained as facts; the complete batch RPC alone
   -- commits a shared screen-visible processing-fee plan.
   v_written := false;
 elsif p_fact_key='card_fee_rate_percent' and jsonb_typeof(p_value_json)='number' then
   v_rate := round(((p_value_json #>> '{}')::numeric)*100);
   if v_rate<0 or v_rate>5000 then raise exception 'invalid_card_fee_percent'; end if;
   -- Copy an existing complete, single-rule plan instead of changing past
   -- months' fee assumptions or guessing the processed sales/transaction mix.
   select * into v_plan from public.processing_fee_rate_plans p
     where p.business_id=p_business_id and p.effective_from<=v_day
       and (p.effective_to is null or p.effective_to>=v_day)
     order by p.effective_from desc limit 1;
   v_written := false;
   if v_plan.id is not null and jsonb_array_length(v_plan.rules)=1 then
     select jsonb_agg(jsonb_set(rule,'{percentageBps}',to_jsonb(v_rate),true))
       into v_rules from jsonb_array_elements(v_plan.rules) rule;
     if v_plan.effective_from<v_day then
       update public.processing_fee_rate_plans set effective_to=v_day-1,updated_at=v_now
         where id=v_plan.id and business_id=p_business_id;
       insert into public.processing_fee_rate_plans (
         business_id,effective_from,effective_to,processor_label,
         processed_sales_share_bps,processed_transaction_share_bps,
         average_processed_ticket_cents,rules,confirmed_by,confirmed_at
       ) values (
         p_business_id,v_day,null,v_plan.processor_label,
         v_plan.processed_sales_share_bps,v_plan.processed_transaction_share_bps,
         v_plan.average_processed_ticket_cents,v_rules,v_uid,v_now
       );
     else
       update public.processing_fee_rate_plans set rules=v_rules,
         confirmed_by=v_uid,confirmed_at=v_now,updated_at=v_now
       where id=v_plan.id and business_id=p_business_id;
     end if;
     v_written := true;
   end if;
 end if;
 return jsonb_build_object('id',v_id,'writeThroughApplied',v_written);
end $$;
revoke all on function public.save_owner_fact(uuid,text,jsonb,text,text) from public,anon;
grant execute on function public.save_owner_fact(uuid,text,jsonb,text,text) to authenticated;

-- Multiple fields from one verified card commit together, or none do.
create or replace function public.save_owner_fact_answers(
 p_business_id uuid, p_answers jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v jsonb; v_item jsonb; v_results jsonb := '[]'::jsonb;
 v_keys text[] := '{}'::text[];
 v_day date;
 v_rate numeric;
 v_card_sales numeric;
 v_card_transactions numeric;
 v_fixed numeric;
 v_average numeric;
 v_processor text;
 v_complete boolean := false;
begin
 if p_answers is null or jsonb_typeof(p_answers)<>'array'
    or jsonb_array_length(p_answers) not between 1 and 6 then
   raise exception 'invalid_owner_answers';
 end if;
 for v in select value from jsonb_array_elements(p_answers) loop
   if jsonb_typeof(v)<>'object' or v->>'factKey' = any(v_keys)
     or v->>'factKey' is null then raise exception 'invalid_owner_answer'; end if;
   v_keys := array_append(v_keys,v->>'factKey');
   v_item := public.save_owner_fact(p_business_id,v->>'factKey',v->'value',
     v->>'unit',v->>'periodScope') || jsonb_build_object('factKey',v->>'factKey');
   v_results := v_results || jsonb_build_array(v_item);
 end loop;

 -- An owner's rate alone is not a fee plan: never guess the card/cash split,
 -- fixed charge, processor, or average ticket needed to estimate transactions.
 -- Only build a canonical single-rule plan after ALL fields were supplied.
 if v_keys && array['card_fee_rate_percent','card_sales_share_percent',
   'card_transactions_share_percent','card_fixed_fee_cents',
   'card_average_ticket_cents','card_processor_label']::text[] then
   select (now() at time zone b.timezone)::date into v_day
     from public.businesses b where b.id=p_business_id;
   select
     max(case when f.fact_key='card_fee_rate_percent'
       then (f.value_json #>> '{}')::numeric end),
     max(case when f.fact_key='card_sales_share_percent'
       then (f.value_json #>> '{}')::numeric end),
     max(case when f.fact_key='card_transactions_share_percent'
       then (f.value_json #>> '{}')::numeric end),
     max(case when f.fact_key='card_fixed_fee_cents'
       then (f.value_json #>> '{}')::numeric end),
     max(case when f.fact_key='card_average_ticket_cents'
       then (f.value_json #>> '{}')::numeric end),
     max(case when f.fact_key='card_processor_label'
       then f.value_json #>> '{}' end)
     into v_rate,v_card_sales,v_card_transactions,v_fixed,v_average,v_processor
   from public.owner_facts f
   where f.business_id=p_business_id and f.superseded_at is null
     and f.fact_key in ('card_fee_rate_percent','card_sales_share_percent',
       'card_transactions_share_percent','card_fixed_fee_cents',
       'card_average_ticket_cents','card_processor_label');
   v_complete := v_rate between 0 and 50
     and v_card_sales between 0 and 100
     and v_card_transactions between 0 and 100
     and v_fixed between 0 and 5000
     and trim(coalesce(v_processor,'')) <> ''
     and length(v_processor) <= 80
     and (v_fixed=0 or v_average between 1 and 100000000);
   if coalesce(v_complete,false) then
     update public.processing_fee_rate_plans p
       set effective_to=v_day - 1,updated_at=now()
       where p.business_id=p_business_id
         and p.effective_from < v_day
         and (p.effective_to is null or p.effective_to>=v_day);
     insert into public.processing_fee_rate_plans (
       business_id,effective_from,effective_to,processor_label,
       processed_sales_share_bps,processed_transaction_share_bps,
       average_processed_ticket_cents,rules,confirmed_by,confirmed_at
     ) values (
       p_business_id,v_day,null,trim(v_processor),
       round(v_card_sales*100)::integer,round(v_card_transactions*100)::integer,
       case when v_fixed>0 then v_average::bigint else null end,
       jsonb_build_array(jsonb_build_object(
         'id','owner-confirmed','label',trim(v_processor),
         'percentageBps',round(v_rate*100)::integer,
         'fixedFeeCents',v_fixed::integer,
         'salesMixBps',10000,'transactionMixBps',10000)),
       auth.uid(),now()
     ) on conflict (business_id,effective_from) do update set
       effective_to=null,
       processor_label=excluded.processor_label,
       processed_sales_share_bps=excluded.processed_sales_share_bps,
       processed_transaction_share_bps=excluded.processed_transaction_share_bps,
       average_processed_ticket_cents=excluded.average_processed_ticket_cents,
       rules=excluded.rules,
       confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,
       updated_at=now();
     -- The whole fee plan now has a shared screen-visible write-through.
     select coalesce(jsonb_agg(
       case when x->>'factKey' like 'card_%'
         then jsonb_set(x,'{writeThroughApplied}','true'::jsonb,true)
         else x end
     ),'[]'::jsonb) into v_results from jsonb_array_elements(v_results) x;
   end if;
 end if;
 return v_results;
end $$;
revoke all on function public.save_owner_fact_answers(uuid,jsonb) from public,anon;
grant execute on function public.save_owner_fact_answers(uuid,jsonb) to authenticated;
