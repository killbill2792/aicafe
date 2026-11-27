-- Fully migrated disposable database only; all fixtures roll back.
\set ON_ERROR_STOP on
BEGIN;
SELECT gen_random_uuid() AS a,gen_random_uuid() AS b,
 gen_random_uuid() AS oa,gen_random_uuid() AS ob,
 gen_random_uuid() AS bill,gen_random_uuid() AS item,
 gen_random_uuid() AS loc_a,gen_random_uuid() AS loc_b,
 gen_random_uuid() AS toast_loc,gen_random_uuid() AS shift_id,gen_random_uuid() AS employee_key,
 gen_random_uuid() AS order_a,gen_random_uuid() AS order_b \gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
VALUES(:'oa','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'screen-a-'||:'oa'||'@example.invalid','',now(),now()),
 (:'ob','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 'screen-b-'||:'ob'||'@example.invalid','',now(),now());
INSERT INTO public.businesses(id,name,is_demo,timezone,currency)
VALUES(:'a','Disposable Screen A',false,'UTC','CAD'),(:'b','Disposable Screen B',false,'UTC','CAD');
INSERT INTO public.memberships(business_id,user_id,role)
VALUES(:'a',:'oa','owner'),(:'b',:'ob','owner');
INSERT INTO public.locations(id,business_id,name)
VALUES(:'loc_a',:'a','Fixture A'),(:'loc_b',:'b','Fixture B');
UPDATE public.locations SET pos_location_id='fixture-square-location' WHERE id=:'loc_a';
INSERT INTO public.pos_scheduled_shifts(business_id,location_id,provider,external_shift_id,
 external_employee_id,scheduled_start,scheduled_end,deleted)
VALUES (:'a',:'loc_a','toast',:'shift_id','toast-employee',current_date-1+time '08:00',current_date-1+time '10:00',false),
 (:'a',:'loc_a','toast','older','toast-employee',current_date-5+time '08:00',current_date-5+time '10:00',false),
 (:'a',:'loc_a','square',:'shift_id','square-employee',current_date-1+time '11:00',current_date-1+time '14:00',false),
 (:'a',:'loc_a','square','removed','square-employee',current_date-1+time '15:00',current_date-1+time '16:00',true),
 (:'b',:'loc_b','square',:'shift_id','foreign-employee',current_date-1+time '08:00',current_date-1+time '10:00',false);
SELECT public.external_commit_page(:'a','toast',:'toast_loc','labor/v1/shifts','range',0,
 jsonb_build_object('mode','window','scope',jsonb_build_object('locationId',:'loc_a',
  'from',to_jsonb((current_date-2)::timestamptz),'until',to_jsonb(current_date::timestamptz))),true,
 jsonb_build_array(jsonb_build_object('key',:'shift_id','payload',jsonb_build_object('guid',:'shift_id',
  'employeeReference',jsonb_build_object('guid',:'employee_key'),
  'inDate',(current_date-1+time '09:00')::timestamptz,'outDate',(current_date-1+time '10:00')::timestamptz))));
SELECT public.external_commit_page(:'a','square','fixture-square-merchant','scheduled_shifts','fixture-square-location',0,
 jsonb_build_object('mode','window','scope',jsonb_build_object('location','fixture-square-location',
  'query',jsonb_build_object('query',jsonb_build_object('filter',jsonb_build_object(
   'start',jsonb_build_object('end_at',current_date::timestamptz),'end',jsonb_build_object('start_at',(current_date-2)::timestamptz))))::text)),true,
 jsonb_build_array(jsonb_build_object('key',:'shift_id','payload',jsonb_build_object('id',:'shift_id',
  'published_shift_details',jsonb_build_object('location_id','fixture-square-location','team_member_id','square-employee',
  'start_at',(current_date-1+time '12:00')::timestamptz,'end_at',(current_date-1+time '14:00')::timestamptz)))));
INSERT INTO public.daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,
 staff_wages_cents,staff_tax_cents,card_fees_cents,voids_cents,sales_data_status,card_fees_status,labor_wage_status)
VALUES(:'a',current_date-1,1200,2,3,250,NULL,NULL,30,0,'actual','actual','missing'),
 (:'a',current_date-2,2000,3,5,500,300,20,90,0,'actual','actual','actual'),
 (:'b',current_date-1,9900,8,9,500,300,20,90,0,'actual','actual','actual');
INSERT INTO public.recurring_costs(id,business_id,category_code,label,amount_cents,frequency,active_from)
VALUES(:'bill',:'a','rent','Rent',30000,'monthly',current_date-10);
INSERT INTO public.expenses(business_id,spent_on,amount_cents,category_code,source,status,dedupe_key,recurring_cost_id)
VALUES(:'a',current_date-1,30000,'rent','manual','actual','screen-'||:'a',:'bill'),
 (:'b',current_date-1,40000,'rent','manual','actual','screen-'||:'b',NULL);
INSERT INTO public.menu_items(id,business_id,name,base_name,price_cents,category)
VALUES(:'item',:'a','Test drink','Test drink',600,'drink');
INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents)
VALUES(:'order_a',:'a','screen-order-a-'||:'a',now(),current_date-1,1200,1200),
 (:'order_b',:'b','screen-order-b-'||:'b',now(),current_date-1,9900,9900);
