# Phase 5 — owner-approved AI Team guidance and permissions

Phase 5 extends the **same Supervisor and four specialists**, not the operating
tasks inbox. Owners can create written guidance for Supervisor, Alex, Olivia,
Maya or Leo, explicitly approve/reject it, pause an active rule, resume a paused
rule and inspect an immutable audit history. The Team inbox continues to be
the one source of actionable pricing/staff/supply tasks.

## Important distinction: notes vs actions

These are **human-readable operating instructions and future-workflow guidance**,
not executable programs or LLM prompts with authority. Phase 4's deterministic
Supervisor continues to use its existing trusted read-only café tools. Merely
writing or approving a rule **does not execute it**, change the price engine,
apply a price to Square/Toast, update payroll, alter schedules, message staff,
place orders, or bypass an approval. Automated interpretation of arbitrary
natural-language rules is not introduced in this phase. The Supervisor can
answer "What rules did I give Alex?" by reading only **active**, owner-approved
instructions under the same café scope. Those instructions are displayed as
quoted data, never executed as commands or treated as authority for business
writes.

`evaluateSupervisorPermission()` is explicitly default-deny: only known
allow-listed **reads** are permitted. All business writes remain forbidden in
this new policy layer; a future separately reviewed action executor must bind
an owner-approved **specific action** to the existing operating task or domain
workflow, verify evidence and permissions, and record verified outcomes.
Approving a *rule* is NOT approval to apply an *action*. Never make a second
`needs_you` task queue.

## Data and approval model

`20261010000034_ai_owner_rules.sql` adds **only**:
- `ai_team_rules`: café-scoped agent, immutable instruction text and identity,
  `draft | active | paused | rejected` state and monotonic version.
- `ai_rule_events`: append-only, trigger-produced before/after status,
  rule text snapshot, actor, version and event timestamp.

A draft can be explicitly `approve`d or `reject`ed by a café owner.
An active rule can be `pause`d and a paused rule `resume`d. A rejected
rule is terminal; modifying text means creating a **new draft** instead of
editing or deleting the past. Optimistic `expectedVersion` prevents owners
from unknowingly overwriting simultaneous reviews. Database-side trigger
enforces the transition graph and immutable fields even on direct PostgREST
access, while a separate SECURITY DEFINER trigger writes audit events.

All table policies require signed-in **owner role membership** in the café.
Managers and outsiders cannot read or write rules; café co-owners can
collaborate on the same café rules, and recorded reviewer IDs distinguish
who approved each version. The client cannot INSERT/UPDATE/DELETE audit
events or DELETE rules. Existing café and conversation data remain intact.

## Owner workflow

Home → **Team** → **Team rules**:
1. Select Supervisor, Alex, Olivia, Maya or Leo and type an instruction.
2. **Save draft**. It is not yet active and has no business side effects.
3. **Approve rule** to make it active, or **Reject**. Review history records
   the owner's actor identity and status transition.
4. Later **Pause** / **Resume** as appropriate.
5. See audit history of all recorded transitions.

Screens and messages are localized in English, Spanish and Arabic. The Team
inbox, price reviews, staffing decisions and money calculations are unchanged.

## API endpoints

Cookie-authenticated, same-origin writes, strict bounded JSON, no-store
responses; business/user IDs never come from the request:

| Endpoint | Result |
|---|---|
| `GET /api/ai/rules?offset=0` | 40 most recent café rules (paged) |
| `POST /api/ai/rules` | Creates draft from `{agentId, instruction}` only |
| `PATCH /api/ai/rules/:id` | Explicit decision `{expectedVersion, decision}` |
| `GET /api/ai/rules/audit?offset=0` | 40 audit transitions (paged) |

Owner membership is checked again at the server layer, and Supabase RLS is
enforced by the session client. The administrator service-role client is
never used to edit rules.

## Required deployment order

1. Confirm the earlier migration `20261010000033_ai_conversations.sql` was
   safely applied and reconcile actual Supabase migration history.
2. Review and apply `20261010000034_ai_owner_rules.sql` **once**, before
   deploying Phase 5 page/API code. The tables are additive. Do not run an
   unreconciled `supabase db push`.
3. Run staging auth tests with two owners of the same café, an owner of another
   café, a manager and an outsider. Confirm direct PostgREST updates cannot
   change instruction text, cross café, jump to arbitrary states or forge audit.
4. Deploy and verify Team rules and audit for EN/ES/AR with a real authenticated
   café; confirm legacy Needs You/Handled/Watching pages still work.
5. Only then merge/deploy production deliberately. No production database
   mutation, Vercel environment update or live rule activation was performed
   by this PR.

## Tests

The CI branch runs TypeScript, changed-file ESLint, full Vitest tests, the
actual migrations 33 and 34 against a **disposable PostgreSQL** service,
Next.js production build and diff checks. The PostgreSQL test verifies RLS
isolation, status transitions, immutable rule fields, actor attribution,
monotonic versions, optimistic concurrency and append-only audit history.

That isolated database test does **not** prove the user's live Supabase
database was migrated; verify actual production history before deployment.
