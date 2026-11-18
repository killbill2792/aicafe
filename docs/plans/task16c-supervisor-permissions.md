# Task 16C — Supervisor external permission controls (owner-approved architecture, Nov 17 2026)

## Outcome and separation
One existing autonomous Supervisor remains responsible for model-selected research, durable steps, proactive updates and owner-gated effects. This PR adds enforceable external access controls and visible, revocable settings; it does **not** add another agent, scheduler, connector platform or privileged browser/computer executor. Task 16D integrates accessibility, Task 17B inventories all tools, Task 17C proves unattended/restart, Task 17D tests combined UI, and Task 17E handles separately authorized release.

## Source → storage → reader/worker
| Current source | Real received fields and keys | Stored and authority | Change/revocation |
|---|---|---|---|
| Task 11 Gmail OAuth | Google verified `sub`, `email`, token scopes; owner + café | `connector_accounts` key (`business_id,owner_user_id,provider`), `connector_credentials` by `account_id` with encrypted tokens; `connector_provider_receipts` | Owner operation changes atomically update generation alongside credential generation; reconnect/disconnect invalidates old proposals. Existing Task 10 gateway still owns effects. |
| Task 12 selected upload | `id`, filename, MIME, size, object path, owner/café/thread | `ai_attachments` and `ai-chat-private`, selected attachment IDs only for the turn | Denial overlay keyed to existing scoped attachment ID, verified again before model exposure; stored evidence is not hard-deleted. |
| Public web search | Text query and HTTPS source URLs, no connected account | Existing read-only `web_search` and `inspect_public_page`; optional owner denial record | Recheck before each public search; disabled access returns unavailable, not fabricated results. |
| Authenticated browser/computer | **No usable Supervisor runtime discovered**; developer dispatcher browser is not a café tool | Nothing connected; shown as unavailable | No privileged browser/desktop agent or provider credentials exposed in this PR. |
| Provider effects | Current owner click/mandate and immutable proposal/effect hash | Existing `supervisor_proposals`, `supervisor_effect_attempts`, provider receipts | Gateway remains sole effect path; stale/unknown provider outcome is reconciled without blind replay. |

## Proposed permission state
A single additive service-only `supervisor_external_access` table stores explicit owner changes for public web and per-file revocation, with composite owner+café+kind+resource key and monotonic revision. Absence preserves current public web behavior and the existing **explicitly selected only** file capability. Its immutable audit table captures all changes; server-side CAS/owner membership required. Fail closed on missing/unreadable permission data. File access once revoked is not silently re-enabled; a new upload and explicit selection are required.

Gmail internal `enabled_operations` remains the source for read/draft/send/organize; no separate permission registry or shadow OAuth token. Google `gmail.modify` is broader than internal switches: disclose this clearly and do not imply Google supports separate OAuth scopes per switch.

## Owner experience
Keep existing Gmail panel, add operation switches with truthful pending/conflict/reconnect state; disclose Google scope and that every consequential effect separately requires approval. Add a single Supervisor access area under More showing Gmail (existing panel), public web enable/disable, selected uploaded files with revoke-future-use, and unsupported computer access. Use existing Supervisor run/receipt projection, not another work queue. No credentials, raw mail, document contents or private prompts in settings/audit logs.

## Exclusive proposed paths
- `docs/plans/task16c-supervisor-permissions.md` (this plan; no PROGRESS edits)
- `supabase/migrations/20261118100000_supervisor_external_access.sql`
- `lib/connectors/registry.server.ts`, `lib/connectors/gmail/provider.server.ts`, `lib/connectors/access.server.ts`
- `app/api/connectors/gmail/permissions/route.ts`, `app/api/connectors/gmail/status/route.ts`, `app/api/connectors/gmail/callback/route.ts`
- `app/api/supervisor/access/route.ts`, `app/[locale]/more/supervisor-access/page.tsx`
- `components/more/GmailConnectionPanel.tsx`, `components/more/SupervisorAccessPanel.tsx`, `app/[locale]/more/page.tsx`
- `lib/ai/conversations/agentRunner.server.ts`, `app/api/ai/threads/[threadId]/attachments/route.ts`, `messages/en.json`, `components/home/chatExperience.ts`
- existing tests `app/api/connectors/gmail/routes.test.ts`, `lib/connectors/gmail/provider.test.ts`, `components/home/chatExperience.test.ts`, `tests/redesign16Cleanup.test.ts`, `tests/e2e/owner-journeys.spec.mjs`, `scripts/acceptance/owner-gate.mjs` + `owner-gate.test.mjs`, `scripts/e2e/targeted.mjs` + `targeted.test.mjs`, `scripts/db/run-all.sh`, focused new security/API tests and `scripts/task16c-external-permissions-db.sql`.

## Acceptance / merge gate
- Real registered `gpt-6-luna` selected tool journey in trusted, bounded, owner-authorized disposable Supabase; independently read account permission/receipt and owner UI; record exact provider/code evidence.
- Gmail: permission toggle CAS and generation; stale proposal denied; no send without owner-click; revoked while delayed or after worker restart denied; unknown outcome reconciled not resent.
- Files: owner-selected provenance, wrong café/thread access denied, revoked file no model access even on resumed work; hostile email/PDF/CSV content never treated as permission.
- Web: deny before provider request; timeout/error not reported as success; public search never leaks private café details.
- Auth/RLS: stolen resource IDs/other café, manager/anonymous, CSRF, concurrent updates, stale browser tabs; each change auditable.
- Desktop and 390px mobile: owner can see identity/scope, disable/revoke, refresh, see failed/uncertain state, safe retry; no duplicate approval cards.
- Full exact-head CI, security, final-head Codex and actual browser tests. **No Vercel previews or production connections/effects.** If real Luna or scoped database execution is unavailable, explicitly mark feature_unproven and **do not merge**.

## Task 17 retests
17B: dynamically enumerate new/existing external registry tools and coverage of all operations, permission failures and UI parity.
17C: real Luna proactive source-triggered Gmail/file/public-web investigation, owner notice, pause/revoke between plan and next tool, actual worker termination/restart with same work ID, effect receipt reconciliation, no duplicate send, cross-café concurrency.
17D: reconnect and mobile/desktop owner controls, stale tabs, revocation during pending approval, offline/retry, accessibility.
17E: owner-authorized disposable-to-live rollback and production safety only after fresh approval.
