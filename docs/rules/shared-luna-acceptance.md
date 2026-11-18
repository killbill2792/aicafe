# Shared Luna acceptance — one trusted runner for parallel feature PRs

## Owner-approved design

Owner request (Nov 17, 2026): keep parallel feature PRs coding while avoiding
a separate PR merely to authorize every feature's paid real-Luna test. Keep
genuine first-party feature acceptance before merging active AI behavior and
add separate grouped/cross-domain integration proof later. Do not run paid
Luna on every push. No new production data source, table, operator agent,
authorization bypass, or development dispatcher is introduced.

The single trusted entry point is GitHub Actions:
**AI CAFE Shared Owner-Gated Luna Scenarios**
(.github/workflows/ai-cafe-luna-shared.yml).

One manual owner-only workflow_dispatch on trusted main selects an exact SHA
and an individual scenario ID or ALL registered scenarios. For feature work,
the SHA must be the **current head** of that same-repo open owner PR; for
merged integration, it must be **current main**. Each scenario runs separately
with disposable local Supabase, a real registered Supervisor and
gpt-6-luna Responses, the existing capped trusted host broker, and
independent host attestation. Candidates receive only a fake provider key,
a disposable local DB and a limited proxy; never the real provider key,
a write GitHub token, or access to production cafés.

**Price guard:** existing trusted broker MAX_CALLS=18 and
MAX_RESERVATION_MICROS=180000 per scenario; that is up to $0.18 reserved
per scenario, and up to $3.60 reserved for a maximum 20-case ALL run.
All cases run sequentially within one workflow run. One owner manual
dispatch authorizes one bounded run; GitHub reruns fail before provider
access. A fresh manual dispatch is a fresh, explicitly owner-approved grant.
Actual usage may be less. CI, Codex and browser tests continue free of
provider access.

Source: current exact candidate Git tree. One record per scenario is a
manifest at .github/luna/scenarios/<scenario-id>.json. Changing a feature
PR adds or changes only its own manifest + genuine live test. GitHub
run ID + exact head + scenario and sanitized host artifact identify proof.
No new database table or private-owner data store. Private prompts, source
IDs, tokens, and customer/employee records must not enter public artifacts.

## Existing real-Luna journeys reused

- **13c**: existing registered staff decline/follow-up journey, with the
  previously proven independent trusted 13C host DB/source/owner oracle.
- **14b**: existing multi-turn purchasing and authenticated owner click,
  with its trusted provider/tool and objective candidate test oracle.
  It does not, by itself, prove Task17C autonomous integration.
- **13d**: the trusted 13D host attester was extracted from the existing
  draft #513. The feature #508 can add 13d.json in the SAME feature PR.
  Until registered, 13D remains NOT_TESTED, not a silent passing case.
- **New feature PRs** such as 14C: put a generic declarative scenario
  manifest and the real Vitest test in that PR; do not copy a workflow,
  broker or authorization file into a second PR.

## Add Task13D to the existing #508 PR

Add this file: .github/luna/scenarios/13d.json

~~~json
{
  "id": "13d",
  "mode": "legacy",
  "engine": "vitest",
  "entrypoint": "lib/ai/supervisor/routines/staffCoordination.live.test.ts",
  "proof": "13d-live-proof.json",
  "scope": "13d-live-scope.json"
}
~~~

The existing 13D test supplies the two named JSON proof/scope files from
test-results/acceptance. The trusted host checks actual provider tools,
dated leave source, owner messages, migrated DB rows, permissions, quota,
and negative no-unapproved-effect cases.

## Add any new real-Luna feature scenario without a runner PR

Place a genuine registered-Supervisor Vitest journey in the feature PR.
It must run **only** when AICAFE_SHARED_LUNA=1, with local disposable DB,
and produce test-results/acceptance/<id>-proof.json containing
head_sha, observed_model gpt-6-luna and status passed, plus
test-results/acceptance/<id>-scope.json containing test-scoped IDs and
expectedProviderCalls matching the host broker.

Add a manifest in the same PR. Example only (replace with feature-specific
reviewed sources and expected results; NOT itself proof of any capability):

