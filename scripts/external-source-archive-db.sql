-- Run on a seeded, disposable database with the full migration chain.
\set ON_ERROR_STOP on
begin;
do $$
declare cafe uuid; other uuid; owner_id uuid; rec uuid; before_rev bigint;
  merchant uuid:=gen_random_uuid(); native_id uuid:=gen_random_uuid(); menu_id uuid:=gen_random_uuid();
  square_item uuid:=gen_random_uuid();
  today date; status text; candidate record;
  publication text:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
begin
  select m.business_id,m.user_id into strict cafe,owner_id from public.memberships m
    where m.role='owner' and m.business_id <> '11111111-1111-1111-1111-111111111111' limit 1;
  select id into strict other from public.businesses where id <> cafe limit 1;
  select (now() at time zone timezone)::date into strict today from public.businesses where id=cafe;
  perform public.external_discover_resources(cafe,'fixture-provider','merchant:4',clock_timestamp(),
    '[{"resource":"activity","permission":"read:activity","granted":true},
      {"resource":"future","permission":"read:future","granted":false}]');
  select e.status into strict status from public.external_resources e where e.business_id=cafe and e.resource='future';
  if status<>'permission_required' then raise exception 'Capability discovery lost permission status'; end if;
  perform public.external_commit_page(cafe,'fixture-provider','merchant:4','activity','one',0,
    '"next"',false,'[{"key":"not-a-guid","payload":{"future.tax":null,"labels":["old"]}}]');
  perform public.external_commit_page(cafe,'fixture-provider','merchant:4','activity','one',1,
    null,true,'[{"key":"not-a-guid","payload":{"labels":["new"],"optional":null}}]');
  select id into strict rec from public.external_records where business_id=cafe and provider='fixture-provider'
    and source_account='merchant:4' and source_key='not-a-guid' and payload='{"labels":["new"],"optional":null}';
  if not exists (select 1 from public.external_record_changes where record_id=rec and changes @>
    '[{"segments":["future.tax"],"before_present":true,"after_present":false},{"segments":["optional"],"before_present":false,"after_present":true},{"segments":["labels","0"],"before":"old","after":"new"}]')
  then raise exception 'Missing change or ambiguous null history'; end if;
  begin
    perform public.external_commit_page(cafe,'fixture-provider','merchant:4','activity','one',1,null,true,'[]');
    raise exception 'Accepted a stale checkpoint';
  exception when serialization_failure then null; end;
  begin
    perform public.external_commit_page(cafe,'fixture-provider','merchant:4','activity','one',2,null,true,
      '[{"key":"a","payload":{"amount":3}},{"key":"z"}]');
    raise exception 'Expected missing identity/payload failure';
  exception when raise_exception then
    if sqlerrm <> 'Missing external record identity or payload' then raise; end if;
  end;
  select revision into strict before_rev from public.external_sync_checkpoints
   where business_id=cafe and provider='fixture-provider' and stream='one';
  if before_rev<>2 or exists(select 1 from public.external_records where business_id=cafe and source_key='a') then
    raise exception 'Partial page committed'; end if;
  perform public.external_commit_page(cafe,'fixture-provider','merchant:4','public_documents','city',0,
    '{"cursor":"opaque","scope":{"edition":"first"}}',false,
    '[{"key":"notice-1","payload":{"appendix":{"unfamiliar title":[null,2]}}}]');
  begin
    perform public.external_read_observation(cafe,'fixture-provider','merchant:4','public_documents','city',1,null);
    raise exception 'Unfinished observation reported as complete';
  exception when serialization_failure then null; end;
  perform public.external_commit_page(cafe,'fixture-provider','merchant:4','public_documents','city',1,
    '{"cursor":null,"scope":{"edition":"first"}}',true,
    '[{"key":"notice-2","payload":{"appendix":{"unfamiliar title":[3,null]}}}]');
  if (select count(*) from public.external_read_observation(cafe,'fixture-provider','merchant:4','public_documents','city',2,null))<>2
     or not exists(select from public.external_resources e where e.business_id=cafe
       and e.resource='public_documents' and e.last_complete_scope->>'edition'='first') then
    raise exception 'Completed observation lost a page or its scope'; end if;
  perform public.external_commit_page(cafe,'fixture-provider','merchant:4','public_documents','another city',0,
    null,true,'[{"key":"notice-1","payload":{"appendix":{"unfamiliar title":[null,2]}}}]');
  if (select count(*) from public.external_read_observation(cafe,'fixture-provider','merchant:4','public_documents','city',2,null))<>2 then
    raise exception 'Overlapping observation overwrote prior membership'; end if;

  -- The same merchant object can occur in more than one coverage window.
  -- A valid late change may advance the original, but cannot silently change
  -- the payload certified by the earlier receipt.
  perform public.external_commit_page(cafe,'square','merchant:7','orders','location:a',0,
    '{"mode":"window","scope":{"location":"a","from":"2026-10-01","through":"2026-10-02"}}',true,
    '[{"key":"order-1","updated_at":"2026-10-02T12:00:00Z","payload":{"amount":700}}]');
  perform public.external_commit_page(cafe,'square','merchant:7','orders','location:a',1,
    '{"mode":"window","scope":{"location":"a","from":"2026-10-02","through":"2026-10-03"},"cursor":"next"}',false,'[]');
  if not exists(select from public.external_read_observation(cafe,'square','merchant:7','orders','location:a',1,null,
    '{"location":"a","from":"2026-10-01","through":"2026-10-02"}','window') where payload->>'amount'='700') then
    raise exception 'Starting a traversal discarded the previous completed receipt';
  end if;
  begin
    perform public.external_commit_page(cafe,'square','merchant:7','orders','location:a',2,
      '{"mode":"window","scope":{"location":"b","from":"2026-10-02","through":"2026-10-03"}}',true,'[]');
    raise exception 'Accepted a changed scope on a continuation';
  exception when raise_exception then
    if sqlerrm<>'External page does not match the active observation scope' then raise; end if;
  end;
  perform public.external_commit_page(cafe,'square','merchant:7','orders','modified:a',0,
    '{"mode":"incremental","scope":{"location":"a","modified_from":"2026-10-03"}}',true,
    '[{"key":"order-1","updated_at":"2026-10-03T12:00:00Z","payload":{"amount":600}}]');
  begin
    perform public.external_read_observation(cafe,'square','merchant:7','orders','location:a',1,null,
      '{"location":"a","from":"2026-10-01","through":"2026-10-02"}','window');
    raise exception 'Returned a payload that the window did not observe';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    perform public.external_read_observation(cafe,'square','merchant:7','orders','modified:a',1,null,
      '{"location":"b","modified_from":"2026-10-03"}','incremental');
    raise exception 'Accepted another location as completed coverage';
  exception when serialization_failure then null; end;
  if exists(select from public.external_records r join public.external_resources e
       on (r.business_id,r.provider,r.source_account,r.entity)=(e.business_id,e.provider,e.source_account,e.resource)
       where r.business_id=cafe and r.source_account='merchant:7' and public.external_current_observation(r,e))
     or not exists(select from public.external_read_observation(cafe,'square','merchant:7','orders','modified:a',1,null,
       '{"location":"a","modified_from":"2026-10-03"}','incremental') where payload->>'amount'='600') then
    raise exception 'An incremental receipt became unscoped current evidence or lost its observed payload';
  end if;
  perform public.external_commit_page(cafe,'square','merchant:7','orders','location:a',2,
    '{"mode":"window","scope":{"location":"a","from":"2026-10-02","through":"2026-10-03"}}',true,
    '[{"key":"order-1","updated_at":"2026-10-02T12:00:00Z","payload":{"amount":700}}]');
  begin
    perform public.external_read_observation(cafe,'square','merchant:7','orders','location:a',3,null,
      '{"location":"a","from":"2026-10-02","through":"2026-10-03"}','window');
    raise exception 'A stale provider page certified a newer payload';
  exception when object_not_in_prerequisite_state then null; end;

  perform public.external_commit_page(cafe,'square','merchant:7','orders','location:c',0,
    '{"mode":"window","scope":{"location":"c"}}',true,'[{"key":"order-c","payload":{"amount":310}}]');
  perform public.external_commit_page(cafe,'square','merchant:7','orders','location:c',1,
    '{"mode":"window","scope":{"location":"c"},"cursor":"old grant cursor"}',false,
    '[{"key":"pending-c","payload":{"amount":100}}]');
  perform public.external_note_availability(cafe,'square','merchant:7','orders','permission_required',clock_timestamp(),null);
  perform public.external_commit_page(cafe,'square','merchant:7','orders','location:d',0,
    '{"mode":"window","scope":{"location":"d"}}',true,'[{"key":"order-d","payload":{"amount":120}}]');
  begin
    perform public.external_commit_page(cafe,'square','merchant:7','orders','location:c',2,
      '{"mode":"window","scope":{"location":"c"}}',true,'[]');
    raise exception 'Used a continuation from before permission was lost';
  exception when serialization_failure then null; end;
  begin
    perform public.external_read_observation(cafe,'square','merchant:7','orders','location:c',1,null,
      '{"location":"c"}','window');
    raise exception 'A new location restored stale coverage under the former grant';
  exception when serialization_failure then null; end;
  if not exists(select from public.external_observation_members m join public.external_records r
    on (r.business_id,r.provider,r.id)=(m.business_id,m.provider,m.record_id)
    where r.business_id=cafe and r.source_key='order-c') then
    raise exception 'Revocation erased historical source evidence'; end if;
  perform public.external_commit_page(cafe,'square','merchant:7','orders','location:c',3,
    '{"mode":"window","scope":{"location":"c"}}',true,'[{"key":"order-c","payload":{"amount":310}}]');
  if (select count(*) from public.external_read_observation(cafe,'square','merchant:7','orders','location:c',4,null,
       '{"location":"c"}','window'))<>1 then raise exception 'Fresh first page did not restore coverage'; end if;

  perform public.external_commit_page(other,'fixture-provider','merchant:4','activity','one',0,null,true,
    '[{"key":"not-a-guid","payload":{"private":true}}]');
  perform public.external_commit_page(cafe,'fixture-provider','merchant:4','annotations','one',0,null,true,
    '[{"key":"note","payload":{"sourceReference":"object-24"},"identifiers":[
       {"namespace":"origin","value":"object-24","relationship":"annotates","shared":true,"selector":{"path":[]}}]}]');
  perform public.external_commit_page(cafe,'another-provider','merchant:5','source_objects','one',0,null,true,
    '[{"key":"object-24","payload":{"unexpected field":{"a.b":[true,3]}},"identifiers":[
       {"namespace":"origin","value":"object-24","shared":true,"selector":{"path":[]}}]}]');
  perform public.external_commit_page(other,'another-provider','merchant:5','source_objects','one',0,null,true,
    '[{"key":"object-24","payload":{"private":true},"identifiers":[
       {"namespace":"origin","value":"object-24","shared":true,"selector":{"path":[]}}]}]');
  select * into strict candidate from public.external_relationship_candidates
    where business_id=cafe and relationship='annotates';
  if candidate.match_status<>'matched' or candidate.target_provider<>'another-provider' then
    raise exception 'Shared identifier relationship failed'; end if;
  perform public.external_commit_page(cafe,'fixture-provider','merchant:4','source_objects','one',0,null,true,
    '[{"key":"overlap","payload":{"available":null},"identifiers":[
       {"namespace":"origin","value":"object-24","shared":true,"selector":{"path":[]}}]}]');
  if (select count(*) from public.external_identity_authority a where a.business_id=cafe
      and a.value='object-24' and a.authority='overlap')<>2 then
    raise exception 'Overlapping identities selected without authority evidence'; end if;
  insert into public.external_record_links(business_id,provider,record_id,relation,target_provider,target_id,
    selector,evidence)
  select a.business_id,a.provider,a.record_id,'authoritative_for',b.provider,b.record_id,
    a.selector,jsonb_build_object('namespace',a.namespace,'value',a.value,'target_selector',b.selector)
  from public.external_identity_authority a join public.external_identity_authority b using(business_id,namespace,value)
  where a.business_id=cafe and a.provider='another-provider' and b.provider='fixture-provider';
  if not exists(select from public.external_identity_authority a where a.business_id=cafe
    and a.provider='another-provider' and a.authority='selected') then
    raise exception 'Explicit evidence did not reconcile shared identities'; end if;

  insert into public.ingredients(id,business_id,name,base_unit) values(native_id,cafe,'Native ingredient','g');
  perform public.external_bind_native_identities(cafe,'another-provider','merchant:5','source_objects','origin',
    'public.ingredients',jsonb_build_array(jsonb_build_object('native_id',native_id,'source_id','object-24')));
  if not exists(select from public.external_record_links l where l.business_id=cafe
    and l.native_relation='public.ingredients' and l.native_key=jsonb_build_object('id',native_id)) then
    raise exception 'Native identity did not link to source'; end if;
  begin
    perform public.external_bind_native_identities(other,'another-provider','merchant:5','source_objects','origin',
      'public.ingredients',jsonb_build_array(jsonb_build_object('native_id',native_id,'source_id','object-24')));
    raise exception 'Cross-café native identity accepted';
  exception when raise_exception then
    if sqlerrm<>'Native identity outside café or duplicated' then raise; end if;
  end;

  perform public.external_commit_page(cafe,'toast',merchant::text,'stock/v1/inventory','current',0,null,true,
    jsonb_build_array(jsonb_build_object('key','source-item','business_date',today,
      'restaurant_guid',merchant,'payload','{"quantity":3,"status":"QUANTITY"}'::jsonb),
      jsonb_build_object('key','unaffected-item','business_date',today,
      'restaurant_guid',merchant,'payload','{"quantity":5,"status":"QUANTITY"}'::jsonb)));
  if not exists (select from public.inventory_evidence_for(cafe,today,today)
    where menu_item_ref='source-item' and quantity=3 and data->>'evidence_state'='observed_current') then
    raise exception 'Complete original stock observation not shown'; end if;
  perform public.external_commit_page(cafe,'toast',merchant::text,'stock/v1/inventory','point:source-item',0,
    '{"mode":"point"}',true,jsonb_build_array(jsonb_build_object('key','source-item','business_date',today,
      'restaurant_guid',merchant,'payload','{"quantity":4,"status":"QUANTITY"}'::jsonb)));
  if not exists(select from public.inventory_evidence_for(cafe,today,today)
     where menu_item_ref='source-item' and quantity=4 and data->>'evidence_state'='observed_current')
     or not exists(select from public.inventory_evidence_for(cafe,today,today)
     where menu_item_ref='unaffected-item' and quantity=5 and data->>'evidence_state'='observed_current') then
    raise exception 'Point observation displaced complete collection evidence'; end if;
  perform public.external_commit_page(cafe,'toast',merchant::text,'stock/v1/inventory','current',1,null,true,'[]');
  if not exists (select from public.inventory_evidence_for(cafe,today,today)
    where menu_item_ref='source-item' and quantity is null and data->>'evidence_state'='not_observed') then
    raise exception 'A later empty receipt incorrectly certified earlier quantity'; end if;

  insert into public.menu_items(id,business_id,pos_item_id,name,base_name,price_cents,prep_seconds,catalog_source,
    toast_publication_state,toast_publication_version)
  values(menu_id,cafe,'menu-example','Former catalog title','Former catalog title',600,41,'toast','active',publication);
  perform public.external_commit_page(cafe,'toast',merchant::text,'menus/v2/menus','publication',0,null,true,
    jsonb_build_array(jsonb_build_object('key',merchant,'updated_at',publication,
      'payload','{"items":[{"guid":"menu-example","name":"Provider item","description":"Seasonal","pricingStrategy":"SIZE_PRICE"}],
                 "options":{"regular":{"guid":"regular","name":"Regular","price":7.25,"pricingStrategy":"BASE_PRICE"}}}'::jsonb,
      'identifiers','[{"namespace":"pos_item_id","value":"menu-example","selector":{
         "path":["items","0"],"itemGuid":"menu-example","sizeOptionGuid":"regular","sizeOptionPath":["options","regular"]}}]'::jsonb)));
  perform public.external_bind_native_identities(cafe,'toast',merchant::text,'menus/v2/menus','pos_item_id',
    'public.menu_items',jsonb_build_array(jsonb_build_object('native_id',menu_id,'source_id','menu-example')));
  insert into public.menu_items(id,business_id,pos_item_id,name,base_name,pos_name,description,price_cents,catalog_source)
    values(square_item,cafe,'square-variation','Owner label','Copied base','Previous provider label','Copied description',999,'square');
  perform public.external_commit_page(cafe,'square','merchant:6','catalog','location:6',0,null,true,
    '[{"key":"square-item","payload":{"item_data":{"name":"Provider label","description":"Original provider description"}},"identifiers":[
     {"namespace":"pos_item_id","value":"square-variation","selector":{"path":["item_data"],
       "display":{"name":["item_data","name"],"description":["item_data","description"]}}}]},
      {"key":"square-variation","payload":{"version":7,"item_variation_data":{"price_money":{"amount":625}}}}]');
  perform public.external_bind_native_identities(cafe,'square','merchant:6','catalog','pos_item_id',
    'public.menu_items',jsonb_build_array(jsonb_build_object('native_id',square_item,'source_id','square-variation',
     'price_source','{"recordKey":"square-variation","path":["item_variation_data","price_money","amount"],
        "checks":[{"path":["version"],"value":7}]}'::jsonb)));
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('app.supervisor_research_business_id',cafe::text,true);
  set local role authenticated;
  if (select count(*) from public.external_records where provider='fixture-provider')<>5 or
     exists(select 1 from public.external_records where payload ? 'private') then
    raise exception 'Owner isolation failed'; end if;
  if not exists(select from public.external_records where
    (payload #>> array['unexpected field','a.b','1'])::int=3) then
    raise exception 'Owner cannot query opaque provider JSON directly'; end if;
  if not exists(select from public.menu_catalog_for(cafe) c where c.id=menu_id and c.price_cents=725
    and c.name='Provider item' and c.description='Seasonal' and c.size_label='Regular' and c.prep_seconds=41)
    or exists(select from public.menu_catalog_for(other) c where c.id=menu_id) then
    raise exception 'Scoped Menu did not combine certified source values and native recipe identity'; end if;
  if not exists(select from public.menu_catalog_for(cafe) c where c.id=square_item and c.price_cents=625
     and c.name='Owner label' and c.base_name='Provider label' and c.description='Original provider description')
     or exists(select from public.menu_catalog_for(other) c where c.id=square_item)
     or not exists(select from public.cv_menu c where c.id=square_item and c.data->>'price_cents'='625') then
    raise exception 'Menu lost the exact Square labels, price or owner override'; end if;
  if has_function_privilege('authenticated','public.external_commit_page(uuid,text,text,text,text,bigint,jsonb,boolean,jsonb)','execute') then
    raise exception 'Owner has archive write privilege'; end if;
  reset role;
  update public.menu_items set name=pos_name where id=square_item;
  set local role authenticated;
  if not exists(select from public.menu_catalog_for(cafe) c where c.id=square_item and c.name='Provider label') then
    raise exception 'Menu used a copied label when the owner had no override'; end if;
  reset role;
  perform public.external_commit_page(cafe,'square','merchant:6','catalog','location:6',1,
    '{"cursor":"page-2","scope":{}}',false,'[]');
  set local role authenticated;
  if not exists(select from public.menu_catalog_for(cafe) c where c.id=square_item and c.price_cents is null) then
    raise exception 'Menu fell back to a copied price after losing current catalog coverage'; end if;
  reset role;
  perform public.external_commit_page(cafe,'square','merchant:6','catalog','location:6',2,
    '{"cursor":null,"scope":{}}',true,
    '[{"key":"square-item","payload":{"item_data":{"name":"Provider label"}}},
      {"key":"square-variation","payload":{"version":8,"item_variation_data":{"price_money":{"amount":620}}}}]');
  set local role authenticated;
  if not exists(select from public.menu_catalog_for(cafe) c where c.id=square_item and c.price_cents is null) then
    raise exception 'Menu resolved a price path from a different catalog version'; end if;
end $$;
rollback;
