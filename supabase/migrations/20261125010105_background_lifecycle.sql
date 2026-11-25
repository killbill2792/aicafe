-- Background lifecycle: system conditions never reach the owner, one notice per waiting item,
-- no technical chat messages, silent closure. Extends the existing queue and notice writers; no new scheduler or store.
set lock_timeout='3s';
set statement_timeout='45s';

-- Which alerts the owner can act on. Keep the list in sync with lib/alerts/ownerActionable.ts (a test compares them).
create function public.supervisor_alert_owner_actionable(p_kind text,p_payload jsonb)
returns boolean language sql immutable set search_path='' as $actionable$
 select case
  when p_kind is distinct from 'business_anomaly' then true
  when p_payload->>'family' is distinct from 'data_gap' then true
  else coalesce(p_payload->>'subject' in ('actual_wage_coverage','ingredient_prices','stock_counts','expense_coverage'),false)
 end
$actionable$;
revoke all on function public.supervisor_alert_owner_actionable(text,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_alert_owner_actionable(text,jsonb) to service_role;

CREATE OR REPLACE FUNCTION public.supervisor_enqueue_investigation(p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_source_type text, p_source_id text, p_revision_hash text, p_stable_key text, p_priority integer, p_now timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_open boolean;v_episode uuid;v_anomaly boolean:=false;v_drift boolean:=false;
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
        and public.supervisor_alert_owner_actionable(a.kind,a.payload)) into v_open;
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
    -- Rolling comparisons (this week against last) drift with every refresh; discrete findings do not.
    select exists(select 1 from public.alerts a where a.business_id=p_business_id
       and a.id::text=p_source_id and a.kind='business_anomaly'
       and a.payload->>'family' in ('sales_decline','sales_growth','live_sales_decline','live_sales_growth','labor_cost',
         'recorded_expense_rise','recorded_refund_rise','order_refund_rise','operating_margin','cost_recovery_lag',
         'cost_recovery_ahead','overstaffed_hour','customer_trend','high_contribution','product_contribution')) into v_drift;
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
       -- A rolling business metric drifts every refresh. Drift may wake work at most once every six hours.
       and (not v_drift or updated_at<=p_now-interval '6 hours')
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
  -- Drift restarts work at most every six hours (a blocked investigation: a day).
  where (not v_drift or public.supervisor_investigations.updated_at<=p_now-
      case when public.supervisor_investigations.phase='blocked' then interval '24 hours' else interval '6 hours' end)
    and (public.supervisor_investigations.revision_hash<>excluded.revision_hash
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
declare v_task_id text;v_msg_id uuid;v_hash text;v_found boolean;
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
      and public.supervisor_alert_owner_actionable(a.kind,a.payload)) into v_found;
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
  -- An item with an open notice waiting for the owner is not announced again when its evidence moves.
  if p_source_type in ('alert','operating_task') and exists(
    select 1 from public.operating_tasks t
    where t.business_id=p_business_id and t.owner_user_id=p_owner_user_id
      and t.kind='priority_notice' and t.status in ('needs_owner','needs_response','watching')
      and t.payload->>'sourceType'=p_source_type and t.payload->>'sourceId'=p_source_id
      and t.id<>v_task_id) then
    return false;
  end if;
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
    'high',jsonb_build_array(jsonb_build_object('source',p_source_type,
      'facts',jsonb_build_object('sourceId',p_source_id,
        'revisionHash',p_revision_hash,'asOf',p_as_of::text))),
    'priority_source',p_stable_key)
  on conflict do nothing returning id into v_inserted_task_id;
  v_hash:=md5('priority-notice:'||p_business_id::text||':'||p_owner_user_id::text||':'||v_task_id);
  v_msg_id:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
    substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
  insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
    content_type,structured_content,grounding)
  values(v_msg_id,p_business_id,p_thread_id,p_owner_user_id,'supervisor','blocks',
    jsonb_build_array(jsonb_build_object('type','text','text',p_reason)),
    jsonb_build_object('status','verified','intent','priority_notice',
      'evidence',jsonb_build_array(jsonb_build_object('source',p_source_type,
        'identifier',p_source_id,'asOf',p_as_of::text))))
  on conflict(id) do nothing;
  return v_inserted_task_id is not null;
