---
name: aicafe-proof-gate
description: Use to verify that an AI CAFE PR or prior merged prerequisite actually delivered its promised behavior; inspect final-head CI, Codex, applicable DB/integration/e2e proof and real on-main wiring before declaring completion.
---

> **AI CAFE local rules:** Follow AGENTS.md, `docs/rules/tests.md`, and `verification-before-completion`. Evidence before assertions. Do not weaken tests or edit fixtures as a workaround. A documentation checklist is not a GitHub branch protection rule.

# Prove the capability, not the claim

1. Read the approved brief and PR body's **specific acceptance scenarios**. For each, record the actual test file/command, expected behavior, executed result, commit SHA and accessible CI job/log URL. Inspect underlying changes and tests. A checklist with `[x]`, green build or claimed 'done' is never sufficient.
2. **Always required on code PR:** final-head `AI CAFE PR baseline` success, matching submitted Codex review with unresolved substantive findings addressed/threads resolved, correct base/head, and actual required per-domain tests. Check GitHub job steps: required test must have **run**, not merely been present or skipped.
3. **Targeted, not blanket:** SQL/RLS tests when data changes; recorded Supervisor eval for changed agent code; isolated fake-provider and receipt tests for effects; focused browser/Playwright plus screenshot/preview only when UI/browser flow materially changes; no universal screenshot demand for backend-only PRs.
4. For a predecessor already merged, rerun/reinspect its **public interface on the latest main**, plus its integration consumer: imports, registration, canonical reader/view, job/cron wiring and exact acceptance. If incomplete, report `merged_unproven` with missing assertions and create a scoped repair proposal. Do not have a dependent PR hide it with copied code.
5. For cross-system flows, require one executable end-to-end test at the **capability integration milestone**, even if constituent small backend PRs only use focused tests. Use disposable Supabase and synthetic cafés; production pilot is separate and owner-authorized.
6. Optional or inapplicable tests need a one-line N/A reason. A required test skipped because of missing keys, fixture or environment is **NOT PROVEN**. CI/PR-body proof checks only guard what is machine verifiable; preview and real business outcomes remain independently checked.

**Output:** `merge_gate: pass/fail/unknown`; `capability_gate: proven/unproven/unknown`; scenario → result → command/job/head SHA; unresolved failures; production release state separately. Never claim a completed live business operation from an API request without an outcome receipt.
