-- Staff readiness: additive per-café prep/cleanup and consented delivery ledger.
-- Safe to re-run. No sending or modification of existing rosters.
ALTER TABLE public.team_rules
 ADD COLUMN IF NOT EXISTS prep_minutes_before_open integer NOT NULL DEFAULT 0
   CHECK (prep_minutes_before_open BETWEEN 0 AND 240),
 ADD COLUMN IF NOT EXISTS prep_minutes_after_close integer NOT NULL DEFAULT 0
   CHECK (prep_minutes_after_close BETWEEN 0 AND 240);
ALTER TABLE public.employees
 ADD COLUMN IF NOT EXISTS whatsapp_opt_in boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS public.staff_schedule_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 proposal_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 recipient_e164 text NOT NULL CHECK(recipient_e164 ~ '^\+[1-9][0-9]{1,14}$'),
 status text NOT NULL DEFAULT 'prepared'
   CHECK(status IN ('prepared','sending','sent','failed','delivered')),
 meta_message_id text,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,proposal_id,employee_id),
 FOREIGN KEY (business_id,proposal_id) REFERENCES public.supervisor_proposals(business_id,id) ON DELETE CASCADE,
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS staff_schedule_deliveries_meta
 ON public.staff_schedule_deliveries(meta_message_id) WHERE meta_message_id IS NOT NULL;
ALTER TABLE public.staff_schedule_deliveries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND tablename='staff_schedule_deliveries' AND policyname='owner read deliveries') THEN
  CREATE POLICY "owner read deliveries" ON public.staff_schedule_deliveries
   FOR SELECT TO authenticated USING (public.scheduling_is_owner(business_id));
 END IF;
END $$;
REVOKE ALL ON public.staff_schedule_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.staff_schedule_deliveries TO authenticated;
GRANT ALL ON public.staff_schedule_deliveries TO service_role;