end $$;


-- A dependency shares the answer, not the original row's unique reply authority.
alter table public.supervisor_investigations add column shared_question_id uuid;
create function public.supervisor_normalize_question(p_question text)
returns text language sql immutable strict set search_path='' as $$
  select btrim(regexp_replace(regexp_replace(lower(p_question),'[^[:alnum:][:space:]]',' ','g'),'[[:space:]]+',' ','g'))
$$;
revoke all on function public.supervisor_normalize_question(text) from public,anon,authenticated;

create or replace function public.supervisor_reset_investigation_answer_scope()
returns trigger language plpgsql set search_path=public as $$
begin
 if new.episode_id is distinct from old.episode_id then
  new.pending_question_id:=null;new.shared_question_id:=null;
  new.last_owner_answer_id:=null;new.reported_owner_answer_id:=null;
 elsif new.phase in ('resolved','blocked') then
  new.pending_question_id:=null;new.shared_question_id:=null;
 end if;
 return new;
end $$;

-- Only the authenticated answer RPC's recorded response can wake dependents.
-- If the primary card becomes stale without an answer, release dependents to
-- investigate again rather than leave them asleep with an unanswerable card.
create function public.supervisor_settle_shared_investigation_question()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_answer uuid;
begin
 if new.episode_id=old.episode_id and new.last_owner_answer_id is distinct from old.last_owner_answer_id
   and new.last_owner_answer_id is not null and new.phase='awaiting_owner'
   and exists(select 1 from public.ai_messages a where a.id=new.last_owner_answer_id
    and a.business_id=old.business_id and a.owner_user_id=old.owner_user_id
    and a.thread_id=old.thread_id and a.role='owner'
    and a.owner_input_prompt_message_id=old.pending_question_id
    and a.owner_input_response->>'questionId'=old.pending_question_id::text) then
  v_answer:=new.last_owner_answer_id;
 end if;
 with affected as (
  update public.supervisor_investigations d set shared_question_id=null,
    phase=case when v_answer is null then 'investigate' else 'awaiting_owner' end,
    last_owner_answer_id=coalesce(v_answer,d.last_owner_answer_id),
    lease_token=null,lease_until=null,next_retry_at=clock_timestamp(),
    failure_count=0,last_error=null,updated_at=clock_timestamp()
  where d.business_id=old.business_id and d.owner_user_id=old.owner_user_id
    and d.thread_id=old.thread_id and d.phase='awaiting_owner'
    and d.shared_question_id=old.pending_question_id
  returning d.episode_id
 )
 update public.operating_tasks t set status='handled',resolved_at=coalesce(t.resolved_at,clock_timestamp())
 where v_answer is not null and t.business_id=old.business_id and t.owner_user_id=old.owner_user_id
   and t.kind='priority_notice' and t.status in ('needs_owner','needs_response','watching')
   and t.payload->>'intent'='priority_investigation'
   and t.payload->>'episodeId' in (select episode_id::text from affected);
 return new;
end $$;
revoke all on function public.supervisor_settle_shared_investigation_question() from public,anon,authenticated;
create trigger supervisor_settle_shared_investigation_question
 after update on public.supervisor_investigations for each row
 when (old.pending_question_id is not null and new.pending_question_id is distinct from old.pending_question_id)
 execute function public.supervisor_settle_shared_investigation_question();

