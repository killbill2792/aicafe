-- Plan step 5: real Toast messiness at the database. Each scenario imports the same
-- Toast day in a different messy way into its own café; every café must end with
-- exactly the same stored rows (orders, item lines, archive, typed details, voids,
-- refunds, card-fee facts, day totals, change log) as one clean import.
-- Scenarios: re-pull, shuffled lists and page order, one order on two pages, a failed
-- run then a retry, a partial day then the full day. A real change is the control:
-- same rows as a clean import of the new data, plus exactly one change line.
-- Run ONLY against a disposable local Supabase after all migrations. Synthetic data, rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean, note text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEST FAILURE: %', note; END IF; END $$;
SELECT set_config('request.jwt.claim.role','service_role',true);

-- Fixed Toast IDs shared by every café (only the café and restaurant differ).
CREATE FUNCTION pg_temp.g(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ select ('eeeeeeee-eeee-4eee-8eee-'||lpad(to_hex(n),12,'0'))::uuid $$;

-- One Toast day as Toast sends it: two orders, taxes and modifiers, a voided item,
-- a card tip with a fee, a cash refund. shuffle=true reverses every list.
CREATE FUNCTION pg_temp.raw_orders(tip numeric,shuffle boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
declare
 o1 jsonb; o2 jsonb;
 rev jsonb:='[]';
begin
 o1:=jsonb_build_object('guid',pg_temp.g(1),'businessDate',20261021,'modifiedDate','2026-10-21T20:00:00.000+0000',
  'openedDate','2026-10-21T18:00:00.000+0000','closedDate','2026-10-21T18:30:00.000+0000',
  'checks',jsonb_build_array(jsonb_build_object('guid',pg_temp.g(11),'amount',10,'taxAmount',0.8,
   'selections',jsonb_build_array(
    jsonb_build_object('guid',pg_temp.g(21),'displayName','Latte','price',6,'quantity',1,
     'appliedTaxes',jsonb_build_array(jsonb_build_object('guid',pg_temp.g(31),'taxAmount',0.4),
      jsonb_build_object('guid',pg_temp.g(32),'taxAmount',0.08)),
     'modifiers',jsonb_build_array(jsonb_build_object('guid',pg_temp.g(41),'displayName','Oat','price',0.75),
      jsonb_build_object('guid',pg_temp.g(42),'displayName','Extra shot','price',1))),
    jsonb_build_object('guid',pg_temp.g(22),'displayName','Chai','price',4,'quantity',1,
     'appliedTaxes',jsonb_build_array(jsonb_build_object('guid',pg_temp.g(33),'taxAmount',0.32))),
    jsonb_build_object('guid',pg_temp.g(23),'displayName','Samosa','price',3,'quantity',1,'voided',true)),
   'payments',jsonb_build_array(jsonb_build_object('guid',pg_temp.g(51),'type','CREDIT',
    'paymentStatus','CAPTURED','amount',10.8,'tipAmount',tip,'originalProcessingFee',0.33)))));
 o2:=jsonb_build_object('guid',pg_temp.g(2),'businessDate',20261021,'modifiedDate','2026-10-21T19:00:00.000+0000',
  'openedDate','2026-10-21T18:40:00.000+0000','closedDate','2026-10-21T18:45:00.000+0000',
  'checks',jsonb_build_array(jsonb_build_object('guid',pg_temp.g(12),'amount',2,'taxAmount',0,
   'selections',jsonb_build_array(jsonb_build_object('guid',pg_temp.g(24),'displayName','Water','price',2,'quantity',1)),
   'payments',jsonb_build_array(jsonb_build_object('guid',pg_temp.g(52),'type','CASH','paymentStatus','CLOSED',
    'amount',2,'tipAmount',0,'refund',jsonb_build_object('refundAmount',1,'refundBusinessDate',20261021))))));
 if not shuffle then return jsonb_build_array(o1,o2); end if;
 -- Reverse every list at every depth.
 return pg_temp.reverse_lists(jsonb_build_array(o1,o2));
end $$;
CREATE FUNCTION pg_temp.reverse_lists(j jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
begin
 if jsonb_typeof(j)='array' then
  return coalesce((select jsonb_agg(pg_temp.reverse_lists(x.v) order by x.i desc)
   from jsonb_array_elements(j) with ordinality x(v,i)),'[]'::jsonb);
 elsif jsonb_typeof(j)='object' then
  return (select jsonb_object_agg(k,pg_temp.reverse_lists(v)) from jsonb_each(j) e(k,v));
 end if;
 return j;
end $$;

-- What the app sends to toast_import_day for the same day (parser output).
CREATE FUNCTION pg_temp.app_orders(r uuid,tip numeric,only_first boolean,shuffle boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
declare o1 jsonb; o2 jsonb; l jsonb;
begin
 l:=jsonb_build_array(
  jsonb_build_object('posLineId',pg_temp.g(21),'posItemId',null,'name','Latte','quantity',1,'netSalesCents',600,
   'modifiers','[]'::jsonb,'voided',false,'category','Coffee'),
  jsonb_build_object('posLineId',pg_temp.g(22),'posItemId',null,'name','Chai','quantity',1,'netSalesCents',400,
   'modifiers','[]'::jsonb,'voided',false,'category','Tea'),
  jsonb_build_object('posLineId',pg_temp.g(23),'posItemId',null,'name','Samosa','quantity',1,'netSalesCents',0,
   'modifiers','[]'::jsonb,'voided',true,'category','Food'));
 if shuffle then l:=pg_temp.reverse_lists(l); end if;
 o1:=jsonb_build_object('posOrderId','toast:'||r||':'||pg_temp.g(1),'closedAt','2026-10-21T18:30:00Z',
  'grossSalesCents',1000,'discountsCents',0,'refundsCents',0,'taxCents',80,'tipCents',(tip*100)::int,
  'netSalesCents',1000,'lines',l);
 o2:=jsonb_build_object('posOrderId','toast:'||r||':'||pg_temp.g(2),'closedAt','2026-10-21T18:45:00Z',
  'grossSalesCents',200,'discountsCents',0,'refundsCents',100,'taxCents',0,'tipCents',0,'netSalesCents',100,
  'lines',jsonb_build_array(jsonb_build_object('posLineId',pg_temp.g(24),'posItemId',null,'name','Water',
   'quantity',1,'netSalesCents',200,'modifiers','[]'::jsonb,'voided',false,'category','Drinks')));
 if only_first then return jsonb_build_array(o1); end if;
 if shuffle then return jsonb_build_array(o2,o1); end if;
 return jsonb_build_array(o1,o2);
end $$;
CREATE FUNCTION pg_temp.app_summary(tip numeric,only_first boolean) RETURNS jsonb LANGUAGE sql AS $$
 select jsonb_build_object(
  'net_sales_cents',case when only_first then 1000 else 1100 end,'order_count',case when only_first then 1 else 2 end,
  'gross_sales_cents',case when only_first then 1000 else 1200 end,'discounts_cents',0,
  'refunds_cents',case when only_first then 0 else 100 end,'tax_cents',80,'tip_cents',(tip*100)::int,
  'open_check_count',0,'service_charges_cents',0,'gratuity_cents',0,
  'unparsed_count',case when only_first then 1 else 0 end,'warnings','{}'::jsonb,'snapshot_sha256','messy',
  'voids',jsonb_build_array(jsonb_build_object('selection_guid',pg_temp.g(23),'order_guid',pg_temp.g(1),
   'check_guid',pg_temp.g(11),'order_business_date','2026-10-21','void_business_date','2026-10-21',
   'voided_at',null,'amount_cents',300,'amount_basis','price','void_reason_guid',null,'level','selection')),
  'refund_facts',case when only_first then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
   'order_guid',pg_temp.g(2),'payment_guid',pg_temp.g(52),'order_business_date','2026-10-21',
   'refund_business_date','2026-10-21','amount_cents',100)) end,
  'parsed_order_guids',case when only_first then jsonb_build_array(pg_temp.g(1))
   else jsonb_build_array(pg_temp.g(1),pg_temp.g(2)) end,
  'unparsed',case when only_first then jsonb_build_array(jsonb_build_object('order_guid',pg_temp.g(2),
   'business_date','2026-10-21','error_path','checks','raw_sha256',repeat('f',64),'source_page',1,'source_index',2))
   else '[]'::jsonb end)
$$;

-- A café with one verified Toast restaurant.
CREATE FUNCTION pg_temp.cafe(n integer) RETURNS uuid LANGUAGE plpgsql AS $$
declare b uuid:=('dededede-dede-4ede-8ede-'||lpad(to_hex(n),12,'0'))::uuid;
 r uuid:=('dededede-dede-4ede-8ede-'||lpad(to_hex(n+256),12,'0'))::uuid;
 loc uuid:=('dededede-dede-4ede-8ede-'||lpad(to_hex(n+512),12,'0'))::uuid;
begin
 insert into public.businesses(id,name,is_demo) values(b,'Messy import café '||n,false);
 insert into public.locations(id,business_id,name) values(loc,b,'Messy location '||n);
 perform public.toast_save_configuration(b,'https://ws-api.toasttab.com','messy_'||n,'synthetic_ciphertext',
  jsonb_build_array(jsonb_build_object('location_id',loc,'restaurant_guid',r)));
 update public.toast_location_mappings set verified_at=now(),toast_time_zone='America/Los_Angeles',
  closeout_hour=4,toast_start_date='2026-10-21' where business_id=b;
 return b;
end $$;
CREATE FUNCTION pg_temp.rest(b uuid) RETURNS uuid LANGUAGE sql AS
$$ select restaurant_guid from public.toast_location_mappings where business_id=b $$;
CREATE FUNCTION pg_temp.loc(b uuid) RETURNS uuid LANGUAGE sql AS
$$ select location_id from public.toast_location_mappings where business_id=b $$;

-- One import: stage the pages on a new run, then commit (or crash before committing).
CREATE FUNCTION pg_temp.import_day(b uuid,pages jsonb,orders jsonb,summary jsonb,crash boolean default false)
RETURNS void LANGUAGE plpgsql AS $$
declare run uuid; p record;
begin
 insert into public.toast_sync_runs(business_id,restaurant_guid,kind,state)
  values(b,pg_temp.rest(b),'daily','running') returning id into run;
 for p in select x.v,x.i from jsonb_array_elements(pages) with ordinality x(v,i) loop
  insert into public.toast_day_pages(run_id,business_date,page,payload) values(run,'2026-10-21',p.i,p.v);
 end loop;
 if crash then
  update public.toast_sync_runs set state='failed' where id=run;
  return;
 end if;
 perform public.toast_import_day(b,pg_temp.loc(b),pg_temp.rest(b),'2026-10-21',orders,summary,run);
end $$;

-- Everything stored for a café, without its own IDs, run IDs or times.
CREATE FUNCTION pg_temp.stored(b uuid) RETURNS jsonb LANGUAGE sql AS $$
 select jsonb_build_object(
  'orders',(select jsonb_agg(jsonb_build_array(split_part(o.pos_order_id,':',3),o.gross_sales_cents,
    o.discounts_cents,o.refunds_cents,o.tax_cents,o.tip_cents,o.net_sales_cents,o.toast_excluded)
    order by o.pos_order_id) from public.orders o where o.business_id=b),
  'lines',(select jsonb_agg(jsonb_build_array(split_part(o.pos_order_id,':',3),l.pos_line_id,l.name,l.quantity,
    l.net_sales_cents,l.voided,l.category) order by o.pos_order_id,l.pos_line_id)
    from public.order_lines l join public.orders o on o.id=l.order_id where o.business_id=b),
  'archive',(select jsonb_agg(jsonb_build_array(r.entity_guid,md5(public.toast_stable_json(r.payload)::text))
    order by r.entity_guid) from public.toast_raw_records r where r.business_id=b and r.entity='order'),
  'typed',(select jsonb_agg(jsonb_build_array(t.order_guid,t.check_discounts,t.item_taxes,t.modifier_prices,
    t.void_details,t.refund_details) order by t.order_guid)
    from public.toast_order_typed_facts t where t.business_id=b),
  'voids',(select jsonb_agg(jsonb_build_array(v.selection_guid,v.amount_cents,v.void_business_date)
    order by v.selection_guid) from public.toast_void_facts v where v.business_id=b),
  'refunds',(select jsonb_agg(jsonb_build_array(f.payment_guid,f.amount_cents,f.refund_business_date)
    order by f.payment_guid) from public.toast_refund_facts f where f.business_id=b),
  'fees',(select jsonb_agg(jsonb_build_array(f.payment_type,f.amount_cents,f.tip_cents,
    f.original_processing_fee_cents,f.processing_fee_cents,f.status) order by f.amount_cents,f.payment_type)
    from public.toast_payment_facts f where f.business_id=b),
  'day',(select jsonb_build_array(d.import_state,d.net_sales_cents,d.order_count,d.tip_cents,d.refunds_cents)
    from public.toast_day_status d where d.business_id=b),
  'rollup',(select jsonb_build_array(r.net_sales_cents,r.orders_count) from public.daily_rollups r
    where r.business_id=b and r.business_date='2026-10-21'),
  'changes',(select count(*) from public.toast_raw_changes c where c.business_id=b))
$$;

DO $messy$
DECLARE
 clean uuid:=pg_temp.cafe(1); repull uuid:=pg_temp.cafe(2); shuffled uuid:=pg_temp.cafe(3);
 two_pages uuid:=pg_temp.cafe(4); retry uuid:=pg_temp.cafe(5); partial uuid:=pg_temp.cafe(6);
 changed uuid:=pg_temp.cafe(7); clean_new uuid:=pg_temp.cafe(8);
 ref jsonb; got jsonb; raw jsonb:=pg_temp.raw_orders(1,false);
BEGIN
 -- Reference: one clean import.
 perform pg_temp.import_day(clean,jsonb_build_array(raw),pg_temp.app_orders(pg_temp.rest(clean),1,false,false),
  pg_temp.app_summary(1,false));
 ref:=pg_temp.stored(clean);
 perform pg_temp.assert_true(jsonb_array_length(ref->'orders')=2 and jsonb_array_length(ref->'lines')=4
  and jsonb_array_length(ref->'archive')=2 and jsonb_array_length(ref->'voids')=1
  and jsonb_array_length(ref->'refunds')=1 and (ref->>'changes')::int=0,
  'the clean import stores each order, item, void and refund once, got '||ref::text);

 -- Re-pull: the same day imported three times.
 for i in 1..3 loop
  perform pg_temp.import_day(repull,jsonb_build_array(raw),pg_temp.app_orders(pg_temp.rest(repull),1,false,false),
   pg_temp.app_summary(1,false));
 end loop;
 got:=pg_temp.stored(repull);
 perform pg_temp.assert_true(got=ref,'three re-pulls store the same rows as one import: '||got::text);

 -- Shuffled: every list inside every order reversed, page order reversed, lines reversed.
 perform pg_temp.import_day(shuffled,jsonb_build_array(raw),pg_temp.app_orders(pg_temp.rest(shuffled),1,false,false),
  pg_temp.app_summary(1,false));
 perform pg_temp.import_day(shuffled,jsonb_build_array(pg_temp.raw_orders(1,true)),
  pg_temp.app_orders(pg_temp.rest(shuffled),1,false,true),pg_temp.app_summary(1,false));
 got:=pg_temp.stored(shuffled);
 perform pg_temp.assert_true(got=ref,'a shuffled re-pull changes nothing and logs nothing: '||got::text);

 -- One order on two pages.
 perform pg_temp.import_day(two_pages,jsonb_build_array(raw,jsonb_build_array(raw->1)),
  pg_temp.app_orders(pg_temp.rest(two_pages),1,false,false),pg_temp.app_summary(1,false));
 got:=pg_temp.stored(two_pages);
 perform pg_temp.assert_true(got=ref,'an order on two pages is stored once: '||got::text);

 -- A run that staged the day and crashed, then a retry on a new run.
 perform pg_temp.import_day(retry,jsonb_build_array(raw),null,null,true);
 perform pg_temp.import_day(retry,jsonb_build_array(raw),pg_temp.app_orders(pg_temp.rest(retry),1,false,false),
  pg_temp.app_summary(1,false));
 got:=pg_temp.stored(retry);
 perform pg_temp.assert_true(got=ref,'a crashed run then a retry store the same rows as one import: '||got::text);

 -- A partial day (second order could not be read), then the full day.
 perform pg_temp.import_day(partial,jsonb_build_array(jsonb_build_array(raw->0)),
  pg_temp.app_orders(pg_temp.rest(partial),1,true,false),pg_temp.app_summary(1,true));
 perform pg_temp.assert_true((select count(*)=1 from public.orders where business_id=partial),
  'the partial day stores only the order it could read');
 perform pg_temp.import_day(partial,jsonb_build_array(raw),pg_temp.app_orders(pg_temp.rest(partial),1,false,false),
  pg_temp.app_summary(1,false));
 got:=pg_temp.stored(partial);
 perform pg_temp.assert_true(got=ref,'a partial day then the full day store the same rows as one import: '||got::text);

 -- Control: a real change (tip 1.00 -> 2.50) gives the new data plus one change line.
 perform pg_temp.import_day(changed,jsonb_build_array(raw),pg_temp.app_orders(pg_temp.rest(changed),1,false,false),
  pg_temp.app_summary(1,false));
 perform pg_temp.import_day(changed,jsonb_build_array(pg_temp.raw_orders(2.5,true)),
  pg_temp.app_orders(pg_temp.rest(changed),2.5,false,true),pg_temp.app_summary(2.5,false));
 perform pg_temp.import_day(clean_new,jsonb_build_array(pg_temp.raw_orders(2.5,false)),
  pg_temp.app_orders(pg_temp.rest(clean_new),2.5,false,false),pg_temp.app_summary(2.5,false));
 got:=pg_temp.stored(changed); ref:=pg_temp.stored(clean_new);
 perform pg_temp.assert_true((got-'changes')=(ref-'changes'),
  'a changed tip stores the same rows as a clean import of the new data: '||got::text||' vs '||ref::text);
 perform pg_temp.assert_true((got->>'changes')::int=1 and (ref->>'changes')::int=0,
  'the change is logged once, got '||(got->>'changes'));
 perform pg_temp.assert_true((select c.changes->0->>'path' like '%tipAmount' from public.toast_raw_changes c
  where c.business_id=changed),'the change line is the tip');
END $messy$;

ROLLBACK;
