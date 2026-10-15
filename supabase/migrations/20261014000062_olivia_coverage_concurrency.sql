-- Coverage equivalence is independent of client request keys.
-- Preserve existing records: migration aborts for duplicates, with no cleanup.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.scheduling_coverage_requirements
  GROUP BY business_id, location_id, day_of_week, local_date,
   effective_from, effective_to, start_local, end_local, overnight,
   min_headcount, qualification_code, min_overlap_minutes, priority
  HAVING count(*) > 1) THEN
  RAISE EXCEPTION 'Existing equivalent coverage rows require owner reconciliation' USING ERRCODE='23505';
 END IF;
END $$;
-- PostgreSQL 15+ treats NULLs as equal for this unique identity.
CREATE UNIQUE INDEX scheduling_coverage_identity_unique
 ON public.scheduling_coverage_requirements
 (business_id, location_id, day_of_week, local_date, effective_from,
  effective_to, start_local, end_local, overnight, min_headcount,
  qualification_code, min_overlap_minutes, priority) NULLS NOT DISTINCT;
