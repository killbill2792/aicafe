# AI CAFE — Universal Supervisor delivery plan (owner-review draft)

**One destination:** by milestone **PR17**, one Supervisor should proactively observe, prioritize, plan, use authorized café data/files/email/browser, coordinate staffing/suppliers/finances/maintenance, act only with one-time or explicitly granted standing authorization, verify effects, remember operational context and continue work when the owner is offline. This is one model/tool loop, not persona agents, a second inbox or another scheduling/approval system.

**Authority:** [AGENTS.md](../../AGENTS.md) and its linked rules; this plan never overrides them. A proposed mandate is not permission to contact employees, write to POS, move funds or deploy. Existing restrictions stay until separately owner-approved rule changes. Every external source and stored record needs the plain-language architecture sheet in AGENTS.md before coding. The owner can approve a complete shared contract once, then coding agents implement within that scope without repeating the same discussion.

**For any Toast/POS task, first read [binding POS source authority](../rules/pos-data.md) in addition to the three dispatch files below. Diagnostic capture/test data must not feed the live Supervisor, no matter what historical fixtures say.**

**One generated dispatch handoff, not three independent instructions:** the existing GitHub dispatcher reads the [machine queue](universal-supervisor-queue.json) (DAG, ownership, proof and approval gate) and [assigned task brief](universal-supervisor-task-briefs.md) (acceptance); its `delivery.mjs` creates the sole bounded ChatGPT/Claude assignment or continuation prompt. [Agent operations](universal-supervisor-agent-operations.md) is lifecycle context, **not** a copy-paste prompt or second approval path. AGENTS.md, read-only PROGRESS.md, binding POS rules, applicable skills and #398's retrievable POS0a handoff card is the architecture first-read; the matrix's historical field ledger is selective evidence, not a mandatory prompt dump.

## PRIORITY ZERO — complete Toast Standard API data and one AI read path (owner decision, Nov 6)

**This now comes before the remaining Universal Supervisor PR6–PR17 work, including E2.** The
[existing machine queue](universal-supervisor-queue.json) adds **POS0a → POS0e shared current-reader/retention foundation → POS0b/POS0c/POS0d → POS0f**, and explicitly makes POS0f an integrated-proof dependency of E2, PR6, PR9
and PR10 (hence the rest of the queue). The actual deterministic dispatcher checks dependencies;
this is not merely a change of prose priority. Finish existing open PR CI/Codex/reviews normally,
but do not create new lower-priority dispatch assignments while POS0f is unproven.

**D4 owner-approved architecture clarification (NOT implementation):** D4A selects change-driven family-specific refresh and automatic reconciliation in the existing 10-minute coordinator plus separate 15-minute live orders; never blanket GET every tick or webhook-only. D4B requires SQL-level bad-order isolation and no starvation of valid orders, daily jobs, payment-gap recovery or generation-bound cost work; preserve prior #189/#203/#264/#297 regressions. Proposed `POS0-order-recovery` has no dispatch/file/SQL approval, and the 77 due cost-refresh jobs with zero attempts are a separate diagnostic. **One briefing path:** [binding POS rules](../rules/pos-data.md) → [#398 D4 card](toast-standard-api-coverage-matrix.md#d4ad4b-approved-architecture-outcome--no-runtime-approval-nov-7) → [task brief](universal-supervisor-task-briefs.md) + [queue](universal-supervisor-queue.json). Do not add another prompt.

**Why first:** The current one-record-per-order writer, revision log, sales imports and canonical
screen numbers are working and must remain. The gap is complete **field retention and current-object
ingestion** for other accessible Toast Standard API endpoints, plus the path from those current
objects to `describe_data` / `query_data`. A successful old diagnostic capture does not prove
a current importer. Do not rebuild orders or keep parallel raw snapshots.

