-- Private pilot diagnostic traces. Apply through the reviewed migration process.
-- Rich source/model/owner payloads live here, NEVER in broadly accessible Vercel logs.
-- Authenticated owners can read their scoped records. Only trusted service_role may write.
CREATE TABLE IF NOT EXISTS public.supervisor_turn_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  owner_message_id uuid NOT NULL REFERENCES public.ai_messages(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 80),
  events jsonb NOT NULL CHECK (jsonb_typeof(events)='array' AND octet_length(events::text)<=500000),
  dropped_count integer NOT NULL DEFAULT 0 CHECK (dropped_count>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  UNIQUE (business_id, owner_message_id, request_id)
);
CREATE INDEX IF NOT EXISTS supervisor_turn_traces_owner_idx
  ON public.supervisor_turn_traces (business_id, owner_user_id, thread_id, created_at DESC);
ALTER TABLE public.supervisor_turn_traces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_turn_traces FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.supervisor_turn_traces TO authenticated;
GRANT INSERT, DELETE ON public.supervisor_turn_traces TO service_role;
CREATE POLICY "owner reads own private supervisor traces"
ON public.supervisor_turn_traces FOR SELECT TO authenticated
USING (
  owner_user_id=auth.uid() AND expires_at>now()
  AND EXISTS (
    SELECT 1 FROM public.ai_messages m
    WHERE m.id=supervisor_turn_traces.owner_message_id
      AND m.thread_id=supervisor_turn_traces.thread_id
      AND m.business_id=supervisor_turn_traces.business_id
      AND m.owner_user_id=supervisor_turn_traces.owner_user_id
      AND m.role='owner'
  )
  AND EXISTS (
    SELECT 1 FROM public.memberships mb
    WHERE mb.business_id=supervisor_turn_traces.business_id
      AND mb.user_id=auth.uid() AND mb.role='owner'
  )
);
-- Housekeeping: immediate owner-scoped purge during new owner turns plus
-- recurring server-side deletion when pg_cron is available. Provision pg_cron
-- before activating private capture; without it, 14-day deletion is not ensured.
-- Authenticated clients cannot insert or delete forensic records.
CREATE OR REPLACE FUNCTION public.purge_expired_supervisor_turn_traces()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  DELETE FROM public.supervisor_turn_traces WHERE expires_at<=now();
END;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_supervisor_turn_traces()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_supervisor_turn_traces()
  TO service_role;
-- SECURITY DEFINER reads only a Boolean scheduler health flag. It grants no
-- access to cron metadata or the private trace table itself.
CREATE OR REPLACE FUNCTION public.supervisor_private_trace_retention_ready()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE ready boolean:=false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron')
  THEN RETURN false; END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname='
    || quote_literal('aicafe-supervisor-private-traces-hourly-purge')
    || ' AND active IS TRUE)' INTO ready;
  RETURN coalesce(ready,false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_private_trace_retention_ready()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_private_trace_retention_ready()
  TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.schedule('aicafe-supervisor-private-traces-hourly-purge',
      '11 * * * *','SELECT public.purge_expired_supervisor_turn_traces()');
  ELSE
    RAISE NOTICE 'Enable pg_cron and schedule hourly purge before private tracing is enabled';
  END IF;
END;
$$;