INSERT INTO public.order_lines(order_id,menu_item_id,name,quantity,net_sales_cents,voided)
VALUES(:'order_a',:'item','Test drink',2,1200,false),
 (:'order_a',:'item','Void',5,3000,true),
 (:'order_b',NULL,'Other',9,9900,false);
INSERT INTO public.toast_today_live(business_id,business_date,read_at,net_sales_cents,orders,reading)
VALUES(:'a',current_date,now(),700,1,'{}'),(:'b',current_date,now(),800,2,'{}');
-- Golden cost scenarios: partial linked payment, multiple obligations, unlinked
-- overlap, >1,000 receipts, prior regular expense and future-dated receipt.
INSERT INTO public.recurring_costs(business_id,category_code,label,amount_cents,frequency,active_from)
VALUES(:'a','other','Test obligation A',50000,'monthly',date_trunc('month',current_date)::date),
 (:'a','other','Test obligation B',20000,'monthly',date_trunc('month',current_date)::date);
INSERT INTO public.expenses(business_id,spent_on,amount_cents,category_code,source,status,dedupe_key,recurring_cost_id)
SELECT :'a',current_date,49000,'other','manual','actual','test-linked',id
 FROM public.recurring_costs WHERE business_id=:'a' AND label='Test obligation A';
INSERT INTO public.expenses(business_id,spent_on,amount_cents,category_code,source,status,dedupe_key)
SELECT :'a',current_date,1,'other','manual','actual','test-many-'||i FROM generate_series(1,1001) i;
INSERT INTO public.expenses(business_id,spent_on,amount_cents,category_code,source,status,dedupe_key)
VALUES(:'a',(date_trunc('month',current_date)-interval '1 day')::date,1000,'internet','manual','actual','test-prior'),
 (:'a',current_date+1,999999,'other','manual','estimated','test-future');
-- Closed provider pay and scheduled/unknown clocks retain separate quality.
UPDATE public.businesses SET payroll_tax_rate=.12 WHERE id=:'a';
INSERT INTO public.timecards(business_id,clock_in,clock_out,hourly_wage_cents,source_type,provider_regular_hours,provider_overtime_hours)
VALUES(:'a',current_date-1+time '08:00',current_date-1+time '11:00',1000,'connected_pos',2,1),
 (:'b',current_date-1+time '08:00',current_date-1+time '11:00',9999,'connected_pos',3,0),
 (:'a',current_date-2+time '08:00',current_date-2+time '11:00',null,'connected_pos',3,0);
-- Effective fees use actual zero, then date-scoped owner rate/fixed plan, then saved or default.
INSERT INTO public.processing_fee_rate_plans(business_id,effective_from,effective_to,processor_label,processed_sales_share_bps,processed_transaction_share_bps,rules)
VALUES(:'a',current_date-1,current_date,'Synthetic plan',10000,10000,'[{"percentageBps":200,"fixedFeeCents":10,"salesMixBps":10000,"transactionMixBps":10000}]');
UPDATE public.daily_rollups SET card_fees_status='missing',card_fees_cents=0 WHERE business_id=:'a' AND business_date=current_date-1;
-- Current recipe cost wins over the owner aggregate; future ingredient prices do not.
INSERT INTO public.ingredients(id,business_id,name,base_unit) VALUES(gen_random_uuid(),:'a','Test milk','ml') RETURNING id AS ingredient \gset
INSERT INTO public.recipe_lines(menu_item_id,ingredient_id,quantity) VALUES(:'item',:'ingredient',100);
INSERT INTO public.ingredient_prices(ingredient_id,effective_from,cost_per_base_unit_micros,source)
VALUES(:'ingredient',current_date-1,250000,'manual'),(:'ingredient',current_date+1,9999999,'manual');
INSERT INTO public.menu_item_cost_fallbacks(business_id,menu_item_id,cost_cents,source_type,status)
VALUES(:'a',:'item',123,'owner_manual','confirmed');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'oa',true),
 set_config('request.jwt.claim.role','authenticated',true),
 set_config('request.jwt.claims',json_build_object('sub',:'oa','role','authenticated')::text,true);
