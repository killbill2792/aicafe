#!/usr/bin/env bash
# Only after the trusted disposable DB bootstrap, never on a hosted endpoint.
set -euo pipefail
: "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}"
test -s "$RUNNER_TEMP/luna-local-supabase.json"
password="$(openssl rand -hex 24)"
printf '::add-mask::%s\n' "$password"
# Require exactly the migrated restricted role; do not create or grant a broader role.
PGPASSWORD=postgres psql -X -q -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -v research_password="$password" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aicafe_research'
    AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
  THEN RAISE EXCEPTION 'restricted research role missing or privileged'; END IF;
END $$;
ALTER ROLE aicafe_research LOGIN PASSWORD :'research_password';
SQL
PGPASSWORD="$password" PGOPTIONS="-c default_transaction_read_only=on" psql \
  -X -q -t -A -h 127.0.0.1 -p 54322 -U aicafe_research -d postgres \
  -v ON_ERROR_STOP=1 -c "SELECT current_user = 'aicafe_research' AND current_setting('transaction_read_only') = 'on'" | grep -qx t
url="postgresql://aicafe_research:$password@127.0.0.1:54322/postgres"
printf '::add-mask::%s\n' "$url"
printf 'AICAFE_RESEARCH_SQL_ENABLED=true\nAICAFE_RESEARCH_DATABASE_URL=%s\n' "$url" >> "$GITHUB_ENV"
