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
