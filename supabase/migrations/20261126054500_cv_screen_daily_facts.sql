set lock_timeout = '5s';
set statement_timeout = '60s';

-- Complete the existing saved-day projection without changing its grain, grants or source.
-- No data is copied or rewritten; all owner-visible provenance stays intact.
create or replace view public.cv_sales_days
 (business_id,source,source_ref,status,business_date,net_sales_cents,orders_count,data)
 with (security_invoker=true) as
 select d.business_id,'app'::text,'rollup:'||d.business_date::text,
  case when d.sales_data_status in ('missing','partial') then 'open'
       when d.sales_data_status='estimated' then 'estimated' else 'actual' end::text,
  d.business_date,d.net_sales_cents,d.orders_count,
  jsonb_build_object('net_sales_cents',d.net_sales_cents,'orders_count',d.orders_count,
   'drinks_count',d.drinks_count,'ingredients_cents',d.ingredients_cents,
   'staff_wages_cents',d.staff_wages_cents,'staff_tax_cents',d.staff_tax_cents,
   'labor_wage_status',d.labor_wage_status,'staff_tax_status',d.staff_tax_status,
   'staff_tax_source',d.staff_tax_source,'sales_data_status',d.sales_data_status,
   'card_fees_cents',d.card_fees_cents,'card_fees_status',d.card_fees_status,
   'voids_cents',d.voids_cents,'voids_status',d.voids_status,'voids_source',d.voids_source,
   'effective_fee',jsonb_build_object('amountCents',fee.amount,'basis',fee.basis,'notes',to_jsonb(array_remove(array[
     case when fee.basis in ('owner_plan','default_estimate') then 'feeNetSalesProxy' end,
     case when fee.basis<>'actual' and p.id is not null and not coalesce(r.valid,false) then 'feeOwnerPlanInvalid' end
   ]::text[],null))),
   'recorded_contribution_cents',case when d.labor_wage_status='missing' or d.staff_wages_cents is null or d.staff_tax_cents is null then null
    else d.net_sales_cents-d.ingredients_cents-d.card_fees_cents-d.staff_wages_cents-d.staff_tax_cents end)
 from public.daily_rollups d
 left join lateral (
   select p.id,p.rules,p.processed_sales_share_bps,p.processed_transaction_share_bps
   from public.processing_fee_rate_plans p where p.business_id=d.business_id
    and p.effective_from<=d.business_date and (p.effective_to is null or p.effective_to>=d.business_date)
   order by p.effective_from desc limit 1
 ) p on true
 left join lateral (
   select count(*)>0 and bool_and(
      percent between 0 and 9007199254740991 and percent=trunc(percent)
      and fixed between 0 and 9007199254740991 and fixed=trunc(fixed)
      and sales_mix between 0 and 10000 and sales_mix=trunc(sales_mix)
      and txn_mix between 0 and 10000 and txn_mix=trunc(txn_mix)
      and percent is not null and fixed is not null and sales_mix is not null and txn_mix is not null
   ) as valid,
   sum(percent*sales_mix/100000000) as rate,
   sum(fixed*txn_mix/10000) as fixed_fee
   from (
     select case when v->>'percentageBps' ~ '^[0-9]+(\.[0-9]+)? is 'One saved day per café and business date. Screen and Supervisor daily sales, ingredient cost, wages, payroll tax, fees and voids; data includes independent sales_data_status, labor_wage_status, staff_tax_status/source and card_fees_status. Not provisional intraday sales.';
comment on column public.cv_sales_days.data is 'Saved daily fact amounts in integer cents and counts, with independent source and completeness statuses. Unknown wages and taxes remain null. recorded_contribution_cents is recorded sales minus ingredients, saved fees and loaded wages, before operating bills; null when labor is incomplete. effective_fee is the screen fee calculation: actual fee, applicable owner plan, saved estimate, then labeled 2.9 percent default. Sum unrounded amountCents before rounding; raw saved fee/status remains separate.';

-- Existing recurring commitments; retain every existing key and expose the active dates and due day.
create or replace view public.cv_bills
 (business_id,source,source_ref,status,business_date,data,id,category_code,label,amount_cents,frequency,is_estimate,active_from,active_to,due_day) with (security_invoker=true) as
 select c.business_id,coalesce(nullif(c.source,''),'app')::text,
 'bill:'||c.id::text,case when c.is_estimate then 'estimated' else 'actual' end::text,
 null::date,jsonb_build_object('id',c.id,'amount_cents',c.amount_cents,
 'frequency',c.frequency,'category',c.category_code,'name',c.label,'is_estimate',c.is_estimate,
 'category_code',c.category_code,'label',c.label,'active_from',c.active_from,
 'active_to',c.active_to,'due_day',c.due_day),
 c.id,c.category_code,c.label,c.amount_cents,c.frequency,c.is_estimate,c.active_from,c.active_to,c.due_day
 from public.recurring_costs c;
comment on view public.cv_bills is 'Recurring obligations, one row per saved commitment, with active dates, amount, frequency and estimate status. Actual expense receipts are in cv_expenses.';

-- Expenses and bills have different grains; never union receipts with obligations.
create view public.cv_expenses with (security_invoker=true) as
 select e.business_id,e.source,'expense:'||e.id::text as source_ref,e.status,
 e.spent_on as business_date,e.id,e.spent_on,e.amount_cents,e.category_code,
 e.recurring_cost_id,e.custom_label,e.vendor
 from public.expenses e;
revoke all on public.cv_expenses from public,anon,authenticated;
grant select on public.cv_expenses to authenticated,service_role;
comment on view public.cv_expenses is 'One saved expense receipt per source_ref, with business date, amount in cents, status and recurring commitment linkage. Attachment paths and private storage metadata are excluded.';

-- The latest provisional reading has a different grain than saved closed days.
-- Do not add it to cv_sales_days or sum it alongside finalized days.
create view public.cv_sales_live with (security_invoker=true) as
 select t.business_id,'toast'::text as source,'live:'||t.business_date::text as source_ref,
 'provisional'::text as status,t.business_date,t.net_sales_cents,t.orders as orders_count,
 t.read_at,t.reading
 from public.toast_today_live t;
revoke all on public.cv_sales_live from public,anon,authenticated;
grant select on public.cv_sales_live to authenticated,service_role;
comment on view public.cv_sales_live is 'Latest provisional Toast café sales snapshot, one row per café. Use only for the matching business date before closeout; never add to finalized cv_sales_days. read_at is the source timestamp.';

-- Preserve order provenance needed by the payment-fee eligibility checks.
create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,source_channel,guest_count,data,net_sales_cents)
 with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text,
 'order:'||o.id::text,case when o.toast_excluded is true or o.superseded_by is not null then 'needs_match' else 'actual' end::text,
 o.business_date,o.id::text,o.dining_option,o.source_channel,o.guest_count::integer,
 jsonb_build_object('order_ref',o.id,'dining_option',o.dining_option,'source_channel',o.source_channel,
 'guest_count',o.guest_count,'toast_excluded',o.toast_excluded,'superseded',o.superseded_by is not null,
 'recorded_net_sales_cents',o.net_sales_cents,'pos_order_id',o.pos_order_id,
 'processing_fee_provider',o.processing_fee_provider),
 case when o.toast_excluded is true or o.superseded_by is not null then null::bigint else o.net_sales_cents end
 from public.orders o;

-- One item/day total from the canonical sold lines. UI and SQL share the same
-- actual-only grouping; no application-side per-line aggregation.
create view public.cv_item_sales_daily with (security_invoker=true) as
 select business_id,'item-day:'||business_date::text||':'||(data->>'menu_item_id') as source_ref,
 'actual'::text as status,business_date,(data->>'menu_item_id')::uuid as menu_item_id,
 sum(quantity) as quantity,sum(net_sales_cents) as net_sales_cents
 from public.cv_item_sales
 where status='actual' and data->>'menu_item_id' is not null
 group by business_id,business_date,(data->>'menu_item_id');
revoke all on public.cv_item_sales_daily from public,anon,authenticated;
grant select on public.cv_item_sales_daily to authenticated,service_role;
comment on view public.cv_item_sales_daily is 'Actual sold quantity and net sales in integer cents, grouped once per cafe, item and business date from cv_item_sales. No voided or review-only lines. Missing days are not zero.';

-- Item identity and quantity use the same operational canonical lines as SQL chat.
create or replace function public.menu_item_quantities_sold(p_business_id uuid,p_from date,p_to date)
 returns table(menu_item_id uuid,total_quantity numeric)
 language sql stable security invoker set search_path=public as $$
 select v.menu_item_id,sum(v.quantity)
 from public.cv_item_sales_daily v
 where v.business_id=p_business_id and v.business_date between p_from and p_to
 group by v.menu_item_id
 $$;

-- Preserve the existing item/review/version union and expose menu display fields.
create or replace view public.cv_menu
 (business_id,source,source_ref,status,business_date,data,id,name,base_name,size_label,price_cents,prep_seconds,category,menu_group,is_active,pos_item_id,catalog_source,catalog_last_synced_at,description,pos_visibility,pos_pricing_strategy) with (security_invoker=true) as
 select m.business_id,case when m.catalog_source='toast' then 'toast' else 'app' end::text,
 'item:'||m.id::text,'actual'::text,null::date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
 'category',m.category,'menu_group',m.menu_group,'is_active',m.is_active,'pos_item_id',m.pos_item_id,
 'base_name',m.base_name,'size_label',m.size_label,'prep_seconds',m.prep_seconds,
 'catalog_source',m.catalog_source,'catalog_last_synced_at',m.catalog_last_synced_at,
 'description',m.description,'pos_visibility',m.pos_visibility,'pos_pricing_strategy',m.pos_pricing_strategy),
 m.id,m.name,m.base_name,m.size_label,m.price_cents,m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,m.catalog_last_synced_at,m.description,m.pos_visibility,m.pos_pricing_strategy
 from public.menu_items m
 union all
 select r.business_id,'toast'::text,'review:'||r.review_type||':'||r.source_key,
 'needs_match'::text,null::date,jsonb_build_object('review_type',r.review_type,'source_key',r.source_key,'detail',r.detail),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.pos_import_reviews r where r.provider='toast' and r.review_type in ('catalog_item','menu_identity','item_identity')
 and r.status='needs_owner'
 union all
 select v.business_id,'toast'::text,
 'price-version:'||v.restaurant_guid::text||':'||v.kind||':'||v.provider_guid::text||':'||v.price_fingerprint,
 'actual'::text,null::date,jsonb_build_object('kind','price_version','provider_guid',v.provider_guid,
 'entity_kind',v.kind,'name',v.name,'category',v.category,'price_cents',v.price_cents,'observed_at',v.observed_at),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.toast_catalog_price_versions v;
comment on view public.cv_menu is 'Current and archived catalog rows have source_ref item:; price-version and needs_match review rows are separate, not additional sellable products. Null open prices remain unknown.';

-- One calculation of monthly running costs. Expense receipts remain dated evidence;
-- linked receipts reduce ONLY their obligation, and unlinked overlap is uncertain.
create function public.running_cost_lines_for_month(p_business_id uuid,p_month_start date,p_as_of date)
returns table(category_code text,data jsonb)
language sql stable security invoker set search_path=public as $$
with bounds as (
 select p_month_start as start_date,(p_month_start+interval '1 month - 1 day')::date as end_date
 where p_month_start=date_trunc('month',p_month_start)::date
 and p_as_of>=p_month_start and exists(select 1 from public.businesses where id=p_business_id)
), expenses as materialized (
 select e.* from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on between b.start_date and least(b.end_date,p_as_of)
), prior as (
 select distinct e.category_code from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on>=b.start_date-interval '1 month'
 and e.spent_on<b.start_date and e.status='actual'
), obligations as (
 select r.*,floor(case r.frequency when 'weekly' then r.amount_cents::numeric*52/12
   when 'quarterly' then r.amount_cents::numeric/3 when 'yearly' then r.amount_cents::numeric/12
   else r.amount_cents::numeric end+0.5)::bigint as monthly_equivalent,
 coalesce(l.recorded,0) as linked_recorded,coalesce(l.actual,0) as linked_actual
 from public.cv_bills r cross join bounds b
 left join lateral (select sum(e.amount_cents) as recorded,
 sum(e.amount_cents) filter(where e.status='actual') as actual
 from expenses e where e.recurring_cost_id=r.id) l on true
 where r.business_id=p_business_id and r.active_from<=b.end_date
 and (r.active_to is null or r.active_to>=b.start_date)
), bill_totals as (
 select r.category_code,count(*) as n,
 sum(greatest(0,r.monthly_equivalent-r.linked_recorded)) as remaining,
 jsonb_agg(jsonb_build_object('kind','recurring','id',r.id,'label',r.label,
 'amountCents',r.amount_cents,'frequency',r.frequency,'source',r.source,'dueDay',r.due_day,
 'activeFrom',r.active_from,'activeTo',r.active_to,'isEstimate',r.is_estimate,
 'monthlyEquivalentCents',r.monthly_equivalent,'linkedRecordedCents',r.linked_recorded,
 'linkedActualCents',r.linked_actual,'linkedEstimatedCents',r.linked_recorded-r.linked_actual,
 'remainingForecastCents',greatest(0,r.monthly_equivalent-r.linked_recorded),
 'costBehaviour','unknown') order by r.id) as evidence
 from obligations r group by r.category_code
), expense_totals as (
 select e.category_code,count(*) as n,sum(e.amount_cents) as recorded,
 coalesce(sum(e.amount_cents) filter(where e.status='actual'),0) as actual,
 coalesce(sum(greatest(0,e.amount_cents)) filter(where e.recurring_cost_id is null),0) as unlinked,
 coalesce(sum(e.amount_cents) filter(where e.status='actual' and e.spent_on=p_as_of),0) as actual_today,
 bool_or(e.status<>'actual') as estimated,
 jsonb_agg(jsonb_build_object('kind','expense','id',e.id,
 'label',coalesce(e.custom_label,e.vendor,e.category_code),'amountCents',e.amount_cents,
 'date',e.spent_on,'status',e.status,'source',e.source,'recurringCostId',e.recurring_cost_id,
 'costBehaviour','unknown') order by e.id) as evidence
 from expenses e group by e.category_code
), defaults(code,label,position,regular) as (
 values ('rent','Rent',1,true),('utilities_power','Electricity & gas',2,true),
 ('water','Water',3,true),('internet','Internet & phone',4,true),('insurance','Insurance',5,true),
 ('loan','Loan payment',6,true),('software','Software',7,true),('supplies','Store runs & supplies',8,true),
 ('repairs','Repairs',9,false),('other','Other',10,false)
), codes as (
 select code from defaults union select p.category_code from prior p
 union select e.category_code from expenses e union select r.category_code from obligations r
 union select o.bucket_code from public.recovery_order o where o.business_id=p_business_id
), facts as (
 select c.code,coalesce(d.label,c.code) as label,coalesce(e.n,0) as receipts,
 coalesce(r.n,0) as commitments,coalesce(e.recorded,0) as recorded,
 coalesce(e.actual,0) as actual,coalesce(r.remaining,0) as remaining,
 least(coalesce(r.remaining,0),coalesce(e.unlinked,0)) as overlap,
 coalesce(e.actual_today,0) as actual_today,coalesce(e.estimated,false) as receipt_estimate,
 coalesce(e.evidence,'[]'::jsonb)||coalesce(r.evidence,'[]'::jsonb) as evidence,
 (coalesce(r.n,0)>0 or (coalesce(d.regular,false) and p.category_code is not null)) as expected,
 o.position as owner_position,d.position as default_position
 from codes c cross join bounds b left join defaults d on d.code=c.code
 left join expense_totals e on e.category_code=c.code left join bill_totals r on r.category_code=c.code
 left join prior p on p.category_code=c.code
 left join public.recovery_order o on o.business_id=p_business_id and o.bucket_code=c.code
 where c.code<>'ingredients'
)
select f.code,jsonb_build_object('categoryCode',f.code,'label',f.label,
 'amountCents',f.recorded+f.remaining-f.overlap,'recordedExpenseCents',f.recorded,
 'recordedActualCents',f.actual,'recordedEstimatedCents',f.recorded-f.actual,
 'recurringEstimateCents',f.remaining-f.overlap,'expenseEvidence',f.evidence,
 'possibleAdditionalForecastCents',f.overlap,'forecastUpperCents',f.recorded+f.remaining,
 'forecastOverlapUncertain',f.overlap>0,'amountSource',case when f.receipts>0 then
  case when f.remaining>0 then 'mixed' else 'recorded_expense' end
  when f.commitments>0 then 'recurring' else 'missing' end,
 'actualTodayCents',f.actual_today,'isEstimate',f.receipt_estimate or f.remaining>0,
 'isMissing',f.receipts=0 and f.commitments=0 and f.expected,
 'isExpected',f.expected or f.receipts>0,
 'dailyAllocatedCents',(
   select jsonb_agg(jsonb_build_object('date',p.day::date,'amountCents',
     coalesce((select sum(e.amount_cents) from expenses e
       where e.category_code=f.code and e.spent_on=p.day::date),0)
     + case when f.remaining>0 then
       (f.remaining-f.overlap)/f.remaining/(b.end_date-b.start_date+1)
       * coalesce((select sum(greatest(0,r.monthly_equivalent-r.linked_recorded))
          from obligations r where r.category_code=f.code and r.active_from<=p.day::date
          and (r.active_to is null or r.active_to>=p.day::date)),0)
       else 0 end) order by p.day)
   from bounds b cross join lateral generate_series(b.start_date::timestamp,b.end_date::timestamp,interval '1 day') p(day)
 ))
