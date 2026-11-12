# Muse → GitHub: owner speech as authenticated operational commands

**Owner decision:** "If the owner says something, GitHub should follow it. I should be able to write it through Muse. No hashtags." [Exact approved source/field and path plan](https://github.com/killbill2792/aicafe/issues/411#issuecomment-6815051832).

The single source of truth remains `killbill2792/dave-task-queue/dispatcher/state.json`. The existing Git-CAS ledger and GitHub dispatcher remain the only authoritative writer; the original Tasks and handoffs screen is the only owner task table. The existing Muse GitHub identity is delegated to relay the actual owner instruction through the *existing* `owner_instruction` receipt, authenticated by GitHub commit actor and receipt filename.

## Muse instructions (no hashtag, no template)

When owner says "Set Task 9 priority to 90" or "Recheck Task 10", Muse writes exactly:
```json
{"kind":"owner_instruction","event_id":"unique-id-1","target":{"task_id":"9"},"text":"Set Task 9 priority to 90","submitted_at":"<actual UTC ISO>"}
```
Use the real named task and the owner's **verbatim words**. `event_id` must be unique for each new owner utterance and stable across retries of the *same* utterance. Use `node scripts/dev-dispatcher/receipt-identity.mjs < receipt.json` to obtain the exact filename. Commit to `dispatcher/receipts/<filename>` in the private queue with the existing authorized SSH Git writer. Wake the existing `dispatcher_owner_instruction` repository dispatch. Wait for `state.owner_instruction_events[event_id]` status and reason, then report the outcome to owner. Do NOT mutate `dispatcher/state.json` or the public Pages output yourself. Do not fabricate "owner said" when the instruction did not come from the owner.

Muse may also translate the owner's ordinary language into an optional **typed receipt command** when the owner did not use one of the example phrasings. The owner never needs to see or type JSON. Example: owner says "Please move my rolling memory task ahead of the other work"; Muse writes the original verbatim `text` plus `"command":{"type":"control","task_id":"9","field":"dispatch_priority","value":85}` and the same target `{"task_id":"9"}`. GitHub validates allowed operation/value/target and the authenticated courier. If the owner's words already unambiguously specify a recognized operation, the structured interpretation must match them or GitHub records BLOCKED. No unsupported operation can be smuggled in via the JSON field.

For a safe PR recovery, the optional command is `{"type":"recovery","intent":"REQUEST_CODEX_IF_ELIGIBLE","task_id":null,"pr_number":442}`; GitHub resolves the task and exact current PR head from its own ledger. Other permitted recovery intents follow the existing `recovery-v3.mjs` allowlist; the courier cannot supply its own CI/Codex result or merge authorization. If the PR is not linked, GitHub responds `BLOCKED:pr_not_linked_to_task`. The correct next step is to repair the authoritative PR association, not to guess its head.

**Important owner approvals:** If the owner answers a pending specific scope/proposal decision, Muse must use the *existing authenticated `owner_reply` receipt* with the exact target and original owner's words, not reinterpret the decision as an owner control. The existing signed scope-plan approval validation remains in force. Unsupported new operations must be recorded BLOCKED with a reason; they must not silently disappear. The user never needs a hashtag; selecting the appropriate existing receipt kind is Muse's job.

GitHub recognizes ordinary statements:
- `Set Task 9 priority to 90`
- `Pause Task 9` and `Resume Task 9`
- `Add note to Task 9: <actual note>`
- `Set stall timeout to 10 minutes`
- `Set escalation timeout to 15 minutes`
- `Recheck Task 10` / `Reconcile Task 10`, also `Refresh the dispatcher`
- `Request Codex review for PR 444`
- `Retry CI for PR 444`
- `Merge PR 444 if eligible`
- `Verify integration for Task 10`

The parser is deterministic, with no special owner hashtag or slash command. It recognizes one clear operation. If the request is ambiguous/unimplemented, GitHub records `BLOCKED` plus the reason so Muse can ask for clarification or a scoped extension, instead of silently doing nothing.

## Exact state keys

- Inputs: existing private receipt `kind, event_id, target, text, submitted_at`, authenticated GitHub commit actor via existing `inspectReceipts`.
- Records: `owner_instruction_events[event_id] = {target, text, courier, at, status, reason, command_kind?, control_revision?, recovery_request_id?}`.
- Owner mutable fields: existing `owner_controls.per_task[task_id].dispatch_priority / pause_new_dispatch / note` and `owner_controls.monitoring.stall_minutes / escalation_minutes` (CAS `revision`, history).
- For GitHub facts, existing `recovery_requests[request_id]` via `recordRecoveryEvent` with exact task ↔ PR ↔ SHA identity where eligible; never overwrite PR, CI, Codex, acceptance, merge facts.
- Public Pages projection: only allowlisted owner-control priority/pause and *event status*, timestamp, bounded reason code. **No verbatim instruction or note text** is published. The actual note remains private.

## Authority and failure

The authenticated Muse commit actor is the delegated courier identity; self-claimed owner text in an unverified comment/receipt has no authority. Only the existing supported owner controls and recovery gates can be invoked. Signed scope, CI, Codex, integration, merge and production-effect gates cannot be bypassed with an arbitrary sentence.

Results: `APPLIED` (control saved), `REQUESTED` (GitHub wake recorded, execution not yet verified), `BLOCKED` (no safe supported operation; explicit reason), `RECORDED` (valid chat URL registration only). Muse reports the real result and keeps the same event ID on retry. Retry never applies twice.

## Verification

Realistically simulate verified and unverified GitHub courier receipts, duplicate event, target mismatch, stale PR/head, wrong actor, unknown task, unsupported requests, private note leakage, and ledger current revision. Run targeted Node tests, full CI and final-head Codex. Only a real trusted-main/private-Git readback and a Muse-host receipt proves delivery after merge. No paid/live provider tests or production effects.
