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
  - Each event shows: name, time, **distance tag ("0.3 mi")**, source link.
- **Day plan** (tap a day): expected busy hours (usual hourly sales for that weekday, with event hours
  highlighted), one plain sentence explaining why, at most one question, and a "Get ready" checklist
  (staff, prep, ordering, bringing people in, hours, operations). Each item has its reason, and the
  owner ticks it off. A staffing item drafts the shift change as the usual approval card.
- **Question card:** the AI's options (e.g. Busier / About the same / Quieter / Not open then) **plus
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
2. **No evidence → ask, don't guess.** If the café has no history for a day like it, the AI asks the
   owner (options + Other). The answer is saved as an owner fact and used every year after.
3. **Search once, keep it.** Events and plans are saved. Opening the app reads the saved rows; it never
   triggers a new search or rewrites advice the owner has already seen. Refresh only when: a new day
   enters the 14-day window, the address changes, or the day-before check finds a change (cancelled,
   moved).
4. **Advice is more than staffing:** staff, prep/stock, ordering (lead times), menu/promo, opening
   hours, operations (road closures, deliveries).
5. **One data layer.** Everything (events, plans, answers, checklist status, reports) is in tables read
   by one set of readers in `lib/data/`. The board panels and the chat tools use the same readers.
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
| D2 | New tables for events, plans, answers, checklist, reports (migration, RLS) | Owner approves the migration PR before merge |
| D3 | Distance: a geocoding service (Google Maps / Mapbox) for "0.3 mi" tags vs the venue/area name only | **Open**: until decided, show the venue or area name; never a guessed number |
| D4 | Output-token budget for the internal search call (above the 1,200 used for chat turns) | **Open**: PR 1 proposes a number with evidence; owner approves |
| D5 | Look-ahead timing: weekly on Monday morning + one new day each day + day-before check | Proposed |
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
- Tool description and system prompt: the AI writes the plan (expected busy hours, actions across
  staff / prep / ordering / promo / hours / operations, each with a reason from the facts); with no
  history for a day like it, it asks the owner instead of advising.
- **Question card with "Other":** the facts-card `choice` field renders today as a `<select>` with no
  free text. Make choices tap buttons and add an "Other" button that opens an optional text box
  (`components/home/ClarifyCard.tsx`). Save the answer as an owner fact keyed by event and year, e.g.
  `event_outcome:halloween:2025`.
- The current "Coming up" card shows facts only (no verdict pill) until PR 5 replaces it.
- Check: "anything happening this week?" on the test café gives an AI-written plan with hours, or one
  question, and never "add staff" without evidence.

> **Prompt:** "Read AGENTS.md and docs/plans/nearby-events.md. Do PR 2 only: remove the hard-coded
> advice, make get_nearby_events facts-only with hourly usual sales, and add the 'Other' option to the
> choice question card. Open a PR when the Done checks pass."

### PR 3 — Storage and one reader (migration: owner approves before merge)

- Tables (RLS on, café-scoped, AGENTS.md section 8):
  - `cafe_events` — one row per event or holiday: dates, start/end time, name, kind, venue, venue
    address, distance or area label, source URL, status (`found`/`cancelled`/`moved`), `found_at`,
    `last_checked_at`.
  - `cafe_event_days` — one row per café per notable day: the AI's plan (summary, expected busy hours,
    actions with area + reason + status `open`/`done`/`dismissed`), the question and the owner's answer,
    the thread id, `plan_written_at`, and a `facts_hash` (rewrite the plan only when the facts change).
  - `cafe_event_reports` — the morning-after report: actual vs usual numbers (from core), the AI's
    summary, checklist outcome.
- One reader module `lib/data/cafeEvents.server.ts` for Past / Now / Coming up / a date range.
- Chat tools on that reader: `get_events` (any date range, past or future) and `get_event_report`, so
  the chat can answer "how did Halloween go?" at any time.
- No UI change in this PR.

> **Prompt:** "Read AGENTS.md and docs/plans/nearby-events.md. Do PR 3 only: the migration for
> cafe_events / cafe_event_days / cafe_event_reports with RLS, one reader in lib/data, and the get_events
> and get_event_report chat tools. Don't apply the migration to production; the owner approves it."

### PR 4 — Find once, plan once (scheduled job)

- A cron route (`app/api/cron/events-lookahead`): weekly 14-day look-ahead (D5), then each day only the
  new day entering the window, plus a day-before check for each planned day. Writes `cafe_events`.
- For each notable day without a plan, or whose `facts_hash` changed, run the **same agent loop** as
  a system turn in an "Events" chat thread. The agent saves its plan through one strict tool
  (`save_event_plan`). The plan is an inert draft; staff changes stay `propose_*` cards.
- One inbox item (`operating_tasks`) per newly planned day; no duplicates; daily cap (AGENTS.md section 4).
- Opening the app never triggers this job.

> **Prompt:** "Read AGENTS.md and docs/plans/nearby-events.md. Do PR 4 only: the events look-ahead cron,
> plan-once via the agent loop and a save_event_plan tool, and inbox items. Requires PR 3 merged."

### PR 5 — Home strip and the events panel (UI)

- Replace `ComingUpCard` with: headline + 7-day strip on the chat start; the events panel (Past · Now ·
  Coming up tabs, month calendar, "Affects you / All" filter, folded small events, distance or area tag);
  the day-plan panel (busy-hours bars, why, question card, checklist with ticks saved through the reader).
- Reads only saved rows (no search on open). Follows `docs/02-design-system.md`: 48px targets, 17px
  body, EN/ES/AR, RTL, reduced motion. Matches the mockup.
- Screenshot at phone width in the PR.

> **Prompt:** "Read AGENTS.md, docs/02-design-system.md and docs/plans/nearby-events.md, and look at the
> mockup linked there. Do PR 5 only: the Home strip, events panel (Past/Now/Coming up + calendar) and
> day-plan panel over the Supervisor chat, reading the PR 3 reader. Requires PRs 3–4 merged."

### PR 6 — On the day: live watch

- During open hours on a planned day, the existing live checks (~30 min, `today-live` cron) compare
  sales so far and the hourly pace with a usual day, and checklist status; the AI writes at most a few
  short live notes into the day row and the chat thread. The Home headline shows them.

### PR 7 — Report card the morning after

- Morning after a planned day: numbers from core (actual vs usual, by hour; checklist done or not); the
  AI writes the report into `cafe_event_reports` and the thread; an inbox item. Past tab shows 14 days.
  Next year's plan reads this report as evidence.

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

### PR 8 (optional, after D3) — Real distance

- Geocode the café once and each venue once; store lat/lng; show "0.3 mi". Until then: venue or area name.

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
| 3 | PR 6 (live watch), PR 7 (report card), PR 8 (distance, after D3) | Need PRs 4–5 |

Shared files will clash a little: `lib/ai/agent/tools/index.ts`, the pinned tool list in
`lib/ai/agent/agent.test.ts`, the system prompt in `lib/ai/agent/loop.server.ts`, `messages/*.json`
and `PROGRESS.md`. The second PR to merge does a normal "merge main into branch" and keeps both sides.
Ask that PR's chat to do it. Keep to at most 4 chats at once, so reviews and merges stay manageable.
