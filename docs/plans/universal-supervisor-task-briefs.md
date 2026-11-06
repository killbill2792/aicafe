# Universal Supervisor — coding-agent task briefs (proposal)

**Read once:** `AGENTS.md`, `PROGRESS.md`, [agent operations](universal-supervisor-agent-operations.md), [queue](universal-supervisor-queue.json), and the three AI CAFE skills in `.claude/skills/`. Each coding chat opens the task's relevant listed existing skills and verifies its own current code/PR scope. The **one common lifecycle** (stacked draft immediately, one PR/chat, current-head CI, Codex review and resolved threads, rebase when dependency merges, integration proof, merge) is in `aicafe-pr-lifecycle`; do not duplicate it in each task.

**Status:** these are proposed requirements until owner-approved architecture and exclusive editable paths are recorded. Do not assume the Grok-local PR6–PR12 briefs were retrieved. A merged prerequisite is not automatically proven. **Browser screenshots only when a changed UI/browser owner journey needs them.** No production deploy or action without separate owner authorization.

**Short coding prompt:** `Use connected GitHub plugin. Read AGENTS.md + PROGRESS.md and load aicafe-pr-lifecycle, aicafe-dependency-check, aicafe-proof-gate and TASK_ID skills. Implement the approved brief for TASK_ID from docs/plans/universal-supervisor-task-briefs.md. Open a draft PR immediately (stack on open dependency branch); own it through CI/Codex/resolve/review/rebase/merge. Verify prerequisite behavior and required acceptance with actual executed evidence. Only touch assigned paths; no production changes.`

## Task E2: E2 required seeded browser CI, protected preview proof

