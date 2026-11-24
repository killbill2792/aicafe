-- Extend the existing encrypted research receipt protocol to leased incidents.
-- No new scheduler, source authority, model tool or effect authorization.
set lock_timeout='3s';
set statement_timeout='45s';

CREATE FUNCTION u3_research_private.investigation_work_id(i public.supervisor_investigations)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path='' AS $identity$
 SELECT md5(i.episode_id::text||':'||i.revision_hash||':'||i.step_version::text||':'||coalesce(i.last_owner_answer_id::text,''))::uuid
$identity$;
REVOKE ALL ON FUNCTION u3_research_private.investigation_work_id(public.supervisor_investigations) FROM PUBLIC,anon,authenticated;

CREATE TABLE u3_research_private.investigation_research_receipts (
 business_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 source_type text NOT NULL,
 source_id text NOT NULL,
 work_id uuid NOT NULL,
 operation uuid NOT NULL,
 checkpoint_seq bigint GENERATED ALWAYS AS IDENTITY,
 progress_key text NOT NULL CHECK (progress_key ~ '^[a-f0-9]{64}$'),
 ciphertext text NOT NULL CHECK (length(ciphertext)>0),
 yielded boolean NOT NULL DEFAULT false,
 PRIMARY KEY(work_id,operation),
 FOREIGN KEY(business_id,owner_user_id,source_type,source_id)
  REFERENCES public.supervisor_investigations(business_id,owner_user_id,source_type,source_id) ON DELETE CASCADE
);
CREATE INDEX investigation_research_page_idx ON u3_research_private.investigation_research_receipts(work_id,checkpoint_seq);
-- Reason: New private encrypted receipt table with no client policies.
-- squawk-ignore ban-alter-row-level-security
ALTER TABLE u3_research_private.investigation_research_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON u3_research_private.investigation_research_receipts FROM PUBLIC,anon,authenticated,service_role,aicafe_research,aicafe_research_view_owner;

