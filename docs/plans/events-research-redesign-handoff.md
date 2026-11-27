# Events redesign — research continuation handoff

Owner decision (2026-11-26): redesign Events separately. This is a discovery-only draft, not an implementation or release; do not merge it as a completed Events redesign.

## Finding
PR #585 migrates event planning, change alerts and final reports to the shared `runResearchTurn` engine via `lib/events/eventResearch.server.ts`. The adapter still has a physical execution deadline (`args.executionDeadline ?? Date.now() + 110_000`) and no continuation port. A physical interruption can cause the event research to retry rather than restore the already-admitted transcript and completed tool evidence. This is not a cumulative model budget; it is a hosting slice limitation. Owner chat, routines and alert/operating-task investigations have checkpoint continuation. `lib/ai/research/backgroundContinuation.server.ts` scopes existing checkpoints by source type, source ID, thread, revision and lease token; event types are not currently covered.

## Redesign acceptance criteria
- Reassess the entire Events experience with the owner before implementation; do not assume existing event workflow design is final.
- If event-specific research survives the redesign, use the common research engine, scoped SQL and durable checkpoint/resume rather than introducing a second research stack.
- Persist transcript, completed tool evidence, pending calls and presentation state; fence writes by business/source identity, revision and lease; revoke or discard stale/deauthorized work. Incomplete in-flight provider calls may retry; completed calls must not be repeated.
- Preserve owner authorization for effects and tenant isolation; avoid artificial cumulative time, call, token or confidence gates.
- Test interruptions and resume for every retained event research workflow, duplicate delivery, stale revisions, cancellation, concurrent leases, and tenant isolation. Verify generated text and structured presentation, and report measured usage. Do not claim live-provider or production proof without authorized execution.

## Dependency
Review #585 and #586 once merged; rebase this discovery branch on current main before implementing. No runtime changes in this draft.