| Task | Outcome | Dependency | Proof |
|---|---|---|---|
| **POS0a (start now)** | Current official Standard API operation/field/permission/storage/reader matrix; explicit one-object-key and privacy architecture for owner sign-off | None | Read-only repeatable audit; no production changes |
| **POS0b** | Current staff, jobs, shifts, attendance: all permitted fields, correct changes and 10-minute coordinated refresh; genuine current-object → Supervisor proof | POS0a + POS0e | Source-field/DB/AI + Staff/labor/money parity |
| **POS0c** | Current cash, stock, kitchen and operational availability; diagnostic-only values never appear as actual | POS0a + POS0e | API-to-current-object change logs, failure/freshness and query tests |
| **POS0d** | Current eligible menu, configuration, restaurant, device, packaging and remaining Standard API data | POS0a + POS0e | Every eligible source-field mapping, revisions, canonical screen parity |
| **POS0e — FIRST foundation** | Retire diagnostic-backed live SQL, retain all permitted customer/staff fields, complete existing schema-backed discovery and bounded on-demand reads for all current-object families | POS0a | Actual current object vs conflicting diagnostic values, same existing tools, cross-café isolation, no stored-but-inaccessible source |
| **POS0f (release prerequisite)** | Final endpoint × field Supervisor/screen proof, active SQL lineage zero diagnostics, and safe tracked retirement/cleanup of obsolete captures/mirrors/rows | POS0e + POS0b/c/d | Official inventory × field → API-shaped response → one-object writer → `describe_data` → `query_data` → Supervisor + screen, disposable SQL CI and owner-authorized read-only live proof |

**Preserve existing working architecture:** `toast_raw_records` current objects,
`toast_raw_changes` field diffs, existing organized tables, live/closeout order importer,
screen metrics in `lib/metrics/core`, specialized tool projections, `calculate`,
`describe_data` and `query_data`. No duplicate ingestion/read path, no new tool/view per
question, no arbitrary AI SQL, no data loss and no indiscriminate 30-minute requests.
**Target, NOT verified current behavior:** the existing 10-minute coordinator should make bounded per-family change checks and report actual freshness, but optional labor/config paths are still daily gated. Future approved POS0b–d work must reuse that coordinator, respect quotas/backoff and prefer revision/metadata checks before a validated full snapshot; no current 10-minute freshness guarantee.
Names, customer IDs, phone/email, staff details, notes and other fields Toast returns under real permissions must be retained for café-authorized AI, except card PAN/CVV/track and payment/authentication credentials. A missing optional field cannot block an unrelated order or answer. `toast_raw_samples` and `toast_raw_samples_latest` are LEGACY_DIAGNOSTIC_ONLY and must never feed operational `cv_*`, Supervisor or screen figures. A restricted endpoint is a documented, date-stamped `permission`/`not_supported`/`empty` reason,
not an invented zero. Standard API is distinct from optional paid Toast Analytics/ERA and
Menus V3 limitations.

