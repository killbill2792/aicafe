# AI Cafe WhatsApp Supervisor channel — architecture RFC (2026-10-30)

**Status:** architecture proposal only. **No implementation, environment change, production
registration, SQL, external send, merge or deployment is authorized by this RFC.**
`AGENTS.md` is the binding implementation contract. This proposal must be revisited if
that file, Meta's current terms or the current implementation changes.

## Owner journey and product goal

A café owner opts in to one **morning briefing** at a café-local time. The briefing
leads with what matters **today**: an evidence-backed demand outlook, readiness
(staffing and known supply gaps), the most relevant verified prior-day result, and
**one useful next step**. Owners can ask follow-ups in WhatsApp if this channel is
permitted. The same Supervisor answers with authorized café tools, not a generic
LLM answering from the notification text. Actual business changes remain in-app
approval-card actions. An owner never has to manage a second inbox.

**Why this is better than a general chatbot:** the Supervisor can compare canonical
Toast and financial data to an appropriate baseline, bring in *saved and verified*
nearby-event intelligence, inspect actual staffing coverage, remember verified owner
facts and decisions, suggest a concrete next step, and monitor/report the outcome
using existing systems. Fresh data is read on demand, never treated as a remembered
numeric fact. Do not invent predictions, margins, staffing needs or event impact.

Illustrative experience (not data from a café):

> Morning: “A nearby conference may raise lunch demand; there may be a coverage
> gap 11–2. Yesterday's sales were above a comparable weekday. Suggested next
> step: review lunch staffing. Open AI Cafe for the details.”
>
> Owner: “Do I need one more person?”
>
> Supervisor: reads that café's staffing schedule, comparable demand and
> canonical labor economics, distinguishes observed facts from forecasts, and
> gives an actionable recommendation with its uncertainty. If asked to change
> the schedule, it prepares an inert proposal and points to an authenticated
> approval card in the app; **WhatsApp text does not approve anything**.

### UX contract

- One message **maximum per opted-in owner/café-local day**, no redundant
  team-alert message alongside the morning brief. Configurable send time; a
  local-time due/quiet-hour gate handles DST and late/missing data.
- Prioritize: (1) today's outlook, (2) readiness/risk, (3) relevant
  yesterday-versus-comparable-day performance, (4) one recommended action.
  Omit unhelpful sections; do not force sales into every briefing.
- Write a short answer first, then one next step; **actual/estimate/partial and
  source period/as-of** must be clear. No fabricated all-clear for missing data.
  Use the café's locale (EN/ES/AR) and currency, via existing localization.
- Keep full report, evidence, “How I got this”, proposal and history in the
  existing Supervisor thread / `operating_tasks` Inbox; external text is a
  concise, privacy-aware delivery surface with a deep link.
- WhatsApp cannot stream a token-by-token web reply: use one useful final
  answer and a bounded delayed-response acknowledgement only if needed.
  Avoid chatty “typing” spam and unsolicited repeated follow-ups.
- Treat replies as the next turn in the **same** owner/café conversation.
  Re-read current source facts; reuse stored owner-provided preferences/facts.
  Never claim an owner action happened merely because they said “yes”.

## Architecture: a channel adapter, not a new Supervisor

```text
existing morning brief / operating_tasks / same supervisor history
       │
       ├─ existing web app and Supervisor (unchanged)
       │
       └─ default-off owner delivery adapter -> verified Meta sender -> WhatsApp
                                                               │ reply
                 signed webhook -> durable inbox + dedupe -> identity binding
                                                               │
                       authorized existing Supervisor turn service
                       (same OpenAI loop, tools, facts and validations)
                                                               │
                 persisted reply -> delivery outbox -> Meta -> owner's phone
```

**Reuse, do not replicate**:
- `lib/operating/dailyBrief.server.ts` and `lib/operating/dailyBrief.ts`
  already create an Inbox entry and Supervisor message. Current behavior
  targets the first owner, runs during a broad 8–12 local-time window, and
  primarily reports yesterday's snapshot plus needs-owner count. Extend
  this **single** producer for a today-first briefing later; no second
  financial reader, event search or report writer.
- `lib/ai/notifications/whatsapp.server.ts`,
  `app/api/cron/team-alerts/route.ts`, `app/api/ai/notifications/route.ts`
  and `ai_owner_notifications`/`ai_delivery_attempts` provide a limited,
  default-off **outbound task-category template** path. They are *not* a
  two-way chat implementation. Their current daily cap is per business,
  owner and local day; future design must distinguish event, recipient
  and channel without duplicate daily alerts.
