-- Fully migrated disposable database only; all fixtures roll back.
\set ON_ERROR_STOP on
BEGIN;
SELECT gen_random_uuid() AS a,gen_random_uuid() AS b,
 gen_random_uuid() AS oa,gen_random_uuid() AS ob,
 gen_random_uuid() AS bill,gen_random_uuid() AS item,
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
INSERT INTO public.daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,
 staff_wages_cents,staff_tax_cents,card_fees_cents,voids_cents,sales_data_status,card_fees_status,labor_wage_status)
VALUES(:'a',current_date-1,1200,2,3,250,NULL,NULL,30,0,'actual','actual','missing'),
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
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'oa',true),
 set_config('request.jwt.claim.role','authenticated',true),
 set_config('request.jwt.claims',json_build_object('sub',:'oa','role','authenticated')::text,true);
SELECT (
 (SELECT count(*) FROM public.cv_sales_days WHERE business_id=:'a')=1
 AND (SELECT net_sales_cents FROM public.cv_sales_days WHERE business_id=:'a')=1200
 AND (SELECT (data->>'ingredients_cents')::bigint FROM public.cv_sales_days WHERE business_id=:'a')=250
 AND (SELECT data->>'staff_wages_cents' IS NULL AND data->>'labor_wage_status'='missing'
 FROM public.cv_sales_days WHERE business_id=:'a')
 AND (SELECT count(*) FROM public.cv_sales_days WHERE business_id=:'b')=0
 AND (SELECT net_sales_cents FROM public.cv_sales_live WHERE business_id=:'a')=700
 AND (SELECT count(*) FROM public.cv_sales_live WHERE business_id=:'b')=0
 AND (SELECT amount_cents FROM public.cv_expenses WHERE business_id=:'a')=30000
 AND (SELECT count(*) FROM public.cv_expenses WHERE business_id=:'b')=0
 AND (SELECT (data->>'amount_cents')::bigint FROM public.cv_bills WHERE business_id=:'a')=30000
 AND (SELECT (data->>'price_cents')::bigint FROM public.cv_menu WHERE business_id=:'a' AND source_ref='item:'||:'item')=600
 AND (SELECT total_quantity FROM public.menu_item_quantities_sold(:'a',current_date-1,current_date-1) WHERE menu_item_id=:'item')=2
 AND (SELECT count(*) FROM public.cv_item_sales WHERE business_id=:'b')=0
 AND (SELECT count(*) FROM public.cv_orders WHERE business_id=:'b')=0
) IS TRUE AS passed \gset
\if :passed
\echo Canonical screen amounts, missingness, provisional separation, void exclusion and tenant isolation passed.
\else
\echo Canonical screen parity failed.
SELECT 1/0;
\endif
RESET ROLE;
ROLLBACK;
