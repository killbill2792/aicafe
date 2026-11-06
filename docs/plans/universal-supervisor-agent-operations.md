# AI CAFE — dispatcher and coding-agent runbook (PROPOSAL)

**Read first:** `AGENTS.md`, `PROGRESS.md`, the binding `docs/rules/*` and `docs/rules/skills.md`. This file is the operational supplement to `universal-supervisor-delivery-queue-2026-11.md` and `universal-supervisor-queue.json`. If rules conflict, `AGENTS.md` wins. No coding before the owner's approval of the infrastructure contract. No actual external business effects/production deployment without separate approval.

## 1. Not one-time green: continuous proof

**A merged PR is not evidence a capability works.** The dispatcher shall check predecessor(s) **before** assigning downstream work:
1. GitHub says `merged:true` with a merge commit on the expected base; compare actual diff and current main, not title/body or a checkbox. If merged but code was superseded/removed, reopen proof.
2. Verify the previous PR's **final head SHA** and its actual completed jobs. Green `AI CAFE PR baseline` is necessary but not sufficient. Inspect each job's steps: which SQL, fixture, eval, and browser acceptance actually **ran**, not skipped. Check later changes to same implementation files for regressions.
3. Check independent evidence: expected test names and exact assertions, direct database query where relevant, run URL/log and reproducible commands; expected source-to-screen parity; preview URL/screenshots/traces for UX; no missing cases. No PR body assertion of `done` can substitute for a check.
4. If any predecessor capability is partially implemented, branch a **small repair PR owned by that previous task** and mark the dependent task `blocked_verification`, or proceed on independent work. Do not build a workaround or duplicate it downstream. Update the queue evidence.
5. Run a final **cross-PR integration check** after each milestone and again at PR17. Completion has three separate states: `merged`, `integrated_proven`, `released_proven`. Only the last is live.
6. Failure/timeout/skip/empty artifacts/unverified preview = **not proven**. A skipped optional check can remain optional only if the acceptance contract explicitly marks it optional.

**Current factual limitation:** `.github/workflows/ai-cafe-pr-baseline.yml` (Nov 5) checks type, lint, full Vitest, build, guards, disposable DB and recorded Supervisor eval; the `e2e` path output exists but no Playwright execution job is in the baseline's `needs` list. `scripts/guards/run-all.mjs` runs local .mjs guards; it is not a capability-level proof verifier. E2 must add a real protected E2E check and proof validation, not merely an additional markdown promise.

## 2. Machine dispatcher: one polling/webhook cycle

1. Read current `AGENTS.md`, `PROGRESS.md`, architecture plan and queue file **from main**; verify the plan has merged. Do not dispatch from an unmerged proposal.
2. Refresh actual PR states/commits/check runs/reviews/migrations, allocated agent slots and exclusive file locks. If any record disagrees with GitHub, GitHub wins for merges and checks; tests and preview evidence separately establish completion.
3. Validate queue schema: unique IDs, existing dependencies, no self/cyclic edges, all intended tasks accounted for, accepted architecture version and non-empty acceptance criteria. Normalize milestones vs real GitHub PR numbers; never confuse PR13 milestone with GitHub issue/PR #13.
4. Each task's `requirements_satisfied` is TRUE only if: architecture approved, its exact brief/evidence accepted, owned paths resolved from main, safety/credential constraints resolved, and required predecessor *capabilities* independently proven. **For a stacked draft** its predecessor may still be open with an approved contract and stable branch; it may CODE early but **cannot merge** until predecessor merged and integrated-proven.
5. Build the ready frontier from tasks. Lock task+owned files atomically (lease ID + agent assignment). Reject conflicting ownership, different migration numbers, or overlapping shared-schema/tool-registry changes unless one common foundation owner is assigned. For incompatible tasks, serialize or stack explicitly. NEVER have two agents cherry-pick shared code without an owner.
6. Fill up to **four ChatGPT** and **two Claude** active agent slots (maximum 6, not a requirement to open 6). First use independent ready items, then safely stacked dependencies. Prioritize critical foundation/E2 gates. A blocked slot may be reassigned after state is durably recorded.
7. Coding agent owns one implementation PR from draft to merge in its **same chat/session**; never start a replacement conversation on its next CI/Codex failure. Agent may rerun tests and edit owned files. Model selection is based on owner's routing policy and task difficulty, not on an assumed magical provider capability.
8. Publish real PR branch, base and URL back to queue. On merge webhook verify merge SHA, run predecessor acceptance audit, mark `integrated_proven` only after actual evidence, update children branches and refill available slots. Dedup webhook events by task ID + merged SHA.
9. Never silently modify `AGENTS.md`, production flags/secrets, privileged approval scopes, real customer/staff/vendor accounts, bank or POS. A changed product decision is an explicit architecture gate, not an AI-generated approval.

