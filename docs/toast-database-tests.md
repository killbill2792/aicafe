# Toast stabilization: database integration verification

The separate GitHub workflow "Toast disposable database integration" uses an ephemeral Supabase instance; it does not connect to production. It replays all migrations (not just Toast files) with Supabase db reset and runs scripts/toast-db-integration.sql using psql with ON_ERROR_STOP. The SQL test wraps its fixtures and assertions in a transaction and ROLLBACK. It exercises grants, tenant rejection, credential rotation, dependent location removal, event lease nonce fencing, monotonic order staging, correction to an old time entry, and schedule disappearance. A **green workflow is required**; tests have not been claimed as run simply because a workflow was authored.

Migration 51 must not be applied to a real environment until this suite passes and any previous partial migrations are reconciled with the environment's migration history. Do not use a production Supabase URL or service token in this workflow.
