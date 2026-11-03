# Plan: Local Demand Intelligence — ONE Events path

Status: **owner-requested planning record, November 2, 2026; implementation not started**. Parallel development is permitted only for distinct file ownership; connecting the pieces is a separate tested responsibility. This is not permission to merge, deploy, run production SQL, change flags or purchase a provider. Read `AGENTS.md` and `PROGRESS.md` first; `AGENTS.md` wins. Preserve the historical `docs/plans/nearby-events.md`; its October 30 owner decision on automatic read-only observation and business-action approvals still applies.

## Owner journey / definition of the product

An owner supplies **only a café address**; POS history is useful but not required to start. Without interviewing the owner, AI CAFE researches the area's demand generators and the city's events. In the existing Events panel and Supervisor chat the owner can:

- Browse **All City Events**: every *discovered* public event, with date, venue when confirmed, source, freshness, and honest incomplete coverage. Never falsely claim to list literally every city event.
- Read **For My Café**: the same Supervisor's café-specific demand outlook and, when justified, concise preparation advice. It considers venue access, likely approaches, event hours, attendance, normal neighborhood patterns, competition, café opening hours, Toast baseline and uncertainty; no hardcoded radius/attendance-to-sales rule.
- Open any city event and ask Supervisor to investigate it, including events Supervisor did not proactively highlight.
- Benefit automatically from subsequent observations. Recorded Toast results, prior event reports, changing public facts and owner-supplied observations refine *future* judgments; owner feedback is optional, not a prerequisite.
- Receive only deduplicated, useful proactive findings. Uncertain impact is **unknown**, not normal, zero, or proven extra sales. Association with increased sales is not proof of causation.

Three linked kinds of knowledge: **city event intelligence** (public and reusable across cafés), **neighborhood demand intelligence** (place facts plus location-specific hypotheses), and **café performance intelligence** (private POS baseline, historical observations, owner facts and prior Supervisor reports).

## Inspected current code and real gaps

- `vercel.json` schedules **one** `/api/cron/events-lookahead` at `10 15 * * *` UTC. `lib/events/eventsLookahead.ts` selects initial 14-day, daily one entering day, and Monday full-window rediscovery. `lib/events/eventsLookahead.server.ts` checks café owner/AI access, runs those windows, saves events, verifies changes, then asks Supervisor for proposals.
- `lib/events/nearbyEvents.ts` currently asks OpenAI to web-search approximately 2 miles around one café, plus holiday queries; it demands `{events:[{name,startDate,sourceUrl}]}`, **at most five** per prompt. `nearbyEventsSearch.server.ts` caps the combined result at **eight**, `max_output_tokens=1200`, with bounded fallback/retries; success/partial/failure must remain distinct.
- `cafe_event_search_state` is **per café**, not a city/source coverage ledger. `cafe_events` stores café-scoped dated discoveries and verification. `eventIdentity` uses kind + name + date + URL; minor name differences can produce duplicate events. The minimal OpenAI response leaves saved `venue`, address and event time null. `upsert(...ignoreDuplicates:true)` preserves history but does not enrich an existing fact.
- `eventVerification.server.ts` performs source-specific checks for **planned** events, limited to three/day, through the **same** lookahead job. Absence from web results never proves cancellation; preserve this.
- `draftDay` in `eventsLookahead.server.ts` calls `runAgentTurn` with **only** `propose_event_plan`. It sees saved day facts, usual hourly sales, past reports and some `event_outcome:*` owner facts; it cannot follow up on missing venue/attendance/route evidence and requires the proposal's event IDs to equal **all** provided day events. It caps new day-plan notices at three/day.
- One live observation path exists: `/api/cron/today-live` → `eventLiveWatch.server.ts` → existing Supervisor monitor samples (gated by Toast refresh, saved hours, data availability and Events enablement); next-day reconciliation is in the lookahead job. Do not build another monitor, report, inbox or approval path.
- `lib/data/cafeEvents.server.ts::readSavedEventTimeline` supplies the existing canonical Events read for Home/API/chat. `components/home/SavedEventsCard.tsx` renders the in-place panel. `lib/ai/agent/tools/getEvents.ts` reads saved events. **Legacy divergence:** `lib/ai/agent/tools/events.ts::get_nearby_events` still has a fallback through `buildEventsOutlook` when the saved-events port is absent. Name this and retire the fallback after parity tests; never add a third query path.
- `PROGRESS.md` still lists an unchecked **Events Fix C** owning the Events UI and canonical read/API. Treat this as an ownership/merge gate: check the actual PR/branch state and resolve it before overlapping files are edited. Do not silently replace its scope.

## ONE production path and data authority

