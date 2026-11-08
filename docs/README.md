# Documentation index

`AGENTS.md` is the single source of agent instructions and the product direction (an AI operator that runs
the café through the Supervisor chat). Start with [AGENTS.md](../AGENTS.md) and [PROGRESS.md — Now](../PROGRESS.md).
If any document conflicts with AGENTS.md, AGENTS.md wins.

**Before ANY POS/Toast/AI-data work, read [binding POS source authority and file classification](rules/pos-data.md) first.** It identifies the real operating record and change log, the legacy diagnostic-only `toast_raw_samples` (which must never drive Supervisor or screens), the correct data-reader chain, naming rules, retirement steps and mandatory executable proof. [POS0a coverage audit](plans/toast-standard-api-coverage-matrix.md) records current gaps; [POS0b–POS0f PR briefs](plans/universal-supervisor-task-briefs.md) own fixes. **Do not start from historical SQL migrations, passing diagnostic fixture tests, or descriptive file names to decide which data is authoritative.**

## Current docs
- **POS0 first read:** [binding source/consumer rules](rules/pos-data.md) → [#398 current owner-decision summary](https://github.com/killbill2792/aicafe/pull/398), then specific [matrix evidence](plans/toast-standard-api-coverage-matrix.md) only when needed (compact in-file entrypoint remains a #398 deliverable) → [assigned POS0a–f brief](plans/universal-supervisor-task-briefs.md) + [machine queue](plans/universal-supervisor-queue.json) → existing source + [acceptance tests](rules/tests.md). Architecture principles approved; implementation/final PR approval pending. **Draft cross-PR note:** #398's matrix is not on main while its PR is open; read the latest [PR #398](https://github.com/killbill2792/aicafe/pull/398) head for review, never dispatch implementation to work around an unavailable on-main file or the false queue approval gate.
- [Universal Supervisor delivery queue (owner-review draft)](plans/universal-supervisor-delivery-queue-2026-11.md) — concise PR6–PR17 roadmap; **not** an implementation authorization until owner approved.
- [Universal Supervisor task briefs](plans/universal-supervisor-task-briefs.md) — per-task dependencies, acceptance, skills and proposed scope.
- [Universal Supervisor coding operations](plans/universal-supervisor-agent-operations.md) — **single generated dispatcher handoff** and stacked PR/Codex/CI lifecycle; old manual prompt templates retired.
- [Universal Supervisor machine queue](plans/universal-supervisor-queue.json) — structured DAG; not a persistent assignment engine.
- [01 product](01-product.md) — what the operator does, limits for now, and what not to build.
- [02 design system](02-design-system.md) — design, accessibility and localization (binding for UI).
- [03 screens](03-screens.md) — existing screen specifications. New capabilities go to the chat first.
- [04 data model](04-data-model.md) — **original model/DDL reference**; not authoritative for current Toast SQL; verify live schema.
- [05 calculations](05-calculations.md) — canonical math and test fixtures.
- [06 integrations](06-integrations.md) — older integration guidance, including **obsolete Toast “v1 = CSV” wording**; not current Toast API source/sync instructions.
- [08 pricing engine plan](08-pricing-engine-plan.md) — pricing-engine design and decisions.
- [scheduling architecture](scheduling-architecture.md) — scheduling boundaries and contracts.
- [AI CAFE skills index](rules/skills.md) — current reusable skills, including ChatGPT + connected GitHub loading.
- [plan: nearby events](plans/nearby-events.md) — nearby events, holidays and readiness: rules and PR order.
- [plan: local demand intelligence](plans/local-demand-intelligence.md) — single-path city events, automatic neighborhood discovery, café impact, historical learning and merge-gated PR sequence.
- [admin dashboard merge checklist](admin-dashboard-merge-checklist.md) — admin dashboard review checklist.
- [auth pr133 testing](auth-pr133-testing.md) — authentication testing notes.

### Toast integration — historical phase runbooks (NOT current operating authority)

These PR1/pilot documents describe past disabled staging, polling, promotion and early migration states. They are preserved for investigation **only**; do not use their flags, cadence, migration instructions, source-readers or “not yet implemented” claims as current deployment instructions. For live current/target distinctions use [POS0a's start-here discrepancy and source-to-reader card](plans/toast-standard-api-coverage-matrix.md#start-here--durable-agent-handoff-and-conflicts-index-2026-11-07) and [binding POS rules](rules/pos-data.md); use actual code and deployed SQL to verify current behavior. `toast-net-sales.md` retains useful historical accounting explanation, not a second calculation authority. The original runbooks have **not** been deleted or their migration instructions applied.

- [toast runbook](toast-runbook.md), [toast net sales](toast-net-sales.md), [toast polling](toast-polling.md),
  [toast order queue](toast-order-queue.md), [toast database tests](toast-database-tests.md),
  [toast labor staging](toast-labor-staging.md), [toast promotion guard](toast-promotion-guard.md),
  [toast first cafe readonly pilot](toast-first-cafe-readonly-pilot.md),
  [toast consolidation first restaurant smoke checklist](toast-consolidation-first-restaurant-smoke-checklist.md).
- PR notes kept for context: [toast implementation pr1](toast-implementation-pr1.md), [toast pr-h](toast-pr-h.md),
  [toast pr63 final verification](toast-pr63-final-verification.md), [toast stabilization 63](toast-stabilization-63.md),
  [toast adapter dependent](toast-adapter-dependent.md), [toast pilot dependent](toast-pilot-dependent.md),
  [toast webhook dependent](toast-webhook-dependent.md).

**Current source caveat:** [generated data dictionary](data-dictionary.md) still repeats an old “daily capture” source claim from `lib/data/canonical/dictionary.ts`. The [notes footer](data-dictionary-notes.md) flags the defect; only POS0e can correct the dictionary source and active migrated SQL under separate owner approval. `seen_run_id` also remains active despite an old retirement plan. Neither is safe to delete by documentation.

**Investigation capture:** [.github/workflows/toast-diagnostic-capture-manual.yml](../.github/workflows/toast-diagnostic-capture-manual.yml) is manually invoked diagnostics only; automatic `toast-raw-capture-daily.yml` and its CLI entrypoint were retired. `toast_raw_samples` rows remain a legacy diagnostic data-cleanup task until the POS0e/0f reader cutover and dependency proof.

## Background (may be outdated; not instructions)
- [team collaboration (Oct 15)](team-collaboration.md) — older human-only workflow; AGENTS.md current parallel/auto-merge rules win.
These describe earlier designs, phases or single PRs. Read them for context only. Never implement from them
when they conflict with AGENTS.md (for example personas as separate agents, P1/P2/P3 pipelines, or bans on
chat-first features).
- [07 build plan](07-build-plan.md) — original milestone plan.
- [09 ai native operating system](09-ai-native-operating-system.md) — early operating-system architecture notes.
- [supervisor phase2 engine boundary](supervisor-phase2-engine-boundary.md),
  [supervisor phase5 owner rules](supervisor-phase5-owner-rules.md),
  [supervisor phase6 voice attachments](supervisor-phase6-voice-attachments.md),
  [supervisor phase7 whatsapp](supervisor-phase7-whatsapp.md),
  [supervisor phase8 supplier intelligence](supervisor-phase8-supplier-intelligence.md).
- [olivia pr4a domain capabilities](olivia-pr4a-domain-capabilities.md),
  [olivia pr4a 2 whatif capability](olivia-pr4a-2-whatif-capability.md),
  [olivia pr4b a command capabilities](olivia-pr4b-a-command-capabilities.md).
- [p1 authoritative revisions](p1-authoritative-revisions.md).

## Historical (do not implement)
- [Toast storage Nov 3 plan](plans/toast-storage.md) — **historical architectural intent**. Its “retire `seen_run_id`” text was **not** the final deployed contract: current `toast_archive_order` and `toast_records_for` still use it. Consult [#398 discrepancy register](plans/toast-standard-api-coverage-matrix.md#start-here--durable-agent-handoff-and-conflicts-index-2026-11-07); never remove existing history/reader fields without D3 consumer/rollback proof.
- [Progress before November 5 cleanup](history/progress-snapshot-2026-11-05.md) — all old checkboxes and detailed work preserved; not today's task status.
- [Earlier universal Supervisor proposal](history/universal-supervisor-initial-proposal-2026-11-05.md) — original detailed draft superseded by the compact queue and task briefs.
- [supervisor-conversational-investigation.md](history/supervisor-conversational-investigation.md) — retired design.
- [supervisor-phase4-grounded-chat.md](history/supervisor-phase4-grounded-chat.md) — retired design.
- [supervisor-experience-responses.md](history/supervisor-experience-responses.md) — retired design.
- [supervisor-phase3-conversations.md](history/supervisor-phase3-conversations.md) — retired design.
- [supervisor-pr108-readiness.md](history/supervisor-pr108-readiness.md) — retired design.
- [progress-2026.md](history/progress-2026.md) — archived prior progress and checklists.
- [supervisor-platform-architecture.md](supervisor-platform-architecture.md) — retired historical design retained in place and marked RETIRED.
