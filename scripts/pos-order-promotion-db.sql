-- Run against a disposable migrated database only.
\set ON_ERROR_STOP on
begin;

do $test$
declare
  cafe uuid := gen_random_uuid();
  other_cafe uuid := gen_random_uuid();
  location uuid := gen_random_uuid();
  other_location uuid := gen_random_uuid();
  saved_order uuid;
  day date := current_date - 1;
  header jsonb;
begin
  if has_function_privilege('anon','public.pos_commit_order(uuid,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.pos_refresh_daily_fees(uuid,date,text)','EXECUTE') then
    raise exception 'Anonymous role can mutate POS orders or fees';
  end if;
  insert into public.businesses(id,name) values(cafe,'Order promotion fixture'),(other_cafe,'Other fixture');
  insert into public.locations(id,business_id,name)
    values(location,cafe,'Main'),(other_location,other_cafe,'Other');
  insert into public.orders(business_id,location_id,pos_order_id,closed_at,business_date,
    gross_sales_cents,net_sales_cents) values(cafe,location,'pos-fixture',now(),day,100,100)
    returning id into saved_order;
  insert into public.order_lines(order_id,name,quantity,net_sales_cents)
    values(saved_order,'Original item',1,100);
  header := jsonb_build_object(
    'location_id',location,'pos_order_id','pos-fixture','closed_at',now(),'business_date',day,
    'gross_sales_cents',250,'discounts_cents',0,'refunds_cents',0,'tax_cents',0,'tip_cents',0,
    'processing_fee_cents',0,'processing_fee_status','actual','processing_fee_provider','square',
    'net_sales_cents',250);

  begin
    perform public.pos_commit_order(cafe,header,
      '[{"name":"Invalid revision","quantity":null,"net_sales_cents":250}]');
    raise exception 'Invalid revision was accepted';
  exception when not_null_violation then null;
  end;
  if not exists (select 1 from public.orders where id=saved_order and net_sales_cents=100)
    or not exists (select 1 from public.order_lines where order_id=saved_order and name='Original item') then
    raise exception 'Line rejection changed the saved order or detail';
  end if;
  begin
    perform public.pos_commit_order(cafe,header || jsonb_build_object('location_id',other_location),'[]');
    raise exception 'Foreign location was accepted';
  exception when raise_exception then
    if sqlerrm <> 'POS order refers to another or missing café location or employee' then raise; end if;
  end;

  perform public.pos_commit_order(cafe,header,'[{"name":"New item","quantity":1,"net_sales_cents":250}]');
  if not exists (select 1 from public.orders where id=saved_order and net_sales_cents=250)
    or (select array_agg(name) from public.order_lines where order_id=saved_order)
      is distinct from array['New item'] then
    raise exception 'Retry did not replace both the order and its line set in place';
  end if;

  perform public.upsert_processing_fee_daily_candidate(cafe,day,500,'actual','manual_actual','merchant-report');
  insert into public.orders(business_id,location_id,pos_order_id,closed_at,business_date,
    gross_sales_cents,net_sales_cents,processing_fee_cents,processing_fee_status,processing_fee_provider)
  select cafe,location,'fee-fixture-'||i,now(),day,100,100,1,'actual','square' from generate_series(1,1001) i;

  perform public.pos_refresh_daily_fees(cafe,day,'square');
  if not exists (select 1 from public.processing_fee_daily_facts
    where business_id=cafe and business_date=day and source_type='connected_pos_actual' and amount_cents=1001) then
    raise exception 'Connected day fee did not include the full eligible order set including explicit zero';
  end if;

  update public.orders set processing_fee_status='missing'
    where business_id=cafe and pos_order_id='fee-fixture-1001';
  perform public.pos_refresh_daily_fees(cafe,day,'square');
  if not exists (select 1 from public.processing_fee_daily_facts
    where business_id=cafe and business_date=day and source_type='manual_actual' and amount_cents=500) then
    raise exception 'A late missing order fee did not restore the manual actual';
  end if;
end;
$test$;

rollback;