```text
Existing authorized Events cron (initial / daily / Monday / verification)
  -> source-backed CITY + venue research and recorded coverage
  -> ONE canonical public event identity/fact source
  -> café's neighborhood demand context + private owner/POS facts
  -> ONE existing Supervisor tool-calling loop (event selection / advice)
  -> existing Supervisor proposals, messages, inbox, monitors and reports
  -> ONE canonical Events reader -> existing in-place Events panel + chat
  -> verified/partial Toast observations feed the next assessment
```

1. **One research runner:** extend `events-lookahead` and its existing search/verification helpers. Do not add per-category, per-café or neighborhood crons. Per-city/public searches should be reusable for cafés in the same city, with bounded source-specific coverage, retries and deduplication; café authorization remains mandatory before its personal analysis or paid café-specific work.
2. **One authoritative event-fact source:** evolve the current Events data path to support shared city facts and per-café associations. New public event name/date/venue/source facts have **one canonical authority**; `cafe_events` keeps its existing IDs and historical proposal/report references, serving as a legacy snapshot/association during migration, not a competing second writable event database. All new/old readings resolve through **`lib/data/cafeEvents.server.ts`**, used by Home, chat and APIs. The first schema PR must state the authority and safe backfill, uniqueness, RLS and compatibility contract explicitly. Do not rewrite approved owner decisions or old report identities.
3. **One neighborhood knowledge path:** scheduled address-based discovery (not an owner interview) identifies likely demand generators and their dated official calendars, locations, access/transport evidence and nearby alternatives. Public place facts may be reusable; café-specific hypotheses and owner facts remain private. Save sources, dates, uncertainty and refresh status. Research updates feed the *existing* event discovery and Supervisor; they are not a separate agent or event store.
4. **One decision-maker:** existing Supervisor decides which specific event IDs warrant analysis and what to tell this café, with safe, bounded `web_search`/data tools available where needed. Code supplies facts, verified numeric calculations and scope; it does not assign a fixed impact score or rewrite the model's explanation. An event may remain in All City Events without a proactive plan.
5. **One learning/monitoring loop:** reuse `owner_facts`, canonical Toast readers, `supervisor_proposals`, `supervisor_monitor_samples`, `supervisor_reports`, `operating_tasks` and `ai_messages`. Historical outcomes are evidence, not automatic attribution. Do not create an independent forecast, inbox, report or learning agent.
6. **One UI/API:** extend the existing in-place Events panel; keep Past/Today/Upcoming, saved sources, exact-event drilldown and intentional "Chat about this." Add All City Events and For My Café as views over the same canonical reader, not separate search-on-open endpoints.

**D3 route-provider decision is still binding:** no paid geocoding, maps-distance or foot-traffic provider is approved. Start with cited public directions, entrances, timing and transit evidence; when actual route metrics are missing, say so. A new route provider requires an explicit owner decision and a separate scoped integration; do not block the core product on it.

## What OpenAI is sent and what gets saved

**Discovery (existing compact factual web-search call, repeated by researched source/window):** "Find confirmed San Francisco public events between [dates] from this specific official venue calendar / city source. Give exactly name, local startDate and URL confirming the date; omit unsupported listings." Also retain a broad city catch-all and existing holidays. **Receive** compact, cited event candidates; **save** one canonical event fact and source/coverage evidence. If one source fails, mark only that scope incomplete and retry; do not claim the whole city was checked. Keep the existing 1,200-token cap and bounded retries.

**Focused factual enrichment (only for selected candidates or missing high-value facts):** "From the event/organizer source, confirm venue/address, dates/hours, attendance, access information, and the URLs for each claim; return unknown for anything not established." **Save** bounded, provenance-tagged verified/unknown facts, not unbounded prose and not unsourced attendance guesses. Do not try a giant multi-event JSON response.

**Neighborhood discovery (on first eligible scheduled run and later source-refresh):** "From this café's saved address, identify public destinations and regular activities that plausibly generate demand, official calendars and visitor approaches, with sources and uncertainty." **Save** public place identities/source coverage plus café-scoped hypotheses; do not invent historical business impact.

**Supervisor impact turn:** Provide the current café identity/address/hours, discovered events and enrichment, neighborhood evidence, normal and prior comparable Toast observations, relevant prior event reports and owner facts. Ask: "Which specific events, if any, justify a café-specific insight? Investigate gaps within the tool budget; distinguish known, estimated and missing; explain likely direction and at most three useful actions. Never imply an actual purchase, POS, marketing or schedule change." **Save** selected-event reasoning as the existing Supervisor proposal/message and inbox item; weak-evidence events stay in the city catalog without noisy alerts.

**Afterward:** existing monitors/reports save actual/provisional Toast evidence. Later Supervisor assessments read those recorded outcomes alongside other possible explanations. Owner statements are saved as owner facts only when the owner actually says them, not when AI hypothesizes them.

