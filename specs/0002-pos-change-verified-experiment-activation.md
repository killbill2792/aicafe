# POS-confirmed experiments — plans are not operating changes

**Status:** In Review — approved source confirmation, pending reminders, rolling-24-hour approved experiments and **independent 7-day proactive price-change observation** (#6728419191), with daily owner reports; source/reader, watch storage/delivery and implementation ownership still unapproved.
**Date:** 2026-11-07
**Relation:** [D4C Toast menu authority and owner review](0001-d4c-toast-menu-authority-and-owner-review.md) §8.1; draft [#398](https://github.com/killbill2792/aicafe/pull/398) and [#400](https://github.com/killbill2792/aicafe/pull/400).
**Scope:** price experiments/price-change monitoring at Toast-connected cafés; same source-confirmation rule applies to staff experiments, but exact staff authoritative source and workflow are separately unapproved.

## 1. Problem and proven baseline

Owner requests a price experiment in Supervisor, e.g. change a particular Toast product **size** from its current published price to a trial target for an agreed number of days. AI CAFE is not a Toast menu editor: an owner may approve a plan, make a local edit or click Done without publishing that change in Toast. This is **pending action**, not evidence that the actual selling price changed. The owner wants a helpful reminder and a monitor that begins only after the price change is actually observed in Toast, without flagging the intentionally different target as corrupt data or losing historical sales. **Even without any approved experiment, a verified published Toast price change independently starts a seven-day observational Supervisor watch (§3.3).**

Read-only source/code audit:
- `lib/ai/supervisor/loop/priceExperiment.server.ts` commits a price experiment as `requires_manual_action`, correctly not writing to Toast.
- `app/api/ai/threads/[threadId]/experiments/route.ts` accepts `manual_done` and calls `confirmManualLoop(..., next café day)` without verifying the Toast-published price. Thus a button click can begin monitoring too early.
- `lib/ai/supervisor/loop/menuPriceChange.server.ts` uses `setCanonicalMenuPrice` to change `menu_items.price_cents`, returns `verified` based on local history and begins monitoring, although Toast may still have the prior selling price.
- `alex.drink_price_experiment.v1` also currently uses a fixed **seven-day** monitor window in its loop definition. Preserve the **owner-agreed duration** end to end; the separate `propose_price_experiment` tool accepts a `days` input, but that does not prove all experiment pathways honor that parameter.
- The current `lib/operating/experiments.ts` and SupervisorExperiment UI have `waitingOnOwner`/monitoring stages, so **reuse that existing lifecycle**, rather than inventing a second experiments subsystem.
- Toast's Menus API returns only **published** menu data; saving without publishing in Toast isn't enough: [official guide](https://doc.toasttab.com/doc/devguide/apiMenusApiReturnsPublishedDataOnly.html). The existing change-driven menu metadata/version sync must remain the only source of published catalog truth.

## 2. Intent, goals, non-goals and invariants

**Approved owner intent:**
1. Toast (for a Toast-connected café) controls current real published price, product/size, modifiers and availability. AI CAFE records decisions and proposes desired changes but **does not write back to Toast**.
2. Supervisor records target price, original observed price, exact Toast item/size GUID and café/restaurant scope, approved duration and source/proposal evidence. No changed official price is implied by this proposal or local editing.
3. **Waiting for Toast:** remind the owner to update **and publish** the agreed price in Toast; compare to the genuine published value only on a supported metadata/publication change or bounded proof check, avoiding unnecessary full-menu GETs.
4. **Start clock after source confirmation:** only when an authoritative, version-consistent Toast publication evidences the agreed effective price for that exact item/size. Never accept the owner's Done click, a local table update or an order discounted to a coincidentally matching amount as proof.
5. During waiting, describe target-versus-Toast difference as **pending owner action**, not an unexplained data mismatch, broken records or a completed experiment. Keep the actual price and all sales accurate.
6. Once verified, monitor the agreed number of covered days using real source-backed sales and the shared metric quality checks. If the correct price cannot be verified or coverage is incomplete, say so; no fabricated completed experiment.
7. Independent **owner-approved observational behavior**: automatically notice any reliable published Toast item+size price change, deliver initial notice, **daily updates for all seven days**, and a cumulative report without an experiment or owner action; do not infer causality (§3.3).
8. The same concept applies to future staff/roster experiments: planning in AI CAFE is not evidence that the actual authoritative scheduling system has been changed. Do not assert staff work shifts were published on plan approval.

**Non-goals:** Requiring an owner-initiated experiment or approval to merely observe a verified external price change, converting the seven-day watch into an approved/causal test, adding a second reader/cron/agent or automatically restarting an interrupted approved experiment; editing Toast prices/staff through an unsupported writeback; independently creating a new polling service, scheduler, order archive or AI agent; rewriting past sales, charges, wages or historical price versions; claiming that a price experiment conclusively caused any observed increase; making Toast the authority for inventory recipes/ingredient costs, which remain verified owner enrichment.

**Anti-goals:** A target price overwriting the real selling price, monitoring starting on a Done click, undercounting trial days, false provider mismatch alarms, duplicate experiments on the same item/period, or a cross-café price lookup.

## 3. Source, model and flow

~~~mermaid
flowchart TD
  A[Owner requests price test in Supervisor] --> B[Inert proposal with target, exact Toast item/size, duration]
  B --> C{Owner approves?}
  C -->|no| Z[No effect]
  C -->|yes| D[Awaiting owner Toast publish; offer reminder and notes]
  D --> E[Existing Toast menu metadata/version checks]
  E -->|unchanged, old price or unavailable| D
  E -->|verified new published catalog| F{Same restaurant, exact item/size and effective target price?}
  F -->|no / ambiguous| D
  F -->|yes| G[Record verified source event + effective as-of evidence]
  G --> H[Begin agreed monitoring window from confirmed source change]
  H --> I[Daily actual sales, price coverage and quality]
  I --> J[Report covered days, evidence, limitations, recommendation]
~~~

**Keep one existing state machine:** extend existing price proposal/monitor records and canonical Toast menu/publication evidence where needed, after concrete schema and file ownership review. Conceptual values are (1) `current_toast_price`, (2) `proposed_trial_price`, (3) `toast_verified_effective_price`, each with separate provenance, version and effective date. **Do not store proposed price as a canonical Toast price.** If the true Toast price is dynamic (size group, daypart, menu visibility, pricing strategy, modifiers, discounts, open price), do not assert exact-price verification without resolving the legitimate price context for this trial. Missing data = unverified, not zero/old truth.

**Source of time:** distinguish time of owner approval, owner's claim about a Toast edit, genuine published source effective time if provided and independently trustworthy, and first successful observed published-price verification. **Owner approved rolling exact 24-hour periods from the verified effective/observation instant** (no wait until next local morning); use elapsed instants/UTC for each 24-hour boundary, display them in the café's local time (including daylight-saving transitions). Do not backdate from an owner's Done click or unsupported inferred edit time. See §3.2 for final-closing extension and reporting. Source data lag and temporarily incomplete order evidence must remain labeled.

**Owner-facing copy example:**
> “We agreed to test Adeni Tea, 12 oz at the proposed price for 7 days. Toast still shows the previous published price, so your test hasn't started. Please update and publish the price in Toast. I'll track it once Toast confirms the change.”

If the price later differs intentionally because of another approved plan, show which plan explains the target and avoid duplicate raw-data corruption alerts. If a genuine unexpected price change happens, keep a distinct anomaly with exact Toast evidence. Never suppress serious data discrepancies merely because some plan exists.

## 3.1 Pending-Toast reminders — owner-approved requirement (2026-11-07) and cadence (2026-11-08)

**Owner-approved behavior:** When an experiment was agreed/approved but the exact new Toast product/size price has not yet appeared in **fresh verified published Toast data**, the experiment is **awaiting Toast**, not running. Supervisor proactively follows up, including **a few hours later and again the next café morning if still pending**, and keeps doing so until the change is verified or the owner cancels/revises the plan. Waiting without notifications is not acceptable. A reported target price is **not** a POS mismatch/error, and no sales/price data should be discarded.

**Timing distinction:** The experiment activates only when AI CAFE receives a validated published Toast price for the exact café/item/size, **not next morning or owner Done**. Record the source's trustworthy effective timestamp when present and the separately observed verification time; don't claim a retroactive effective instant without provider evidence. The **rolling 24-hour clock** and final café closing-time extension are now OWNER APPROVED (§3.2), not open. A 24-hour window is elapsed time, not 24 hours of trading; use true per-order timestamps to report on actual sale exposure.

**OWNER-APPROVED CADENCE (2026-11-08):** if still waiting and source confirmation has not arrived, send the first proactive reminder approximately **two hours after the owner approves the plan**; follow up **later that café-local day if needed**, with a hard limit of **two proactive reminders per owner/experiment per café-local day**; if still pending, include a reminder **the next café morning** (counts toward that day's same maximum of two), and continue bounded daily follow-ups while pending. A browser view may show the waiting state immediately, but scheduled messages must be idempotent and deduplicated by café/owner/proposal/reminder window. Do not issue a false claim of a fresh unchanged source when Toast is unavailable; use source freshness as explained below. Stop pending reminders on verified target publication, cancellation, rejection, or supersession. Never send on every coordinator tick; do not create an extra full-menu polling loop for reminders. Actual delivery times should respect the café-local timezone, owner contact preferences, and eligible channels.

**Truthful wording and freshness:** Use the last successfully verified Toast metadata/publication check and give its actual local timestamp. If a fresh successful check confirms no new publication and last-good price remains $7, Supervisor can say “Toast still shows $7 as of 3 PM.” If Toast is unreachable or the check is stale, say “I couldn't verify the Toast price yet; the experiment has not started,” NOT “Toast still shows $7 right now.” If the owner says “I updated Toast”, request/perform a permitted bounded metadata/verification check; this is evidence of an owner claim only, not proof of publication.

**Channels:** reuse the existing authenticated owner Operating Board/in-app inbox and owner thread/notification gateway with source-linked delivery evidence; optionally use WhatsApp only when the café/owner has enabled and configured that channel. The current `app/api/cron/supervisor-experiments/route.ts` explicitly sends **no notifications** and only scans `manual_confirmed`/`committed` monitoring states. The existing `lib/operating/commitments.server.ts` uses owner/café-scoped, deduplicated due follow-up delivery; reuse its patterns/gateway or existing task abstractions as approved, **not** an independent reminder engine. The precise task/cron owner and allowable WhatsApp template remain to be designed. A queued or failed external send must never be asserted as delivered.

**Acceptance scenarios:** approved at 9 AM, fresh Toast still old at 11 AM → reminder; fresh Toast still old at 3 PM → waiting status and bounded reminder; next morning unchanged → reminder; owner clicks Done early → still waiting; source unavailable → report verification unavailable, no false old-price-now assertion; new valid published price at 3 PM → **activate at that verified event**, cease pending reminders and record partial-day exposure explicitly; no duplicate notifications across retries; another café's proposal/price can't trigger the message.

## 3.2 OWNER-APPROVED measurement clock: rolling 24-hour periods plus final closing extension (2026-11-08)

**Owner decision:** If a 10-day experiment is approved at 3 PM and the new published Toast price is first reliably verified at 5 PM, the test **activates at the source-verification instant** rather than approval time or the next day. Its Day 1 ends **exactly 24 elapsed hours** later (5 PM the following day), Day 2 ends at +48 hours, and so on. The normal N-day target completes at `verifiedStart + N × 24 elapsed hours`, including nights when the shop is closed. The final period **may extend until the café's actual scheduled close** on that last day if that close is later than the N×24-hour boundary. If the business was already closed or closes before the boundary, do not arbitrarily extend into a future trading day. Label final extra trading time and revenue as a **closing-time extension**, separate from the N full 24-hour windows. Do not automatically force a POS price revert at the end; Toast remains owner-controlled.

**Example (local café time):** Owner agrees Monday 3 PM; Toast confirmed Monday 5 PM → first rolling period Monday 5 PM–Tuesday 5 PM; second Tuesday 5 PM–Wednesday 5 PM; tenth 24-hour boundary ten elapsed days after Monday 5 PM. If the café is trading and closes at 7 PM on that final date, observe the extra 5–7 PM and then finalize the report with N full windows **plus 2h extra**. Keep explicit timestamps and timezone. For daylight-saving changes, use true elapsed-hour arithmetic; the displayed local wall clock can shift.

**Reporting evidence:** The current code aggregates `order_lines` by `orders.business_date` and `daily_rollups` (see `lib/ai/supervisor/loop/sales.server.ts`, `lib/calc/priceExperiment.ts`). **That cannot on its own prove 5-PM-to-5-PM rolling periods**. Before implementing, audit source-native order/check close/paid/created times, timezone and data coverage, and build time-window sums from canonical real sales and actual price context (no synthetic allocation of daily money). Show both elapsed duration and **observed trading hours**; compare equivalent weekdays/open hours where possible. Actual order time may not prove when a published price first became effective. If time-specific sales or authoritative business hours are unavailable, say `insufficient_evidence` and preserve the experiment rather than inventing precision. Opening-hours changes, overnight closes, daylight-saving boundaries, delayed source publication and last-day price changes require deterministic tests.

**Cancellation:** If owner cancels while waiting, stop reminders and remove the proposal from active experiments while preserving the approval/cancellation audit record. If owner stops an already active test, stop measuring at the verified termination/cancellation time and report only **partial observed exposure**, never call it a complete N-day outcome. Keep one proposal/monitor lifecycle, never erase history just to hide a canceled card.

**Delivery/implementation contract:** Source-confirmed start timestamp, N configurable rolling 24-hour windows, final café-close rule and any extra period are part of **owner-approved requirements**. Exact timestamp field hierarchy, opening-hours source, effective-versus-observed-time policy, calculations, persistence and ownership are **pending spec acceptance**. No actual changes are in this document.

## 3.3 Owner-approved proactive seven-day price-change observation — NO experiment prerequisite (2026-11-08)

**Source and authority:** [Owner #6728419191](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6728419191) APPROVES an autonomous **observational** watch when the **existing** Toast Menus V2/version-gated source shows a genuinely changed **published** price for one exact café/restaurant, product GUID, size/option GUID and price context. There is **no requirement** for an owner-requested experiment, plan, reminder or approval to **observe and explain** the external change. As always, modifying café/Toast data or launching a new owner-approved experiment still requires owner authorization. This does not authorize implementation in PR #398.

**Evidence to trigger:** Compare two authenticated, complete, restaurant/version-consistent *published* Toast snapshots via existing metadata/change-driven sync and price history. Retain previous and new published values, exact item/size/context, version, source provenance and freshness; distinguish the genuinely supported source-effective timestamp from the first **observed verification** time and do not claim an earlier effective time without proof. Handle options, dayparts, multiple menu contexts, discounts, multi-price/open-price semantics and location scoping. Owner Done, a local target/menu edit, unchanged or failed/403/429/empty/partial response, stale October diagnostic, different café/size or an order charged a coincidentally equal price **cannot** trigger an observed price change. If ambiguous or unentitled, report unknown, never assume zero or new authority.

**No-experiment example:** Toast publishes a validated change to Latte, 12 oz, from a previously verified price to a new price. Without being asked, the **ONE Supervisor** tells the owner, in plain words, which published item/size price changed and when it was *first verified*, with evidence; then says it will watch for **seven days**. It initiates an **observational** monitor using existing Supervisor/Operating Board/commitment mechanisms, **not an experiment, second agent, new importer, price ledger, cron or polling loop**. It must not ask permission just to observe or imply the owner changed the price.

**Mandatory proactive delivery:** Send the first source-grounded notice once, then **one meaningful daily update for each of the seven observation days**, then a **cumulative seven-day analysis**, even if no experiment or owner prompt exists. Closed/no-sales days, lagging orders, unknown costs or insufficient coverage still receive an honest daily update (e.g. “not enough verified evidence today”), not silence or fictitious zeros. Reuse existing authenticated owner-eligible inbox/Operating Board/notification gateway, channel preferences and delivery/acknowledgement rules. One ten-minute sync tick is not a reason to notify. Batch several product/size changes into a **bounded owner daily digest** rather than ten separate messages; dedupe by café/owner/verified source change/item+size/context/day and track queued versus delivered without inventing sends. The watch's daily reports differ from the **pending experiment reminder maximum of two per café-local day (§3.1)**, and do not silently adopt the approved experimental N×24-hour clock (§3.2). Exact observation-day alignment, local cutoff and delivery guarantees still require implementation design.

**Actual metrics, not a causal experiment:** Each day show source-backed sales units, net/gross sales, discounts, refunds and actual changed-price exposure; compare feasible matched hours/weekday or pre-change periods and label correlation, confounders, partial coverage and source freshness. Ingredient usage, recipe cost and margin may be shown **only if independently verified**; otherwise explicitly mark cost or margin **UNKNOWN/PARTIAL**, not a number inferred from selling price. Preserve original sale prices, historical orders/price versions, real paid/closed timestamps, lateness, refunds, non-trading days, timezone/DST and uncertified daily money. No completed seven-day claim before the period is actually covered.

**When price changes again:**
- **No owner-approved experiment:** preserve earlier exposure as a dated segment, observe the new verified price segment without duplicate overlapping watches or lost comparisons, combine daily communications and never invent a causal approved test.
- **Already approved experiment:** a verified revert or different price during the agreed trial **splits actual exposure**; preserve real source segments, mark any affected plan **PARTIAL**, notify the owner, then offer **stop/report partial**, **treat the new price as a separately understood phase**, or **approve a new experiment**. Do not silently auto-complete, restart, extend or approve another trial. Source verification of the original target still gates initial experiment activation.

~~~mermaid
flowchart TD
  A[Existing version-gated published Toast menu reader] --> B{Verified exact item size price-context change?}
  B -->|No or unavailable| Z[Preserve last good price and freshness uncertainty]
  B -->|Yes| C[Record old and new published version and observation time]
  C --> D[One Supervisor sends owner change notice]
  D --> E{Previously approved exact-price experiment?}
  E -->|No| F[Start seven-day observational watch without approval]
  E -->|Yes| G[Preserve approved test lifecycle and actual exposure]
  F --> H[Daily bounded evidence digest on each of seven days]
  H --> I[Final cumulative observation with limitations]
  G --> J{Verified price changes again?}
  J -->|Yes| K[Split exposure and ask owner stop phase or new experiment]
  J -->|No| L[Continue verified approved-window facts]
  K --> H
~~~

**Approved outcomes versus implementation decisions (not coding approval):**

| Topic | OWNER APPROVED | STILL IN REVIEW — downstream exact design |
|---|---|---|
| Trigger/authority | Actual published Toast item+size/context price change starts observation without experiment or owner approval | Timestamp precedence, option/daypart context, source freshness, stable change keys and per-café scopes |
| Delivery | Initial notice + each of 7 daily updates + cumulative final, bounded cross-product digest | Existing watch/commitment representation, day boundaries, retry/dedupe, eligible owner channels, RLS |
| Truth | Real exposure, discounts/refunds, like-for-like comparison where possible, explicit unknown cost/missing totals; observation ≠ causation | Time-window SQL, protected current reader, cost/recipe evidence, shared metrics, complete migrated DB proof |
| Revert/new price | Keep prior and new segments; planned test asks owner for stop/partial, phase, or separately approved new test | Transition/rollback, overlap/digest algorithm, durable source event and acceptance tests |
| Ownership | Reuse existing D4A sync, current Toast version history, one Supervisor/Operating Board | POS0e reader → POS0d published catalog/price signal → POS0f registered one-Supervisor/Menu/migrated DB end-to-end; exact files require separate approval |

**Required later acceptance scenarios — NOT executed in this documentation PR:**
1. **No prior plan:** two verified published price versions → one initial owner notice, 7 daily evidence-backed reports, and final cumulative report; **no experiment** created and no owner interaction needed.
2. **No valid change:** wrong café, changed size/daypart, unverified source version, stale diagnostic, unpublished local edit, 403/429, empty/partial menu → no watch or claimed published change.
3. **Interrupted approved N-day experiment:** exact target validates; a different verified price/revert on day 3 segments evidence, prompts owner decision, reports partial, and never silently approves a new trial.
4. **Further unsolicited change:** preserve historical segment, start new evidenced segment where valid, bounded combined digest, no duplicate overlapping watcher or per-tick spam.
5. **Quality/tenant/delivery:** no trading, unknown COGS, refund, poison order, late correction, daylight saving, two cafés and ten products → honest missing/partial reports with authenticated owner isolation and idempotent actual delivery receipts.
6. **Integration:** source-shaped real publication changes on fully migrated disposable DB → canonical price provenance → existing shared describe_data/query_data → registered **one Supervisor** turn + Menu/current screen parity and existing owner delivery; no new polling/agent or live production mutation.

**Architecture boundary:** The seven-day daily-monitor outcome is **approved**, but its watch record, source timestamp hierarchy, daily alignment, deduplication, channel implementation, join/range-performance, restaurant-RLS and executable integration remain **not designed/implemented**. #398 records the behavior and source-contract questions; #400 exclusively owns the binding instruction/queue handoff. Any runtime changes and POS0e/d/f coding require a later explicit owner go-ahead.

## 4. Safety / STRIDE and failure handling

| Risk | Guard |
|---|---|
| Spoofing | Source price verified from authenticated, restaurant-scoped Toast published menu, not browser, owner button or external URL |
| Tampering | Separate proposed/real prices; no local action overwrites Toast canonical price; immutable trial version and exact item/size |
| Repudiation | Record owner approval, target, old source price, Toast published version/effective timestamp, any verified transition and reminders |
| Information disclosure | Café/restaurant GUID and owner auth/RLS on proposal, matching, published-source and monitor |
| Denial/data corruption | Partial/lagging/unpublished menus, 403, rate limits or missed metadata checks preserve pending state; bounded reuse of current fetch |
| Elevation of privilege | A local 'Done' or price editor cannot bypass provider truth or trigger an unverified monitor |
| Analytics integrity | Only actual covered periods and observed source evidence count; preserve sales, discounts, voids and price history; observation ≠ causal experiment; unknown margin stays unknown |
| Notification or tenant leakage | Source-change/date dedupe, bounded owner-eligible daily digest, real delivery acknowledgement, café/owner RLS and no per-sync spam |
| Context/price confusion | Compare the same café, restaurant, item/size/option, published version, daypart and price context; partial/unknown source never triggers |
| Mid-experiment verified reversion | Preserve actual exposure segments and ask owner stop/partial, phase or new approval; never silently complete or auto-restart |

## 5. Alternatives

**A. Local price change or Done button starts the clock:** current code partly does this; rejected by owner because no Toast writeback means the experiment may not actually be running.

**B. Record the approved plan, wait for real Toast source confirmation, then count the trial days:** **owner-selected behavior**. Clear owner communication, accurate timing; costs a little verification and monitoring state.

**C. Owner must manually attest price changed, without any Toast check:** faster but still allows false starts. Not sufficient for Toast-connected cafés with accessible published-menu price; owner signal can guide a check, not substitute for it.

**Rejected for proactive observation:** owner must request a trial before price monitoring, every changed price auto-creates an experiment, owner Done counts as source confirmation, and a second polling/agent/notification ledger. **Selected:** verified existing publication source + ONE Supervisor, passive seven-day evidence watch, bounded delivery (§3.3); implementation details remain open.

## 6. Implementation/verification handoff (pending approval)

- Explicitly scope the changes to existing `priceExperiment.server.ts`, `menuPriceChange.server.ts`, `engine.ts`, `/api/ai/threads/[threadId]/experiments/route.ts`, `menu_items` source price update path, `lib/operating/experiments.ts`, components and shared menu version/price evidence; do **not** modify any until the owner approves an implementation plan and exact exclusive PR ownership.
- Preserve the existing approval + `manual_pending` workflow; owner clicking Done is a nudge to check Toast, **not** a `manual_confirmed` start signal until provider evidence is verified.
- Distinguish the **pending experiment reminder cadence (§3.1)** from **post-change observational seven-day daily reporting (§3.3)**. Design expiry, delivery and overlap within existing Supervisor/Operating Board, without any new scheduler or second price recorder.
- Test with source-shaped Toast published old/target/intermediate price, unchanged metadata, async publication lag, 403/429, menu missing price/open price, size-specific and daypart pricing, wrong café, owner Done before publication, scheduled future publish, revert, incomplete day and overlapping approved experiments. **Also** test §3.3 no-experiment notice, all seven daily deliveries and cumulative observation; second changed price with segment continuity and approved-test owner decision, ten product updates in one digest, no trade, cost unknown, DST, stale/partial data and no duplicate/cross-tenant notification.
- End-to-end proof: canonical current Menu shows Toast actual price; Supervisor clearly shows planned price and waiting state; local edits do not imply source application; only verified Toast change transitions experiment; reports count agreed measured days and label incomplete coverage accurately. Run against disposable migrated DB and registered Supervisor, plus no extra full menu fetch; preserve historical orders and owner recipes. PR bodies record what the tests proved, not just mock passes.

## 7. Approved decisions, open questions and status

**Owner-approved (2026-11-07; reminder cadence explicitly approved 2026-11-08):** No Toast writeback; Toast remains the operational source; local/menu changes and price-experiment approval do not mean Toast changed; Supervisor remembers a planned experiment and proactively reminds the owner at approximately +2 hours, later if necessary, and on the following café mornings with **no more than two proactive reminders per café-local day** until verified or canceled. Distinguish expected pending target versus genuine data mismatch, and **activate** the experiment only on validated published Toast price change, recording exact observed timing. **The rolling exact-24-hour test windows and final café closing-time extension are also owner approved.** **Separate approved observation (#6728419191):** any verified published Toast price change launches an initial notice, seven daily proactive Supervisor updates and a cumulative observation report with no owner-initiated experiment or prior approval; later changes split actual exposure and interrupted approved tests ask the owner what to do. Extend the source-confirmation distinction to staffing plans. **No runtime or migration approval yet.**

**OWNER DECISION CLOSED — reminder cadence (2026-11-08):** Approved: first reminder approximately two hours after experiment approval while awaiting Toast; later same-day follow-up if still pending; next café-morning reminder if still waiting; maximum two proactive reminders per café-local day, continuing until verified source change or cancellation. Delivery channels must obey existing eligibility and user preferences; exact operational delivery integration is an implementation design detail, not a new permission to schedule sends. **OWNER DECISION CLOSED (2026-11-08):** Rolling exact 24-hour periods start upon verified Toast price evidence; include the actual trailing trading interval until final-day closing time if closing is later than the N×24-hour boundary; report the extension separately. No next-morning delay and no owner Done-based start. **Existing document authority:** AGENTS.md and binding rules, #398 architecture/specs and #400's exclusive active brief/queue routing. Do not create a competing documentation hierarchy or dispatcher.

Other **implementation-design questions** (not outstanding owner behavior decisions): exact source effective price under size/contextual/open-price rules, seven-day watch representation and daily digest/segmentation, how to handle incomplete sales days, Done without Toast and repeated reminders; what staff scheduling source is truly authoritative for each connected café; exact approval-safe owner-facing edit controls; file/SQL ownership among POS0d/POS0f and the existing Supervisor/experiment feature owners.

**Checklist:** problem and current code inspected; goals/non-goals; flow; threat model; alternatives; acceptance/rollout; remaining questions documented. **Independent builder check and final design acceptance pending.** Related template and reviewer files have not been provided. Status stays **In Review**. No implementation, DB changes, scheduler activation or PR merge is permitted by this document.
