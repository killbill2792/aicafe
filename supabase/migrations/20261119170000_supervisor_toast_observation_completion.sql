-- Task 8A: preserve completion proof independently of the mutable latest
-- menu checkpoint. No new source, price writer, scheduler, or historical backfill.
set lock_timeout='5s';
set statement_timeout='45s';

alter table public.menu_price_history
 add column toast_publication_completed_at timestamptz,
 add column toast_publication_pos_item_id text;
-- Both fields are absent on history written before this migration. An existing
-- Toast provider/receipt mutation is already protected by the 8a source guard.
alter table public.menu_price_history
 add constraint supervisor_8a_completed_publication_identity check (
  (toast_publication_completed_at is null and toast_publication_pos_item_id is null)
  or (toast_publication_completed_at is not null and
    toast_publication_pos_item_id is not null and
    source_type is not distinct from 'connected_pos' and
    source_provider is not distinct from 'toast' and
    toast_restaurant_guid is not null and toast_publication_version is not null
    and toast_observed_at is not null
    and toast_publication_completed_at>=toast_observed_at
    and toast_publication_pos_item_id ~*
      '^toast:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(:size:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})?$'
    and split_part(toast_publication_pos_item_id,':',2)=toast_restaurant_guid::text
    and old_price_cents is not null and old_price_cents>0
    and new_price_cents is not null and new_price_cents>0
    and old_price_cents<>new_price_cents)) not valid;
alter table public.menu_price_history validate constraint supervisor_8a_completed_publication_identity;
create index supervisor_8a_completed_toast_history
 on public.menu_price_history(business_id,toast_publication_completed_at,id)
 where toast_publication_completed_at is not null;

-- Separate opt-in means a café already using the approved-experiment cutover
-- cannot accidentally receive a historical flood when this code is deployed.
alter table public.supervisor_experiment_cutover_cafes
 add column toast_observation_enabled_at timestamptz;

-- Only the existing importer's final checkpoint transition can stamp proof.
-- A per-item receipt, pending version, failure, or a metadata-only refresh
-- cannot manufacture completion. The checkpoint and proof share a transaction.
create function public.supervisor_8a_stamp_completed_toast_history()
 returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if old.menu_checked_local_day is not null or new.menu_checked_local_day is null
    or old.menu_last_updated is distinct from new.menu_last_updated
    or new.menu_last_updated is null or new.menu_last_updated like 'pending:%'
    or old.menu_copied_at is null or new.menu_copied_at is null
    or new.menu_copied_at<old.menu_copied_at
    or new.menu_copied_at>clock_timestamp()+interval '1 minute'
    or new.business_id is distinct from old.business_id
    or new.restaurant_guid is distinct from old.restaurant_guid
 then return new;end if;
 if current_user in ('anon','authenticated') or
    coalesce(auth.role(),'') in ('anon','authenticated')
 then raise exception 'toast_history_source_service_role_only' using errcode='42501';end if;
 if not exists(select 1 from public.toast_location_mappings l
   where l.business_id=new.business_id and l.restaurant_guid=new.restaurant_guid
    and l.verified_at is not null)
 then return new;end if;
 update public.menu_price_history h
 set toast_publication_completed_at=new.menu_copied_at,
     toast_publication_pos_item_id=m.pos_item_id
 from public.menu_items m
 where h.business_id=new.business_id and m.business_id=h.business_id
   and m.id=h.menu_item_id and h.source_type='connected_pos'
   and h.source_provider='toast' and h.toast_restaurant_guid=new.restaurant_guid
   and h.toast_publication_version=new.menu_last_updated
   and h.toast_publication_completed_at is null
   and h.toast_observed_at is not null and h.toast_observed_at<=new.menu_copied_at
   and h.old_price_cents>0 and h.new_price_cents>0 and h.old_price_cents<>h.new_price_cents
   and m.catalog_source='toast' and m.is_active
   and m.toast_publication_state='active'
   and m.toast_publication_version=h.toast_publication_version
   and m.price_cents=h.new_price_cents
   and m.pos_item_id like 'toast:'||new.restaurant_guid::text||':%'
   and m.pos_item_id ~*
     '^toast:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(:size:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})?$'
   and m.pos_pricing_strategy=case when m.pos_item_id like '%:size:%'
      then 'SIZE_PRICE' else 'BASE_PRICE' end
   and (select count(*) from public.menu_price_history other
     where other.business_id=h.business_id and other.menu_item_id=h.menu_item_id
     and other.toast_restaurant_guid=h.toast_restaurant_guid
     and other.toast_publication_version=h.toast_publication_version
     and other.source_type='connected_pos' and other.source_provider='toast'
     and other.old_price_cents>0 and other.new_price_cents>0
     and other.old_price_cents<>other.new_price_cents)=1;
 return new;
