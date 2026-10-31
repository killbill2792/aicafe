# AI Cafe WhatsApp Supervisor channel — architecture RFC (2026-10-30)

**Status:** updated implementation roadmap; technical work is authorized for scoped, default-off PRs, but no production sends, migrations, merges or deployments are authorized. **No implementation, environment change, production
registration, SQL, external send, merge or deployment is authorized by this RFC.**
`AGENTS.md` is the binding implementation contract. This proposal must be revisited if
that file, Meta's current terms or the current implementation changes.

## Owner journey and product goal

A café owner opts in to one **morning briefing** at a café-local time.
**Owner-validated priorities:** yesterday's net sales, where *known* money went,
an actual product-mix insight (e.g. drinks sold and best-selling item), and
**one** forward-looking observation/action when justified by saved events,
comparable-day demand and verified costs. **Do not include month-to-date or
year-to-date sales by default**: provide those on request. If staffing plans
are unavailable, ask for them politely and at most when useful, rather than
inventing coverage. Owners can ask follow-ups in WhatsApp if this channel is
permitted. The same Supervisor answers with authorized café tools, not a generic
LLM answering from notification text. Actual business changes remain in-app
approval-card actions. An owner never has to manage a second inbox.

**Why this is better than a general chatbot:** the Supervisor can compare canonical
Toast and financial data to an appropriate baseline, bring in *saved and verified*
nearby-event intelligence, inspect actual staffing coverage, remember verified owner
facts and decisions, suggest a concrete next step, and monitor/report the outcome
using existing systems. Fresh data is read on demand, never treated as a remembered
numeric fact. Do not invent predictions, margins, staffing needs or event impact.

Illustrative experience (not data from a café):

> Morning: “Yesterday's **net sales** were $1,700. Recorded staff wages were
> $480 (28.2% of net sales); ingredient costs are not yet verified. Of 190
> drinks sold, 89 were matcha drinks (if these are correctly classified and
> verified). Halloween is tomorrow and a saved nearby event may matter; it
> is not a proven traffic forecast. On recent comparable Saturdays your busiest
> measured sales period was 10 AM–noon. I don't have your future staffing plan
> verified yet—could you share the shifts? Open AI Cafe for the details.”
>
> Owner: “We have two people 8–12 and three 12–5.”
>
> Supervisor: explains the confirmed prior-day money and historical peaks,
> checks the proposed shift coverage without presuming it was entered into
> Toast, and offers an inert schedule preview. Only an authenticated in-app
> approval can commit the schedule. **WhatsApp text does not approve anything**.

### UX contract

- One message **maximum per opted-in owner/café-local day**, no redundant
  team-alert message alongside the morning brief. Configurable send time; a
  local-time due/quiet-hour gate handles DST and late/missing data.
- Consistent baseline: (1) yesterday's confirmed net sales, (2) *known*
  cost breakdown with each percent of those same sales, (3) meaningful
  sold-item count/top seller if reliably classified. Then *one* prioritized
  verified event, unusual cost/performance pattern or readiness insight and
  a practical next step. No default month-to-date/year-to-date total or
  forced break-even number. Omit sections lacking trustworthy evidence.
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

### Owner-approved briefing content and comparisons (October 30 revision)

**The product advantage isn't relaying Toast:** Toast already provides
sales, labor, item-mix and hourly reports. AI Cafe must synthesize those
with owners' verified operating knowledge, saved nearby events and
canonical cost/recovery calculations: **what happened → why it might
matter → what's next → what to monitor**. Avoid generic AI advice and
unsupported causal attribution. No new calculation pipeline or second AI.

**Example shape, not a Meta approval template** (all numbers/hours are
hypothetical; the live message must omit unavailable facts):

1. “Good morning. Yesterday's **net sales** were $1,700.”
2. “Where the *known* sales went: recorded wages $480 (28.2% of net
   sales); estimated ingredients $340 (20%) **only if ingredient evidence
   supports that estimate**. Card fees, payroll taxes, rent and other
   bills are labeled actual/estimated/missing; never suggest the remaining
   sales amount is net profit.”
