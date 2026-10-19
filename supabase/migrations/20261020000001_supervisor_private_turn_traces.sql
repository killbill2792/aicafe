-- Private pilot diagnostic traces. Apply through the reviewed migration process.
-- Rich source/model/owner payloads live here, NEVER in broadly accessible Vercel logs.
-- Only the authenticated owner of the exact source message may write/read.
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
GRANT SELECT, INSERT ON public.supervisor_turn_traces TO authenticated;
CREATE POLICY "owner reads own private supervisor traces"
ON public.supervisor_turn_traces FOR SELECT TO authenticated
USING (
  owner_user_id=auth.uid() AND expires_at>now()
  AND EXISTS (
    SELECT 1 FROM public.ai_messages m
    WHERE m.id=owner_message_id AND m.thread_id=thread_id
      AND m.business_id=business_id AND m.owner_user_id=owner_user_id
      AND m.role='owner'
  )
  AND EXISTS (
    SELECT 1 FROM public.memberships mb
    WHERE mb.business_id=supervisor_turn_traces.business_id
      AND mb.user_id=auth.uid() AND mb.role='owner'
  )
);
CREATE POLICY "owner writes own private supervisor traces"
ON public.supervisor_turn_traces FOR INSERT TO authenticated
WITH CHECK (
  owner_user_id=auth.uid() AND expires_at<=now()+interval '14 days'
  AND EXISTS (
    SELECT 1 FROM public.ai_messages m
    WHERE m.id=owner_message_id AND m.thread_id=thread_id
      AND m.business_id=business_id AND m.owner_user_id=owner_user_id
      AND m.role='owner'
  )
  AND EXISTS (
    SELECT 1 FROM public.memberships mb
    WHERE mb.business_id=supervisor_turn_traces.business_id
      AND mb.user_id=auth.uid() AND mb.role='owner'
  )
);