end;$$;
revoke all on function public.supervisor_8a_stamp_completed_toast_history()
 from public,anon,authenticated;
grant execute on function public.supervisor_8a_stamp_completed_toast_history() to service_role;
create trigger supervisor_8a_stamp_completed_toast_history
 after update of menu_checked_local_day on public.toast_optional_sync_state
 for each row execute function public.supervisor_8a_stamp_completed_toast_history();

-- Retain old slot-zero observation records if any exist, but all new daily
-- claims use their elapsed-window index, independent of café timezone/date.
alter table public.supervisor_experiment_notice_receipts
 drop constraint supervisor_experiment_notice_receipts_slot_check,
 drop constraint supervisor_experiment_notice_receipts_check;
alter table public.supervisor_experiment_notice_receipts
 add constraint supervisor_8a_notice_slot_range check(
 (kind='price_reminder' and slot in (1,2)) or
 (kind in ('toast_price_initial','toast_price_final') and slot=0) or
 (kind='toast_price_daily' and slot between 0 and 7)) not valid;
alter table public.supervisor_experiment_notice_receipts validate constraint supervisor_8a_notice_slot_range;

-- Observation measurements are café facts; approved proposal results remain
-- private to the owner who authorized them. Delivery stays owner-specific.
drop policy supervisor_8a_windows_owner_read on public.supervisor_monitor_windows;
create policy supervisor_8a_windows_owner_read
 on public.supervisor_monitor_windows for select to authenticated
 using ((monitor_kind='toast_price_observation' or owner_user_id=(select auth.uid())) and exists(
  select 1 from public.memberships m
  where m.business_id=supervisor_monitor_windows.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));