create or replace function public.supervisor_finish_investigation(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,
  p_lease_token uuid,p_outcome text,p_evidence jsonb,p_narrative text,
  p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_phase text;v_hash text;v_msg uuid;v_blocks jsonb;v_proposal public.supervisor_proposals;v_new_question boolean:=false;v_shared_question uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  -- Serialize question publication with the existing exact-thread answer RPC.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
  -- The source is the authority for who may see this result right NOW.
  -- Acquire its FOR SHARE lock BEFORE the investigation lease row: source
  -- status triggers already lock source -> investigation in that order.
  -- FOR SHARE blocks concurrent updates to status/owner and deletions until
  -- this transaction atomically commits the checkpoint, inbox and chat.
  -- A prior model read cannot authorize a later report after reassignment.
  if p_source_type='alert' then
    perform 1 from public.alerts a
      where a.business_id=p_business_id and a.id::text=p_source_id
        and a.status in ('new','seen') for share;
  elsif p_source_type='operating_task' then
    perform 1 from public.operating_tasks t
      where t.business_id=p_business_id and t.id=p_source_id
        and t.kind not in ('priority_notice','commitment','event_plan',
          'event_change','event_report')
        and t.status in ('needs_owner','needs_response','watching')
        and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)
      for share;
  else
    return false;
  end if;
  if not found then return false; end if;
  select * into v from public.supervisor_investigations
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id for update;
  if not found or v.thread_id<>p_thread_id or v.revision_hash<>p_revision_hash
    or v.lease_token is distinct from p_lease_token or v.lease_until<=p_now
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
  then return false; end if;
  if p_outcome='collected' and v.phase='collect' then v_phase:='investigate';
  elsif p_outcome='investigated' and v.phase='investigate' then v_phase:='awaiting_owner';
  elsif p_outcome='followed_up' and v.phase='awaiting_owner' then v_phase:='awaiting_owner';
  elsif p_outcome='rechecked' and v.phase='awaiting_owner' then v_phase:='awaiting_owner';
  else raise exception 'Invalid investigation transition' using errcode='23514'; end if;
  if p_evidence is null or jsonb_typeof(p_evidence)<>'object'
    or octet_length(p_evidence::text)>8192 then
    raise exception 'Invalid investigation evidence' using errcode='22023'; end if;
  if p_outcome not in ('collected','rechecked') and
    (p_narrative is null or length(btrim(p_narrative)) not between 1 and 1800) then
    raise exception 'Investigation needs a grounded next step' using errcode='22023'; end if;
  -- Link a repeated question to the existing live card in this exact private thread.
  -- This check and publication share the answer RPC's transaction lock.
  v_shared_question:=v.shared_question_id;
  if p_outcome in ('investigated','followed_up') then
    if v.pending_question_id is null and v_shared_question is null
      and p_evidence->>'ownerQuestion' is not null
      and length(btrim(p_evidence->>'ownerQuestion')) between 1 and 200 then
      select i.pending_question_id into v_shared_question
      from public.supervisor_investigations i
      join public.ai_messages m on m.id=i.pending_question_id
        and m.business_id=i.business_id and m.owner_user_id=i.owner_user_id
        and m.thread_id=i.thread_id and m.role='supervisor'
      where i.business_id=p_business_id and i.owner_user_id=p_owner_user_id
        and i.thread_id=p_thread_id and i.phase='awaiting_owner'
        and (i.source_type,i.source_id)<>(p_source_type,p_source_id)
        and m.grounding->>'durableQuestionId'=m.id::text
        and m.grounding->>'intent'='priority_investigation'
        and m.grounding->>'investigationEpisodeId'=i.episode_id::text
        and exists(select 1 from jsonb_array_elements(
          case when jsonb_typeof(m.structured_content)='array' then m.structured_content else '[]'::jsonb end
        ) b where b->>'type'='clarify' and
          public.supervisor_normalize_question(b->>'question')=
          public.supervisor_normalize_question(p_evidence->>'ownerQuestion'))
      order by m.created_at,m.id limit 1 for share of i;
    end if;
    if v_shared_question is not null or v.pending_question_id is not null then
      -- A duplicate must not be repeated in the plain text either.
      p_narrative:=btrim(regexp_replace(p_narrative,E'(^|\\n)Owner question:[^\\n]*','','gi'));
      if p_narrative='' then p_narrative:='Waiting for the answer to the question already open in this conversation.';end if;
    end if;
  end if;
  update public.supervisor_investigations set phase=v_phase,evidence=p_evidence,
    narrative=case when p_outcome in ('collected','rechecked') then narrative else btrim(p_narrative) end,
    step_version=step_version+1,failure_count=0,lease_token=null,lease_until=null,
    next_retry_at=case when p_outcome='collected' then p_now
      else p_now+interval '6 hours' end,
    last_error=null,updated_at=p_now
    where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id;
  if p_outcome in ('investigated','followed_up') then
    -- Reuse the shared operating_tasks inbox. This insertion and the chat
    -- message below commit atomically from the single fenced SQL checkpoint.
    -- An episode+step key is different for each real follow-up, but stable
    -- for retries of that exact report. It is an owner-private priority notice.
    insert into public.operating_tasks
      (business_id,id,owner_user_id,agent_id,kind,status,payload,confidence,
       evidence,entity_type,dedupe_key)
    values (
      p_business_id,
      'investigation:'||v.stable_key||':'||v.episode_id::text||':'||(v.step_version+1)::text,
      p_owner_user_id,'leo','priority_notice','needs_owner',
      jsonb_build_object('title',left(btrim(p_narrative),180),
        'threadId',p_thread_id::text,'sourceType',p_source_type,
        'sourceId',p_source_id,'revisionHash',p_revision_hash,
        'episodeId',v.episode_id::text,'stepVersion',v.step_version+1,
        'ownerNoticeDate',(p_now at time zone
          (select timezone from public.businesses where id=p_business_id))::date::text,
        'asOf',p_now::text,'intent','priority_investigation',
        'externalEffects','not_attempted'),
      case when p_evidence->'source'->>'quality' in ('partial','missing','stale')
        or (p_evidence ? 'missing' and p_evidence->'missing'<>'[]'::jsonb)
        then 'low' else 'high' end,
      jsonb_build_array(jsonb_build_object('source',p_source_type,
        'facts',jsonb_build_object('sourceId',p_source_id,
          'revisionHash',p_revision_hash,'episodeId',v.episode_id::text,
          'asOf',p_now::text))),
      'priority_source',
      'investigation:'||v.stable_key||':'||v.episode_id::text||':'||(v.step_version+1)::text
    ) on conflict do nothing;
    v_hash:=md5('investigation:'||p_business_id::text||':'||p_owner_user_id::text||
      ':'||p_source_type||':'||p_source_id||':'||p_revision_hash||':'||
      v.episode_id::text||':'||(v.step_version+1)::text);
    v_msg:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
      substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
    v_blocks:=jsonb_build_array(jsonb_build_object('type','text','text',btrim(p_narrative)));
    -- Keep verified model text complete; publish server-observed purchasing
    -- status as a separate existing note block for the exact leased stock source.
    if p_source_type='alert' and jsonb_typeof(p_evidence->'stockProcurementStatus')='string'
      and length(btrim(p_evidence->>'stockProcurementStatus')) between 1 and 1100
      and exists(select 1 from public.alerts a where a.business_id=p_business_id
        and a.id::text=p_source_id and a.kind='business_anomaly'
        and a.payload->>'family' in ('stockout_risk','stock_shortage')) then
      v_blocks:=v_blocks||jsonb_build_array(jsonb_build_object('type','warning',
        'code','stock_procurement_status','text','Procurement status: '||btrim(p_evidence->>'stockProcurementStatus')));
    end if;
    -- Keep one unanswered question across repeated reminders.
    if v.pending_question_id is null and v_shared_question is null and p_evidence->>'ownerQuestion' is not null
      and length(btrim(p_evidence->>'ownerQuestion')) between 1 and 200 then
      v_new_question:=true;
      v_blocks:=v_blocks||jsonb_build_array(jsonb_build_object('type','clarify','kind','choice',
        'question',p_evidence->>'ownerQuestion','allowOther',true,'options',
        jsonb_build_array(jsonb_build_object('label','I do not have that information yet','value','unknown'),
          jsonb_build_object('label','I will check the source records','value','checking'))));
    end if;
    update public.supervisor_investigations set
      pending_question_id=case when v_new_question then v_msg else v.pending_question_id end,
      shared_question_id=v_shared_question,
      reported_owner_answer_id=v.last_owner_answer_id
      where business_id=p_business_id and owner_user_id=p_owner_user_id
      and source_type=p_source_type and source_id=p_source_id;
    -- Only an inert, owner-scoped follow-up draft for this exact claimed
    -- receiving source can be attached to the existing atomic owner update.
    if p_evidence ? 'receivingFollowupProposalId' and p_source_type='operating_task'
      and p_source_id like 'supplier-receiving:%' then
      select * into v_proposal from public.supervisor_proposals where business_id=p_business_id
        and owner_user_id=p_owner_user_id and thread_id=p_thread_id
        and id=(p_evidence->>'receivingFollowupProposalId')::uuid
        and status='draft' and capability_id='alex.gmail_effect.v1'
        and 'supplier-receiving:'||(canonical_effect_payload->'supplierFollowup'->>'purchaseOrderId')=p_source_id;
      if v_proposal.id is not null then
        v_blocks:=v_blocks||jsonb_build_array(jsonb_build_object('type','proposal_card','proposalId',v_proposal.id::text));
      end if;
    end if;
    -- A separate email approval must match the same ingredient and an existing
    -- approved PO's prepared dispatch; a stock alert never authorizes sending.
    if p_source_type='alert' and p_evidence ? 'stockEmailProposalId' then
      select p.* into v_proposal from public.supervisor_proposals p
      join public.purchase_order_dispatches d on d.business_id=p.business_id and d.proposal_id=p.id and d.owner_user_id=p.owner_user_id
      join public.purchase_orders o on o.business_id=d.business_id and o.id=d.purchase_order_id and o.owner_user_id=d.owner_user_id
      join public.purchase_order_lines l on l.business_id=o.business_id and l.purchase_order_id=o.id
      join public.alerts a on a.business_id=p.business_id and a.id::text=p_source_id
      where p.business_id=p_business_id and p.owner_user_id=p_owner_user_id and p.thread_id=p_thread_id
       and p.id::text=p_evidence->>'stockEmailProposalId' and p.status='draft' and p.capability_id='alex.gmail_effect.v1'
       and d.state='prepared' and o.status='approved_for_ordering' and d.po_revision=o.revision and d.po_effect_hash=o.effect_hash
       and a.kind='business_anomaly' and a.payload->>'family' in ('stockout_risk','stock_shortage')
       and l.ingredient_id::text=a.payload->>'subject' limit 1;
      if found and not exists(select 1 from public.ai_messages m where m.business_id=p_business_id and m.owner_user_id=p_owner_user_id
       and m.thread_id=p_thread_id and m.structured_content @> jsonb_build_array(jsonb_build_object('type','proposal_card','proposalId',v_proposal.id::text))) then
        v_blocks:=v_blocks||jsonb_build_array(jsonb_build_object('type','proposal_card','proposalId',v_proposal.id::text));
      end if;
    end if;
    -- Only the currently claimed stock-risk ingredient can carry a matching inert draft.
    if p_source_type='alert' and p_evidence ? 'stockPurchaseProposalId' then
      select p.* into v_proposal from public.supervisor_proposals p
      join public.alerts a on a.business_id=p.business_id and a.id::text=p_source_id
      where p.business_id=p_business_id and p.owner_user_id=p_owner_user_id
        and p.thread_id=p_thread_id and p.id::text=p_evidence->>'stockPurchaseProposalId'
        and p.status='draft' and p.capability_id='maya.supplier_purchase_order.v1'
        and a.kind='business_anomaly' and a.payload->>'family' in ('stockout_risk','stock_shortage')
        and jsonb_array_length(p.canonical_effect_payload->'lines')=1
        and p.canonical_effect_payload #>> '{lines,0,ingredientId}'=a.payload->>'subject';
      if found and not exists(select 1 from public.ai_messages m
        where m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
        and m.structured_content @> jsonb_build_array(jsonb_build_object('type','proposal_card','proposalId',v_proposal.id::text))) then
        v_blocks:=v_blocks||jsonb_build_array(jsonb_build_object('type','proposal_card','proposalId',v_proposal.id::text));
      end if;
    end if;
    insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
      content_type,structured_content,grounding)
    values(v_msg,p_business_id,p_thread_id,p_owner_user_id,'supervisor','blocks',
      v_blocks,
      jsonb_build_object('status',case
          when p_evidence->'source'->>'quality' in ('partial','missing','stale')
            or (p_evidence ? 'missing' and p_evidence->'missing'<>'[]'::jsonb)
          then 'partial' else 'verified' end,
        'intent','priority_investigation',
        'evidence',jsonb_build_array(jsonb_build_object('source',p_source_type,
          'identifier',p_source_id,'revisionHash',p_revision_hash,
          'asOf',p_now::text)),
        'agentMetadata',jsonb_build_object('phase',v_phase,'stepVersion',v.step_version+1,
          'externalEffects','not_attempted','effectReceipt',null))
        ||case when v_new_question then jsonb_build_object('durableQuestionId',v_msg::text,'investigationEpisodeId',v.episode_id::text) else '{}'::jsonb end
        ||case when v.last_owner_answer_id is not null and v.reported_owner_answer_id is distinct from v.last_owner_answer_id
          then jsonb_build_object('ownerMessageId',v.last_owner_answer_id::text) else '{}'::jsonb end)
    on conflict(id) do nothing;
  end if;
  return true;