SELECT (
 (SELECT count(*) FROM public.cv_sales_days WHERE business_id=:'a')=2
 AND (SELECT net_sales_cents FROM public.cv_sales_days WHERE business_id=:'a' AND business_date=current_date-1)=1200
 AND (SELECT (data->>'ingredients_cents')::bigint FROM public.cv_sales_days WHERE business_id=:'a' AND business_date=current_date-1)=250
 AND (SELECT data->>'staff_wages_cents' IS NULL AND data->>'labor_wage_status'='missing'
 FROM public.cv_sales_days WHERE business_id=:'a' AND business_date=current_date-1)
 AND (SELECT data->>'recorded_contribution_cents' IS NULL FROM public.cv_sales_days WHERE business_id=:'a' AND business_date=current_date-1)
 AND (SELECT (data->>'recorded_contribution_cents')::bigint FROM public.cv_sales_days WHERE business_id=:'a' AND business_date=current_date-2)=1090
 AND (SELECT (data->'effective_fee'->>'amountCents')::numeric=44 AND data->'effective_fee'->>'basis'='owner_plan'
 FROM public.cv_sales_days WHERE business_id=:'a' AND business_date=current_date-1)
 AND (SELECT (data->'effective_fee'->>'amountCents')::numeric=90 AND data->'effective_fee'->>'basis'='actual'
 FROM public.cv_sales_days WHERE business_id=:'a' AND business_date=current_date-2)
 AND (SELECT count(*) FROM public.cv_sales_days WHERE business_id=:'b')=0
 AND (SELECT net_sales_cents FROM public.cv_sales_live WHERE business_id=:'a')=700
 AND (SELECT count(*) FROM public.cv_sales_live WHERE business_id=:'b')=0
 AND (SELECT amount_cents FROM public.cv_expenses WHERE business_id=:'a' AND category_code='rent')=30000
 AND (SELECT count(*) FROM public.cv_expenses WHERE business_id=:'b')=0
 AND (SELECT (data->>'amount_cents')::bigint FROM public.cv_bills WHERE business_id=:'a' AND category_code='rent')=30000
 AND (SELECT (data->>'price_cents')::bigint FROM public.cv_menu WHERE business_id=:'a' AND source_ref='item:'||:'item')=600
 AND (SELECT total_quantity FROM public.menu_item_quantities_sold(:'a',current_date-1,current_date-1) WHERE menu_item_id=:'item')=2
 AND (SELECT quantity=2 AND net_sales_cents=1200 FROM public.cv_item_sales_daily WHERE business_id=:'a' AND menu_item_id=:'item')
 AND (SELECT cost_cents=25 AND data->>'source'='recipe' AND (data->>'ownerTotalCostCents')::numeric=123
 FROM public.cv_menu_product_costs WHERE business_id=:'a' AND menu_item_id=:'item')
 AND (SELECT (data->>'costCents')::numeric=123 AND data->>'source'='owner_total'
 FROM public.product_costs_as_of(:'a',current_date-2) WHERE menu_item_id=:'item')
 AND (SELECT count(*) FROM public.cv_financial_periods WHERE business_id=:'b')=0
 AND (SELECT count(*) FROM public.cv_financial_periods WHERE business_id=:'a')=6
 AND (SELECT (data->>'netSalesCents')::bigint=3200 AND (data->>'ingredientsCents')::bigint=750
 AND (data->>'knownLaborCents')::bigint=320 AND (data->>'feesCents')::bigint=134
 AND (data->>'coveredLaborDays')::integer=1 AND (data->>'coveredSalesDays')::integer=2
 AND (data->>'profitCents')::bigint=3200-(data->>'totalCostsCents')::bigint
 FROM public.financial_periods_as_of(:'a',current_date,current_date-2,current_date-1))
 AND (SELECT count(*) FROM public.cv_menu_product_costs WHERE business_id=:'b')=0
 AND (SELECT count(*) FROM public.cv_item_sales_daily WHERE business_id=:'b')=0
 AND (SELECT count(*) FROM public.cv_item_sales WHERE business_id=:'b')=0
 AND (SELECT count(*) FROM public.cv_orders WHERE business_id=:'b')=0
 AND (SELECT count(*) FROM public.cv_staff_clock_entries WHERE business_id=:'b')=0
 AND (SELECT array_agg(source_ref order by source_ref)=array['square-shift:'||:'shift_id','toast-shift:'||:'shift_id']
   AND bool_and(data->>'provider'=source AND data->'paid'='false'::jsonb AND data->>'evidence'='completed_observation')
 FROM public.cv_shifts WHERE business_id=:'a' AND business_date=current_date-1)
 AND (SELECT (data->>'scheduled_start')::timestamptz=(current_date-1+time '09:00')::timestamptz
  FROM public.cv_shifts WHERE business_id=:'a' AND source_ref='toast-shift:'||:'shift_id')
 AND (SELECT (data->>'scheduled_start')::timestamptz=(current_date-1+time '12:00')::timestamptz
  FROM public.cv_shifts WHERE business_id=:'a' AND source='square')
 AND (SELECT count(*) FROM public.cv_shifts WHERE business_id=:'b')=0
 AND (SELECT wages_cents=3500 AND loaded_cost_cents=3920 AND day_loaded_cost_cents=3920
 FROM public.cv_staff_clock_entries WHERE business_id=:'a' AND business_date=current_date-1)
 AND (SELECT wages_cents IS NULL AND day_loaded_cost_cents IS NULL
 FROM public.cv_staff_clock_entries WHERE business_id=:'a' AND business_date=current_date-2)
 AND (SELECT count(*) FROM public.cv_running_cost_days WHERE business_id=:'b')=0
 AND (SELECT abs(sum(amount_cents)-70000)<0.00001 FROM public.cv_running_cost_days
 WHERE business_id=:'a' AND category_code='other' AND business_date>=date_trunc('month',current_date)::date
 AND business_date<(date_trunc('month',current_date)+interval '1 month')::date)
 AND (SELECT count(*) FROM public.cv_running_cost_months WHERE business_id=:'b')=0
 AND (SELECT amount_cents=30000 AND (data->>'recordedExpenseCents')::bigint=30000
 FROM public.cv_running_cost_months WHERE business_id=:'a' AND category_code='rent'
 AND business_date=date_trunc('month',current_date-1)::date)
 AND (SELECT amount_cents=70000 AND (data->>'recordedExpenseCents')::bigint=50001
   AND (data->>'recurringEstimateCents')::bigint=19999
   AND (data->>'possibleAdditionalForecastCents')::bigint=1001
   AND (data->>'forecastUpperCents')::bigint=71001
   AND jsonb_array_length(data->'expenseEvidence')=1004
   AND (data->>'forecastOverlapUncertain')::boolean
 FROM public.cv_running_cost_months WHERE business_id=:'a' AND category_code='other'
 AND business_date=date_trunc('month',current_date)::date)
 AND (SELECT (data->>'isMissing')::boolean FROM public.cv_running_cost_months
 WHERE business_id=:'a' AND category_code='internet' AND business_date=date_trunc('month',current_date)::date)
 AND (SELECT count(*) FROM public.running_cost_lines_for_month(:'b',date_trunc('month',current_date)::date,current_date))=0
 AND (SELECT data FROM public.running_cost_lines_for_month(:'a',date_trunc('month',current_date)::date,current_date)
 WHERE category_code='other')=(SELECT data FROM public.cv_running_cost_months
 WHERE business_id=:'a' AND category_code='other' AND business_date=date_trunc('month',current_date)::date)
) IS TRUE AS passed \gset
\if :passed
\echo Canonical screen amounts, missingness, provisional separation, void exclusion and tenant isolation passed.
\else
\echo Canonical screen parity failed.
SELECT 1/0;
\endif
RESET ROLE;
INSERT INTO public.locations(business_id,name,pos_location_id)
VALUES(:'a','Fixture A second store','fixture-square-location-2');
SELECT jsonb_build_object('mode','window','scope',jsonb_build_object('location','fixture-square-location-2',
  'query',jsonb_build_object('query',jsonb_build_object('filter',jsonb_build_object(
   'start',jsonb_build_object('end_at',current_date::timestamptz),'end',jsonb_build_object('start_at',(current_date-2)::timestamptz))))::text)) AS square_scope,
 jsonb_build_array(jsonb_build_object('key','second-square-shift','payload',jsonb_build_object('id','second-square-shift',
  'published_shift_details',jsonb_build_object('location_id','fixture-square-location-2','team_member_id','second-store-worker',
  'start_at',(current_date-1+time '15:00')::timestamptz,'end_at',(current_date-1+time '17:00')::timestamptz)))) AS square_payload \gset
