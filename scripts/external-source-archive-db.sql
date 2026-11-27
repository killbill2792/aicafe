-- Run on a seeded, disposable database with the full migration chain.
\set ON_ERROR_STOP on
begin;
do $$
declare cafe uuid; other uuid; owner_id uuid; rec uuid; before_rev bigint;
begin
  select m.business_id,m.user_id into strict cafe,owner_id from public.memberships m
    where m.role='owner' and m.business_id <> '11111111-1111-1111-1111-111111111111' limit 1;
  select id into strict other from public.businesses where id <> cafe limit 1;
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
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('app.supervisor_research_business_id',cafe::text,true);
  set local role authenticated;
  if (select count(*) from public.external_records where provider='fixture-provider')<>1 or
     exists(select 1 from public.external_records where payload ? 'private') then
    raise exception 'Owner isolation failed'; end if;
  if has_function_privilege('authenticated','public.external_commit_page(uuid,text,text,text,text,bigint,jsonb,boolean,jsonb)','execute') then
    raise exception 'Owner has archive write privilege'; end if;
end $$;
rollback;
