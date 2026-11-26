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
   'recorded_contribution_cents',case when d.labor_wage_status='missing' or d.staff_wages_cents is null or d.staff_tax_cents is null then null
    else d.net_sales_cents-d.ingredients_cents-d.card_fees_cents-d.staff_wages_cents-d.staff_tax_cents end)
 from public.daily_rollups d;
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
 'isExpected',f.expected or f.receipts>0)
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
