-- Existing U4 routine occurrence continuation, using the same private encrypted
-- research checkpoint mechanism as owner runs. No new job or source store;
-- payloads are ephemeral and unreadable by browser or research roles.
set lock_timeout='3s';
set statement_timeout='45s';

CREATE TABLE u3_research_private.routine_research_receipts (
 run_id uuid NOT NULL REFERENCES public.supervisor_routine_occurrences(run_id) ON DELETE CASCADE,
 operation uuid NOT NULL,
 checkpoint_seq bigint NOT NULL,
 progress_key text NOT NULL CHECK (progress_key ~ '^[a-f0-9]{64}$'),
 ciphertext text NOT NULL CHECK (length(ciphertext)>0),
 yielded boolean NOT NULL DEFAULT false,
 PRIMARY KEY(run_id,operation),
 UNIQUE(run_id,checkpoint_seq)
);
CREATE INDEX routine_research_progress_idx ON u3_research_private.routine_research_receipts(run_id,progress_key);
-- Reason: New private table, no client policy or prior access.
-- squawk-ignore ban-alter-row-level-security
ALTER TABLE u3_research_private.routine_research_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON u3_research_private.routine_research_receipts FROM PUBLIC,anon,authenticated,service_role,aicafe_research,aicafe_research_view_owner;

create or replace function public.u4_checkpoint_model_step(
  p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid,
  p_stage text,p_tool text,p_digest text
) returns boolean language plpgsql security definer set search_path=''
as $u4_step$
declare current_journal jsonb;steps jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role'
    or p_stage not in ('provider_start','provider_complete','provider_uncertain',
      'tool_start','tool_complete')
    or (p_tool is not null and (length(p_tool)>80
      or p_tool !~ '^[a-z][a-z0-9_]*$'))
    or (p_digest is not null and p_digest !~ '^[a-f0-9]{64}$')
  then raise exception 'u4_checkpoint_invalid' using errcode='42501'; end if;
  if not public.u4_routine_lease_active(
      p_business_id,p_routine_id,p_run_id,p_lease_token) then return false; end if;
  select u4_checkpoint into current_journal from public.supervisor_routine_occurrences
    where business_id=p_business_id and routine_id=p_routine_id
      and run_id=p_run_id for update;
  if not found or not public.u4_routine_lease_active(
      p_business_id,p_routine_id,p_run_id,p_lease_token) then return false; end if;
  steps:=coalesce(current_journal->'steps','[]'::jsonb);
  steps:=(select coalesce(jsonb_agg(x.val order by x.ord),'[]'::jsonb)
    from jsonb_array_elements(steps) with ordinality x(val,ord)
    where x.ord>greatest(0,jsonb_array_length(steps)-23));
  steps:=steps||jsonb_build_array(jsonb_build_object(
    'stage',p_stage,'tool',p_tool,'digest',p_digest,
    'at',statement_timestamp()::text));
  update public.supervisor_routine_occurrences set
    u4_checkpoint=coalesce(current_journal,'{}'::jsonb)||jsonb_build_object('steps',steps,'lastStage',p_stage,
      'lastTool',p_tool,'updatedAt',statement_timestamp()::text),
    updated_at=statement_timestamp()
    where business_id=p_business_id and routine_id=p_routine_id
      and run_id=p_run_id;
  return true;
