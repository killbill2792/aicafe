set lock_timeout = '5s';
set statement_timeout = '60s';

-- Public city reports are shared at their existing city/source/window identity.
-- The report is the admitted provider response, while the coverage ledger
-- continues to own retries and the city event rows own occurrence identity.
alter table public.city_source_coverage
  add column source_report jsonb,
  add column source_report_observed_at timestamptz,
  add column source_report_changes jsonb;

comment on column public.city_source_coverage.source_report is
  'Original admitted public event research report for this city, source and window. A cited search report is distinct from publisher page contents.';

create function public.ldi_record_city_coverage(
  p_city_key text,p_source_key text,p_from date,p_to date,p_status text,p_checked_at timestamptz,
  p_source_report jsonb
) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  v_previous public.city_source_coverage%rowtype;
  v_delta jsonb;
begin
  if coalesce(jsonb_typeof(p_source_report),'null') not in ('array','object') or p_status='failed' then
    raise exception 'Invalid public city source report' using errcode='22023';
  end if;
  perform public.ldi_record_city_coverage(p_city_key,p_source_key,p_from,p_to,p_status,p_checked_at);
  select * into strict v_previous from public.city_source_coverage c
    where (c.city_key,c.source_key,c.window_from,c.window_to)=(p_city_key,p_source_key,p_from,p_to)
    for update;
  if p_checked_at<=v_previous.source_report_observed_at then return; end if;
  if v_previous.source_report is not null and v_previous.source_report is distinct from p_source_report then
    select jsonb_agg(d order by d->'path') into v_delta
      from public.external_json_delta(v_previous.source_report,p_source_report) d;
  end if;
  update public.city_source_coverage c set
    source_report=p_source_report,source_report_observed_at=p_checked_at,
    source_report_changes=case when v_delta is null then v_previous.source_report_changes else
      coalesce(v_previous.source_report_changes,'[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'observed_at',p_checked_at,'changes',v_delta)) end
  where (c.city_key,c.source_key,c.window_from,c.window_to)=(p_city_key,p_source_key,p_from,p_to);
end $$;

revoke all on function public.ldi_record_city_coverage(text,text,date,date,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.ldi_record_city_coverage(text,text,date,date,text,timestamptz,jsonb) to service_role;
