# Toast read-only integration — dependent PR 1 (secure foundation)

**State:** draft, not production-ready. No real Toast credentials were used. No external API was called from tests. This PR is *not* a full Toast connector.

## Implemented
- Service-role-only encrypted Standard API credentials, explicit Toast GUID ↔ canonical location mappings, additive migration 40.
- Owner-only JSON endpoints: POST/GET/DELETE /api/pos/toast; POST /api/pos/toast/test for explicit permission verification.
- Strict HTTPS + approved exact-host allowlist (add a Toast-provided host to TOAST_ALLOWED_API_HOSTS), no arbitrary outbound hosts.
- Shared read-only authenticated Toast client; encrypted bearer persistence with database lease, bounded retries, 401 refresh, timeouts, sanitized errors.
- Verification checks restaurants, menus metadata, orders, employees, time entries and scheduled shifts per mapped location. Credential save is never claimed as connection verification.
- No POS canonical fact ingestion; no automatic scheduled jobs; no production activation.
- Existing pos_connections and existing Square/CSV paths deliberately unchanged in this first PR.

## Production activation blocked
Before *any* setup: apply **only** migration \`supabase/migrations/20261012000040_toast_secure_access.sql\` in a verified staging database after comparing production migration history. Do **not** replay all migrations. Check function grants and RLS denial for anon/authenticated, cross-business mapping rejection and owner route membership. Production migration requires explicit approval.

Required server environment:
- TOKEN_ENCRYPTION_KEY: existing, exactly 32 raw bytes encoded as base64; do not rotate without decrypt/re-encrypt plan.
- NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (existing session connection).
- SUPABASE_SERVICE_ROLE_KEY (existing, server-only).
- TOAST_ALLOWED_API_HOSTS: comma-separated *exact* Toast HTTPS hostnames authorized by Toast; hostnames must end in \`.toasttab.com\`. No trailing slash. Verify against the actual API Access URL.

TOAST_SETUP_ENABLED defaults to false; explicitly set it to true only after staging authorization and security review. Automatic sync, webhook and backfill remain absent and disabled. Nothing in this PR uses Vercel cron; the existing Team alerts cron is preserved.

Owner checklist when test is explicitly authorized: eligible Essentials+ subscription, permission 8.4 Manage Integrations, Standard API credentials from Toast Web → Integrations → Toast API access → Manage credentials; scopes \`restaurants:read\`, \`menus:read\`, \`orders:read\`, \`labor:read\`, \`labor.employees:read\`; explicit restaurant GUID(s) mapped to AI CAFE location IDs. The secret must be entered only over the protected HTTPS setup route, never sent in chat.

## Next dependent implementation PRs — BLOCKING
1. Verified order financial normalization and closeout/business-date reconciliation. Never infer completed orders from modification time; preserve historical corrections; no zero coverage without authoritative day proof.
2. Menus V2 normalization and metadata caching, staff/time entries with real/missing wage provenance, shifts separately stored with RLS; guarded canonical sync and duplicate CSV reconciliation.
3. Signed webhook ingress, dedupe/replay protection, resumable bounded sync coordinators, disabled scheduler hooks; safe source-aware coverage.
4. Localized EN/ES/AR owner connection screen; tests for authorization and flows, full project regression/test/lint/typecheck/build, real staging reconciliation.

**Rollback:** disable setup routes at deployment, delete *only* the new functions/tables in reverse dependency order if they contain no needed pilot credentials. Existing canonical facts/Square/CSV are untouched; never drop historical tables. Disconnect via DELETE only deletes local credentials/mappings and does not revoke the Toast-issued client credentials; owner must also revoke them in Toast Web.

**CI baseline note:** The first full `npm run lint` attempt failed in pre-existing, untouched `components/menu/AggregateProductCostEditor.tsx`, `components/operations/TeamRulesManager.tsx` and `scripts/seed/demoData.mjs`. All 808 tests passed. We intentionally do not edit these unrelated files in a Toast PR. CI independently checks Toast-only lint and runs typecheck/build even if legacy lint fails; repository-wide lint still correctly reports failure.\n\n**Important:** all source changes must be reviewed and CI executed before changing this from draft. No live API verification, cost reconciliation, webhook/polling, or canonical facts are claimed in this PR.

## Security follow-up
Migration `20261012000047_toast_auth_throttle.sql` adds a lease claim guard honoring persisted Retry-After, without touching existing POS facts. Authentication 429s are persisted so repeated Vercel invocations defer instead of hammering Toast. Tests cover read-only token cache, expired bearer replacement, 429 suppression, transient API failure, owner/manager/demo restrictions and SQL access-control invariants. The SQL tests inspect migration contracts only; actual rollback and RLS must still be tested against an isolated staging Postgres database before approval. The full integration is not complete and live restaurant credentials have not been used.
