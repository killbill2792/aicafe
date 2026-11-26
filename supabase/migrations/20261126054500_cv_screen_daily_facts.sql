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
   'voids_cents',d.voids_cents,'voids_status',d.voids_status,'voids_source',d.voids_source)
 from public.daily_rollups d;
comment on view public.cv_sales_days is 'One saved day per café and business date. Screen and Supervisor daily sales, ingredient cost, wages, payroll tax, fees and voids; data includes independent sales_data_status, labor_wage_status, staff_tax_status/source and card_fees_status. Not provisional intraday sales.';
comment on column public.cv_sales_days.data is 'Saved daily fact amounts in integer cents and counts, with independent source and completeness statuses. Unknown wages and taxes remain null.';

-- Existing recurring commitments; retain every existing key and expose the active dates and due day.
create or replace view public.cv_bills
 (business_id,source,source_ref,status,business_date,data) with (security_invoker=true) as
 select c.business_id,coalesce(nullif(c.source,''),'app')::text,
 'bill:'||c.id::text,case when c.is_estimate then 'estimated' else 'actual' end::text,
 null::date,jsonb_build_object('id',c.id,'amount_cents',c.amount_cents,
 'frequency',c.frequency,'category',c.category_code,'name',c.label,'is_estimate',c.is_estimate,
 'category_code',c.category_code,'label',c.label,'active_from',c.active_from,
 'active_to',c.active_to,'due_day',c.due_day)
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