**Owner approval boundary:** The user approved **priority** and the high-level architecture.
POS0a is approved for **read-only contract/audit work**. **November 8 owner switch remains OFF:** dispatcher issue/queue tracking does not authorize delivery of POS0b–f coding prompts; the owner will personally activate the existing coding dispatcher after #398/#399/#400 architecture closeout. Comment reconciliation remains manual in these draft PR bodies, not a new blocking automation task. Before POS0e or POS0b–d begin coding,
AGENTS.md §15 still requires a source-field-by-field mapping, stable object keys, destinations,
redaction, permissions, readers and exact file ownership that the owner has reviewed.
Production migrations/deploys and new credentials need separate approval.
Detailed per-task acceptance, failures, migration/CI/Codex and post-merge proof are in
[task briefs](universal-supervisor-task-briefs.md#priority-zero--finish-all-permitted-toast-standard-api-data-before-e2--pr6pr17)
and [queue JSON](universal-supervisor-queue.json).

## Current factual baseline (GitHub, Nov 5)

Merged **code**, not certified live behavior: #361 live Toast orders; #362 saved owner facts; universal **PR1 #375** general queries; **PR2 #379** canonical coverage and cents; **PR3 #377** commitments; **PR4 #376** notice decision; **PR5 #378** durable run storage. CI foundations #369 (E1), #374 (B2), #371/#381 (skills), #373 (recorded evals), #382 (Squawk), #383 (café-delete fix). Actual merge SHA and end-to-end acceptance must be verified against current main each time. Existing historical incomplete work remains visible in [archived progress](../history/progress-snapshot-2026-11-05.md).

The previous Grok queue's complete PR6–PR12 briefs were referenced at Grok-local paths **not verified in the repository**. Recover and reconcile before marking any PR6–PR12 brief as owner-approved. [Original proposal](../history/universal-supervisor-initial-proposal-2026-11-05.md) is retained only for detailed architecture context.

## Finish-line milestones

| Milestone | Owner-visible outcome | Dependencies / delivery proof |
|---|---|---|
| **E2** | Required targeted Playwright in GitHub Actions against a locally started app + disposable seeded DB. **No Vercel preview deployments/builds** and no screenshot gate for backend-only PRs | E1 #369, B2 #374, plus POS0f integration proof; real CI execution, not a skipped job |
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

**Current first wave:** POS0a only (approved read-only inventory), plus a distinct source-authority/naming guard PR #400 with no SQL/data deletion. POS0e is the proposed first shared code foundation after POS0a's actual approved field contract; POS0b/c/d depend on its integrated reader; POS0f requires all slice proofs. Do not mark any unmerged proposal released. After POS0f is integrated-proven, the earlier E2/PR6/PR9/PR10 wave may proceed against the latest main on nonoverlapping scopes. Previously opened lower-priority PRs are not abandoned. Up to **five ChatGPT and two Claude** active tasks; no forced slot-filling if scopes conflict. The queue determines the actual frontier from latest GitHub facts; these are examples, not automatic authorizations.

## Test policy: meaningful, fast and real

- Every code PR: current-head TypeScript, lint, full Vitest, build, GitHub baseline/Codex as required by AGENTS.md. A missing/skipped required check is not a pass.
- Data/schema: disposable migrated Supabase SQL/RLS and exact currency/count/coverage parity.
- Actions/routines: failures, idempotency, revoked permission, receipt and recovery tests; actual tool registration or cron consumer proved before calling capability integrated.
- UI/browser changes: **targeted Playwright in GitHub Actions against a disposable seeded local app**; retain meaningful screenshots/traces as GitHub artifacts, never Vercel previews/builds. No automatic screenshots for backend-only PRs. Focused integration proof belongs at the first actual consumer and again at PR17.
- Never claim production-live from fixture CI; production migrations, external communications and pilot require explicit owner approval.

## Proof states (do not conflate)

`proposed → architecture-approved → draft-open → CI/Codex fixing → merged → integrated-proven → released-proven`. **Merged is NOT done** if the required integration acceptance wasn't executed; a later task checks the predecessor on latest main, and a defect returns to a small repair PR, not a hidden workaround downstream. A green PR body assertion, old checkbox or review approval alone does not establish proof.

## Decisions needed before dispatch

1. Owner-approved infrastructure sheet, source/API fields, saved record identity/retention and mandate boundaries (PR10 contract considered **before** PR6 worker assumes an authorization interface).
2. Reconcile actual Grok PR6–PR12 briefs; no fabricated task ownership.
3. Assign exact editable files from current main + open PRs, including shared-module owner; resolve proof failures in already merged foundations.
4. Verify CI/Codex protections and future E2 GitHub-only local browser tests (no Vercel preview setup). No assumptions about real production readiness.

After approval, dispatchers and coding agents follow the [short runbook](universal-supervisor-agent-operations.md) and the [skills index](../rules/skills.md); do not keep inventing a second plan.
