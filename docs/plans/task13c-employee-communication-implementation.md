# Task 13C — Shared restricted employee communication (approved owner direction)

## Scope and source contract
This extends Task 13B on main, and does **not** create a second Supervisor, scheduler, authentication provider, staff roster, task engine, or owner chat. The owner explicitly authorized structured responses **and free text**, cross-task reuse, employee-only permissions, and reuse of existing owner-created login accounts.

| Verified source field | Canonical identity and change | New storage / consumer |
| --- | --- | --- |
| `auth.users.id,email,confirmed_at` | Existing owner-provisioned login, no account creation. Only server-side exact email lookup under authenticated owner authorization | `employees.staff_auth_user_id` link; login maps to **one** active employee. Login creation stays outside this task |
| `employees.id,business_id,active,phone_e164,whatsapp_opt_in` | Canonical employee and opt-in, never identify by name or raw model text | Worker web identity; signed WhatsApp correlation must match the unique opted-in phone |
| `scheduled_shifts.id,business_id,employee_id,local_date,start_local,end_local,status,updated_at,deleted_at` | Existing roster is authoritative. Published `sent` shifts become scoped employee requests. A revision/owner deletion cancels stale requests | `staff_communication_requests`, keyed by business/employee/source ID/source revision |
| `staff_schedule_publications` / deliveries | Published + sent/delivered are not staff acceptance | Context only; never promote delivery to confirmation |
| Authenticated staff web click or signed Meta inbound `wamid` | Immutable text and optional structured code, idempotent per client nonce/provider ID | `staff_communication_messages`, keyed by business/employee/nonce or provider wamid; owner tools/inbox read only verified receipts |
| Owner-approved future task/checklist request | A validated employee-scoped request issued by an authorized producer, never by staff | Reuse `staff_communication_requests` with source_type and owner-selected action; same secure staff endpoints |
| `memberships.user_id,role` | Existing owner membership, checked server-side AND at DB effect boundaries | Only owner may link a login or read messages from another worker; employee roles get no business membership |

**Uncertain/unknown:** unconfirmed WhatsApp sender, duplicate phone across tenants, unknown request context, stale shift, disabled staff sender, unverified attendance or a coverage offer without schedule write. Preserve as unverified or blocked. Do not guess a recipient or assert that staff is covered. Raw employee text is untrusted *data*, not an instruction to the AI.

## Shared path

1. A staff-only `/crew` surface uses existing Supabase Auth but does not load the owner navigation or owner tools. Server maps the signed-in user to precisely one active employee record. No signup or login provisioning is included.
2. One server-side staff communication service reads that worker's current assigned requests and their own messages; responses may combine `confirm`, `decline`, `complete` with written explanation, or submit an incident report without a request.
3. Append-only message rows and task receipts survive refreshes, retries and worker restarts; dedupe on client/provider request IDs. The DB rejects cross-cafe and cross-employee request IDs.
4. Existing `operating_tasks` and routine dispatcher bring the response into owner-facing Supervisor notices. A registered read tool gives Supervisor source-verified text and state. No employee LLM tools or chat memory.
5. Existing effect gateway owns any staff outreach or real roster change, requiring fresh owner approval. Staff responses are proposals/evidence, never automatic roster application.
6. Future assigned staff tasks/checklists use the same `staff_communication_requests` and `staff_communication_messages`; they may not invent authorization by writing those tables from a client.

## File ownership
New migration `supabase/migrations/20261117003000_task13c_staff_communication.sql`, service `lib/staffCommunication/channel.server.ts`, staff-only pages/components `app/crew/**`, `components/crew/**`, routes `app/api/staff-channel/**`, owner link UI `components/staff/StaffLoginLinkPanel.tsx`, targeted tests and SQL proof.
Existing integrations: `app/[locale]/staff/page.tsx`, `proxy.ts`, `lib/ai/agent/tools/scheduleReads.ts`, `lib/ai/supervisor/routines/dispatch.server.ts`, `lib/whatsapp/webhook.ts` and `app/api/whatsapp/webhook/route.ts` as required. No edit to `PROGRESS.md` or dispatcher signed queue. No production deploy.

## Acceptance that is **not** a unit-test claim
Prove with two isolated cafés and owner-created employee logins: A cannot see B, employees cannot call owner APIs/tools or read owner data; structured + text response persists once; changed shifts invalidate old requests; checklist producer can reuse protocol; owner gets deduped task and real registered Supervisor tool evidence; Meta retries and cross-provider collisions dedupe; revocation before any external effect blocks; restarted durable worker resumes; real GPT-6 Luna registered journey, independent disposable migrated DB and owner screen receipts; current-head full CI, Codex and security. Task17B/C final integration and 17D/E release remain separate.


## Shared channel implementation and proof boundaries (PR #501)

