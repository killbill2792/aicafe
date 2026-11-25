-- Staff questions: the owner's own chat message is a valid source, and the owner's approval click replaces the
-- "worker is on a published shift right now" requirement. The owner decides who to contact and when; the checks
-- that remain are the ones the message needs to be delivered: an active employee linked to a staff account, a
-- verified owner click on this exact proposal, and an unchanged source.
set lock_timeout='3s';
set statement_timeout='30s';
create or replace function public.supervisor_commit_staff_question(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_proposal_id uuid,p_effect_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.supervisor_proposals; e public.employees; t public.operating_tasks;
 a public.alerts; v_revision timestamptz;
 v_effect jsonb; v_receipt jsonb;
 v_question text; v_follow_up timestamptz;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'service_role_only' using errcode='42501'; end if;
 select * into p from public.supervisor_proposals
  where business_id=p_business_id and owner_user_id=p_owner_user_id
   and thread_id=p_thread_id and id=p_proposal_id for update;
 if not found or p.capability_id<>'olivia.staff_question.v1'
  or p.capability_version<>1 or p.status<>'executing'
  or p.effect_hash is distinct from p_effect_hash or not exists(
   select 1 from public.supervisor_effect_attempts attempt
   where attempt.business_id=p_business_id and attempt.proposal_id=p_proposal_id
    and attempt.effect_hash=p_effect_hash and attempt.authorization_kind='click'
    and attempt.state='executing') or not exists(
   select 1 from public.memberships m where m.business_id=p_business_id
    and m.user_id=p_owner_user_id and m.role='owner')
 then raise exception 'verified_owner_click_required' using errcode='42501';end if;
 v_effect:=p.canonical_effect_payload;
 v_question:=nullif(btrim(v_effect->>'question'),'');
 v_follow_up:=(v_effect->>'followUpAfter')::timestamptz;
 if v_question is null or char_length(v_question) not between 5 and 800
  or v_follow_up is null or v_follow_up<=statement_timestamp()
 then raise exception 'staff_question_not_actionable' using errcode='40001';end if;
 -- Lock employee BEFORE its source task to follow the shared channel's lock
 -- order and prevent stale link/shift/source outcomes.
 select * into e from public.employees
  where business_id=p_business_id and id=(v_effect->>'employeeId')::uuid for update;
 if not found or not e.active or e.staff_auth_user_id is null then
  raise exception 'employee_link_changed' using errcode='40001';end if;
 if v_effect->>'sourceKind'='operating_task' then
  select * into t from public.operating_tasks
   where business_id=p_business_id and id=v_effect->>'sourceTaskId'
    and (owner_user_id=p_owner_user_id or owner_user_id is null) for update;
  if not found or t.status not in ('needs_owner','needs_response','watching') then
   raise exception 'source_task_changed' using errcode='40001';end if;
  v_revision:=t.updated_at;
 elsif v_effect->>'sourceKind'='alert' then
  select * into a from public.alerts where business_id=p_business_id
   and id::text=v_effect->>'sourceTaskId' for share;
  if not found or a.status not in ('new','seen') then
   raise exception 'source_alert_changed' using errcode='40001';end if;
  v_revision:=a.created_at;
 elsif v_effect->>'sourceKind'='owner_chat' then
  -- The owner's own saved chat message in this thread is the source: no alert or task is needed.
  select m.created_at into v_revision from public.ai_messages m
   where m.business_id=p_business_id and m.owner_user_id=p_owner_user_id
    and m.thread_id=p_thread_id and m.role='owner' and m.id::text=v_effect->>'sourceTaskId';
  if not found then raise exception 'source_message_missing' using errcode='40001';end if;
 else raise exception 'source_kind_invalid' using errcode='40001';end if;
 if v_revision is distinct from (v_effect->>'sourceRevision')::timestamptz
 then raise exception 'source_revision_changed' using errcode='40001';end if;
 v_receipt:=public.staff_channel_assign_verified(p_owner_user_id,e.id,'task',
  'Supervisor question',v_question,p_proposal_id,'owner_manual',v_follow_up);
 if v_receipt->>'id' is null then
  raise exception 'staff_question_not_saved' using errcode='40001';end if;
 return v_receipt;
end $$;
revoke all on function public.supervisor_commit_staff_question(uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.supervisor_commit_staff_question(uuid,uuid,uuid,uuid,text) to service_role;
