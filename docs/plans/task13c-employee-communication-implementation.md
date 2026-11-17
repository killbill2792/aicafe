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
New migration `supabase/migrations/20261114001003_task13c_staff_communication.sql`, service `lib/staffCommunication/channel.server.ts`, staff-only pages/components `app/crew/**`, `components/crew/**`, routes `app/api/staff-channel/**`, owner link UI `components/staff/StaffLoginLinkPanel.tsx`, targeted tests and SQL proof.
Existing integrations: `app/[locale]/staff/page.tsx`, `proxy.ts`, `lib/ai/agent/tools/scheduleReads.ts`, `lib/ai/supervisor/routines/dispatch.server.ts`, `lib/whatsapp/webhook.ts` and `app/api/whatsapp/webhook/route.ts` as required. No edit to `PROGRESS.md` or dispatcher signed queue. No production deploy.

## Acceptance that is **not** a unit-test claim
Prove with two isolated cafés and owner-created employee logins: A cannot see B, employees cannot call owner APIs/tools or read owner data; structured + text response persists once; changed shifts invalidate old requests; checklist producer can reuse protocol; owner gets deduped task and real registered Supervisor tool evidence; Meta retries and cross-provider collisions dedupe; revocation before any external effect blocks; restarted durable worker resumes; real GPT-6 Luna registered journey, independent disposable migrated DB and owner screen receipts; current-head full CI, Codex and security. Task17B/C final integration and 17D/E release remain separate.