**Recommended initial frontier AFTER owner approval and exact file lock review:** E2, PR6, PR9, PR10 (four independent foundation tracks at the high level). PR7 and PR16b can be opened as **stacked drafts** on PR6 if their **owned files do not overlap**. PR16a can similarly stack on PR10. PR11 waits for PR10's auth contract and can stack on its branch. PR8a/8b/8c can start in parallel after PR7 code stabilizes, each with its own domain file ownership. These are candidate lanes, NOT proof of zero conflicts; a dispatcher must run the live file-overlap check before choosing slots.

## 3. Copy-paste dispatcher prompt (short)

```text
You are the AI CAFE PR dispatcher. Read AGENTS.md, PROGRESS.md, docs/rules/skills.md,
docs/plans/universal-supervisor-delivery-queue-2026-11.md,
docs/plans/universal-supervisor-queue.json, and
docs/plans/universal-supervisor-agent-operations.md from latest main.
Treat AGENTS.md as highest authority. Do not implement code yourself.
Verify GitHub merge SHA, final-head CI/Codex, mandatory test executions and
preview artifacts for every predecessor; merged != proven. Fix unproven
predecessors before declaring dependencies complete. Inspect open PR file
ownership. Fill up to 4 ChatGPT + 2 Claude slots with independent/valid
stacked small PRs. Assign one chat per PR through merge. Never infer an
architecture approval, source credentials or production rollout permission.
Output: ready frontier, assigned agent, exact branch/base/owned paths,
dependencies, proof gaps, blocked tasks and next dispatch actions.
```

## 4. Copy-paste coding agent prompt (short; substitute TASK_ID)

```text
Implement AI CAFE task TASK_ID from the owner-approved queue on main.
Read AGENTS.md and PROGRESS.md FIRST; read all relevant docs/rules/*
and listed .claude/skills/*/SKILL.md. Read the task's approved
architecture/fields, deps, file ownership, exclusions and proof tests from
docs/plans/universal-supervisor-delivery-queue-2026-11.md and
docs/plans/universal-supervisor-queue.json.
VERIFY predecessor code + final-head CI, DB/E2E evidence and preview;
a merged checkbox is not proof. Don't create duplicate paths or weaken tests.
Branch from latest main if independent; otherwise open a STACKED draft PR
NOW with base = predecessor branch. Edit only owned files. Include plain
words: trigger → data source → key/storage → tool → approval → effect →
verified receipt/report, plus what may fail. Run specified tests on disposable
seeded cafés, including browser preview if required; attach actual CI run
links, screenshot/trace, test results and failure proof to PR body.
Keep this SAME chat on all CI/Codex fixes and rebases until merged under
AGENTS.md. Do not claim completion for skipped or unrun checks; do not
deploy or touch production without explicit owner authorization.
```

## 5. Required task brief template (one per child PR)

```text
TASK_ID:
OWNER JOURNEY / DELIVERABLE:
ARCHITECTURE APPROVAL (link/version):
DEPENDENCIES (task ID → exact PR/merge SHA → integrated proof):
CAN START IN PARALLEL WITH: [IDs, after no-overlap check]
BRANCH BASE: main OR active prerequisite branch (exact)
FILE OWNER: owned exact paths/globs after verification; exclude everything else
SOURCES / DATA: provider fields; one record/key/update/history/exclusions/retention;
                source variation, RLS, freshness, screens sharing the truth
RUN: trigger, step sequence, bounded reasoning, lease/timeout/retry, result
AUTHORIZATION: individual or pre-granted mandate; owner/café/action scope
EFFECTS: safe no-write default, auditable actual action, receipt and undo/uncertain
MANDATORY TESTS: exact test file + assertion + executed job URL (not "will test")
E2E PREVIEW: preview URL + browser steps + 390px/desktop screenshots/traces OR
             explicit reviewed exemption (no UI)
PROOF OF PARENT: previous task's final-head checks + integrated outcome
DONE WHEN: all mandatory acceptance passed; no skipped required job; Codex clean;
           current base; merged SHA; next integration test passed
ROLLBACK / OPEN GAPS:
```

## 6. Mandatory end-to-end test matrix by change type

