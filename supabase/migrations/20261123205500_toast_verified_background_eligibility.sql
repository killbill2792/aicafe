set lock_timeout='3s';
set statement_timeout='45s';
-- Require an explicitly verified Toast connection for unattended business analysis.
-- The business/owner/thread join remains UUID-scoped; business names are only display labels.
-- Nonconnected cafés retain their existing investigation state but cannot incur new paid calls.
CREATE OR REPLACE FUNCTION public.supervisor_list_derived_refresh_businesses()
 RETURNS TABLE(id uuid, timezone text, is_demo boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'derived refresh unauthorized' using errcode='42501';end if;
  return query select b.id,b.timezone,b.is_demo from public.businesses b
    left join public.supervisor_derived_refresh_state s on s.business_id=b.id
    where not b.is_demo
      and exists (select 1 from public.toast_api_credentials tc where tc.business_id=b.id and tc.state='verified')
      and (s.lease_until is null or s.lease_until<=statement_timestamp())
      and (s.business_id is null or s.last_started_at is null
        or s.last_started_at<=statement_timestamp()-interval '15 minutes'
        or s.requested_version>s.completed_version)
    order by s.last_started_at asc nulls first,b.id limit 100;
end $function$;

CREATE OR REPLACE FUNCTION public.supervisor_claim_investigation(p_now timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.supervisor_investigations;v_token uuid;v_open boolean;
  v_exists boolean;v_status_open boolean;v_scan integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if p_now is null then raise exception 'Invalid instant' using errcode='22023'; end if;
  -- A delayed caller or database wait cannot claim with an already expired lease.
  p_now:=greatest(p_now,clock_timestamp());
  -- Serialize only the brief selection transaction, never the investigation.
  -- Concurrent ticks do not all choose a noisy café from the same snapshot.
  if not pg_try_advisory_xact_lock(hashtextextended('supervisor-investigation-dispatch-v1',0))
    then return null; end if;
  -- A stale or revoked row must not hide healthy work elsewhere in the queue.
  -- Bounded cleanup in the SAME transaction; no unbounded worker loop.
  for v_scan in 1..16 loop
  with last_served as (
    select business_id,max(last_claimed_at) as served
      from public.supervisor_investigations group by business_id
  )
  select i.* into v from public.supervisor_investigations i
    join last_served s on s.business_id=i.business_id
    where i.phase in ('collect','investigate','awaiting_owner')
      and exists (select 1 from public.toast_api_credentials tc join public.businesses cb on cb.id=tc.business_id where tc.business_id=i.business_id and tc.state='verified' and cb.is_demo=false)
      and i.next_retry_at<=p_now and (i.lease_until is null or i.lease_until<=p_now)
    -- First choose the least recently served café, then preserve that café's
    -- urgency and aging. New incidents do not reset the café's dispatch history.
    order by s.served asc nulls first,
      (i.priority+least(250,greatest(0,
      extract(epoch from (p_now-i.created_at))/3600))::integer) desc,
      i.next_retry_at asc,i.created_at asc,i.business_id asc,i.source_id asc,i.owner_user_id asc
    for update of i skip locked limit 1;
  if not found then return null; end if;
  if not public.supervisor_routine_owner_authorized(
    v.business_id,v.owner_user_id,v.thread_id) then
    update public.supervisor_investigations set phase='blocked',last_error='authorization_revoked',
      lease_token=null,lease_until=null,updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    continue;
  end if;
  -- Missing evidence is NOT verified resolution. Neither is a still-open
  -- owner task reassigned to someone else. Treat these as blocked exceptions.
  if v.source_type='alert' then
    select exists(select 1 from public.alerts a
      where a.business_id=v.business_id and a.id::text=v.source_id) into v_exists;
    select exists(select 1 from public.alerts a
      where a.business_id=v.business_id and a.id::text=v.source_id
        and a.status in ('new','seen')) into v_open;
    v_status_open:=v_open;
  else
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id) into v_exists;
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id
        and t.status in ('needs_owner','needs_response','watching')) into v_status_open;
    select exists(select 1 from public.operating_tasks t
      where t.business_id=v.business_id and t.id=v.source_id
        and t.status in ('needs_owner','needs_response','watching')
        and (t.owner_user_id is null or t.owner_user_id=v.owner_user_id)) into v_open;
  end if;
  if not v_open then
    update public.supervisor_investigations set
      phase=case when v_exists and not v_status_open then 'resolved' else 'blocked' end,
      last_error=case when not v_exists then 'source_missing'
        when v_status_open then 'source_reassigned' else 'source_closed' end,
      lease_token=null,lease_until=null,updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
    -- Deleted/reassigned/closed source data must not leave private,
    -- now-obsolete investigation reports in the owner's active inbox.
    update public.operating_tasks set status='handled',
      resolved_at=coalesce(resolved_at,p_now)
      where business_id=v.business_id and owner_user_id=v.owner_user_id
        and kind='priority_notice' and status in ('needs_owner','needs_response','watching')
        and payload->>'intent'='priority_investigation'
        and payload->>'sourceType'=v.source_type
        and payload->>'sourceId'=v.source_id;
    continue;
  end if;
  v_token:=gen_random_uuid();
  update public.supervisor_investigations set lease_token=v_token,
    lease_until=greatest(p_now,clock_timestamp())+interval '3 minutes',last_claimed_at=clock_timestamp(),updated_at=p_now
    where business_id=v.business_id and owner_user_id=v.owner_user_id
      and source_type=v.source_type and source_id=v.source_id;
  return jsonb_build_object('business_id',v.business_id,'owner_user_id',v.owner_user_id,
    'thread_id',v.thread_id,'source_type',v.source_type,'source_id',v.source_id,
    'revision_hash',v.revision_hash,'stable_key',v.stable_key,
    'episode_id',v.episode_id,
    'phase',v.phase,'evidence',v.evidence,'narrative',v.narrative,
    'last_error',v.last_error,'step_version',v.step_version,
    'lease_token',v_token);
  end loop;
  return null;
end $function$;
