set lock_timeout='1s';
set statement_timeout='5s';
alter table public.alerts add constraint alerts_kind_scope_v2 check(kind in ('missing_bill','voids','meal_break','early_clockin','underpriced','overstaffed','covered_milestone','unmatched_sales_items','business_anomaly')) not valid;
-- Reason: replacement above retains every existing alert kind and permits the single new source-backed observation kind.
-- squawk-ignore ban-drop-constraint
alter table public.alerts drop constraint alerts_kind_check;
create function public.supervisor_reconcile_business_anomaly(p_business_id uuid,p_key text,p_active boolean,p_payload jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare existing public.alerts;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_business_id is null or p_active is null
 or length(coalesce(p_key,'')) not between 1 and 200 or p_payload->>'dedupeKey' is distinct from p_key
 or not exists(select 1 from public.businesses where id=p_business_id and not is_demo)
 then raise exception 'anomaly_scope_invalid' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':business_anomaly:'||p_key,0));
 select * into existing from public.alerts where business_id=p_business_id and kind='business_anomaly' and payload->>'dedupeKey'=p_key
 order by created_at desc,id desc limit 1 for update;
 if not p_active then
  if found and existing.status in ('new','seen') then
   update public.alerts set status='resolved',payload=p_payload where id=existing.id and business_id=p_business_id;
  end if;
  return false;
 end if;
 if found then
  if existing.status in ('new','seen') then
   if existing.payload is distinct from p_payload then update public.alerts set payload=p_payload where id=existing.id and business_id=p_business_id; end if;
   return false;
  end if;
  if (existing.status='dismissed' or existing.payload->>'dispositionSource'='owner') and existing.payload-'dispositionSource'=p_payload then return false; end if;
 end if;
 insert into public.alerts(business_id,kind,impact_cents,payload) values(p_business_id,'business_anomaly',null,p_payload);
 return true;
end $$;
revoke all on function public.supervisor_reconcile_business_anomaly(uuid,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_reconcile_business_anomaly(uuid,text,boolean,jsonb) to service_role;

-- The canonical usage reader already accepts a trusted service-scoped client.
-- Keep the authenticated owner check; permit the existing internal cron role.
create or replace function public.pantry_usage_sales_evidence(
 p_business_id uuid,p_from date,p_to date
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_covered boolean;v_staff jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' and (auth.uid() is null or not exists (
  select 1 from public.memberships m where m.business_id=p_business_id
   and m.user_id=auth.uid() and m.role='owner'
 )) then raise exception 'not authorized' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>30
  then raise exception 'invalid usage range';end if;
 select not exists (
  select 1 from generate_series(p_from,p_to,interval '1 day') d
  where not exists (
   select 1 from public.daily_rollups r where r.business_id=p_business_id
    and r.business_date=d::date and r.sales_data_status='actual'
  )
 ) into v_covered;
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',t.id::text,'clockIn',t.clock_in,'clockOut',t.clock_out,
   'locationId',null,'staff',coalesce(e.display_name,'Unlinked employee'),
   'staffId',t.employee_id::text
  ) order by t.clock_in,t.id),'[]'::jsonb) into v_staff
 from public.timecards t
 join public.businesses b on b.id=t.business_id
 left join public.employees e on e.id=t.employee_id and e.business_id=t.business_id
 where t.business_id=p_business_id and t.source_type<>'owner_schedule'
   and t.clock_in < ((p_to+1)::timestamp at time zone b.timezone)
   and coalesce(t.clock_out,now()) >= (p_from::timestamp at time zone b.timezone);
 return jsonb_build_object('covered',v_covered,'staff',v_staff,
  'modifierMappings',coalesce((
    -- Preserve migration 099's linked Toast catalog modifier mappings.
    select jsonb_agg(jsonb_build_object('provider','toast',
     'locationRef',c.restaurant_guid::text,
     'posModifierId',c.provider_guid::text,
     'recipeId',c.linked_modifier_recipe_id::text))
    from public.toast_catalog_facts c
    join public.modifier_recipes cr
     on cr.id=c.linked_modifier_recipe_id and cr.business_id=c.business_id
    where c.business_id=p_business_id and c.kind='modifier'
     and c.linked_modifier_recipe_id is not null
   ),'[]'::jsonb) || coalesce((
    select jsonb_agg(jsonb_build_object('provider',l.provider,'locationRef',l.location_ref,
     'posModifierId',l.pos_modifier_id,'recipeId',l.modifier_recipe_id::text))
    from public.pantry_modifier_links l
    join public.modifier_recipes r on r.id=l.modifier_recipe_id and r.business_id=l.business_id
    where l.business_id=p_business_id
   ),'[]'::jsonb));
