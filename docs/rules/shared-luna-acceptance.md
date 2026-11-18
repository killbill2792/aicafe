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

An owner can authorize a test by posting a NEW comment in the existing
feature PR, without navigating to Actions or opening another testing PR:

    /aicafe-luna pr <exact-40-hex-PR-head> 13d 0.20

After merging, an owner can run a mainline scenario by commenting on any
PR (including a merged PR):

    /aicafe-luna main <exact-current-main-sha> 13c 0.20

The trusted host checks the owner's GitHub identity, exact source head,
live unchanged owner comment, and bounded price before authorizing any
provider access. For owner comments, a trusted GitHub-only authorization job
first checks all existing consumption records, then writes one durable
github-actions[bot] consumption marker tied to the original comment ID and
exact workflow run ID. The paid job has **read-only GitHub permission** and
verifies that exact marker and the live, unchanged owner comment again
immediately before starting the key-isolated provider broker. Duplicate
events, replayed runs, revoked comments, stale commits and failed or
uncertain consumption are fail-closed. A deleted or edited comment is not usable. The original
manual owner-only workflow_dispatch on trusted main is still supported.
Both entry points use the same non-replayable, isolated runner. For PR work
the SHA must be its current same-repo head; for merged integration,
it must be current main. Each scenario runs separately
with disposable local Supabase, a real registered Supervisor and
gpt-6-luna Responses, the existing capped trusted host broker, and
independent host attestation. Candidates receive only a fake provider key,
a disposable local DB and a limited proxy; never the real provider key,
a write GitHub token, or access to production cafés.

**Price guard:** the trusted broker reserves at most $0.18 and
18 provider calls **per scenario**. The manual workflow additionally has a
required cumulative max_budget_usd input, defaulting to **$0.20**. A single
13C or 14B test fits; selecting ALL on current main would require an explicit
increase to at least $0.36 for two scenarios. At most 20 cases are supported,
and any combined ceiling must be approved anew for that dispatch (maximum
$3.60 for 20 cases). The host refuses an over-budget selection before any
provider access. GitHub Actions serializes this workflow's paid launches in
a single non-canceling FIFO concurrency group with queue: max; no overlapping
paid jobs within this new runner. The GitHub queue can hold up to 100 waiting
runs, and it is not a global finance budget across legacy workflow families.
One fresh owner command or manual dispatch authorizes one bounded run;
reruns fail before provider access. Actual billed usage can be lower than the reserved ceiling.
CI, Codex and browser tests remain free of provider calls.

Source: current exact candidate Git tree. One record per scenario is a
manifest at .github/luna/scenarios/<scenario-id>.json. Before running any
candidate install or test code, the trusted host snapshots that exact
Git-committed manifest into a separate protected file. The candidate can only
read the frozen copy; host attestation uses the very same snapshot even if
the candidate later edits its checkout. Separately, before any untrusted
candidate install/test executes, the trusted host records SHA-256 hashes and
symlink targets for every Git-tracked source file. Later checks use only Node's
non-executing file reads: **Git is never invoked by the trusted host on a
candidate-controlled checkout after candidate execution**, so a malicious
.git/config fsmonitor cannot execute on the host. Both candidate Docker
stages mount their .git directory read-only. Changes to any tracked source
fail closed, except the specifically approved Task14B rolling
supabase/seed.sql regeneration during no-secret preflight; the trusted
coordinator independently derives the full expected SQL bytes from its own
reviewed `scripts/seed/cafes.mjs` + `seedSql.mjs` sources, lazily imported
**only by the trusted-host snapshot command** (not at module startup, since
candidate Docker mounts only the shared runner file), the canonical latest
closed day, and the fixed 14-day window. The host compares SHA-256 of the
candidate-generated seed against the independently generated SQL **before**
approving the refresh. An arbitrary candidate-mutated generator's SQL is
rejected even if it restores all tracked source files afterward. The approved
exact byte hash is then frozen before any provider access and must remain
unchanged through database reset and attestation. This exception never
applies to another scenario. Changing a feature
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

Place a genuine registered-Supervisor journey in the feature PR.
The common runner accepts a Vitest .live.test.ts case (engine: vitest), or
a localhost Next.js/owner-browser scenario in
evals/acceptance/live/<name>.mjs (engine: node-server). Node-server cases
receive --output /proof/<id>-proof.json and
--scope-output /proof/<id>-scope.json; the real app runs in the same disposable
Docker. Vitest cases write those files to test-results/acceptance/.
Either mode must run **only** when AICAFE_SHARED_LUNA=1, with local disposable DB,
and produce test-results/acceptance/<id>-proof.json containing
head_sha, observed_model gpt-6-luna and status passed, plus
test-results/acceptance/<id>-scope.json containing test-scoped IDs and
expectedProviderCalls matching the host broker. Leave the disposable evidence
rows in place until the independent host attester reads them; the workflow
destroys the entire local database after verification.

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
      "name": "foreign-cafe-source-not-written", "kind": "isolation",
      "table": "public.operating_tasks",
      "where": {"business_id": {"scope": "otherCafeId"}, "id": {"scope": "taskId"}},
      "minCount": 0, "maxCount": 0
    }
  ]
}
~~~

Every generic scenario needs at least two actual model-selected registered
tools and at least source, owner and isolation host SQL checks. An isolation
readback proving no source row was written for another cafe is NOT a
cross-cafe RLS/access-denial test: the actual authenticated foreign-cafe
denial must also be executed separately inside that feature's acceptance
test and its negative receipt independently reviewed. Scope values are
restricted to safe literals and SQL reads are performed by the trusted
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
3. When the AI feature is stable and free CI is green, the owner posts
   /aicafe-luna pr HEAD_SHA SCENARIO 0.20 on THAT SAME PR, or selects
   GitHub Actions > AI CAFE Shared Owner-Gated Luna Scenarios > Run
   workflow on main and supplies matching inputs. The owner comment
   or manual dispatch is the paid approval. It must be independent of
   untrusted candidate code. Codex final-head security review and verified
   model evidence are both required before merging active AI behavior.
4. For one coordinated run of all registered merged-main scenarios, use
   /aicafe-luna main HEAD_SHA all 0.36 (currently two scenarios), or
   manually dispatch with pr_number=0, scenario=all, and a sufficient
   explicitly approved max_budget_usd. A $0.20 grant will NOT run
   these two tests together. Unmerged or unregistered cases remain NOT_PROVEN.
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

The new AI CAFE Luna Scenario Integrity workflow runs
node scripts/acceptance/shared-luna.mjs validate-all on every scenario
change, rejecting missing test entrypoints, invalid manifests and symlinks,
at zero provider cost. It never grants paid authority to PR CI.
