# Owner-approved generic Muse proposal → planning handoff (November 11, 2026)

Owner's rule: every authenticated Muse "yes" must **advance** the selected proposal, for any future task ID, without another manual GitHub step. Existing yeses for E2/7/9/10 must be replayed from the private ledger on the next trusted reconciliation, not requested again.

## Existing authoritative source/record contract

| Source | Real fields | Key | Reader / effect |
| --- | --- | --- | --- |
| Signed machine queue on main | id, goal, brief, scope_hint, exclusive_files/edits, dependencies, acceptance, state, architecture_approval | task ID | Existing trusted dispatcher; proposal planning ONLY when still unsigned |
| Private authenticated Muse owner_reply | event_id, kind=owner_reply, target.task_id, target.notice_id, text, submitted_at, authenticated GitHub actor | notice ID + event ID | Trusted inbox; existing owner_proposal_replies task map |
| Private owner notice | kind=next_task_proposal, task_id, source_sha, status, notice_hash, receipt | notice ID | Bound to exact planned source version |
| Private task/action ledger | planning approval identity, scope-planning stage, existing action ID/status, prompt hash/receipt, saved chat | task ID + deterministic scope-plan action key | Existing Muse private queue / signed opaque wake; **never** code permission |

Source version changes invalidate pending read-only planning handoffs. Invalid/unverified/no/changed replies do not advance. The dispatcher continues to require the established exact owner-approved file list and signed task authorization before generating any **coding** `assign` prompt. No machine-generated file ownership, hidden owner approval, external effects, second dispatcher, queue, scheduler, or token.

## Intended behavior

1. On any trusted main reconciliation, inspect newly recorded or historically recorded signed Muse proposal replies. If latest response is "yes" and exact notice source still matches the signed plan, write durable `scope_planning` state and enqueue exactly one **read-only scope design** prompt through the existing Muse courier. This is the next state, not a stalled `proposed` task.
2. Deliver the plan prompt through the existing authenticated action and receipt mechanism. A verified receipt moves it to `scope_plan_sent`; a retry/duplicate wake cannot reopen the same prompt.
3. The planning agent reads actual source, proposes precise files/dependencies, and routes any remaining scope decision back through Muse. The existing owner authorization and signed queue remain the only gate before coding. If missing, surface the exact blocker to Muse; never silently stop.
4. Once an independently signed exact coding authorization is later present in the queue, existing assignment logic (capacity/dependencies/CI/Codex) continues unchanged.

## What isn't automatically signed

The existing four proposals contain only suggestive file areas and **zero** exact approved files. The already given "yes" authorizes the next planning step, **not** arbitrary code edits, protected SQL, deployments or merge. This is why read-only planning is safe and directly executable while code assignment is not. Proposals that already contain a final owner-approved scope continue using the original coding assignment path.

## Acceptance and verification

Deterministic tests: backfill historical yes; all task IDs; no/no-op responses; changed scope; duplicate receipts; no coding `assign` while unsigned; one Muse deliverable read-only action; correct courier receipt, retry and post-receipt stage; no capacity consumption until actual code. Run current-head dispatcher Actions and baseline. Live Muse delivery requires an authenticated receipt; a file commit alone is not delivery proof. This PR changes dispatcher code and stays draft, owner merge only; never request early Codex or edit PROGRESS.md.

## PR comment disposition

No actionable PR comments at creation. Reconcile any subsequently added IDs in this PR before final review.
