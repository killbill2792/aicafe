## Owner-approved purpose: no silent stop after Muse proposal yes

**Observed failure (verified at 2026-11-11 09:17 UTC):** E2, 7, 9 and 10 have authenticated Muse `next_task_proposal` yes replies in the private ledger, but zero coding assignments. The signed queue still lists each as `state=proposed`, with `architecture_approval=null` and `exclusive_files=[]`. Task 6, in contrast, already had explicit approved files before its start yes.

**Fix the dispatcher lifecycle, not Muse:** An authenticated yes bound to the current proposal hash must advance into a **scope-preparation/authorization-needed** state, never disappear silently. The dispatcher publishes one version-bound `next_task_scope` owner notice through the existing private Muse queue, specifying the task's approved goal, acceptance and suggested source area, and explicitly requesting an exact reviewed file list. Subsequent valid queue authorization will be handled by existing dispatcher assignment rules. No owner should be directed to GitHub or asked to repeat the original proposal yes.

**Data contract:** Source = checked-in queue task ID, dependencies, goal, acceptance, `scope_hint`, plus authenticated `owner_proposal_replies[task_id][event_id]` and matching submitted `owner_alerts[notice_id]` from Muse. Key = existing deterministic `notice_hash(kind, task_id, source_sha)`. Writes = existing `owner_alerts` only, no new database, no credential or extra agent. Muse reads the same `dispatcher/state.json` and `dispatcher/owner-queue.md`. Stale/edited scope invalidates the request, preserves historical receipts and re-notifies.

**Safety:** Saying yes to an unsigned broad proposal is not approval of unknown files. The dispatcher must not fabricate the exact write list, set `approved=true`, create coding prompts, bypass signed-queue authority, or merge itself. Preserve the exact-head CI, Codex and integration rules.

**Acceptance:** Tests for all four real receipts, one scope notice per valid yes, duplicate reconciliation, negative/stale replies, signed already-approved tasks, receipt version changes, and no unauthorized task assignments. Exact-head CI receipts required. Owner-merge only; keep draft until full checks green.

**Remaining architectural boundary:** This PR makes the missing next step visible and actionable through Muse, but cannot itself infer or certify unseen exact file lists. Creating/proposing and signing those exact scopes through Muse remains necessary before coding. Do **not** advertise coding as started just because proposal yes was recorded.

**Comment dispositions:** None at opening. This is a new focused follow-up to #431. No fabricated ChatGPT conversation URL.
