-- PR E: one-time, repeatable cleanup of future predictions for inactive staff.
-- Recheck migration numbering after rebasing. Does not delete actual clock-ins,
-- historical payroll, current-day owner schedules or published scheduled_shifts.
BEGIN;

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

COMMIT;