| Change | Mandatory proof |
|---|---|
| Database/schema/queries | On migrated disposable Supabase: SQL asserts, RLS isolation of two cafés, duplicate/import/update/incomplete facts, representative source drift, screen/tool totals where applicable; exact job and test step |
| Worker/routine/memory | Claim/race, lease death/restart, resume, dedup, budget, timezone/DST, owner offline, trigger catch-up, scoped memory expiry/forget; persisted rows and final report |
| Approval/mandate | No effect without approval, fresh phone step-up bound to exact scope, replay/expiry, revoke during plan/run, spending/recipient ceiling, cross-owner denial and receipt |
| Connector/file/browser | Fixture with prompt injection, OAuth refresh/revoke, missing permission, rate limit, unsupported portal, uncertain send, retry without duplication, source receipts, no leaked secrets |
| Staffing/procurement/maintenance | Full owner journey, independent money/record parity, error and missing-data cases, real state transitions and acceptance/delivery evidence; no mock result stated as real completion |
| UI | Seeded preview authenticated browser, desktop and ~390px mobile, screenshots and trace, one owner approval flow, error/retry/empty, accessibility; preview isolation verified |
| Cross-domain/release | Supervisor proactively detects, prioritizes, performs a permitted work plan, waits for unauthorized effects, verifies receipts, learns/follows up, survives multi-day faults; real data only with owner-approved pilot |

**Every capability PR gets a regression on its public interface**, even when its visible output is only a chat tool. A `build` green result is not a substitute for the associated owner journey.

## 7. GitHub check and preview policy

- The **required baseline** must still pass on the final PR head, with TypeScript, lint, full Vitest, build, repo guards, required disposable DB tests and matching recorded evals.
- **E2 must wire an executable browser job** into branch protection and make relevant Playwright scenarios run, with trace/screenshots artifacts; don't count a path filter alone or `skipped` test. Functional changes to the execution/permission domains must trigger their E2E, not only changes to `tests/e2e/**`.
- Require a **proof manifest** for each PR: exact test/acceptance ID, expected assertions, CI job conclusion and URL for head SHA, executed vs skipped, preview URL and artifacts if needed, predecessor merge+proof SHA. A repo guard or CI job may validate this but must verify GitHub actual results where necessary; text in PR description alone is insufficient.
- A GitHub/Vercel **preview is a deployment**, not merely a screenshot. Confirm existing Vercel preview integration and isolated credentials rather than inventing a URL. Run browser tests against preview only when authenticated seeded test data exists, no production writes possible, and secrets are segregated. Preview can be green but release remains blocked until live acceptance is separately approved.
- After predecessor merge: inspect new `main` state; rebase the dependent branch, rerun all required checks + fresh Codex review. Source changes since predecessor proof require regression re-verification.
- Never mark PR17 released solely on GitHub CI green. Record authorized real-café pilot evidence and a reversible release plan; if no owner authorization, mark code complete but **not live**.

## 8. Skills per task (explicit loading; not auto-assumed in ChatGPT)

| Queue IDs | Read applicable skills in `.claude/skills/` |
|---|---|
| E2, 16*, 17* | `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `gh-fix-ci`, `pr` |
| 6, 7, 8*, 9, 10, 13*, 14*, 15* | `supabase`, `supabase-postgres-best-practices`, `vitest`, `two-axis-code-review`, `pr` where changing DB |
| 10, 11, 12, 13b, 13d, 14c, 14e, 15d, 16a | `testing-api-security-with-owasp-top-10`, `exploiting-idor-vulnerabilities`, `supabase` |
| 11, 12, 14c, 16c | `playwright-cli` if browser tested; `context-engineering`, `incremental-implementation`, `pr` |
| Any failed CI/review | `gh-fix-ci`, `gh-address-comments`; any PR `pr`, `two-axis-code-review`, `handoff` if blocked |

Check `docs/rules/skills.md` for exact current applicability and file names; do not assume a skill silently executes a test.

## 9. Defect handback and "ChatGPT said done" defense

- Agent's words `done`, green text, unchecked skipped jobs, or a merged checkbox **never change a capability to proven**.
- If the checker finds missing behavior after a merge, create a repair task linked to the original task, with exact failing acceptance. Do not claim downstream dependencies satisfied, and do not patch fixtures or remove tests to make green.
- The checker is an **independent verification process**, not a second reviewer LLM in the production Supervisor. It should use deterministic CI results, actual PR diffs and test artifacts. The Codex review remains an additional gate, never the only proof.
- Keep a durable queue ledger of assignments, branch/head/base, predecessor evidence, file locks, check URLs, screenshots, migrations, merged SHA, preview status, pilot authorization; the proposed static JSON is a plan **not a race-safe mutable job store**. Implement a transactional dispatcher state store before allowing concurrent webhook-driven agents, to prevent double assignment.
