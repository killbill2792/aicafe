# AI CAFE — coding-agent operations (short, owner-review draft)

**Required reading for every agent:** latest main `AGENTS.md`, `PROGRESS.md`, relevant `docs/rules/*`, [task queue](universal-supervisor-queue.json), [Universal Supervisor delivery plan](universal-supervisor-delivery-queue-2026-11.md), this operations guide, and the exact [task brief](universal-supervisor-task-briefs.md). Use the **connected GitHub plugin** to fetch actual files, PRs, commits, CI/check logs, Codex reviews, comments and thread resolution; explicitly read applicable `.claude/skills/*/SKILL.md` from GitHub. Do not assume a cloud shell, uninterrupted waiting, skill auto-loading or live production access.

## Current dispatch order — POS0 before PR6

**Current mandatory first-read contract for all POS0 coding tasks:** [docs/rules/pos-data.md](../rules/pos-data.md). It is the single authoritative classification of OPERATIONAL_CURRENT (`toast_raw_records`), OPERATIONAL_CHANGE_LOG (`toast_raw_changes`), LEGACY_DIAGNOSTIC_ONLY (`toast_raw_samples`), TEST_FIXTURE_ONLY, existing source writers/readers, naming, no fallback, safe retirement, and real source-to-Supervisor proof. Code/migrations/fixtures with contradictory comments **do not override it**. The generated ChatGPT/Claude coding handoff explicitly requires `source_authority_checked: yes` in every POS0 PR and actual consumer inspection.

**Corrected source-first DAG:** POS0a is the read-only operation/field/key/scope audit, then **POS0e FIRST** owns the shared existing Toast reader/field discovery/retention-policy cutover. POS0e retires current Supervisor/canonical dependencies on diagnostic samples before the new source-family PRs. POS0b staff/labor, POS0c cash/stock/kitchen and POS0d menu/config may then run on **disjoint** adapters and current-object writers, all using POS0e's shared tools. POS0f finally proves all field→stored→reader→Supervisor→screen paths and finishes the tracked diagnostic/fixture retirement only after dependency and retention checks. Do not build duplicate customer tables, new AI readers, sample fallbacks, or new agents. Every permitted field is available to authorized café AI on demand; only card PAN/CVV/track and reusable card/security credentials are filtered. Missing optional fields do not block other records/answers.

**Priority and authorization stay distinct.** POS0f is the proof gate before any new E2/PR6/PR9/PR10 assignment. POS0a's earlier read-only approval does not imply approval for field-level implementation, an exact file list or production database deletion. After POS0a's actual merged SHA is `integrated_proven`, the owner must review its final field/key/source/reader contract and supply an authenticated GitHub comment URL. Record exact SHA, `approved=true`, and review comment under `dispatch_rules.architecture_foundation_implementation_approval`. Until that, the existing gate stays `approved=false`; **do not start POS0e code or POS0b–d** merely because this is the planned sequence.

**Stacking:** POS0e opens on the verified POS0a prerequisite branch if open (with approved exact scope). POS0b/c/d each depend on POS0e and POS0a; stack on POS0e's branch while open, each with exclusive nonoverlapping files and no independent edit to the global reader/redactor. POS0f depends on POS0e plus b/c/d; select its declared stack base `POS0d` when multiple predecessors remain open and keep all other predecessor proofs as merge gates. Once prerequisites merge, update the dependent branch onto latest main and re-run final-head CI/Codex. The owner-alert flow for unresolved architecture decisions and the established same-chat PR lifecycle remain unchanged.

**Diagnostic storage cleanup:** Former scheduled raw endpoint capture is retired in source-authority PR #400; the manual diagnostic workflow is **not** operational. Old database rows/relations are not deleted while the currently deployed SQL still depends on them. POS0e must cut over all live consumer definitions; POS0f must verify no SQL/JS/mirror/test dependency and record an owner-controlled destructive migration/retention plan before actual purge. No compatibility view that silently re-exposes samples.

