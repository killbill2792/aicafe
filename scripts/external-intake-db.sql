\set ON_ERROR_STOP on
begin;
do $$
declare
  v_cafe uuid;
  v_owner uuid;
  v_other_owner uuid;
  v_job uuid:=gen_random_uuid();
  v_source constant jsonb:='{"headers":["Date","New field","New field"],"rows":[["2026-11-04","0",""]]}'::jsonb;
  v_city constant text:='us|test|archive city';
  v_day constant date:='2026-11-04';
  v_at constant timestamptz:='2026-11-04 20:00:00Z';
  v_report constant jsonb:='{"events":[{"name":"Market","extra":{"field":null}}]}'::jsonb;
  v_correction constant jsonb:='{"events":[{"name":"Market","extra":{"new field":0}}]}'::jsonb;
begin
  select m.business_id,m.user_id into strict v_cafe,v_owner from public.memberships m
    join public.businesses b on b.id=m.business_id where m.role='owner' and not b.is_demo limit 1;
  select m.user_id into strict v_other_owner from public.memberships m
    where m.role='owner' and m.user_id<>v_owner and m.business_id<>v_cafe limit 1;
  insert into public.memberships(business_id,user_id,role) values(v_cafe,v_other_owner,'owner') on conflict do nothing;
  insert into public.csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file)
    values(v_job,v_cafe,'sales','done',v_job::text,1);

  set local role service_role;
  perform public.archive_sales_csv_evidence(v_cafe,v_owner,v_job,v_source,'{"date":"Date"}');
  perform public.archive_sales_csv_evidence(v_cafe,v_owner,v_job,v_source,'{"date":"Date"}');
  if (select count(*) from public.external_records where business_id=v_cafe and entity='sales_csv')<>1
    or (select count(*) from public.external_record_links where business_id=v_cafe
      and native_key=jsonb_build_object('id',v_job))<>1 then
    raise exception 'Idempotent CSV replay duplicated source or job link';
  end if;

  perform public.ldi_record_city_coverage(v_city,'category:fixture',v_day,v_day,'found',v_at,v_report);
  perform public.ldi_record_city_coverage(v_city,'category:fixture',v_day,v_day,'found',v_at+interval '1 second',v_correction);
  perform public.ldi_record_city_coverage(v_city,'category:fixture',v_day,v_day,'found',v_at,v_report);
  perform public.ldi_record_city_coverage(v_city,'category:fixture',v_day,v_day,'failed',v_at+interval '2 seconds');
  reset role;

  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  set local role authenticated;
  if not exists(select from public.external_records where business_id=v_cafe and entity='sales_csv' and payload=v_source) then
    raise exception 'The uploader cannot query the original cells';
  end if;
  if has_function_privilege(current_user,'public.archive_sales_csv_evidence(uuid,uuid,uuid,jsonb,jsonb)','execute')
    or has_function_privilege(current_user,'public.ldi_record_city_coverage(text,text,date,date,text,timestamptz,jsonb)','execute') then
    raise exception 'An authenticated client can bypass intake authorization';
  end if;

  perform set_config('request.jwt.claim.sub',v_other_owner::text,true);
  if exists(select from public.external_records where business_id=v_cafe and entity='sales_csv') then
    raise exception 'A co-owner can query the uploader-private original';
  end if;
  if not exists(select from public.city_source_coverage where city_key=v_city and source_report=v_correction
      and status='failed' and last_completed_at=v_at+interval '1 second'
      and jsonb_array_length(source_report_changes)=1
      and source_report_changes#>'{0,changes}' @> '[
        {"segments":["events","0","extra","field"],"before_present":true,"after_present":false},
        {"segments":["events","0","extra","new field"],"before_present":false,"after":0}
      ]'::jsonb) then
    raise exception 'Public report lost shared scope, last successful response or original change evidence';
  end if;
end $$;
rollback;