SELECT public.external_commit_page(:'a','square','fixture-square-merchant','scheduled_shifts','fixture-square-location-2',0,
 :'square_scope'::jsonb,true,:'square_payload'::jsonb);
SET LOCAL ROLE authenticated;
SELECT ((SELECT count(*)=2 AND bool_and(data->>'evidence'='completed_observation')
 FROM public.cv_shifts WHERE business_id=:'a' AND source='square') IS TRUE
 AND NOT has_column_privilege('authenticated','public.external_sync_checkpoints','cursor_state','SELECT')) AS square_windows \gset
\if :square_windows
\echo Both Square locations retained their own completed evidence. Cursor access stayed service-only.
\else
SELECT 1/0;
\endif
SET LOCAL ROLE service_role;
SELECT public.external_note_availability(:'a','square','fixture-square-merchant','scheduled_shifts','permission_required',clock_timestamp(),null);
SELECT public.external_commit_page(:'a','square','fixture-square-merchant','scheduled_shifts','fixture-square-location-2',1,
 :'square_scope'::jsonb,true,:'square_payload'::jsonb);
SET LOCAL ROLE authenticated;
SELECT ((SELECT count(*)=2 and count(*) filter(where data->>'evidence'='completed_observation')=1
  and bool_and((data->>'evidence'='completed_observation')=(source_ref='square-shift:second-square-shift'))
  FROM public.cv_shifts WHERE business_id=:'a' AND source='square') IS TRUE) AS square_regain \gset
