# Plan: nearby events, holidays and readiness (owner priority 2)

Status: agreed with the owner on Oct 30 2026. Build it as the small PRs below, in order, one per chat session.
AGENTS.md wins over this file. Do not edit AGENTS.md.

## What the owner gets

The owner never has to think about "what's happening near my café". The Supervisor already knows, plans for
it, asks only what it can't know, watches the day, and reports back.

- **Home (Supervisor chat start):** one headline for the day that matters most, plus a 7-day strip.
  Example: "Tomorrow · Halloween — busier afternoon 2–6pm · 4 to prepare · 1 question for you".
- **Events panel**, opened from the strip. It slides up over the chat, so the owner never leaves the chat:
  - Tabs: **Past (14 days) · Now · Coming up (14 days)**, plus a **month calendar** to jump to any date.
  - Coming up: grouped by day, ranked by how much each event affects the café. Filter "Affects you · 6 /
    All · 10". A multi-day event is one row. Small events are folded away ("4 small events…").
  - Each event shows: name, time, venue/area, saved address (opens Maps), source link. No invented numeric distance.
- **Day plan** (tap a day): expected busy hours (usual hourly sales for that weekday, with event hours
  highlighted), one plain sentence explaining why, at most one question, and a "Get ready" checklist
  (staff, prep, ordering, bringing people in, hours, operations). Each item has its reason, and the
  owner ticks it off. A staffing item drafts the shift change as the usual approval card.
