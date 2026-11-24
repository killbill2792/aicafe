-- The existing fenced investigation writer stores the complete, verified
-- narrative. Do not reject a useful report merely because of its character
-- count. Provider/run resource budgets and the nonempty/evidence/lease/
-- owner/zero-effect checks remain; the inbox title is still a short preview.
set lock_timeout = '3s';
set statement_timeout = '45s';

-- Reason: replace the arbitrary report-length ceiling; text remains nonempty at the fenced writer and existing authorization/evidence checks are unchanged.
-- squawk-ignore ban-drop-constraint
alter table public.supervisor_investigations drop constraint investigation_narrative_size;

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
        and a.status in ('new','seen')
        and public.supervisor_alert_evidence_eligible(a.kind,a.payload) for share;
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
    (p_narrative is null or length(btrim(p_narrative))=0) then
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
