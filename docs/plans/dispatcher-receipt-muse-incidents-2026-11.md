# Dispatcher original-receipt recovery and owner-visible Muse incidents

Owner-approved architecture, November 10, 2026. This is a scoped extension of the existing trusted-main dispatcher, not another scheduler, courier, queue, or approval mechanism.

| Boundary | Source fields | Record / key | Behavior |
| --- | --- | --- | --- |
| Signed delivery | Current approved task, scope/approval hash, immutable action ID, prompt hash, approved project/provider/destination | Private ledger `actions[action_id]` | GitHub proposes one signed action. Muse is the only browser courier; no resend when acceptance is uncertain. |
| Original receipt | Authorized GitHub actor and v1 filename `sha256(action_id + ':' + prompt_hash)`, task, approval, project/provider, actual chat URL | Existing private `dispatcher/receipts/<sha>.json` | GitHub validates actor/identity and late receipt against the original signed action even after the PR head advanced. Does not revive a stale continuation or revoked approval. |
| Chat binding | Validated original receipt, current approved task branch and PR | `tasks[id].conversation_ref`, `branch_chat_links[branch]`, `pr_chat_links[PR]` in same ledger CAS | Links original chat once. Later repairs use the same chat. |
| Incident and recovery | GitHub receipt scan/validation and authenticated action transition | `receipt_feedback[action_id]` and deduped `owner_alerts['notice:'+hash]` | One current Muse owner notice: what failed, who is fixing it, whether owner action is necessary; on verified acceptance, resolve the hold and report verified recovery. Missed notice delivery remains planned/visible and eligible for wake. |
| Courier delivery acknowledgement | Authenticated Muse `owner_notice` with notice ID/hash | Existing notice `status='submitted'` plus receipt | A plan is not an actual delivery; do not infer the owner saw it. |

**Transport:** private ledger CAS → existing opaque HMAC public fingerprint (never private prompts or URLs) → Muse already configured to read the private owner-notice queue → one browser owner notification → authenticated private notice receipt → repository-dispatch immediate wake, delayed self-wake as backup.

**Failure envelope:** If GitHub cannot read the private ledger, it cannot truthfully claim it alerted Muse; workflow is red and owner dashboard timestamps remain stale. If Muse is unavailable, the notice remains planned/undelivered in the private ledger and owner dashboard until confirmed. Recovery never re-sends an unknown coding prompt, changes owner approvals, or merges a PR.

**Scope:** shared receipt validator/inbox, receipt feedback, failure/closure notice projection, owner view tests, and courier instructions. No product code, new secrets, deployment, independent watcher or second message channel. All project-specific values come from `.dispatcher/settings.json`.
