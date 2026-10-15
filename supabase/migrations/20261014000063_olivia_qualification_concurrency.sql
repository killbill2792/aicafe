-- Olivia PR 1B: request receipts deduplicate one submission, not concurrent
-- submissions with different keys. Equivalence is tenant-scoped and excludes
-- owner attribution/confirmation, which must not duplicate a qualification.
-- Fail closed on existing duplicates; never delete or remap owner data.
DO $$
BEGIN
 IF EXISTS (
   SELECT 1 FROM public.scheduling_qualification_types
   GROUP BY business_id, lower(btrim(display_name))
   HAVING count(*) > 1
 ) THEN
   RAISE EXCEPTION 'Duplicate qualification type labels require owner reconciliation'
     USING ERRCODE='23505';
 END IF;
 IF EXISTS (
   SELECT 1 FROM public.staff_qualifications
   GROUP BY business_id, employee_id, location_id, qualification_code,
     valid_from, valid_to
   HAVING count(*) > 1
 ) THEN
   RAISE EXCEPTION 'Duplicate staff qualification assignments require owner reconciliation'
     USING ERRCODE='23505';
 END IF;
END $$;

CREATE UNIQUE INDEX scheduling_qualification_type_label_unique
  ON public.scheduling_qualification_types (business_id, lower(btrim(display_name)));

CREATE UNIQUE INDEX staff_qualification_assignment_unique
  ON public.staff_qualifications
  (business_id, employee_id, location_id, qualification_code, valid_from, valid_to)
  NULLS NOT DISTINCT;