CREATE FUNCTION public.supervisor_investigation_research_checkpoint(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_source_type text,p_source_id text,
 p_work_id uuid,p_lease_token uuid,p_action text,p_after_seq bigint DEFAULT 0,
 p_operation uuid DEFAULT NULL,p_progress_key text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_tool text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $checkpoint$
DECLARE i public.supervisor_investigations; page jsonb;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' OR p_work_id IS NULL OR p_lease_token IS NULL OR
  p_action IS NULL OR p_action NOT IN ('assert','load','store','yield') THEN
  RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501';
 END IF;
 -- Same source -> investigation lock order as the report writer.
 IF p_source_type='alert' THEN
  PERFORM 1 FROM public.alerts a WHERE a.business_id=p_business_id AND a.id::text=p_source_id
   AND a.status IN ('new','seen') AND public.supervisor_alert_evidence_eligible(a.kind,a.payload) FOR SHARE;
 ELSIF p_source_type='operating_task' THEN
  PERFORM 1 FROM public.operating_tasks t WHERE t.business_id=p_business_id AND t.id=p_source_id
   AND t.kind NOT IN ('priority_notice','commitment','event_plan','event_change','event_report','daily_brief')
   AND t.status IN ('needs_owner','needs_response','watching')
   AND (t.owner_user_id IS NULL OR t.owner_user_id=p_owner_user_id) FOR SHARE;
 ELSE RETURN 'false'::jsonb;
 END IF;
 IF NOT FOUND THEN RETURN 'false'::jsonb; END IF;
 SELECT * INTO i FROM public.supervisor_investigations s WHERE s.business_id=p_business_id
  AND s.owner_user_id=p_owner_user_id AND s.source_type=p_source_type AND s.source_id=p_source_id FOR UPDATE;
 IF NOT FOUND OR i.thread_id IS DISTINCT FROM p_thread_id OR i.lease_token IS DISTINCT FROM p_lease_token
  OR i.lease_until<=statement_timestamp() OR i.phase NOT IN ('investigate','awaiting_owner')
  OR u3_research_private.investigation_work_id(i) IS DISTINCT FROM p_work_id
  OR NOT public.supervisor_routine_owner_authorized(p_business_id,p_owner_user_id,p_thread_id)
 THEN RETURN 'false'::jsonb; END IF;
 IF p_action='assert' THEN RETURN 'true'::jsonb; END IF;
 IF p_action='load' THEN
  IF p_after_seq IS NULL OR p_after_seq<0 THEN RAISE EXCEPTION 'research_checkpoint_invalid' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.checkpoint_seq),'[]'::jsonb) INTO page
  FROM (SELECT j.operation,j.checkpoint_seq,j.ciphertext FROM u3_research_private.investigation_research_receipts j
   WHERE j.work_id=p_work_id AND j.checkpoint_seq>p_after_seq ORDER BY j.checkpoint_seq LIMIT 16) r;
  RETURN page;
 END IF;
 IF p_action='store' THEN
  IF p_tool IS NULL OR p_tool NOT IN ('describe_data','query_data','calculate') OR p_operation IS NULL
   OR p_progress_key IS NULL OR p_progress_key !~ '^[a-f0-9]{64}$' OR p_ciphertext IS NULL OR length(p_ciphertext)=0
  THEN RAISE EXCEPTION 'research_checkpoint_invalid' USING ERRCODE='22023'; END IF;
  INSERT INTO u3_research_private.investigation_research_receipts
   (business_id,owner_user_id,source_type,source_id,work_id,operation,progress_key,ciphertext,yielded)
  VALUES(p_business_id,p_owner_user_id,p_source_type,p_source_id,p_work_id,p_operation,p_progress_key,p_ciphertext,
   p_tool='describe_data' OR EXISTS(SELECT 1 FROM u3_research_private.investigation_research_receipts j
     WHERE j.work_id=p_work_id AND j.progress_key=p_progress_key))
  ON CONFLICT(work_id,operation) DO NOTHING;
  RETURN 'true'::jsonb;
 END IF;
 UPDATE u3_research_private.investigation_research_receipts SET yielded=true WHERE work_id=p_work_id AND NOT yielded;
 IF NOT FOUND THEN RETURN 'false'::jsonb; END IF;
 -- A productive slice is not a failed attempt, nor a report or a new episode.
 UPDATE public.supervisor_investigations SET lease_token=NULL,lease_until=NULL,
  next_retry_at=statement_timestamp()+interval '1 minute',updated_at=statement_timestamp()
 WHERE business_id=p_business_id AND owner_user_id=p_owner_user_id AND source_type=p_source_type AND source_id=p_source_id;
 RETURN 'true'::jsonb;
END $checkpoint$;
REVOKE ALL ON FUNCTION public.supervisor_investigation_research_checkpoint(uuid,uuid,uuid,text,text,uuid,uuid,text,bigint,uuid,text,text,text) FROM PUBLIC,anon,authenticated,aicafe_research,aicafe_research_view_owner;
GRANT EXECUTE ON FUNCTION public.supervisor_investigation_research_checkpoint(uuid,uuid,uuid,text,text,uuid,uuid,text,bigint,uuid,text,text,text) TO service_role;

-- Stale work cannot be restored; discard ephemeral receipts on a completed
-- step, changed relevant revision/reply, changed thread or terminal phase.
CREATE FUNCTION u3_research_private.clear_investigation_research_receipts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $clear$
BEGIN
 DELETE FROM u3_research_private.investigation_research_receipts
 WHERE business_id=OLD.business_id AND owner_user_id=OLD.owner_user_id AND source_type=OLD.source_type AND source_id=OLD.source_id;
 RETURN NEW;
END $clear$;
REVOKE ALL ON FUNCTION u3_research_private.clear_investigation_research_receipts() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER supervisor_clear_investigation_research_receipts AFTER UPDATE ON public.supervisor_investigations
 FOR EACH ROW WHEN (OLD.episode_id IS DISTINCT FROM NEW.episode_id OR OLD.revision_hash IS DISTINCT FROM NEW.revision_hash
 OR OLD.step_version IS DISTINCT FROM NEW.step_version OR OLD.thread_id IS DISTINCT FROM NEW.thread_id
 OR OLD.last_owner_answer_id IS DISTINCT FROM NEW.last_owner_answer_id
 OR (NEW.phase IN ('resolved','blocked') AND OLD.phase IS DISTINCT FROM NEW.phase))
 EXECUTE FUNCTION u3_research_private.clear_investigation_research_receipts();

