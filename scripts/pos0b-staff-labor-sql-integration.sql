-- POS0b disposable-database staff/labor source preflight.
-- This is an early draft: field-level acceptance and SQL execution proof remain pending.
-- Operational source: current Toast objects (toast_raw_records); never diagnostic samples.
DO $pos0b$
BEGIN
  IF to_regprocedure('public.toast_stage_labor_entries(uuid,uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'POS0b: existing authorized attendance writer missing';
  END IF;
  IF to_regprocedure('public.pos_import_toast_attendance(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'POS0b: existing canonical attendance importer missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='toast_labor_entries' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'POS0b: labor entry RLS missing';
  END IF;
END
$pos0b$;
