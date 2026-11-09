# Café Operator — agent instructions (single source of truth; CLAUDE.md only points here)

Read this file fully before any task. If any other doc, PROGRESS entry, PR description or code comment
conflicts with it, THIS FILE WINS. Docs marked "historical" or "background" in `docs/README.md` are not
instructions. If a rule here blocks the task you were given, stop and ask the owner. Never work around it.

## What AI Cafe is (read this first)
1. AI Cafe is an AI operator for independent café owners.
2. At its core is Supervisor: one universal agent for the café, in one chat.
3. Supervisor answers anything from all stored café data: POS sales and orders, staff and schedules,
   costs and bills, stock, events, experiments, and the owner's own inputs.
4. Its numbers come from that data and the one `calculate` tool, labelled actual, estimate or incomplete.
5. It acts proactively: it watches the café and tells the owner about problems and chances, with a next step.
6. It finishes tasks end to end: it drafts, the owner says yes, it does the work, monitors it and reports back.
7. Nothing with an effect happens without the owner's yes.
8. The chat and every screen show the same numbers from the same code.
9. Answers are short and plain: café owners are busy and many are not technical.
10. It is a web app first, for phone and desktop browsers; WhatsApp carries the brief and short replies.

## Standing rules from the owner (every agent: Claude, ChatGPT, Codex, Grok and any future agent)
Where an older line in this file conflicts with these rules, these rules win.
1. **Product first.** Read "What AI Cafe is" above before any task, and build toward it.
2. **The owner is the builder.** The owner's product decisions are final. You may push back once, with
   evidence and a better option. Then build what the owner chose. No refusing and no re-arguing.
3. **Architecture first for all infrastructure** (data, APIs, jobs, crons, approvals, tools, connectors).
   Before coding, write down: what the source really sends, field by field; one record per object and
   its key; what happens when it changes; which table it goes to; what is not kept and why; gaps; and
   how the source may differ between cafés. Get the owner's approval, then build.
4. **One path per capability.** Before adding code, find the existing path that already does the job and
   extend it. Never add a second path to get the same data or do the same job. If a new path replaces
   an old one, the PR says so, and the old one is deleted in the same PR or in a named follow-up
   deletion PR.
5. **No hardcoding.** No hardcoded currency (such as USD), café names, IDs, time zones, dates, prices, or
   values that only make a test or scenario pass. Read them from settings or data. Tests check real
   behavior on realistic data, and the PR states how each acceptance test proves it.
6. **English only for now.** Do not add or update Spanish or Arabic strings or translation logic until the
   owner says so (new strings go in `messages/en.json` only). Do not break the existing ones.
7. **Parallel and dependent PRs open now.** Once a task and its source/file scope are approved,
   open an EARLY DRAFT PR promptly, independent or dependent, even while implementation is incomplete.
   Never tell a chat "blocked until X merges" or "start only after X merges" as a reason to avoid
   authorized work. Independent PRs branch from the latest `main`. If PR B depends on open
   PR A, open B with **base = A's branch (not `main`)**; keep B's code ready and its CI green on that
   base. **B merges only after A is on `main`.** Then rebase B onto (or retarget B to) the latest
   `main`, re-run CI and Codex review, re-check migration numbers, and list any other open PRs that
   touch the same files. Merge only under the auto-merge rule.
8. **Merge readiness.** A PR is mergeable only when CI is green, the Codex review is clean (or every comment
   is fixed and re-reviewed), it is rebased on current main, and the PR body says what changed, what was
   deleted and what was not touched.
8a. **Never lose a PR or owner comment.** In the **same existing PR description**, maintain one
   **Comment disposition** checklist keyed by original GitHub issue-comment ID or
   inline review-thread ID. Include new owner decisions, requested repairs, Codex
   findings and follow-ups even if posted after the last commit. Each item records
   responsible file/task, state (`acknowledged`, `working`, `blocked—owner decision`,
   `fixed—awaiting proof`, `verified`, or `superseded`) and an exact commit +
   executed test/CI reference, or an explicit blocker/superseding comment. Re-read
   the full PR conversation and review threads before editing, after substantive
   changes and before reporting done; account for every actionable ID exactly once.
   A reply, resolved thread, clean Codex review or checkbox alone is **not** proof.
   Resolve inline threads only after actual fixes are verified. Never silently
   infer approval. This uses the existing GitHub/dispatcher workflow and is **not**
   a new task queue, agent, approval system or documentation authority.
9. **No silent data loss.** Every save records success or failure. Failures retry automatically with
   backoff and stay visible in the health check until they are recovered. The owner is never asked to
   fix data.
