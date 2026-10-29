# Documentation index

`AGENTS.md` is the single source of agent instructions and the product direction (an AI operator that runs
the café through the Supervisor chat). Start with [AGENTS.md](../AGENTS.md) and [PROGRESS.md — Now](../PROGRESS.md).
If any document conflicts with AGENTS.md, AGENTS.md wins.

## Current docs
- [01 product](01-product.md) — what the operator does, limits for now, and what not to build.
- [02 design system](02-design-system.md) — design, accessibility and localization (binding for UI).
- [03 screens](03-screens.md) — existing screen specifications. New capabilities go to the chat first.
- [04 data model](04-data-model.md) — database entities and policies.
- [05 calculations](05-calculations.md) — canonical math and test fixtures.
- [06 integrations](06-integrations.md) — integrations and data connection guidance.
- [08 pricing engine plan](08-pricing-engine-plan.md) — pricing-engine design and decisions.
- [scheduling architecture](scheduling-architecture.md) — scheduling boundaries and contracts.
- [team collaboration](team-collaboration.md) — human implementer and review workflow.
- [admin dashboard merge checklist](admin-dashboard-merge-checklist.md) — admin dashboard review checklist.
- [auth pr133 testing](auth-pr133-testing.md) — authentication testing notes.

### Toast integration (current)
- [toast runbook](toast-runbook.md), [toast net sales](toast-net-sales.md), [toast polling](toast-polling.md),
  [toast order queue](toast-order-queue.md), [toast database tests](toast-database-tests.md),
  [toast labor staging](toast-labor-staging.md), [toast promotion guard](toast-promotion-guard.md),
  [toast first cafe readonly pilot](toast-first-cafe-readonly-pilot.md),
  [toast consolidation first restaurant smoke checklist](toast-consolidation-first-restaurant-smoke-checklist.md).
- PR notes kept for context: [toast implementation pr1](toast-implementation-pr1.md), [toast pr-h](toast-pr-h.md),
  [toast pr63 final verification](toast-pr63-final-verification.md), [toast stabilization 63](toast-stabilization-63.md),
  [toast adapter dependent](toast-adapter-dependent.md), [toast pilot dependent](toast-pilot-dependent.md),
  [toast webhook dependent](toast-webhook-dependent.md).

## Background (may be outdated; not instructions)
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
- [supervisor-conversational-investigation.md](history/supervisor-conversational-investigation.md) — retired design.
- [supervisor-phase4-grounded-chat.md](history/supervisor-phase4-grounded-chat.md) — retired design.
- [supervisor-experience-responses.md](history/supervisor-experience-responses.md) — retired design.
- [supervisor-phase3-conversations.md](history/supervisor-phase3-conversations.md) — retired design.
- [supervisor-pr108-readiness.md](history/supervisor-pr108-readiness.md) — retired design.
- [progress-2026.md](history/progress-2026.md) — archived prior progress and checklists.
- [supervisor-platform-architecture.md](supervisor-platform-architecture.md) — retired historical design retained in place and marked RETIRED.