end $$;


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
    phase=case when v.phase='awaiting_owner' and (v.pending_question_id is not null or v.shared_question_id is not null)
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
  -- A technical failure stays on the row for the health check; it is never posted into the owner's chat.
  return true;
end $function$
;

create or replace function public.supervisor_settle_investigation_on_source()
returns trigger language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_type text;v_hash text;v_msg uuid;
begin
  if tg_table_name='alerts' then
    if new.status in ('new','seen') then return new; end if;
    v_type:='alert';
  else
    -- Owner intent or snooze is not an applied change. A watching task is
    -- open until a trusted status transition actually handles/expires it.
    if new.kind='priority_notice' or new.status in ('needs_owner','needs_response','watching')
    then return new; end if;
    v_type:='operating_task';
  end if;
  for v in select * from public.supervisor_investigations
    where business_id=new.business_id and source_type=v_type
      and source_id=new.id::text and phase not in ('resolved','blocked')
    for update
  loop
    update public.supervisor_investigations set
      phase='resolved',lease_token=null,lease_until=null,
      last_error='source_closed',updated_at=now()
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    -- A real source closure settles EVERY open report/follow-up from the
    -- incident, not merely the last message. Keep all records for audit.
    -- The priority_notice trigger returns immediately, avoiding recursion.
    update public.operating_tasks set status='handled',
      resolved_at=coalesce(resolved_at,now())
      where business_id=v.business_id and owner_user_id=v.owner_user_id
        and kind='priority_notice' and status in ('needs_owner','needs_response','watching')
        and payload->>'intent'='priority_investigation'
        and payload->>'sourceType'=v.source_type
        and payload->>'sourceId'=v.source_id;
    -- This internal trigger runs only after a permitted canonical source
    -- update. Its recipient is the durable investigation owner, not the
    -- actor who closed the source (e.g. another authorized café member).
    -- Do not alter the caller-bound authorization helper or grant any RPC
    -- privileges. Recheck current membership, exact private thread and
    -- task ownership before writing to the recipient's existing inbox.
    if not exists(select 1 from public.memberships m
      where m.business_id=v.business_id and m.user_id=v.owner_user_id and m.role='owner')
      or not exists(select 1 from public.ai_threads t
        where t.business_id=v.business_id and t.id=v.thread_id and t.owner_user_id=v.owner_user_id)
      or (v_type='operating_task' and not exists(
        select 1 from public.operating_tasks t
        where t.business_id=v.business_id and t.id=v.source_id
          and (t.owner_user_id is null or t.owner_user_id=v.owner_user_id)))
      then continue; end if;
    -- Close silently unless the owner was waiting on a question from this investigation.
    if v.phase<>'awaiting_owner' or v.pending_question_id is null then continue; end if;
    v_hash:=md5('investigation-resolved:'||v.business_id::text||':'||v.owner_user_id::text||
      ':'||v.source_type||':'||v.source_id||':'||v.revision_hash||':'||v.episode_id::text);
    v_msg:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-4'||
      substr(v_hash,14,3)||'-a'||substr(v_hash,18,3)||'-'||substr(v_hash,21,12))::uuid;
    insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,
      content_type,structured_content,grounding)
    values(v_msg,v.business_id,v.thread_id,v.owner_user_id,'supervisor','blocks',
      jsonb_build_array(jsonb_build_object('type','text','text',
        'Follow-up: the original café issue is now closed in its source. I verified that status; this does not prove any external action succeeded.')),
      jsonb_build_object('status','verified','intent','priority_investigation_resolution',
        'evidence',jsonb_build_array(jsonb_build_object('source',v.source_type,
          'identifier',v.source_id,'asOf',now()::text))))
    on conflict(id) do nothing;
  end loop;
  return new;