3. “You sold 190 drinks. Matcha was the top-selling **drink group** at
   89 units” only if group mapping, drinks-vs-all-items denominator,
   modifiers/voids and quantity are verified in the canonical sales
   reader. Prefer **one meaningful interpretation** such as “matcha
   accounted for an unusually large share versus comparable Thursdays”,
   only if the comparison is supported.
4. “Halloween is tomorrow; we're tracking [a verified saved nearby event].
   It *might* change foot traffic, but we can't establish the impact yet.
   Your normal Saturday peak across the recent comparable Saturdays was
   [verified time period], so use that as a preparation baseline.”
5. “I don't have your **future staff plan** verified. Could you send
   today's shifts or this week's schedule? You can reply in text;
   photo/document intake will be offered **only when the channel really
   supports and validates attachments**. I'll organize it for you to
   review before anything is saved or acted on.”

**Comparisons/coverage:**
- For *yesterday's performance*, compare with the last **four complete
  same weekdays** (e.g. this Thursday against four earlier Thursdays).
  The latest week may be mentioned as context, but one week is not the
  only baseline; show “based on N comparable days” and detect outliers.
- For a *future day's busy periods*, aggregate **hourly net sales** across
  the last **four comparable weekdays** and cross-check order/item
  counts as available. Find consistently strong adjacent time windows,
  not the largest single raw sample. Compare the immediately preceding
  weekday as context. Fewer than four complete comparable days lowers
  confidence and must be disclosed; none means “not enough history,”
  not a made-up peak. Don't claim peak periods are a Halloween forecast.
- With a past year's *same holiday* data, a special-event pattern could
  be evaluated separately; without it, the usual-weekday baseline is
  just a starting point. Event relevance must come from the existing
  dated, saved Events records, not invented nearby crowds or weather.
- **Wages vs loaded labor**: $480/$1,700 is ~28.2%, never 38%.
  Identify the numerator honestly: Toast clocked wages exclude payroll
  taxes unless loaded-labor cost is separately available. Show the
  same period, café currency, actual/estimate and missing coverage.
- **Ingredient costs are not supplied by Toast sales alone.** The
  ingredient estimate must use existing validated recipe/item-cost
  coverage, and say estimated/partial; otherwise say “ingredient
  costs not fully available,” never assume a 20% ingredient cost.
- Break-even is an *optional* important insight when the existing
  Money/Plan/Supervisor canonical calculation has full enough evidence.
  It is a target estimate, **not observed yesterday's profit**, and
  should not be included merely to fill a slot.
- Planned shifts are independent from past Toast *clocked time entries*.
  Read any available Toast planned shifts and owner-supplied plans before
  asking. Missing a plan is “schedule not available to AI Cafe,” never
  “nobody scheduled.” Don't repeat requests every day; owner-provided
  schedule facts should persist only with appropriate review and
  approval. WhatsApp file/photo handling is **not currently built**.
- **Message length discipline:** lead with yesterday's sales, known
  costs, one product-mix insight, then one timely event/operating
  insight and one optional staffing request. Short external copy;
  detailed comparisons, evidence and charts remain in existing chat.
  Never fabricate a concern just to fill sections.

### New behavioral acceptance for the morning-brief PR

- Fixture: four comparable Saturdays with differing hourly demand,
  one unusual outlier and a Halloween event. Assert accurate hourly
  aggregation, sample count, event uncertainty and no impact claim.
- Fixture: one Saturday / partial hours; do not promote to a confident
  “usual Saturday peak.” No data => no named peak hours.
- Fixture: 190 sold drinks, 89 matcha; verify correct quantity,
  classification and no double counting modifiers or refunds.
- Fixture: wages $480, net sales $1,700; display 28.2% wages,
  distinguish wage-only from loaded labor; missing recipe coverage
  never yields a fabricated 20% ingredient estimate.
- Fixture: missing manually managed schedule; ask politely once,
  accept proposed text for review but never treat it as committed.
  Unsupported WhatsApp photo/file attachments must be communicated
  as unsupported rather than claimed saved.