create or replace function public.supervisor_8a_claim_notice(
 p_business_id uuid,p_owner_user_id uuid,p_source_id uuid,
 p_kind text,p_local_date date,p_slot smallint
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;v_sent integer;v_existing public.supervisor_experiment_notice_receipts;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 if not exists(select 1 from public.memberships m
   where m.business_id=p_business_id and m.user_id=p_owner_user_id
    and m.role='owner') then return null;end if;
 if p_kind not in ('price_reminder','toast_price_initial',
  'toast_price_daily','toast_price_final') or p_local_date is null or
  (p_kind='price_reminder' and p_slot not in (1,2)) or
  (p_kind in ('toast_price_initial','toast_price_final') and p_slot<>0) or
  (p_kind='toast_price_daily' and p_slot not between 1 and 7) then
  raise exception 'invalid_notice_key' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(
  concat_ws(':',p_business_id,p_owner_user_id,p_source_id,
   case when p_kind='price_reminder' then p_local_date::text else p_kind||':'||p_slot::text end),0));
 -- Recheck under the claim lock. A queued cron read may race an owner
 -- cancellation OR the matching Toast source publication. Never reclaim a
 -- failed lease when the exact approved change is already source-verified.
 if p_kind='price_reminder' and not exists (
  select 1 from public.supervisor_proposals p
  where p.business_id=p_business_id and p.owner_user_id=p_owner_user_id
   and p.id=p_source_id and p.status='manual_pending'
   and p.approved_at is not null
   and not exists (
    select 1 from public.menu_price_history h
    join public.toast_location_mappings l
     on l.business_id=h.business_id
     and l.restaurant_guid=h.toast_restaurant_guid
    where h.business_id=p.business_id
     and h.menu_item_id::text=p.canonical_effect_payload->>'productId'
     and h.old_price_cents::text=p.canonical_effect_payload->>'oldPriceCents'
     and h.new_price_cents::text=p.canonical_effect_payload->>'newPriceCents'
     and h.source_type='connected_pos' and h.source_provider='toast'
     and h.toast_publication_version is not null
     and h.toast_observed_at>=p.approved_at
     and l.verified_at is not null
   )
 ) then return null;end if;
 if p_kind<>'price_reminder' and not exists (
  select 1 from public.menu_price_history h
  join public.toast_location_mappings l
   on l.business_id=h.business_id
   and l.restaurant_guid=h.toast_restaurant_guid
  where h.business_id=p_business_id and h.id=p_source_id
   and h.source_type='connected_pos' and h.source_provider='toast'
   and h.toast_restaurant_guid is not null and l.verified_at is not null
   and h.toast_publication_version is not null
   and h.toast_observed_at is not null
   and h.old_price_cents>0 and h.new_price_cents>0
   and h.old_price_cents<>h.new_price_cents
   and h.toast_publication_completed_at is not null
   and h.toast_publication_completed_at<=now()
   and exists (select 1 from public.supervisor_experiment_cutover_cafes g
     where g.business_id=h.business_id and g.mode='new'
     and g.parity_proven_at is not null and g.rollback_proven_at is not null
     and g.release_approved_at is not null
     and h.toast_observed_at>=g.toast_observation_enabled_at)
   and exists (select 1 from public.supervisor_monitor_windows w
     where w.business_id=h.business_id and w.monitor_kind='toast_price_observation'
     and w.source_id=h.id and w.window_index=case when p_kind='toast_price_daily' then p_slot-1 else 0 end
     and (p_kind<>'toast_price_daily' or w.evaluation_status<>'in_progress'))
 ) then return null;end if;
 select * into v_existing from public.supervisor_experiment_notice_receipts
  where business_id=p_business_id and owner_user_id=p_owner_user_id
   and source_id=p_source_id and kind=p_kind
   and (p_kind<>'price_reminder' or local_date=p_local_date) and slot=p_slot
  order by (state='posted') desc,created_at,id limit 1 for update;
 if found then
  if v_existing.state='posted' or
   (v_existing.state='claimed' and v_existing.claimed_at>now()-interval '5 minutes') or
   (v_existing.state='failed' and v_existing.retry_at>now()) or
   v_existing.attempts>=30 then return null;end if;
  update public.supervisor_experiment_notice_receipts
  set state='claimed',claimed_at=now(),retry_at=null,attempts=attempts+1,
   updated_at=now() where id=v_existing.id returning id into v_id;
  return v_id;
 end if;
 if p_kind='price_reminder' then
  select count(*) into v_sent from public.supervisor_experiment_notice_receipts
   where business_id=p_business_id and owner_user_id=p_owner_user_id
    and source_id=p_source_id and kind=p_kind and local_date=p_local_date;
  if v_sent>=2 then return null;end if;
 end if;
 insert into public.supervisor_experiment_notice_receipts
  (business_id,owner_user_id,source_id,kind,local_date,slot)
  values(p_business_id,p_owner_user_id,p_source_id,p_kind,p_local_date,p_slot)
  returning id into v_id;
 return v_id;
end;$$;
revoke all on function public.supervisor_8a_claim_notice(
 uuid,uuid,uuid,text,date,smallint) from public,anon,authenticated;
grant execute on function public.supervisor_8a_claim_notice(
 uuid,uuid,uuid,text,date,smallint) to service_role;


