-- Luna now reads through supervisor_research_sql. Keep all cv_* source views
-- and their helper functions, including ai_query_path (used by the JSON sanitizer).
set lock_timeout = '5s';
set statement_timeout = '30s';
-- RESTRICT prevents silently removing a still-dependent view or function.
-- Reason: Owner-approved retirement after the replacement SQL path is deployed and old callers are removed.
-- squawk-ignore ban-drop-function
drop function if exists public.ai_query_view(uuid,text,text[],jsonb,text[],jsonb,date,date,jsonb,integer) restrict;
-- Reason: Owner-approved retirement of the obsolete catalog RPC; describe_database uses PostgreSQL metadata.
-- squawk-ignore ban-drop-function
drop function if exists public.ai_toast_fields(uuid,text) restrict;
