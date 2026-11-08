# AI CAFE — coding-agent operations (short, owner-review draft)

**Required first read, in order:** latest main `AGENTS.md` (and `PROGRESS.md` as read-only status) → [binding POS rules](../rules/pos-data.md) for POS tasks → #398 latest audit/spec head while draft → the **one assigned** [task brief](universal-supervisor-task-briefs.md) and [machine queue](universal-supervisor-queue.json) with approval/ownership checks → current implementation/active SQL → [executable tests](../rules/tests.md). Read applicable `.claude/skills/*/SKILL.md` and topic-specific rules; consult this operations guide and [delivery plan](universal-supervisor-delivery-queue-2026-11.md) for lifecycle/context, **not** as an additional approval source or repeated mandatory prompt. Use connected GitHub evidence for current commits, owner conversation comments, review threads and CI; reconcile every actionable comment in the same PR's **Comment disposition** checklist before claiming completion. Do not assume continuous background work, skill auto-loading or live production access.

## Current dispatch order — POS0 before PR6

**First-read execution sequence, not a new authority:** read latest `AGENTS.md` (+ `PROGRESS.md` as read-only status) → `docs/rules/pos-data.md` → #398 [Start here, D1–D3 and discrepancy register](toast-standard-api-coverage-matrix.md#start-here--durable-agent-handoff-and-conflicts-index-2026-11-07) → *both* assigned task brief and machine queue (owner approval remains false for POS0b–f) → inspect actual code + deployed SQL → run `docs/rules/tests.md` acceptance and report the CI link. Direct and indirect reader/status/tenant history must be listed, as must known defects and unapproved work. This ordering is required in generated ChatGPT/Claude handoffs and tests; historical pilot runbooks and immutable old migrations do not override it. Dedicated SQL importer row-error recovery ownership is **unassigned pending separate owner-approved file/PR scope**, while POS0d owns catalog snapshots, POS0e the active diagnostic reader and metadata cutover, POS0f final migrated DB lineage.

**Current mandatory first-read contract for all POS0 coding tasks:** [docs/rules/pos-data.md](../rules/pos-data.md). It is the single authoritative classification of OPERATIONAL_CURRENT (`toast_raw_records`), OPERATIONAL_CHANGE_LOG (`toast_raw_changes`), LEGACY_DIAGNOSTIC_ONLY (`toast_raw_samples`), TEST_FIXTURE_ONLY, existing source writers/readers, naming, no fallback, safe retirement, and real source-to-Supervisor proof. Code/migrations/fixtures with contradictory comments **do not override it**. The generated ChatGPT/Claude coding handoff explicitly requires `source_authority_checked: yes` in every POS0 PR and actual consumer inspection.

**Owner D4A/D4B reconciliation (architecture only):** Use the single #398 decision card and binding `docs/rules/pos-data.md`, not a second owner prompt. The approach is family-specific change-driven synchronization plus bounded automatic reconciliation using the existing 10-minute coordinator and separate 15-minute live read. DB-only malformed-order recovery must preserve existing #189/#203/#264/#297 lease/backfill/fairness/payment-gap and generation-bound cost queue. `POS0-order-recovery` is a **proposed, non-dispatchable future implementation owner** until SQL design/exclusive files receive separate owner sign-off; no new scheduler, queue or runtime edits authorized in #398/#400.

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

## One current dispatch/handoff path — no standalone copy-paste prompts

**The only executable coding-agent prompt** comes from the existing deterministic `scripts/dev-dispatcher/run.mjs` → `scripts/dev-dispatcher/delivery.mjs#createDelivery`, supplied with an **approved** task from `docs/plans/universal-supervisor-queue.json` and its exact `docs/plans/universal-supervisor-task-briefs.md` anchor. It includes the D1–D4A/D4B contract by first-read links, real predecessor SHA, exclusive files, acceptance and owner hold. The bridge resumes the same saved chat/PR; never manually replace or concatenate prompts. The former dispatcher and coding-agent copy-paste examples were **superseded and removed from this CURRENT operations page** (their history remains in Git) because those duplicated instructions and could omit owner decisions.

**Agent setup/preflight, not a prompt:** current main `AGENTS.md` and `PROGRESS.md` (read-only) → binding `docs/rules/pos-data.md` → latest #398 "Start here" architecture decision record (including approved D4A/B and unresolved D4B SQL mechanism) → assigned brief **AND** queue with `architecture_foundation_implementation_approval.approved=false` until separate owner signoff → inspect current code and deployed SQL → actually execute `docs/rules/tests.md` acceptance. When #398 remains draft, a reviewer reads the actual PR head, but cannot use an absent on-main file to bypass the owner gate.

**Dispatch safety:** Do not send a task whose exact file scope or owner approval is missing, change the saved task approval signature during an existing assignment, create a separate `POS0-order-recovery` task, or activate implementation because D4A/B principles were approved. Only a separate authenticated owner decision after approved SQL design and file/PR ownership can authorize that future work. Any manual emergency workaround must first resolve the source/approval discrepancy; no independently authored alternate coding prompt.

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
