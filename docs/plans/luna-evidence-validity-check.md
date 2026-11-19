# Automated Luna evidence validity — implementation contract

Owner request: stop paid real-model retesting merely because another PR lands.
Reuse the existing shared owner-gated runner (#520), not a new dispatcher or
a second production/approval mechanism. The existing acceptance-quality rule
permits reuse only when every relevant executable behavior and safety path
is demonstrably unchanged. This work must make the decision independently
verifiable rather than trust the candidate agent's judgment.

## Scope and conservative first stage

The comparison module in this draft compares complete Git tree objects
fetched by a trusted caller for the actual tested and new candidate commits.
It checks paths, blob identities, types and modes, including added/deleted
files and gitlinks. Only edits to a small exact list of reviewed documentation
files are provisionally exempt; prove those documents are not runtime inputs
before enabling this policy. No arbitrary directory exemptions or scenario
dependency declaration supplied by the candidate. COMPARISON_ELIGIBLE is
only a tree comparison result, never a verified receipt, merge decision or
authority to spend. IMPACT_CHANGED means independence is not established;
UNKNOWN means missing/incomplete data. Do not run a paid test solely on
either result without owner authorization.

## Required before rollout

1. Authenticate original evidence using the existing shared runner's
   successful first-attempt run/job, owner-approved target, immutable
   scenario-specific sanitized host artifact and original tested commit.
   Read through authenticated GitHub API; never treat an uploaded candidate
   artifact, synthetic fixture, PR text, wrong workflow, expired artifact,
   skipped/failed job or a similar-looking model name as genuine proof.
   Support the existing legacy and generic attestation formats explicitly.
   Verify scenario, model, source, owner authorization and scenario oracle
   provenance. Bind evidence to run/job/artifact identities and validated
   immutable content. Do not replace the original tested SHA with the newer SHA.
2. Run the verifier from independently trusted main, with read-only data
   access and no provider key or candidate execution. Fetch complete tree
   metadata for exact validated commits, not an untrusted claim that paths
   were unchanged. Compare the original attested executable tree, scenario
   oracle, dependencies, schema, prompts, environment/model configuration,
   shared runner and relevant trusted policy to the current candidate.
   Treat incomplete trees, expired or missing proof and unexpected formats
   as UNKNOWN. Separate receipt authentication from comparison eligibility.
3. Expand beyond document-only reuse through a reviewed, sound per-scenario
   dependency model if feasible: include transitive imports, dynamic
   registration, shared authorization/effects, database schema/RLS, prompts,
   package lock, configuration, build inputs and tests/oracles. Default to
   full runtime impact for unknown paths or incomplete dependency closure.
   Never let a feature PR weaken its own dependency classifier to pass.
   A model/prompt, shared agent/tool/approval change or unknown safety impact
   invalidates every affected scenario. Avoid paying for unaffected scenarios.
4. Publish a free independently produced verdict bound to the exact candidate
   and base: VERIFIED_REUSE, FRESH_TEST_REQUIRED, MISSING_OR_UNVERIFIED,
   or NOT_APPLICABLE (only for independently classified non-AI scope).
   Include original tested SHA, current SHA, scenario, evidence link and
   concrete reasons. No provider spend, no auto-review, merge, dispatch,
   owner approval or external product action. Exact-head CI/Codex/security
   requirements remain unchanged. Reevaluate validity when main/head moves.
5. Integrate with the existing acceptance rules/gate and existing Muse
   dashboard once PR #527 is merged; do not create a parallel dashboard or
   touch #527's active files in this initial branch. The collector displays
   verified facts; Muse coordinates final merge order and forwards only
   necessary budget requests. Preserve #520's one-shot owner authorization
   and bound ceilings with no automatic paid retries.
6. Test receipt spoofing, wrong scenario/head/workflow, incomplete pagination
   and trees, changed safety/migration/dependency/oracle/model inputs, missing
   or expired artifacts, unknown paths, cross-PR updates and genuine unchanged
   evidence. Include a no-provider-cost end-to-end regression against actual
   successful historical shared-run artifacts where available. Explicitly
   distinguish historical real-model proof from synthetic validator tests.

## Completion and boundaries

No new product behavior or dependencies on provider calls. No live paid
Luna run required for the checker itself. Do not claim completed automated
acceptance until trusted provenance, no-cost check and enforcement are
implemented and independently tested. Keep this PR draft until those gates
and normal CI are green; request one final exact-head Codex code/security
review and leave infrastructure merge to owner. Live Muse host rollout
requires separately verified import/display. No changes to ongoing feature
PRs or retired dispatcher. Existing valid evidence is not automatically
revoked on this draft's creation.
