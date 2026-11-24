-- PR #563: source-eligible notice/investigation boundary, no generic chat spam.
-- Reuses the established producer functions and fenced leases from #561.
-- A known technical source gap is not an owner loss or a model objective.
-- No new scheduler, store, public API, authentication or effect permissions.
set lock_timeout='3s';
set statement_timeout='45s';

CREATE OR REPLACE FUNCTION public.supervisor_enqueue_investigation(p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_source_type text, p_source_id text, p_revision_hash text, p_stable_key text, p_priority integer, p_now timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_open boolean;v_episode uuid;v_anomaly boolean:=false;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if not public.supervisor_routine_owner_authorized(
    p_business_id,p_owner_user_id,p_thread_id) then
    raise exception 'Investigation owner or thread revoked' using errcode='42501'; end if;
  if p_source_type not in ('alert','operating_task') or
    length(coalesce(p_source_id,'')) not between 1 and 256 or
    p_revision_hash !~ '^[a-f0-9]{64}$' or p_stable_key !~ '^[a-f0-9]{64}$'
    or p_priority is null or p_priority not between 0 and 400
    or p_now is null then raise exception 'Invalid investigation key' using errcode='22023'; end if;
  if p_source_type='alert' then
    select exists(select 1 from public.alerts a
      where a.business_id=p_business_id and a.id::text=p_source_id
        and a.status in ('new','seen')
        and not (a.kind='business_anomaly' and
          (a.payload->>'family'='data_gap' or
           a.payload->>'quality' in ('technical_failure','not_matured'))))
       into v_open;
  else
    select exists(select 1 from public.operating_tasks t
      where t.business_id=p_business_id and t.id=p_source_id
        and t.kind not in ('priority_notice','commitment','event_plan','event_change','event_report','daily_brief')
        and t.status in ('needs_owner','needs_response','watching')
        and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)) into v_open;
  end if;
  if not v_open then return false; end if;
  -- Rolling business-source data revisions are not a new incident. Keep the
  -- outstanding owner question, answer and episode; fence the old revision.
  if p_source_type='alert' then
    select exists(select 1 from public.alerts a where a.business_id=p_business_id
       and a.id::text=p_source_id and a.kind='business_anomaly') into v_anomaly;
  end if;
  -- A relevant source revision wakes the SAME episode, but leaves its
  -- owner question answerable. The pendingRelevantRevision token is set by
  -- service-only enqueue, consumed by the investigation checkpoint, and
  -- NEVER minted by a periodic cron timestamp or unrelated café row.
  if v_anomaly then
    update public.supervisor_investigations set revision_hash=p_revision_hash,
      stable_key=p_stable_key,priority=p_priority,next_retry_at=p_now,updated_at=p_now,
      evidence=case when phase='awaiting_owner' then
        jsonb_set(coalesce(evidence,'{}'::jsonb),'{pendingRelevantRevision}',
          to_jsonb(p_revision_hash),true) else evidence end,
      failure_count=0,last_error=null
      where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
       and source_type=p_source_type and source_id=p_source_id
       and phase in ('collect','investigate','awaiting_owner')
       and revision_hash<>p_revision_hash and (lease_until is null or lease_until<=p_now);
    if found then return true;end if;
  else
    update public.supervisor_investigations set revision_hash=p_revision_hash,
      stable_key=p_stable_key,priority=p_priority,next_retry_at=p_now,updated_at=p_now,
      evidence=jsonb_set(coalesce(evidence,'{}'::jsonb),
        '{pendingRelevantRevision}',to_jsonb(p_revision_hash),true),
      failure_count=0,last_error=null
      where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
       and source_type=p_source_type and source_id=p_source_id and phase='awaiting_owner'
       and revision_hash<>p_revision_hash and (lease_until is null or lease_until<=p_now);
    if found then return true;end if;
  end if;
  insert into public.supervisor_investigations
    (business_id,owner_user_id,thread_id,source_type,source_id,
     revision_hash,stable_key,priority,next_retry_at)
  values(p_business_id,p_owner_user_id,p_thread_id,p_source_type,p_source_id,
    p_revision_hash,p_stable_key,p_priority,p_now)
  on conflict (business_id,owner_user_id,source_type,source_id)
  do update set episode_id=gen_random_uuid(),
    revision_hash=excluded.revision_hash,stable_key=excluded.stable_key,
    priority=excluded.priority,
    thread_id=excluded.thread_id,phase='collect',step_version=0,
    failure_count=0,lease_token=null,lease_until=null,next_retry_at=p_now,
    evidence='{}'::jsonb,narrative=null,last_error=null,updated_at=p_now
  -- Closed/technical-blocked incidents stay asleep on identical evidence.
  -- A restored owner/member assignment is an independently verified change
  -- of authorization and may restart a previously authorization-blocked row.
  where (public.supervisor_investigations.revision_hash<>excluded.revision_hash
    -- A genuinely reopened source is different from a passive unchanged
    -- incident: an owner-handled task that becomes actionable again may
    -- restart without altering its original material payload.
    or (public.supervisor_investigations.phase='resolved'
      and public.supervisor_investigations.last_error='source_closed')
    or (public.supervisor_investigations.phase='blocked'
      and public.supervisor_investigations.last_error in
        ('source_missing','source_reassigned','authorization_revoked')))
    and (public.supervisor_investigations.lease_until is null
      or public.supervisor_investigations.lease_until<=p_now);
  -- FOUND reports whether a new investigation was inserted or a material
  -- source revision reset it. Repeated identical scans are not new work.
  if found then
    -- A new episode supersedes earlier owner reports for the same exact
    -- business/owner/source. Preserve the report rows as Handled history,
    -- but never leave their old "Needs you" actions open alongside the new
    -- investigation. Rechecks of the SAME active episode do not enter here.
    select episode_id into v_episode from public.supervisor_investigations
      where business_id=p_business_id and owner_user_id=p_owner_user_id
        and source_type=p_source_type and source_id=p_source_id;
    update public.operating_tasks set status='handled',
      resolved_at=coalesce(resolved_at,p_now)
      where business_id=p_business_id and owner_user_id=p_owner_user_id
        and kind='priority_notice' and status in ('needs_owner','needs_response','watching')
        and payload->>'intent'='priority_investigation'
        and payload->>'sourceType'=p_source_type
        and payload->>'sourceId'=p_source_id
        and payload->>'episodeId' is distinct from v_episode::text;
    return true;
  end if;
  -- A priority change updates queue rank without resetting multi-step work.
  update public.supervisor_investigations set priority=p_priority
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id
      and revision_hash=p_revision_hash and priority is distinct from p_priority;
  return false;