- **Depends:** none (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Required Playwright CI job + isolated seeded preview; verify browser scenarios really run.
- **Scope to verify/assign:** CI/browser test harness, disposable seeded auth and PR check integration. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** A changed browser flow runs a real targeted Playwright scenario, with recorded job link; Backend-only changes are not delayed by irrelevant screenshots; No production accounts/side effects in preview fixtures.
- **Tests:** db, e2e, preview, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 6: Durable worker and cross-turn execution

- **Depends:** 5 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Leased worker resumes one AI loop safely under budgets and authorization.
- **Scope to verify/assign:** lib/ai/supervisor/runs/*; new worker route; usage adapter. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Two workers cannot claim the same step; Restart resumes after verified earlier steps without repeating effects; Timeout/budget/cancel retains a truthful persisted status.
- **Tests:** unit, db, failure; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 7: Self-directed routines/prioritization

- **Depends:** 6 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Self-managed schedules and proactive priority decisions with due-once triggers.
- **Scope to verify/assign:** lib/ai/supervisor/routines/*; existing commitment/attention adapters. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** One routine occurrence makes one run across retries/DST; Owner may pause and revoke without stopping unrelated routine work; New evidence can trigger independent prioritization and owner notice.
- **Tests:** unit, db, failure; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 8a: Experiment cutover parity

- **Depends:** 7 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Experiments cutover with parity and single writer.
- **Scope to verify/assign:** existing lib/ai/supervisor/loop/* experiment cron. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Existing experiment observations and reports match before/after cutover; No duplicate runs or notices; Old cron disabled only after verified parity and rollback.
- **Tests:** unit, db, acceptance; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 8b: Events cutover parity

- **Depends:** 7 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Events cutover with parity and single writer.
- **Scope to verify/assign:** existing lib/events/* lookahead cron. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Events research/observation/report parity across current local day boundaries; Only one authoritative event monitor and notice writer; A missing/research-failed event is not called absent.
- **Tests:** unit, db, acceptance; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 8c: Morning brief cutover parity

- **Depends:** 7 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Brief cutover with timezone/delivery parity and single writer.
- **Scope to verify/assign:** lib/operating/briefSchedule.ts and existing morningBrief delivery path. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** One brief per verified owner/café-local day and preopening deadline; Provider failure remains visible/retriable; No duplicate sends or silent skips.
- **Tests:** unit, db, acceptance; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 9: Rolling operational memory

- **Depends:** 5 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Rolling thread memory with provenance and no cached financial facts.
- **Scope to verify/assign:** lib/ai/agent/history.ts, memory.server.ts and ai_threads summary. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Remember decisions/preferences across a reopened thread; No cached business money in summary, reread authoritative data; Forget/change and tenant isolation verified.
- **Tests:** unit, db, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 10: Individual approval and standing mandate gateway

- **Depends:** 5 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** One effect gateway supporting individual approval and OTP-backed standing authorization.
- **Scope to verify/assign:** existing supervisor proposals/approvals; auth-backed mandate authorization and receipts. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Individual approval and matching standing authorization both pass same effect gateway; Phone step-up binds exact owner/café/action/limit/revision; replay/expiry/revocation fail; Effect receipt uncertain state cannot be double committed.
- **Tests:** unit, db, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `testing-api-security-with-owasp-top-10`, `exploiting-idor-vulnerabilities`, `pr`.

## Task 11: Gmail and reusable connector security boundary

- **Depends:** 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Secure connector registry and Gmail end-to-end.
- **Scope to verify/assign:** new integration adapter plus existing tools/approval gateway. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Authorize/connect/disconnect Gmail and respect scopes; Draft/read/send only through permitted action with provider receipt; Timed-out send reconciles before retry; token not model-visible.
- **Tests:** unit, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `testing-api-security-with-owasp-top-10`, `playwright-cli`, `pr`.

## Task 12: General file/spreadsheet/browser/computer use

- **Depends:** 6, 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Files/spreadsheets/PDF/browser use with controlled external effects.
- **Scope to verify/assign:** existing attachment/file paths and new isolated browser adapter. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Read a permitted CSV/XLSX/PDF with column provenance and bounded data; Browser can inspect a permitted site but webpage instructions cannot change authority; Write attempt requires gateway permission and verified receipt.
- **Tests:** unit, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `testing-api-security-with-owasp-top-10`, `playwright-cli`, `pr`.

## Task 13a: Canonical staff schedule/labor reads and planning

- **Depends:** 6, 7 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Canonical scheduling reads and labor parity.
- **Scope to verify/assign:** lib/scheduling/*; lib/ai/agent/tools/draftSchedule.ts; canonical Staff readers. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Staff availability and projected demand produce valid schedule with canonical labor cost; No available staff/partial timecards truthfully handled; Exact parity to Staff view.
- **Tests:** unit, db, parity; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `e2e-testing-patterns`, `pr`.

## Task 13b: Mandate-controlled schedule publication and worker messaging

- **Depends:** 13a, 10, 11 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Mandate-controlled schedule publishing and messaging receipts.
- **Scope to verify/assign:** lib/actions/staffDraftInPlace.ts; existing approval + outbound transports. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner approval or valid mandate publishes one correct schedule; Authorized staff messages have verified delivery attempts; Mandate revoke before send prevents effect.
- **Tests:** unit, db, e2e, receipt; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `e2e-testing-patterns`, `pr`.

## Task 13c: Shift response/coverage lifecycle

- **Depends:** 13b (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Staff response, absences and shift coverage lifecycle.
- **Scope to verify/assign:** existing Staff scheduling acceptance/response readers and records. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Staff accepts/declines and coverage state updates once; No silent status success on a sent-only message; Missing staff coverage escalates without duplicate notices.
- **Tests:** unit, db, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `e2e-testing-patterns`, `pr`.

## Task 13d: Recruitment/leave/onboarding supported actions and human decision gates

- **Depends:** 13a, 10, 11 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Recruitment, leave, onboarding and human decision gates.
- **Scope to verify/assign:** Staff records plus authorized external posting/interview integrations. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Vacancy/interview/onboarding pipeline uses actual evidence, not presumed consent; No prohibited autonomous hiring/firing; Candidate data isolation and retention respected.
- **Tests:** unit, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `e2e-testing-patterns`, `pr`.

## Task 14a: Inventory/recipe/consumption evidence

- **Depends:** 6, 9 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Stock/recipe/consumption sources and uncertainty.
- **Scope to verify/assign:** existing inventory/menu/recipe evidence readers; no duplicate ledger. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Stock/recipe and consumption evidence retain source + freshness; Unknown quantity never becomes zero; No duplicate count from repeated source records.
- **Tests:** unit, db, parity; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 14b: Supplier/quote/PO domain lifecycle

- **Depends:** 14a, 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Vendor quotes and purchase order lifecycle.
- **Scope to verify/assign:** existing purchasing/bills records; vendor quote and PO domain contract. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Vendor quotes with units/currency/date are comparable or labeled incomplete; One PO state per key, history and duplicate protection; Owner approval boundary present.
- **Tests:** unit, db, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 14c: Authorized vendor communication and ordering

- **Depends:** 14b, 11, 12 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Vendor communications/order execution and receipts.
- **Scope to verify/assign:** approved connector/browser action adapters and vendor receipt ledger. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Only authorized vendor action executes; Provider timeout enters uncertain state; no duplicate order; Approval expires/revokes without further sends.
- **Tests:** unit, e2e, receipt; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 14d: Receiving/invoice matching and exception handling

- **Depends:** 14c (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Deliveries and invoice reconciliation.
- **Scope to verify/assign:** purchase receiving, invoice and expense readers; canonical money engine. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Partial receipt and mismatched invoice remain open exceptions; Duplicate invoice rejected; Expense/money parity with canonical metrics.
- **Tests:** unit, db, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 14e: Cashflow/payables administration and payment boundary

- **Depends:** 14d, 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Cash flow, bills and payable preparation with payment boundary.
- **Scope to verify/assign:** existing financial readers and preparation workflow; no unapproved fund movement. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Bills and cash needs accurately sourced, known vs projected labeled; Payments stay preparation-only absent explicit authorized lawful integration; No unverified settlement reported paid.
- **Tests:** unit, db, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 15a: Operating priority and anomaly escalation

- **Depends:** 7, 9 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Prioritization and alert escalation using one inbox.
- **Scope to verify/assign:** lib/attention/* and operating_tasks/notifyOwner. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Supervisor initiates priority work from events and operational evidence; One attention/inbox lifecycle and suppressed duplicates; High urgency and missing evidence escalated truthfully.
- **Tests:** unit, db, failure; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 15b: Equipment/maintenance coordination with evidence

- **Depends:** 15a, 10, 11 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Maintenance and equipment coordination.
- **Scope to verify/assign:** operating_tasks plus equipment/maintenance evidence adapters. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Maintenance incident assigned to authorized staff/vendor and tracked; Request sent is not repair completed; Late or unverified resolution remains visible.
- **Tests:** unit, e2e, receipt; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 15c: Fleet resilience/queue fairness/recovery operational proof

- **Depends:** 6, 7, 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** System outages, concurrency, queue fairness and catch-up.
- **Scope to verify/assign:** existing worker/routines resiliency and health reads. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Concurrent cafés progress under fairness/budget caps; Stalled lease and missed routine recover once; Owner offline doesn't freeze permitted work.
- **Tests:** unit, db, failure; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 15d: Untrusted external content/identity/revocation hardening

- **Depends:** 10, 11, 12 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Prompt-injection and provider/cafe access revocation.
- **Scope to verify/assign:** connector and browser authorization/trust handling. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Untrusted email/website prompts cannot authorize actions; Revoked connector/café access stops new effects; No cross-tenant leakage/secret logs.
- **Tests:** unit, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `testing-api-security-with-owasp-top-10`, `exploiting-idor-vulnerabilities`, `pr`.

## Task 16a: Owner mandate grant/revoke and OTP step-up experience

- **Depends:** 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Owner approval and OTP mandate grant/revoke UI.
- **Scope to verify/assign:** existing Supervisor chat approval controls + Supabase owner auth. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner deliberately grants/revokes scoped mandate with step-up; Individual approval still works; chat phrase alone cannot grant; Mobile errors/expired code visible.
- **Tests:** e2e, security, preview; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `pr`.

## Task 16b: Owner-visible durable work, results, exceptions

- **Depends:** 6, 9 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Chat progress, retries and receipts.
- **Scope to verify/assign:** Supervisor chat/Operations status cards and runs reader. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner sees queued/running/approval/failed/completed run with true receipts; Refresh/reconnect shows persisted state; No duplicated approval card on resume.
- **Tests:** e2e, preview; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `pr`.

## Task 16c: Owner connector and computer access controls

- **Depends:** 11, 12 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Account, connector and browser permission controls.
- **Scope to verify/assign:** owner-facing authorized connectors/files/browser controls. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner can link/revoke and understand scope of external access; Revocation reflected before new work; Safe file/browser error and retry displayed.
- **Tests:** e2e, security, preview; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `pr`.

## Task 16d: Accessible responsive owner acceptance

- **Depends:** 16a, 16b, 16c (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Responsive accessible final owner UX.
- **Scope to verify/assign:** existing responsive chat and operations screens; no new dashboard. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** 390px mobile and desktop owner journeys work with keyboard/tap targets; No second required dashboard; Conditional screenshots/traces only for changed UI flows.
- **Tests:** e2e, visual, preview; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `pr`.

## Task 17a: Required CI E2E gate and evidence audit

- **Depends:** E2, 16d (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Required E2E gate evidence and branch protection.
- **Scope to verify/assign:** existing PR baseline/E2 targeted check wiring. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Required CI acceptance recognizes actual test execution vs skip; Branch protection accurately reflects available checks; No irrelevant browser gate for backend-only PR.
- **Tests:** e2e, ci, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `gh-fix-ci`, `pr`.

## Task 17b: Cross-domain deterministic business scenario suite

- **Depends:** 8a, 8b, 8c, 13c, 13d, 14e, 15b, 16d (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Cross-domain deterministic acceptance suite.
- **Scope to verify/assign:** cross-domain fixtures + existing golden eval suites. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Unfamiliar café questions combine canonical data with exact numbers; Staff/supply/finance/events/brief owner journeys verify real state transitions; Permissions and missing data negatives covered.
- **Tests:** db, e2e, receipt, parity; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `gh-fix-ci`, `pr`.

## Task 17c: Unattended multi-day outage/autonomy simulation

- **Depends:** 17b, 15c, 15d (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Multi-day autonomous failure simulation.
- **Scope to verify/assign:** disposable multi-day operations simulation. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Multi-day unattended run recovers worker/provider failures; Standing mandate and individual approval both exercised; No duplicate side effects across retries.
- **Tests:** failure, db, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `gh-fix-ci`, `pr`.

## Task 17d: Isolated preview readiness and smoke acceptance

- **Depends:** 17c (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Safe preview smoke and artifacts.
- **Scope to verify/assign:** isolated preview/deployment smoke harness. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Seeded isolated preview runs owner-facing scenario; Preview never touches production systems; Required evidence URLs/artifacts exist for UI changes.
- **Tests:** preview, e2e, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `gh-fix-ci`, `pr`.

## Task 17e: Owner-authorized live pilot and final release evidence

- **Depends:** 17d, 17a (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Owner-authorized live pilot and certified release.
- **Scope to verify/assign:** owner-authorized pilot/release checklist and evidence. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner-authorized pilot verifies live sources and actions; Rollback, audit and incident procedures exercised; Actual release readiness distinguished from merged code.
- **Tests:** pilot, release; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `gh-fix-ci`, `pr`.

