-- Plan step 6 follow-up: fill step 2 (Toast line IDs) still ran for minutes in production.
-- Its working sets are built inside the statement, so the planner guesses one row each
-- (really ~13,700) and chose nested loops that re-counted every order once per line.
-- With nested loops off, every join in the fill is a single hash pass (checked with
-- EXPLAIN in production). The setting applies only while this function runs.
alter function public.toast_fill_organized_fields(integer) set enable_nestloop = off;
