# AI CAFE — Universal Supervisor delivery plan (owner-review draft)

**One destination:** by milestone **PR17**, one Supervisor should proactively observe, prioritize, plan, use authorized café data/files/email/browser, coordinate staffing/suppliers/finances/maintenance, act only with one-time or explicitly granted standing authorization, verify effects, remember operational context and continue work when the owner is offline. This is one model/tool loop, not persona agents, a second inbox or another scheduling/approval system.

**Authority:** [AGENTS.md](../../AGENTS.md) and its linked rules; this plan never overrides them. A proposed mandate is not permission to contact employees, write to POS, move funds or deploy. Existing restrictions stay until separately owner-approved rule changes. Every external source and stored record needs the plain-language architecture sheet in AGENTS.md before coding. The owner can approve a complete shared contract once, then coding agents implement within that scope without repeating the same discussion.

**Read only three files for dispatch:** [machine task queue](universal-supervisor-queue.json) (IDs, dependency DAG, proof status), [task briefs](universal-supervisor-task-briefs.md) (unique task acceptance) and [agent operations](universal-supervisor-agent-operations.md) (short copy-paste prompt). Reusable process belongs in `.claude/skills/aicafe-*/SKILL.md`; do not paste all rules into each coding turn.

## Current factual baseline (GitHub, Nov 5)

Merged **code**, not certified live behavior: #361 live Toast orders; #362 saved owner facts; universal **PR1 #375** general queries; **PR2 #379** canonical coverage and cents; **PR3 #377** commitments; **PR4 #376** notice decision; **PR5 #378** durable run storage. CI foundations #369 (E1), #374 (B2), #371/#381 (skills), #373 (recorded evals), #382 (Squawk), #383 (café-delete fix). Actual merge SHA and end-to-end acceptance must be verified against current main each time. Existing historical incomplete work remains visible in [archived progress](../history/progress-snapshot-2026-11-05.md).

The previous Grok queue's complete PR6–PR12 briefs were referenced at Grok-local paths **not verified in the repository**. Recover and reconcile before marking any PR6–PR12 brief as owner-approved. [Original proposal](../history/universal-supervisor-initial-proposal-2026-11-05.md) is retained only for detailed architecture context.

## Finish-line milestones

| Milestone | Owner-visible outcome | Dependencies / delivery proof |
|---|---|---|
| **E2** | Targeted Playwright/preview proof when a PR changes the UI/browser; no unnecessary screenshot gate for backend-only PRs | E1 #369, B2 #374; real execution check, not a skipped path-filter |
| **PR6** | Durable scoped worker: runs long work with checkpoints, per-run/café cost budgets, retries and lease safety | PR5 storage proof; restarts/duplicate worker tests |
| **PR7** | Supervisor decides and schedules its own monitoring and follow-up work, including exception handling | PR6; trigger/dedup/DST/inbox parity |
| **PR8a–c** | Existing experiments, Events and morning briefs reuse the common routine contract without second writers or lost deadlines | PR7 + each domain's actual operational acceptance |
| **PR9** | Rolling operational memory, known facts, preferences and open work; never stale cached business money | existing owner-facts storage; tenant/forget/update tests |
| **PR10** | Single server-enforced gateway for **individual click approvals and repeatable standing mandates**; optional phone OTP step-up tied to a specific permission | existing approve/commit flows; owner-approved scope/limits/revoke/receipt tests |
| **PR11** | Secure connector registry, Gmail read/draft/send where authorized, provider receipt/revocation and missing-scope handling | PR10; simulated provider delivery/retry checks |
| **PR12** | Authorized CSV/XLSX/PDF and isolated browser/computer use with source proof and same effects gateway | PR6, PR10; file/browser permission and prompt-injection tests |
| **PR13** | Staffing planning → approved/mandated publish → permitted employee communication → responses/coverage; recruitment support within legal authority | PR6–PR12 as needed; real staff state and labor parity |
| **PR14** | Inventory → demand → vendor quote → permitted PO → delivery/invoice matching; finance/cash administration | PR10–PR12 and canonical money/stock evidence; no duplicate order/payment |
| **PR15** | Continuous priorities, equipment/maintenance work, outages, escalation, budgets, revocation and recovery | shared run/routine/attention/notice paths; unattended failures tested |
| **PR16** | One chat-native owner experience: approvals/mandates, live work status, connector controls, honest outcome reports | shared backend contracts; focused mobile/desktop browser proof |
| **PR17** | Full unfamiliar cross-domain operator trials, multi-day restarts, isolated preview and owner-authorized live pilot | **all** prior integrated tests; explicit release evidence and rollback |

These are **delivery milestones**; suffixed IDs in the queue (e.g. `14a`, `16b`) are **small owned implementation PR tasks**, not GitHub PR numbers. No unspecified future phase substitutes for a PR17 acceptance requirement. A real provider limitation must be reported as a gap, not called a pass.

## Parallel implementation and merge

**Open now, merge later:** independent approved tasks start on latest main. If task B depends on open A, create B's branch from A's branch and open **a draft PR targeting A's branch immediately**, with stable file ownership; B is not blocked from coding merely because A is unmerged. As soon as A merges, B incorporates latest main, checks actual shared exports/schema/registration, reruns relevant tests and gets new Codex review. Only one PR owns any shared file/migration; no duplicate readers or dead adapters.

**Candidate first wave once briefs/architecture and file scopes are approved:** E2, PR6, PR9, PR10 on separate nonoverlapping scopes; optional PR7 stacked on PR6 and PR16a on PR10. Up to **four ChatGPT and two Claude** active tasks; no forced slot-filling if scopes conflict. The queue determines the actual frontier from latest GitHub facts; these are examples, not automatic authorizations.

## Test policy: meaningful, fast and real

- Every code PR: current-head TypeScript, lint, full Vitest, build, GitHub baseline/Codex as required by AGENTS.md. A missing/skipped required check is not a pass.
- Data/schema: disposable migrated Supabase SQL/RLS and exact currency/count/coverage parity.
- Actions/routines: failures, idempotency, revoked permission, receipt and recovery tests; actual tool registration or cron consumer proved before calling capability integrated.
- UI/browser changes: **targeted** Playwright/preview and screenshots/traces when meaningful. No automatic screenshots for backend-only work. Avoid slow redundant checks; focused integration acceptance belongs at the first actual consumer and again at PR17.
- Never claim production-live from fixture CI; production migrations, external communications and pilot require explicit owner approval.

## Proof states (do not conflate)

`proposed → architecture-approved → draft-open → CI/Codex fixing → merged → integrated-proven → released-proven`. **Merged is NOT done** if the required integration acceptance wasn't executed; a later task checks the predecessor on latest main, and a defect returns to a small repair PR, not a hidden workaround downstream. A green PR body assertion, old checkbox or review approval alone does not establish proof.

## Decisions needed before dispatch

1. Owner-approved infrastructure sheet, source/API fields, saved record identity/retention and mandate boundaries (PR10 contract considered **before** PR6 worker assumes an authorization interface).
2. Reconcile actual Grok PR6–PR12 briefs; no fabricated task ownership.
3. Assign exact editable files from current main + open PRs, including shared-module owner; resolve proof failures in already merged foundations.
4. Verify available CI/Codex protections and optional E2 preview setup. No assumptions about real production readiness.

After approval, dispatchers and coding agents follow the [short runbook](universal-supervisor-agent-operations.md) and the [skills index](../rules/skills.md); do not keep inventing a second plan.