end
$u4_step$;
revoke all on function public.u4_checkpoint_model_step(
  uuid,uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.u4_checkpoint_model_step(
  uuid,uuid,uuid,uuid,text,text,text) to service_role;


CREATE FUNCTION public.u4_store_research_read(
 p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid,
 p_operation uuid,p_progress_key text,p_ciphertext text,p_tool text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $store$
DECLARE journal jsonb; n bigint;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' OR p_tool IS NULL OR
  p_tool NOT IN ('describe_data','query_data','calculate') OR
  p_progress_key IS NULL OR p_progress_key !~ '^[a-f0-9]{64}$' OR
  p_operation IS NULL OR p_ciphertext IS NULL OR length(p_ciphertext)=0
 THEN RAISE EXCEPTION 'research_checkpoint_invalid' USING ERRCODE='42501'; END IF;
 -- The existing journal boundary locks the occurrence and checks the current
 -- owner, revision and lease before the private receipt is appended.
 IF NOT public.u4_checkpoint_model_step(p_business_id,p_routine_id,p_run_id,p_lease_token,
  'tool_complete',p_tool,p_progress_key) THEN RETURN false; END IF;
 SELECT u4_checkpoint INTO journal FROM public.supervisor_routine_occurrences
  WHERE business_id=p_business_id AND routine_id=p_routine_id AND run_id=p_run_id;
 n:=coalesce((journal->>'research_count')::bigint,0);
 INSERT INTO u3_research_private.routine_research_receipts(run_id,operation,checkpoint_seq,progress_key,ciphertext,yielded)
 VALUES(p_run_id,p_operation,n+1,p_progress_key,p_ciphertext,
  p_tool='describe_data' OR EXISTS(SELECT 1 FROM u3_research_private.routine_research_receipts
   WHERE run_id=p_run_id AND progress_key=p_progress_key));
 IF FOUND THEN
  UPDATE public.supervisor_routine_occurrences
   SET u4_checkpoint=jsonb_set(u4_checkpoint,'{research_count}',to_jsonb(n+1))
   WHERE business_id=p_business_id AND routine_id=p_routine_id AND run_id=p_run_id;
 END IF;
 RETURN true;
END $store$;
REVOKE ALL ON FUNCTION public.u4_store_research_read(uuid,uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.u4_store_research_read(uuid,uuid,uuid,uuid,uuid,text,text,text) TO service_role;

CREATE FUNCTION public.u4_load_research_reads(
 p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid,p_after_seq bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $load$
DECLARE page jsonb;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' OR p_after_seq IS NULL OR p_after_seq<0 OR
  NOT public.u4_routine_lease_active(p_business_id,p_routine_id,p_run_id,p_lease_token)
 THEN RAISE EXCEPTION 'research_checkpoint_scope_denied' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.checkpoint_seq),'[]'::jsonb) INTO page
 FROM (SELECT j.operation,j.checkpoint_seq,j.ciphertext
  FROM u3_research_private.routine_research_receipts j
  WHERE j.run_id=p_run_id AND j.checkpoint_seq>p_after_seq
  ORDER BY j.checkpoint_seq LIMIT 16) r;
 RETURN page;
END $load$;
REVOKE ALL ON FUNCTION public.u4_load_research_reads(uuid,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.u4_load_research_reads(uuid,uuid,uuid,uuid,bigint) TO service_role;

CREATE FUNCTION public.u4_yield_research_slice(
 p_business_id uuid,p_routine_id uuid,p_run_id uuid,p_lease_token uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $yield$
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' THEN
  RAISE EXCEPTION 'research_checkpoint_scope_denied' USING ERRCODE='42501';
 END IF;
 -- Same lock order and identity as the normal occurrence finish path.
 PERFORM 1 FROM public.supervisor_routines WHERE business_id=p_business_id AND id=p_routine_id FOR UPDATE;
 PERFORM 1 FROM public.supervisor_routine_occurrences WHERE business_id=p_business_id AND routine_id=p_routine_id AND run_id=p_run_id FOR UPDATE;
 IF NOT public.u4_routine_lease_active(p_business_id,p_routine_id,p_run_id,p_lease_token) THEN RETURN false; END IF;
 UPDATE u3_research_private.routine_research_receipts SET yielded=true
  WHERE run_id=p_run_id AND NOT yielded;
 IF NOT FOUND THEN RETURN false; END IF;
 -- Only a newly completed, distinct observation makes a technical yield
 -- different from a failed attempt. Owner/provider spend remains reserved
 -- in the existing usage ledger; repeated/no-progress failures keep their
 -- original retry backoff and attempt ceiling.
 UPDATE public.supervisor_routine_occurrences SET state='pending',lease_token=NULL,lease_until=NULL,
  attempts=greatest(0,attempts-1),next_retry_at=statement_timestamp()+interval '1 minute',
  updated_at=statement_timestamp()
 WHERE business_id=p_business_id AND routine_id=p_routine_id AND run_id=p_run_id;
 RETURN true;
END $yield$;
REVOKE ALL ON FUNCTION public.u4_yield_research_slice(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.u4_yield_research_slice(uuid,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION u3_research_private.clear_terminal_routine_research_reads()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $clear$
BEGIN
 DELETE FROM u3_research_private.routine_research_receipts WHERE run_id=NEW.run_id;
 RETURN NEW;
END $clear$;
REVOKE ALL ON FUNCTION u3_research_private.clear_terminal_routine_research_reads() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER supervisor_clear_terminal_routine_research_reads AFTER UPDATE OF state
 ON public.supervisor_routine_occurrences FOR EACH ROW
 WHEN (NEW.state IN ('completed','failed') AND OLD.state IS DISTINCT FROM NEW.state)
 EXECUTE FUNCTION u3_research_private.clear_terminal_routine_research_reads();
