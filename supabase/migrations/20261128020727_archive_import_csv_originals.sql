set lock_timeout = '5s';
set statement_timeout = '60s';

-- Exact or equivalent uploads can refer to the same import job without
-- promoting a second set of facts. The job determines the resource family.
create function public.archive_import_csv_evidence(
  p_business uuid,p_uploader uuid,p_job uuid,p_payload jsonb,p_mapping jsonb
) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  v_job public.csv_import_jobs%rowtype;
  v_record public.external_records%rowtype;
  v_resource text;
  v_key text;
begin
  if not exists (select from public.memberships m join public.businesses b on b.id=m.business_id
    where m.business_id=p_business and m.user_id=p_uploader and not b.is_demo) then
    raise exception 'CSV import membership required' using errcode='42501';
  end if;
  select * into v_job from public.csv_import_jobs
    where id=p_job and business_id=p_business and kind in ('sales','labor')
      and status in ('processing','done','needs_review','needs_wage_review');
  if not found then
    raise exception 'CSV import job is unavailable' using errcode='22023';
  end if;
  if jsonb_typeof(p_payload->'headers') is distinct from 'array'
    or jsonb_typeof(p_payload->'rows') is distinct from 'array'
    or jsonb_typeof(p_mapping) is distinct from 'object' then
    raise exception 'Invalid CSV evidence' using errcode='22023';
  end if;
  if jsonb_array_length(p_payload->'rows') <> v_job.rows_in_file then
    raise exception 'CSV row count does not match import' using errcode='22023';
  end if;

  v_key := encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
  v_resource := v_job.kind || '_csv';
  perform public.external_register_owner_resource(p_business,'owner_upload',p_uploader::text,v_resource,p_uploader);
  select * into v_record from public.external_records
    where business_id=p_business and provider='owner_upload' and source_account=p_uploader::text
      and entity=v_resource and source_key=v_key;
  if not found then
    perform public.external_commit_page(p_business,'owner_upload',p_uploader::text,v_resource,v_key,0,
      jsonb_build_object('mode','point'),true,
      jsonb_build_array(jsonb_build_object('key',v_key,'payload',p_payload,'updated_at',clock_timestamp())));
    select * into strict v_record from public.external_records
      where business_id=p_business and provider='owner_upload' and source_account=p_uploader::text
        and entity=v_resource and source_key=v_key;
  end if;
  if v_record.reader_owner_user_id is distinct from p_uploader or v_record.payload is distinct from p_payload then
    raise exception 'CSV evidence identity mismatch' using errcode='22023';
  end if;

  insert into public.external_record_links(business_id,provider,record_id,relation,evidence,native_relation,native_key)
    values(p_business,'owner_upload',v_record.id,'source_document',jsonb_build_object('column_mapping',p_mapping),
      'public.csv_import_jobs',jsonb_build_object('id',p_job)) on conflict do nothing;
end $$;

revoke all on function public.archive_import_csv_evidence(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.archive_import_csv_evidence(uuid,uuid,uuid,jsonb,jsonb) to service_role;