- **Question card** (shown under the AI's first plan, never instead of it): the AI's options (e.g. Busier / About the same / Quieter / Not open then) **plus
  "Other"**, which opens a text box. Typing is optional.
- **On the day:** the Home headline becomes a live watch: sales so far vs a usual day, checklist status,
  and live notes ("38 hot chocolates since 2pm, milk may run out by 5pm").
- **Chat about any event, any time.** Every day plan, event row, live note and report card has
  "Chat about this". It opens the Supervisor chat for that day (its own thread), with the event, the
  plan and the facts already in context. The owner can ask **anything** there, not only about the plan:
  "what's the parade route?", "is it going to rain?", "give me 3 Halloween drink names", "move the extra
  shift to 3pm", "how did this go last year?". The Supervisor answers like a capable general assistant:
  it uses its café tools, a general web search, and its own knowledge. It never answers "I can only help
  with…", so the owner never leaves the app to ask another AI. Actions still go through approval cards.
- **Report card** the morning after: what happened vs the plan. Report cards show in Past for 14 days,
  are kept in the database for good, and the chat can answer about any of them at any time ("how did
  Halloween go last year?").

Design mockup (sample data): https://claude.ai/artifact/UBRTrUsFqQAtxjTqi5JqK7

## Rules (from the owner, on top of AGENTS.md)

1. **All plans and advice come from the AI.** No hard-coded advice, holiday notes, "busier/quieter"
   rules or default actions in code. Code only supplies facts and calculates numbers.
2. **Answer first, then ask to make it better.** The AI always gives its best plan straight away from
   what it has (events, the café's usual hours for that weekday, its own general knowledge), and labels
   what is an estimate. If an owner answer would make the plan better (e.g. no Toast data for last
   Halloween), it adds ONE question (options + "Other"). The owner's answer is sent back to the AI,
   which updates the plan in the same thread ("since last Halloween was quiet, skip the extra person")
   and saves the answer as an owner fact for every year after. The owner is never left waiting on a
   question.
3. **Discover, save and verify without repeated full research.** Opening Home and reading saved events
   in chat never starts research or rewrites owner decisions. The target schedule (PR 10): bootstrap
   the full 14-day window once, then search only the one new boundary day each day; once a week look
   specifically for newly announced events in already covered dates without replacing saved facts.
   Verify important upcoming events *early enough to protect preparation decisions* (not just the day
   before), and again as their dates approach. Confirm cancellations, postponements and venue/time
   changes against reliable sources; missing search results or failed checks are **not** cancellations.
   Retain original event history, notify the owner through the existing inbox/thread, and let the AI
   explain the impact on preparation. Never silently cancel staff, orders or an approved plan.
4. **Advice is more than staffing:** staff, prep/stock, ordering (lead times), menu/promo, opening
   hours, operations (road closures, deliveries).
5. **One system, one data layer (AGENTS.md sections 3 and 5).** A day's readiness plan is a
   **capability in the existing Supervisor loop** (`lib/ai/supervisor/loop/`): the plan is a
   `supervisor_proposals` row, live notes are its mid-run updates, and the report card is a
   `supervisor_reports` row, exactly like goals. No second monitor, plan or report system. Only
   supporting facts get their own tables (found events, checklist ticks). Owner answers are owner facts.
   The board panels and the chat tools read all of it through the same readers in `lib/data/` and
   `lib/ai/supervisor/loop/reads.server.ts`.
6. **The conversation is never restrictive.** Any question gets a real answer: café data through
   tools, the outside world through web search (with source links), ideas and writing from the
   model itself. If something truly can't be done, the AI says what it can do instead.
7. **Not noisy:** at most 1–3 actions per day, ranked by impact. The day-before reminder appears only
   if a checklist item is still open. One inbox item per planned day; no duplicates.
8. **Every new API route and job** checks the owner role and the café's AI access before any paid AI or
   search call (`authenticatedConversationContext` + `assertCafeAiAccess`, as in #271).
9. Numbers: only from `lib/metrics/core` tools or `calculate` (AGENTS.md 7.2); "usual" means the café's
   own Toast days; unknown is never shown as zero.

## What exists today (after #271)

- `lib/events/holidays.ts` — holidays from `date-holidays` 3.37.0. **Remove `CAFE_NOTES`** (hard-coded
  advice). Keep the dates and names.
- `lib/events/outlook.ts` — builder shared by chat and card. **Remove `decideDay` and the `notable`
  rule** (hard-coded decisions).
- `lib/events/nearbyEvents.ts`, `nearbyEventsSearch.server.ts` — the web search. **Broken in production**
  (see PR 1).
- `lib/metrics/core/dayOutlook.ts` — usual-day median and last-time change (keep).
- `lib/data/cafeLocation.server.ts` — café location from the profile, else the `cafe_address` owner fact (keep).
- `lib/ai/agent/tools/events.ts` — `get_nearby_events` chat tool (becomes facts-only).
- `components/home/ComingUpCard.tsx`, `/api/events/outlook` — the board card (replaced in PR 5).

## Production evidence (Vercel logs, Oct 29, 11:28–11:33pm Pacific)

- `get_nearby_events` ran from chat (13.9 s, partial) and from Home (`/api/events/outlook`).
- Every search logged `nearby_events_search_unparsed`: OpenAI returned HTTP 200, but the app couldn't
  read an events JSON from it.
- Cause in code: the fallbacks (preview tool name, plain JSON) only run on HTTP 400. A 200 with
  `status:"incomplete"`, no `message` output, or non-JSON text is treated as a failure at once. No safe
  diagnostics were logged, so the exact reason is unknown. Likely: the 1,200 output-token cap (web search
  with a reasoning model uses tokens before writing the answer), or strict JSON being ignored alongside
  web search.
- The AI then said "add staff" from the hard-coded Halloween note. That is what rules 1–2 above fix.

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Panels over the chat (not standalone screens) for the events list, calendar, day plan, past reports | **Agreed** |
| D2 | New supporting tables for found events and checklist ticks (migration, RLS). Plans and reports use the existing `supervisor_proposals` / `supervisor_reports` | Owner approves the migration PR before merge |
| D3 | No geocoding, numeric distance or extra location dependency. Show the saved venue/area and a clickable saved address opening Maps. | **Agreed Oct 30** (PR 8) |
| D4 | Output-token budget for the internal search call (above the 1,200 used for chat turns) | **Open**: PR 1 proposes a number with evidence; owner approves |
| D5 | Bootstrap 14 days once; daily one new date; weekly newly announced events; early verification of important saved events and imminent-event checks, with confirmed changes and owner notification. No wholesale weekly refresh. | **Agreed Oct 30**; PR 10 must implement and test |
| D6 | A general web search tool for the chat (PR 9), small cost per search | Proposed: needed so the owner never leaves the app |

## PRs, in order

Each PR: small (ideally < 400 changed lines), one concern, tests for the behavior, the AGENTS.md
"Done" checks, and a PROGRESS.md tick. Do not edit AGENTS.md.

### PR 1 — Make the web search work and say why when it doesn't

- Treat a 200 with `status:"incomplete"`, no message output, empty text or unparseable JSON as a
  retryable failure: retry once in the plain-JSON format; then give up.
- Log safe diagnostics only: response `status`, `incomplete_details.reason`, output item types, which
  attempt, parse-failure category, duration. Never the address, the prompt or the page text.
- Search per holiday in the window ("Halloween events near <address> <date>") plus one general search,
  merged and de-duplicated. Ask for the venue address and start/end times.
- Return three distinct outcomes: `found`, `none_found` (searched, nothing nearby), `failed`
  (with category). The chat and card must say which.
- Output budget: measure on the test café, propose a number (D4), keep it in one constant.
- **Time:** web search often takes 10–40 s. Production: one search returned in ~14 s, so the failure was
  reading the reply, not time. With retries, the total can pass the 60 s chat-turn limit, so:
  - **Background search (cron, PR 4): generous time** (e.g. up to 60 s per attempt, 2 attempts). Nobody
    is waiting.
  - **Inside a chat turn: never block on a slow search.** Answer at once from saved events plus holidays
    and the café's own data. If nothing is saved yet, say "I'm checking local events now and will post
    them here", start the search in the background, and post the result to the same thread when done.
  - Log the duration of every attempt, so the right limits are set from real numbers.
- Tests: recorded real-shape failure fixtures (incomplete, reasoning-only output, prose instead of
  JSON, fenced JSON, empty list), not only the happy path.
- Check: the test café's Halloween search finds local events, or logs a clear reason.

> **Prompt for a new chat:** "Read AGENTS.md and docs/plans/nearby-events.md. Do PR 1 only: make the
> nearby-events web search robust (lib/events/nearbyEventsSearch.server.ts, lib/events/nearbyEvents.ts)
> as described there, with real failure-shape tests. Don't touch other PR scopes. Open a PR when the
> AGENTS.md Done checks pass."

### PR 2 — Facts only: remove hard-coded advice; the AI plans and asks

- Delete `CAFE_NOTES` (`lib/events/holidays.ts`) and `decideDay` / `notable` (`lib/events/outlook.ts`);
  update their tests (list each changed test in the PR, per AGENTS.md section 9).
- `get_nearby_events` returns facts only, per day: holidays, events (time, venue, distance or area,
  source), café opening hours that day, usual sales for that weekday **by hour** (peak-hours reader),
  last-year same day if any, top items on similar days, people scheduled, saved owner answers.
  Keep it under ~1.5k tokens.
- Tool description and system prompt: the AI always writes its best plan first (expected busy hours,
  actions across staff / prep / ordering / promo / hours / operations, each with a reason from the
  facts), labelling estimates; with no history for a day like it, it adds one question. The owner's
  answer goes back to the AI, which updates the plan and saves the answer.
- **Question card with "Other":** the facts-card `choice` field renders today as a `<select>` with no
  free text. Make choices tap buttons and add an "Other" button that opens an optional text box
  (`components/home/ClarifyCard.tsx`). Save the answer as an owner fact keyed by event and year, e.g.
  `event_outcome:halloween:2025`.
- The current "Coming up" card shows facts only (no verdict pill) until PR 5 replaces it.
- Check: "anything happening this week?" on the test café gives an AI-written plan with hours at once
  (estimates labelled), plus at most one question; answering it updates the plan.

> **Prompt:** "Read AGENTS.md and docs/plans/nearby-events.md. Do PR 2 only: remove the hard-coded
> advice, make get_nearby_events facts-only with hourly usual sales, and add the 'Other' option to the
> choice question card. Open a PR when the Done checks pass."

### PR 3 — Event readiness in the Supervisor loop, plus supporting storage (migration: owner approves)

- **New loop capability `event_readiness`** (`lib/ai/supervisor/loop/eventReadiness.server.ts`,
  registered like `goal.server.ts`), so plans, monitoring and reports use the one lifecycle:
  - **Proposal = the AI's plan for one day** (summary, expected busy hours, 1–3 actions with area and
    reason, the facts it used, a `facts_hash`). Inert: "Use this plan" approves it; commit has no side
    effect (`verified`, like a goal); staff actions stay their own `propose_*` cards.
  - **Monitor** = each business day of the window (the event day, or the days of a multi-day event):
    a sample of sales vs a usual day by hour (core readers) and checklist status.
  - **Report** = `supervisor_reports`: mid-run updates (live notes) and the final report card, with the
    numbers from core; the owner-facing wording is written by the AI in the day's thread from that
    report (PR 7).
- **Supporting tables** (RLS on, café-scoped, AGENTS.md section 8):
  - `cafe_events`: one row per found event or holiday (dates, start/end time, name, kind, venue, venue
    address, distance or area label, source URL, status `found`/`cancelled`/`moved`, `found_at`,
    `last_checked_at`). Facts only, no advice.
  - `cafe_event_checklist`: one row per plan action the owner ticks or dismisses, keyed by proposal id.
- Readers: `lib/data/cafeEvents.server.ts` (found events, any date range) and the existing
  `reads.server.ts` for proposals and reports. Chat tools on them: `get_events` (any range, past or
  future, with each day's plan and report status) and the existing report reads, so the chat can answer
  "how did Halloween go?" at any time.
- No UI change in this PR. Add the capability to `capabilityExposure.test.ts` (or document why not).

> **Prompt:** "Read AGENTS.md and docs/plans/nearby-events.md. Do PR 3 only: the event_readiness
> capability in the existing Supervisor loop (plans as supervisor_proposals, reports in
> supervisor_reports), the migration for cafe_events and cafe_event_checklist with RLS, one reader in
> lib/data, and the get_events chat tool. No second monitor or report system. Don't apply the migration
> to production; the owner approves it."

### PR 4 — Find once, plan once (scheduled job)

- A cron route (`app/api/cron/events-lookahead`): weekly 14-day look-ahead (D5), then each day only the
  new day entering the window, plus a day-before check for each planned day. Writes `cafe_events` only.
- For each notable day without a plan, or whose `facts_hash` changed, run the **same agent loop** as a
  system turn in that day's chat thread. The agent drafts the plan with a strict
  `propose_event_plan` tool, which creates the `event_readiness` proposal through `proposeLoop`
  (like `propose_goal`). The owner sees it as the usual approval card ("Use this plan").
- One inbox item (`operating_tasks`) per newly planned day; no duplicates; daily cap (AGENTS.md section 4).
- Opening the app never triggers this job.

> **Prompt:** "Read AGENTS.md and docs/plans/nearby-events.md. Do PR 4 only: the events look-ahead cron
> and plan-once via the agent loop with a propose_event_plan tool creating event_readiness proposals,
> plus inbox items. Requires PR 3 merged."

### PR 5 — Home strip and the events panel (UI)

- Replace `ComingUpCard` with: headline + 7-day strip on the chat start; the events panel (Past · Now ·
  Coming up tabs, month calendar, "Affects you / All" filter, folded small events, distance or area tag);
  the day-plan panel (busy-hours bars, why, question card, checklist with ticks saved to
  `cafe_event_checklist`, "Use this plan" approval).
- Reads only saved data through the PR 3 readers (no search on open). The Operating Board's "Running"
  and "Recent reports" show event plans like any other loop item, from the same rows.
- Follows `docs/02-design-system.md`: 48px targets, 17px body, EN/ES/AR, RTL, reduced motion. Matches
  the mockup. Screenshot at phone width in the PR.

> **Prompt:** "Read AGENTS.md, docs/02-design-system.md and docs/plans/nearby-events.md, and look at the
> mockup linked there. Do PR 5 only: the Home strip, events panel (Past/Now/Coming up + calendar) and
> day-plan panel over the Supervisor chat, reading the PR 3 readers. Requires PRs 3–4 merged."

### PR 6 — On the day: live watch (loop mid-run updates)

- During open hours on a planned day, the existing live checks (~30 min, `today-live` cron) run the
  `event_readiness` monitor on the live reading; notable changes become the loop's mid-run update in
  `supervisor_reports`, and the AI posts a short note in the day's thread. At most a few per day. The
  Home headline shows the latest.

### PR 7 — Report card the morning after (loop final report)

- Morning after the window: the `event_readiness` final report in `supervisor_reports` (actual vs usual
  by hour from core; checklist done or not); the AI writes the owner-facing report card in the thread
  from it; an inbox item. Past tab shows 14 days; reports are kept for good, and next year's plan reads
  them as evidence.

### PR 9 — Chat about any event, and answer anything (can run in wave 1)

- A general, read-only `web_search` chat tool (strict schema, compact results with source links, safe
  logs, counted in the turn budget, AI-access checked). The model uses it for any outside-world
  question: weather, routes, opening times, ideas, news.
- System prompt: answer every owner question helpfully, café-related or general; never refuse with
  "I only help with…"; use tools for café facts, web search for the outside world, and own knowledge
  for ideas and writing; say plainly when something can't be done and offer what can.
- "Chat about this" on an event or day opens its own thread with the event, plan and facts as context
  (through the PR 3 reader once merged; the event facts from `get_nearby_events` before that).
- Golden owner questions for event threads, e.g. "what's the parade route?", "3 Halloween drink names",
  "move the extra shift to 3pm" (→ approval card).

> **Prompt:** "Read AGENTS.md and docs/plans/nearby-events.md. Do PR 9 only: a general read-only
> web_search chat tool, a never-restrictive answer rule in the system prompt, and 'Chat about this' for
> an event day opening its own thread with the event context. Open a PR when the Done checks pass."

### PR 8 — Saved venue map links (D3 agreed)

- In the existing PR 5 events list and day panel, show a **saved venue address** as a one-tap
  external Google Maps search link so owners can inspect distance and directions themselves.
  If no sourced venue address was saved, show the venue/area and source link only.
- No guessed distances, geocoder, new API, coordinates, migration, browser location or research on open.
  Retain the existing panels and EN/ES/AR + RTL + 48px touch behavior. Test link safety,
  missing addresses and localization. Keep PR 6/7 event-monitor/report code untouched.

### PR 10 — Early event verification, rolling discovery and change notifications (after PRs 6–8)

- Extend **the existing** PR 4 scheduled search and `cafe_events` facts, not a second event system.
  On first eligible run (on any weekday), cover 14 days. Thereafter only discover the new boundary day
  each day; the weekly pass asks for recently announced events in the already-covered window and
  merges *new* facts without resetting confirmed records, owner decisions or saved plans.
- Verify saved **important** upcoming events daily before likely owner preparations (ordering/shift
  lead time), again on imminent days; use source-backed AI research for cancellation, postponed,
  reopened, moved or changed time/venue. Model assesses significance, code validates and stores only
  sourced factual changes. Missing or failed search is unknown, **never** evidence of cancellation.
- Preserve original event and changes, update status only on verified evidence, and use the **existing**
  `operating_tasks` inbox plus event-day Supervisor thread for one deduplicated owner alert:
  what changed, when checked, why it may affect prep, and what to review. Do **not** amend an approved
  schedule, purchase, staff plan or POS automatically. The AI proposes; owner chooses any action.
- Track successful vs failed/unsearched date coverage (including dates with zero events), without
  another events store. If a schema change truly proves necessary, request owner approval separately.
  Test non-Monday bootstrap, daily boundary, weekly late announcements, cancellation known 5 days
  ahead, moved/reopened, failed checks, unchanged event, no duplicate inbox, and owner approval.
- Feature remains default-off until owner-approved migration/rollout and real café smoke tests.

### PR 11 — One saved-events read for chat and Home (after PR 10)

- Make the active `get_nearby_events` chat experience read the same owner-scoped saved facts and
  plans as the PR 5 Home panel / `get_events` reader by default. No paid live search just because
  the owner asks what is already saved; use the existing general web-search tool only when the owner
  explicitly asks for fresh external information. Avoid duplicate business-data readers.
- Verify exact saved event/status/plan parity between chat and Home, no search on screen open,
  honest never-searched/failed coverage, and access to older saved event reports by date.
  Remove or retire obsolete read paths only in a separate deletion-only cleanup PR if appropriate.

### Owner acceptance / rollout (not a separate new system)

- After PRs 6, 7, 8, 10 and 11 are reviewed/merged, verify the approved café-events RLS migration,
  cron/live-watch flags and authorized test café access before activation. Run a real 14-day bootstrap,
  a next-day boundary, an early sourced cancellation with existing prep plans, owner inbox review,
  live monitoring, next-morning saved report, EN/ES/AR and 360–430px phone screenshots.
  Do not merge, activate flags, apply migrations or deploy without owner approval.

## How to run this with new chats

1. Merge the PR that adds this file first, so every new chat reads it from `main`.
2. One Claude Code session per PR, started from the latest `main`, using that PR's prompt above.
3. Each session opens its PR. Codex reviews it; fix and re-request review in that same session.
4. PR 3's migration is applied only after you approve it.
5. After each merge, check the test café.

### Running PRs at the same time (waves)

PRs in the same wave don't depend on each other and can run in parallel, one chat each. Start a wave
only after the previous wave is merged.

| Wave | PRs in parallel | Why they can |
|---|---|---|
| 1 | PR 1 (search), PR 2 (facts-only + "Other"), PR 3 (storage), PR 9 (open chat + web search) | Different files; none needs another |
| 2 | PR 4 (find once / plan once), PR 5 (Home strip + panels) | Both need PR 3; PR 4 also uses PR 1–2 |
| 3 | PR 6 (live watch), PR 7 (report card), PR 8 (Maps links) | Need PRs 4–5; PR 8 merges after PRs 6 and 7 per owner |

After wave 3: PR 10 (search/status verification) then PR 11 (saved chat parity). These are explicit
follow-up PRs, **not** part of PR 8. Confirm final event flows on the test café before rollout.

Shared files will clash a little: `lib/ai/agent/tools/index.ts`, the pinned tool list in
`lib/ai/agent/agent.test.ts`, the system prompt in `lib/ai/agent/loop.server.ts`, `messages/*.json`
and `PROGRESS.md`. The second PR to merge does a normal "merge main into branch" and keeps both sides.
Ask that PR's chat to do it. Keep to at most 4 chats at once, so reviews and merges stay manageable.