-- Bounded fair enumeration. A pinned approved proposal already owns its
-- measurement. An eligible matching pending proposal gets first refusal;
-- a later source event never restarts a previously pinned experiment.
create function public.supervisor_8a_due_toast_observations(p_now timestamptz,p_limit integer)
 returns table(history_id uuid,business_id uuid,enabled_at timestamptz)
 language plpgsql security invoker set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 if p_now is null or p_limit is null or p_limit not between 1 and 100 then
  raise exception 'invalid_observation_batch' using errcode='22023';end if;
 return query
 select h.id,h.business_id,g.toast_observation_enabled_at
 from public.menu_price_history h
 join public.supervisor_experiment_cutover_cafes g on g.business_id=h.business_id
 join public.toast_location_mappings l on l.business_id=h.business_id and l.restaurant_guid=h.toast_restaurant_guid
 left join public.supervisor_monitor_windows w on w.business_id=h.business_id
  and w.monitor_kind='toast_price_observation' and w.source_id=h.id and w.window_index=0
 where g.mode='new' and g.parity_proven_at is not null
  and g.rollback_proven_at is not null and g.release_approved_at is not null
  and g.toast_observation_enabled_at is not null
  and h.toast_publication_completed_at is not null
  and h.toast_publication_completed_at<=p_now
  and h.toast_observed_at>=g.toast_observation_enabled_at
  and l.verified_at is not null
  and exists(select 1 from public.memberships m where m.business_id=h.business_id and m.role='owner')
  and (w.id is null or w.source_reference->>'closedAt' is null)
  and not exists(select 1 from public.supervisor_monitor_windows a
    where a.business_id=h.business_id and a.monitor_kind='approved_price'
    and a.window_index=0 and a.source_reference->>'historyId'=h.id::text)
  and not exists(select 1 from public.supervisor_proposals p
    where p.business_id=h.business_id
    and p.capability_id in ('alex.drink_price_experiment.v1','alex.menu_price_change.v1')
    and p.status in ('manual_pending','manual_confirmed','committed')
    and p.approved_at<=h.toast_observed_at
    and p.canonical_effect_payload->>'productId'=h.menu_item_id::text
    and p.canonical_effect_payload->>'oldPriceCents'=h.old_price_cents::text
    and p.canonical_effect_payload->>'newPriceCents'=h.new_price_cents::text
    and not exists(select 1 from public.supervisor_monitor_windows a
      where a.business_id=h.business_id and a.monitor_kind='approved_price'
      and a.source_id=p.id and a.window_index=0))
 order by coalesce(w.updated_at,h.toast_publication_completed_at),h.id
 limit p_limit;
end;$$;
revoke all on function public.supervisor_8a_due_toast_observations(timestamptz,integer)
 from public,anon,authenticated;
grant execute on function public.supervisor_8a_due_toast_observations(timestamptz,integer) to service_role;

-- Capture the specific lease generation in the same transaction as the
-- existing claim. A delayed previous worker must never borrow a new lease.
create function public.supervisor_8a_claim_observation_notice(
 p_business_id uuid,p_owner_user_id uuid,p_source_id uuid,p_kind text,p_local_date date,p_slot smallint
) returns table(receipt_id uuid,attempt bigint) language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 if p_kind not in ('toast_price_initial','toast_price_daily','toast_price_final') then
  raise exception 'invalid_observation_notice_kind' using errcode='22023';end if;
 v_id:=public.supervisor_8a_claim_notice(p_business_id,p_owner_user_id,p_source_id,p_kind,p_local_date,p_slot);
 if v_id is null then return;end if;
 return query select n.id,n.attempts from public.supervisor_experiment_notice_receipts n where n.id=v_id;
end;$$;
revoke all on function public.supervisor_8a_claim_observation_notice(uuid,uuid,uuid,text,date,smallint) from public,anon,authenticated;
grant execute on function public.supervisor_8a_claim_observation_notice(uuid,uuid,uuid,text,date,smallint) to service_role;

