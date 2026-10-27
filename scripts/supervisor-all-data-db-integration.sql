-- PR #202 disposable database, never production. Run after all migrations,
-- replay 102 twice, then perform these assertions in a rolled-back transaction.
\set ON_ERROR_STOP on
begin;
do $checks$
declare
 n integer;
 def text;
begin
 select count(*) into n from information_schema.columns where table_schema='public'
 and table_name='businesses' and column_name in
 ('target_ingredient_cost_rate','target_ingredient_cost_rate_status','owner_monthly_payroll_extras_cents','owner_monthly_payroll_extras_updated_at');
 if n<>4 then raise exception 'Financial settings columns missing (%)',n;end if;
 if not exists (select 1 from pg_constraint where conrelid='public.businesses'::regclass
   and conname='businesses_target_ingredient_rate_guard')
 then raise exception 'Ingredient rate CHECK missing';end if;
 if not exists (select 1 from pg_constraint where conrelid='public.businesses'::regclass
   and contype='c' and pg_get_constraintdef(oid) like '%owner_monthly_payroll_extras_cents%'
    and pg_get_constraintdef(oid) like '%>= 0%')
 then raise exception 'Owner payroll extras nonnegative CHECK missing';end if;
 if not exists (select 1 from pg_indexes where schemaname='public'
   and indexname='toast_one_cafe_per_restaurant_uidx')
 then raise exception 'Toast tenant-wide uniqueness missing';end if;
 if not exists (select 1 from pg_indexes where schemaname='public'
   and indexname='square_one_cafe_per_location_uidx')
 then raise exception 'Square tenant-wide uniqueness missing';end if;
 foreach def in array array[
   'toast_rollup_refresh_jobs','toast_analytics_credentials',
   'toast_analytics_rate_calls','toast_first_import_check','square_sync_leases'
 ] loop
  if not exists (select 1 from pg_constraint c where c.contype='f'
    and c.confrelid='public.businesses'::regclass
    and c.conrelid=to_regclass('public.'||def) and c.confdeltype='c')
   then raise exception '% missing business cascading deletion',def;end if;
 end loop;
 if not (select relrowsecurity from pg_class where oid='public.square_sync_leases'::regclass)
 then raise exception 'Square lease RLS missing';end if;
 if has_table_privilege('authenticated','public.square_sync_leases','SELECT')
 then raise exception 'Square service lease leaked to authenticated role';end if;
 if has_function_privilege('authenticated','public.square_claim_sync_lease(uuid,integer)','EXECUTE')
 then raise exception 'Square lease RPC leaked to authenticated role';end if;
 if not has_function_privilege('service_role','public.square_claim_sync_lease(uuid,integer)','EXECUTE')
 then raise exception 'Square service lease RPC unavailable';end if;
 def:=pg_get_functiondef('public.toast_import_day(uuid,uuid,uuid,date,jsonb,jsonb,uuid)'::regprocedure);
 if def not like '%employee_id=excluded.employee_id%' or
    def not like '%source_channel=excluded.source_channel%' or
    def not like '%guest_count=excluded.guest_count%'
 then raise exception 'Toast canonical order enrichment missing';end if;
 def:=pg_get_functiondef('public.pantry_usage_sales_evidence(uuid,date,date)'::regprocedure);
 if def not like '%public.timecards%' or def like '%from public.toast_labor_entries%'
 then raise exception 'Usage still depends on provider-specific Toast attendance';end if;
 if not exists(select 1 from pg_constraint
   where conrelid='public.pos_scheduled_shifts'::regclass
    and conname='pos_scheduled_shifts_supported_provider')
 then raise exception 'Shared Square/Toast scheduled-shift provider CHECK missing';end if;
