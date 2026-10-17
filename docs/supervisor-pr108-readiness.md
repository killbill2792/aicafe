# Supervisor PR #108: completion and verified limits

This PR connects Olivia's existing what-if service to the default-on Supervisor read/simulation path and completes the pending review fixes. The follow-up also exposes all five existing Alex recipe-change types through owner-usable ingredient names. It does not complete the separate proposal/approval/execution or proactive roadmap phases.

## What is connected in code

- The model audits the owner's clauses and selects from compiled, authorized capability schemas. P1 readers, Alex pricing, Olivia scheduling and the registered expression evaluator participate in the existing default-on P3 path. There is no new question/keyword router or stored-answer catalog.
- The generic expression evaluator supports novel combinations of registered operands and owner hypotheticals, with units, exact cents, source/tenant/period checks, bounded operations and canonical calculation primitives. Existing COMPOSE regression tests exercise this through the Supervisor entrypoint.
- A domain declares that its result is an owner-parameterized simulation. The central Supervisor no longer keeps a specialist-ID whitelist for those results. Plain current-state reviews/previews retain their different contract.
- Olivia supports temporary unavailability (including a time window), weekly minute caps, daily minute caps, multiple workers, and optimizer objectives. Names are resolved against the authenticated roster; the simulation snapshot must still contain one unique matching name. Every read must match the Supervisor's selected café. Explicit owner dates and named weekdays constrain the simulated date before data reads. Worker names must appear in the audited owner clause; ambiguous/name-free follow-ups need clarification rather than guessed identity.
- Olivia reports the optimizer's actual selected objective, coverage and cost differences, modeled wage differences and owner minutes. Salary allocation, estimated labor, unverified legal review and additional planner caveats are labeled. Long worker names and multiple overrides cannot truncate result fields/caveats.
- Alex supports selling-price replacement/delta, target cost ratio or ingredient margin, ingredient-cost multiplier, absolute unit cost, supplier package cost/count/unit, ingredient substitution and recipe quantity. P3 ingredient changes require exact names, not invented UUIDs. Resolution and calculation use the same authorized snapshot; a changed final source epoch invalidates the result. Missing, duplicate and truncated ingredient catalogs fail closed.
- Recipe and scheduling what-if parameters are presented using EN/ES/AR catalogs. Results remain hypothetical/provisional, with no schedule, price or recipe writes.

## What “ask anything” means here

There is no finite list of accepted questions. New wording and new safe arithmetic combinations can use registered evidence and primitives without a new developer-written question branch. This does not provide unrestricted access to every database column, every external source or every imaginable operation. Typed source contracts are the authorization and correctness boundary. Adding a genuinely new data source or domain operation still requires a reviewed adapter; it must not be improvised by an LLM.

Existing limits remain: USD-only P3, bounded clauses/read/calculation budgets, supported quantities/units, owner access and valid source evidence. Current/hypothetical recipe prices do not establish historical option-level sales or profit. Missing burden, wage, demand, inventory or option-mix evidence must remain missing. Ambiguous dates/names require clarification. This PR does not build general web research, legal advice, supplier purchasing, payroll changes, autonomous publishing, universal effect execution or future P4/P5/P6 work.

## Production readiness

Code integration and deterministic tests are distinct from a live production acceptance. The execution environment has no configured live OpenAI key or authenticated staging/production café. Provider behavior, deployed database/RLS/RPC readiness, conversation persistence and actual owner browser use therefore cannot be certified here.

For a release, independently review the final diff and final-head CI, then use an authorized test café to verify: persisted owner conversation; named weekday and explicit-date scheduling requests; a multi-worker scenario; ingredient substitution/quantity/package scenarios; a novel cross-domain expression; missing-source clarification; non-owner/cross-tenant denial; EN/ES/AR output. Confirm the existing Supervisor/provider/Supabase and scheduling prerequisites without treating a successful build as evidence of live configuration. No new migration, flag or dependency is required by this PR.

Repository workflow requires independent human review and owner-authorized merge. Production migrations/settings/deployment remain separate explicit owner gates. Neither merging nor production activation is performed by this completion task.

## Validation recorded for this completion

Original locked dependencies installed successfully, including xlsx. Final local full suite: **1,533 passed, one pre-existing skipped test, 192 files**. Strict TypeScript, changed-file ESLint, production build and whitespace checks passed. The provider smoke script reported NOT RUN due to missing `OPENAI_API_KEY`; no live-provider pass is claimed. Final-head GitHub workflow conclusions must be read from the PR checks independently of these local results.
