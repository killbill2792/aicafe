# POS-confirmed experiments — plans are not operating changes

**Status:** In Review — owner approved principle; implementation boundaries, day-zero rule and cross-domain ownership not yet accepted.
**Date:** 2026-11-07
**Relation:** [D4C Toast menu authority and owner review](0001-d4c-toast-menu-authority-and-owner-review.md) §8.1; draft [#398](https://github.com/killbill2792/aicafe/pull/398) and [#400](https://github.com/killbill2792/aicafe/pull/400).
**Scope:** price experiments/price-change monitoring at Toast-connected cafés; same source-confirmation rule applies to staff experiments, but exact staff authoritative source and workflow are separately unapproved.

## 1. Problem and proven baseline

Owner requests a price experiment in Supervisor, e.g. change a particular Toast product **size** from its current published price to a trial target for an agreed number of days. AI CAFE is not a Toast menu editor: an owner may approve a plan, make a local edit or click Done without publishing that change in Toast. This is **pending action**, not evidence that the actual selling price changed. The owner wants a helpful reminder and a monitor that begins only after the price change is actually observed in Toast, without flagging the intentionally different target as corrupt data or losing historical sales.

Read-only source/code audit:
- \`lib/ai/supervisor/loop/priceExperiment.server.ts\` commits a price experiment as \`requires_manual_action\`, correctly not writing to Toast.
- \`app/api/ai/threads/[threadId]/experiments/route.ts\` accepts \`manual_done\` and calls \`confirmManualLoop(..., next café day)\` without verifying the Toast-published price. Thus a button click can begin monitoring too early.
- \`lib/ai/supervisor/loop/menuPriceChange.server.ts\` uses \`setCanonicalMenuPrice\` to change \`menu_items.price_cents\`, returns \`verified\` based on local history and begins monitoring, although Toast may still have the prior selling price.
- The current \`lib/operating/experiments.ts\` and SupervisorExperiment UI have \`waitingOnOwner\`/monitoring stages, so **reuse that existing lifecycle**, rather than inventing a second experiments subsystem.
- Toast's Menus API returns only **published** menu data; saving without publishing in Toast isn't enough: [official guide](https://doc.toasttab.com/doc/devguide/apiMenusApiReturnsPublishedDataOnly.html). The existing change-driven menu metadata/version sync must remain the only source of published catalog truth.

## 2. Intent, goals, non-goals and invariants

**Approved owner intent:**
1. Toast (for a Toast-connected café) controls current real published price, product/size, modifiers and availability. AI CAFE records decisions and proposes desired changes but **does not write back to Toast**.
2. Supervisor records target price, original observed price, exact Toast item/size GUID and café/restaurant scope, approved duration and source/proposal evidence. No changed official price is implied by this proposal or local editing.
3. **Waiting for Toast:** remind the owner to update **and publish** the agreed price in Toast; compare to the genuine published value only on a supported metadata/publication change or bounded proof check, avoiding unnecessary full-menu GETs.
4. **Start clock after source confirmation:** only when an authoritative, version-consistent Toast publication evidences the agreed effective price for that exact item/size. Never accept the owner's Done click, a local table update or an order discounted to a coincidentally matching amount as proof.
5. During waiting, describe target-versus-Toast difference as **pending owner action**, not an unexplained data mismatch, broken records or a completed experiment. Keep the actual price and all sales accurate.
6. Once verified, monitor the agreed number of covered days using real source-backed sales and the shared metric quality checks. If the correct price cannot be verified or coverage is incomplete, say so; no fabricated completed experiment.
7. The same concept applies to future staff/roster experiments: planning in AI CAFE is not evidence that the actual authoritative scheduling system has been changed. Do not assert staff work shifts were published on plan approval.

**Non-goals:** Editing Toast prices/staff through an unsupported writeback; independently creating a new polling service, scheduler, order archive or AI agent; rewriting past sales, charges, wages or historical price versions; claiming that a price experiment conclusively caused any observed increase; making Toast the authority for inventory recipes/ingredient costs, which remain verified owner enrichment.

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

**Keep one existing state machine:** extend existing price proposal/monitor records and canonical Toast menu/publication evidence where needed, after concrete schema and file ownership review. Conceptual values are (1) \`current_toast_price\`, (2) \`proposed_trial_price\`, (3) \`toast_verified_effective_price\`, each with separate provenance, version and effective date. **Do not store proposed price as a canonical Toast price.** If the true Toast price is dynamic (size group, daypart, menu visibility, pricing strategy, modifiers, discounts, open price), do not assert exact-price verification without resolving the legitimate price context for this trial. Missing data = unverified, not zero/old truth.

**Source of time:** distinguish date of owner approval, date owner says they changed Toast, actual observed published-source timestamp/as-of, and start/end of measurable full café business days. Exact day-zero handling (current partial café day vs first full day after verification), source correction and temporarily incomplete coverage require owner design acceptance in §7. Do not backdate merely because an owner clicked Done.

**Owner-facing copy example:**
> “We agreed to test Adeni Tea, 12 oz at the proposed price for 7 days. Toast still shows the previous published price, so your test hasn't started. Please update and publish the price in Toast. I'll track it once Toast confirms the change.”

If the price later differs intentionally because of another approved plan, show which plan explains the target and avoid duplicate raw-data corruption alerts. If a genuine unexpected price change happens, keep a distinct anomaly with exact Toast evidence. Never suppress serious data discrepancies merely because some plan exists.

## 4. Safety / STRIDE and failure handling

| Risk | Guard |
|---|---|
| Spoofing | Source price verified from authenticated, restaurant-scoped Toast published menu, not browser, owner button or external URL |
| Tampering | Separate proposed/real prices; no local action overwrites Toast canonical price; immutable trial version and exact item/size |
| Repudiation | Record owner approval, target, old source price, Toast published version/effective timestamp, any verified transition and reminders |
| Information disclosure | Café/restaurant GUID and owner auth/RLS on proposal, matching, published-source and monitor |
| Denial/data corruption | Partial/lagging/unpublished menus, 403, rate limits or missed metadata checks preserve pending state; bounded reuse of current fetch |
| Elevation of privilege | A local 'Done' or price editor cannot bypass provider truth or trigger an unverified monitor |
| Analytics integrity | Only actual covered period and observed price/source evidence count; preserve original sales, discounts, voids and historical rollups |

## 5. Alternatives

**A. Local price change or Done button starts the clock:** current code partly does this; rejected by owner because no Toast writeback means the experiment may not actually be running.

**B. Record the approved plan, wait for real Toast source confirmation, then count the trial days:** **owner-selected behavior**. Clear owner communication, accurate timing; costs a little verification and monitoring state.

**C. Owner must manually attest price changed, without any Toast check:** faster but still allows false starts. Not sufficient for Toast-connected cafés with accessible published-menu price; owner signal can guide a check, not substitute for it.

## 6. Implementation/verification handoff (pending approval)

- Explicitly scope the changes to existing \`priceExperiment.server.ts\`, \`menuPriceChange.server.ts\`, \`engine.ts\`, \`/api/ai/threads/[threadId]/experiments/route.ts\`, \`menu_items\` source price update path, \`lib/operating/experiments.ts\`, components and shared menu version/price evidence; do **not** modify any until the owner approves an implementation plan and exact exclusive PR ownership.
- Preserve the existing approval + \`manual_pending\` workflow; owner clicking Done is a nudge to check Toast, **not** a \`manual_confirmed\` start signal until provider evidence is verified.
- Automated/periodic reminder cadence, expiry and overlap handling remain to be designed with existing Supervisor/Operating Board and no new scheduler.
- Test with source-shaped Toast published old/target/intermediate price, unchanged metadata, async publication lag, 403/429, menu missing price/open price, size-specific and daypart pricing, wrong café, owner click Done before Toast publish, scheduled future publish, later revert, incomplete day, price change during trial, draft conflict and multiple overlapping experiments.
- End-to-end proof: canonical current Menu shows Toast actual price; Supervisor clearly shows planned price and waiting state; local edits do not imply source application; only verified Toast change transitions experiment; reports count agreed measured days and label incomplete coverage accurately. Run against disposable migrated DB and registered Supervisor, plus no extra full menu fetch; preserve historical orders and owner recipes. PR bodies record what the tests proved, not just mock passes.

## 7. Approved decisions, open questions and status

**Owner-approved (2026-11-07):** No Toast writeback; Toast remains the operational source; local/menu changes and price-experiment approval do not mean Toast changed; Supervisor remembers a planned experiment, reminds the owner to change and publish in Toast, distinguishes expected pending target versus genuine data mismatch, and starts measuring the agreed trial duration only after source-backed confirmation. Extend the distinction to staffing plans. **No runtime or migration approval yet.**

**NEXT DECISION:** When Toast confirms the new published price during a café business day, does the test count that partial day as Day 1, or begin **Day 1 on the next full local business day** (recommended for a clean comparable trial)? The source event still records the precise observation time.

Other design questions: how to evidence effective price under size/contextual and open-price rules; how to handle a later midtrial price revert, incomplete sales days, manual Done without Toast data and repeated reminders; what staff scheduling source is truly authoritative for each connected café; exact approval-safe owner-facing edit controls; file/SQL ownership among POS0d/POS0f and the existing Supervisor/experiment feature owners.

**Checklist:** problem and current code inspected; goals/non-goals; flow; threat model; alternatives; acceptance/rollout; remaining questions documented. **Independent builder check and final design acceptance pending.** Related template and reviewer files have not been provided. Status stays **In Review**. No implementation, DB changes, scheduler activation or PR merge is permitted by this document.