end $checks$;
-- Two actual ephemeral café rows prove deletion does not delete another tenant,
-- and a duplicated Square location / Toast restaurant cannot be linked twice.
do $tenant$
declare
 a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();
 la uuid:=gen_random_uuid();lb uuid:=gen_random_uuid();
 ga uuid:=gen_random_uuid();gb uuid:=gen_random_uuid();
 duplicateBlocked boolean;
 orderId uuid:=gen_random_uuid();
 ownerId uuid:=gen_random_uuid();
 toastModifierId uuid:=gen_random_uuid();
 foreignModifierId uuid:=gen_random_uuid();
 toastRecipeId uuid:=gen_random_uuid();
 pantryRecipeId uuid:=gen_random_uuid();
 foreignRecipeId uuid:=gen_random_uuid();
 linkedMenuItemId uuid:=gen_random_uuid();
 linkedToastItemGuid uuid:=gen_random_uuid();
 linkedEmployeeId uuid:=gen_random_uuid();
 linkedToastEmployeeGuid uuid:=gen_random_uuid();
 usage jsonb;
begin
 insert into public.businesses(id,name) values(a,'Migration A'),(b,'Migration B');
 -- A malformed resync must roll back replacement and keep old item details.
 insert into public.orders(id,business_id,pos_order_id,closed_at,business_date,
   gross_sales_cents,net_sales_cents)
 values(orderId,a,'square:rollback-check',now(),'2026-10-25',100,100);
 insert into public.order_lines(order_id,name,quantity,net_sales_cents)
 values(orderId,'Original item',1,100);
 begin
  perform public.pos_replace_order_lines(a,orderId,
   '[{"name":"Replacement","quantity":null,"net_sales_cents":200}]'::jsonb);
  raise exception 'Invalid POS item accepted';
 exception when not_null_violation then null;
 end;
 if not exists(select 1 from public.order_lines
   where order_id=orderId and name='Original item')
 then raise exception 'POS order-line replacement lost existing rows';end if;
 perform public.pos_replace_order_lines(a,orderId,'[]'::jsonb);
 if exists(select 1 from public.order_lines where order_id=orderId)
 then raise exception 'POS zero-line replacement did not clear previous lines';end if;
 insert into public.locations(id,business_id,name,pos_location_id)
 values(la,a,'A Location','square-'||a::text),(lb,b,'B Location','square-'||b::text);
 duplicateBlocked:=false;
 begin
  update public.locations set pos_location_id='square-'||a::text where id=lb;
 exception when unique_violation then duplicateBlocked:=true;
 end;
 if not duplicateBlocked then raise exception 'Square cross-café location duplicate accepted';end if;
 insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc)
 values(a,'https://example.invalid','integration-a','synthetic'),
       (b,'https://example.invalid','integration-b','synthetic');
 insert into public.toast_location_mappings(business_id,location_id,restaurant_guid)
 values(a,la,ga);
 duplicateBlocked:=false;
 begin
  insert into public.toast_location_mappings(business_id,location_id,restaurant_guid)
  values(b,lb,ga);
 exception when unique_violation then duplicateBlocked:=true;
 end;
 if not duplicateBlocked then raise exception 'Toast restaurant linked to two cafés';end if;
 insert into public.toast_location_mappings(business_id,location_id,restaurant_guid)
 values(b,lb,gb);
 -- Real invocation: a linked Toast catalog modifier and an owner-linked pantry
 -- modifier must both survive in the scoped, JSONB-concatenated mapping array.
 insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 values(ownerId,'00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','usage-'||ownerId::text||'@example.invalid','',now(),now());
 insert into public.memberships(business_id,user_id,role) values(a,ownerId,'owner');
 insert into public.modifier_recipes(id,business_id,pos_modifier_id,name)
 values(toastRecipeId,a,'toast-test-modifier','Toast linked recipe'),
       (pantryRecipeId,a,'pantry-test-modifier','Pantry linked recipe'),
       (foreignRecipeId,b,'other-cafe-modifier','Another cafe recipe');
 insert into public.menu_items(id,business_id,name,base_name)
 values(linkedMenuItemId,a,'Toast catalog linked drink','Toast catalog linked drink');
 insert into public.employees(id,business_id,display_name,active)
 values(linkedEmployeeId,a,'Linked Toast staff',true);
 insert into public.toast_employee_directory(
  business_id,restaurant_guid,employee_guid,display_name,linked_employee_id,linked_at)
 values(a,ga,linkedToastEmployeeGuid,'Linked Toast staff',linkedEmployeeId,now());
 insert into public.toast_catalog_facts(
  business_id,restaurant_guid,kind,provider_guid,name,linked_menu_item_id)
 values(a,ga,'item',linkedToastItemGuid,'Linked Toast item',linkedMenuItemId);
 insert into public.toast_catalog_facts(
  business_id,restaurant_guid,kind,provider_guid,name,linked_modifier_recipe_id)
 values(a,ga,'modifier',toastModifierId,'Linked Toast modifier',toastRecipeId),
       (b,gb,'modifier',foreignModifierId,'Foreign Toast modifier',foreignRecipeId);
 insert into public.toast_catalog_price_versions(
  business_id,restaurant_guid,kind,provider_guid,price_fingerprint,
  price_cents,name)
 values(a,ga,'modifier',toastModifierId,'modifier-test-price',50,'Linked Toast modifier'),
       (a,ga,'item',linkedToastItemGuid,'item-test-price',500,'Linked Toast item');
 insert into public.pantry_modifier_links(
  business_id,provider,location_ref,pos_modifier_id,modifier_recipe_id)
 values(a,'square','test-square-location','test-square-modifier',pantryRecipeId);
 perform set_config('request.jwt.claim.sub',ownerId::text,true);
 usage:=public.pantry_usage_sales_evidence(a,date '2026-10-25',date '2026-10-25');
 if not exists(select 1 from jsonb_array_elements(usage->'modifierMappings') as m(value)
  where m.value=jsonb_build_object('provider','toast','locationRef',ga::text,
   'posModifierId',toastModifierId::text,'recipeId',toastRecipeId::text))
 then raise exception 'Linked Toast catalog modifier absent from modifierMappings';end if;
 if not exists(select 1 from jsonb_array_elements(usage->'modifierMappings') as m(value)
  where m.value=jsonb_build_object('provider','square','locationRef','test-square-location',
   'posModifierId','test-square-modifier','recipeId',pantryRecipeId::text))
 then raise exception 'Pantry modifier mapping lost when Toast catalog mapping restored';end if;
 if jsonb_array_length(usage->'modifierMappings')<>2 or exists(
  select 1 from jsonb_array_elements(usage->'modifierMappings') as m(value)
  where m.value->>'recipeId'=foreignRecipeId::text
 ) then raise exception 'Modifier mappings leaked between cafés or were duplicated';end if;
 perform set_config('request.jwt.claim.sub','',true);
 insert into public.toast_analytics_credentials(
  business_id,management_group_guid,api_origin,client_id,client_secret_enc)
 values(a,gen_random_uuid(),'https://example.invalid','integration-a','synthetic'),
       (b,gen_random_uuid(),'https://example.invalid','integration-b','synthetic');
 insert into public.toast_analytics_rate_calls(business_id,kind)
 values(a,'get'),(b,'get');
 insert into public.toast_first_import_check(business_id) values(a),(b);
 insert into public.toast_rollup_refresh_jobs(business_id,business_date)
 values(a,'2026-10-25'),(b,'2026-10-25');
 insert into public.square_sync_leases(business_id) values(a),(b);
 delete from public.businesses where id=a;
 if exists(select 1 from public.businesses where id=a)
  or exists(select 1 from public.toast_analytics_credentials where business_id=a)
  or exists(select 1 from public.toast_analytics_rate_calls where business_id=a)
  or exists(select 1 from public.toast_first_import_check where business_id=a)
  or exists(select 1 from public.toast_rollup_refresh_jobs where business_id=a)
  or exists(select 1 from public.square_sync_leases where business_id=a)
 then raise exception 'Deleted tenant retained orphan rows';end if;
 if not exists(select 1 from public.businesses where id=b)
  or not exists(select 1 from public.toast_analytics_credentials where business_id=b)
  or not exists(select 1 from public.toast_analytics_rate_calls where business_id=b)
  or not exists(select 1 from public.toast_first_import_check where business_id=b)
  or not exists(select 1 from public.toast_rollup_refresh_jobs where business_id=b)
  or not exists(select 1 from public.square_sync_leases where business_id=b)
 then raise exception 'Tenant deletion damaged a different café';end if;
end $tenant$;

rollback;