~~~json
{
  "id": "example",
  "mode": "generic",
  "engine": "vitest",
  "entrypoint": "lib/ai/supervisor/routines/example.live.test.ts",
  "proof": "example-proof.json",
  "scope": "example-scope.json",
  "expectedTools": ["get_investigation_source", "get_schedule"],
  "assertions": [
    {
      "name": "canonical-task-source", "kind": "source",
      "table": "public.operating_tasks",
      "where": {"business_id": {"scope": "businessId"}, "id": {"scope": "taskId"}},
      "minCount": 1, "maxCount": 1
    },
    {
      "name": "owner-was-updated", "kind": "owner",
      "table": "public.ai_messages",
      "where": {"business_id": {"scope": "businessId"}, "role": {"eq": "supervisor"}},
      "minCount": 1, "maxCount": 10
    },
    {
      "name": "foreign-cafe-cannot-read-source", "kind": "isolation",
      "table": "public.operating_tasks",
      "where": {"business_id": {"scope": "otherCafeId"}, "id": {"scope": "taskId"}},
      "minCount": 0, "maxCount": 0
    }
  ]
}
~~~

Every generic scenario needs at least two actual model-selected registered
tools and at least source, owner and isolation host SQL checks. Scope values
are restricted to safe literals and SQL reads are performed by the trusted
host against actual migrated local PostgreSQL, NOT by trusting the
candidate's assertion that it checked the DB. Codex must review each new
scenario oracle: an inadequate candidate-supplied expected result is NOT
a proof of business correctness. Add further permissions, idempotence,
revocation, failed-transport, effect, screen and owner approval tests as
applicable. Generic host attestation proves model identity/tool selection
and specified DB assertions, **NOT independent owner browser or full
Task17C autonomy**; separate actual Playwright/browser/effect receipts
remain required where relevant.

## Run one scenario or all scenarios

1. Merge the **one shared infrastructure PR** after normal exact-head CI
   and clean Codex. Until then the new workflow is not available from main.
2. A feature developer keeps working on their existing PR and adds only
   the matching scenario manifest + live test. Normal CI can stay parallel.
3. When the AI feature is stable and free CI/Codex are green, the owner opens
   GitHub Actions > AI CAFE Shared Owner-Gated Luna Scenarios > Run workflow
   (select main). Supply current PR head SHA, PR number and scenario ID.
   This is the single manual paid approval. The exact-head test runs.
4. For **one coordinated run of every registered scenario already on
   merged main**, supply the CURRENT main SHA, pr_number=0 and
   scenario=all. The runner discovers and executes all registered cases.
   Cases from PRs still unmerged are not in main and are NOT_PROVEN.
5. A combined 13A/B/C/D journey is its own case using the entire app
   and tools; similarly for Task14 and cross-domain 13+14. ALL executes
   the inventory, but is **not itself** an inter-feature scenario.
   Task17B must fail on unregistered supported capability gaps and Task17C
   must exercise unattended cross-domain restart/approval/recovery before
   integrated_proven can be claimed.

Each verified receipt is bound to scenario + exact SHA + owner run/job
and sanitized host artifact. Green CI or merely merging does not equal
genuine real-model feature_proven; group/Task17/released_proven remain
separate statuses. No automatic retries of failed paid calls.

## Active PR guidance and migration

- #508 Task13D: add 13d.json in the SAME feature PR and rebase after its
  parent #501 is on main. Do not edit the trusted shared workflow.
- #513 Task13D runner: pause the duplicate paid-workflow copy, preserve any
  unique security tests and integrate them into the same feature/foundation
  review. Do not close or merge based on this document alone.
- #502 Task14C / #515 test foundation: keep independent owner Gmail
  click/receipt and simulator safety; put the new real Luna scenario
  and its source/owner/isolation oracle in the feature PR. Generic DB
  assertions do not replace independently attested provider delivery/UI.
- POS0e/POS0f / 15A: existing deterministic or separately paid tests do
  not automatically become registered shared Luna cases. Migrate only
  actual provider-backed cases with equivalent accepted host attestations;
  mark missing scope NOT_PROVEN.

The older specific paid workflows are intentionally left unchanged while
transitioning, to preserve prior one-shot authorizations. After the new
shared route has actually passed its real exact-head host acceptance and
Codex has reviewed security, the owner can retire duplicate triggers in
one small deletion PR, without ever replaying old grants.

## No-cost integrity checks

Run:
- node --test scripts/acceptance/shared-luna.test.mjs
- node --test scripts/acceptance/task14b-broker.test.mjs

The new AI CAFE Luna Scenario Integrity workflow checks scenario changes
at zero provider cost. It never grants paid authority to PR CI.
