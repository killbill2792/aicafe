# AI CAFE — coding-agent operations (short, owner-review draft)

**Required reading for every agent:** latest main `AGENTS.md`, `PROGRESS.md`, relevant `docs/rules/*`, [task queue](universal-supervisor-queue.json) and one [task brief](universal-supervisor-task-briefs.md#task-6). Use the **connected GitHub plugin** to fetch actual files, PRs, commits, CI/check logs, Codex reviews, comments and thread resolution; explicitly read applicable `.claude/skills/*/SKILL.md` from GitHub. Do not assume a cloud shell, uninterrupted waiting, skill auto-loading or live production access.

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
before satisfying dependencies. Check open PR changed files and file-owner locks.
Assign up to 4 ChatGPT and 2 Claude approved tasks, independent or
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
Read AGENTS.md + PROGRESS.md from current main, the task in
docs/plans/universal-supervisor-task-briefs.md, current queue and
relevant docs/rules/* and .claude/skills/*/SKILL.md.
Load aicafe-pr-lifecycle, aicafe-dependency-check, aicafe-proof-gate.
Verify predecessor real code and executed acceptance, not its merged label.
Open draft PR immediately: independent = latest main; dependent on an
open PR = branch FROM prerequisite and PR base = prerequisite branch.
Edit only assigned files. Stay in THIS SAME CHAT for all CI errors,
Codex findings, thread resolutions, fresh reviews and main updates.
Check Codex during this active execution; do not create a background
monitor, cron or polling service. If execution ends, the dispatcher resumes
this SAME PR and chat where it stopped. Never call a pending review clean. If upstream merges, rebase/retarget, verify integration,
rerun relevant tests and obtain new Codex review. Merge only under AGENTS.md.
Show exact test command, run URL, head SHA, outcomes, merged SHA or blocker.
Use targeted Playwright only for relevant UI/browser changes. No production effects.
```

## Dispatcher rules

1. **Read latest GitHub state**, not a stale `PROGRESS.md` checkbox. Task IDs are not GitHub PR numbers; the JSON queue is a proposed immutable DAG, **not** a race-safe live assignment database. Durable file locks, assignment status and webhook dedup must be implemented in the actual dispatcher before six agents run concurrently.
2. Split **can_open** from **can_merge**: all architecture-approved dependent tasks may open draft PRs against an existing prerequisite branch immediately, with exclusive file ownership. They may merge only after predecessors are on main, verified and checks/reviews rerun on latest head. Independent tasks do not wait.
3. When PR A merges during PR B's work, B's owner must discover the merge, incorporate main, check the exact exported contract and usages, retarget its PR to main, rerun applicable checks and request a fresh Codex review. If a ChatGPT turn ended, the owner tells the dispatcher to continue the same PR in the same chat, using GitHub state. Do not create a separate monitoring service and do not claim that a chat can execute indefinitely in the background.
4. For each PR, run base quality checks + **applicable** DB/agent/action tests. Add Playwright and preview/screenshots **only for UI/browser behavior that needs it**; tests proving a merged backend capability in an actual consumer are essential, but not all screens on every commit.
5. Codex review lifecycle: inspect reviews and unresolved threads after each head; fix all P1s and any required findings in-scope, mark truly addressed threads **resolved**, request a fresh Codex review and verify it finished. Resolve merge conflicts then rerun final-head CI and review. Never assert a clean verdict from an unreturned review.
6. **Proof before merge and after:** final-head actual passed checks; required acceptance test executed (not skipped); integration wiring against real predecessor export; PR body links tests, jobs and preview if relevant. If an older merged PR is unproven, create a small repair task tied to that PR's missing capability, don't copy dead/duplicate code downstream.
7. **Progress:** each owner records actual merged SHA/proof in task ledger; **one coordination writer** updates short `PROGRESS.md` on latest main. Historical snapshot remains in `docs/history/` and isn't treated as active queue. No four concurrent full-file PROGRESS overwrites.
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
