# Consolidated Luna acceptance and evidence validity — owner-approved direction

Owner decision (Nov 18, 2026): each AI-dependent feature PR contributes all
applicable executable real Luna scenarios to the existing shared runner
(#520), but paid execution is not a blanket per-PR coding-merge requirement.
Run them on a stable integrated tree when Task13, Task14, Task15, Task16 or
another functional group is complete, before Task17, or during Task17.
The owner chooses the milestone and approves a bounded paid run. Do not
require a group run merely because a group finished if the owner chooses
to consolidate later. All mandatory cases must pass before release.

## Separate the gates

- Coding PR: implementation complete within approved scope; current-head
  full CI, deterministic/recorded-model regression, real migrated DB,
  applicable authenticated browser tests, security/authorization/tenant
  isolation, clean exact-head Codex, dependency and owner gates; reviewed
  executable registered Luna scenarios, including negatives and expected
  independent source/owner/effect assertions. A feature must not defer its
  implementation, missing deterministic tests, or scenario authoring
  to Task17. No model-free infrastructure claim for changed AI behavior.
- Real model acceptance: scenario-level authenticated provider and host
  evidence on the actual combined code. Group completeness is not proof.
  Report not run as NOT_PROVEN, executed failure as FAIL, verified pass
  as PASS with original SHA. Previous failures remain visible and tracked.
- Production boundary: deferral of paid tests is allowed for DEV integration
  only when independent evidence demonstrates that the changed unproven
  execution cannot reach production, including existing enabled paths,
  autonomous cron/worker, tools, direct APIs, UI, external effects and
  migrations. A flag hidden in UI or an owner-approval card is insufficient.
  If merging to main exposes changed unproven behavior, do not merge it
  there under the deferred policy: use an owner-approved isolated
  integration branch or equivalent enforced release boundary, or satisfy
  the existing live acceptance gate. No production deployment/activation
  or new environment is authorized by this PR. Do not change live Vercel
  settings or production migrations implicitly. Verify actual host/branch
  routing and executable negative tests before enabling policy in main.
- Task17B/17C/17D/17E preserve complete registered scenario coverage,
  cross-domain autonomy, real restart/effect/owner evidence, UI and
  independent release signoff. No unproven feature release.

## Scenario inventory and scheduling

Use the existing .github/luna/scenarios/<id>.json inventory and same
production-model test harnesses. Every AI-dependent PR supplies the
applicable cases (including existing scenario upgrades when it changes
shared behavior), reviewed assertions, exact entrypoints, task/group
ownership, prerequisite and a stable coverage mapping. Preserve the
existing runner authorization, immutable approved SHA, host attesters and
cost ceilings. Scenario IDs do not prove coverage: compare the registered
capability/effect inventory and approved task requirements to executable
cases; missing mapping, deleted/disabled scenario, missing entrypoint,
weakened oracle or untested supported capability must fail closed.
Collect all positive/negative/correction/unknown/source/permission/
idempotence/recovery cases as applicable. Existing scenarios must not be
deleted just because a PR is allowed to defer spend.

Reuse existing scenario integrity and owner-journey gates; extend the
trusted existing validation, not a new scheduler. Support selecting a
group or a bounded explicit subset on one frozen integration/main SHA
(where authorized and safely isolated). ALL is inventory execution,
not proof of cross-feature journeys. Add genuine cross-feature cases for
the complete group, and Task17C cross-group cases. Preserve the trusted
runner's one-shot grant and aggregate/per-scenario ceilings; partition
large runs explicitly within existing limits, no automatic paid retries.
Show selected cases, expected upper reservation, existing verified
receipts, failed/invalidated/missing cases and reason before the owner
authorizes. No coding agent or Muse chooses proof validity by assertion.

## Shared engine failure handling

Before a paid batch, run no-provider-cost checks on the combined actual
model request envelope, tool registry, prompt/config, input and output
ceilings, reasoning/final reserve, budget/call/time enforcement,
incomplete responses, safe fallback, quota/replay and effect guards.
Measure sanitized real-token usage, tool selection, latency, cost
reservation and classified failure from trusted existing host evidence.
Group common failures (e.g. max_output_tokens, request size, provider
budget), preserve actual per-scenario results, repair shared cause once
and re-evaluate impacted cases; do not stage repetitive paid retries
on unfinished or moving branches. Optional early targeted live smoke
requires separate explicit owner authorization, not an automatic gate
for every PR. No guarantee a larger ceiling fixes tool selection.

## Trusted evidence validity

The draft comparator is a conservative first step only: it compares
complete Git tree objects fetched by a trusted caller for actual tested
and candidate commits, checks paths/modes/blob IDs, with narrow exact
reviewed document exceptions (verify no runtime use before enabling).
COMPARISON_ELIGIBLE is not acceptance. Authenticate original successful
first-attempt shared-runner job and scenario-specific host artifact,
owner grant, original exact code/model/oracle provenance, immutable
artifact content and trusted runner identity via read-only GitHub API.
Never trust PR prose, candidate-uploaded artifacts, expired/missing
evidence, wrong scenario/workflow/commit, failure or synthetic tests.
Support legacy and generic attestations. Preserve original tested SHA.

Verify exact candidate and base, complete trees, transitive imports,
dynamic tools, prompt/config, runtime/model settings, schema/RLS,
shared safety paths, lockfiles, fixtures/oracles and trusted runner
changes. Candidate cannot weaken its own impact classifier. Unknown
paths, incomplete dependency closure or unverified receipts fail
closed. Prefer conservative invalidation over falsely reusing proof.
Report VERIFIED_REUSE, FRESH_TEST_REQUIRED, MISSING_OR_UNVERIFIED, or
NOT_APPLICABLE with scenario, group, tested/current SHA, reason and
evidence link. A missing run may be deferred during development; it
cannot pass acceptance or release. No paid retry merely because SHA
changed; re-run the affected scenarios after common repairs.

## Muse integration and scope

The existing collector/dashboard (PR #527) imports independent evidence
and displays group inventory, deferred/failed/passed/invalidated cases,
earliest stable candidate, outstanding mandatory tests and budget
request. Muse coordinates; GitHub is a fact source, no auto-spend,
auto-review, auto-dispatch, auto-merge, second scheduler, DB or agent.
Do not edit #527's active branch. Integrate any shared files after its
merge, preserving its content and compare both parents.

## Completion

This draft sets the approved direction, not an active waiver. Before
rollout: reconcile binding AGENTS/rules/task briefs and independent
checks; implement provenance, inventory, group selection, validity and
release enforcement; verify actual production isolation or owner-approved
separate integration route; add adversarial tests (missing/dynamic
coverage, false receipts, wrong SHA/group, changed safety inputs,
missing/expired artifacts, incomplete reads, budget bounds, fail-closed
release and no-cost real historical artifact verification where available).
Execute exact-head CI, clean Codex code/security and leave infrastructure
merge to owner. Verify real Muse host import separately. Preserve existing
rules until revised policy is safely merged. No paid run for this draft,
no new spend approval, no production changes or feature branch edits.
