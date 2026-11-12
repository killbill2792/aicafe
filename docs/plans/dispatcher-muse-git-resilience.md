# Muse ↔ GitHub dispatcher: durable signed Git recovery

This extends the existing v3 dispatcher; it does not create a second
dispatcher, ledger, scheduler, coding agent, approval authority or dashboard.

## Purpose and transport

GitHub repository_dispatch HTTP 204 proves the **wake was accepted**, not that
its queued workflow started. Pending trusted-main jobs may be replaced by newer
pending jobs. GitHub REST can hit primary/secondary limits, and scheduled actions
can be delayed or omitted.

Muse first persists a signed command by ordinary Git to the **existing private**
killbill2792/dave-task-queue main branch, under:
dispatcher/recovery-requests/<request_id>.json

The existing dispatcher/state.json is still the only authority. A trusted-main
runner reads signed recovery files by Git and reads/writes the ledger by Git.
The existing repository_dispatch is an optional fast wake, not the only record.
Later main pushes, valid GitHub schedules and independent Muse-host wake retries
can process durable requests even after cancellation.

**Limit:** Git-only writes cannot start a GitHub Actions job when GitHub Actions
is down. GitHub REST is still needed for current CI, Codex and PR facts. When the
API is exhausted, Muse can still read/persist its private Git backlog but may
not claim these facts are fresh. Do not blindly repeat API dispatches.

## One-time operator provisioning (never expose secret values)

Generate an independent random signing key with at least 32 bytes of entropy.
Install the same printable secret in GitHub Actions as
DISPATCH_MUSE_RECOVERY_KEY and on the authorized Muse host as
DISPATCH_MUSE_RECOVERY_KEY. Muse also needs MUSE_PRIVATE_GIT_TOKEN restricted to
the private queue repository and DISPATCH_MUSE_ACTOR set to the actual
allowlisted Muse login (currently killbill2792). Existing GitHub
DISPATCH_LEDGER_TOKEN and DISPATCH_COURIER_ACTORS remain in place.

Until the new secret is present on both sides, the old authenticated
repository_dispatch mechanism continues; Git recovery is not operational.

## What Muse writes

Supply only operational fields to the Muse Git CLI. For global reconcile:

~~~json
{
  "version": 1,
  "intent": "RECONCILE",
  "task_id": null,
  "pr_number": null,
  "expected_head_sha": null
}
~~~

From the authorized Muse host:

~~~sh
node scripts/dev-dispatcher/muse-recovery-git-cli.mjs < recovery-command.json
~~~

The CLI fills the pinned repo, configured actor, UTC timestamp, deterministic
SHA-256 request ID and HMAC. It commits a file through non-force Git CAS.
The resulting private file has this structure:

~~~json
{
  "version": 1,
  "request": {
    "version": 1,
    "repo": "killbill2792/aicafe",
    "actor": "killbill2792",
    "intent": "RECONCILE",
    "task_id": null,
    "pr_number": null,
    "expected_head_sha": null,
    "requested_at": "<actual UTC ISO timestamp>",
    "request_id": "<canonical 64-hex hash>"
  },
  "signature": "<64-hex HMAC-SHA256>"
}
~~~

Never invent the hash or signature. A scoped command must include the current
task ID, PR number and exact 40-character PR head SHA. Supported intents:
RECONCILE, MARK_READY_IF_ELIGIBLE, REQUEST_CODEX_IF_ELIGIBLE,
RETRY_CI_IF_SAFE, REFRESH_BRANCH_IF_SAFE, MERGE_IF_ELIGIBLE,
VERIFY_INTEGRATION, CHECK_STALL.

An existing file with the same ID and content is a successful idempotent retry.
A hash collision with changed content fails closed; no force-push is permitted.

The runner verifies the signature, exact repo, allowlisted Muse actor, file
identity, bounded seven-day freshness, live task/PR/head and normal safety
gates. API-dispatched commands continue using their shorter 10-minute TTL.
No command can approve scope, force a merge, fabricate CI or mark integration.

## Where Muse checks acknowledgment

After a successful GitHub run read the PRIVATE ledger:
recovery_requests[request_id] or recovery_rejections[request_id].
PENDING means queued; OBSERVED means the reconcile was observed only;
SATISFIED needs actual GitHub proof; BLOCKED requires repair.
Git push success alone does not imply execution. Preserve the same ID for
retries of the same signed request, and keep API backoff/cooldown after 429/403.
If the receiver's HMAC key is missing, report configuration unavailable.

## Historical merged PR reconciliation

On a bounded hourly audit for approved tasks lacking PR links, the trusted
runner reads recent first-parent merge titles by ordinary Git. It only calls
the PR API for plausible task-specific candidates (maximum five).
GitHub must then verify the owner, exact task marker, same repo/branch prefix,
real main merge SHA, and complete changed-file list.

For Task 10 the actual merged PR is #443. A verified match records technical
merged facts and cancels only that task's unsent obsolete prompts. **Task 9 is
not modified.** If any file is outside the signed scope, an owner scope-audit
notice is created; integration remains unproven. No source comment, code or
label alone is a new owner approval.

## Acceptance before enabling in live use

- Signed Git submit/read against a disposable Git repo, including duplicate CAS
  and tampered signature, stale head, forged actor and seven-day expiration
- Run cancelled or delayed: signed Git request remains and is ingested later
- Owner-only merged PR discovery verified for Task 10 without Task 9 mutation
- Current-head CI and Codex review clean
- Install scoped Muse host Git credential and independent HMAC secret
- Demonstrate real host Git push -> trusted main run -> matching ledger receipt
- Verify the independent Muse watchdog can detect GitHub schedule outage
- Obtain owner-only infrastructure merge and cutover approval

No production database, POS, provider or payment effects are authorized here.


## Automatic Muse-host watchdog mode

The existing muse-watch-v3.mjs host runner now prefers Git only when BOTH
MUSE_PRIVATE_GIT_TOKEN and DISPATCH_MUSE_RECOVERY_KEY are configured.
It writes each eligible recovery intent to the signed private Git inbox before
attempting any REST wake. It sends **at most one** REST repository_dispatch
event of type dispatcher_git_wake (no task or owner command payload) per batch,
and repeats the same lightweight wake only after a 15-minute cooldown if GitHub
has not acknowledged the original signed files. The old authorized API-only
route remains the fallback until the host keys are provisioned.

An HTTP 429/403 with confirmed quota exhaustion does not prevent Git queue
persistence. The watchdog retains local retry/backoff state, does not claim
GitHub execution from an accepted API request, and reads the private
recovery_requests/recovery_rejections fields for eventual acknowledgments.
If the Git push itself is uncertain, it retains the command in the local
backlog. Neither Muse nor GitHub changes any owner approval to recover it.

Run the existing host watchdog with its current positional arguments
(ledger snapshot path, local backlog path, optional queue path). Its existing
MUSE_GITHUB_WAKE_TOKEN is optional for the fast API wake. Do not provision
the GitHub Actions signing secret to any untrusted PR runner or browser page.
