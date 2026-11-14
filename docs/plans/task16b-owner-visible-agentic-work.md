# Task 16B — Owner-visible durable, proactive agentic work

Owner direction: Grokbot/Muse-class proactive, persistent, multi-step *behavior* is mandatory, not a cosmetic loading indicator. This task must display genuine persisted work, owner decisions, exceptions and independent verified results in the one Supervisor chat. The owner explicitly authorized implementation in this conversation.

Existing sources, keys and trust boundaries:

| Existing record | Read fields | Identity/key | Change trigger | Authoritative for |
| --- | --- | --- | --- | --- |
| supervisor_runs | id, request_key, status, final_report_ref, updated_at, finished_at | business_id + owner_user_id + thread_id + run id | worker claim, step, finish | Durable run lifecycle; a saved answer **not** external delivery |
| supervisor_run_steps | run_id, step_key/index, status, attempts, error_code, lease_until, updated_at | business_id + run_id + step_key | worker lease/complete/reconcile | Retry, exception, uncertain leased step |
| ai_agent_jobs | id, owner_message_id, status, reply_message_id, attempt, heartbeat_at, created_at | business_id + thread_id + job id | existing conversation worker | In-progress turn or saved reply; heartbeat is not effect proof |
| supervisor_proposals | id, status, capability_id, effect_hash, updated_at | business_id + owner_user_id + thread_id + proposal id | existing approval gateway | Awaiting owner approval, executing or reconciled proposal |
| supervisor_effect_attempts | proposal_id, effect_hash, state, receipt_ref, verified_at | business_id + proposal_id + immutable effect hash | gateway receipt / reconcile | Verified external or database effect only when hash, state, receipt and proposal lifecycle agree |

Only server-owned, authenticated owner/café/thread-scoped reads. Projection keeps no new rows, does not copy provider payloads into browser status, and never trusts model text or client status for receipt proof. Existing proposal card handles approvals. No new scheduler, worker, database, action gateway, reminders service or polling daemon. Use existing live chat/realtime and a bounded read refresh while owner is viewing chat. Café/provider differences are shown as incomplete/uncertain, not invented success. Worker deployment dispatch is a separate integration proof gate, not silently considered done.

Acceptance: verified multi-step autonomous flow with no repeated user prompting; persisted status and recovery across close/reload/reconnect; exactly-once owner approval and provider effect; negative evidence/lease expiry/timeout cases; cross-café isolation; phone/desktop keyboard/screen reader; end-to-end with actual DB, provider receipts and stable final-head CI + clean Codex. Task 15A/13B/14B domain implementations must integrate; this PR alone is not competitor-parity proof. Work that lacks actual runtime/provid­er evidence remains explicitly unproven.
