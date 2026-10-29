-- Fails if any table in the public schema has row level security turned off.
-- AGENTS.md section 8: RLS is enabled on every table, checked in CI.
\set ON_ERROR_STOP on
DO $rls$
DECLARE missing text;
BEGIN
 SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity;
 IF missing IS NOT NULL THEN
  RAISE EXCEPTION 'TEST FAILURE: row level security is off on public tables: %', missing;
 END IF;
END $rls$;