- No default month-to-date total; owner requests about MTD are answered
  from the same canonical Toast reader on demand.
- Exact-money parity with Money/Plan and the Supervisor; no replayed
  sends and no cross-owner/multi-café data leakage.

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

## Three concurrent implementation PRs (replaces earlier five-PR split)

The owner prefers **three** implementation PRs, no additional planning PR; the scoped checklist is in `PROGRESS.md`. This division supersedes any older five-PR table below or elsewhere in this RFC. Work can start in three separate chats, but **integrate and merge sequentially A → B → C**. Only A changes the shared plan/checklist initially. No production sends, merges, SQL application or deployments without explicit owner approval.

| PR | Exclusive file ownership and scope | Gate |
| --- | --- | --- |
| **A — verified transport/foundation** | `app/api/whatsapp/webhook/route.ts`, new `lib/whatsapp/{transport,webhook,identity,queue}*.ts`, new RLS-protected schema and dedupe/delivery ledgers, plus these plan texts. Expose a fail-closed dispatcher boundary for C. No chat/brief modifications. | Signed raw-body webhook, durable enqueue-before-200, Meta test sender, validated binding, correct payload handling, safe outbound, deduplication, disable/consent tests. |
| **B — canonical morning-brief content** | `lib/operating/dailyBrief*.ts` + new `lib/whatsapp/morningBrief*.ts`, optionally existing daily-brief cron and their tests; don't edit A/C files. | Seven truthful template parameters, covered drink counts, closed-day sales, saved event/monitor eligibility, one recipient/day, skip missing data, screen/chat financial parity, correct daily-brief inbox message. |
| **C — shared Supervisor conversation + media** | `app/api/ai/threads/[threadId]/agent/route.ts`, new shared `lib/ai/conversations/*` service, `lib/whatsapp/{supervisor,media}*.ts`, existing website chat refresh code, tests; wire A dispatcher after A merge. | One `ai_threads`/`ai_messages` history across channels, jobs serialized, four payloads and free text answered by same loop, owner/café isolation, web refresh/focus, secure image/PDF drafts, no unauthorized actions, 24-hour send gate. |

### One conversation, two delivery surfaces

Current web chat uses `ConversationService` / `SupabaseConversationRepository` scoped by `{businessId,ownerUserId}`; owner messages live in `ai_messages` as `role:"owner"`, replies as `role:"supervisor"`, with `thread_id`. The current `lib/ai/agent/jobs.server.ts` coordinates in-flight web turns. WhatsApp is a **channel adapter**, not a second table of AI messages or an alternate agent. A binding must resolve an explicitly selected, currently authorized `thread_id` (existing web chat thread when linked, otherwise a single linked thread created safely), and keep it stable. If a user intentionally opens a different web thread, the linked WhatsApp history remains accessible in the thread list rather than being silently merged into the wrong conversation. Fresh WhatsApp arrivals must bump thread ordering so the linked thread appears as recent.

Persist the morning brief *once* as a Supervisor message in that linked thread and log WhatsApp delivery in the outbox; never duplicate the same brief to the web and WhatsApp as two independent `ai_messages`. When the owner taps, record exactly one inbound `ai_messages` owner turn with a deterministic client-message UUID tied to Meta's `wamid`, preserving the Meta id in the dedicated inbound ledger. The same Supervisor tool loop creates one `role:"supervisor"` reply with its usual evidence and source rules. Keep per-inbound channel and provider-outbox records **outside** the model's conversational state; do not blindly mirror web-only agent replies back into WhatsApp. Replays and retries must produce no duplicate `ai_messages` or outbound sends.