### Employee and owner communication
- Employee web sign-in uses the existing owner-created, confirmed auth login mapped by the owner to exactly one active employee. The isolated /crew page reveals only that employee's assignments, messages, and their own responses. There is no second agent or login provider.
- The employee may confirm or decline a published shift, complete assigned work, attach a written explanation, send text without clicking either response, or report an independent issue. Text remains employee-authored evidence, not a command to Supervisor or a recorded roster change.
- The signed staff WhatsApp sender accepts text from a uniquely matched opted-in employee and saves it as an unmatched-to-shift issue report. Unknown or ambiguous staff numbers get a durable hashed quarantine receipt without retaining the raw uncorrelated text. A provider wamid is a dedupe identity, not a delivered/read receipt.
- The owner can explicitly send an in-app reply and assign work or a checklist from the Staff page, with dedicated owner-only authenticated database RPCs. The web response does not claim the employee has received or read the message. These endpoints never send WhatsApp and never update a roster.
- Future task/checklist PRs reuse the same worker-specific request and message record protocol. New automated outbound effects must still use the existing approval and effect gateway; importing the channel does not grant approval or service-account authority.

### Reuse of Task 15A's actual Supervisor
Task 15A merged after the initial 13C draft. PR #501 now incorporates that latest main: the existing routine tick discovers changed published shifts and unanswered imminent confirmations; operating-task evidence is queued into the existing durable investigation worker. The registered Supervisor reads a claim-bound incident, verified employee-originated replies and independent roster or labor evidence. The off-turn read port authenticates the claimed owner and café from stored scope rather than a worker cookie. It cannot approve or perform an outbound effect while investigating.

The owner must still authorize any changed published schedule or external worker outreach; an employee suggesting 8 AM instead of 7 AM is an unverified scheduling proposal, not a completed coverage change.

### Explicit acceptance status (not a substitute for execution)
- Migrated DB test source: scripts/task13c-staff-channel-db.sql, registered in scripts/db/run-all.sh. Includes two-café RLS, owner-created account linking, free-text/structured reply, nonce replay, owner reply, assigned checklist, stale-shift rejection, and denial for wrong identities.
- Real seeded browser source: tests/e2e/staff-channel.spec.mjs, registered in the fail-closed @staff Playwright scenario; verifies a worker's real login and written decline, owner sees it, owner replies, checklist gets completed, and cross-café access is denied.
- Provider parser/route, registered agent tool, and independent evidence domain negative tests are included in the same full regression suite.
- Real GPT-6 Luna feature: NOT PROVEN until separately owner-authorized secret-isolated execution on this exact behavioral head proves tool-choice, persistent follow-up, independent source/owner UI and approval/receipt negative cases. Fake/recorded evaluator output is not equivalent.
- Task17B/17C integrated autonomy: NOT PROVEN (combined registry completeness, genuinely unattended multi-domain restart and coverage closure). Task17D/E release: NOT PROVEN (no production effects).


### Linked-worker owner-onboarding boundary (security addendum)
The existing generic first-owner onboarding bootstrap uses a service-role client to create a café. A worker login is a valid auth account but has no owner membership, so an unguarded onboarding visit would bootstrap a business. 13C explicitly owns the necessary minimal access guards: lib/staffCommunication/identity.server.ts (single positive linked-employee identity check), lib/auth/requireUser.ts (owner page guard redirects linked employees to /crew), app/[locale]/onboarding/page.tsx (pre-render deny), and lib/actions/onboarding.ts (server action refuses service-role business creation). The seeded employee browser test proves a linked worker cannot enter onboarding or cause a new business row. This does not change unrelated new owner signup behavior.


### Final owner-only access and credential revocation scope
Linked staff accounts (including deactivated employees whose auth record remains linked) are barred from owner business pages, the owner More navigation, Pricing, and any first-owner onboarding bootstrap. Account self-service password-reset/deletion paths remain available, rather than treating employee status as a ban on privacy/self-service controls. The actual owner can explicitly unlink an inactive employee; a newly linked or relinked account must still belong to an active employee. The owner linking form refreshes the shared reply and checklist composer without a manual reload, and the composer derives a safe live selection when the first link arrives asynchronously. The original owner account ID in a signed in-app message is retained as historical provenance without creating a foreign-key restriction that prevents auth account deletion.

Additional exact write-owned paths for those necessary boundaries and negative tests:
- app/[locale]/more/page.tsx and app/[locale]/pricing/page.tsx — owner-only screens redirect linked staff, without making pricing or subscription data staff-visible
- components/staff/StaffReplyComposer.tsx and components/staff/StaffLoginLinkPanel.tsx — current linked selection, owner unlink after deactivation, server refresh
- lib/data/snapshotIdentity.test.ts — scoped legacy owner caching mock, not an exemption from the staff guard
- scripts/e2e/targeted.mjs and scripts/e2e/targeted.test.mjs — real @staff browser proof required for onboarding, More and Pricing changes, unknown UI still fails closed
- tests/e2e/staff-channel.spec.mjs and scripts/task13c-staff-channel-db.sql — actual browser/SQL negative cases for staff, disabled employee and owner unlink.