All assigned coding chats must verify earlier merged PRs against live GitHub:
actual merge SHA, current main code and consumers, executed tests/integration proof,
and remaining gaps. The generated task prompt enforces this inspection and the
dependency/merge gates enforce it again for completion. An old merged badge alone
is not prior-work acceptance.

Only POS0a's **documentation-only architecture audit** is approved to start without
another decision. Every later data/job/SQL/tool PR needs the owner's per-field
source/key/destination/privacy/reader plan sign-off and exclusive file ownership under
AGENTS.md. No paid ERA scope assumptions, new owner credentials, direct production
writes or demo-only acceptance shortcuts. Review [priority-zero task briefs](universal-supervisor-task-briefs.md#priority-zero--finish-all-permitted-toast-standard-api-data-before-e2--pr6pr17).

For owner decisions, the coding agent publishes the exact question on its
existing PR (including an early draft) using `needs-owner-decision` and
`<!-- aicafe-owner-question ... -->`. No coding-agent prompt needs to know
how the existing courier delivers that question. If the current active
execution ends before CI/Codex returns, it resumes in the SAME chat and PR;
a pending Codex verdict never counts as clean.

## Use existing skills, not a giant prompt

- `aicafe-pr-lifecycle`: a coding chat owns one PR from creation through review, CI fixes, rebase and merge.
- `aicafe-dependency-check`: open stacked dependent PRs NOW, reserve file ownership and integrate when the prerequisite changes.
- `aicafe-proof-gate`: actual run/test/CI evidence and post-merge consumer verification; merged does not imply finished.
- Load `gh-fix-ci`, `gh-address-comments`, `receiving-code-review`, `pr`, `verification-before-completion`, `supabase`, `vitest`, `playwright-cli` etc. **only when relevant**. Full list: `docs/rules/skills.md`.

## Copy-paste dispatcher prompt

```text
Use connected GitHub plugin. Read AGENTS.md, PROGRESS.md,
docs/rules/skills.md and the approved queue at
docs/plans/universal-supervisor-queue.json on latest main.
Load aicafe-dependency-check and aicafe-proof-gate from .claude/skills/.
Confirm actual merged commits, executed required tests and on-main integration
before satisfying dependencies. Read docs/rules/pos-data.md; require source_authority_checked: yes and exact diagnostic/current consumer audit in every POS0 PR. PRIORITIZE POS0a then POS0e foundation, then POS0b/c/d, finally POS0f;
do not create new E2/PR6/PR9/PR10 assignments before POS0f integrated proof. Check open PR changed files and file-owner locks.
Assign up to 5 ChatGPT and 2 Claude approved tasks, independent or
stacked NOW on open prerequisite branches (PR base = that branch).
Never confuse opened with mergeable. Advance after real merges and proof;
send a concise task brief + branch/base/owned files/skills to each agent.
Do not invent owner approvals, secrets or live deployment authority.
```

## Copy-paste ChatGPT coding-agent prompt

```text
Use connected GitHub plugin. Implement approved AI CAFE task TASK_ID.
Build toward one proactive universal cafe operator; reuse canonical Toast POS
readers, shared calculations, one AI loop and existing approval/inbox paths.
Read AGENTS.md + PROGRESS.md + docs/rules/pos-data.md from current main, the task in
docs/plans/universal-supervisor-task-briefs.md, current queue and
relevant docs/rules/* and .claude/skills/*/SKILL.md.
Load aicafe-pr-lifecycle, aicafe-dependency-check, aicafe-proof-gate.
Verify predecessor real code and executed acceptance, not its merged label.
Open a DRAFT PR PROMPTLY once authorized: independent = latest main;
dependent on an open PR = branch FROM prerequisite and PR base = that branch.
An unmerged upstream is a merge blocker, not permission to stop coding;
develop and test against its committed branch. Do not invent missing interfaces.
Edit only assigned files. Stay in THIS SAME CHAT for all CI errors,
Codex findings, thread resolutions, fresh reviews and main updates.
Check Codex during this active execution; do not create a background
monitor, cron or polling service. If execution ends, the dispatcher resumes
this SAME PR and chat where it stopped. Never call a pending review clean. If upstream merges, rebase/retarget, verify integration,
rerun relevant tests and obtain new Codex review. Merge only under AGENTS.md.
Show exact test command, run URL, head SHA, outcomes, merged SHA or blocker.
Use targeted Playwright in GitHub CI only for relevant UI/browser changes;
NEVER deploy/build a Vercel preview (owner disabled previews for cost).
Never edit PROGRESS.md inside a coding PR; one coordinator updates it alone
on current main after merge/proof. No production effects.
```

## Dispatcher rules

1. **Read latest GitHub state**, not a stale `PROGRESS.md` checkbox. Task IDs are not GitHub PR numbers; the JSON queue is a proposed immutable DAG, **not** a race-safe live assignment database. Durable file locks, assignment status and webhook dedup must be implemented in the actual dispatcher before six agents run concurrently.
2. Split **can_open** from **can_merge**: all architecture-approved dependent tasks may open draft PRs against an existing prerequisite branch immediately, with exclusive file ownership. They may merge only after predecessors are on main, verified and checks/reviews rerun on latest head. Independent tasks do not wait.
3. When PR A merges during PR B's work, B's owner must discover the merge, incorporate main, check the exact exported contract and usages, retarget its PR to main, rerun applicable checks and request a fresh Codex review. If a ChatGPT turn ended, the owner tells the dispatcher to continue the same PR in the same chat, using GitHub state. Do not create a separate monitoring service and do not claim that a chat can execute indefinitely in the background.
4. For each PR, run base quality checks + **applicable** DB/agent/action tests. Add Playwright and preview/screenshots **only for UI/browser behavior that needs it**; tests proving a merged backend capability in an actual consumer are essential, but not all screens on every commit.
5. Codex review lifecycle: inspect reviews and unresolved threads after each head; fix all P1s and any required findings in-scope, mark truly addressed threads **resolved**, request a fresh Codex review and verify it finished. Resolve merge conflicts then rerun final-head CI and review. Never assert a clean verdict from an unreturned review.
6. **Proof before merge and after:** final-head actual passed checks; required acceptance test executed (not skipped); integration wiring against real predecessor export; PR body links tests, jobs and preview if relevant. If an older merged PR is unproven, create a small repair task tied to that PR's missing capability, don't copy dead/duplicate code downstream.
7. **Progress:** each coding owner records merge SHA/proof in its own PR body/task record but NEVER edits `PROGRESS.md` from a parallel branch. **One coordination writer** makes a separate progress-only update after proven merges on latest main. The existing Repo guard fails PRs mixing `PROGRESS.md` with other files. Historical snapshot remains read-only; no repeated checkbox edits by B/C/D after A merges.
8. **Stop only** for actual owner decision, unapproved architecture, missing secret/provider, forbidden production action, evidence gap or file ownership conflict; keep PR open and send actionable blocker. Unrelated tasks continue. Don't ask the owner to approve ordinary CI fixes already within an approved task.

## PR body completion evidence (short)

```text
Task ID / approved architecture:
Owner journey, source → stored key → reader/tool → permission → outcome:
Dependent PRs / exact shared-file owner:
Changed / deleted / not touched:
Required checks: test name + expected/actual + command + CI run URL + head SHA
Database/effect/integration proof (if applicable):
Targeted UI/browser preview screenshot/trace (if applicable; else N/A):
Codex review status, resolved threads, latest base:
Merged SHA, post-merge integration result, release status:
```

**Completion levels:** `merged` = code landed; `integrated_proven` = actual consumer/owner journey passed; `released_proven` = separately authorized live deployment/pilot passed. Owner has not granted general production permission by approving a planning PR.