\if :square_regain
\echo Restored access certifies only the Square location observed under the new grant.
\else
SELECT 1/0;
\endif
RESET ROLE;
SELECT jsonb_build_object('mode','window','scope',jsonb_build_object('locationId',:'loc_a',
 'from',to_jsonb((current_date-2)::timestamptz),'until',to_jsonb(current_date::timestamptz))) AS schedule_scope \gset
SELECT public.external_commit_page(:'a','toast',:'toast_loc','labor/v1/shifts','range',1,
 :'schedule_scope'::jsonb||'{"cursor":"next"}',false,
 jsonb_build_array(jsonb_build_object('key',:'shift_id','payload',jsonb_build_object('guid',:'shift_id',
  'employeeReference',jsonb_build_object('guid',:'employee_key'),
  'inDate',(current_date-1+time '09:30')::timestamptz,'outDate',(current_date-1+time '10:00')::timestamptz))));
SELECT ((SELECT data->>'evidence'='historical_projection' AND
  (data->>'scheduled_start')::timestamptz=(current_date-1+time '08:00')::timestamptz
  FROM public.cv_shifts WHERE business_id=:'a' AND source_ref='toast-shift:'||:'shift_id') IS TRUE) AS planned_incomplete \gset
\if :planned_incomplete
\echo A partial revision leaves the last planned shift readable as historical evidence.
\else
SELECT 1/0;
\endif
-- A complete empty traversal marks absence only through the existing typed
-- application of the exact Toast interval. Other source scopes remain intact.
SELECT public.external_commit_page(:'a','toast',:'toast_loc','labor/v1/shifts','range',2,null,false,'[]');
SELECT public.external_commit_page(:'a','toast',:'toast_loc','labor/v1/shifts','range',3,:'schedule_scope',true,'[]');
SELECT public.toast_save_configuration(:'a','https://ws-api.toasttab.com','fixture-client','fixture-ciphertext',
 jsonb_build_array(jsonb_build_object('location_id',:'loc_a','restaurant_guid',:'toast_loc')));