from facts f order by f.owner_position nulls last,f.default_position nulls last,f.code
$$;
revoke all on function public.running_cost_lines_for_month(uuid,date,date) from public,anon;
grant execute on function public.running_cost_lines_for_month(uuid,date,date) to authenticated,service_role;
comment on function public.running_cost_lines_for_month(uuid,date,date) is 'Canonical monthly running costs, recorded expense evidence and conservative obligation forecasts, using the requested café calendar month and as-of date. Never treats a category match as settlement.';

-- Discoverable SQL view for all observed months and months covered by commitments.
-- Explicit as-of-date reads use the very same function, not a second calculation.
create view public.cv_running_cost_months with (security_invoker=true) as
with cafes as (
 select b.id as business_id,(now() at time zone b.timezone)::date as today
 from public.businesses b
), months as (
 select c.business_id,c.today,date_trunc('month',c.today)::date as business_date from cafes c
 union select c.business_id,c.today,(date_trunc('month',c.today)-interval '1 month')::date from cafes c
 union select c.business_id,c.today,date_trunc('month',e.spent_on)::date
 from cafes c join public.cv_expenses e using(business_id) where e.spent_on<=c.today
 union select c.business_id,c.today,(date_trunc('month',e.spent_on)+interval '1 month')::date
 from cafes c join public.cv_expenses e using(business_id)
 where e.status='actual' and e.spent_on<date_trunc('month',c.today)::date
 union select c.business_id,c.today,date_trunc('month',d.business_date)::date
 from cafes c join public.cv_sales_days d using(business_id) where d.business_date<=c.today
 union select c.business_id,c.today,g.month::date from cafes c
 join public.cv_bills r using(business_id)
 cross join lateral generate_series(date_trunc('month',r.active_from),
  date_trunc('month',least(coalesce(r.active_to,c.today),c.today)),interval '1 month') g(month)
)
select m.business_id,'app'::text as source,'running-cost:'||m.business_date||':'||r.category_code as source_ref,
 case when (r.data->>'isMissing')::boolean then 'open' when (r.data->>'isEstimate')::boolean then 'estimated'
 when (r.data->>'isExpected')::boolean then 'actual' else 'open' end::text as status,
 m.business_date, r.category_code,(r.data->>'amountCents')::bigint as amount_cents,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date) as as_of_date,r.data
from months m cross join lateral public.running_cost_lines_for_month(m.business_id,m.business_date,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date)) r;
revoke all on public.cv_running_cost_months from public,anon,authenticated;
grant select on public.cv_running_cost_months to authenticated,service_role;
comment on view public.cv_running_cost_months is 'One café/month/category, with amount in cents including separately labeled unpaid forecast and dated receipt evidence; as_of_date identifies the cutoff. Do not treat estimated forecasts as paid bills.';

-- Staff screen's persisted clock records deliberately include schedule predictions;
-- cv_labor_entries remains actual provider labor (do not add these two views).
-- A single database statement fixes the clock for all per-entry and day totals.
create view public.cv_staff_clock_entries with (security_invoker=true) as
with entries as (
 select t.business_id,coalesce(t.source_provider,'app')::text as source,'staff-clock:'||t.id as source_ref,
 case when t.source_type='owner_schedule' then 'estimated'
      when t.clock_out is null or t.clock_out>now() then 'provisional'
      when t.hourly_wage_cents is null then 'open' else 'actual' end::text as status,
 (t.clock_in at time zone b.timezone)::date as business_date,
 t.id,t.employee_id,t.schedule_id,t.source_type,t.source_provider,t.clock_in,t.clock_out,
 t.hourly_wage_cents,t.breaks,t.provider_regular_hours,t.provider_overtime_hours,
 e.display_name as employee_name,e.role as employee_role,now() as as_of,
 b.payroll_tax_rate,
 case when t.hourly_wage_cents is null then null
 when t.clock_out is not null and (t.provider_regular_hours is not null or t.provider_overtime_hours is not null)
  and coalesce(t.provider_regular_hours,0)>=0 and coalesce(t.provider_overtime_hours,0)>=0
 then (coalesce(t.provider_regular_hours,0)+coalesce(t.provider_overtime_hours,0)*1.5)*t.hourly_wage_cents
 else greatest(0,extract(epoch from least(coalesce(t.clock_out,now()),now())-t.clock_in)
   - coalesce((select sum(greatest(0,extract(epoch from
      (br->>'end')::timestamptz-(br->>'start')::timestamptz)))
     from jsonb_array_elements(t.breaks) br where not coalesce((br->>'paid')::boolean,false)),0))
   /3600*t.hourly_wage_cents end::numeric as wages_cents
 from public.timecards t join public.businesses b on b.id=t.business_id
 left join public.employees e on e.id=t.employee_id and e.business_id=t.business_id
)
select business_id,source,source_ref,status,business_date,id,employee_id,schedule_id,source_type,source_provider,
 clock_in,clock_out,hourly_wage_cents,breaks,provider_regular_hours,provider_overtime_hours,
 employee_name,employee_role,as_of,wages_cents,wages_cents*(1+payroll_tax_rate) as loaded_cost_cents,
 hourly_wage_cents*(1+payroll_tax_rate) as loaded_hourly_cents,
 case when count(*) filter(where wages_cents is null) over(partition by business_id,business_date)>0 then null
 else sum(wages_cents*(1+payroll_tax_rate)) over(partition by business_id,business_date) end as day_loaded_cost_cents
from entries;
revoke all on public.cv_staff_clock_entries from public,anon,authenticated;
grant select on public.cv_staff_clock_entries to authenticated,service_role;
comment on view public.cv_staff_clock_entries is 'Stored Staff-screen clock records, including explicitly estimated owner schedules. Wage amounts use saved provider hours when available, else elapsed time minus unpaid breaks at as_of; loaded amounts include business payroll tax rate. day_loaded_cost_cents repeats the whole café/day total per entry; never sum it across entries. Unknown wage in any entry makes the day total null. Not additive with cv_labor_entries.';

-- Fractional-cent day allocation is the source for arbitrary period totals.
-- Sum before rounding, and do not treat projected days as payments.
create view public.cv_running_cost_days with (security_invoker=true) as
 select m.business_id,m.source,'running-cost-day:'||(d.value->>'date')||':'||m.category_code as source_ref,
 m.status,(d.value->>'date')::date as business_date,m.category_code,
 (d.value->>'amountCents')::numeric as amount_cents,m.as_of_date
 from public.cv_running_cost_months m cross join lateral jsonb_array_elements(m.data->'dailyAllocatedCents') d;
revoke all on public.cv_running_cost_days from public,anon,authenticated;
grant select on public.cv_running_cost_days to authenticated,service_role;
comment on view public.cv_running_cost_days is 'Canonical period allocation of recorded receipts on their dates plus unpaid forecast only on active commitment days. Amounts may be fractional cents; sum then round. as_of_date is the receipt evidence cutoff, future day allocations are forecasts. Not additive with cv_running_cost_months.';
 then (v->>'percentageBps')::numeric end as percent,
       case when v->>'fixedFeeCents' ~ '^[0-9]+(\.[0-9]+)? is 'One saved day per café and business date. Screen and Supervisor daily sales, ingredient cost, wages, payroll tax, fees and voids; data includes independent sales_data_status, labor_wage_status, staff_tax_status/source and card_fees_status. Not provisional intraday sales.';
comment on column public.cv_sales_days.data is 'Saved daily fact amounts in integer cents and counts, with independent source and completeness statuses. Unknown wages and taxes remain null. recorded_contribution_cents is recorded sales minus ingredients, saved fees and loaded wages, before operating bills; null when labor is incomplete.';

-- Existing recurring commitments; retain every existing key and expose the active dates and due day.
create or replace view public.cv_bills
 (business_id,source,source_ref,status,business_date,data,id,category_code,label,amount_cents,frequency,is_estimate,active_from,active_to,due_day) with (security_invoker=true) as
 select c.business_id,coalesce(nullif(c.source,''),'app')::text,
 'bill:'||c.id::text,case when c.is_estimate then 'estimated' else 'actual' end::text,
 null::date,jsonb_build_object('id',c.id,'amount_cents',c.amount_cents,
 'frequency',c.frequency,'category',c.category_code,'name',c.label,'is_estimate',c.is_estimate,
 'category_code',c.category_code,'label',c.label,'active_from',c.active_from,
 'active_to',c.active_to,'due_day',c.due_day),
 c.id,c.category_code,c.label,c.amount_cents,c.frequency,c.is_estimate,c.active_from,c.active_to,c.due_day
 from public.recurring_costs c;
comment on view public.cv_bills is 'Recurring obligations, one row per saved commitment, with active dates, amount, frequency and estimate status. Actual expense receipts are in cv_expenses.';

-- Expenses and bills have different grains; never union receipts with obligations.
create view public.cv_expenses with (security_invoker=true) as
 select e.business_id,e.source,'expense:'||e.id::text as source_ref,e.status,
 e.spent_on as business_date,e.id,e.spent_on,e.amount_cents,e.category_code,
 e.recurring_cost_id,e.custom_label,e.vendor
 from public.expenses e;
revoke all on public.cv_expenses from public,anon,authenticated;
grant select on public.cv_expenses to authenticated,service_role;
comment on view public.cv_expenses is 'One saved expense receipt per source_ref, with business date, amount in cents, status and recurring commitment linkage. Attachment paths and private storage metadata are excluded.';

-- The latest provisional reading has a different grain than saved closed days.
-- Do not add it to cv_sales_days or sum it alongside finalized days.
create view public.cv_sales_live with (security_invoker=true) as
 select t.business_id,'toast'::text as source,'live:'||t.business_date::text as source_ref,
 'provisional'::text as status,t.business_date,t.net_sales_cents,t.orders as orders_count,
 t.read_at,t.reading
 from public.toast_today_live t;
revoke all on public.cv_sales_live from public,anon,authenticated;
grant select on public.cv_sales_live to authenticated,service_role;
comment on view public.cv_sales_live is 'Latest provisional Toast café sales snapshot, one row per café. Use only for the matching business date before closeout; never add to finalized cv_sales_days. read_at is the source timestamp.';

-- Preserve order provenance needed by the payment-fee eligibility checks.
create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,source_channel,guest_count,data,net_sales_cents)
 with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text,
 'order:'||o.id::text,case when o.toast_excluded is true or o.superseded_by is not null then 'needs_match' else 'actual' end::text,
 o.business_date,o.id::text,o.dining_option,o.source_channel,o.guest_count::integer,
 jsonb_build_object('order_ref',o.id,'dining_option',o.dining_option,'source_channel',o.source_channel,
 'guest_count',o.guest_count,'toast_excluded',o.toast_excluded,'superseded',o.superseded_by is not null,
 'recorded_net_sales_cents',o.net_sales_cents,'pos_order_id',o.pos_order_id,
 'processing_fee_provider',o.processing_fee_provider),
 case when o.toast_excluded is true or o.superseded_by is not null then null::bigint else o.net_sales_cents end
 from public.orders o;

-- One item/day total from the canonical sold lines. UI and SQL share the same
-- actual-only grouping; no application-side per-line aggregation.
create view public.cv_item_sales_daily with (security_invoker=true) as
 select business_id,'item-day:'||business_date::text||':'||(data->>'menu_item_id') as source_ref,
 'actual'::text as status,business_date,(data->>'menu_item_id')::uuid as menu_item_id,
 sum(quantity) as quantity,sum(net_sales_cents) as net_sales_cents
 from public.cv_item_sales
 where status='actual' and data->>'menu_item_id' is not null
 group by business_id,business_date,(data->>'menu_item_id');
revoke all on public.cv_item_sales_daily from public,anon,authenticated;
grant select on public.cv_item_sales_daily to authenticated,service_role;
comment on view public.cv_item_sales_daily is 'Actual sold quantity and net sales in integer cents, grouped once per cafe, item and business date from cv_item_sales. No voided or review-only lines. Missing days are not zero.';

