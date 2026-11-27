-- Keep the existing import-versus-live authority rules and financial facts.
create or replace function public.toast_archive_order(
 p_business_id uuid,p_restaurant_guid uuid,p_entity_guid uuid,p_business_date date,
 p_payload jsonb,p_sha text,p_run_id uuid,p_page integer,p_source_index integer,
 p_capture_key text,p_commit boolean
) returns text language plpgsql security definer set search_path=public as $order$
declare cur public.external_records%rowtype; diff jsonb; new_id uuid;
begin
 if auth.role() <> 'service_role' and current_user not in ('postgres','supabase_admin')
 then raise exception 'service role only'; end if;
 for attempt in 1..2 loop
  select * into cur from public.external_records r
  where r.provider='toast' and r.business_id=p_business_id and r.restaurant_guid is not distinct from p_restaurant_guid
   and r.business_date=p_business_date and r.entity='order' and r.entity_guid=p_entity_guid
  order by r.last_seen desc,r.id desc limit 1 for update;
  exit when found;
  -- Two writers can meet on a new order (the live job and a chat refresh).
  -- The loser of the race reads the winner's record and continues from it.
  insert into public.external_records(provider,source_account,source_key,source_updated_at,business_id,restaurant_guid,entity,entity_guid,
   business_date,payload,payload_sha256,run_id,seen_run_id,source_page,source_index,capture_key)
  values('toast',p_restaurant_guid::text,p_entity_guid::text,public.toast_time_or_null(p_payload->>'modifiedDate'),
   p_business_id,p_restaurant_guid,'order',p_entity_guid,p_business_date,p_payload,
   p_sha,p_run_id,p_run_id,p_page,p_source_index,p_capture_key)
  on conflict do nothing returning id into new_id;
  if new_id is not null then return 'inserted'; end if;
 end loop;
 if cur.id is null then raise exception 'toast archive: order record not readable'; end if;
 if p_run_id is null and (cur.run_id is not null or cur.seen_run_id is not null) then
  -- Live mode: an import already owns this record. The import is the authority.
  return 'skipped';
 end if;
 if cur.payload_sha256<>p_sha
  and p_payload->>'modifiedDate' is not null and cur.payload->>'modifiedDate' is not null
  and public.toast_time_or_null(p_payload->>'modifiedDate')<public.toast_time_or_null(cur.payload->>'modifiedDate') then
  -- An older version than the one stored: never replace newer data with older data.
  return 'older';
 elsif cur.payload_sha256<>p_sha then
  -- Real change (list order is already sorted by the app): log it, update in place.
  select jsonb_agg(change order by change->'segments') into diff
    from public.external_json_delta(cur.payload,p_payload) change;
  if diff is not null then
    insert into public.external_record_changes(provider,source_account,source_key,record_id,business_id,
      restaurant_guid,entity,entity_guid,business_date,run_id,changes)
    values('toast',cur.source_account,p_entity_guid::text,cur.id,p_business_id,p_restaurant_guid,
      'order',p_entity_guid,cur.business_date,p_run_id,diff);
  end if;
  update public.external_records set payload=p_payload,payload_sha256=p_sha,
   source_account=p_restaurant_guid::text,source_key=p_entity_guid::text,
   source_updated_at=public.toast_time_or_null(p_payload->>'modifiedDate'),
   seen_run_id=p_run_id,last_seen=now(),
   run_id=case when p_commit then p_run_id else run_id end,
   source_page=case when p_commit then p_page else source_page end,
   source_index=case when p_commit then p_source_index else source_index end
  where provider='toast' and business_id=p_business_id and id=cur.id;
  delete from public.toast_order_typed_facts where raw_record_id=cur.id;
  perform public.toast_capture_typed_order(cur.id);
  return 'changed';
 elsif (cur.source_account is null and cur.payload=p_payload) or cur.seen_run_id is distinct from p_run_id
  or (p_commit and cur.run_id is distinct from p_run_id) then
  update public.external_records set seen_run_id=p_run_id,last_seen=now(),
   source_account=case when cur.payload=p_payload then p_restaurant_guid::text else cur.source_account end,
   source_key=p_entity_guid::text,source_updated_at=public.toast_time_or_null(cur.payload->>'modifiedDate'),
   run_id=case when p_commit then p_run_id else run_id end,
   source_page=case when p_commit then p_page else source_page end,
   source_index=case when p_commit then p_source_index else source_index end
  where provider='toast' and business_id=p_business_id and id=cur.id;
  if p_commit then
   update public.toast_order_typed_facts set run_id=p_run_id
   where raw_record_id=cur.id and run_id is distinct from p_run_id;
  end if;
 end if;
 return 'same';
end $order$;