**Website behavior:** Opening the linked thread in AI Cafe should display all WhatsApp-origin owner turns and Supervisor replies in chronological order with web-native rich cards/evidence. The current website loads `/api/ai/threads/{threadId}/messages` on opening/thread change but does not provide automatic idle external-message refresh. PR C adds a safe focus/reconnect refresh (plus bounded idle refresh or existing realtime) and preserves unsent drafts/active streams; no page reload necessary. When already viewing a different thread, show the linked WhatsApp thread as recent; do not append a message into the wrong thread. Concurrent web/WhatsApp turns must be serialized through the existing `ai_agent_jobs` lifecycle. An absorbed/continued owner follow-up must not be double-replied or delivered to the wrong channel.

**Security:** Web requests retain cookie-based user authentication; the webhook uses verified Meta signature plus prior phone/owner/café consent binding and current membership checks. Do not fake browser cookies from a webhook. Extract the already-authorized service loop to a channel-neutral server boundary without changing numbers, model text, tool budgets or approval rules. Save incoming attachments privately and offer review; a WhatsApp “yes” never counts as an in-app approval.

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


## Owner-provided Meta test integration contract (October 30, 2026; supersedes the illustrative preview above)

**Scope of this contract:** Prepare a default-OFF, test-first integration on independent implementation PRs. This section supersedes earlier *example message*, button and media scope; it does not override AGENTS.md, WhatsApp policy or explicit production-approval gates. No Meta token or app secret is stored in this document. The owner has provided identifiers only; no live API message has been sent or verified.

### Provider identifiers and supplied template

- Meta App: Cafe Profit; App ID `4481906628792262`.
- Business portfolio ID `2219361048922286`; WABA ID `2591886181260442`.
- **Developer test** Phone Number ID `1322195347653883`; displayed test sender +1 555 650 6570. Do not treat this as a production sender.
- Template name `cafe_profit_daily_brief`, language `en_US`, seven text body parameters and four approved-template quick replies. **Template approval status and category are not yet independently verified**; check in Meta before sending.
- Owner-specified Graph endpoint: `POST https://graph.facebook.com/v21.0/1322195347653883/messages`. Graph v21.0 was reported due to sunset January 21, 2027; keep API version configuration centralized and plan upgrade. The existing legacy task template sender uses v22.0 and `META_WHATSAPP_TOKEN`; reuse one transport/credential source instead of creating conflicting Meta senders. A new `WHATSAPP_TOKEN` alias/migration should be explicit and documented.
- Env **server only**: API bearer token (`WHATSAPP_TOKEN` or one canonical name migrated from `META_WHATSAPP_TOKEN`), `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, Phone Number ID / Graph version and distinct default-OFF brief/reply flags. Existing `AI_CAFE_WHATSAPP_ENABLED` controls task alerts, not automatic permission to send owner morning briefs.
- Authorized **test recipient** must be configured in Meta, separately verified/opted-in and associated with exactly one selected owner/café binding before any send. Never use an arbitrary webhook `from` as proof of identity.

**Exact, stable ordered seven-body mapping** (all nonempty):
1. `{{1}}` café display name (NOT assumed owner name).
2. `{{2}}` **yesterday's net sales** in that café's currency from the canonical snapshot.
3. `{{3}}` **number of drinks sold** from correctly classified, covered item quantities; do not substitute total menu items.
4. `{{4}}` top-selling drink name from the same covered set.
5. `{{5}}` units sold of that same top drink.
6. `{{6}}` one brief, verified today-event fact, one line. No speculative “expect a busier 3 to 6 PM” unless a valid grounded forecast actually exists. Example: “Halloween today; a saved nearby event starts at 3 PM” only when that source/date is verified.
7. `{{7}}` café-local day-of-week for **today**, e.g. “Saturday”; this labels a historical same-weekday comparison, not a prediction of event impact.

**Current template body as owner supplied:**

```text
Good morning ☀️

Here's {{1}}'s daily brief from Cafe Profit.

*Yesterday*
💰 Net sales: {{2}}
☕ Drinks sold: {{3}}
🏆 Best seller: {{4}}, with {{5}} sold

📅 Today: {{6}}

I'm watching today's sales against your usual {{7}} pattern and will message you if anything looks off.