-- Item identity and quantity use the same operational canonical lines as SQL chat.
create or replace function public.menu_item_quantities_sold(p_business_id uuid,p_from date,p_to date)
 returns table(menu_item_id uuid,total_quantity numeric)
 language sql stable security invoker set search_path=public as $$
 select v.menu_item_id,sum(v.quantity)
 from public.cv_item_sales_daily v
 where v.business_id=p_business_id and v.business_date between p_from and p_to
 group by v.menu_item_id
 $$;

-- Preserve the existing item/review/version union and expose menu display fields.
create or replace view public.cv_menu
 (business_id,source,source_ref,status,business_date,data,id,name,base_name,size_label,price_cents,prep_seconds,category,menu_group,is_active,pos_item_id,catalog_source,catalog_last_synced_at,description,pos_visibility,pos_pricing_strategy) with (security_invoker=true) as
 select m.business_id,case when m.catalog_source='toast' then 'toast' else 'app' end::text,
 'item:'||m.id::text,'actual'::text,null::date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
 'category',m.category,'menu_group',m.menu_group,'is_active',m.is_active,'pos_item_id',m.pos_item_id,
 'base_name',m.base_name,'size_label',m.size_label,'prep_seconds',m.prep_seconds,
 'catalog_source',m.catalog_source,'catalog_last_synced_at',m.catalog_last_synced_at,
 'description',m.description,'pos_visibility',m.pos_visibility,'pos_pricing_strategy',m.pos_pricing_strategy),
 m.id,m.name,m.base_name,m.size_label,m.price_cents,m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,m.catalog_last_synced_at,m.description,m.pos_visibility,m.pos_pricing_strategy
 from public.menu_items m
 union all
 select r.business_id,'toast'::text,'review:'||r.review_type||':'||r.source_key,
 'needs_match'::text,null::date,jsonb_build_object('review_type',r.review_type,'source_key',r.source_key,'detail',r.detail),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.pos_import_reviews r where r.provider='toast' and r.review_type in ('catalog_item','menu_identity','item_identity')
 and r.status='needs_owner'
 union all
 select v.business_id,'toast'::text,
 'price-version:'||v.restaurant_guid::text||':'||v.kind||':'||v.provider_guid::text||':'||v.price_fingerprint,
 'actual'::text,null::date,jsonb_build_object('kind','price_version','provider_guid',v.provider_guid,
 'entity_kind',v.kind,'name',v.name,'category',v.category,'price_cents',v.price_cents,'observed_at',v.observed_at),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.toast_catalog_price_versions v;
comment on view public.cv_menu is 'Current and archived catalog rows have source_ref item:; price-version and needs_match review rows are separate, not additional sellable products. Null open prices remain unknown.';

-- One calculation of monthly running costs. Expense receipts remain dated evidence;
-- linked receipts reduce ONLY their obligation, and unlinked overlap is uncertain.
create function public.running_cost_lines_for_month(p_business_id uuid,p_month_start date,p_as_of date)
returns table(category_code text,data jsonb)
language sql stable security invoker set search_path=public as $$
with bounds as (
 select p_month_start as start_date,(p_month_start+interval '1 month - 1 day')::date as end_date
 where p_month_start=date_trunc('month',p_month_start)::date
 and p_as_of>=p_month_start and exists(select 1 from public.businesses where id=p_business_id)
), expenses as materialized (
 select e.* from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on between b.start_date and least(b.end_date,p_as_of)
), prior as (
 select distinct e.category_code from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on>=b.start_date-interval '1 month'
 and e.spent_on<b.start_date and e.status='actual'
), obligations as (
 select r.*,floor(case r.frequency when 'weekly' then r.amount_cents::numeric*52/12
   when 'quarterly' then r.amount_cents::numeric/3 when 'yearly' then r.amount_cents::numeric/12
   else r.amount_cents::numeric end+0.5)::bigint as monthly_equivalent,
 coalesce(l.recorded,0) as linked_recorded,coalesce(l.actual,0) as linked_actual
 from public.cv_bills r cross join bounds b
 left join lateral (select sum(e.amount_cents) as recorded,
 sum(e.amount_cents) filter(where e.status='actual') as actual
 from expenses e where e.recurring_cost_id=r.id) l on true
 where r.business_id=p_business_id and r.active_from<=b.end_date
 and (r.active_to is null or r.active_to>=b.start_date)
), bill_totals as (
 select r.category_code,count(*) as n,
 sum(greatest(0,r.monthly_equivalent-r.linked_recorded)) as remaining,
 jsonb_agg(jsonb_build_object('kind','recurring','id',r.id,'label',r.label,
 'amountCents',r.amount_cents,'frequency',r.frequency,'source',r.source,'dueDay',r.due_day,
 'activeFrom',r.active_from,'activeTo',r.active_to,'isEstimate',r.is_estimate,
 'monthlyEquivalentCents',r.monthly_equivalent,'linkedRecordedCents',r.linked_recorded,
 'linkedActualCents',r.linked_actual,'linkedEstimatedCents',r.linked_recorded-r.linked_actual,
 'remainingForecastCents',greatest(0,r.monthly_equivalent-r.linked_recorded),
 'costBehaviour','unknown') order by r.id) as evidence
 from obligations r group by r.category_code
), expense_totals as (
 select e.category_code,count(*) as n,sum(e.amount_cents) as recorded,
 coalesce(sum(e.amount_cents) filter(where e.status='actual'),0) as actual,
 coalesce(sum(greatest(0,e.amount_cents)) filter(where e.recurring_cost_id is null),0) as unlinked,
 coalesce(sum(e.amount_cents) filter(where e.status='actual' and e.spent_on=p_as_of),0) as actual_today,
 bool_or(e.status<>'actual') as estimated,
 jsonb_agg(jsonb_build_object('kind','expense','id',e.id,
 'label',coalesce(e.custom_label,e.vendor,e.category_code),'amountCents',e.amount_cents,
 'date',e.spent_on,'status',e.status,'source',e.source,'recurringCostId',e.recurring_cost_id,
 'costBehaviour','unknown') order by e.id) as evidence
 from expenses e group by e.category_code
), defaults(code,label,position,regular) as (
 values ('rent','Rent',1,true),('utilities_power','Electricity & gas',2,true),
 ('water','Water',3,true),('internet','Internet & phone',4,true),('insurance','Insurance',5,true),
 ('loan','Loan payment',6,true),('software','Software',7,true),('supplies','Store runs & supplies',8,true),
 ('repairs','Repairs',9,false),('other','Other',10,false)
), codes as (
 select code from defaults union select p.category_code from prior p
 union select e.category_code from expenses e union select r.category_code from obligations r
 union select o.bucket_code from public.recovery_order o where o.business_id=p_business_id
), facts as (
 select c.code,coalesce(d.label,c.code) as label,coalesce(e.n,0) as receipts,
 coalesce(r.n,0) as commitments,coalesce(e.recorded,0) as recorded,
 coalesce(e.actual,0) as actual,coalesce(r.remaining,0) as remaining,
 least(coalesce(r.remaining,0),coalesce(e.unlinked,0)) as overlap,
 coalesce(e.actual_today,0) as actual_today,coalesce(e.estimated,false) as receipt_estimate,
 coalesce(e.evidence,'[]'::jsonb)||coalesce(r.evidence,'[]'::jsonb) as evidence,
 (coalesce(r.n,0)>0 or (coalesce(d.regular,false) and p.category_code is not null)) as expected,
 o.position as owner_position,d.position as default_position
 from codes c cross join bounds b left join defaults d on d.code=c.code
 left join expense_totals e on e.category_code=c.code left join bill_totals r on r.category_code=c.code
 left join prior p on p.category_code=c.code
 left join public.recovery_order o on o.business_id=p_business_id and o.bucket_code=c.code
 where c.code<>'ingredients'
)
select f.code,jsonb_build_object('categoryCode',f.code,'label',f.label,
 'amountCents',f.recorded+f.remaining-f.overlap,'recordedExpenseCents',f.recorded,
 'recordedActualCents',f.actual,'recordedEstimatedCents',f.recorded-f.actual,
 'recurringEstimateCents',f.remaining-f.overlap,'expenseEvidence',f.evidence,
 'possibleAdditionalForecastCents',f.overlap,'forecastUpperCents',f.recorded+f.remaining,
 'forecastOverlapUncertain',f.overlap>0,'amountSource',case when f.receipts>0 then
  case when f.remaining>0 then 'mixed' else 'recorded_expense' end
  when f.commitments>0 then 'recurring' else 'missing' end,
 'actualTodayCents',f.actual_today,'isEstimate',f.receipt_estimate or f.remaining>0,
 'isMissing',f.receipts=0 and f.commitments=0 and f.expected,
 'isExpected',f.expected or f.receipts>0,
 'dailyAllocatedCents',(
   select jsonb_agg(jsonb_build_object('date',p.day::date,'amountCents',
     coalesce((select sum(e.amount_cents) from expenses e
       where e.category_code=f.code and e.spent_on=p.day::date),0)
     + case when f.remaining>0 then
       (f.remaining-f.overlap)/f.remaining/(b.end_date-b.start_date+1)
       * coalesce((select sum(greatest(0,r.monthly_equivalent-r.linked_recorded))
          from obligations r where r.category_code=f.code and r.active_from<=p.day::date
          and (r.active_to is null or r.active_to>=p.day::date)),0)
       else 0 end) order by p.day)
   from bounds b cross join lateral generate_series(b.start_date::timestamp,b.end_date::timestamp,interval '1 day') p(day)
 ))
from facts f order by f.owner_position nulls last,f.default_position nulls last,f.code
$$;
revoke all on function public.running_cost_lines_for_month(uuid,date,date) from public,anon;
grant execute on function public.running_cost_lines_for_month(uuid,date,date) to authenticated,service_role;
comment on function public.running_cost_lines_for_month(uuid,date,date) is 'Canonical monthly running costs, recorded expense evidence and conservative obligation forecasts, using the requested café calendar month and as-of date. Never treats a category match as settlement.';

-- Discoverable SQL view for all observed months and months covered by commitments.
-- Explicit as-of-date reads use the very same function, not a second calculation.
create view public.cv_running_cost_months with (security_invoker=true) as
with cafes as (
 select b.id as business_id,(now() at time zone b.timezone)::date as today
 from public.businesses b
), months as (
 select c.business_id,c.today,date_trunc('month',c.today)::date as business_date from cafes c
 union select c.business_id,c.today,(date_trunc('month',c.today)-interval '1 month')::date from cafes c
 union select c.business_id,c.today,date_trunc('month',e.spent_on)::date
 from cafes c join public.cv_expenses e using(business_id) where e.spent_on<=c.today
 union select c.business_id,c.today,(date_trunc('month',e.spent_on)+interval '1 month')::date
 from cafes c join public.cv_expenses e using(business_id)
 where e.status='actual' and e.spent_on<date_trunc('month',c.today)::date
 union select c.business_id,c.today,date_trunc('month',d.business_date)::date
 from cafes c join public.cv_sales_days d using(business_id) where d.business_date<=c.today
 union select c.business_id,c.today,g.month::date from cafes c
 join public.cv_bills r using(business_id)
 cross join lateral generate_series(date_trunc('month',r.active_from),
  date_trunc('month',least(coalesce(r.active_to,c.today),c.today)),interval '1 month') g(month)
)
select m.business_id,'app'::text as source,'running-cost:'||m.business_date||':'||r.category_code as source_ref,
 case when (r.data->>'isMissing')::boolean then 'open' when (r.data->>'isEstimate')::boolean then 'estimated'
 when (r.data->>'isExpected')::boolean then 'actual' else 'open' end::text as status,
 m.business_date, r.category_code,(r.data->>'amountCents')::bigint as amount_cents,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date) as as_of_date,r.data
from months m cross join lateral public.running_cost_lines_for_month(m.business_id,m.business_date,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date)) r;
revoke all on public.cv_running_cost_months from public,anon,authenticated;
grant select on public.cv_running_cost_months to authenticated,service_role;
comment on view public.cv_running_cost_months is 'One café/month/category, with amount in cents including separately labeled unpaid forecast and dated receipt evidence; as_of_date identifies the cutoff. Do not treat estimated forecasts as paid bills.';

-- Staff screen's persisted clock records deliberately include schedule predictions;
-- cv_labor_entries remains actual provider labor (do not add these two views).
-- A single database statement fixes the clock for all per-entry and day totals.
create view public.cv_staff_clock_entries with (security_invoker=true) as
with entries as (
 select t.business_id,coalesce(t.source_provider,'app')::text as source,'staff-clock:'||t.id as source_ref,
 case when t.source_type='owner_schedule' then 'estimated'
      when t.clock_out is null or t.clock_out>now() then 'provisional'
      when t.hourly_wage_cents is null then 'open' else 'actual' end::text as status,
 (t.clock_in at time zone b.timezone)::date as business_date,
 t.id,t.employee_id,t.schedule_id,t.source_type,t.source_provider,t.clock_in,t.clock_out,
 t.hourly_wage_cents,t.breaks,t.provider_regular_hours,t.provider_overtime_hours,
 e.display_name as employee_name,e.role as employee_role,now() as as_of,
 b.payroll_tax_rate,
 case when t.hourly_wage_cents is null then null
 when t.clock_out is not null and (t.provider_regular_hours is not null or t.provider_overtime_hours is not null)
  and coalesce(t.provider_regular_hours,0)>=0 and coalesce(t.provider_overtime_hours,0)>=0
 then (coalesce(t.provider_regular_hours,0)+coalesce(t.provider_overtime_hours,0)*1.5)*t.hourly_wage_cents
 else greatest(0,extract(epoch from least(coalesce(t.clock_out,now()),now())-t.clock_in)
   - coalesce((select sum(greatest(0,extract(epoch from
      (br->>'end')::timestamptz-(br->>'start')::timestamptz)))
     from jsonb_array_elements(t.breaks) br where not coalesce((br->>'paid')::boolean,false)),0))
   /3600*t.hourly_wage_cents end::numeric as wages_cents
 from public.timecards t join public.businesses b on b.id=t.business_id
 left join public.employees e on e.id=t.employee_id and e.business_id=t.business_id
)
select business_id,source,source_ref,status,business_date,id,employee_id,schedule_id,source_type,source_provider,
 clock_in,clock_out,hourly_wage_cents,breaks,provider_regular_hours,provider_overtime_hours,
 employee_name,employee_role,as_of,wages_cents,wages_cents*(1+payroll_tax_rate) as loaded_cost_cents,
 hourly_wage_cents*(1+payroll_tax_rate) as loaded_hourly_cents,
 case when count(*) filter(where wages_cents is null) over(partition by business_id,business_date)>0 then null
 else sum(wages_cents*(1+payroll_tax_rate)) over(partition by business_id,business_date) end as day_loaded_cost_cents
