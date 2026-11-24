-- Validate the replacement array-only checkpoint CHECK after the earlier DDL
-- transaction commits. Existing rows satisfied the stronger old validated CHECK;
-- new writes were already subject to the replacement CHECK. Validation now uses
-- SHARE UPDATE EXCLUSIVE rather than retaining the earlier ACCESS EXCLUSIVE lock.
set lock_timeout='3s';
set statement_timeout='45s';
ALTER TABLE public.supervisor_run_steps VALIDATE CONSTRAINT supervisor_run_steps_checkpoint_receipts_check;