- `app/api/ai/threads/[threadId]/agent/route.ts` and
  `lib/ai/agent/loop.server.ts` have the existing streaming Supervisor.
  A WhatsApp webhook **must not** call browser-auth routes using a fake
  cookie or run a second agent. Extract/reuse an internal authorized
  invocation boundary when building the integration; retain budget,
  source grounding, number checks, thread persistence and audit.
- `lib/data/`, `lib/metrics/core/`, `lib/attention/`,
  `lib/ai/supervisor/loop/` and `operating_tasks` remain authoritative.
  Respect all concurrent Financial, Events and Pantry PR ownership.

### Multi-café identity and privacy

One Meta **developer test sender** may address up to five verified **test
recipient phone numbers**; that is a test-environment limit, not permission
for five production cafés or general outbound campaigning. One sender can
serve multiple businesses only through **separate, authorized sessions**.

- Owner signs in to AI Cafe, verifies phone ownership, expressly opts in,
  and binds that number to an owner account and selected business in-app.
  Check active membership, role and entitlement on **every** turn and send.
  Do not trust the WhatsApp profile name, message body, caller-supplied
  `business_id`, or phone number alone as sufficient authorization.
- At delivery, the server resolves an owner-specific, current
  owner-user/business binding from the **verified** WhatsApp account ID /
  normalized phone and its consent record. If absent, revoked, mismatched
  or ambiguous (e.g. same owner manages two cafés), **fail closed**.
  Business selection/changes occur after authenticated confirmation in
  the app, not by trusting arbitrary text from WhatsApp.
- All reads and writes are café-scoped; service-role usage, if needed for
  webhooks, has explicit membership/authorization checks before the agent
  sees a tool. Store minimal binding metadata, never POS credentials in
  messaging tables. RLS on all new public tables and regression tests
  for spoofed numbers, revoked owners and café A/B isolation.
- Distinguish one sender's five private 1:1 chats from a WhatsApp group.
  No group ingestion, workers, suppliers, or customer messaging.

### Inbound and outbound reliability

1. Meta webhook handshake + raw-body signature validation
   (`X-Hub-Signature-256`); reject invalid events. Safelist sender account,
   supported event types and consenting test recipients.
2. Persist inbound message and Meta message ID **before** acknowledging
   webhook; deduplicate repeated/out-of-order webhooks. Acknowledge fast,
   process the authorized Supervisor turn via a durable bounded worker.
   Do not run a long model call inside the webhook request.
3. Persist the owner message once in the existing thread, invoke the
   existing Supervisor turn service, persist the answer once, then
   reserve an outbound delivery in an outbox. Enforce idempotency around
   provider timeout/unknown acceptance; never blindly resend.
4. Handle message delivery status callbacks separately. Track accepted,
   sent, delivered, read (if supplied) and failed; never label “delivered”
   merely because Meta accepted the API request. Minimize/redact logs.
5. Throttle/quotas per owner and café, bounded input size, safe supported
   text-only MVP, delivery expiry, opt-out, operator kill switch and
   per-channel provider flags (default off).
6. External messages exclude employee/customer PII, payment details,
   internal tool results and sensitive raw transactions. Long financial
   details and approval previews live behind the authenticated app link.
7. Never ship new staff/supplier messaging or WhatsApp-based approvals.

### Morning brief: one producer, one notification

The existing daily briefing and team-alert crons must not independently
send two WhatsApp messages. Have one canonical `morning_brief` persisted
per business/date (reuse current thread/Inbox identity), then fan out to
each consented owner via a per-recipient/channel deduplicated delivery
record. Current first-owner behavior is a known limitation to address
in the morning-delivery PR, **not** an assumption that five cafés work today.

Facts are gathered from existing canonical data and the saved/verified Events
reader; do not conduct web/event research when Home opens or a message arrives
unless the existing Supervisor tool explicitly calls for it. Calculate
comparisons using established calculators, and let the **same** Supervisor
choose which verified facts matter, without a separate classifier, summary
agent or hard-coded business advice. Label predictions as estimates and
incomplete periods as partial. If no trustworthy result is available,
send a safe, useful update instead of fabricated specifics.

For scheduled provider-initiated WhatsApp messages, **only approved templates**
are allowed outside the 24-hour customer-service window. Developer test
templates do not prove approval for a free-form morning report; until the
custom template is approved, send only permitted template text linking
to the saved in-app briefing, or keep delivery disabled. Free-form
follow-up replies are limited to the 24-hour window following the user's
most recent message. Maintain an accessible human escalation route.

## Compliance and release gates (hard stop)