end $$;

revoke all on function public.pantry_usage_sales_evidence(uuid,date,date) from public,anon,authenticated;
grant execute on function public.pantry_usage_sales_evidence(uuid,date,date) to authenticated,service_role;


-- Create the ordinary private owner thread only when there is real actionable work.
-- This writes no owner message and grants no approval or external authority.
create function public.supervisor_ensure_proactive_thread(p_business_id uuid,p_owner_user_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare thread_id uuid;
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(
  select 1 from public.memberships m join public.businesses b on b.id=m.business_id
  where m.business_id=p_business_id and m.user_id=p_owner_user_id and m.role='owner' and not b.is_demo
 ) then raise exception 'proactive_thread_scope_invalid' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':'||p_owner_user_id::text||':proactive_thread',0));
 select id into thread_id from public.ai_threads
 where business_id=p_business_id and owner_user_id=p_owner_user_id order by updated_at desc,id limit 1;
 if thread_id is not null then return thread_id;end if;
 if not exists(select 1 from public.alerts a where a.business_id=p_business_id and a.status in ('new','seen'))
 and not exists(select 1 from public.operating_tasks t where t.business_id=p_business_id
 and (t.owner_user_id is null or t.owner_user_id=p_owner_user_id)
 and t.status in ('needs_owner','needs_response')
 and t.kind not in ('priority_notice','commitment','event_plan','event_change','event_report')) then return null;end if;
 insert into public.ai_threads(business_id,owner_user_id,client_request_id,title)
 values(p_business_id,p_owner_user_id,gen_random_uuid(),'Supervisor proactive review') returning id into thread_id;
 return thread_id;
end $$;
revoke all on function public.supervisor_ensure_proactive_thread(uuid,uuid) from public,anon,authenticated;
grant execute on function public.supervisor_ensure_proactive_thread(uuid,uuid) to service_role;

-- Persist exact question and answer references on the existing investigation.
alter table public.supervisor_investigations add column pending_question_id uuid,
 add column last_owner_answer_id uuid, add column reported_owner_answer_id uuid;
-- Reason: New nullable column is empty on migration; the index enforces question identity.
-- squawk-ignore require-concurrent-index-creation
create unique index supervisor_investigation_pending_question_idx on public.supervisor_investigations(pending_question_id) where pending_question_id is not null;
create function public.supervisor_reset_investigation_answer_scope()
returns trigger language plpgsql set search_path=public as $$
begin
 if new.episode_id is distinct from old.episode_id then
  new.pending_question_id:=null; new.last_owner_answer_id:=null; new.reported_owner_answer_id:=null;
 elsif new.phase in ('resolved','blocked') then new.pending_question_id:=null;
 end if;
 return new;
end $$;
revoke all on function public.supervisor_reset_investigation_answer_scope() from public,anon,authenticated;
create trigger supervisor_reset_investigation_answer_scope before update on public.supervisor_investigations
 for each row execute function public.supervisor_reset_investigation_answer_scope();