end $function$
;

create or replace function public.post_supervisor_priority_notice(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,
  p_stable_key text,p_reason text,p_as_of timestamptz,
  p_routine_id uuid default null,p_run_id uuid default null,p_lease_token uuid default null
) returns boolean
language plpgsql security definer set search_path=public as $$
declare v_task_id text;v_found boolean;
        v_inserted_task_id text;v_o public.supervisor_routine_occurrences;
        v_r public.supervisor_routines;
begin
  if coalesce(auth.role(),'')<>'service_role'
  then raise exception 'Service role required' using errcode='42501'; end if;
  if not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then raise exception 'Owner or thread revoked' using errcode='42501'; end if;
  if p_source_type not in ('alert','operating_task','supplier_po','supplier_dispatch') or p_source_id is null
    or length(p_source_id) not between 1 and 256
    or p_revision_hash !~ '^[a-f0-9]{64}$' or p_stable_key !~ '^[a-f0-9]{64}$'
    or p_reason not in ('Overdue item needs review','Actionable café alert needs review',
      'Owner task needs review','Task response needs review',
      'Supplier purchase-order draft needs your approval',
       'Approved order unresolved: was the supplier contacted by Gmail, phone or portal, and what did they confirm?') or p_as_of is null
  then raise exception 'Invalid priority evidence' using errcode='22023'; end if;
  if p_routine_id is not null then
    if p_run_id is null or p_lease_token is null
    then raise exception 'Incomplete routine lease' using errcode='42501'; end if;
    select * into v_r from public.supervisor_routines
      where business_id=p_business_id and id=p_routine_id for update;
    select * into v_o from public.supervisor_routine_occurrences
      where business_id=p_business_id and routine_id=p_routine_id and run_id=p_run_id for update;
    if v_r.status<>'active' or v_o.state<>'running' or
      v_o.revision<>v_r.revision or v_o.lease_token is distinct from p_lease_token
      or v_o.lease_until<=p_as_of then
      raise exception 'Routine lease revoked or expired' using errcode='42501'; end if;
    if v_r.owner_user_id<>p_owner_user_id or v_r.thread_id<>p_thread_id
    then raise exception 'Routine owner mismatch' using errcode='42501'; end if;
  elsif p_run_id is not null or p_lease_token is not null
  then raise exception 'Invalid independent notice lease' using errcode='42501'; end if;
  if p_source_type='alert' then
    select exists(select 1 from public.alerts a where a.business_id=p_business_id
      and a.id::text=p_source_id and a.status in ('new','seen')
        and not (a.kind='business_anomaly' and
          (a.payload->>'family'='data_gap' or
           a.payload->>'quality' in ('technical_failure','not_matured'))))
      into v_found;
  elsif p_source_type='supplier_po' then
    select exists(select 1 from public.supervisor_proposals p
      where p.business_id=p_business_id and p.id::text=p_source_id
        and p.owner_user_id=p_owner_user_id and p.thread_id=p_thread_id
        and p.capability_id='maya.supplier_purchase_order.v1'
        and p.status='draft'
        and p.created_at<=p_as_of-interval '2 hours'
        for share) into v_found;
  elsif p_source_type='supplier_dispatch' then
    -- The owner-report BEFORE INSERT trigger takes this identical PO lock.
    -- Acquire it first, then read reports in a separate SQL statement:
    -- READ COMMITTED must see a terminal report committed while we waited.
    perform 1 from public.purchase_orders po
      join public.supervisor_proposals origin on origin.business_id=po.business_id
        and origin.id=po.proposal_id
      where po.business_id=p_business_id and po.owner_user_id=p_owner_user_id
        and po.id::text=p_source_id and origin.thread_id=p_thread_id
        and po.status='approved_for_ordering'
        and po.approved_at<=p_as_of-interval '2 hours'
      for update of po;
    if not found then return false; end if;
    select not exists(select 1 from public.purchase_order_channel_reports r
      where r.business_id=p_business_id and r.purchase_order_id=p_source_id::uuid
        and r.outcome in ('supplier_accepted','supplier_declined'))
      into v_found;
  else
    select exists(select 1 from public.operating_tasks t where t.business_id=p_business_id
      and t.id=p_source_id and t.kind not in
        ('priority_notice','commitment','event_plan','event_change','event_report')
      and t.status in ('needs_owner','needs_response')
      and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)) into v_found;
  end if;
  if not v_found then return false; end if;
  v_task_id:='priority:'||p_stable_key;
  if p_source_type='supplier_dispatch' then
    -- A previously published revision (even already handled/superseded) must
    -- NEVER close the newest unresolved notice on a delayed retry. The PO
    -- row is locked above, so this read and the following supersession are
    -- serialized against all other vendor notice writers.
    if exists(select 1 from public.operating_tasks t
      where t.business_id=p_business_id and t.owner_user_id=p_owner_user_id
        and t.id=v_task_id and t.kind='priority_notice') then
      return false;
    end if;
    -- Changes from not_prepared -> prepared -> Gmail-accepted alter the
    -- revision hash. Keep one owner action per PO, closing the superseded
    -- notice before inserting the new source revision in THIS transaction.
    -- The PO row lock also serializes concurrent revision writers/reports.
    update public.operating_tasks t
       set status='handled',resolved_at=now(),updated_at=now()
     where t.business_id=p_business_id and t.owner_user_id=p_owner_user_id
       and t.kind='priority_notice' and t.status='needs_owner'
       and t.payload->>'sourceType'='supplier_dispatch'
       and t.payload->>'sourceId'=p_source_id
       and t.id<>v_task_id;
  end if;
  insert into public.operating_tasks
    (business_id,id,owner_user_id,agent_id,kind,status,payload,confidence,evidence,
      entity_type,dedupe_key)
  values(p_business_id,v_task_id,p_owner_user_id,
    case when p_source_type in ('supplier_po','supplier_dispatch') then 'maya' else 'leo' end,
    'priority_notice','needs_owner',
    jsonb_build_object('title',p_reason,'threadId',p_thread_id::text,
      'sourceType',p_source_type,'sourceId',p_source_id,
      'priorityReason',p_reason,'asOf',p_as_of::text),
    case
      when p_source_type in ('supplier_po','supplier_dispatch') then 'high'
      when p_source_type='alert' and exists(
        select 1 from public.alerts a where a.business_id=p_business_id
          and a.id::text=p_source_id and a.payload->>'quality'='verified'
      ) then 'high'
      else 'low' end,
    jsonb_build_array(jsonb_build_object('source',p_source_type,
      'facts',jsonb_build_object('sourceId',p_source_id,
        'revisionHash',p_revision_hash,'asOf',p_as_of::text))),
    'priority_source',p_stable_key)
  on conflict do nothing returning id into v_inserted_task_id;
  -- Ordinary notices live in the attention surface; never write generic chat.
  return v_inserted_task_id is not null;