from entries;
revoke all on public.cv_staff_clock_entries from public,anon,authenticated;
grant select on public.cv_staff_clock_entries to authenticated,service_role;
comment on view public.cv_staff_clock_entries is 'Stored Staff-screen clock records, including explicitly estimated owner schedules. Wage amounts use saved provider hours when available, else elapsed time minus unpaid breaks at as_of; loaded amounts include business payroll tax rate. day_loaded_cost_cents repeats the whole café/day total per entry; never sum it across entries. Unknown wage in any entry makes the day total null. Not additive with cv_labor_entries.';

-- Fractional-cent day allocation is the source for arbitrary period totals.
-- Sum before rounding, and do not treat projected days as payments.
create view public.cv_running_cost_days with (security_invoker=true) as
 select m.business_id,m.source,'running-cost-day:'||(d.value->>'date')||':'||m.category_code as source_ref,
 m.status,(d.value->>'date')::date as business_date,m.category_code,
 (d.value->>'amountCents')::numeric as amount_cents,m.as_of_date
 from public.cv_running_cost_months m cross join lateral jsonb_array_elements(m.data->'dailyAllocatedCents') d;
revoke all on public.cv_running_cost_days from public,anon,authenticated;
grant select on public.cv_running_cost_days to authenticated,service_role;
comment on view public.cv_running_cost_days is 'Canonical period allocation of recorded receipts on their dates plus unpaid forecast only on active commitment days. Amounts may be fractional cents; sum then round. as_of_date is the receipt evidence cutoff, future day allocations are forecasts. Not additive with cv_running_cost_months.';
 then (v->>'fixedFeeCents')::numeric end as fixed,
       case when v->>'salesMixBps' ~ '^[0-9]+(\.[0-9]+)? is 'One saved day per café and business date. Screen and Supervisor daily sales, ingredient cost, wages, payroll tax, fees and voids; data includes independent sales_data_status, labor_wage_status, staff_tax_status/source and card_fees_status. Not provisional intraday sales.';
comment on column public.cv_sales_days.data is 'Saved daily fact amounts in integer cents and counts, with independent source and completeness statuses. Unknown wages and taxes remain null. recorded_contribution_cents is recorded sales minus ingredients, saved fees and loaded wages, before operating bills; null when labor is incomplete.';

-- Existing recurring commitments; retain every existing key and expose the active dates and due day.
create or replace view public.cv_bills
 (business_id,source,source_ref,status,business_date,data,id,category_code,label,amount_cents,frequency,is_estimate,active_from,active_to,due_day) with (security_invoker=true) as
 select c.business_id,coalesce(nullif(c.source,''),'app')::text,
 'bill:'||c.id::text,case when c.is_estimate then 'estimated' else 'actual' end::text,
 null::date,jsonb_build_object('id',c.id,'amount_cents',c.amount_cents,
 'frequency',c.frequency,'category',c.category_code,'name',c.label,'is_estimate',c.is_estimate,
 'category_code',c.category_code,'label',c.label,'active_from',c.active_from,
 'active_to',c.active_to,'due_day',c.due_day),
 c.id,c.category_code,c.label,c.amount_cents,c.frequency,c.is_estimate,c.active_from,c.active_to,c.due_day
 from public.recurring_costs c;
comment on view public.cv_bills is 'Recurring obligations, one row per saved commitment, with active dates, amount, frequency and estimate status. Actual expense receipts are in cv_expenses.';

-- Expenses and bills have different grains; never union receipts with obligations.
create view public.cv_expenses with (security_invoker=true) as
 select e.business_id,e.source,'expense:'||e.id::text as source_ref,e.status,
 e.spent_on as business_date,e.id,e.spent_on,e.amount_cents,e.category_code,
 e.recurring_cost_id,e.custom_label,e.vendor
 from public.expenses e;
revoke all on public.cv_expenses from public,anon,authenticated;
grant select on public.cv_expenses to authenticated,service_role;
comment on view public.cv_expenses is 'One saved expense receipt per source_ref, with business date, amount in cents, status and recurring commitment linkage. Attachment paths and private storage metadata are excluded.';

-- The latest provisional reading has a different grain than saved closed days.
-- Do not add it to cv_sales_days or sum it alongside finalized days.
create view public.cv_sales_live with (security_invoker=true) as
 select t.business_id,'toast'::text as source,'live:'||t.business_date::text as source_ref,
 'provisional'::text as status,t.business_date,t.net_sales_cents,t.orders as orders_count,
 t.read_at,t.reading
 from public.toast_today_live t;
revoke all on public.cv_sales_live from public,anon,authenticated;
grant select on public.cv_sales_live to authenticated,service_role;
comment on view public.cv_sales_live is 'Latest provisional Toast café sales snapshot, one row per café. Use only for the matching business date before closeout; never add to finalized cv_sales_days. read_at is the source timestamp.';

-- Preserve order provenance needed by the payment-fee eligibility checks.
create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,source_channel,guest_count,data,net_sales_cents)
 with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text,
 'order:'||o.id::text,case when o.toast_excluded is true or o.superseded_by is not null then 'needs_match' else 'actual' end::text,
 o.business_date,o.id::text,o.dining_option,o.source_channel,o.guest_count::integer,
 jsonb_build_object('order_ref',o.id,'dining_option',o.dining_option,'source_channel',o.source_channel,
 'guest_count',o.guest_count,'toast_excluded',o.toast_excluded,'superseded',o.superseded_by is not null,
 'recorded_net_sales_cents',o.net_sales_cents,'pos_order_id',o.pos_order_id,
 'processing_fee_provider',o.processing_fee_provider),
 case when o.toast_excluded is true or o.superseded_by is not null then null::bigint else o.net_sales_cents end
 from public.orders o;

-- One item/day total from the canonical sold lines. UI and SQL share the same
-- actual-only grouping; no application-side per-line aggregation.
create view public.cv_item_sales_daily with (security_invoker=true) as
 select business_id,'item-day:'||business_date::text||':'||(data->>'menu_item_id') as source_ref,
 'actual'::text as status,business_date,(data->>'menu_item_id')::uuid as menu_item_id,
 sum(quantity) as quantity,sum(net_sales_cents) as net_sales_cents
 from public.cv_item_sales
 where status='actual' and data->>'menu_item_id' is not null
 group by business_id,business_date,(data->>'menu_item_id');
revoke all on public.cv_item_sales_daily from public,anon,authenticated;
grant select on public.cv_item_sales_daily to authenticated,service_role;
comment on view public.cv_item_sales_daily is 'Actual sold quantity and net sales in integer cents, grouped once per cafe, item and business date from cv_item_sales. No voided or review-only lines. Missing days are not zero.';

-- Item identity and quantity use the same operational canonical lines as SQL chat.
create or replace function public.menu_item_quantities_sold(p_business_id uuid,p_from date,p_to date)
 returns table(menu_item_id uuid,total_quantity numeric)
 language sql stable security invoker set search_path=public as $$
 select v.menu_item_id,sum(v.quantity)
 from public.cv_item_sales_daily v
 where v.business_id=p_business_id and v.business_date between p_from and p_to
 group by v.menu_item_id
 $$;

-- Preserve the existing item/review/version union and expose menu display fields.
create or replace view public.cv_menu
 (business_id,source,source_ref,status,business_date,data,id,name,base_name,size_label,price_cents,prep_seconds,category,menu_group,is_active,pos_item_id,catalog_source,catalog_last_synced_at,description,pos_visibility,pos_pricing_strategy) with (security_invoker=true) as
 select m.business_id,case when m.catalog_source='toast' then 'toast' else 'app' end::text,
 'item:'||m.id::text,'actual'::text,null::date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
 'category',m.category,'menu_group',m.menu_group,'is_active',m.is_active,'pos_item_id',m.pos_item_id,
 'base_name',m.base_name,'size_label',m.size_label,'prep_seconds',m.prep_seconds,
 'catalog_source',m.catalog_source,'catalog_last_synced_at',m.catalog_last_synced_at,
 'description',m.description,'pos_visibility',m.pos_visibility,'pos_pricing_strategy',m.pos_pricing_strategy),
 m.id,m.name,m.base_name,m.size_label,m.price_cents,m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,m.catalog_last_synced_at,m.description,m.pos_visibility,m.pos_pricing_strategy
 from public.menu_items m
 union all
 select r.business_id,'toast'::text,'review:'||r.review_type||':'||r.source_key,
 'needs_match'::text,null::date,jsonb_build_object('review_type',r.review_type,'source_key',r.source_key,'detail',r.detail),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.pos_import_reviews r where r.provider='toast' and r.review_type in ('catalog_item','menu_identity','item_identity')
 and r.status='needs_owner'
 union all
 select v.business_id,'toast'::text,
 'price-version:'||v.restaurant_guid::text||':'||v.kind||':'||v.provider_guid::text||':'||v.price_fingerprint,
 'actual'::text,null::date,jsonb_build_object('kind','price_version','provider_guid',v.provider_guid,
 'entity_kind',v.kind,'name',v.name,'category',v.category,'price_cents',v.price_cents,'observed_at',v.observed_at),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.toast_catalog_price_versions v;
comment on view public.cv_menu is 'Current and archived catalog rows have source_ref item:; price-version and needs_match review rows are separate, not additional sellable products. Null open prices remain unknown.';

-- One calculation of monthly running costs. Expense receipts remain dated evidence;
-- linked receipts reduce ONLY their obligation, and unlinked overlap is uncertain.
create function public.running_cost_lines_for_month(p_business_id uuid,p_month_start date,p_as_of date)
returns table(category_code text,data jsonb)
language sql stable security invoker set search_path=public as $$
with bounds as (
 select p_month_start as start_date,(p_month_start+interval '1 month - 1 day')::date as end_date
 where p_month_start=date_trunc('month',p_month_start)::date
 and p_as_of>=p_month_start and exists(select 1 from public.businesses where id=p_business_id)
), expenses as materialized (
 select e.* from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on between b.start_date and least(b.end_date,p_as_of)
), prior as (
 select distinct e.category_code from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on>=b.start_date-interval '1 month'
 and e.spent_on<b.start_date and e.status='actual'
), obligations as (
 select r.*,floor(case r.frequency when 'weekly' then r.amount_cents::numeric*52/12
   when 'quarterly' then r.amount_cents::numeric/3 when 'yearly' then r.amount_cents::numeric/12
   else r.amount_cents::numeric end+0.5)::bigint as monthly_equivalent,
 coalesce(l.recorded,0) as linked_recorded,coalesce(l.actual,0) as linked_actual
 from public.cv_bills r cross join bounds b
 left join lateral (select sum(e.amount_cents) as recorded,
 sum(e.amount_cents) filter(where e.status='actual') as actual
 from expenses e where e.recurring_cost_id=r.id) l on true
 where r.business_id=p_business_id and r.active_from<=b.end_date
 and (r.active_to is null or r.active_to>=b.start_date)
), bill_totals as (
 select r.category_code,count(*) as n,
 sum(greatest(0,r.monthly_equivalent-r.linked_recorded)) as remaining,
 jsonb_agg(jsonb_build_object('kind','recurring','id',r.id,'label',r.label,
 'amountCents',r.amount_cents,'frequency',r.frequency,'source',r.source,'dueDay',r.due_day,
 'activeFrom',r.active_from,'activeTo',r.active_to,'isEstimate',r.is_estimate,
 'monthlyEquivalentCents',r.monthly_equivalent,'linkedRecordedCents',r.linked_recorded,
 'linkedActualCents',r.linked_actual,'linkedEstimatedCents',r.linked_recorded-r.linked_actual,
 'remainingForecastCents',greatest(0,r.monthly_equivalent-r.linked_recorded),
 'costBehaviour','unknown') order by r.id) as evidence
 from obligations r group by r.category_code
), expense_totals as (
 select e.category_code,count(*) as n,sum(e.amount_cents) as recorded,
 coalesce(sum(e.amount_cents) filter(where e.status='actual'),0) as actual,
 coalesce(sum(greatest(0,e.amount_cents)) filter(where e.recurring_cost_id is null),0) as unlinked,
 coalesce(sum(e.amount_cents) filter(where e.status='actual' and e.spent_on=p_as_of),0) as actual_today,
 bool_or(e.status<>'actual') as estimated,
 jsonb_agg(jsonb_build_object('kind','expense','id',e.id,
 'label',coalesce(e.custom_label,e.vendor,e.category_code),'amountCents',e.amount_cents,
 'date',e.spent_on,'status',e.status,'source',e.source,'recurringCostId',e.recurring_cost_id,
 'costBehaviour','unknown') order by e.id) as evidence
 from expenses e group by e.category_code
), defaults(code,label,position,regular) as (
 values ('rent','Rent',1,true),('utilities_power','Electricity & gas',2,true),
 ('water','Water',3,true),('internet','Internet & phone',4,true),('insurance','Insurance',5,true),
 ('loan','Loan payment',6,true),('software','Software',7,true),('supplies','Store runs & supplies',8,true),
 ('repairs','Repairs',9,false),('other','Other',10,false)
), codes as (
 select code from defaults union select p.category_code from prior p
 union select e.category_code from expenses e union select r.category_code from obligations r
 union select o.bucket_code from public.recovery_order o where o.business_id=p_business_id
), facts as (
 select c.code,coalesce(d.label,c.code) as label,coalesce(e.n,0) as receipts,
 coalesce(r.n,0) as commitments,coalesce(e.recorded,0) as recorded,
 coalesce(e.actual,0) as actual,coalesce(r.remaining,0) as remaining,
 least(coalesce(r.remaining,0),coalesce(e.unlinked,0)) as overlap,
 coalesce(e.actual_today,0) as actual_today,coalesce(e.estimated,false) as receipt_estimate,
 coalesce(e.evidence,'[]'::jsonb)||coalesce(r.evidence,'[]'::jsonb) as evidence,
 (coalesce(r.n,0)>0 or (coalesce(d.regular,false) and p.category_code is not null)) as expected,
 o.position as owner_position,d.position as default_position
 from codes c cross join bounds b left join defaults d on d.code=c.code
 left join expense_totals e on e.category_code=c.code left join bill_totals r on r.category_code=c.code
 left join prior p on p.category_code=c.code
 left join public.recovery_order o on o.business_id=p_business_id and o.bucket_code=c.code
 where c.code<>'ingredients'
)
select f.code,jsonb_build_object('categoryCode',f.code,'label',f.label,
 'amountCents',f.recorded+f.remaining-f.overlap,'recordedExpenseCents',f.recorded,
 'recordedActualCents',f.actual,'recordedEstimatedCents',f.recorded-f.actual,
 'recurringEstimateCents',f.remaining-f.overlap,'expenseEvidence',f.evidence,
 'possibleAdditionalForecastCents',f.overlap,'forecastUpperCents',f.recorded+f.remaining,
 'forecastOverlapUncertain',f.overlap>0,'amountSource',case when f.receipts>0 then
  case when f.remaining>0 then 'mixed' else 'recorded_expense' end
  when f.commitments>0 then 'recurring' else 'missing' end,
 'actualTodayCents',f.actual_today,'isEstimate',f.receipt_estimate or f.remaining>0,
 'isMissing',f.receipts=0 and f.commitments=0 and f.expected,
 'isExpected',f.expected or f.receipts>0,
 'dailyAllocatedCents',(
   select jsonb_agg(jsonb_build_object('date',p.day::date,'amountCents',
     coalesce((select sum(e.amount_cents) from expenses e
       where e.category_code=f.code and e.spent_on=p.day::date),0)
     + case when f.remaining>0 then
       (f.remaining-f.overlap)/f.remaining/(b.end_date-b.start_date+1)
       * coalesce((select sum(greatest(0,r.monthly_equivalent-r.linked_recorded))
          from obligations r where r.category_code=f.code and r.active_from<=p.day::date
          and (r.active_to is null or r.active_to>=p.day::date)),0)
       else 0 end) order by p.day)
   from bounds b cross join lateral generate_series(b.start_date::timestamp,b.end_date::timestamp,interval '1 day') p(day)
 ))