UPDATE public.toast_location_mappings SET verified_at=now() WHERE business_id=:'a';
SELECT public.toast_apply_schedule_window(:'a',:'toast_loc',:'loc_a',(current_date-2)::timestamptz,current_date::timestamptz,'[]');
SELECT (NOT EXISTS(SELECT FROM public.cv_shifts WHERE business_id=:'a' AND source_ref='toast-shift:'||:'shift_id')
 AND EXISTS(SELECT FROM public.cv_shifts WHERE business_id=:'a' AND source_ref='toast-shift:older')
 AND EXISTS(SELECT FROM public.cv_shifts WHERE business_id=:'a' AND source_ref='square-shift:'||:'shift_id')) AS planned_empty \gset
\if :planned_empty
\echo Completed empty schedule evidence removed only the covered Toast shift.
\else
SELECT 1/0;
\endif

-- A complete day may replace stale saved hours only when every accepted order
-- matches its committed original, including the close and reconciled totals.
SELECT gen_random_uuid() AS hourly_run,gen_random_uuid() AS hourly_order,
 gen_random_uuid() AS hourly_thread,gen_random_uuid() AS provider_actor,current_date-9 AS hourly_day \gset
INSERT INTO public.toast_sync_runs(id,business_id,restaurant_guid,kind,state,requested_from,requested_to)
VALUES(:'hourly_run',:'a',:'toast_loc','daily','running',:'hourly_day',:'hourly_day');
INSERT INTO public.toast_day_status(business_id,restaurant_guid,business_date,import_state,coverage_complete,
 unparsed_count,order_count,last_import_run_id)
VALUES(:'a',:'toast_loc',:'hourly_day','imported',true,0,1,:'hourly_run');
UPDATE public.toast_sync_runs SET state='completed' WHERE id=:'hourly_run';
INSERT INTO public.daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,
 ingredients_cents,card_fees_cents,voids_cents,sales_data_status)
VALUES(:'a',:'hourly_day',1200,1,0,0,0,0,'actual');
INSERT INTO public.hourly_sales_rollup(business_id,location_id,business_date,hour_local,net_sales_cents,orders_count)
VALUES(:'a',:'loc_a',:'hourly_day',12,1200,1),(:'b',:'loc_b',:'hourly_day',12,9900,1);
INSERT INTO public.employees(id,business_id,display_name,pos_team_member_id)
VALUES(:'employee_key',:'a','First shift','toast:'||:'toast_loc'||':'||:'provider_actor');
INSERT INTO public.employee_sales_rollup(business_id,employee_id,business_date,net_sales_cents,orders_count)
VALUES(:'a',:'employee_key',:'hourly_day',900,1);
INSERT INTO public.orders(business_id,location_id,employee_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents)
VALUES(:'a',:'loc_a',:'employee_key','toast:'||:'toast_loc'||':'||:'hourly_order',
 (:'hourly_day'::date + time '11:05') AT TIME ZONE 'UTC',:'hourly_day',1200,1200);
INSERT INTO public.external_records(business_id,restaurant_guid,entity,entity_guid,business_date,
 run_id,seen_run_id,payload,payload_sha256,capture_key,source_account,source_key)
VALUES(:'a',:'toast_loc','order',:'hourly_order',:'hourly_day',:'hourly_run',:'hourly_run',
 jsonb_build_object('guid',:'hourly_order','closedDate',:'hourly_day'||'T11:05:00Z',
  'server',jsonb_build_object('guid',:'provider_actor'),'checks','[{"amount":12}]'::jsonb),
 repeat('a',64),'fixture-hourly-order',:'toast_loc',:'hourly_order');
INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id)
VALUES(:'hourly_thread',:'a',:'oa',gen_random_uuid());
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT public.u3_issue_research_scope(:'a',:'oa',:'hourly_thread','owner') AS hourly_ticket \gset
GRANT aicafe_research TO postgres WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE aicafe_research;
SELECT set_config('aicafe.u3_research_scope',:'hourly_ticket',true) IS NOT NULL AS scope_set \gset
SELECT (count(*)=1 AND min(hour_local)=11 AND sum(net_sales_cents)=1200 AND sum(orders_count)=1)
 AS hourly_research FROM u3_research.hourly_sales_rollup WHERE business_date=:'hourly_day' \gset
