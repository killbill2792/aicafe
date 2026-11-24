-- Ephemeral continuation data for the EXISTING owner_run checkpoint.
-- No new agent, job, scheduler, source reader or authority. Only the trusted
-- worker encrypts already-authorized research observations; the model and
-- browser cannot query this table or mint/replay an authorization.
set lock_timeout='3s';
set statement_timeout='45s';

CREATE TABLE u3_research_private.owner_research_receipts (
 step_id uuid NOT NULL REFERENCES public.supervisor_run_steps(id) ON DELETE CASCADE,
 operation uuid NOT NULL,
 checkpoint_seq bigint NOT NULL,
 ciphertext text NOT NULL CHECK (length(ciphertext)>0),
 PRIMARY KEY(step_id,operation),
 UNIQUE(step_id,checkpoint_seq)
);
-- New private table: no grants or RLS policies for browser/research roles.
-- squawk-ignore ban-alter-row-level-security
ALTER TABLE u3_research_private.owner_research_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON u3_research_private.owner_research_receipts FROM PUBLIC,anon,authenticated,service_role,aicafe_research,aicafe_research_view_owner;

CREATE FUNCTION public.supervisor_store_research_read_v3(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,
 p_expected_seq integer,p_operation uuid,p_receipt_ref text,p_ciphertext text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $store$
DECLARE s jsonb; item jsonb;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' OR p_ciphertext IS NULL OR length(p_ciphertext)=0
   OR p_receipt_ref IS NULL OR p_receipt_ref !~ '^read:[a-f0-9]{32}_[a-f0-9]{64}:ref:durable$'
 THEN RAISE EXCEPTION 'research_checkpoint_invalid' USING ERRCODE='42501'; END IF;
 -- The existing checkpoint RPC locks the original run and step and enforces
 -- membership, attachment revision, live lease, operation and expected seq.
 s:=public.supervisor_checkpoint_owner_run_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,
  p_claim_token,p_expected_seq,p_operation,'complete',NULL,p_receipt_ref);
 item:=s->'checkpoint_receipts'->-1;
 IF item->>'phase' IS DISTINCT FROM 'read_pending'
    OR coalesce(item->>'tool','') NOT IN ('describe_data','query_data','calculate')
    OR item->>'operation' IS DISTINCT FROM p_operation::text
    OR item->>'receipt' IS DISTINCT FROM p_receipt_ref
 THEN RAISE EXCEPTION 'research_checkpoint_invalid' USING ERRCODE='42501'; END IF;
 -- Atomic with checkpoint completion; a crash cannot leave a completed read
 -- marker without its encrypted receipt or attach a receipt to an effect.
 INSERT INTO u3_research_private.owner_research_receipts(step_id,operation,checkpoint_seq,ciphertext)
 VALUES ((s->>'id')::uuid,p_operation,(s->>'checkpoint_seq')::bigint,p_ciphertext);
 RETURN s;
END $store$;
REVOKE ALL ON FUNCTION public.supervisor_store_research_read_v3(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_store_research_read_v3(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text) TO service_role;

CREATE FUNCTION public.supervisor_load_research_reads_v3(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_run_id uuid,p_claim_token uuid,p_after_seq bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $load$
DECLARE page jsonb;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' OR p_after_seq IS NULL OR p_after_seq<0
   OR NOT public.supervisor_owner_job_fence_v2(p_business_id,p_owner_user_id,p_thread_id,p_run_id,p_claim_token)
 THEN RAISE EXCEPTION 'research_checkpoint_scope_denied' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.checkpoint_seq),'[]'::jsonb) INTO page
 FROM (
  SELECT j.operation,j.checkpoint_seq,j.ciphertext
  FROM u3_research_private.owner_research_receipts j
  JOIN public.supervisor_run_steps s ON s.id=j.step_id
  WHERE s.business_id=p_business_id AND s.run_id=p_run_id AND s.step_key='owner_turn'
    AND j.checkpoint_seq>p_after_seq
  ORDER BY j.checkpoint_seq LIMIT 16
 ) r;
 -- Page size bounds only this transport request; callers exhaust all pages.
 RETURN page;
END $load$;
REVOKE ALL ON FUNCTION public.supervisor_load_research_reads_v3(uuid,uuid,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_load_research_reads_v3(uuid,uuid,uuid,uuid,uuid,bigint) TO service_role;

CREATE FUNCTION u3_research_private.clear_terminal_research_reads()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $clear$
BEGIN
 -- Only ephemeral research payloads from this run. Permanent source rows,
 -- result references, owner messages and verified effects are unchanged.
 DELETE FROM u3_research_private.owner_research_receipts WHERE step_id=NEW.id;
 RETURN NEW;
END $clear$;
REVOKE ALL ON FUNCTION u3_research_private.clear_terminal_research_reads() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER supervisor_clear_terminal_research_reads
 AFTER UPDATE OF status ON public.supervisor_run_steps
 FOR EACH ROW WHEN (NEW.status IN ('completed','blocked') AND OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION u3_research_private.clear_terminal_research_reads();