from facts f order by f.owner_position nulls last,f.default_position nulls last,f.code
$$;
revoke all on function public.running_cost_lines_for_month(uuid,date,date) from public,anon;
grant execute on function public.running_cost_lines_for_month(uuid,date,date) to authenticated,service_role;
comment on function public.running_cost_lines_for_month(uuid,date,date) is 'Canonical monthly running costs, recorded expense evidence and conservative obligation forecasts, using the requested café calendar month and as-of date. Never treats a category match as settlement.';

-- Discoverable SQL view for all observed months and months covered by commitments.
-- Explicit as-of-date reads use the very same function, not a second calculation.
create view public.cv_running_cost_months with (security_invoker=true) as
with cafes as (
 select b.id as business_id,(now() at time zone b.timezone)::date as today
 from public.businesses b
), months as (
 select c.business_id,c.today,date_trunc('month',c.today)::date as business_date from cafes c
 union select c.business_id,c.today,(date_trunc('month',c.today)-interval '1 month')::date from cafes c
 union select c.business_id,c.today,date_trunc('month',e.spent_on)::date
 from cafes c join public.cv_expenses e using(business_id) where e.spent_on<=c.today
 union select c.business_id,c.today,(date_trunc('month',e.spent_on)+interval '1 month')::date
 from cafes c join public.cv_expenses e using(business_id)
 where e.status='actual' and e.spent_on<date_trunc('month',c.today)::date
 union select c.business_id,c.today,date_trunc('month',d.business_date)::date
 from cafes c join public.cv_sales_days d using(business_id) where d.business_date<=c.today
 union select c.business_id,c.today,g.month::date from cafes c
 join public.cv_bills r using(business_id)
 cross join lateral generate_series(date_trunc('month',r.active_from),
  date_trunc('month',least(coalesce(r.active_to,c.today),c.today)),interval '1 month') g(month)
)
select m.business_id,'app'::text as source,'running-cost:'||m.business_date||':'||r.category_code as source_ref,
 case when (r.data->>'isMissing')::boolean then 'open' when (r.data->>'isEstimate')::boolean then 'estimated'
 when (r.data->>'isExpected')::boolean then 'actual' else 'open' end::text as status,
 m.business_date, r.category_code,(r.data->>'amountCents')::bigint as amount_cents,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date) as as_of_date,r.data
from months m cross join lateral public.running_cost_lines_for_month(m.business_id,m.business_date,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date)) r;
revoke all on public.cv_running_cost_months from public,anon,authenticated;
grant select on public.cv_running_cost_months to authenticated,service_role;
comment on view public.cv_running_cost_months is 'One café/month/category, with amount in cents including separately labeled unpaid forecast and dated receipt evidence; as_of_date identifies the cutoff. Do not treat estimated forecasts as paid bills.';

-- Staff screen's persisted clock records deliberately include schedule predictions;
-- cv_labor_entries remains actual provider labor (do not add these two views).
-- A single database statement fixes the clock for all per-entry and day totals.
create view public.cv_staff_clock_entries with (security_invoker=true) as
with entries as (
 select t.business_id,coalesce(t.source_provider,'app')::text as source,'staff-clock:'||t.id as source_ref,
 case when t.source_type='owner_schedule' then 'estimated'
      when t.clock_out is null or t.clock_out>now() then 'provisional'
      when t.hourly_wage_cents is null then 'open' else 'actual' end::text as status,
 (t.clock_in at time zone b.timezone)::date as business_date,
 t.id,t.employee_id,t.schedule_id,t.source_type,t.source_provider,t.clock_in,t.clock_out,
 t.hourly_wage_cents,t.breaks,t.provider_regular_hours,t.provider_overtime_hours,
 e.display_name as employee_name,e.role as employee_role,now() as as_of,
 b.payroll_tax_rate,
 case when t.hourly_wage_cents is null then null
 when t.clock_out is not null and (t.provider_regular_hours is not null or t.provider_overtime_hours is not null)
  and coalesce(t.provider_regular_hours,0)>=0 and coalesce(t.provider_overtime_hours,0)>=0
 then (coalesce(t.provider_regular_hours,0)+coalesce(t.provider_overtime_hours,0)*1.5)*t.hourly_wage_cents
 else greatest(0,extract(epoch from least(coalesce(t.clock_out,now()),now())-t.clock_in)
   - coalesce((select sum(greatest(0,extract(epoch from
      (br->>'end')::timestamptz-(br->>'start')::timestamptz)))
     from jsonb_array_elements(t.breaks) br where not coalesce((br->>'paid')::boolean,false)),0))
   /3600*t.hourly_wage_cents end::numeric as wages_cents
 from public.timecards t join public.businesses b on b.id=t.business_id
 left join public.employees e on e.id=t.employee_id and e.business_id=t.business_id
)
select business_id,source,source_ref,status,business_date,id,employee_id,schedule_id,source_type,source_provider,
 clock_in,clock_out,hourly_wage_cents,breaks,provider_regular_hours,provider_overtime_hours,
 employee_name,employee_role,as_of,wages_cents,wages_cents*(1+payroll_tax_rate) as loaded_cost_cents,
 hourly_wage_cents*(1+payroll_tax_rate) as loaded_hourly_cents,
 case when count(*) filter(where wages_cents is null) over(partition by business_id,business_date)>0 then null
 else sum(wages_cents*(1+payroll_tax_rate)) over(partition by business_id,business_date) end as day_loaded_cost_cents
from entries;
revoke all on public.cv_staff_clock_entries from public,anon,authenticated;
grant select on public.cv_staff_clock_entries to authenticated,service_role;
comment on view public.cv_staff_clock_entries is 'Stored Staff-screen clock records, including explicitly estimated owner schedules. Wage amounts use saved provider hours when available, else elapsed time minus unpaid breaks at as_of; loaded amounts include business payroll tax rate. day_loaded_cost_cents repeats the whole café/day total per entry; never sum it across entries. Unknown wage in any entry makes the day total null. Not additive with cv_labor_entries.';

-- Fractional-cent day allocation is the source for arbitrary period totals.
-- Sum before rounding, and do not treat projected days as payments.
create view public.cv_running_cost_days with (security_invoker=true) as
 select m.business_id,m.source,'running-cost-day:'||(d.value->>'date')||':'||m.category_code as source_ref,
 m.status,(d.value->>'date')::date as business_date,m.category_code,
 (d.value->>'amountCents')::numeric as amount_cents,m.as_of_date
 from public.cv_running_cost_months m cross join lateral jsonb_array_elements(m.data->'dailyAllocatedCents') d;
revoke all on public.cv_running_cost_days from public,anon,authenticated;
grant select on public.cv_running_cost_days to authenticated,service_role;
comment on view public.cv_running_cost_days is 'Canonical period allocation of recorded receipts on their dates plus unpaid forecast only on active commitment days. Amounts may be fractional cents; sum then round. as_of_date is the receipt evidence cutoff, future day allocations are forecasts. Not additive with cv_running_cost_months.';
 then (v->>'salesMixBps')::numeric end as sales_mix,
       case when v->>'transactionMixBps' ~ '^[0-9]+(\.[0-9]+)? is 'One saved day per café and business date. Screen and Supervisor daily sales, ingredient cost, wages, payroll tax, fees and voids; data includes independent sales_data_status, labor_wage_status, staff_tax_status/source and card_fees_status. Not provisional intraday sales.';
comment on column public.cv_sales_days.data is 'Saved daily fact amounts in integer cents and counts, with independent source and completeness statuses. Unknown wages and taxes remain null. recorded_contribution_cents is recorded sales minus ingredients, saved fees and loaded wages, before operating bills; null when labor is incomplete.';

-- Existing recurring commitments; retain every existing key and expose the active dates and due day.
create or replace view public.cv_bills
 (business_id,source,source_ref,status,business_date,data,id,category_code,label,amount_cents,frequency,is_estimate,active_from,active_to,due_day) with (security_invoker=true) as
 select c.business_id,coalesce(nullif(c.source,''),'app')::text,
 'bill:'||c.id::text,case when c.is_estimate then 'estimated' else 'actual' end::text,
 null::date,jsonb_build_object('id',c.id,'amount_cents',c.amount_cents,
 'frequency',c.frequency,'category',c.category_code,'name',c.label,'is_estimate',c.is_estimate,
 'category_code',c.category_code,'label',c.label,'active_from',c.active_from,
 'active_to',c.active_to,'due_day',c.due_day),
 c.id,c.category_code,c.label,c.amount_cents,c.frequency,c.is_estimate,c.active_from,c.active_to,c.due_day
 from public.recurring_costs c;
comment on view public.cv_bills is 'Recurring obligations, one row per saved commitment, with active dates, amount, frequency and estimate status. Actual expense receipts are in cv_expenses.';

-- Expenses and bills have different grains; never union receipts with obligations.
create view public.cv_expenses with (security_invoker=true) as
 select e.business_id,e.source,'expense:'||e.id::text as source_ref,e.status,
 e.spent_on as business_date,e.id,e.spent_on,e.amount_cents,e.category_code,
 e.recurring_cost_id,e.custom_label,e.vendor
 from public.expenses e;
revoke all on public.cv_expenses from public,anon,authenticated;
grant select on public.cv_expenses to authenticated,service_role;
comment on view public.cv_expenses is 'One saved expense receipt per source_ref, with business date, amount in cents, status and recurring commitment linkage. Attachment paths and private storage metadata are excluded.';

-- The latest provisional reading has a different grain than saved closed days.
-- Do not add it to cv_sales_days or sum it alongside finalized days.
create view public.cv_sales_live with (security_invoker=true) as
 select t.business_id,'toast'::text as source,'live:'||t.business_date::text as source_ref,
 'provisional'::text as status,t.business_date,t.net_sales_cents,t.orders as orders_count,
 t.read_at,t.reading
 from public.toast_today_live t;
revoke all on public.cv_sales_live from public,anon,authenticated;
grant select on public.cv_sales_live to authenticated,service_role;
comment on view public.cv_sales_live is 'Latest provisional Toast café sales snapshot, one row per café. Use only for the matching business date before closeout; never add to finalized cv_sales_days. read_at is the source timestamp.';

-- Preserve order provenance needed by the payment-fee eligibility checks.
create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,source_channel,guest_count,data,net_sales_cents)
 with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text,
 'order:'||o.id::text,case when o.toast_excluded is true or o.superseded_by is not null then 'needs_match' else 'actual' end::text,
 o.business_date,o.id::text,o.dining_option,o.source_channel,o.guest_count::integer,
 jsonb_build_object('order_ref',o.id,'dining_option',o.dining_option,'source_channel',o.source_channel,
 'guest_count',o.guest_count,'toast_excluded',o.toast_excluded,'superseded',o.superseded_by is not null,
 'recorded_net_sales_cents',o.net_sales_cents,'pos_order_id',o.pos_order_id,
 'processing_fee_provider',o.processing_fee_provider),
 case when o.toast_excluded is true or o.superseded_by is not null then null::bigint else o.net_sales_cents end
 from public.orders o;

-- One item/day total from the canonical sold lines. UI and SQL share the same
-- actual-only grouping; no application-side per-line aggregation.
create view public.cv_item_sales_daily with (security_invoker=true) as
 select business_id,'item-day:'||business_date::text||':'||(data->>'menu_item_id') as source_ref,
 'actual'::text as status,business_date,(data->>'menu_item_id')::uuid as menu_item_id,
 sum(quantity) as quantity,sum(net_sales_cents) as net_sales_cents
 from public.cv_item_sales
 where status='actual' and data->>'menu_item_id' is not null
 group by business_id,business_date,(data->>'menu_item_id');
revoke all on public.cv_item_sales_daily from public,anon,authenticated;
grant select on public.cv_item_sales_daily to authenticated,service_role;
comment on view public.cv_item_sales_daily is 'Actual sold quantity and net sales in integer cents, grouped once per cafe, item and business date from cv_item_sales. No voided or review-only lines. Missing days are not zero.';

-- Item identity and quantity use the same operational canonical lines as SQL chat.
create or replace function public.menu_item_quantities_sold(p_business_id uuid,p_from date,p_to date)
 returns table(menu_item_id uuid,total_quantity numeric)
 language sql stable security invoker set search_path=public as $$
 select v.menu_item_id,sum(v.quantity)
 from public.cv_item_sales_daily v
 where v.business_id=p_business_id and v.business_date between p_from and p_to
 group by v.menu_item_id
 $$;