**Ready-to-copy instructions:** [parallel workstream PR prompts](local-demand-intelligence-pr-prompts.md).

## Parallel implementation without parallel systems

**Key distinction:** Independent research/storage/evidence modules may be coded in parallel, but there is still **ONE production Events pipeline**. No workstream may create a second cron, screen query, report loop, agent or competing writer. Starting a PR never waits for another PR to merge; **merging and releasing follow integration gates**.

**Start rule:** All four independent workstreams below may start **now** from latest `main`, using this planning PR (#329) as the contract even if it has not merged. Do not branch from #329 or another unmerged feature branch, and do not assume a future module exists. Each PR must compile and pass tests **against its own current-main branch**, deliver its entire assigned output contract, and use its own recorded fixtures. After others merge, rebase/update before final review. If a proposed implementation really requires a not-yet-merged file, isolate and test the dependency-free adapter rather than waiting, editing someone else's file, or inventing a duplicate path. Do not mark whole-product integration complete from independent adapter tests.

### Frozen cross-PR contracts (the integration owner enforces these)

- **City candidate**: `name`, confirmed local `startDate`, `sourceUrl`. This is the existing compact strict search contract; enrichment is separate. City research returns candidates **plus** a source/window identifier and `found | none_found | partial | failed` coverage, each scoped by a date range and checked-at time. Never claim a failed venue was researched successfully.
- **Neighborhood candidate**: sourced place identity/address/type and official calendar/visitor information when documented; unknown fields remain null. Distinguish **public place fact** from **café-specific demand hypothesis** and from **actual observed demand**. No owner statement is invented.
- **Performance evidence**: café-scoped event/date, comparable certified Toast baseline and actual/provisional readings with coverage, relevant saved reports and owner facts; do not calculate a new money metric or assign event causation. Return a compact, typed fact bundle for Supervisor.
- **Identity/storage**: one shared public event identity and source evidence, one café-event association compatible with **existing `cafe_events` IDs**, one source-coverage ledger and a scoped neighborhood evidence area; the existing `lib/data/cafeEvents.server.ts` is the eventual **single consumer reader** for UI and chat. No duplicate long-term event authority.

### Wave 1 — four parallel PRs (all independent, start from main)

| PR / exclusive file ownership | Entire assigned deliverable and acceptance checks | Must NOT edit |
| --- | --- | --- |
| **A — Storage/identity foundation**. New RLS migration(s), `lib/events/cityEventIdentity*`, `lib/events/cityEventPersistence*`, and dedicated tests. **Only A owns new schema/migration numbering.** | Additive public-event/source/coverage/neighborhood data definitions, deterministic dedupe/compatibility mapping, atomic idempotent canonical writes, café-private association safeguards. Test two cafés share only public facts, legacy IDs/history remain stable, RLS isolation and replays. Stage migration only; never apply production SQL. | Cron, existing `cafeEvents.server.ts`, Supervisor, UI, other workstreams. |
| **B — City research adapter**. New `lib/events/citySourceResearch*` and tests. | Source- and venue-scoped OpenAI web research returning existing three-field dated-source candidates + explicit per-source coverage/failure. Multi-source batches cover more than today's five/eight-result limit without giant JSON, preserve 1,200-token cap/bounded retries and skip unverifiable dates. Test Monday/14-day/one-day scope inputs, partial failure, duplicates and source provenance with recorded responses. **Pure adapter; wired by E.** | Storage, existing `nearbyEventsSearch.server.ts`, `eventsLookahead.server.ts`, UI/agent. |
| **C — Zero-hint neighborhood research adapter**. New `lib/events/neighborhoodResearch*` and tests. | Given only canonical café address, research sourced demand-generating places and calendars: convention, campus, office, transit, hotel, medical, entertainment etc. Separate public facts from café hypotheses; null unsupported entrances/routes/traffic; bounded refresh/coverage result, cold-start and failure fixtures, test distinct café contexts. **Research adapter; persisted/wired via A + E.** | New migration numbers, cron, canonical reader, UI, Agent. |
| **D — Café performance evidence reader**. New `lib/data/eventDemandEvidence.server.ts`, `lib/events/eventDemandEvidence*` and tests. | One owner/café-scoped **composite** read of existing Toast canonical metrics, `owner_facts`, Supervisor proposals/monitor samples/reports, with comparable-day coverage and historic outcomes. No new metric definition, new event store or monitoring. Test missing/partial evidence, conflicting reasons, two cafés, current event vs historical actual, no causal attribution. **Consumed by F.** | Cron, `eventReadiness.server.ts`, main event reader, UI, other workstreams. |

All A–D own **different paths**, can be opened/reviewed/merged in any order once this planning record is accepted, and must show a test proving their exported interface works. Each is **complete within its bounded scope**, but none may claim the whole feature is live. For any conflict with the old unchecked Events Fix C, leave that owned file unchanged and record the overlap for G.

### Wave 2 — owner-assigned integration PRs (start preparation early; merge-gated)

| PR | When it can be merged; sole integration ownership | Required full-path proof |
| --- | --- | --- |
| **E — ONE cron + canonical reader integration** | After A, B, C merge. Own existing `lib/events/eventsLookahead.server.ts`, `nearbyEventsSearch.server.ts`, `lib/data/cafeEvents.server.ts`/API as needed, and tests; **coordinate older Fix C reader ownership before edits**. This is the **only PR that attaches the parallel research adapters** to the authorized existing job and saves through A's one writer. | Initial 14d + daily +1 + Monday venue+city coverage, partial-source retry, zero-owner-hint neighborhoods, correct shared and private persistence, event-source verification, owner-authorized paid work, same café event identity in saved chat/Home reader. No on-open paid research or new cron. |
| **F — Existing Supervisor judgment + learning** | After E + D merge. Own `draftDay` / `eventReadiness.server.ts`, existing agent tool parity and tests. Use D's evidence reader, E's saved event/context reader. Remove obsolete live-search fallback in chat, **do not replace it with a new path**. | Select one relevant event of two on same day without throwing; research uncertain facts within normal tool/cost budget; weak events remain browseable without a notice; idempotent proposal/inbox/monitor, owner actions require approval; next comparison references prior partial/verified Toast outcomes, no causal claims. |
| **G — Existing Events panel + end-to-end release gate** | After E + F and after explicit resolution of Events Fix C ownership. Own `SavedEventsCard.tsx`, existing in-place UI, EN/ES/AR messages, read-only API surfacing and UI tests; if a reader change is needed, request E/F owner to supply it **before** G starts. | **One** screen/one reader: For My Café + All City Events (paged beyond old 500-row/8-tool caps), exact-event links and source freshness, 390px/desktop, EN/ES/AR RTL. Automated cold-start address-only → researched venue + city event → saved facts → Supervisor selective insight → event-day live Toast → next-day report, with same data in chat and UI. |

**Merge authority and order:** A/B/C/D may be merged in any order after review, owner approval and green final-head CI; **E waits for A+B+C; F waits for E+D; G waits for E+F**. Do not auto-merge or silently reorder. Even when PR work begins in parallel, every implementer rebases onto latest merged main and reruns the full required checks + predecessor handoff tests before requesting final review. Integration E must confirm A–C exports in code, F must confirm E/D exports, and G must confirm E/F outputs. If a handoff is missing, the responsible PR remains open; never defer it to an unspecified future PR.

**Release gate:** After G, one owner-authorized test-café rehearsal of the complete city/neighborhood/café learning loop, then owner-reviewed SQL, flags and production rollout as separately approved steps. Record exact pipeline run, saved source IDs, saved Supervisor IDs, same-row Home/chat parity and read-only observations. No claim of complete integration until this demonstration passes.

## Non-negotiable release and safety gates

- Follow `AGENTS.md`: one Supervisor, no router/reviewer/subagents; typed strict tools; ≤6 model calls/≤8 tools/60s turn/1,200 output tokens per call; tool outputs compact; no model-written SQL or unreviewed money calculations. Record research costs/coverage and cap scheduled per-city/per-café work without silently dropping failed scopes.
- One owner/café scope for all private knowledge; RLS on every exposed table, no cross-café POS/owner facts in shared city data, no provider keys/client leakage. Verify role/entitlement before paid café research.
- All changes to POS, staff, menu, purchasing, hours, schedules or outbound communications still require the existing approval workflow. Read-only monitoring is automatic; **never** pretend a draft was approved or an action happened.
- Never invent crowd size, customer counts, sales lift or walking traffic. Separate organizer-confirmed, model-estimated, owner-reported and observed data. No route-provider purchase until approved.
- All EN/ES/AR owner-facing text uses `messages/`; use existing design system/accessible in-place Events panel. No new screen-only data path.
- Every implementation PR: behavior tests, existing tests intact unless the specifically named behavior changes, `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`, green final-commit CI and independent Codex review with P1s fixed. **No autonomous PR merge, production migration or deployment.** Owner must approve migrations and rollout independently.
- Explicit blocker: resolve the older Events Fix C status/ownership before touching its UI/API/reader files. Record existing conflicting implementation paths in PR review; do not add a new one or silently choose.

## Reader pagination handoff

The current canonical `readCafeEvents` limits rows to 500, the chat `get_events` result returns eight event records, and the saved Events API uses a bounded date window. City browsing must paginate through the SAME canonical reader (and keep the chat result compact), without a parallel screen query or unbounded model context. Include a test with more results than current per-call caps.