end $$;

-- CREATE OR REPLACE preserves the original service_role-only EXECUTE grants.
CREATE OR REPLACE FUNCTION public.supervisor_fail_investigation(p_business_id uuid, p_owner_user_id uuid, p_source_type text, p_source_id text, p_lease_token uuid, p_error text, p_now timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.supervisor_investigations;v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_error not in ('source_unavailable','provider_unavailable','owner_quota_reached','model_incomplete',
    'evidence_incomplete','authorization_revoked','time_exceeded','storage_failed')
  then raise exception 'Invalid investigation error code' using errcode='22023'; end if;
  select * into v from public.supervisor_investigations
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id for update;
  if not found or v.lease_token is distinct from p_lease_token
    or v.lease_until<=p_now then return false; end if;
  v_count:=case when p_error='owner_quota_reached' then v.failure_count
    else least(3,v.failure_count+1) end;
  update public.supervisor_investigations set
    -- Three bounded technical retries; a terminal failure remains visible but
    -- does not continue paid work every six hours without new evidence.
    -- Keep the original owner question replyable even after paid model
    -- retries are exhausted. A blocked row clears pending_question_id via
    -- supervisor_reset_investigation_answer_scope and rejects the saved
    -- owner's response. The lease still sleeps indefinitely below.
    phase=case when v.phase='awaiting_owner' and v.pending_question_id is not null
        and (v.last_owner_answer_id is null or
             v.last_owner_answer_id=v.reported_owner_answer_id)
        and p_error<>'authorization_revoked' then 'awaiting_owner'
      when p_error='authorization_revoked' or v_count>=3 then 'blocked'
      else v.phase end,
    failure_count=v_count,
    last_error=p_error,lease_token=null,lease_until=null,
    next_retry_at=case when p_error='owner_quota_reached'
      then (date_trunc('day',p_now at time zone 'UTC')+interval '1 day') at time zone 'UTC'
      when v_count>=3 or p_error='authorization_revoked' then 'infinity'::timestamptz
      else p_now+(interval '1 minute'*least(60,power(2,v_count)::integer)) end,
    updated_at=p_now
  where business_id=p_business_id and owner_user_id=p_owner_user_id
    and source_type=p_source_type and source_id=p_source_id;
  -- The persisted fenced error is the engineering diagnostic. No technical
  -- failure may create a generic owner chat message.
  return true;
end $function$
;

-- Existing detector gaps are technically unready; never pay again for the
-- unchanged cause. Preserve every incident, message and source row as audit.
update public.supervisor_investigations i
set phase='blocked',last_error='source_ineligible',
    lease_token=null,lease_until=null,next_retry_at='infinity'::timestamptz,
    updated_at=statement_timestamp()
from public.alerts a
where i.business_id=a.business_id and i.source_type='alert'
  and i.source_id=a.id::text
  and i.phase in ('collect','investigate','awaiting_owner')
  and a.kind='business_anomaly'
  and (a.payload->>'family'='data_gap' or
       a.payload->>'quality' in ('technical_failure','not_matured'));

-- The technical attention row is no longer actionable. Do not delete audit
-- and do not modify any item which the owner already handled.
update public.operating_tasks t
set status='handled',resolved_at=coalesce(t.resolved_at,statement_timestamp()),
    updated_at=statement_timestamp()
from public.alerts a
where t.business_id=a.business_id and t.kind='priority_notice'
  and t.status in ('needs_owner','needs_response','watching')
  and t.payload->>'sourceType'='alert'
  and t.payload->>'sourceId'=a.id::text
  and a.kind='business_anomaly'
  and (a.payload->>'family'='data_gap' or
       a.payload->>'quality' in ('technical_failure','not_matured'));

-- The U3 retained operational Toast views independently enforced the same
-- arbitrary 31-day cap. Preserve the original signed tenant/owner/mode, field
-- scrubbing, source date-pair validation and SECURITY DEFINER owner; remove only
-- the interval-length rejection. Heavy SQL still meets PostgreSQL statement
-- timeout, planner admission and per-page output controls.
CREATE OR REPLACE FUNCTION u3_research_private.toast_operational_records()
RETURNS TABLE(
 source text,source_ref text,status text,business_date date,record_type text,
 record_ref text,order_ref text,check_ref text,counts_in_sales boolean,data jsonb
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $u3_toast_records$
 SELECT r.source,
  CASE WHEN s.mode='owner' THEN r.source_ref ELSE NULL END,
  r.status,r.business_date,r.record_type,
  CASE WHEN s.mode='owner' THEN r.record_ref ELSE NULL END,
  CASE WHEN s.mode='owner' THEN r.order_ref ELSE NULL END,
  CASE WHEN s.mode='owner' THEN r.check_ref ELSE NULL END,
  r.counts_in_sales,
  CASE WHEN s.mode='owner' THEN r.data ELSE NULL::jsonb END
 FROM u3_research_private.scope() s
 CROSS JOIN LATERAL (
  SELECT nullif(current_setting('aicafe.u3_date_from',true),'')::date AS from_day,
   nullif(current_setting('aicafe.u3_date_to',true),'')::date AS to_day
 ) u3_window
 CROSS JOIN LATERAL public.toast_records_for(s.business_id,
    CASE WHEN u3_window.from_day IS NOT NULL AND u3_window.to_day IS NOT NULL
      AND u3_window.to_day>=u3_window.from_day
      THEN u3_window.from_day ELSE '9999-12-31'::date END,
    CASE WHEN u3_window.from_day IS NOT NULL AND u3_window.to_day IS NOT NULL
      AND u3_window.to_day>=u3_window.from_day
      THEN u3_window.to_day ELSE '0001-01-01'::date END) r
 WHERE u3_window.from_day IS NOT NULL AND u3_window.to_day IS NOT NULL
   AND u3_window.to_day>=u3_window.from_day
  
$u3_toast_records$;

CREATE OR REPLACE FUNCTION u3_research_private.toast_change_rows()
RETURNS TABLE(
 change_id bigint,entity text,entity_guid uuid,business_date date,
 changed_at timestamptz,field_path text,before_scalar text,after_scalar text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $u3_change_rows$
 SELECT
  c.id,c.entity,
  CASE WHEN s.mode='owner' THEN c.entity_guid ELSE NULL::uuid END,
  c.business_date,c.changed_at,n.named_path,
  CASE WHEN s.mode='owner'
    AND jsonb_typeof(e.value->'before') IN ('string','number','boolean')
    AND length(e.value->>'before')<=256
    THEN e.value->>'before' ELSE NULL END,
  CASE WHEN s.mode='owner'
    AND jsonb_typeof(e.value->'after') IN ('string','number','boolean')
    AND length(e.value->>'after')<=256
    THEN e.value->>'after' ELSE NULL END
 FROM u3_research_private.scope() s
 CROSS JOIN LATERAL (
  SELECT nullif(current_setting('aicafe.u3_date_from',true),'')::date AS from_day,
    nullif(current_setting('aicafe.u3_date_to',true),'')::date AS to_day
 ) u3_window
 JOIN public.toast_raw_changes c ON c.business_id=s.business_id
 CROSS JOIN LATERAL jsonb_array_elements(c.changes) e(value)
 CROSS JOIN LATERAL (
  SELECT 'data.' || btrim(regexp_replace(
     coalesce(e.value->>'path',''), '\[[^]]+\]', '.0','g'),'.') AS named_path
 ) n
 WHERE u3_window.from_day IS NOT NULL AND u3_window.to_day IS NOT NULL
  AND u3_window.to_day>=u3_window.from_day
 
  AND coalesce(c.business_date,(c.changed_at AT TIME ZONE 'UTC')::date)
      BETWEEN u3_window.from_day AND u3_window.to_day
  AND length(n.named_path)<=512
  AND public.ai_query_path(n.named_path) IS NOT NULL
  AND n.named_path !~* '(^|\.)(note|notes|instructions|comment|comments|memo|message|freeText|text|description)(\.|$)'
  AND (jsonb_typeof(e.value->'before') IN ('string','number','boolean','null')
    OR jsonb_typeof(e.value->'after') IN ('string','number','boolean','null'))
$u3_change_rows$;