-- Preserve the existing item/review/version union and expose menu display fields.
create or replace view public.cv_menu
 (business_id,source,source_ref,status,business_date,data,id,name,base_name,size_label,price_cents,prep_seconds,category,menu_group,is_active,pos_item_id,catalog_source,catalog_last_synced_at,description,pos_visibility,pos_pricing_strategy) with (security_invoker=true) as
 select m.business_id,case when m.catalog_source='toast' then 'toast' else 'app' end::text,
 'item:'||m.id::text,'actual'::text,null::date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
 'category',m.category,'menu_group',m.menu_group,'is_active',m.is_active,'pos_item_id',m.pos_item_id,
 'base_name',m.base_name,'size_label',m.size_label,'prep_seconds',m.prep_seconds,
 'catalog_source',m.catalog_source,'catalog_last_synced_at',m.catalog_last_synced_at,
 'description',m.description,'pos_visibility',m.pos_visibility,'pos_pricing_strategy',m.pos_pricing_strategy),
 m.id,m.name,m.base_name,m.size_label,m.price_cents,m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,m.catalog_last_synced_at,m.description,m.pos_visibility,m.pos_pricing_strategy
 from public.menu_items m
 union all
 select r.business_id,'toast'::text,'review:'||r.review_type||':'||r.source_key,
 'needs_match'::text,null::date,jsonb_build_object('review_type',r.review_type,'source_key',r.source_key,'detail',r.detail),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.pos_import_reviews r where r.provider='toast' and r.review_type in ('catalog_item','menu_identity','item_identity')
 and r.status='needs_owner'
 union all
 select v.business_id,'toast'::text,
 'price-version:'||v.restaurant_guid::text||':'||v.kind||':'||v.provider_guid::text||':'||v.price_fingerprint,
 'actual'::text,null::date,jsonb_build_object('kind','price_version','provider_guid',v.provider_guid,
 'entity_kind',v.kind,'name',v.name,'category',v.category,'price_cents',v.price_cents,'observed_at',v.observed_at),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.toast_catalog_price_versions v;
comment on view public.cv_menu is 'Current and archived catalog rows have source_ref item:; price-version and needs_match review rows are separate, not additional sellable products. Null open prices remain unknown.';

-- One calculation of monthly running costs. Expense receipts remain dated evidence;
-- linked receipts reduce ONLY their obligation, and unlinked overlap is uncertain.
create function public.running_cost_lines_for_month(p_business_id uuid,p_month_start date,p_as_of date)
returns table(category_code text,data jsonb)
language sql stable security invoker set search_path=public as $$
with bounds as (
 select p_month_start as start_date,(p_month_start+interval '1 month - 1 day')::date as end_date
 where p_month_start=date_trunc('month',p_month_start)::date
 and p_as_of>=p_month_start and exists(select 1 from public.businesses where id=p_business_id)
), expenses as materialized (
 select e.* from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on between b.start_date and least(b.end_date,p_as_of)
), prior as (
 select distinct e.category_code from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on>=b.start_date-interval '1 month'
 and e.spent_on<b.start_date and e.status='actual'
), obligations as (
 select r.*,floor(case r.frequency when 'weekly' then r.amount_cents::numeric*52/12
   when 'quarterly' then r.amount_cents::numeric/3 when 'yearly' then r.amount_cents::numeric/12
   else r.amount_cents::numeric end+0.5)::bigint as monthly_equivalent,
 coalesce(l.recorded,0) as linked_recorded,coalesce(l.actual,0) as linked_actual
 from public.cv_bills r cross join bounds b
 left join lateral (select sum(e.amount_cents) as recorded,
 sum(e.amount_cents) filter(where e.status='actual') as actual
 from expenses e where e.recurring_cost_id=r.id) l on true
 where r.business_id=p_business_id and r.active_from<=b.end_date
 and (r.active_to is null or r.active_to>=b.start_date)
), bill_totals as (
 select r.category_code,count(*) as n,
 sum(greatest(0,r.monthly_equivalent-r.linked_recorded)) as remaining,
 jsonb_agg(jsonb_build_object('kind','recurring','id',r.id,'label',r.label,
 'amountCents',r.amount_cents,'frequency',r.frequency,'source',r.source,'dueDay',r.due_day,
 'activeFrom',r.active_from,'activeTo',r.active_to,'isEstimate',r.is_estimate,
 'monthlyEquivalentCents',r.monthly_equivalent,'linkedRecordedCents',r.linked_recorded,
 'linkedActualCents',r.linked_actual,'linkedEstimatedCents',r.linked_recorded-r.linked_actual,
 'remainingForecastCents',greatest(0,r.monthly_equivalent-r.linked_recorded),
 'costBehaviour','unknown') order by r.id) as evidence
 from obligations r group by r.category_code
), expense_totals as (
 select e.category_code,count(*) as n,sum(e.amount_cents) as recorded,
 coalesce(sum(e.amount_cents) filter(where e.status='actual'),0) as actual,
 coalesce(sum(greatest(0,e.amount_cents)) filter(where e.recurring_cost_id is null),0) as unlinked,
 coalesce(sum(e.amount_cents) filter(where e.status='actual' and e.spent_on=p_as_of),0) as actual_today,
 bool_or(e.status<>'actual') as estimated,
 jsonb_agg(jsonb_build_object('kind','expense','id',e.id,
 'label',coalesce(e.custom_label,e.vendor,e.category_code),'amountCents',e.amount_cents,
 'date',e.spent_on,'status',e.status,'source',e.source,'recurringCostId',e.recurring_cost_id,
 'costBehaviour','unknown') order by e.id) as evidence
 from expenses e group by e.category_code
), defaults(code,label,position,regular) as (
 values ('rent','Rent',1,true),('utilities_power','Electricity & gas',2,true),
 ('water','Water',3,true),('internet','Internet & phone',4,true),('insurance','Insurance',5,true),
 ('loan','Loan payment',6,true),('software','Software',7,true),('supplies','Store runs & supplies',8,true),
 ('repairs','Repairs',9,false),('other','Other',10,false)
), codes as (
 select code from defaults union select p.category_code from prior p
 union select e.category_code from expenses e union select r.category_code from obligations r
 union select o.bucket_code from public.recovery_order o where o.business_id=p_business_id
), facts as (
 select c.code,coalesce(d.label,c.code) as label,coalesce(e.n,0) as receipts,
 coalesce(r.n,0) as commitments,coalesce(e.recorded,0) as recorded,
 coalesce(e.actual,0) as actual,coalesce(r.remaining,0) as remaining,
 least(coalesce(r.remaining,0),coalesce(e.unlinked,0)) as overlap,
 coalesce(e.actual_today,0) as actual_today,coalesce(e.estimated,false) as receipt_estimate,
 coalesce(e.evidence,'[]'::jsonb)||coalesce(r.evidence,'[]'::jsonb) as evidence,
 (coalesce(r.n,0)>0 or (coalesce(d.regular,false) and p.category_code is not null)) as expected,
 o.position as owner_position,d.position as default_position
 from codes c cross join bounds b left join defaults d on d.code=c.code
 left join expense_totals e on e.category_code=c.code left join bill_totals r on r.category_code=c.code
 left join prior p on p.category_code=c.code
 left join public.recovery_order o on o.business_id=p_business_id and o.bucket_code=c.code
 where c.code<>'ingredients'
)
select f.code,jsonb_build_object('categoryCode',f.code,'label',f.label,
 'amountCents',f.recorded+f.remaining-f.overlap,'recordedExpenseCents',f.recorded,
 'recordedActualCents',f.actual,'recordedEstimatedCents',f.recorded-f.actual,
 'recurringEstimateCents',f.remaining-f.overlap,'expenseEvidence',f.evidence,
 'possibleAdditionalForecastCents',f.overlap,'forecastUpperCents',f.recorded+f.remaining,
 'forecastOverlapUncertain',f.overlap>0,'amountSource',case when f.receipts>0 then
  case when f.remaining>0 then 'mixed' else 'recorded_expense' end
  when f.commitments>0 then 'recurring' else 'missing' end,
 'actualTodayCents',f.actual_today,'isEstimate',f.receipt_estimate or f.remaining>0,
 'isMissing',f.receipts=0 and f.commitments=0 and f.expected,
 'isExpected',f.expected or f.receipts>0,
 'dailyAllocatedCents',(
   select jsonb_agg(jsonb_build_object('date',p.day::date,'amountCents',
     coalesce((select sum(e.amount_cents) from expenses e
       where e.category_code=f.code and e.spent_on=p.day::date),0)
     + case when f.remaining>0 then
       (f.remaining-f.overlap)/f.remaining/(b.end_date-b.start_date+1)
       * coalesce((select sum(greatest(0,r.monthly_equivalent-r.linked_recorded))
          from obligations r where r.category_code=f.code and r.active_from<=p.day::date
          and (r.active_to is null or r.active_to>=p.day::date)),0)
       else 0 end) order by p.day)
   from bounds b cross join lateral generate_series(b.start_date::timestamp,b.end_date::timestamp,interval '1 day') p(day)
 ))
from facts f order by f.owner_position nulls last,f.default_position nulls last,f.code
$$;
revoke all on function public.running_cost_lines_for_month(uuid,date,date) from public,anon;
grant execute on function public.running_cost_lines_for_month(uuid,date,date) to authenticated,service_role;
comment on function public.running_cost_lines_for_month(uuid,date,date) is 'Canonical monthly running costs, recorded expense evidence and conservative obligation forecasts, using the requested café calendar month and as-of date. Never treats a category match as settlement.';

-- Discoverable SQL view for all observed months and months covered by commitments.
-- Explicit as-of-date reads use the very same function, not a second calculation.
create view public.cv_running_cost_months with (security_invoker=true) as
with cafes as (
 select b.id as business_id,(now() at time zone b.timezone)::date as today
 from public.businesses b
), months as (
 select c.business_id,c.today,date_trunc('month',c.today)::date as business_date from cafes c
 union select c.business_id,c.today,(date_trunc('month',c.today)-interval '1 month')::date from cafes c
 union select c.business_id,c.today,date_trunc('month',e.spent_on)::date
 from cafes c join public.cv_expenses e using(business_id) where e.spent_on<=c.today
 union select c.business_id,c.today,(date_trunc('month',e.spent_on)+interval '1 month')::date
 from cafes c join public.cv_expenses e using(business_id)
 where e.status='actual' and e.spent_on<date_trunc('month',c.today)::date
 union select c.business_id,c.today,date_trunc('month',d.business_date)::date
 from cafes c join public.cv_sales_days d using(business_id) where d.business_date<=c.today
 union select c.business_id,c.today,g.month::date from cafes c
 join public.cv_bills r using(business_id)
 cross join lateral generate_series(date_trunc('month',r.active_from),
  date_trunc('month',least(coalesce(r.active_to,c.today),c.today)),interval '1 month') g(month)
)
select m.business_id,'app'::text as source,'running-cost:'||m.business_date||':'||r.category_code as source_ref,
 case when (r.data->>'isMissing')::boolean then 'open' when (r.data->>'isEstimate')::boolean then 'estimated'
 when (r.data->>'isExpected')::boolean then 'actual' else 'open' end::text as status,
 m.business_date, r.category_code,(r.data->>'amountCents')::bigint as amount_cents,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date) as as_of_date,r.data
from months m cross join lateral public.running_cost_lines_for_month(m.business_id,m.business_date,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date)) r;
revoke all on public.cv_running_cost_months from public,anon,authenticated;
grant select on public.cv_running_cost_months to authenticated,service_role;
comment on view public.cv_running_cost_months is 'One café/month/category, with amount in cents including separately labeled unpaid forecast and dated receipt evidence; as_of_date identifies the cutoff. Do not treat estimated forecasts as paid bills.';

-- Staff screen's persisted clock records deliberately include schedule predictions;
-- cv_labor_entries remains actual provider labor (do not add these two views).
-- A single database statement fixes the clock for all per-entry and day totals.
create view public.cv_staff_clock_entries with (security_invoker=true) as
with entries as (
 select t.business_id,coalesce(t.source_provider,'app')::text as source,'staff-clock:'||t.id as source_ref,
 case when t.source_type='owner_schedule' then 'estimated'
      when t.clock_out is null or t.clock_out>now() then 'provisional'
      when t.hourly_wage_cents is null then 'open' else 'actual' end::text as status,
 (t.clock_in at time zone b.timezone)::date as business_date,
 t.id,t.employee_id,t.schedule_id,t.source_type,t.source_provider,t.clock_in,t.clock_out,
 t.hourly_wage_cents,t.breaks,t.provider_regular_hours,t.provider_overtime_hours,
 e.display_name as employee_name,e.role as employee_role,now() as as_of,
 b.payroll_tax_rate,
 case when t.hourly_wage_cents is null then null
 when t.clock_out is not null and (t.provider_regular_hours is not null or t.provider_overtime_hours is not null)
  and coalesce(t.provider_regular_hours,0)>=0 and coalesce(t.provider_overtime_hours,0)>=0
 then (coalesce(t.provider_regular_hours,0)+coalesce(t.provider_overtime_hours,0)*1.5)*t.hourly_wage_cents
 else greatest(0,extract(epoch from least(coalesce(t.clock_out,now()),now())-t.clock_in)
   - coalesce((select sum(greatest(0,extract(epoch from
      (br->>'end')::timestamptz-(br->>'start')::timestamptz)))
     from jsonb_array_elements(t.breaks) br where not coalesce((br->>'paid')::boolean,false)),0))
   /3600*t.hourly_wage_cents end::numeric as wages_cents
 from public.timecards t join public.businesses b on b.id=t.business_id
 left join public.employees e on e.id=t.employee_id and e.business_id=t.business_id
)
select business_id,source,source_ref,status,business_date,id,employee_id,schedule_id,source_type,source_provider,
 clock_in,clock_out,hourly_wage_cents,breaks,provider_regular_hours,provider_overtime_hours,
 employee_name,employee_role,as_of,wages_cents,wages_cents*(1+payroll_tax_rate) as loaded_cost_cents,
 hourly_wage_cents*(1+payroll_tax_rate) as loaded_hourly_cents,
 case when count(*) filter(where wages_cents is null) over(partition by business_id,business_date)>0 then null
 else sum(wages_cents*(1+payroll_tax_rate)) over(partition by business_id,business_date) end as day_loaded_cost_cents
from entries;
revoke all on public.cv_staff_clock_entries from public,anon,authenticated;
grant select on public.cv_staff_clock_entries to authenticated,service_role;
comment on view public.cv_staff_clock_entries is 'Stored Staff-screen clock records, including explicitly estimated owner schedules. Wage amounts use saved provider hours when available, else elapsed time minus unpaid breaks at as_of; loaded amounts include business payroll tax rate. day_loaded_cost_cents repeats the whole café/day total per entry; never sum it across entries. Unknown wage in any entry makes the day total null. Not additive with cv_labor_entries.';

-- Fractional-cent day allocation is the source for arbitrary period totals.
-- Sum before rounding, and do not treat projected days as payments.
create view public.cv_running_cost_days with (security_invoker=true) as
 select m.business_id,m.source,'running-cost-day:'||(d.value->>'date')||':'||m.category_code as source_ref,
 m.status,(d.value->>'date')::date as business_date,m.category_code,
 (d.value->>'amountCents')::numeric as amount_cents,m.as_of_date
 from public.cv_running_cost_months m cross join lateral jsonb_array_elements(m.data->'dailyAllocatedCents') d;