10. **Screen and chat match.** Supervisor's numbers come from the same shared calculations as the app
    screens (`lib/metrics/core`), never a formula the model invents.
11. **Proactive by default.** Every feature says how Supervisor brings it to the owner without being asked.
12. **The database aggregates.** Supervisor reads small summaries built in the database, not raw rows, to
    keep tokens low.
13. **Proof, not claims.** The PR body matches the diff, and "done" means verified on real café data, not
    only on fixtures.
14. **Read before you build, update after.** Every task starts by reading AGENTS.md and PROGRESS.md.
    **One coordination owner** updates PROGRESS.md after a PR actually merges and integration proof
    is checked, in a dedicated progress-only change against latest main. Coding/stacked PRs must
    NEVER edit or re-check shared PROGRESS.md checkboxes, even after their predecessor merges;
    instead record actual merge SHA, test/CI job and missing proof in their own PR body/task record.
    The repo guard blocks simultaneous feature+PROGRESS changes; live GitHub state always wins.
15. **Plan before the PR, with the owner.** Before any PR that adds or changes data, jobs, crons, tools or
    connectors starts coding, present the owner a short plain-words plan: where the data comes from
    (field by field), what is saved, where and under what key, who reads it, what Supervisor says or
    does from it, and the gaps. The owner reviews it and may propose a simpler way. Coding starts only
    after the owner agrees. The PR body then repeats the agreed plan.
16. **Parallel PR waves.** We ship in days with several PR chats at once. Before a wave starts, the plan
    lists each PR, the files and tables it owns, and the shared pieces it uses or adds (connectors,
    settings, views, tools). Shared pieces are built once in a small foundation PR that merges first;
    dependent PRs open now against that foundation branch, reuse its work, and keep their own CI green.
    If two PRs need the same file, assign the overlap to one owner or the foundation PR; do not hold
    the other PR unopened. Open it against the owning PR's branch instead. Independent PRs use latest
    `main`. After each prerequisite merges, update the dependent PR onto latest `main`, switch to
    merged shared pieces, take the next free migration number, and re-run CI and Codex. Only merge when
    its prerequisites are on `main` and all checks are green under the auto-merge rule.
17. **End-to-end testing.** "Done" means every acceptance scenario was tested end to end on the real app
    and real café data (chat answer, screen, stored rows, scheduled job), not only unit tests or a few
    happy paths. The PR lists each scenario with pass or fail. Partial passes are not done. Keep CI fast:
    if a check gets slow or flaky, fix it or split it rather than waiting.
18. **Use an existing skill first.** Before building anything, check for an official Anthropic/OpenAI skill or a repository skill that already does the job; reuse it instead of rebuilding it.
    The list, with pinned sources and the AI Cafe rules for each, is `docs/rules/skills.md`; Claude Code
    loads them from `.claude/skills/`, other agents open a skill's `SKILL.md` by path.
19. **One coding chat and PR lifecycle.** Each authorized ChatGPT or Claude task opens its own draft
    promptly, continues working in that same PR/chat through executable CI, actual Codex review,
    required fixes, resolved threads and fresh final-head review, then completes the proven merge.
    Do not claim a Codex review of an empty early draft proves the final implementation. Do not
    start a background polling loop or invent uninterrupted cloud execution; after a chat ends,
    the existing dispatcher resumes it at the saved GitHub head. Explicit owner questions must
    be published on the same PR, including drafts, not left waiting in an invisible chat.
20. **No Vercel preview deployments/builds.** Vercel previews are disabled by owner decision for
    cost. Never enable automatic or manual Vercel preview builds for PRs, E2, or UI acceptance.
    When browser proof is needed, run the app in GitHub Actions with disposable test data and
    targeted Playwright; save execution proof there, without a Vercel deployment.

## POS0 architecture review merge hold — explicit owner release only

**Owner decision (November 7):** PR #398 (Toast source-to-Supervisor architecture contract) and PR #400 (diagnostic-source rules/guards) **remain DRAFT / DO NOT MERGE** until the owner explicitly approves the final architecture specification and its enforcement. This is a specific exception to the ordinary CI-green/Codex-clean auto-merge rule: **never mark either PR ready, invoke merge or enable auto-merge because tests pass**. Apply the same owner confirmation gate to POS0b–POS0f implementations; the earlier high-level architecture decisions are **not** authorization to code new runtime paths or apply production migrations. The queue's existing `architecture_foundation_implementation_approval` remains `approved=false` until evidence and the authenticated owner review comment are supplied. Keep #399's already-merged owner-question/approval machinery unchanged. **November 8 sequencing:** existing issue/queue tracking is not permission to DELIVER coding instructions; the owner alone switches on coding dispatch after #398's completed read-only source audit, #399's merged trusted transport, #400's documentation closeout and final architecture review. The existing foundation gate stays false. POS0a may finish its already authorized read-only work; do not dispatch POS0b–POS0f, or add automatic comment harvesting/merge gates, before a separate explicit owner release. Manual same-PR comment dispositions are sufficient for this phase.

