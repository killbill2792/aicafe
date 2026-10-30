-- Toast day imports were cancelled by the database time limit (error 57014).
-- toast_archive_page (migration 120) redacted every page with a recursive
-- plpgsql walk, and one import ran it up to three times per page: on stage,
-- on archive and on delete of the staged page. A busy day never finished, so
-- its one-day backfill retried forever, and the payments (processing fees)
-- for those days were never saved.
--
-- The app now redacts each page once, before staging it, with the same rules
-- (lib/pos/toast/redact.ts). The database only stores what it receives.
--
-- ORDER: deploy the app change first, then apply this migration. Applied
-- earlier, pages staged by the old app would be archived unredacted.

-- 1. Pages staged before this change hold unredacted Toast payloads. They were
--    already archived (redacted) when staged, so remove them without archiving
--    them again. Their runs re-fetch the day from Toast on the next tick.
alter table public.toast_day_pages disable trigger toast_archive_page_delete;
delete from public.toast_day_pages;
alter table public.toast_day_pages enable trigger toast_archive_page_delete;

-- 2. Store only. Same rows, keys and hashes as migration 120, without the
--    in-database redaction.
create or replace function public.toast_archive_page(
 p_run_id uuid,p_business_date date,p_page integer,p_payload jsonb
) returns void language plpgsql security definer set search_path=public as $archive$
declare v_safe jsonb:=p_payload; -- redacted by the app before staging
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 insert into public.toast_raw_records(
  business_id,restaurant_guid,entity,entity_guid,business_date,payload,
  payload_sha256,run_id,source_page,source_index,capture_key)
 select s.business_id,s.restaurant_guid,'order',
   case when item.raw->>'guid' ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (item.raw->>'guid')::uuid else null end,
   p_business_date,item.raw,
   encode(sha256(convert_to(item.raw::text,'UTF8')),'hex'),
   p_run_id,p_page,item.idx::integer,
   'page:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||item.idx::text||':'||encode(sha256(convert_to(item.raw::text,'UTF8')),'hex')
 from public.toast_sync_runs s
 cross join lateral jsonb_array_elements(v_safe) with ordinality as item(raw,idx)
 where s.id=p_run_id
 on conflict (business_id,capture_key) do nothing;
 -- Preserve nested checks as independent immutable raw entities.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,run_id,source_page,source_index,capture_key)
 select s.business_id,s.restaurant_guid,'check',
 case when c.raw->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (c.raw->>'guid')::uuid else null end,
 p_business_date,c.raw,encode(sha256(convert_to(c.raw::text,'UTF8')),'hex'),p_run_id,p_page,o.idx::integer,
 'check:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||o.idx::text||':'||c.idx::text||':'||
 encode(sha256(convert_to(c.raw::text,'UTF8')),'hex')
 from public.toast_sync_runs s
 cross join lateral jsonb_array_elements(v_safe) with ordinality as o(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(o.raw->'checks')='array' then o.raw->'checks' else '[]'::jsonb end) with ordinality as c(raw,idx)
 where s.id=p_run_id
 on conflict(business_id,capture_key) do nothing;
 -- Preserve payments independently as raw entities; the owner reads only sanitized summaries.
 insert into public.toast_raw_records(business_id,restaurant_guid,entity,entity_guid,business_date,payload,payload_sha256,run_id,source_page,source_index,capture_key)
 select s.business_id,s.restaurant_guid,'payment',
 case when p.raw->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (p.raw->>'guid')::uuid else null end,
 p_business_date,p.raw,encode(sha256(convert_to(p.raw::text,'UTF8')),'hex'),p_run_id,p_page,o.idx::integer,
 'payment:'||p_run_id::text||':'||p_business_date::text||':'||p_page::text||':'||o.idx::text||':'||c.idx::text||':'||p.idx::text||':'||
 encode(sha256(convert_to(p.raw::text,'UTF8')),'hex')
 from public.toast_sync_runs s
 cross join lateral jsonb_array_elements(v_safe) with ordinality as o(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(o.raw->'checks')='array' then o.raw->'checks' else '[]'::jsonb end) with ordinality as c(raw,idx)
 cross join lateral jsonb_array_elements(case when jsonb_typeof(c.raw->'payments')='array' then c.raw->'payments' else '[]'::jsonb end) with ordinality as p(raw,idx)
 where s.id=p_run_id
 on conflict(business_id,capture_key) do nothing;
end $archive$;
revoke all on function public.toast_archive_page(uuid,date,integer,jsonb) from public,anon,authenticated;
grant execute on function public.toast_archive_page(uuid,date,integer,jsonb) to service_role;
