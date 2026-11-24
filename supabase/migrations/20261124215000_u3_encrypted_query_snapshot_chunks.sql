-- Immutable encrypted query observations, not a new source or research tool.
-- The existing signed scope and live lease are checked on every chunk access.
-- Expiry affects only this optimization; a missing chunk uses exact replay.
set lock_timeout='3s';
set statement_timeout='45s';

CREATE TABLE u3_research_private.query_snapshot_chunks (
 scope_key text NOT NULL CHECK (scope_key ~ '^[a-f0-9]{64}$'),
 snapshot_id uuid NOT NULL,
 thread_id uuid NOT NULL REFERENCES public.ai_threads(id) ON DELETE CASCADE,
 start_row bigint NOT NULL CHECK (start_row>=0),
 row_count bigint NOT NULL CHECK (row_count>0),
 ciphertext text NOT NULL CHECK (length(ciphertext)>0),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(scope_key,snapshot_id,start_row)
);
CREATE INDEX query_snapshot_expiry_idx ON u3_research_private.query_snapshot_chunks(expires_at);
-- Reason: New private encrypted table with no client grants or research-role policies.
-- squawk-ignore ban-alter-row-level-security
ALTER TABLE u3_research_private.query_snapshot_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON u3_research_private.query_snapshot_chunks FROM PUBLIC,anon,authenticated,service_role,aicafe_research,aicafe_research_view_owner;

CREATE FUNCTION public.u3_query_snapshot_chunk(
 p_business_id uuid,p_owner_user_id uuid,p_thread_id uuid,p_mode text,
 p_source_type text,p_source_id text,p_run_id uuid,p_lease_token uuid,
 p_snapshot_id uuid,p_start_row bigint,p_row_count integer,p_ciphertext text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $chunk$
DECLARE k text; row_data jsonb;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' OR p_snapshot_id IS NULL OR
    p_start_row IS NULL OR p_start_row<0 THEN
  RAISE EXCEPTION 'research_scope_denied' USING ERRCODE='42501';
 END IF;
 -- Reuse the same independently fenced scope admission as ordinary research.
 PERFORM public.u3_issue_research_scope(p_business_id,p_owner_user_id,p_thread_id,
  p_mode,p_source_type,p_source_id,p_run_id,p_lease_token);
 k:=encode(extensions.digest(convert_to(jsonb_build_array(p_business_id,p_owner_user_id,
  p_thread_id,p_mode,p_source_type,p_source_id,p_run_id,
  CASE WHEN p_mode IN ('routine','durable') THEN NULL ELSE p_lease_token END)::text,'UTF8'),'sha256'),'hex');
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