revoke all on public.cv_running_cost_days from public,anon,authenticated;
grant select on public.cv_running_cost_days to authenticated,service_role;
comment on view public.cv_running_cost_days is 'Canonical period allocation of recorded receipts on their dates plus unpaid forecast only on active commitment days. Amounts may be fractional cents; sum then round. as_of_date is the receipt evidence cutoff, future day allocations are forecasts. Not additive with cv_running_cost_months.';
 then (v->>'transactionMixBps')::numeric end as txn_mix
     from jsonb_array_elements(p.rules) v
   ) rules
 ) r on true
 cross join lateral (
   select case when d.card_fees_status='actual' and d.card_fees_cents>=0 then 'actual'
     when p.id is not null and r.valid then 'owner_plan'
     when d.card_fees_cents>0 and (d.card_fees_status='estimated' or d.card_fees_status is null) then 'estimated'
     else 'default_estimate' end as basis,
   case when d.card_fees_status='actual' and d.card_fees_cents>=0 then d.card_fees_cents::numeric
     when p.id is not null and r.valid then
       d.net_sales_cents::numeric*p.processed_sales_share_bps*r.rate/10000+
       d.orders_count::numeric*p.processed_transaction_share_bps*r.fixed_fee/10000
     when d.card_fees_cents>0 and (d.card_fees_status='estimated' or d.card_fees_status is null) then d.card_fees_cents::numeric
     else d.net_sales_cents::numeric*290/10000 end as amount
 ) fee;
comment on view public.cv_sales_days is 'One saved day per café and business date. Screen and Supervisor daily sales, ingredient cost, wages, payroll tax, fees and voids; data includes independent sales_data_status, labor_wage_status, staff_tax_status/source and card_fees_status. Not provisional intraday sales.';
comment on column public.cv_sales_days.data is 'Saved daily fact amounts in integer cents and counts, with independent source and completeness statuses. Unknown wages and taxes remain null. recorded_contribution_cents is recorded sales minus ingredients, saved fees and loaded wages, before operating bills; null when labor is incomplete.';

-- Existing recurring commitments; retain every existing key and expose the active dates and due day.
create or replace view public.cv_bills
 (business_id,source,source_ref,status,business_date,data,id,category_code,label,amount_cents,frequency,is_estimate,active_from,active_to,due_day) with (security_invoker=true) as
 select c.business_id,coalesce(nullif(c.source,''),'app')::text,
 'bill:'||c.id::text,case when c.is_estimate then 'estimated' else 'actual' end::text,
 null::date,jsonb_build_object('id',c.id,'amount_cents',c.amount_cents,
 'frequency',c.frequency,'category',c.category_code,'name',c.label,'is_estimate',c.is_estimate,
 'category_code',c.category_code,'label',c.label,'active_from',c.active_from,
 'active_to',c.active_to,'due_day',c.due_day),
 c.id,c.category_code,c.label,c.amount_cents,c.frequency,c.is_estimate,c.active_from,c.active_to,c.due_day
 from public.recurring_costs c;
comment on view public.cv_bills is 'Recurring obligations, one row per saved commitment, with active dates, amount, frequency and estimate status. Actual expense receipts are in cv_expenses.';

-- Expenses and bills have different grains; never union receipts with obligations.
create view public.cv_expenses with (security_invoker=true) as
 select e.business_id,e.source,'expense:'||e.id::text as source_ref,e.status,
 e.spent_on as business_date,e.id,e.spent_on,e.amount_cents,e.category_code,
 e.recurring_cost_id,e.custom_label,e.vendor
 from public.expenses e;
revoke all on public.cv_expenses from public,anon,authenticated;
grant select on public.cv_expenses to authenticated,service_role;
comment on view public.cv_expenses is 'One saved expense receipt per source_ref, with business date, amount in cents, status and recurring commitment linkage. Attachment paths and private storage metadata are excluded.';

-- The latest provisional reading has a different grain than saved closed days.
-- Do not add it to cv_sales_days or sum it alongside finalized days.
create view public.cv_sales_live with (security_invoker=true) as
 select t.business_id,'toast'::text as source,'live:'||t.business_date::text as source_ref,
 'provisional'::text as status,t.business_date,t.net_sales_cents,t.orders as orders_count,
 t.read_at,t.reading
 from public.toast_today_live t;
revoke all on public.cv_sales_live from public,anon,authenticated;
grant select on public.cv_sales_live to authenticated,service_role;
comment on view public.cv_sales_live is 'Latest provisional Toast café sales snapshot, one row per café. Use only for the matching business date before closeout; never add to finalized cv_sales_days. read_at is the source timestamp.';

-- Preserve order provenance needed by the payment-fee eligibility checks.
create or replace view public.cv_orders
 (business_id,source,source_ref,status,business_date,order_ref,dining_option,source_channel,guest_count,data,net_sales_cents)
 with (security_invoker=true) as
 select o.business_id,case when o.pos_order_id like 'toast:%' then 'toast' else 'app' end::text,
 'order:'||o.id::text,case when o.toast_excluded is true or o.superseded_by is not null then 'needs_match' else 'actual' end::text,
 o.business_date,o.id::text,o.dining_option,o.source_channel,o.guest_count::integer,
 jsonb_build_object('order_ref',o.id,'dining_option',o.dining_option,'source_channel',o.source_channel,
 'guest_count',o.guest_count,'toast_excluded',o.toast_excluded,'superseded',o.superseded_by is not null,
 'recorded_net_sales_cents',o.net_sales_cents,'pos_order_id',o.pos_order_id,
 'processing_fee_provider',o.processing_fee_provider),
 case when o.toast_excluded is true or o.superseded_by is not null then null::bigint else o.net_sales_cents end
 from public.orders o;

-- One item/day total from the canonical sold lines. UI and SQL share the same
-- actual-only grouping; no application-side per-line aggregation.
create view public.cv_item_sales_daily with (security_invoker=true) as
 select business_id,'item-day:'||business_date::text||':'||(data->>'menu_item_id') as source_ref,
 'actual'::text as status,business_date,(data->>'menu_item_id')::uuid as menu_item_id,
 sum(quantity) as quantity,sum(net_sales_cents) as net_sales_cents
 from public.cv_item_sales
 where status='actual' and data->>'menu_item_id' is not null
 group by business_id,business_date,(data->>'menu_item_id');
revoke all on public.cv_item_sales_daily from public,anon,authenticated;
grant select on public.cv_item_sales_daily to authenticated,service_role;
comment on view public.cv_item_sales_daily is 'Actual sold quantity and net sales in integer cents, grouped once per cafe, item and business date from cv_item_sales. No voided or review-only lines. Missing days are not zero.';

-- Item identity and quantity use the same operational canonical lines as SQL chat.
create or replace function public.menu_item_quantities_sold(p_business_id uuid,p_from date,p_to date)
 returns table(menu_item_id uuid,total_quantity numeric)
 language sql stable security invoker set search_path=public as $$
 select v.menu_item_id,sum(v.quantity)
 from public.cv_item_sales_daily v
 where v.business_id=p_business_id and v.business_date between p_from and p_to
 group by v.menu_item_id
 $$;

-- Preserve the existing item/review/version union and expose menu display fields.
create or replace view public.cv_menu
 (business_id,source,source_ref,status,business_date,data,id,name,base_name,size_label,price_cents,prep_seconds,category,menu_group,is_active,pos_item_id,catalog_source,catalog_last_synced_at,description,pos_visibility,pos_pricing_strategy) with (security_invoker=true) as
 select m.business_id,case when m.catalog_source='toast' then 'toast' else 'app' end::text,
 'item:'||m.id::text,'actual'::text,null::date,
 jsonb_build_object('id',m.id,'name',m.name,'price_cents',m.price_cents,
 'category',m.category,'menu_group',m.menu_group,'is_active',m.is_active,'pos_item_id',m.pos_item_id,
 'base_name',m.base_name,'size_label',m.size_label,'prep_seconds',m.prep_seconds,
 'catalog_source',m.catalog_source,'catalog_last_synced_at',m.catalog_last_synced_at,
 'description',m.description,'pos_visibility',m.pos_visibility,'pos_pricing_strategy',m.pos_pricing_strategy),
 m.id,m.name,m.base_name,m.size_label,m.price_cents,m.prep_seconds,m.category,m.menu_group,m.is_active,m.pos_item_id,m.catalog_source,m.catalog_last_synced_at,m.description,m.pos_visibility,m.pos_pricing_strategy
 from public.menu_items m
 union all
 select r.business_id,'toast'::text,'review:'||r.review_type||':'||r.source_key,
 'needs_match'::text,null::date,jsonb_build_object('review_type',r.review_type,'source_key',r.source_key,'detail',r.detail),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.pos_import_reviews r where r.provider='toast' and r.review_type in ('catalog_item','menu_identity','item_identity')
 and r.status='needs_owner'
 union all
 select v.business_id,'toast'::text,
 'price-version:'||v.restaurant_guid::text||':'||v.kind||':'||v.provider_guid::text||':'||v.price_fingerprint,
 'actual'::text,null::date,jsonb_build_object('kind','price_version','provider_guid',v.provider_guid,
 'entity_kind',v.kind,'name',v.name,'category',v.category,'price_cents',v.price_cents,'observed_at',v.observed_at),
 null::uuid,null::text,null::text,null::text,null::bigint,null::integer,null::text,null::text,null::boolean,null::text,null::text,null::timestamp with time zone,null::text,null::text,null::text
 from public.toast_catalog_price_versions v;
comment on view public.cv_menu is 'Current and archived catalog rows have source_ref item:; price-version and needs_match review rows are separate, not additional sellable products. Null open prices remain unknown.';

-- One calculation of monthly running costs. Expense receipts remain dated evidence;
-- linked receipts reduce ONLY their obligation, and unlinked overlap is uncertain.
create function public.running_cost_lines_for_month(p_business_id uuid,p_month_start date,p_as_of date)
returns table(category_code text,data jsonb)
language sql stable security invoker set search_path=public as $$
with bounds as (
 select p_month_start as start_date,(p_month_start+interval '1 month - 1 day')::date as end_date
 where p_month_start=date_trunc('month',p_month_start)::date
 and p_as_of>=p_month_start and exists(select 1 from public.businesses where id=p_business_id)
), expenses as materialized (
 select e.* from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on between b.start_date and least(b.end_date,p_as_of)
), prior as (
 select distinct e.category_code from public.cv_expenses e,bounds b
 where e.business_id=p_business_id and e.spent_on>=b.start_date-interval '1 month'
 and e.spent_on<b.start_date and e.status='actual'
), obligations as (
 select r.*,floor(case r.frequency when 'weekly' then r.amount_cents::numeric*52/12
   when 'quarterly' then r.amount_cents::numeric/3 when 'yearly' then r.amount_cents::numeric/12
   else r.amount_cents::numeric end+0.5)::bigint as monthly_equivalent,
 coalesce(l.recorded,0) as linked_recorded,coalesce(l.actual,0) as linked_actual
 from public.cv_bills r cross join bounds b
 left join lateral (select sum(e.amount_cents) as recorded,
 sum(e.amount_cents) filter(where e.status='actual') as actual
 from expenses e where e.recurring_cost_id=r.id) l on true
 where r.business_id=p_business_id and r.active_from<=b.end_date
 and (r.active_to is null or r.active_to>=b.start_date)
), bill_totals as (
 select r.category_code,count(*) as n,
 sum(greatest(0,r.monthly_equivalent-r.linked_recorded)) as remaining,
 jsonb_agg(jsonb_build_object('kind','recurring','id',r.id,'label',r.label,
 'amountCents',r.amount_cents,'frequency',r.frequency,'source',r.source,'dueDay',r.due_day,
 'activeFrom',r.active_from,'activeTo',r.active_to,'isEstimate',r.is_estimate,
 'monthlyEquivalentCents',r.monthly_equivalent,'linkedRecordedCents',r.linked_recorded,
 'linkedActualCents',r.linked_actual,'linkedEstimatedCents',r.linked_recorded-r.linked_actual,
 'remainingForecastCents',greatest(0,r.monthly_equivalent-r.linked_recorded),
 'costBehaviour','unknown') order by r.id) as evidence
 from obligations r group by r.category_code
), expense_totals as (
 select e.category_code,count(*) as n,sum(e.amount_cents) as recorded,
 coalesce(sum(e.amount_cents) filter(where e.status='actual'),0) as actual,
 coalesce(sum(greatest(0,e.amount_cents)) filter(where e.recurring_cost_id is null),0) as unlinked,
 coalesce(sum(e.amount_cents) filter(where e.status='actual' and e.spent_on=p_as_of),0) as actual_today,
 bool_or(e.status<>'actual') as estimated,
 jsonb_agg(jsonb_build_object('kind','expense','id',e.id,
 'label',coalesce(e.custom_label,e.vendor,e.category_code),'amountCents',e.amount_cents,
 'date',e.spent_on,'status',e.status,'source',e.source,'recurringCostId',e.recurring_cost_id,
 'costBehaviour','unknown') order by e.id) as evidence
 from expenses e group by e.category_code
), defaults(code,label,position,regular) as (
 values ('rent','Rent',1,true),('utilities_power','Electricity & gas',2,true),
 ('water','Water',3,true),('internet','Internet & phone',4,true),('insurance','Insurance',5,true),
 ('loan','Loan payment',6,true),('software','Software',7,true),('supplies','Store runs & supplies',8,true),
 ('repairs','Repairs',9,false),('other','Other',10,false)
), codes as (
 select code from defaults union select p.category_code from prior p
 union select e.category_code from expenses e union select r.category_code from obligations r
 union select o.bucket_code from public.recovery_order o where o.business_id=p_business_id
), facts as (
 select c.code,coalesce(d.label,c.code) as label,coalesce(e.n,0) as receipts,
 coalesce(r.n,0) as commitments,coalesce(e.recorded,0) as recorded,
 coalesce(e.actual,0) as actual,coalesce(r.remaining,0) as remaining,
 least(coalesce(r.remaining,0),coalesce(e.unlinked,0)) as overlap,
 coalesce(e.actual_today,0) as actual_today,coalesce(e.estimated,false) as receipt_estimate,
 coalesce(e.evidence,'[]'::jsonb)||coalesce(r.evidence,'[]'::jsonb) as evidence,
 (coalesce(r.n,0)>0 or (coalesce(d.regular,false) and p.category_code is not null)) as expected,
 o.position as owner_position,d.position as default_position
 from codes c cross join bounds b left join defaults d on d.code=c.code
 left join expense_totals e on e.category_code=c.code left join bill_totals r on r.category_code=c.code
 left join prior p on p.category_code=c.code
 left join public.recovery_order o on o.business_id=p_business_id and o.bucket_code=c.code
 where c.code<>'ingredients'
)
select f.code,jsonb_build_object('categoryCode',f.code,'label',f.label,
 'amountCents',f.recorded+f.remaining-f.overlap,'recordedExpenseCents',f.recorded,
 'recordedActualCents',f.actual,'recordedEstimatedCents',f.recorded-f.actual,
 'recurringEstimateCents',f.remaining-f.overlap,'expenseEvidence',f.evidence,
 'possibleAdditionalForecastCents',f.overlap,'forecastUpperCents',f.recorded+f.remaining,
 'forecastOverlapUncertain',f.overlap>0,'amountSource',case when f.receipts>0 then
  case when f.remaining>0 then 'mixed' else 'recorded_expense' end
  when f.commitments>0 then 'recurring' else 'missing' end,
 'actualTodayCents',f.actual_today,'isEstimate',f.receipt_estimate or f.remaining>0,
 'isMissing',f.receipts=0 and f.commitments=0 and f.expected,
 'isExpected',f.expected or f.receipts>0,
 'dailyAllocatedCents',(
   select jsonb_agg(jsonb_build_object('date',p.day::date,'amountCents',
     coalesce((select sum(e.amount_cents) from expenses e
       where e.category_code=f.code and e.spent_on=p.day::date),0)
     + case when f.remaining>0 then
       (f.remaining-f.overlap)/f.remaining/(b.end_date-b.start_date+1)
       * coalesce((select sum(greatest(0,r.monthly_equivalent-r.linked_recorded))
          from obligations r where r.category_code=f.code and r.active_from<=p.day::date
          and (r.active_to is null or r.active_to>=p.day::date)),0)
       else 0 end) order by p.day)
   from bounds b cross join lateral generate_series(b.start_date::timestamp,b.end_date::timestamp,interval '1 day') p(day)
 ))
