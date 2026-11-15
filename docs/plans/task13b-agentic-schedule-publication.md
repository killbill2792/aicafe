# Task 13B — Agentic schedule publication and worker messaging

> **OWNER'S NON-NEGOTIABLE ACCEPTANCE GATE:** AI CAFE Supervisor must behave as a proactive, persistent, multi-step café operator comparable in operational ambition to Grokbot/Muse—not a Q&A bot. It must notice unpublished schedules, prepare/evaluate a plan with canonical staff facts, request the *specific* missing approval, carry out authorized publication, track durable per-worker message attempts and delivery evidence, recover safely, and proactively report the next action to the owner. A card, copied message, provider HTTP 200, or green unit test alone is NOT completion.

**Owner approval:** Owner explicitly authorized implementation and this agentic acceptance requirement in the Task 13B chat on November 14, 2026, following the earlier complete 13B field/architecture audit. This is coding authorization only, not blanket approval to contact staff or production deployment. This branch begins at main `b10db991341df80ab204dca51128d04b00ed3cc4`.

## One canonical Supervisor flow

```text
Existing Supervisor → 13A staff facts / draft → existing owner-approval proposal
   → one service-only publication transaction → versioned immutable publication receipt
   → existing durable routines/worker → per-staff authorized delivery attempts
   → provider acceptance ID → signed status webhook → owner-visible verified outcome
   → existing Operations / Supervisor notices for pending, failed or uncertain work
```

**Sources / primary keys / change authority**

| Source field | Authority, scope and changes | Destination/identity | Consumers |
| --- | --- | --- | --- |
| `scheduled_shifts` `business_id, employee_id, local_date, start_local, end_local, overnight, break_minutes, status, deleted_at` | 13A and an owner-approved staff proposal; rescheduling before publication invalidates a pending snapshot | one source roster, not copied | Staff screen, Supervisor, publication CAS |
| `supervisor_proposals` `id, owner_user_id, thread_id, capability_id, effect_hash, revision, status` and matching `supervisor_approvals` | existing Supervisor gateway, explicit owner click; no model-supplied authorization | `(business_id,proposal_id,revision,effect_hash)` | publication gateway and audit |
| `scheduling_plan_revisions` + `scheduling_plan_series` | legacy Olivia approved/published revision and source CAS; status `published` is not message delivery | `(business_id,plan_revision_id)` | same publication resolver, Staff readers |
| `employees` `id, active, phone_e164, whatsapp_opt_in, preferred_schedule_channel, preferred_language` | owner-edited contact/consent; a phone change resets opt-in | `(business_id,employee_id)` | per-recipient send authorization |
| `staff_schedule_handoff_snapshots` and canonical `staff_handoff_week_shifts` | immutable proposal handoff and current roster equality; expired if the underlying shifts change | `(business_id,proposal_id)` | service-role publication RPC |
| `staff_schedule_publications` | server-only appended published revision receipt and locked full-week roster digest | one `(business_id,week_start,publication_revision)` and unique proposal | owner results, staff UI, durable follow-up |
| `staff_schedule_deliveries` | existing status ledger extended for provider IDs/outcomes; no message until publication authorization | `(business_id,publication_id,employee_id)` | worker, webhook, owner status |

**What is *not* stored/assumed:** OTP, provider tokens, plaintext untrusted inbound instructions, fake delivered/read timestamps, duplicated canonical roster, implicit staff acknowledgment/attendance, or guessed phone consent. Source/country/legal-profile differences remain explicit. Worker WhatsApp requires employee-specific opt-in and a separately configured, approved outbound template. Owner-only WhatsApp identity cannot be reused to identify or message workers. A disabled/unsupported provider leaves an explicit blocker with manual owner composer fallback—not a success claim.

## Authorization and effect contract

- Only the **existing** approved and committed `propose_send_schedule` capability (or equivalently verified published Olivia revision) may authorize publication. Re-check business, owner, proposal, week, revision and exact roster under the SQL transaction. No implicit publish by drafting.
- A standing staff mandate, if enabled, must use verified phone MFA and a narrowly scoped capability/policy/expiry/recipient ceiling through the existing Supervisor gateway. Revocation checked **at send claim time**, not only on queue creation. Until the policy is implemented and verified, click approval is mandatory; no unsafe mandate fallback.
- Publication is distinct from delivery. Publishing is idempotent and keeps the same week/revision visible to Staff and Supervisor. A later change requires a fresh approval and revision with correction notice; never overwrite a published message silently.
- Provider outcomes: prepared → claimed/sending → accepted/sent → delivered/read or failed; 5xx/timeouts and lost receipts become **uncertain** and are reconciled before retry. Manual composer open is `sent_by_owner`, not a provider delivery receipt.
- Existing routines and Operations/Supervisor notices carry every pending or failed step across page reloads and sessions, without a second agent or cron.

## Security and acceptance

Required, not optional: B01–B26 from the approved architecture audit, including correct single authoritative roster, two-café isolation, owner approval/mandate boundary, revocation before send, overlapping publication CAS, changed recipient/phone/consent CAS, retry/restart and uncertain outcomes, webhook verification, exactly-once provider acceptance bookkeeping, corrections, status vocabulary, staff UI/chat parity, proactive notice without a new chat prompt, registered Supervisor interaction, and Task 17A owner-domain gate. Execute actual disposable-database and browser acceptance; missing real provider / live-model / competitor side-by-side proof is **UNPROVEN**, not a pass.

## Ownership / exclusion / merge danger

Expected paths: existing `lib/ai/supervisor/loop/staffProposals.server.ts`, existing effect/authorization gateway and owner approval route where essential; additive publication/recipient service, one additive staff migration, existing staff delivery and WhatsApp status adapter, tests, Task17A acceptance registration. PR #482 Task14B independently owns several shared Supervisor/CI files; merge order and final-head rebase must reconcile those. Do not edit `PROGRESS.md` (coordinator only), change Task13C worker response/shift coverage, create a second agent/approval system, or silently deploy. **One-way migration; blast radius: staff rosters and employee messaging.** Deployment/production send remains owner-gated.

**Proof status:** architecture/owner intent verified; all Task 13B implementation, CI, real provider and side-by-side Grokbot/Muse parity tests are **PENDING** until independently executed on the final head.