-- Atomic fenced in-app delivery for observation receipts. No provider call,
-- no price proposal, and no external transport is made by this function.
create function public.supervisor_8a_post_observation_notice(
 p_receipt_id uuid,p_attempt bigint,p_thread_id uuid,p_task_id text,p_message_id uuid,
 p_timezone text,p_payload jsonb,p_text text,p_confidence text
) returns boolean language plpgsql security invoker set search_path='' as $$
declare n public.supervisor_experiment_notice_receipts; h public.menu_price_history;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501';end if;
 select * into n from public.supervisor_experiment_notice_receipts
  where id=p_receipt_id and kind in ('toast_price_initial','toast_price_daily','toast_price_final')
   and state='claimed' and attempts=p_attempt and claimed_at>clock_timestamp()-interval '5 minutes'
  for update;
 if not found then return false;end if;
 perform 1 from public.memberships m where m.business_id=n.business_id
  and m.user_id=n.owner_user_id and m.role='owner' for share;
 if not found then return false;end if;
 perform 1 from public.ai_threads t where t.id=p_thread_id
  and t.business_id=n.business_id and t.owner_user_id=n.owner_user_id for share;
 if not found then return false;end if;
 select h0.* into h from public.menu_price_history h0
  join public.supervisor_experiment_cutover_cafes g on g.business_id=h0.business_id
  join public.toast_location_mappings l on l.business_id=h0.business_id and l.restaurant_guid=h0.toast_restaurant_guid
  where h0.id=n.source_id and h0.business_id=n.business_id
   and h0.toast_publication_completed_at is not null and l.verified_at is not null
   and g.mode='new' and g.parity_proven_at is not null and g.rollback_proven_at is not null
   and g.release_approved_at is not null and h0.toast_observed_at>=g.toast_observation_enabled_at;
 if not found then return false;end if;
 if p_task_id is distinct from ('toast-price-observation:'||n.owner_user_id::text||':'||n.source_id::text||':'||n.kind||':'||n.slot::text)
  or p_message_id is null or p_payload is null or jsonb_typeof(p_payload) is distinct from 'object'
  or p_text is null or length(trim(p_text))=0 or length(p_text)>1200
  or p_timezone is null or p_confidence not in ('high','low')
 then raise exception 'invalid_observation_delivery' using errcode='22023';end if;
 insert into public.operating_tasks(
  business_id,id,agent_id,owner_user_id,kind,status,confidence,entity_type,entity_id,
  payload,evidence)
 values(n.business_id,p_task_id,'alex',n.owner_user_id,'priority_notice','watching',
  p_confidence,'menu_item',h.menu_item_id,
  p_payload||jsonb_build_object('observationOnly',true,'priceHistoryId',h.id,
    'threadId',p_thread_id,'ownerNoticeDate',n.local_date,'windowIndex',n.slot),
  jsonb_build_array(jsonb_build_object('source','menu_price_history','facts',
    jsonb_build_object('sourceId',h.id,'publicationVersion',h.toast_publication_version))))
 on conflict(business_id,id) do nothing;
 insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,
  role,content_type,text_content,structured_content,grounding)
 values(p_message_id,n.business_id,p_thread_id,n.owner_user_id,null,'supervisor','blocks',null,
  jsonb_build_array(jsonb_build_object('type','text','text',p_text)),
  jsonb_build_object('status',case when p_confidence='high' then 'estimated' else 'insufficient_evidence' end,
   'intent','menu_pricing','evidence',jsonb_build_array(jsonb_build_object(
    'source','operating_tasks','identifier',p_task_id,'asOf',n.local_date))))
 on conflict(id) do nothing;
 if not exists(select 1 from public.operating_tasks t where t.business_id=n.business_id
   and t.id=p_task_id and t.owner_user_id=n.owner_user_id
   and t.payload->>'priceHistoryId'=n.source_id::text)
  or not exists(select 1 from public.ai_messages m where m.id=p_message_id
   and m.business_id=n.business_id and m.owner_user_id=n.owner_user_id
   and m.thread_id=p_thread_id and m.role='supervisor')
 then raise exception 'observation_notice_delivery_identity_conflict' using errcode='23514';end if;
 update public.supervisor_experiment_notice_receipts set state='posted',
  posted_at=clock_timestamp(),task_id=p_task_id,message_id=p_message_id,
  updated_at=clock_timestamp()
  where id=n.id and attempts=p_attempt and state='claimed';
 return found;
end;$$;
revoke all on function public.supervisor_8a_post_observation_notice(uuid,bigint,uuid,text,uuid,text,jsonb,text,text)
 from public,anon,authenticated;
grant execute on function public.supervisor_8a_post_observation_notice(uuid,bigint,uuid,text,uuid,text,jsonb,text,text)
 to service_role;

reset lock_timeout;
reset statement_timeout;
