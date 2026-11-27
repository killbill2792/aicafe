-- Run on a seeded, disposable database with the full migration chain.
\set ON_ERROR_STOP on
begin;
do $$
declare cafe uuid; other uuid; owner_id uuid; rec uuid; before_rev bigint;
  merchant uuid:=gen_random_uuid(); today date; status text; candidate record;
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

  perform public.external_commit_page(cafe,'toast',merchant::text,'stock/v1/inventory','current',0,null,true,
    jsonb_build_array(jsonb_build_object('key','source-item','business_date',today,
      'restaurant_guid',merchant,'payload','{"quantity":3,"status":"QUANTITY"}'::jsonb)));
  if not exists (select from public.inventory_evidence_for(cafe,today,today)
    where menu_item_ref='source-item' and quantity=3 and data->>'evidence_state'='observed_current') then
    raise exception 'Complete original stock observation not shown'; end if;
  perform public.external_commit_page(cafe,'toast',merchant::text,'stock/v1/inventory','current',1,null,true,'[]');
  if not exists (select from public.inventory_evidence_for(cafe,today,today)
    where menu_item_ref='source-item' and quantity is null and data->>'evidence_state'='not_observed') then
    raise exception 'A later empty receipt incorrectly certified earlier quantity'; end if;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('app.supervisor_research_business_id',cafe::text,true);
  set local role authenticated;
  if (select count(*) from public.external_records where provider='fixture-provider')<>2 or
     exists(select 1 from public.external_records where payload ? 'private') then
    raise exception 'Owner isolation failed'; end if;
  if not exists(select from public.external_records where
    (payload #>> array['unexpected field','a.b','1'])::int=3) then
    raise exception 'Owner cannot query opaque provider JSON directly'; end if;
  if has_function_privilege('authenticated','public.external_commit_page(uuid,text,text,text,text,bigint,jsonb,boolean,jsonb)','execute') then
    raise exception 'Owner has archive write privilege'; end if;
end $$;
rollback;