end $$;

-- Settle EVERY open notice for a source when it closes, not only investigation reports.
create function public.supervisor_settle_priority_notices_on_source()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_type text;v_id text;
begin
  if tg_table_name='alerts' then
    if new.status in ('new','seen') then return new; end if;
    v_type:='alert';v_id:=new.id::text;
  else
    if new.kind='priority_notice' or new.status in ('needs_owner','needs_response','watching') then return new; end if;
    v_type:='operating_task';v_id:=new.id;
  end if;
  update public.operating_tasks set status='handled',resolved_at=coalesce(resolved_at,now())
    where business_id=new.business_id and kind='priority_notice'
      and status in ('needs_owner','needs_response','watching')
      and payload->>'sourceType'=v_type and payload->>'sourceId'=v_id;
  return new;
end $$;
revoke all on function public.supervisor_settle_priority_notices_on_source() from public,anon,authenticated;
create trigger settle_priority_notices_on_alert_status
  after update of status on public.alerts
  for each row when (old.status is distinct from new.status)
  execute function public.supervisor_settle_priority_notices_on_source();
create trigger settle_priority_notices_on_task_status
  after update of status on public.operating_tasks
  for each row when (old.status is distinct from new.status)
  execute function public.supervisor_settle_priority_notices_on_source();