-- Preserve the original SQL snapshot across a replacement incident lease
-- only when its server-derived work identity is still current.
CREATE OR REPLACE FUNCTION public.u3_query_snapshot_chunk(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_mode text,
 p_source_type text,p_source_id text,p_run_id uuid,p_lease_token uuid,
 p_snapshot_id uuid,p_start_row bigint,p_row_count integer,p_ciphertext text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $chunk$
DECLARE k text; row_data jsonb; current_work uuid;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' OR p_snapshot_id IS NULL OR
    p_start_row IS NULL OR p_start_row<0 THEN
  RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501';
 END IF;
 -- Reuse the same independently fenced scope admission as ordinary research.
 PERFORM public.u3_issue_research_scope(p_business_id,p_owner_user_id,p_thread_id,
  p_mode,p_source_type,p_source_id,p_run_id,p_lease_token);
 IF p_mode='investigation' AND p_run_id IS NOT NULL THEN
  SELECT u3_research_private.investigation_work_id(i) INTO current_work
  FROM public.supervisor_investigations i WHERE i.business_id=p_business_id AND i.owner_user_id=p_owner_user_id
   AND i.thread_id=p_thread_id AND i.source_type=p_source_type AND i.source_id=p_source_id AND i.lease_token=p_lease_token;
  IF current_work IS DISTINCT FROM p_run_id THEN RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501'; END IF;
 END IF;
 k:=encode(extensions.digest(convert_to(jsonb_build_array(p_business_id,p_owner_user_id,
  p_thread_id,p_mode,p_source_type,p_source_id,p_run_id,
  CASE WHEN p_mode IN ('routine','durable') OR (p_mode='investigation' AND p_run_id IS NOT NULL) THEN NULL ELSE p_lease_token END)::text,'UTF8'),'sha256'),'hex');
 IF p_ciphertext IS NOT NULL THEN
  IF p_row_count IS NULL OR p_row_count<1 OR length(p_ciphertext)=0 OR
     length(p_ciphertext)>2097152 THEN
   RAISE EXCEPTION 'invalid_snapshot_chunk' USING ERRCODE='22023';
  END IF;
  -- Opportunistic bounded removal. Expired ciphertext is never readable.
  DELETE FROM u3_research_private.query_snapshot_chunks c WHERE c.ctid IN (
   SELECT x.ctid FROM u3_research_private.query_snapshot_chunks x
   WHERE x.expires_at<=statement_timestamp() ORDER BY x.expires_at LIMIT 256);
  INSERT INTO u3_research_private.query_snapshot_chunks
   (scope_key,snapshot_id,thread_id,start_row,row_count,ciphertext,expires_at)
  VALUES(k,p_snapshot_id,p_thread_id,p_start_row,p_row_count,p_ciphertext,
   statement_timestamp()+interval '1 hour')
  ON CONFLICT(scope_key,snapshot_id,start_row) DO NOTHING;
  RETURN jsonb_build_object('stored',true);
 END IF;
 SELECT jsonb_build_object('start_row',c.start_row,'row_count',c.row_count,
    'ciphertext',c.ciphertext) INTO row_data
 FROM u3_research_private.query_snapshot_chunks c
 WHERE c.scope_key=k AND c.snapshot_id=p_snapshot_id AND c.thread_id=p_thread_id
   AND c.start_row<=p_start_row AND c.start_row+c.row_count>p_start_row
   AND c.expires_at>statement_timestamp()
 ORDER BY c.start_row DESC LIMIT 1;
 RETURN row_data;
END $chunk$;
REVOKE ALL ON FUNCTION public.u3_query_snapshot_chunk(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,bigint,integer,text) FROM PUBLIC,anon,authenticated,aicafe_research,aicafe_research_view_owner;
GRANT EXECUTE ON FUNCTION public.u3_query_snapshot_chunk(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,bigint,integer,text) TO service_role;