## Mandatory source-authority preflight (all POS/Toast/AI data contributors)

**Mandatory actual first-read sequence for every newly assigned POS0a–f developer (ChatGPT, Claude and future agents):** (1) `AGENTS.md` and read-only `PROGRESS.md`; (2) [binding `docs/rules/pos-data.md`](docs/rules/pos-data.md); (3) [#398 concise POS0a handoff](docs/plans/toast-standard-api-coverage-matrix.md#pos0a-handoff--read-this-card-before-large-evidence-tables-2026-11-08) FIRST (verified retrievable on #398 draft head), then relevant field evidence and draft specs only; #398's official A1 schema/GET/nested-field definition is pinned; café-specific A2 grants/observations and A4 live reader/registered-Supervisor implementation remain explicitly unproven and assigned later; (4) task-specific [brief](docs/plans/universal-supervisor-task-briefs.md) **AND** [machine queue](docs/plans/universal-supervisor-queue.json), checking task/PR ownership and `architecture_foundation_implementation_approval.approved=false`; (5) actual main/owned branch code and **active database functions/views** (not old migrations); (6) [executed acceptance requirements](docs/rules/tests.md) and immutable CI evidence. Read `docs/README.md` for historical routing, **not** as a competing instruction source. **While #398/#400 are both draft, the #398 matrix is not yet available on main:** for architecture review read the concise POS0a handoff and targeted field sections at PR #398's latest exact draft head; if those sections cannot be retrieved, record the #398 handoff blocker and STOP at the owner gate, not a claim of field coverage or permission to begin POS0b–f runtime work. In the first PR/body, identify correct retained current behavior, defective deployed paths and why, exact later owner, all direct/indirect readers, one-café isolation and missing signoff before editing. Do not silently choose the old PR1/pilot paths; do not turn a 10-minute tick into a guaranteed 10-minute fetch of every API.

**D1/D2/D3/D4A/D4B/D4C APPROVED only as architectural principles (including D3 preservation):** zero removal/replacement of existing storage, readers or behavior without full consumer inventory and correctness/completeness/p95 cost/café isolation/rollback proof. **Current defects to trace:** diagnostic-backed active SQL readers (`toast_records_for`, `cv_cash`, `cv_inventory`, `cv_kitchen`, `cv_dining_options`), generated canonical dictionary's historical daily-capture description, `seen_run_id` still used despite historic retirement plan, order SQL-day rollback risk, **liveArchive.server.ts archive RPC errors that log and stop remaining pages without durable retry**, menu two-fetch/absent-item retirement risk, unknown wages. **POS0e** owns first shared reader/dictionary cutover; **POS0b** labor; **POS0c** operational cash/stock/kitchen; **POS0d** menus; **POS0f** final migrated SQL + actual one-agent/screen proof. The dedicated **order-import SQL failure recovery** PR has **no owner-approved number/exclusive paths**: mark blocked for a real owner assignment, do not claim POS0d or POS0e automatically owns rewriting it. Current parser's per-order protection and current indexed projections are to be preserved. No PR 398/400 final approval, merge or migration is implied.


**D4A/D4B owner decisions (November 7):** D4A selects **Approach B**, change-driven Toast family checks with automatic reconciliation within the existing 10-minute coordinator and distinct 15-minute live-order collection. No blanket full API re-download every tick, webhook-only logic or new scheduler. D4B **Approach 1 is owner-approved** ([#398](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6727889494)): repair the EXISTING day-import, live-archive and bounded retry/recovery pipeline, preserving valid committed facts; **reject a separate Approach 2 order-ingestion system**. Exact SQL transaction/savepoint, page retry, scheduling priority and migration/file scope remain **unapproved**. Preserve #189 nonce leases/cursors/429/generation cost queue; #203 backfill priority, five-day pacing and fairness; #264 timeout/fee-gap progress; #297 five-date, 1h→24h recovery. The 77 due cost-refresh jobs with zero attempts are a **separate unresolved diagnostic**, not lost-order proof. Proposed later owner `POS0-order-recovery` is NOT dispatchable and has no approved file/SQL scope. Details in [existing #398 D4 architecture](docs/plans/toast-standard-api-coverage-matrix.md#d4ad4b-approved-architecture-outcome--no-runtime-approval-nov-7); binding rules below. **Both PRs stay draft and downstream implementation approval remains false.**

**Granular D4B owner addendum (same approval boundary):** A DB-failing/poison order cannot make other **validated and durably saved** orders unusable: `lib/data/toastDayTrust.server.ts` already keeps stored rows available; `lib/calc/toastOwnerDay.ts` appropriately withholds **uncertified whole-day totals**. Supervisor and screens must show independent record facts with source/as-of evidence and mark only **affected metrics** partial. Preserve last certified snapshot as historical-as-of, never current. Known-order sums are **not** guaranteed final totals, lower bounds or estimates because adjustments/refunds can be negative. Automatic recovery is an **owner priority to finish** and bounded; distinguish per-row SQL failures, provider/auth/429, whole DB outage and permanent upstream defects. Exact B1 transaction isolation and priority scheduling are NOT approved. `toast_rollup_refresh_jobs` remains a separate derivative queue; ACK `false` must not be counted as success, and superseded generation must be distinguished. Details remain in #398 D4 and binding POS rules; do not send a new coding prompt.

**D4C owner-approved menu lifecycle (November 7; architecture ONLY):** [#398 decision](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6714937954) confirms **D4A's existing change-driven metadata/version checks**, never a full menu download every 10-minute tick. A confirmed **complete, authenticated, restaurant- and version-consistent published-menu snapshot** may mark vanished Toast items, modifiers and provider relationships **inactive**, not hard-delete; republishing the **same GUID** restores provider-publication state without duplication or overwriting owner recipes/ingredients. Keep historical order/line/size/modifier identities, names/prices/versions, owner changes and sales forever queryable. Empty/partial/malformed/unauthorized/lagging/wrong-version/wrong-restaurant/reference-incomplete snapshots, historical size ambiguity and zero sales **cannot** deactivate a last-good item or relationship; record freshness and retry safely. Permanent deletion needs explicit owner approval and dependency/history proof, never erased transactions. **POS0d** is proposed for implementation and **POS0f** for migrated-db + one-agent/screen proof, but exact SQL/files, single-snapshot refactor and downstream code authorization remain unapproved. PR #398/#400 stay DRAFT; approval gate false.

**November 8 D4C clarification ([owner decision](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6727792294); no code authorization):** Verified connected-café **current Menu and Supervisor** must use exactly ONE authenticated, complete, restaurant/version-consistent Toast published catalog for current names, groups, size/option GUIDs, prices and active state; show known recipe costs or explicitly missing, never infer COGS from selling price. **Newest D4C owner supersession [#398 6727941284](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6727941284): connected cafés have NO legacy Owner review tab, NO local Add Item/draft product.** Prior local test entries stay hidden from Menu/pricing and held in storage only for D3 historical/FK safeguards pending separately approved cleanup. Create products or change Toast-owned name/size/price in Toast Web then sync through existing version checks; owner may enrich ingredients, recipes, quantities and ingredient costs ONLY on verified Toast-linked items in AI CAFE. Toast Menus API is read-only. Disconnected/manual cafés keep their manual/CSV flow. Associate owner recipes only by reliable, reversible café+product+size proof. The 563 Aug–Sep historical lines are valid saved sales but unresolved historic variant/recipe links, **not missing sales or current publication**; do not reimport, guess by name/price, or silently invent COGS. The owner **APPROVED historical Option B evidence-first reconciliation** in [#398 comment 6727833986](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6727833986), distinct from current Menu's Option A auto-recipe links: use original same-café/restaurant Toast and old modifier/size GUIDs, dated menu/recipe/version or verified owner evidence; only unique auditable reversible identity matches may auto-link, ambiguous old variants stay grouped in Owner review with partial COGS. SQL/matching thresholds/migration/rollback and code ownership remain UNAPPROVED. POS0e owns shared reader; POS0d the later catalog/Menu implementation; POS0f final migrated-DB/Menu/Supervisor/tenant/history proof.

**One binding operational entry point:** [docs/rules/pos-data.md](docs/rules/pos-data.md) is the authoritative, current file/table classification and data-lineage contract for Toast/POS. Read it **before** implementation, SQL view edits, field discovery, tests, mirror jobs or PR review. Do not infer authority from a name such as `raw`, `sample`, `canonical` or from a historical migration/test that happens to pass. The current [POS0a field audit](docs/plans/toast-standard-api-coverage-matrix.md) documents actual gaps; [POS0b–POS0f briefs](docs/plans/universal-supervisor-task-briefs.md) own remediation. When an old doc, fixture or comment suggests diagnostic Toast data is suitable for Supervisor, **it is wrong**; report it and follow the binding operational contract.

- **Source types:** `toast_raw_records` is **OPERATIONAL_CURRENT** (one true provider object); `toast_raw_changes` is **OPERATIONAL_CHANGE_LOG** (real field deltas); `toast_raw_samples` and `toast_raw_samples_latest` are **LEGACY_DIAGNOSTIC_ONLY**, never live business truth. In future names, use `diag_`/`diagnostic_` for investigation and `test_`/`fixture_` for synthetic data; never allow those to feed operational canonical views, chat answers or screen numbers.
- **Preflight in every relevant PR:** identify exact source/field permissions, object identity, present-vs-null-vs-missing behavior, one existing writer, every screen/AI consumer, diagnostic/test inputs and which old reader is retired. Authors explicitly state `source_authority_checked: yes` and link to this rule in the PR body **before coding**; reviewers verify the actual code, not the label alone. If source authority or file ownership is unclear, investigate before writing a new path.
- **Proof and retirement:** no PR is done merely because a payload was saved or a view exists. Verify true source payload → current record → `describe_data` discovery → `query_data` on-demand retrieval → real Supervisor turn → applicable screen, plus an explicit **negative test** that diagnostic-only values cannot appear in operational results. A new replacement without removing (or naming and gating removal of) the old active consumer is incomplete. The repo guard blocks newly introduced diagnostic references; the POS0e/0f final-schema migrated-DB test must also eliminate unchanged historical source dependencies.
- **Deletion safety:** retire consumers and verify them in migrated disposable CI **before** deleting obsolete diagnostic code/tables or mass-removing live rows. A diagnostic retention/purge migration must have explicit ownership, a migration/rollback plan and owner-approved production application. Never write a compatibility alias that recreates an old operational fallback.

## Code Review Rules
Codex must review the whole PR first, then review only newly changed lines on later rounds. Check:
- **One path per capability:** no duplicate reader, calculator, attention list, inbox, agent loop or experiment system; explicitly name any replacement and deletion.
- **No hardcoded values:** no literal currency, café ID/name, time zone, dates, price, or scenario-only test value in production paths; values come from the actual café's data/settings.
- **Migration naming:** any new migration follows the repository's existing timestamped filename convention, uses the next free number on latest main, and does not collide with other PRs; RLS and compatibility must be checked.
- **PR size:** one concern, ideally under 400 changed lines of behavioral code; call out mechanical documentation moves separately.
- **Owned files:** every changed file must be in this PR's declared scope. Flag unrelated edits and overlaps with parallel PRs.
- Check action approvals, real data/unknowns, money calculations, tests, and security against the detailed rules below. Treat the P1/P2 review process in section 11 as binding.

## Detailed rules (binding)
The linked files below are part of these instructions, not optional background. Read the relevant file before changing that capability. If a detail conflicts with the standing owner rules above, the standing rules win.
- [1–3. Product, approval levels and one system](docs/rules/product-and-autonomy.md)
- [4. Operating Board, inbox and proactive reports](docs/rules/operating-board.md)
- [4b. POS storage and today](docs/rules/pos-data.md)
- [4c. Morning brief](docs/rules/morning-brief.md)
- [5. Experiments](docs/rules/experiments.md)
- [6. AI architecture, conversation state and budget](docs/rules/ai-architecture.md)
- [7. Numbers and money](docs/rules/numbers-and-money.md)
- [8. Safety and privacy](docs/rules/safety-and-privacy.md)
- [9. Regression tests](docs/rules/tests.md)
- [10–12. Work, review and retired paths](docs/rules/workflow-and-review.md)
- [Skills: what to use before building](docs/rules/skills.md)

## Stack (do not swap without asking)
Next.js 16 App Router + TypeScript strict + Tailwind · Supabase (Postgres, Auth, Storage, RLS on every table)
· Vercel (responsive web app / PWA) · next-intl (en, es, ar) · zod · date-fns(-tz) · Vitest
· OpenAI Responses API via `lib/ai/`. Next.js 16 differs from your training data: read
`node_modules/next/dist/docs/` before using framework APIs.

## Where things are
See [docs/README.md](docs/README.md) for current docs and historical designs.
For the **owner-approved** Universal Supervisor coding queue, task briefs and GitHub-plugin skill prompts,
start at [docs/plans/universal-supervisor-delivery-queue-2026-11.md](docs/plans/universal-supervisor-delivery-queue-2026-11.md).
A draft queue never grants permission to implement unapproved infrastructure or deploy.

## Commands
`npm run dev` · `npm run build` · `npm test` · `npm run lint` · `npx tsc --noEmit` · `npm run db:reset`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know
Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
