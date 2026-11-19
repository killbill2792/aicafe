# Task 13D — Proactive recruitment, leave and onboarding coordination

## Owner direction (17 Nov 2026)
Build on merged Task 13A and in-progress Task 13C, and open Task 13D as an early stacked draft. **Task 13D must not merge until 13C is merged to main and its integration is verified.** Preserve first-party proactive Supervisor, owner-authorized decisions and actual sources, not a separate HR agent, inbox, scheduler, or staff chat.

## Existing authority and responsibility boundary
- **13A on main, PR #480:** canonical employee, shift, availability, qualifications and coverage projections; reuse the same Staff page and registered schedule/coverage tools.
- **13B on main:** scheduling publication and delivered receipt; neither proves employee response/consent.
- **13C draft #501:** owner-linked staff login, restricted `/crew` interface, `staff_communication_requests` and append-only `staff_communication_messages`, signed inbound/deduplication and owner-facing notices. **13C exclusively owns messaging/login/WhatsApp; do not fork its channel.**
- **15A on main, #488:** existing routine dispatch and model-driven incident investigation, durable step/lease/source validation, owner inbox/chat. Reuse it, never add another scheduler or agent.
- **10/11 on main:** existing action approval, outbound Gmail draft/send/receipts; never assume that an email send proves acceptance or an interview happened.

## Source-to-record contract
| Source | Actual fields/meaning | Case and evidence | Uncertainty / change |
| --- | --- | --- | --- |
| `staff_communication_messages` (13C) | `business_id,id,employee_id,request_id,response_code,body,channel,client_nonce,provider_event_id,received_at`; authenticated/reconciled staff response, **not** an approved leave or employment decision | A unique `staff_message` case keyed `(business_id,'staff_message',id)`; evidence references the message ID, not duplicated message body | Messages can be late, irrelevant or ambiguous. Model/owner must classify; treat free text as untrusted data |
| `employees` | `business_id,id,active,role,staff_auth_user_id` and separately protected contact data | Foreign key to known employee only; do not copy pay/contact data | Deactivation/revocation invalidates pending work |
| `scheduled_shifts` | `business_id,id,employee_id,local_date,start_local,end_local,status,updated_at` | Evidence references exact shift and revision | Changing shift makes old recommendation stale; never infer confirmed coverage from a send |
| `staff_availability_exceptions` | `business_id,id,employee_id,local_date,exception_type,source,confirmation,revision` | Actual `approved_leave` is verified **only** from source-backed owner-confirmed exception | Owner-reported worker request is unverified origin until authenticated worker reply |
| `scheduling_coverage_requirements`, canonical `get_coverage_gaps` | Location/qualification/headcount/dates; canonical derived staffing gaps | Read to investigate vacancy versus temporary absence | Missing coverage configuration does not mean adequate staffing |
| Owner's authenticated selection, existing proposals and approval/effect attempt | Owner ID, decision, revision and receipt | `owner_decision` + effect/receipt references | No model-made hire/reject/fire or outgoing message |
| Gmail/authorized future recruitment provider | Actual provider message/thread and receipt IDs; no ATS/job board integration exists | Minimal `external_reference` only after consent and owner authorization | Sent, delivered, offered, accepted, interviewed, hired and onboarded are distinct states |

## Owned records and keys
- New **`staff_coordination_cases`**: `id` UUID, `business_id`, `owner_user_id`, `case_kind` (intake/leave/recruitment/onboarding), `source_kind`, `source_key`, `employee_id`, optional `location_id`, relevant dates, state, `next_check_at`, revision, evidence-source revision and `retention_at`. Unique `(business_id,source_kind,source_key)`, composite tenant-safe references, owner-only RLS, no employee direct access.
- New **`staff_coordination_evidence`**: keyed `(business_id,case_id,evidence_key)`, links a source type/ID/revision and observed timestamp. Never copy free text/medical reason/candidate contact/pay into this ledger.
- Reuse **`supervisor_investigations`**, **`supervisor_runs`**, **`operating_tasks`**, **`supervisor_proposals`**, existing approval/effect ledger for model steps, off-turn follow-up, owner alerts and consequential effects. No new worker or duplicated step ledger.
- Candidate-identifying data stays at authorized provider/owner source; pending case references expire and must be purged after a bounded retention window. For missing consent, record **blocked—not contacted**.

## Workflow and permissions
1. Ingest 13C staff report once, as `intake`, preserving its authenticated origin; no SQL keyword classifier and no automatic leave grant.
2. Existing 15A task investigation/model selects registered Staff/coverage and coordination evidence reads. A missing staffing requirement or no response remains **unknown**, never zero or acceptance.
3. Owner is shown a concrete verified next step: approve/deny leave; approve recruiting outreach/interview invitation; attest confirmed hiring and onboarding prerequisites. Only owner can record personnel decisions and only with a checked current revision.
4. Owner-approved existing proposal/effect gateway executes separately; reread canonical schedule/availability/provider acknowledgment and transition to `completed` only after source-verified result. A `sent` email does not close an interview/onboarding case.
5. An unresolved case retains a due follow-up through the **existing** routine tick and reports changes through the **existing** owner inbox/chat, without duplicate notices.

## Owned files vs shared integrations
Exclusive: `lib/staffCoordination/*`, `lib/ai/agent/tools/staffCoordination.ts`, migration `20261114001004_task13d_staff_coordination.sql`, dedicated DB/unit/e2e tests, this plan.
Shared (minimal edits only after 13C source stabilizes): `lib/ai/agent/tools/index.ts`, `lib/ai/supervisor/routines/investigation.ts` and its owner-bound scope wiring, existing dispatcher test/selection. **Never modify `PROGRESS.md` or 13C login/chat/WhatsApp components.**

## Mandatory proof before merge
- 13A really on main; 13C #501 merged with exact main-tree integration and no unresolved staff privacy defects.
- Two-café RLS; revoked staff/member; replay/nonce idempotency; source revision change; no autonomous hiring/termination/leave approval; case follow-up and verified closure; candidate expiration/purge; security and targeted seeded browser.
- Actual production-configured registered **GPT-6 Luna** multi-tool unattended Supervisor evidence and independently verified stored case/owner-screen/approval/effect receipts on disposable migrated Supabase, with a distinct owner-funded bounded trusted run.
- Full exact-head CI, no required skipped tests, clean exact-head Codex code/security review after prerequisites merge, and merge only on current `main`. Task17B/C holistic integration and Task17D/E release proof remain separate.

## Explicit limits
No job-board/ATS connector exists; do not claim automatic posting, applications, candidate consent, interview completion or hire from guessed data. Medical/leave reasons do not enter model reports or coordination evidence. No real provider sends, paid model spending or production migration without separate authorization.
