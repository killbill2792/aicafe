# Task 15C — Supervisor fleet resilience

Owner approved the architecture, scope and failure matrix in the originating ChatGPT conversation on November 18, 2026, and clarified that each café has its own independent Supervisor; only infrastructure resources are shared. Owner authorized merge only after all necessary tests and clean review. No production deploy, migration application or paid provider invocation is authorized by this document.

## One architecture
Keep the existing durable run worker, routine dispatcher, investigation worker, canonical agent loop, authorization and effect gateway. No new production queue, worker, scheduler or agent. Each café retains its private scope and work identity. Fairness governs shared compute, not agent intent. Preserve the current source of truth and independently verified receipts.

## Storage and invariants
- supervisor_runs and supervisor_run_steps: business/owner/thread/request/run/step identity, fenced lease, attempts, checkpoint and verified receipt; no replay of uncertain effects.
- supervisor_routines and existing occurrence records: schedule/revision/timezone/local-date identity, bounded catch-up only for valid schedules and active authority.
- supervisor_investigations: episode/source/revision identity, evidence, next retry, current permissions and verified closure.
- ai_agent_jobs and existing usage accounting: preserve job identity and cumulative pre-transport reservations across crashes; unknown consumption is not zero.
- supervisor_proposals and supervisor_effect_attempts: existing exact approval, attempt and independently verifiable receipt; no authority expansion.
- operating_tasks and ai_messages: canonical owner-visible status and deduplicated updates. No fabricated source facts or confidential payloads in diagnostics.

## Scope coordination
Task 15C owns resilience, not 15B's maintenance behavior, 15D's security policy, 16C's connector authorization or 17C's independent whole-system test. Active PR #506 overlaps investigation.server.ts; #502 overlaps dispatch.server.ts and scripts/db/run-all.sh. Coordinate before touching these shared files and integrate against main before final review. #524 may add receiving domain behavior; preserve it. No central AI loop or registry change in this initial slice.

## Acceptance (all initially NOT PROVEN)
Real process exit and replacement against persistent disposable DB: R01–R07 enqueue, claim, checkpoint, post-effect, concurrent/stale leases and cumulative budgets.
S01–S05 missed dates, DST, duplicate ticks, revoked/revised schedule and bounded catch-up.
P01–P06 provider timeout, 429, 503, incomplete response, killed paid request, concurrent reservations.
D01–D03 DB interruption, lost commit response and recovery.
E01–E06 connector failure before/after dispatch, unknown receipt, revocation and duplicate/revoked approvals.
F01–F07 3/10/50/100 cafés, 10,000 synthetic items, noisy neighbour, continuous arrivals and poison work.
O01–O05 owner offline, waiting approval, reconnect, source-confirmed closure and notification dedup.
T01–T03 cross-café work/receipt denial and authorization bypass rejection.
H01–H03 stale worker, recovered state and retry-budget exhaustion.

Record real process IDs/exit signal, original work IDs, independent database readback, effect counts, source receipts and budgets. No fake-clock-only restart proof. Separate deterministic tests from real GPT-6 Luna evidence using the existing shared acceptance runner (#520), new feature-only scenario 15c and separately authorized exact-head paid run. No provider spend in ordinary CI. Task 17C remains independent.

## Initial scope
The first change will address recovery starvation in the existing durable worker, without relaxing effect reconciliation. Further approved scope includes existing runs/routines/job/usage/health/projection paths, one additive migration with reserved timestamp, and dedicated feature tests/harness. Record each change and incomplete gate in the PR; no edits to PROGRESS.md. Do not merge until required baseline, actual restart/fleet/Luna evidence and exact-head Codex review pass.