-- (1) Notices for sources that are closed or are system conditions are settled.
update public.operating_tasks n set status='handled',resolved_at=coalesce(n.resolved_at,now())
where n.kind='priority_notice' and n.status in ('needs_owner','needs_response','watching')
  and n.payload->>'sourceType'='alert'
  and not exists(select 1 from public.alerts a where a.business_id=n.business_id and a.id::text=n.payload->>'sourceId'
    and a.status in ('new','seen') and public.supervisor_alert_owner_actionable(a.kind,a.payload));
update public.operating_tasks n set status='handled',resolved_at=coalesce(n.resolved_at,now())
where n.kind='priority_notice' and n.status in ('needs_owner','needs_response','watching')
  and n.payload->>'sourceType'='operating_task'
  and not exists(select 1 from public.operating_tasks t where t.business_id=n.business_id and t.id=n.payload->>'sourceId'
    and t.status in ('needs_owner','needs_response','watching'));
-- (2) Several open notices for one source keep only the newest.
update public.operating_tasks n set status='handled',resolved_at=coalesce(n.resolved_at,now())
where n.kind='priority_notice' and n.status in ('needs_owner','needs_response','watching')
  and n.payload->>'sourceType' in ('alert','operating_task')
  and coalesce(n.payload->>'intent','')<>'priority_investigation'
  and exists(select 1 from public.operating_tasks m
    where m.business_id=n.business_id and m.owner_user_id=n.owner_user_id and m.kind='priority_notice'
      and m.status in ('needs_owner','needs_response','watching')
      and coalesce(m.payload->>'intent','')<>'priority_investigation'
      and m.payload->>'sourceType'=n.payload->>'sourceType' and m.payload->>'sourceId'=n.payload->>'sourceId'
      and (m.created_at,m.id)>(n.created_at,n.id));
-- (3) Investigations that can no longer run are closed instead of waiting forever: a system condition, or a café
--     without a verified Toast connection (unattended work is not allowed there). They restart on a changed revision.
update public.supervisor_investigations i set phase='resolved',last_error='source_closed',
  lease_token=null,lease_until=null,updated_at=statement_timestamp()
where i.phase in ('collect','investigate') and i.source_type='alert'
  and exists(select 1 from public.alerts a where a.business_id=i.business_id and a.id::text=i.source_id
    and not public.supervisor_alert_owner_actionable(a.kind,a.payload));
update public.supervisor_investigations i set phase='blocked',last_error='source_unavailable',failure_count=greatest(failure_count,1),
  next_retry_at='infinity'::timestamptz,lease_token=null,lease_until=null,updated_at=statement_timestamp()
where i.phase in ('collect','investigate')
  and not exists(select 1 from public.toast_api_credentials tc where tc.business_id=i.business_id and tc.state='verified');
