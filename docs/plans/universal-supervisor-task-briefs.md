# Universal Supervisor — copy-paste task briefs (proposal)

**Owner-approved architecture required before implementation.** These briefs are implementation targets, not statements that every feature exists or exact file scopes are finalized. Actual owned paths must be set in the queue after checking current main and active PRs. The latest `AGENTS.md` wins. Use [agent operations](universal-supervisor-agent-operations.md) and [queue](universal-supervisor-queue.json) for dispatch. **Each task ID is a logical work item, not a real GitHub PR number.** A milestone can contain multiple small PRs.

**Coding agent copy/paste:** `Use GitHub plugin. Read AGENTS.md, PROGRESS.md, relevant skills. Load .claude/skills/aicafe-pr-lifecycle/SKILL.md, aicafe-dependency-check and aicafe-proof-gate. Implement approved TASK_ID from this document and queue. Open dependent stacked draft PR NOW on the prerequisite branch; own it through final-head CI, Codex, resolved threads, rebases and merge. Include actual required test proof; no mandatory screenshots for backend-only changes. Do not touch production.`

## Task E2 — E2 required seeded browser CI, protected preview proof

**Owner outcome:** Required Playwright CI job + isolated seeded preview; verify browser scenarios really run.

**Dependencies (must be integrated-proven before merge):** None. 

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** CI/browser test harness, disposable seeded auth and PR check integration. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. A changed browser flow runs a real targeted Playwright scenario, with recorded job link.
2. Backend-only changes are not delayed by irrelevant screenshots.
3. No production accounts/side effects in preview fixtures.

**Tests to run:** db, e2e, preview, security as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/supabase/SKILL.md`, `.claude/skills/supabase-postgres-best-practices/SKILL.md`, `.claude/skills/vitest/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 6 — Durable worker and cross-turn execution

**Owner outcome:** Leased worker resumes one AI loop safely under budgets and authorization.

