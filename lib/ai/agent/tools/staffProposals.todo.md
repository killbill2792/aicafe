# Staff owner-approval proposals — deliberately gated

Verified against `main` at `aa5bbc8a` (PR #158 merged).

## Approval infrastructure actually present

- `supervisor_proposals` and a revision-locked approval engine exist.
- `SupervisorProposalCard` is **price-specific** (`productName`, old/new cents).
- `/api/ai/threads/[threadId]/proposals` deliberately rejects every capability
  except `alex.menu_price_change.v1`; only the menu price capability has a
  safely validated commit and stale-revision reconciliation.
- The initiative approval endpoint handles an *initiative* lifecycle, not an
  employee, shift, rule, availability, or delivery command.
- Owner WhatsApp task-alert templates exist but are **not a staff notification
  transport**. Consent, approved message templates, delivery status, and
  recipient-specific authorization for staff are missing.

Thus `main` does **not yet** provide an actionable staff/schedule approval card.
Do not register or execute the seven proposed staff tools merely because a
menu-price card renders. Do not insert inert cards that cannot be approved.

## Gate required for all seven tools

- [ ] Staff-specific preview/card in en/es/ar, RTL, mobile, with Approve/Decline
- [ ] Persisted owner/business/thread scope, revision and immutable action payload
- [ ] Owner-click-only, same-origin approval endpoint with strict zod schemas
- [ ] Re-read staff, rules, wages, availability and target week under owner scope;
      reject stale or conflicting revisions (CAS) before any write
- [ ] Atomic/idempotent commit and safe retry/reconciliation of unknown outcomes
- [ ] E2E tests: cross-tenant denial, non-owner denial, race/double approval,
      expired/deleted employee, changed wage/rule, approval after a week change
- [ ] No edit to `lib/ai/agent/loop.server.ts` or `checkNumbers.ts` by this PR

Register in `lib/ai/agent/tools/index.ts` only after every gate above exists:

- [ ] `propose_schedule`
- [ ] `propose_shift_change`
- [ ] `propose_add_staff`
- [ ] `propose_staff_change`
- [ ] `propose_availability_change`
- [ ] `propose_rule_change`
- [ ] `propose_send_schedule`

`parseAvailabilityText` remains a pure, review-only parser. It does not write.

## Sending a schedule

The current `sendSchedule` action only **prepares text for manual copy**.
It returns `channel:"copy", sent:false`, performs no message transport and
must never mark a scheduled shift as sent. It is not an approved delivery action.

Before enabling `propose_send_schedule`, also require an actual staff-message
transport with consent/recipient opt-in, explicit delivery preview, provider
template support, dedupe key, audit log and verified delivery acknowledgement.
The existing `deliverOwnerTemplate` is **not** reusable for staff.
