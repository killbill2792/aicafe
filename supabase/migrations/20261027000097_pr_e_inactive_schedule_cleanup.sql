-- PR E: one-time, repeatable cleanup of future predictions for inactive staff.
-- Recheck migration numbering after rebasing. Does not delete actual clock-ins,
-- historical payroll, current-day owner schedules or published scheduled_shifts.
BEGIN;

-- Alert rows predate a resolution timestamp. Preserve the original payload and
-- record precisely when the last unresolved matching job is cleared.
ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

UPDATE public.staff_schedules AS ss
SET active = false
FROM public.employees AS e
WHERE ss.business_id = e.business_id
  AND ss.employee_id = e.id
  AND e.active = false
  AND ss.active = true;

DELETE FROM public.timecards AS t
USING public.employees AS e, public.businesses AS b
WHERE t.business_id = e.business_id
  AND t.employee_id = e.id
  AND t.business_id = b.id
  AND e.active = false
  AND t.source_type = 'owner_schedule'
  AND (t.clock_in AT TIME ZONE b.timezone)::date >
      (now() AT TIME ZONE b.timezone)::date;

-- Every owner-authorized deactivation route (including approved staff proposals)
-- turns off repeating assignments in the same PostgreSQL transaction. A trigger
-- error rolls back the employee change instead of leaving partially inactive data.
CREATE OR REPLACE FUNCTION public.staff_disable_repeats_on_deactivation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $staff_deactivate$
BEGIN
  IF OLD.active IS DISTINCT FROM false AND NEW.active = false THEN
    UPDATE public.staff_schedules
       SET active = false
     WHERE business_id = NEW.business_id
       AND employee_id = NEW.id
       AND active = true;
  END IF;
  RETURN NEW;
END
$staff_deactivate$;
REVOKE ALL ON FUNCTION public.staff_disable_repeats_on_deactivation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS staff_disable_repeats_on_deactivation ON public.employees;
CREATE TRIGGER staff_disable_repeats_on_deactivation
AFTER UPDATE OF active ON public.employees
FOR EACH ROW EXECUTE FUNCTION public.staff_disable_repeats_on_deactivation();

COMMIT;