from facts f order by f.owner_position nulls last,f.default_position nulls last,f.code
$$;
revoke all on function public.running_cost_lines_for_month(uuid,date,date) from public,anon;
grant execute on function public.running_cost_lines_for_month(uuid,date,date) to authenticated,service_role;
comment on function public.running_cost_lines_for_month(uuid,date,date) is 'Canonical monthly running costs, recorded expense evidence and conservative obligation forecasts, using the requested café calendar month and as-of date. Never treats a category match as settlement.';

-- Discoverable SQL view for all observed months and months covered by commitments.
-- Explicit as-of-date reads use the very same function, not a second calculation.
create view public.cv_running_cost_months with (security_invoker=true) as
with cafes as (
 select b.id as business_id,(now() at time zone b.timezone)::date as today
 from public.businesses b
), months as (
 select c.business_id,c.today,date_trunc('month',c.today)::date as business_date from cafes c
 union select c.business_id,c.today,(date_trunc('month',c.today)-interval '1 month')::date from cafes c
 union select c.business_id,c.today,date_trunc('month',e.spent_on)::date
 from cafes c join public.cv_expenses e using(business_id) where e.spent_on<=c.today
 union select c.business_id,c.today,(date_trunc('month',e.spent_on)+interval '1 month')::date
 from cafes c join public.cv_expenses e using(business_id)
 where e.status='actual' and e.spent_on<date_trunc('month',c.today)::date
 union select c.business_id,c.today,date_trunc('month',d.business_date)::date
 from cafes c join public.cv_sales_days d using(business_id) where d.business_date<=c.today
 union select c.business_id,c.today,g.month::date from cafes c
 join public.cv_bills r using(business_id)
 cross join lateral generate_series(date_trunc('month',r.active_from),
  date_trunc('month',least(coalesce(r.active_to,c.today),c.today)),interval '1 month') g(month)
)
select m.business_id,'app'::text as source,'running-cost:'||m.business_date||':'||r.category_code as source_ref,
 case when (r.data->>'isMissing')::boolean then 'open' when (r.data->>'isEstimate')::boolean then 'estimated'
 when (r.data->>'isExpected')::boolean then 'actual' else 'open' end::text as status,
 m.business_date, r.category_code,(r.data->>'amountCents')::bigint as amount_cents,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date) as as_of_date,r.data
from months m cross join lateral public.running_cost_lines_for_month(m.business_id,m.business_date,
 least(m.today,(m.business_date+interval '1 month - 1 day')::date)) r;
revoke all on public.cv_running_cost_months from public,anon,authenticated;
grant select on public.cv_running_cost_months to authenticated,service_role;
comment on view public.cv_running_cost_months is 'One café/month/category, with amount in cents including separately labeled unpaid forecast and dated receipt evidence; as_of_date identifies the cutoff. Do not treat estimated forecasts as paid bills.';

-- Staff screen's persisted clock records deliberately include schedule predictions;
-- cv_labor_entries remains actual provider labor (do not add these two views).
-- A single database statement fixes the clock for all per-entry and day totals.
create view public.cv_staff_clock_entries with (security_invoker=true) as
with entries as (
 select t.business_id,coalesce(t.source_provider,'app')::text as source,'staff-clock:'||t.id as source_ref,
 case when t.source_type='owner_schedule' then 'estimated'
      when t.clock_out is null or t.clock_out>now() then 'provisional'
      when t.hourly_wage_cents is null then 'open' else 'actual' end::text as status,
 (t.clock_in at time zone b.timezone)::date as business_date,
 t.id,t.employee_id,t.schedule_id,t.source_type,t.source_provider,t.clock_in,t.clock_out,
 t.hourly_wage_cents,t.breaks,t.provider_regular_hours,t.provider_overtime_hours,
 e.display_name as employee_name,e.role as employee_role,now() as as_of,
 b.payroll_tax_rate,
 case when t.hourly_wage_cents is null then null
 when t.clock_out is not null and (t.provider_regular_hours is not null or t.provider_overtime_hours is not null)
  and coalesce(t.provider_regular_hours,0)>=0 and coalesce(t.provider_overtime_hours,0)>=0
 then (coalesce(t.provider_regular_hours,0)+coalesce(t.provider_overtime_hours,0)*1.5)*t.hourly_wage_cents
 else greatest(0,extract(epoch from least(coalesce(t.clock_out,now()),now())-t.clock_in)
   - coalesce((select sum(greatest(0,extract(epoch from
      (br->>'end')::timestamptz-(br->>'start')::timestamptz)))
     from jsonb_array_elements(t.breaks) br where not coalesce((br->>'paid')::boolean,false)),0))
   /3600*t.hourly_wage_cents end::numeric as wages_cents
 from public.timecards t join public.businesses b on b.id=t.business_id
 left join public.employees e on e.id=t.employee_id and e.business_id=t.business_id
)
select business_id,source,source_ref,status,business_date,id,employee_id,schedule_id,source_type,source_provider,
 clock_in,clock_out,hourly_wage_cents,breaks,provider_regular_hours,provider_overtime_hours,
 employee_name,employee_role,as_of,wages_cents,wages_cents*(1+payroll_tax_rate) as loaded_cost_cents,
 hourly_wage_cents*(1+payroll_tax_rate) as loaded_hourly_cents,
 case when count(*) filter(where wages_cents is null) over(partition by business_id,business_date)>0 then null
 else sum(wages_cents*(1+payroll_tax_rate)) over(partition by business_id,business_date) end as day_loaded_cost_cents
from entries;
revoke all on public.cv_staff_clock_entries from public,anon,authenticated;
grant select on public.cv_staff_clock_entries to authenticated,service_role;
comment on view public.cv_staff_clock_entries is 'Stored Staff-screen clock records, including explicitly estimated owner schedules. Wage amounts use saved provider hours when available, else elapsed time minus unpaid breaks at as_of; loaded amounts include business payroll tax rate. day_loaded_cost_cents repeats the whole café/day total per entry; never sum it across entries. Unknown wage in any entry makes the day total null. Not additive with cv_labor_entries.';

-- Fractional-cent day allocation is the source for arbitrary period totals.
-- Sum before rounding, and do not treat projected days as payments.
create view public.cv_running_cost_days with (security_invoker=true) as
 select m.business_id,m.source,'running-cost-day:'||(d.value->>'date')||':'||m.category_code as source_ref,
 m.status,(d.value->>'date')::date as business_date,m.category_code,
 (d.value->>'amountCents')::numeric as amount_cents,m.as_of_date
 from public.cv_running_cost_months m cross join lateral jsonb_array_elements(m.data->'dailyAllocatedCents') d;
revoke all on public.cv_running_cost_days from public,anon,authenticated;
grant select on public.cv_running_cost_days to authenticated,service_role;
comment on view public.cv_running_cost_days is 'Canonical period allocation of recorded receipts on their dates plus unpaid forecast only on active commitment days. Amounts may be fractional cents; sum then round. as_of_date is the receipt evidence cutoff, future day allocations are forecasts. Not additive with cv_running_cost_months.';

-- One current recipe/product calculation per café/item. As-of refers to
-- ingredient price effective dates, not a reconstructed historical recipe.
create function public.product_costs_as_of(p_business_id uuid,p_as_of date)
returns table(menu_item_id uuid,data jsonb)
language sql stable security invoker set search_path=public as $$
with items as materialized (
 select id from public.menu_items where business_id=p_business_id
), lines as (
 select l.menu_item_id,l.ingredient_id,l.quantity,l.display_unit,l.display_quantity,l.sort_order,
 i.name,i.base_unit,i.starter_key,p.source as price_source,
 l.quantity*p.cost_per_base_unit_micros::numeric/1000000 as cost_cents
 from items m join public.recipe_lines l on l.menu_item_id=m.id
 left join public.ingredients i on i.id=l.ingredient_id and i.business_id=p_business_id
 left join lateral (
  select p.cost_per_base_unit_micros,p.source from public.ingredient_prices p
  where p.ingredient_id=i.id and p.effective_from<=p_as_of
  order by p.effective_from desc,p.recorded_at desc,p.id desc limit 1
 ) p on true
), recipes as (
 select l.menu_item_id,case when count(*) filter(where l.cost_cents is null)>0
  then 'MISSING_INGREDIENT_COST' else 'READY' end as recipe_status,
 case when count(*) filter(where l.cost_cents is null)=0 then sum(l.cost_cents) end as recipe_cost,
 jsonb_agg(jsonb_build_object('ingredientId',l.ingredient_id,'ingredientName',l.name,
 'baseUnit',l.base_unit,'starterKey',l.starter_key,'quantity',l.quantity,'displayUnit',l.display_unit,
 'displayQuantity',l.display_quantity,'sortOrder',l.sort_order,'costCents',l.cost_cents,'priceSource',l.price_source)
 order by l.sort_order nulls last,l.ingredient_id) as recipe
 from lines l group by l.menu_item_id
), base as materialized (
 select m.id,coalesce(r.recipe_status,'NO_RECIPE') as recipe_status,r.recipe_cost,
 coalesce(r.recipe,'[]'::jsonb) as recipe,f.cost_cents as owner_cost,f.status as owner_status,
 f.source_type as owner_source,
 case when r.recipe_cost>0 then r.recipe_cost when f.cost_cents>0 then f.cost_cents else r.recipe_cost end as cost,
 case when r.recipe_cost>0 or f.cost_cents>0 then 'READY' else coalesce(r.recipe_status,'NO_RECIPE') end as cost_status,
 case when r.recipe_cost>0 then 'recipe' when f.cost_cents>0 then 'owner_total' end as cost_source
 from items m left join recipes r on r.menu_item_id=m.id
 left join public.menu_item_cost_fallbacks f on f.business_id=p_business_id and f.menu_item_id=m.id
), parts as materialized (
 select c.* from public.menu_combo_components c where c.business_id=p_business_id
), combos as (
 select p.combo_item_id,
 bool_or(p.component_item_id=p.combo_item_id or exists(select 1 from parts q where q.combo_item_id=p.component_item_id)
  or p.quantity not between 1 and 100 or
  coalesce(p.buy_in_cost_cents,case when b.cost_status='READY' then b.cost end) is null
  or coalesce(p.buy_in_cost_cents,case when b.cost_status='READY' then b.cost end)<0) as unknown,
 sum(p.quantity*coalesce(p.buy_in_cost_cents,case when b.cost_status='READY' then b.cost end)) as cost,
 bool_or(p.buy_in_cost_cents is null and b.cost_source='owner_total' and b.owner_status='estimated') as estimated
 from parts p left join base b on b.id=p.component_item_id group by p.combo_item_id
)
select b.id,jsonb_build_object(
 'costCents',case when c.combo_item_id is not null then case when not c.unknown then c.cost end else b.cost end,
 'status',case when c.combo_item_id is not null then case when c.unknown then 'MISSING_INGREDIENT_COST' else 'READY' end else b.cost_status end,
 'source',case when c.combo_item_id is not null then 'combo' else b.cost_source end,
 'estimated',case when c.combo_item_id is not null then not c.unknown and coalesce(c.estimated,false)
 else coalesce(b.cost_source='owner_total' and b.owner_status='estimated',false) end,
 'recipe',b.recipe,'recipeStatus',case when c.combo_item_id is not null then case when c.unknown then 'MISSING_INGREDIENT_COST' else 'READY' end else b.recipe_status end,
 'recipeCostCents',case when c.combo_item_id is null then b.recipe_cost end,
 'ownerTotalCostCents',b.owner_cost,'ownerTotalCostStatus',b.owner_status,'ownerTotalCostSource',b.owner_source,
 'differenceCents',case when b.owner_cost>0 then b.recipe_cost-b.owner_cost end
)
from base b left join combos c on c.combo_item_id=b.id
$$;
revoke all on function public.product_costs_as_of(uuid,date) from public,anon;
grant execute on function public.product_costs_as_of(uuid,date) to authenticated,service_role;
comment on function public.product_costs_as_of(uuid,date) is 'Current recipe composition and owner fallback valued at the requested ingredient price date. Not historical recipe composition proof. Combo components override stale standalone costs; missing component costs propagate.';

create view public.cv_menu_product_costs with (security_invoker=true) as
 select b.id as business_id,'app'::text as source,'product-cost:'||p.menu_item_id as source_ref,
 case when p.data->>'status'<>'READY' then 'open'
 when (p.data->>'estimated')::boolean then 'estimated' else 'actual' end::text as status,
 (now() at time zone b.timezone)::date as business_date,p.menu_item_id,
 (p.data->>'costCents')::numeric as cost_cents,p.data
 from public.businesses b cross join lateral public.product_costs_as_of(b.id,(now() at time zone b.timezone)::date) p;
revoke all on public.cv_menu_product_costs from public,anon,authenticated;
grant select on public.cv_menu_product_costs to authenticated,service_role;
comment on view public.cv_menu_product_costs is 'Current menu recipe and resolved product costs per item, including archived components, ingredient-price effective date and explicit missing/estimated status. Fractional cents retained until display. Not historical sold-line cost proof.';
