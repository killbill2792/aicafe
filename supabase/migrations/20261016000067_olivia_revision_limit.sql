-- Olivia PR3: enforce the same finite revision range in the database as
-- the preview, owner-edit, approval, and publication services. This is an
-- authoritative invariant even if an owner invokes the draft RPC directly.
-- No existing revision is deleted or renumbered: migration fails visibly
-- if inconsistent preexisting data needs an explicit owner-approved repair.
ALTER TABLE public.scheduling_plan_series
  ADD CONSTRAINT scheduling_plan_series_revision_limit
  CHECK (current_revision BETWEEN 0 AND 500);

ALTER TABLE public.scheduling_plan_revisions
  ADD CONSTRAINT scheduling_plan_revisions_revision_limit
  CHECK (revision BETWEEN 1 AND 500);
