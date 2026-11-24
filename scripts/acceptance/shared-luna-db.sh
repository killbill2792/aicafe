#!/usr/bin/env bash
# Trusted host only. Never attach to an existing listener or kill an unknown service.
set -euo pipefail
: "${RUNNER_TEMP:?}"
# Local contract is fixed across the runner, app and attesters. A busy listener
# means this is not a clean disposable environment; fail before any DB mutation.
listeners="$(ss -H -ltn)"
for port in 54320 54321 54322; do
  if printf '%s\n' "$listeners" | awk -v p=":$port" '$4 ~ (p "$") {found=1} END {exit !found}'; then
    echo "::error::Disposable Supabase port $port already occupied on isolated runner"
    exit 1
  fi
done
set -euo pipefail
supabase start -x realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
supabase db reset --local --yes
pg_isready -q -h 127.0.0.1 -p 54322 -U postgres
# pg_isready is not proof of an authenticated SQL read. The
# trusted host must be able to attest the disposable DB before spend.
command -v psql >/dev/null
PGPASSWORD=postgres PGOPTIONS="-c default_transaction_read_only=on" psql \
  -X -q -t -A -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "select json_build_object('ready',true)->>'ready'" \
  | grep -qx true
supabase status -o json > "$RUNNER_TEMP/luna-local-supabase.json"