\if :hourly_research
\echo Governed SQL uses original hourly data within the signed café.
\else
SELECT 1/0;
\endif
SELECT (count(*)=1 AND bool_and(employee_id=:'employee_key') AND sum(net_sales_cents)=1200 AND sum(orders_count)=1)
 AS employee_research FROM u3_research.employee_sales_rollup WHERE business_date=:'hourly_day' \gset
\if :employee_research
\echo Governed SQL reconciles employee sales from the original order and the existing employee association.
\else
SELECT 1/0;
\endif
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT (count(*)=1 AND min((data->>'hour_local')::int)=11 AND sum(net_sales_cents)=1200
 AND bool_and(data->>'evidence'='committed_orders')) AS hourly_app
FROM public.cv_sales_hours WHERE business_date=:'hourly_day' \gset
\if :hourly_app
\echo The app uses the complete committed order instead of stale saved hours.
\else
SELECT 1/0;
\endif
SELECT (count(*)=1 AND bool_and(employee_id=:'employee_key') AND sum(net_sales_cents)=1200 AND sum(orders_count)=1)
 AS employee_app FROM public.cv_employee_sales WHERE business_date=:'hourly_day' \gset
\if :employee_app
\echo The app uses the original sale under its verified employee association.
\else
SELECT 1/0;
\endif
RESET ROLE;
UPDATE public.external_records SET payload=payload-'closedDate'-'server' WHERE business_id=:'a' AND entity_guid=:'hourly_order';
SET LOCAL ROLE authenticated;
SELECT (count(*)=1 AND min((data->>'hour_local')::int)=12 AND sum(net_sales_cents)=1200
 AND bool_and(data->>'evidence'='saved_hourly_rollup')) AS hourly_fallback
FROM public.cv_sales_hours WHERE business_date=:'hourly_day' \gset
\if :hourly_fallback
\echo An original with no close preserves the entire saved day.
\else
SELECT 1/0;
\endif
SELECT (count(*)=1 AND bool_and(employee_id=:'employee_key') AND sum(net_sales_cents)=900 AND sum(orders_count)=1)
 AS employee_fallback FROM public.cv_employee_sales WHERE business_date=:'hourly_day' \gset
\if :employee_fallback
\echo Missing provider attribution leaves the saved employee amounts readable.
\else
SELECT 1/0;
\endif
SELECT public.pos_rebuild_sales_fact_rollups_v1(:'a',:'hourly_day');
SELECT (
 EXISTS(SELECT FROM public.hourly_sales_rollup WHERE business_id=:'a' AND business_date=:'hourly_day' AND hour_local=12)
 AND EXISTS(SELECT FROM public.employee_sales_rollup WHERE business_id=:'a' AND business_date=:'hourly_day' AND net_sales_cents=900)
) AS divergent_saved \gset
\if :divergent_saved
\echo A day that cannot be reconstructed keeps each historical bucket.
\else
SELECT 1/0;
\endif
RESET ROLE;
UPDATE public.hourly_sales_rollup SET hour_local=11 WHERE business_id=:'a' AND business_date=:'hourly_day';
UPDATE public.employee_sales_rollup SET net_sales_cents=1200 WHERE business_id=:'a' AND business_date=:'hourly_day';
SET LOCAL ROLE authenticated;
SELECT public.pos_rebuild_sales_fact_rollups_v1(:'a',:'hourly_day');
SELECT public.pos_rebuild_sales_fact_rollups_v1(:'a',:'hourly_day');
SELECT (
 NOT EXISTS(SELECT FROM public.hourly_sales_rollup WHERE business_id=:'a' AND business_date=:'hourly_day')
 AND NOT EXISTS(SELECT FROM public.employee_sales_rollup WHERE business_id=:'a' AND business_date=:'hourly_day')
 AND (SELECT count(*)=1 AND min((data->>'hour_local')::int)=11 AND sum(net_sales_cents)=1200
      AND bool_and(data->>'evidence'='accepted_orders') FROM public.cv_sales_hours WHERE business_date=:'hourly_day')
 AND (SELECT count(*)=1 AND bool_and(employee_id=:'employee_key') AND sum(net_sales_cents)=1200
      FROM public.cv_employee_sales WHERE business_date=:'hourly_day')
) AS regenerated_sales \gset
\if :regenerated_sales
\echo Rebuild retires matching copies without writing new rollups or losing readable sales.
\else
SELECT 1/0;
\endif
ROLLBACK;