**Dependencies (must be integrated-proven before merge):** `5`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** lib/ai/supervisor/runs/*; new worker route; usage adapter. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Two workers cannot claim the same step.
2. Restart resumes after verified earlier steps without repeating effects.
3. Timeout/budget/cancel retains a truthful persisted status.

**Tests to run:** unit, db, failure as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/supabase/SKILL.md`, `.claude/skills/supabase-postgres-best-practices/SKILL.md`, `.claude/skills/vitest/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 7 — Self-directed routines/prioritization

**Owner outcome:** Self-managed schedules and proactive priority decisions with due-once triggers.

**Dependencies (must be integrated-proven before merge):** `6`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** lib/ai/supervisor/routines/*; existing commitment/attention adapters. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. One routine occurrence makes one run across retries/DST.
2. Owner may pause and revoke without stopping unrelated routine work.
3. New evidence can trigger independent prioritization and owner notice.

**Tests to run:** unit, db, failure as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/supabase/SKILL.md`, `.claude/skills/supabase-postgres-best-practices/SKILL.md`, `.claude/skills/vitest/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 8a — Experiment cutover parity

**Owner outcome:** Experiments cutover with parity and single writer.

**Dependencies (must be integrated-proven before merge):** `7`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing lib/ai/supervisor/loop/* experiment cron. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Existing experiment observations and reports match before/after cutover.
2. No duplicate runs or notices.
3. Old cron disabled only after verified parity and rollback.

**Tests to run:** unit, db, acceptance as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 8b — Events cutover parity

**Owner outcome:** Events cutover with parity and single writer.

**Dependencies (must be integrated-proven before merge):** `7`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing lib/events/* lookahead cron. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Events research/observation/report parity across current local day boundaries.
2. Only one authoritative event monitor and notice writer.
3. A missing/research-failed event is not called absent.

**Tests to run:** unit, db, acceptance as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 8c — Morning brief cutover parity

**Owner outcome:** Brief cutover with timezone/delivery parity and single writer.

**Dependencies (must be integrated-proven before merge):** `7`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** lib/operating/briefSchedule.ts and existing morningBrief delivery path. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. One brief per verified owner/café-local day and preopening deadline.
2. Provider failure remains visible/retriable.
3. No duplicate sends or silent skips.

**Tests to run:** unit, db, acceptance as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 9 — Rolling operational memory

**Owner outcome:** Rolling thread memory with provenance and no cached financial facts.

**Dependencies (must be integrated-proven before merge):** `5`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** lib/ai/agent/history.ts, memory.server.ts and ai_threads summary. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Remember decisions/preferences across a reopened thread.
2. No cached business money in summary, reread authoritative data.
3. Forget/change and tenant isolation verified.

**Tests to run:** unit, db, security as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/supabase/SKILL.md`, `.claude/skills/supabase-postgres-best-practices/SKILL.md`, `.claude/skills/vitest/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 10 — Individual approval and standing mandate gateway

**Owner outcome:** One effect gateway supporting individual approval and OTP-backed standing authorization.

**Dependencies (must be integrated-proven before merge):** `5`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing supervisor proposals/approvals; auth-backed mandate authorization and receipts. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Individual approval and matching standing authorization both pass same effect gateway.
2. Phone step-up binds exact owner/café/action/limit/revision; replay/expiry/revocation fail.
3. Effect receipt uncertain state cannot be double committed.

**Tests to run:** unit, db, security, e2e as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/supabase/SKILL.md`, `.claude/skills/testing-api-security-with-owasp-top-10/SKILL.md`, `.claude/skills/exploiting-idor-vulnerabilities/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 11 — Gmail and reusable connector security boundary

**Owner outcome:** Secure connector registry and Gmail end-to-end.

**Dependencies (must be integrated-proven before merge):** `10`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** new integration adapter plus existing tools/approval gateway. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Authorize/connect/disconnect Gmail and respect scopes.
2. Draft/read/send only through permitted action with provider receipt.
3. Timed-out send reconciles before retry; token not model-visible.

**Tests to run:** unit, security, e2e as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/testing-api-security-with-owasp-top-10/SKILL.md`, `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 12 — General file/spreadsheet/browser/computer use

**Owner outcome:** Files/spreadsheets/PDF/browser use with controlled external effects.

**Dependencies (must be integrated-proven before merge):** `6`, `10`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing attachment/file paths and new isolated browser adapter. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Read a permitted CSV/XLSX/PDF with column provenance and bounded data.
2. Browser can inspect a permitted site but webpage instructions cannot change authority.
3. Write attempt requires gateway permission and verified receipt.

**Tests to run:** unit, security, e2e as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/testing-api-security-with-owasp-top-10/SKILL.md`, `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 13a — Canonical staff schedule/labor reads and planning

**Owner outcome:** Canonical scheduling reads and labor parity.

**Dependencies (must be integrated-proven before merge):** `6`, `7`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** lib/scheduling/*; lib/ai/agent/tools/draftSchedule.ts; canonical Staff readers. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Staff availability and projected demand produce valid schedule with canonical labor cost.
2. No available staff/partial timecards truthfully handled.
3. Exact parity to Staff view.

**Tests to run:** unit, db, parity as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 13b — Mandate-controlled schedule publication and worker messaging

**Owner outcome:** Mandate-controlled schedule publishing and messaging receipts.

**Dependencies (must be integrated-proven before merge):** `13a`, `10`, `11`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** lib/actions/staffDraftInPlace.ts; existing approval + outbound transports. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Owner approval or valid mandate publishes one correct schedule.
2. Authorized staff messages have verified delivery attempts.
3. Mandate revoke before send prevents effect.

**Tests to run:** unit, db, e2e, receipt as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 13c — Shift response/coverage lifecycle

**Owner outcome:** Staff response, absences and shift coverage lifecycle.

**Dependencies (must be integrated-proven before merge):** `13b`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing Staff scheduling acceptance/response readers and records. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Staff accepts/declines and coverage state updates once.
2. No silent status success on a sent-only message.
3. Missing staff coverage escalates without duplicate notices.

**Tests to run:** unit, db, e2e as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 13d — Recruitment/leave/onboarding supported actions and human decision gates

**Owner outcome:** Recruitment, leave, onboarding and human decision gates.

**Dependencies (must be integrated-proven before merge):** `13a`, `10`, `11`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** Staff records plus authorized external posting/interview integrations. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Vacancy/interview/onboarding pipeline uses actual evidence, not presumed consent.
2. No prohibited autonomous hiring/firing.
3. Candidate data isolation and retention respected.

**Tests to run:** unit, security, e2e as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 14a — Inventory/recipe/consumption evidence

**Owner outcome:** Stock/recipe/consumption sources and uncertainty.

**Dependencies (must be integrated-proven before merge):** `6`, `9`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing inventory/menu/recipe evidence readers; no duplicate ledger. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Stock/recipe and consumption evidence retain source + freshness.
2. Unknown quantity never becomes zero.
3. No duplicate count from repeated source records.

**Tests to run:** unit, db, parity as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 14b — Supplier/quote/PO domain lifecycle

**Owner outcome:** Vendor quotes and purchase order lifecycle.

**Dependencies (must be integrated-proven before merge):** `14a`, `10`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing purchasing/bills records; vendor quote and PO domain contract. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Vendor quotes with units/currency/date are comparable or labeled incomplete.
2. One PO state per key, history and duplicate protection.
3. Owner approval boundary present.

**Tests to run:** unit, db, security as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 14c — Authorized vendor communication and ordering

**Owner outcome:** Vendor communications/order execution and receipts.

**Dependencies (must be integrated-proven before merge):** `14b`, `11`, `12`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** approved connector/browser action adapters and vendor receipt ledger. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Only authorized vendor action executes.
2. Provider timeout enters uncertain state; no duplicate order.
3. Approval expires/revokes without further sends.

**Tests to run:** unit, e2e, receipt as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 14d — Receiving/invoice matching and exception handling

**Owner outcome:** Deliveries and invoice reconciliation.

**Dependencies (must be integrated-proven before merge):** `14c`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** purchase receiving, invoice and expense readers; canonical money engine. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Partial receipt and mismatched invoice remain open exceptions.
2. Duplicate invoice rejected.
3. Expense/money parity with canonical metrics.

**Tests to run:** unit, db, e2e as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 14e — Cashflow/payables administration and payment boundary

**Owner outcome:** Cash flow, bills and payable preparation with payment boundary.

**Dependencies (must be integrated-proven before merge):** `14d`, `10`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing financial readers and preparation workflow; no unapproved fund movement. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Bills and cash needs accurately sourced, known vs projected labeled.
2. Payments stay preparation-only absent explicit authorized lawful integration.
3. No unverified settlement reported paid.

**Tests to run:** unit, db, security as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 15a — Operating priority and anomaly escalation

**Owner outcome:** Prioritization and alert escalation using one inbox.

**Dependencies (must be integrated-proven before merge):** `7`, `9`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** lib/attention/* and operating_tasks/notifyOwner. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Supervisor initiates priority work from events and operational evidence.
2. One attention/inbox lifecycle and suppressed duplicates.
3. High urgency and missing evidence escalated truthfully.

**Tests to run:** unit, db, failure as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 15b — Equipment/maintenance coordination with evidence

**Owner outcome:** Maintenance and equipment coordination.

**Dependencies (must be integrated-proven before merge):** `15a`, `10`, `11`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** operating_tasks plus equipment/maintenance evidence adapters. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Maintenance incident assigned to authorized staff/vendor and tracked.
2. Request sent is not repair completed.
3. Late or unverified resolution remains visible.

**Tests to run:** unit, e2e, receipt as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/vitest/SKILL.md`, `.claude/skills/supabase/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 15c — Fleet resilience/queue fairness/recovery operational proof

**Owner outcome:** System outages, concurrency, queue fairness and catch-up.

**Dependencies (must be integrated-proven before merge):** `6`, `7`, `10`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing worker/routines resiliency and health reads. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Concurrent cafés progress under fairness/budget caps.
2. Stalled lease and missed routine recover once.
3. Owner offline doesn't freeze permitted work.

**Tests to run:** unit, db, failure as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/supabase/SKILL.md`, `.claude/skills/supabase-postgres-best-practices/SKILL.md`, `.claude/skills/vitest/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 15d — Untrusted external content/identity/revocation hardening

**Owner outcome:** Prompt-injection and provider/cafe access revocation.

**Dependencies (must be integrated-proven before merge):** `10`, `11`, `12`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** connector and browser authorization/trust handling. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Untrusted email/website prompts cannot authorize actions.
2. Revoked connector/café access stops new effects.
3. No cross-tenant leakage/secret logs.

**Tests to run:** unit, security, e2e as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/supabase/SKILL.md`, `.claude/skills/testing-api-security-with-owasp-top-10/SKILL.md`, `.claude/skills/exploiting-idor-vulnerabilities/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 16a — Owner mandate grant/revoke and OTP step-up experience

**Owner outcome:** Owner approval and OTP mandate grant/revoke UI.

**Dependencies (must be integrated-proven before merge):** `10`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing Supervisor chat approval controls + Supabase owner auth. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Owner deliberately grants/revokes scoped mandate with step-up.
2. Individual approval still works; chat phrase alone cannot grant.
3. Mobile errors/expired code visible.

**Tests to run:** e2e, security, preview as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/web-design-guidelines/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 16b — Owner-visible durable work, results, exceptions

**Owner outcome:** Chat progress, retries and receipts.

**Dependencies (must be integrated-proven before merge):** `6`, `9`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** Supervisor chat/Operations status cards and runs reader. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Owner sees queued/running/approval/failed/completed run with true receipts.
2. Refresh/reconnect shows persisted state.
3. No duplicated approval card on resume.

**Tests to run:** e2e, preview as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/web-design-guidelines/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 16c — Owner connector and computer access controls

**Owner outcome:** Account, connector and browser permission controls.

**Dependencies (must be integrated-proven before merge):** `11`, `12`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** owner-facing authorized connectors/files/browser controls. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Owner can link/revoke and understand scope of external access.
2. Revocation reflected before new work.
3. Safe file/browser error and retry displayed.

**Tests to run:** e2e, security, preview as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/web-design-guidelines/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 16d — Accessible responsive owner acceptance

**Owner outcome:** Responsive accessible final owner UX.

**Dependencies (must be integrated-proven before merge):** `16a`, `16b`, `16c`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing responsive chat and operations screens; no new dashboard. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. 390px mobile and desktop owner journeys work with keyboard/tap targets.
2. No second required dashboard.
3. Conditional screenshots/traces only for changed UI flows.

**Tests to run:** e2e, visual, preview as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/web-design-guidelines/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 17a — Required CI E2E gate and evidence audit

**Owner outcome:** Required E2E gate evidence and branch protection.

**Dependencies (must be integrated-proven before merge):** `E2`, `16d`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** existing PR baseline/E2 targeted check wiring. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Required CI acceptance recognizes actual test execution vs skip.
2. Branch protection accurately reflects available checks.
3. No irrelevant browser gate for backend-only PR.

**Tests to run:** e2e, ci, security as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/gh-fix-ci/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 17b — Cross-domain deterministic business scenario suite

**Owner outcome:** Cross-domain deterministic acceptance suite.

**Dependencies (must be integrated-proven before merge):** `8a`, `8b`, `8c`, `13c`, `13d`, `14e`, `15b`, `16d`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** cross-domain fixtures + existing golden eval suites. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Unfamiliar café questions combine canonical data with exact numbers.
2. Staff/supply/finance/events/brief owner journeys verify real state transitions.
3. Permissions and missing data negatives covered.

**Tests to run:** db, e2e, receipt, parity as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/gh-fix-ci/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 17c — Unattended multi-day outage/autonomy simulation

**Owner outcome:** Multi-day autonomous failure simulation.

**Dependencies (must be integrated-proven before merge):** `17b`, `15c`, `15d`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** disposable multi-day operations simulation. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Multi-day unattended run recovers worker/provider failures.
2. Standing mandate and individual approval both exercised.
3. No duplicate side effects across retries.

**Tests to run:** failure, db, e2e as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/gh-fix-ci/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 17d — Isolated preview readiness and smoke acceptance

**Owner outcome:** Safe preview smoke and artifacts.

**Dependencies (must be integrated-proven before merge):** `17c`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** isolated preview/deployment smoke harness. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Seeded isolated preview runs owner-facing scenario.
2. Preview never touches production systems.
3. Required evidence URLs/artifacts exist for UI changes.

**Tests to run:** preview, e2e, security as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Targeted Playwright/preview when changed UI or browser functionality warrants it; do not block backend-only work with irrelevant screenshots.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/e2e-testing-patterns/SKILL.md`, `.claude/skills/gh-fix-ci/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

## Task 17e — Owner-authorized live pilot and final release evidence

**Owner outcome:** Owner-authorized live pilot and certified release.

**Dependencies (must be integrated-proven before merge):** `17d`. An open dependency is not a reason to delay opening this PR: stack on its branch.

**Existing path to inspect / proposed scope (not yet assigned exclusive files):** owner-authorized pilot/release checklist and evidence. Confirm on current `main`, open PR file lists and related `docs/rules/*`; do not create a second owner of this capability.

**Acceptance — all mandatory; attach actually executed test evidence:**
1. Owner-authorized pilot verifies live sources and actions.
2. Rollback, audit and incident procedures exercised.
3. Actual release readiness distinguished from merged code.

**Tests to run:** pilot, release as applicable; base CI/typecheck/lint/Vitest/build on final HEAD. Focused unit/DB/integration proof; browser testing only if owner-facing behavior is changed.

**Skills:** `.claude/skills/playwright-cli/SKILL.md`, `.claude/skills/gh-fix-ci/SKILL.md`, `.claude/skills/pr/SKILL.md`; plus `aicafe-pr-lifecycle`, `aicafe-dependency-check`, `aicafe-proof-gate` as applicable. Reuse existing skills, don't copy their whole bodies.

**Do not claim done until:** predecessor actual code and proof verified; no duplicate path; approved scope and file owners; relevant tests really executed; Codex clean/threads resolved; current base; merged SHA plus integrated consumer checked. Never perform live business effects without permission.

