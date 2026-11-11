# Owner-approved generic Muse proposal → planning handoff (November 11, 2026)

Owner's rule: every authenticated Muse "yes" must **advance** the selected proposal, for any future task ID, without another manual GitHub step. Existing yeses for E2/7/9/10 must be replayed from the private ledger on the next trusted reconciliation, not requested again.

## Existing authoritative source/record contract

| Source | Real fields | Key | Reader / effect |
| --- | --- | --- | --- |
| Signed machine queue on main | id, goal, brief, scope_hint, exclusive_files/edits, dependencies, acceptance, state, architecture_approval | task ID | Existing trusted dispatcher; proposal planning ONLY when still unsigned |
| Private authenticated Muse owner_reply | event_id, kind=owner_reply, target.task_id, target.notice_id, text, submitted_at, authenticated GitHub actor | notice ID + event ID | Trusted inbox; existing owner_proposal_replies task map |
| Private owner notice | kind=next_task_proposal, task_id, source_sha, status, notice_hash, receipt | notice ID | Bound to exact planned source version |
| Private task/action ledger | planning approval identity, scope-planning stage, existing action ID/status, prompt hash/receipt, saved chat | task ID + deterministic scope-plan action key | Existing Muse private queue / signed opaque wake; **never** code permission |
| GitHub scope-plan comment on issue #411 | authenticated comment author, issue-comment ID, proposal-source SHA, original Muse action ID, exact edits/uses, architecture/source-key/change/gap description, acceptance plan | GitHub comment ID + immutable content digest | Trusted dispatcher validates provenance as UNTRUSTED proposed scope; Muse never reads assistant transcripts |
| Private scope-review notice and owner reply | kind=scope_plan_review, plan hash, exact owner question, issue link, notice hash; authenticated owner_reply event ID and exact target | notice ID + event ID | Existing Muse route; latest YES is a signed exact-file coding permission, latest NO revokes prior unmerged scope |
| Existing ledger scope authorization | approved exact owned files, read-only uses, task source hash, plan comment and hash, notice/reply IDs, approval digest | task ID | Derived signed effective queue; existing revalidateQueuedActions/dispatchFrontier/createDelivery are the ONLY coding release |

Source version changes invalidate pending read-only planning handoffs. Invalid/unverified/no/changed replies do not advance. The dispatcher continues to require a separately owner-approved exact file list, bound to the trusted plan comment and authenticated Muse reply, before generating any **coding** handoff. No machine-generated file ownership, hidden owner approval, external effects, second dispatcher, queue, scheduler, or token.

## Intended behavior

1. On any trusted main reconciliation, inspect newly recorded or historically recorded signed Muse proposal replies. If latest response is "yes" and exact notice source still matches the signed plan, write durable `scope_planning` state and enqueue exactly one **read-only scope design** prompt through the existing Muse courier. This is the next state, not a stalled `proposed` task.
2. Deliver the plan prompt through the existing authenticated action and receipt mechanism. A verified receipt moves it to `scope_plan_sent`; a retry/duplicate wake cannot reopen the same prompt.
3. The planning agent reads the actual code and submits ONE structured, public-safe exact-file/source/architecture/acceptance plan comment on the existing [owner-control issue #411](https://github.com/killbill2792/aicafe/issues/411). Muse is intentionally a **blind courier**, so it does not read the planning assistant's chat messages. The GitHub comment is untrusted planning input, NEVER code permission.
4. The trusted dispatcher verifies that GitHub comment's authenticated author, original submitted plan-action receipt, task ID, signed proposal source SHA, exact file list and history. It stores the immutable plan in the existing private owner notice and asks the owner through Muse to approve ONLY those files. The source comment link appears in the owner question. If issue comments roll off the most recent page, pending and signed decisions remain in the same private ledger.
5. The owner's authenticated Muse reply, bound to that exact plan-notice ID and content hash, signs the exact file scope as a derived task authorization in the existing private ledger. It is NOT approval merely because the planner created a GitHub comment. A later verified NO revokes an unmerged authorization; a changed source/plan or ownership overlap fails closed.
6. The dispatcher passes that signed exact-file overlay through the existing queue, dependency, capacity, approval-signature and PR gates; then issues a **begin_scoped_coding** action in the SAME verified planning chat. Only the trusted existing dispatcher can create that action. No separate PR, agent, hidden approval, queue, scheduler or token is added.
7. A stale dependency holds an unsent planning action; when dependency proof returns, the original action is restored without a new browser-send identity. A claimed/uncertain/submitted action is never blindly duplicated.

## What isn't automatically signed

The existing four proposals contain only suggestive file areas and **zero** exact approved files. The already given "yes" authorizes the next planning step, **not** arbitrary code edits, protected SQL, deployments or merge. This is why read-only planning is safe and directly executable while code assignment is not. Proposals that already contain a final owner-approved scope continue using the original coding assignment path.

## Acceptance and verification

Deterministic tests: backfill historical yes; all task IDs; no/no-op responses; changed scope; duplicate receipts; no coding `assign` while unsigned; one Muse deliverable read-only action; correct courier receipt, retry and post-receipt stage; no capacity consumption until actual code. Run current-head dispatcher Actions and baseline. Live Muse delivery requires an authenticated receipt; a file commit alone is not delivery proof. This PR changes dispatcher code and stays draft, owner merge only; never request early Codex or edit PROGRESS.md.

## PR comment disposition

Maintained on the PR body as a single checklist keyed to authenticated owner comment IDs and Codex review-thread IDs, with commit and test evidence. Review the PR discussion and current GitHub checks before declaring completion.