Meta's WhatsApp Business Solution Terms restrict AI providers from making
AI technologies available where the AI is the **primary** functionality,
with jurisdictional exceptions. AI Cafe explicitly markets an AI Supervisor,
so a general conversational pilot may be **ineligible**. Do not assume
“other WhatsApp bots exist” or a developer sandbox authorizes deployment.
Confirm applicability and permitted use with Meta / qualified counsel
before enabling **any real-owner** WhatsApp AI conversations; if not allowed,
retain the in-app Supervisor and use a compliant alternative channel.
Do not evade restrictions with unofficial WhatsApp Web automation.

For a production sender: complete applicable onboarding,
business profile/support contact, accurate sender identity, permitted
consent/notice/privacy-policy requirements, appropriate templates,
human escalation, and compliance review. No incorporation or domain is
presumed necessary for the sandbox, but no production verification
outcome is promised. Meta's Messaging Policy requires a business profile
with a support contact and at least one contact method (email,
website or telephone), clear opt-in, opt-out and approved templates.

Official policy references (verify again when enabling):
- https://whatsappbusiness.com/policy/
- https://www.whatsapp.com/legal/business-solution-terms
- https://www.whatsapp.com/legal/meta-terms-whatsapp-business

## Independent implementation PRs, ordered by dependency

| PR | Scope and ownership | Acceptance gate |
| --- | --- | --- |
| **0: this RFC** | New docs file only; design contract, no runtime changes | Owner reviews this plan, Meta eligibility examined |
| **1: secure transport** | Isolated signed webhook, durable inbound/outbound/idempotency layer, owner binding, test-only kill switch | Spoofed signature/owner or duplicate webhook cannot send or leak data; zero external sends by default |
| **2: one morning brief** | Extend existing briefing + approved safe template; per owner/day/channel delivery, local-time configuration, disable redundant team-alert send when active | Five distinct test recipient mappings, exactly one owner brief per local date, DST and partial-data tests |
| **3: conversations** | Extract shared authorized Supervisor turn service; inbound text -> same thread/tool loop -> outbound reply | Exact chat/screen financial parity, two-café isolation, saved owner context, web chat unchanged, no approvals via WhatsApp |
| **4: limited pilot hardening** | Delivery status telemetry, opt-out, quotas, safe errors, operator rollback, supported locale and cost measurements | End-to-end staging traces, no cross-tenant data, no duplicate replies; only after Meta eligibility and owner approval |

Each implementation PR starts from latest `main`, checks active PRs/owned
files, changes one concern, and follows `AGENTS.md`: tests and parity
fixtures, `npx tsc --noEmit`, `npm run lint`, `npm test`,
`npm run build`, independent Codex review with P1 fixes, owner approval
before merge, **no production send, SQL application or deployment**.
Any new schema requires RLS and explicit owner approval before production
migration. Keep `PROGRESS.md` untouched by this docs-only proposal
to avoid concurrent PR conflicts.

## Golden tests and product success measures

**Hard-gate tests**
- Unknown phone, changed/revoked consent, ambiguous café binding,
  forged webhook, wrong sender, replayed Meta event -> no data disclosed.
- Five mapped test numbers each get their own café's data; comparisons
  never read across cafés. If same owner has multiple cafés, selection
  is explicit and authenticated.
- One morning notification per recipient / café-local day across retries,
  restarts and DST; no second team-alert message; statuses distinguish
  accepted vs delivered vs failed.
- Questions about sales, labor, profit and fees use the *same* underlying
  reader/calculator as the screen. Missing/stale coverage is explicit.
- A request to change staff, prices, suppliers or money cannot commit
  through WhatsApp; no staff/supplier direct sends.
- No production messages with flags off, without approved template,
  without authorization, or without required compliance sign-off.

**User-value measurement**
- Can owners correctly identify today's one key action in <30 seconds?
- Do grounded answers cite a real café-specific fact, period and fresh
  source, rather than generic café tips?
- How often do owners ask a follow-up, return the next morning, report
  a useful recommendation, or confirm a real-world action?
- Track p50/p95 reply latency, per-brief and per-turn API cost, provider
  delivery outcomes, duplicated sends, and unavailable-data rates.
  Never use prompt/PII logging to obtain these metrics.

## Open decisions and dependencies

- Owner to create Meta developer API app and add up to five authorized
  *test recipient numbers*; **credentials are not required for this RFC**.
- Verify Meta's AI-provider policy applicability and sender/template
  approval before external owner pilot; sandbox != production permission.
- Confirm consent/opt-out wording, support channel, permitted template,
  and per-business local send time (e.g. before opening).
- Decide whether to keep SMS as a separate transport using this same
  authorized Supervisor boundary (preferred), subject to carrier
  registration; **do not implement SMS in this WhatsApp RFC**.
- Do not modify currently open Events, Money or Pantry PR scopes.