-- Preserve the existing fenced checkpoint and receiving-card behavior; attach an exact stock draft in the same owner-visible transaction.
create or replace function public.supervisor_finish_investigation(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,
  p_lease_token uuid,p_outcome text,p_evidence jsonb,p_narrative text,
  p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
declare v public.supervisor_investigations;v_phase text;v_hash text;v_msg uuid;v_blocks jsonb;v_proposal public.supervisor_proposals;v_new_question boolean:=false;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
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
    if v.pending_question_id is null and p_evidence->>'ownerQuestion' is not null
      and length(btrim(p_evidence->>'ownerQuestion')) between 1 and 200 then
      v_new_question:=true;
      v_blocks:=v_blocks||jsonb_build_array(jsonb_build_object('type','clarify','kind','choice',
        'question',p_evidence->>'ownerQuestion','allowOther',true,'options',
        jsonb_build_array(jsonb_build_object('label','I do not have that information yet','value','unknown'),
          jsonb_build_object('label','I will check the source records','value','checking'))));
    end if;
    update public.supervisor_investigations set
      pending_question_id=case when v_new_question then v_msg else v.pending_question_id end,
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

-- Same explicit owner answer metadata as Task 6/15C, on the existing
-- investigation rather than a synthetic owner run. No domain write.
create function public.supervisor_answer_investigation_question(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_question_id uuid,p_answer_id uuid,p_response jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare q public.ai_messages;a public.ai_messages;v public.supervisor_investigations;
begin
 if coalesce(auth.role(),'')<>'service_role'
   or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
   then raise exception 'owner_answer_denied' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
 select * into q from public.ai_messages where id=p_question_id and business_id=p_business_id
  and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='supervisor'
  and grounding->>'durableQuestionId'=id::text and grounding->>'intent'='priority_investigation'
  and grounding?'investigationEpisodeId';
 if not found then return null;end if;
 if p_response is null or jsonb_typeof(p_response)<>'object' or p_response->>'questionId' is distinct from p_question_id::text
   or p_response->>'action' is distinct from 'supply'
   or (p_response-'questionId'-'action'-'value')<>'{}'::jsonb
   or (p_response?'value' and (jsonb_typeof(p_response->'value')<>'string' or length(p_response->>'value')>200))
   then raise exception 'owner_answer_invalid' using errcode='22023';end if;
 select * into a from public.ai_messages where id=p_answer_id and business_id=p_business_id
  and owner_user_id=p_owner_user_id and thread_id=p_thread_id and role='owner'
  and content_type='text' and created_at>=q.created_at for update;
 if not found or length(btrim(coalesce(a.text_content,'')))=0
  then raise exception 'owner_answer_unavailable' using errcode='42501';end if;
 if a.owner_input_prompt_message_id=p_question_id and a.owner_input_response=p_response
  then return (q.grounding->>'investigationEpisodeId')::uuid;end if;
 -- Source lock precedes investigation lock, consistent with finish/source-close.
 if q.grounding->'evidence'->0->>'source'='alert' then
  perform 1 from public.alerts where business_id=p_business_id and id::text=q.grounding->'evidence'->0->>'identifier'
   and status in ('new','seen') for share;
 else
  perform 1 from public.operating_tasks where business_id=p_business_id and id=q.grounding->'evidence'->0->>'identifier'
   and status in ('needs_owner','needs_response','watching') and (owner_user_id is null or owner_user_id=p_owner_user_id) for share;
 end if;
 if not found then raise exception 'owner_question_stale' using errcode='23505';end if;
 select * into v from public.supervisor_investigations where business_id=p_business_id
  and owner_user_id=p_owner_user_id and thread_id=p_thread_id and episode_id::text=q.grounding->>'investigationEpisodeId'
  and pending_question_id=p_question_id and phase='awaiting_owner' for update;
 if not found or a.owner_input_response is not null or a.owner_input_prompt_message_id is not null
   or exists(select 1 from public.ai_agent_jobs j where j.business_id=p_business_id and j.owner_user_id=p_owner_user_id and j.owner_message_id=p_answer_id)
   or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id and x.owner_user_id=p_owner_user_id
    and (x.request_key=p_answer_id or p_answer_id=any(x.owner_answer_ids)))
  then raise exception 'owner_question_stale' using errcode='23505';end if;
 update public.ai_messages set owner_input_prompt_message_id=p_question_id,owner_input_response=p_response
  where id=p_answer_id;
 update public.supervisor_investigations set pending_question_id=null,last_owner_answer_id=p_answer_id,
  lease_token=null,lease_until=null,next_retry_at=clock_timestamp(),failure_count=0,last_error=null,updated_at=clock_timestamp()
  where business_id=p_business_id and owner_user_id=p_owner_user_id and source_type=v.source_type and source_id=v.source_id;
 update public.operating_tasks set status='handled',resolved_at=coalesce(resolved_at,clock_timestamp())
  where business_id=p_business_id and owner_user_id=p_owner_user_id and kind='priority_notice'
   and payload->>'episodeId'=v.episode_id::text and payload->>'intent'='priority_investigation'
   and status in ('needs_owner','needs_response','watching');
 return v.episode_id;
end $$;
revoke all on function public.supervisor_answer_investigation_question(uuid,uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_answer_investigation_question(uuid,uuid,uuid,uuid,uuid,jsonb) to service_role;


create or replace function public.supervisor_enqueue_investigation(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,
  p_source_type text,p_source_id text,p_revision_hash text,p_stable_key text,
  p_priority integer,p_now timestamptz
) returns boolean language plpgsql security definer set search_path=public as $$
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
        and a.status in ('new','seen')) into v_open;
  else
    select exists(select 1 from public.operating_tasks t
      where t.business_id=p_business_id and t.id=p_source_id
        and t.kind not in ('priority_notice','commitment','event_plan','event_change','event_report')
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
  if v_anomaly then
    update public.supervisor_investigations set revision_hash=p_revision_hash,
      stable_key=p_stable_key,priority=p_priority,next_retry_at=p_now,updated_at=p_now
      where business_id=p_business_id and owner_user_id=p_owner_user_id and thread_id=p_thread_id
       and source_type=p_source_type and source_id=p_source_id and phase in ('collect','investigate','awaiting_owner')
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
  where (public.supervisor_investigations.revision_hash<>excluded.revision_hash
      -- A formerly resolved task can recur with byte-identical evidence.
      -- The live source check above gates this restart, never an active retry.
      or public.supervisor_investigations.phase='resolved'
      or (public.supervisor_investigations.phase='blocked'
        -- Temporary owner/assignment loss can recover once the live source
        -- and owner/thread pass authorization checks above.
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
end $$;

-- Keep exact consumed answers out of both existing owner admission paths.
create or replace function public.ai_agent_job_start(
  p_business_id uuid, p_owner_user_id uuid, p_thread_id uuid, p_owner_message_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mine public.ai_agent_jobs;
  other public.ai_agent_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_only'; end if;
  if not exists (select 1 from public.ai_messages m
      where m.id = p_owner_message_id and m.thread_id = p_thread_id
        and m.business_id = p_business_id and m.owner_user_id = p_owner_user_id
        and m.role = 'owner')
  then raise exception 'owner_message_not_found'; end if;

  -- Serialize starts per thread so two tabs cannot both start a turn.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:' || p_thread_id::text, 0));

  if exists(select 1 from public.supervisor_runs r where r.business_id=p_business_id
    and r.owner_user_id=p_owner_user_id and r.thread_id=p_thread_id
    and (r.request_key=p_owner_message_id or p_owner_message_id=any(r.owner_answer_ids)) and r.execution_version=2)
    then raise exception 'durable_job_owned' using errcode='55000'; end if;
  if exists(select 1 from public.ai_messages m join public.ai_messages q on q.id=m.owner_input_prompt_message_id
    and q.business_id=m.business_id and q.owner_user_id=m.owner_user_id and q.thread_id=m.thread_id
    where m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
    and m.id=p_owner_message_id and q.grounding?'investigationEpisodeId')
    then raise exception 'durable_job_owned' using errcode='55000';end if;
  -- A turn whose server died (no heartbeat for 180s) is failed, never left spinning.
  update public.ai_agent_jobs
     set status = 'failed', error_code = 'timeout', finished_at = now(), updated_at = now()
   where thread_id = p_thread_id and status = 'running' and durable_run_id is null
     and heartbeat_at < now() - interval '180 seconds';

  select * into mine from public.ai_agent_jobs where owner_message_id = p_owner_message_id;
  if found and mine.status = 'running' then
    return jsonb_build_object('mode', 'running', 'job', to_jsonb(mine));
  elsif found and mine.status = 'done' then
    return jsonb_build_object('mode', 'done', 'job', to_jsonb(mine));
  end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and p_owner_message_id = any(consumed) and status <> 'failed'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('mode', 'absorbed', 'job', to_jsonb(other)); end if;

  select * into other from public.ai_agent_jobs
   where thread_id = p_thread_id and status = 'running' for update;
  if found then
    if other.durable_run_id is not null then
      return jsonb_build_object('mode','busy','job',to_jsonb(other));
    end if;
    if p_owner_message_id = any(other.inbox) then
      return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
    end if;
    if cardinality(other.inbox) >= 10 then
      return jsonb_build_object('mode', 'busy', 'job', to_jsonb(other));
    end if;
    update public.ai_agent_jobs
       set inbox = inbox || p_owner_message_id, updated_at = now()
     where id = other.id returning * into other;
    return jsonb_build_object('mode', 'attached', 'job', to_jsonb(other));
  end if;

  if mine.id is not null then
    -- Owner pressed retry on a failed turn.
    if mine.attempt >= 5 then return jsonb_build_object('mode', 'failed', 'job', to_jsonb(mine)); end if;
    update public.ai_agent_jobs
       set status = 'running', attempt = attempt + 1, error_code = null, reply_message_id = null,
           progress = '[]'::jsonb, inbox = '{}', consumed = '{}',
           heartbeat_at = now(), updated_at = now(), finished_at = null
     where id = mine.id returning * into mine;
    return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
  end if;

  insert into public.ai_agent_jobs (business_id, owner_user_id, thread_id, owner_message_id)
  values (p_business_id, p_owner_user_id, p_thread_id, p_owner_message_id)
  returning * into mine;
  return jsonb_build_object('mode', 'started', 'job', to_jsonb(mine));
end $$;
create or replace function public.supervisor_admit_owner_run_v2(
  p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_owner_message_id uuid,
  p_plan_hash text,p_locale text,p_attachment_ids uuid[]
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.supervisor_runs; v_started jsonb; v_fingerprint text;
begin
  if coalesce(auth.role(),'')<>'service_role'
    or not public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
    then raise exception 'owner_run_admission_denied' using errcode='42501'; end if;
  if p_locale is null or p_locale not in ('en','es','ar') or p_attachment_ids is null
    or cardinality(p_attachment_ids)>3
    or (select count(distinct x) from unnest(p_attachment_ids) x)<>cardinality(p_attachment_ids)
    or not exists(select 1 from public.ai_messages m where m.id=p_owner_message_id
      and m.business_id=p_business_id and m.owner_user_id=p_owner_user_id
      and m.thread_id=p_thread_id and m.role='owner' and m.content_type='text'
      and coalesce(m.grounding->>'sourceChannel','web')='web')
    or (select count(*) from public.ai_attachments a where a.id=any(p_attachment_ids)
      and a.business_id=p_business_id and a.owner_user_id=p_owner_user_id
      and a.thread_id=p_thread_id)<>cardinality(p_attachment_ids)
    then raise exception 'owner_run_input_unavailable' using errcode='42501'; end if;
  v_fingerprint:=public.supervisor_owner_attachment_fingerprint_v2(p_business_id,p_owner_user_id,p_thread_id,p_attachment_ids);
  if v_fingerprint is null then raise exception 'owner_run_input_unavailable' using errcode='42501'; end if;
  -- Serialize admission with the existing one-running-thread job entrypoint.
  perform pg_advisory_xact_lock(hashtextextended('ai_agent_job:'||p_thread_id::text,0));
  if exists(select 1 from public.ai_messages m join public.ai_messages q on q.id=m.owner_input_prompt_message_id
    and q.business_id=m.business_id and q.owner_user_id=m.owner_user_id and q.thread_id=m.thread_id
    where m.business_id=p_business_id and m.owner_user_id=p_owner_user_id and m.thread_id=p_thread_id
    and m.id=p_owner_message_id and q.grounding?'investigationEpisodeId')
    then raise exception 'owner_run_input_conflict' using errcode='23505';end if;
  -- Same advisory lock as supervisor_run_start. An existing legacy run
  -- is never converted under an ambiguous receipt or a conflicting replay.
  perform pg_advisory_xact_lock(hashtextextended(
    'supervisor_run:'||p_business_id::text||':'||p_owner_user_id::text||':'||p_owner_message_id::text,0));
  select * into r from public.supervisor_runs where business_id=p_business_id
    and owner_user_id=p_owner_user_id and request_key=p_owner_message_id for update;
  if found then
    if r.execution_version<>2 or r.thread_id<>p_thread_id
      or r.plan_hash is distinct from p_plan_hash or r.input_locale is distinct from p_locale
      or r.input_attachment_ids is distinct from p_attachment_ids or r.input_attachment_version_hash is distinct from v_fingerprint
      then raise exception 'owner_run_input_conflict' using errcode='23505'; end if;
    return to_jsonb(r);
  end if;
  if exists(select 1 from public.ai_agent_jobs j where j.owner_message_id=p_owner_message_id)
    or exists(select 1 from public.supervisor_runs x where x.business_id=p_business_id
      and x.owner_user_id=p_owner_user_id and p_owner_message_id=any(x.owner_answer_ids))
    then raise exception 'owner_run_input_conflict' using errcode='23505'; end if;
  v_started:=public.supervisor_run_start(p_business_id,p_owner_user_id,p_thread_id,
    p_owner_message_id,p_plan_hash,
    '[{"key":"authorize_owner","retry":"idempotent"},{"key":"owner_turn","retry":"reconcile"},{"key":"verify_report","retry":"idempotent"}]'::jsonb);
  update public.supervisor_runs set execution_version=2,input_locale=p_locale,
    input_attachment_ids=p_attachment_ids,input_attachment_version_hash=v_fingerprint where id=(v_started->>'id')::uuid returning * into r;
  return to_jsonb(r);
end $$;

-- Task 15A: serialize unattended stock drafts across owners using the existing
-- proposal writer. Manual explicit owner requests retain the regular gateway;
-- a proactive draft must never race another outstanding purchase for the item.
create function public.supervisor_guard_proactive_stock_draft()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v jsonb; v_ingredient uuid; v_source uuid; v_episode uuid; v_lease uuid; v_checked timestamptz;
begin
 if new.capability_id<>'maya.supplier_purchase_order.v1' then return new;end if;
 -- Every PO insert, including an explicitly requested one, shares this café lock.
 perform pg_advisory_xact_lock(hashtextextended('supervisor_stock_po:'||new.business_id::text,0));
 if not (new.baseline ? 'proactiveStock') then return new;end if;
 if coalesce(auth.role(),'')<>'service_role' then
  raise exception 'proactive_stock_claim_unavailable' using errcode='42501';end if;
 v:=new.baseline->'proactiveStock';
 v_ingredient:=(v->>'ingredientId')::uuid;v_source:=(v->>'sourceId')::uuid;
 v_episode:=(v->>'episodeId')::uuid;v_lease:=(v->>'leaseToken')::uuid;
 v_checked:=(v->>'checkedAt')::timestamptz;
 if v_ingredient is null or v_source is null or v_episode is null or v_lease is null
  or v_checked is null or v_checked>clock_timestamp()+interval '1 minute'
  or v_checked<clock_timestamp()-interval '10 minutes'
  or jsonb_typeof(new.canonical_effect_payload->'lines') is distinct from 'array'
  or jsonb_array_length(new.canonical_effect_payload->'lines')<>1
  or new.canonical_effect_payload->'lines'->0->>'ingredientId' is distinct from v_ingredient::text
  or not public.supervisor_routine_owner_authorized(new.business_id,new.owner_user_id,new.thread_id)
  then raise exception 'proactive_stock_claim_unavailable' using errcode='42501';end if;
 -- Same source-then-investigation lock order as the existing finish checkpoint.
 perform 1 from public.alerts a where a.id=v_source and a.business_id=new.business_id
  and a.kind='business_anomaly' and a.status in ('new','seen')
  and a.payload->>'family' in ('stock_shortage','stockout_risk')
  and a.payload->>'subject'=v_ingredient::text for share;
 if not found then raise exception 'proactive_stock_claim_unavailable' using errcode='42501';end if;
 perform 1 from public.supervisor_investigations i where i.business_id=new.business_id
  and i.owner_user_id=new.owner_user_id and i.thread_id=new.thread_id
  and i.source_type='alert' and i.source_id=v_source::text and i.episode_id=v_episode
  and i.lease_token=v_lease and i.lease_until>clock_timestamp() for share;
 if not found then raise exception 'proactive_stock_claim_unavailable' using errcode='42501';end if;
 if exists(select 1 from public.supervisor_proposals p where p.business_id=new.business_id
   and p.capability_id=new.capability_id and p.status in ('draft','approved','executing')
   and not (p.owner_user_id=new.owner_user_id and p.thread_id=new.thread_id and p.request_key=new.request_key)
   and p.canonical_effect_payload @> jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('ingredientId',v_ingredient::text))))
  or exists(select 1 from public.purchase_orders o join public.purchase_order_lines l
    on l.business_id=o.business_id and l.purchase_order_id=o.id
    where o.business_id=new.business_id and o.status='approved_for_ordering'
     and l.ingredient_id=v_ingredient and o.approved_at>=v_checked-interval '1 minute') then
  raise exception 'proactive_stock_order_overlap' using errcode='P0001';end if;
 -- No claim credential is persisted, exposed to the owner, or used as approval.
 new.baseline:=new.baseline #- '{proactiveStock,leaseToken}';
 return new;
end $$;
revoke all on function public.supervisor_guard_proactive_stock_draft() from public,anon,authenticated;
grant execute on function public.supervisor_guard_proactive_stock_draft() to service_role;
create trigger supervisor_guard_proactive_stock_draft before insert on public.supervisor_proposals
 for each row execute function public.supervisor_guard_proactive_stock_draft();