Tap a question below, or reply with anything about your café.
```

The text promises *active monitoring* and a later message. Therefore **send this exact template only if a canonical monitor is actually active for today and the follow-up delivery is permitted**. The producer cannot remove that sentence from an already approved template. An ordinary-day / no-monitor variant needs **separate Meta approval**, or skip this send until that variant exists. A monitor running is not itself permission for an out-of-window freeform follow-up; templates/24-hour service window govern delivery. If yesterday's sales are absent/partial without a trustworthy net-sales value, skip, do not fill with zero. If drink counts/top seller or today's event are unavailable, do not invent values; skip this exact 7-variable template or use an appropriate *separately approved* alternate once available. Preserve one morning brief per recipient/café-local date and do not send the old task-alert beside it.

**Variable sanitization:** Text-only, nonempty, no `\\r`, `\\n`, `\\t`, or more than four consecutive spaces, no injected markup, control characters or unexpected very-long values; bound values to provider-safe lengths. Normalize/validate digit-only E.164 international destination (no `+` for API `to`, retain normalized E.164 for internal identity). Money in integer cents until formatting using `businesses.currency`. Validate freshness/coverage of yesterday's closed Toast business day. Persist the exact parameters/period/reader provenance with outbound delivery for audit, excluding secrets.

**Four button payloads (indices fixed, treat payload as an owner question, not an action):**

| Index | Payload | Canonical owner question | Display-text constraint |
| --- | --- | --- | --- |
| 0 | `money_went` | “Where did my money go yesterday?” | `Where did my money go?` (22 chars; exact submitted label) |
| 1 | `peak_today` | “What are my usual busiest hours for today?” | `Peak hours today?` |
| 2 | `slowest_yesterday` | “What was my slowest hour yesterday?” | `Yesterday's slowest hour?` (25 chars; exact submitted label) |
| 3 | `event_today` | “Tell me more about today's saved nearby event.” | `About today's event` |

**Keep the owner's exact four submitted Quick Reply labels.** WhatsApp template button labels can contain up to **25 characters**, so “Where did my money go?” (22 characters) and “Yesterday's slowest hour?” (25 characters) fit. The approved template stores the **visible button labels**; the **send request supplies each button's developer-defined payload** for that message. Meta returns the payload when the owner taps. **Route on `button.payload` (or a supported `interactive.button_reply.id` where applicable), never on display text or title.** A change to label wording in a later approved template must not break question routing. Preserve indices matching the actual approved template order. Templates with four replies commonly display only the first two and a “See all options” affordance; keep money/peaks first. The payload -> question mapping is a four-item **UI prompt mapping**, not a deterministic agent/intent router: enqueue that plain-language question as an owner turn in the existing Supervisor loop; the AI and existing tools determine how to answer.

**Answer contract for each reply:**
- `money_went`: actual recorded wages, card fees and supported ingredient costs as percentages of the same yesterday net-sales denominator; label every estimated/missing cost, never equate net sales less known costs with actual profit. Reuse canonical Money/Plan/Supervisor metrics and financial parity checks; don't invent a remainder.
- `peak_today`: recent complete **same weekdays** (target last four) and their café-local hourly sales, with usable sample size and typical peaks; a normal weekday pattern is not a forecast, especially with Halloween/event uncertainty.
- `slowest_yesterday`: yesterday's **open, observed** hourly buckets by net sales, plus order count when complete; exclude after-hours zero buckets, missing hours and partial rollups. Identify date and time zone.
- `event_today`: date/venue/timing/source and the saved event's AI insight, if available, with impact not established until actual sales comparisons. No new paid discovery from a tap unless existing authorized Supervisor tools explicitly require it.

### Security and webhook processing contract

`GET /api/whatsapp/webhook`: exact `hub.mode=subscribe` and constant-time (where appropriate) `hub.verify_token` equality with server-only `WHATSAPP_VERIFY_TOKEN`, then plain-text `hub.challenge`; reject mismatches, absent configuration and invalid challenges.

`POST /api/whatsapp/webhook`: read **raw bytes** once; calculate `HMAC-SHA256(raw body, WHATSAPP_APP_SECRET)`; compare `X-Hub-Signature-256: sha256=...` in constant time; reject absent/mismatched signatures, oversized payloads, wrong `metadata.phone_number_id`, malformed or unsupported events. Parse all `entry[].changes[].value.messages[]` and statuses independently, including multiple changes in one webhook. Explicitly support `type:"button"` with `button.payload`, and supported interactive button-reply variants. Do not process status notifications as owner messages.

To acknowledge fast **without losing events**, insert/enqueue the signed, bounded message + Meta `wamid` with a DB unique key **before** returning HTTP 200. Duplicate webhook => 200 without second owner turn/send; persistence/queue failure => non-2xx so Meta can retry. Process with a durable job/worker and retry controls. Next.js `after()`/Vercel `waitUntil` may reduce webhook latency but alone are not durable: they are bounded by function lifetime. Track queued/processing/completed/error, reclaim stale leases, limit per-owner concurrency, ignore older out-of-order turns unless explicitly supported, and use a transactional outbox to avoid duplicate replies. Status transitions distinguish API accepted (`wamid`) from delivered/read. No tokens, full receipt data or financial text in logs.

**Owner identity:** match a pre-verified phone binding and active owner membership to an explicit café; maintain independent selected-café binding for owner managing multiple cafés. Never choose “first café”, infer ownership from WhatsApp profile name, or grant a service-role agent unrestricted tools. Owner sender `wa_id` alone is not sufficient without prior binding/consent.

**Conversation bridge:** append exactly one authenticated owner message to existing `ai_threads`/`ai_messages` scoped by the binding; invoke the existing `runAgentTurn` service with its tools, owner facts, budgets, number checks, audit and persistence; then send exactly one provider `type:"text"` reply <= 4,096 characters, only while the customer's 24-hour window is valid **at send time**. Do not rewrite/clip the model's answer silently; if overlong, fail safely with an in-app link or explicitly bounded response policy consistent with AGENTS.md. If outside window, do not send free text; no arbitrary template fallback for a conversation reply. WhatsApp reply never approves operating actions.

**Media:** for signed, bound owner messages of supported image/document type: `GET /v21.0/{media_id}` with bearer token, validate response `url` host/HTTPS; download URL with bearer token before expiration; enforce byte, MIME/signature, filename/extension, timeout and malware/content policy checks; private storage and retention; record as a **draft** attachment in the existing `ai_attachments`/receipt-review flow. Images and PDFs have different supported paths; **never auto-post an expense, invoice, inventory item or purchase** without authenticated owner review/approval. Do not treat every unsolicited image as a receipt. If file type or parsing is unsupported, answer with a concise limitation rather than pretend it was processed.

### Three PRs and test sequence (no merge or production switch-on)

1. **A**: secure Meta send/webhook, RLS owner binding, durable inbox/outbox and dedupe. Send disabled until test readiness and owner authorization.
2. **B**: grounded, same-data morning briefing, seven ordered parameters, event/monitor fact gate, one daily message; import A transport only when available.
3. **C**: shared Supervisor turn across website/WhatsApp, four mapped button payloads, free text, website thread visibility/refresh and secure photo/PDF draft intake, then integrate with A dispatcher.

**End-to-end staging acceptance:** verified GET challenge; forged signature denied; signed webhook durable before 200; one actual test owner/café; one populated real-data briefing; all four Quick Reply interactions; free text; unknown-number/cross-café denied; photo/PDF review draft; concurrent browser/WhatsApp turn; page reopens with same messages; 24-hour expiration; one safe send per message. All standard AGENTS.md checks and independent Codex reviews. Confirm actual template approval/category and AI-provider applicability before permitting an owner-facing pilot.

**Acceptance criteria:** This template's event and monitoring claims are only sent when actually supported, no missing facts turn into zeros, every authorized WhatsApp question appears once in the same Supervisor thread, never a cross-café reply, no browser-route cookie forgery, and no duplicate WhatsApp messages. Track curiosity button selection and subsequent substantive follow-up without using click behavior to evade Meta messaging restrictions.
