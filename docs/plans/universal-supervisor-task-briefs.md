# Universal Supervisor — coding-agent task briefs (proposal)

**MANDATORY POS0 PRE-CODING SOURCE-AUTHORITY GATE (fresh-agent first-read order):** `AGENTS.md` (+ `PROGRESS.md` read-only) → **[binding POS rules](../rules/pos-data.md)** → **[#398 concise POS0a handoff](toast-standard-api-coverage-matrix.md#pos0a-handoff--read-this-card-before-large-evidence-tables-2026-11-08)** (retrievable on latest #398 draft), followed by targeted [matrix field evidence](toast-standard-api-coverage-matrix.md) only as needed (official A1/A2/A4 proof remains open) → **this exact task brief AND [machine queue](universal-supervisor-queue.json)** (implementation-approval gate currently false; while #398 is draft, fetch its actual GitHub PR head rather than treating an absent on-main matrix as optional) → actual repository code and deployed SQL → **[executable acceptance](../rules/tests.md)**. In the **first** PR body, reproduce the table/classification for `toast_raw_records` (**OPERATIONAL_CURRENT**), `toast_raw_changes` (**CHANGE_LOG**), `toast_raw_samples` (**LEGACY_DIAGNOSTIC_ONLY**), `toast_raw_samples_latest` (**LEGACY_DIAGNOSTIC_ONLY**), typed/staged operational facts and the existing `toast_records_for` / `describe_data` / `query_data` consumers. List the **exact source→field→object key→writer→reader→Supervisor/screen** chain and the old diagnostic consumers to retire. Include literal `source_authority_checked: yes`, with links to the files inspected and current-head source proof. **This string is a review declaration, not a substitute for proof.** If a coder cannot verify the classification, they must not invent another store, reader or fixture. No POS0 source-family PR may claim done if its newly stored data is not answerable via the real existing Supervisor tools and a non-diagnostic test.

**Sequence correction:** The **existing POS0e task moves ahead of POS0b/c/d as the shared reader and global retained-field foundation**. POS0e first cuts off operational consumers of `toast_raw_samples`, repairs the existing global safe-field policy and provides schema-backed discovery/current-object reads. Then POS0b–d extend that reader with their distinct source families (parallel disjoint files); POS0f is the final all-family proof and explicitly retires obsolete diagnostic capture/mirror/rows **only after** all active consumers are gone. The queue JSON dependencies must match this order. This is a **reordering of the existing six tasks**, not a second agent or data system; POS0e alone owns globally shared reader/redactor files and b/c/d must not edit those in parallel. No production data deletion solely on plan approval.

**Read in authority order, not as competing prompts:** `AGENTS.md`, read-only `PROGRESS.md`, binding POS rules, #398 concise handoff, **this assigned brief plus the [queue](universal-supervisor-queue.json)**, and applicable AI CAFE skills in `.claude/skills/`. [Agent operations](universal-supervisor-agent-operations.md) is lifecycle context only. Each coding chat opens the task's relevant listed existing skills and verifies its own current code/PR scope. The **one common lifecycle** (stacked draft immediately, one PR/chat, current-head CI, Codex review and resolved threads, rebase when dependency merges, integration proof, merge) is in `aicafe-pr-lifecycle`; do not duplicate it in each task.

**Status:** these are proposed requirements until owner-approved architecture and exclusive editable paths are recorded. Do not assume the Grok-local PR6–PR12 briefs were retrieved. A merged prerequisite is not automatically proven. **Browser screenshots only when a changed UI/browser owner journey needs them.** No production deploy or action without separate owner authorization.

**Single delivery prompt (no separate copy/paste template):** Actual authorized assignments are constructed by `scripts/dev-dispatcher/run.mjs` using `scripts/dev-dispatcher/delivery.mjs#createDelivery`, the approved machine queue and this task's exact anchor. Read the current `AGENTS.md` → binding POS rules → #398 decision record → this brief+queue → actual code → executable acceptance. The old short coding-prompt example was superseded; do not paste or concatenate it with the generated prompt, reassign an existing chat because of documentation edits, or turn D4A/D4B architectural approval into runtime authorization. Owner's coding-delivery switch is OFF during POS0a closeout despite issue/queue tracking; do not deliver POS0b–f coding instructions without explicit owner activation. Manual PR-body comment reconciliation suffices for this phase; no new automation gate.

## Priority zero — finish ALL permitted Toast Standard API data before E2 / PR6–PR17

**Owner decision, November 6, 2026:** These six small implementation tasks now lead the **existing**
Universal Supervisor queue. They are a **source-of-truth/data-access prerequisite**, not a second
Supervisor, new POS connector, or order-system rewrite. Do not dispatch new E2/PR6/PR9/PR10 work until
POS0f is **integrated_proven**. Existing open PRs should finish their normal CI/Codex repair cycles
rather than be abandoned. Only **POS0a, a read-only inventory/architecture document**, is approved to
start without additional field-level sign-off; POS0b–POS0f are proposed implementation scopes until the
owner approves the exact source → stored object → reader contract required by AGENTS.md §15.

**Non-negotiable architecture:** Toast Standard API → existing Toast client/ingestion → one current
authorized record **per actual Toast object ID** (order, payment, time entry, menu entity, kitchen item
etc.) + field-change log on genuine edits → organized app facts and **one shared scoped reading
foundation** → existing screens and **one Supervisor**. The existing `toast_raw_records`,
`toast_raw_changes`, organized tables, order writer, daily imports, current order update path, existing
screen metrics, `describe_data`, `query_data`, `calculate`, privacy redaction and specialized screen tools
remain. Extend in place. Do **not** create a duplicate raw ingest, second source of truth, new
per-question view, arbitrary model-written SQL or blanket 30-minute endpoint polling.

**Meaning of all data:** Every field the granted Standard API actually returns—including **customer and employee names, contact information, stable IDs, permitted personal/customer/loyalty fields, notes and complete business/operational metadata**—must survive in the *existing* current-object writer and be available through the existing authorized AI tools. Exclude card PAN/CVV/track and reusable payment authentication credentials/security secrets, not entire customer or staff objects. Preserve café/role isolation. Null/omitted/permission denied must never block unrelated data; schema-defined fields remain discoverable even when no recent record has a value. This does **not** authorize paid Analytics ERA, separate Menus V3 entitlement, permission bypass, fake values or direct unapproved production changes. Endpoint counts and schemas must come from the
**current official Toast specs**, not hardcoded historical 76/86/88 totals. Compare each café's
actual scope and response; a 200 with zero rows, 204, 403, missing GUID, partial page, failed capture
and stale record are distinct statuses.

### Shared acceptance contract across POS0b–POS0f

| Concern | Required observable proof |
|---|---|
| Diagnostic exclusion | `toast_raw_samples` and diagnostic/test café mirror values **never** influence Supervisor/canonical views/screen metrics, even on 403/204/no current source; old active lineage retired and tested in disposable DB; old test assertions corrected, not hidden |
| Full field retention | Current Toast-shaped response field-by-field → allowed stored business field, with documented privacy filtering; nested arrays, GUID references, booleans, null, zero, money and timestamps preserved accurately |
| One object / real changes | Business + restaurant + stable provider object key; identical replay and reordered arrays do not duplicate; genuine field modification updates existing object and records precise before/after/when |
| Storage safety | Reuse current writer, tables and `toast_raw_changes`; no duplicate full snapshots, no loss of already verified orders or historical accounting records; RLS/owner scope, non-PII business IDs |
| Freshness/coverage | Operations (attendance, changing stock/cash, relevant kitchen) check each permitted family in the existing 10-minute coordinating cycle, with bounded provider-specific refresh and modification cursors; static setup checks on version/metadata and full detail on change; backoff, pagination, modified cursor, missed-run repair, day closeout and overnight correctness; no invalid zero or fresh claim |
| One data path | Same authorized **current** facts under screens and chat, with existing `describe_data`/`query_data` over **all permitted fields**, no row sample as the discovery universe; query result limits constrain context only, not DB retrieval |
| Money | Screen money and labor use `lib/metrics/core/`; other arithmetic through sourced `calculate`; actual/estimate/provisional/missing/stale distinguishable with café-local date and currency |
| Testing | Strengthen/replace inadequate assertions/fixtures, do not silently delete valid tests or relax to mocks; executable migrated disposable Supabase SQL/RLS, one-current-object/change/retry, endpoint × field, screen parity and real Supervisor-query deterministic acceptance; tests actually run in CI |
| Proof/release | Every PR body has test command + expected and actual + **executed CI job URL + head SHA**; Codex clean, base current, migrations identified and applied only with owner consent; final read-only real-café audit separately; incomplete/unavailable is NOT success |

## Task POS0a

**Title:** Current Toast Standard API contract and source-to-AI coverage matrix
**Dependency:** none. **State:** architecture-approved **read-only inventory only**.
**Owner-approved audit-only files:** `docs/plans/toast-standard-api-coverage-matrix.md`, `scripts/toast-standard-api-coverage.test.mjs` (deterministic read-only A1/A2/A4), and `docs/plans/toast-openapi-spec-snapshot.json` (pinned official OpenAPI downloads, URLs/versions/SHA). These are the **only** added file permissions from [PR #398 owner scope comment](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6713567512). No runtime code, migrations, live provider writes or merge. **Same-chat dispatcher safety:** `queue.tasks.POS0a.exclusive_files` retains its original signed matrix path so the existing PR/chat is not silently reauthorized or replaced. The extra two owner-approved audit paths and authenticated comment are recorded under `dispatch_rules.pos0a_owner_approved_audit_scope_extension`; this is additional audited permission, not an implementation or merge gate release. Do not invent a second assignment/prompt. Pinning a sample/one API does **not** prove the full eligible Standard GET and response-field universe; the actual official-schema snapshot and executable audit remain **UNPROVEN until committed and run**. Reuse the repository's official operation inventory, current online Toast API
specifications, `docs/plans/toast-storage.md`, `docs/rules/pos-data.md` and existing database evidence.

**How:** Enumerate every current Standard GET/list/detail operation and its child objects/fields
straight from official OpenAPI; group by operations vs endpoint aliases (detail-by-GUID counts
separately). Compare registry in `lib/pos/toast/rawSample.server.ts`, actual normal sync callsites,
existing archive/organized writer keys, change log, query views and dictionary with each authorized
café's actual permission and observed evidence. For every field document: data type/path, provider
object ID/key, business date/modification cursor, sensitive/redacted status and justification,
destination current object and organized projection, update cadence, source of UI and Supervisor,
last proven capture/date, exception and planned owning PR. Distinguish current November imports from
October 28 diagnostic samples. Do not call an unproven field accessible or claim every API is granted.

**Must prove:** A complete inspectable matrix and source/spec links; reproducible read-only verification,
factual source-to-destination gaps, differentiated unauthorized/no-content/no-ID/never-called/stale,
and an owner-reviewable field-by-field architecture sheet for POS0b–POS0e. If official docs and tested
permissions conflict, record both. The matrix is a deliverable, **not** a declaration of full coverage.
**Tests:** deterministic inventory/schema comparison and read-only evidence with commands/output
linked in PR. No DB writes, no production migration. No extra file ownership without review.

**Known defect / owner handoff (not fixed or authorized by these drafts):** `toast_records_for` non-orders plus `cv_cash`, `cv_inventory`, `cv_kitchen`, `cv_dining_options` still depend on diagnostic-only captures; `lib/data/canonical/dictionary.ts` and its generated docs still claim daily non-order capture; `seen_run_id` remains used by live `toast_archive_order` and `toast_records_for` despite old retirement language. **POS0e** owns one additive current-source reader cutover, current dictionary metadata + generated Markdown and a transitive migrated-schema negative test. **POS0f** independently verifies after all migrations and registered screen/Supervisor answers. Do not rewrite historical migrations or erase `seen_run_id` without owner-approved consumer/rollback plan. `dayParser.ts` already isolates individual parse failures; current SQL `toast_import_day` still permits full-day rollback on SQL error, `liveArchive.server.ts` logs and returns early on archived-page failure without a durable retry, and `toast_record_day_error` can mark a backfill run complete with failed days: **dedicated order-import SQL/recovery PR ownership is NOT yet owner-assigned**, so each agent must report that missing scope rather than silently implementing it. **POS0d** owns later validated conditional menu snapshot / size GUID / safe deactivation; no-sales never removes catalog data. All unchanged correct screens, labor app corrections, performance projections, status/freshness and Test Café isolation are D3 protected until equivalent tests run. The current documentary approval of D1–D3 is not code authorization.

### D4A/D4B owner decision implementation boundary — one future order recovery owner, NOT authorized

The [#398 D4 card](toast-standard-api-coverage-matrix.md#d4ad4b-approved-architecture-outcome--no-runtime-approval-nov-7) is the decision evidence; the binding operational contract is **`docs/rules/pos-data.md`**, not another prompt. **D4A Approach B** means the existing 10-minute coordinator and distinct 15-minute live orders remain. Family-level changed-since/version and bounded validated snapshots, independent freshness/completeness/retry and automatic reconciliation must be built into the existing writer/reader; never full-download on every tick or depend only on webhooks.

**D4B outcome approved only:** 99 good + 1 SQL-cast/constraint/trigger-failing order must not lose valid orders or allow false full-day/financial verification. Existing `parseToastDayPage` per-order protection, `dayImport.ts` staged cursor and day transaction, `toast_record_day_error`, `liveArchive.server.ts` skipped-page risk, `missingDays.ts` repair and `rollupRetries.ts` generation-bound derivative queue must be traced end to end, **without inventing a second importer/queue/worker**. Preserve merged **#189** (nonce, cursor, Retry-After, generation cost refresh), **#203** (first backfill, shared five days/tick, daily fairness), **#264** (redaction/SQL timeout and fee-gap nonstarvation), **#297** (five-date 1h→24h deduplicated payment-gap recovery). Read-only queue baseline: 77 due cost-refresh jobs with zero attempts and existing rollups, separate diagnostic **not** evidence of failed imports.

**Newer owner D4B granular reporting + urgent recovery ([#398 decision](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6714387485)):** A single poison order must **never** suppress other validated/durably committed orders, shifts or payments. `lib/data/toastDayTrust.server.ts` already keeps stored rows queryable even if the day's status failed; `lib/calc/toastOwnerDay.ts` correctly withholds **final day aggregates** pending coverage. Registered Supervisor and screens must answer trustworthy individual records with original provider identity/as-of, mark **only the affected metric** partial and keep previously certified snapshots visible as old/as-of, not newly current. A known-order sum is **not necessarily a final total, minimum or estimate** (late negative refunds/adjustments). Test 99 immediately queryable + one DB bad, unknown net money, proper last-good, partial aggregate and eventual full-day certification **separately**.

**Auto-recovery is an owner priority to FINISH:** distinguish provider/auth/429, parse, SQL-row failure, whole DB outage, expired run and permanently bad upstream payload. Reuse `toast_unparsed_orders`, staging, `toast_sync_runs`, leased/paced `missingDays.ts` and existing source/deltas; use durable bounded targeted retrieval only if supported and/or day reconciliation, preserving #203 daily/backfill fairness, #264 payment-gap nonblocking, #297 rate limits/five-date cap and generation-bound derivative cost jobs. A permanent upstream error may remain visible and owner-reviewable but must not freeze independent work. **Exact B1 SQL savepoint/transaction strategy and urgent scheduling priority policy are OPEN owner choices, not approval to implement.** The separately observed 77 due zero-attempt `toast_rollup_refresh_jobs` are not missing sales: `rollupRetries.ts` checks the ACK error but not returned `false`; independently investigate false-vs-superseded generation, never reimport good orders merely to clear cost jobs, and reserve a **separately approved cost-queue fix**.

**D4B order-GUID processing-state handoff ([owner approval](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6714662444)):** Keep app validation/retry evidence logically associated with authorized **business + Toast restaurant + provider order GUID**, not run/page/field/modifier. The unchanged original Toast JSON stays in `toast_raw_records`; `toast_raw_changes` records only real provider edits, **never app-status transitions**. Distinguish `received`, `raw_saved`, `parsed_validated`, `canonical_promoted`, `metric_reconciled`; an archive download or successful today-summary is not proof of a durable write. Clear a defect only with positive save, validation and applicable reconciliation evidence. **No currently existing status column or new physical storage design is established or approved.** Normal same-day reattempt uses the existing **15-minute full current-day `/orders/v2/ordersBulk?businessDate=...`** collection, preserving idempotency for corrected **eligible finished** orders; open orders do not become final. Whole-row/page DB failure and no-GUID malformed data have **no stored order row to flag**: use existing staging/`toast_unparsed_orders`/day-status checkpoint/reconciliation evidence, then current closeout and bounded repull after rollover. Test missing field/GUID, bad SQL row, failed page, truncated provider page, repeat bulk download, rollover and corrected record; **98/99 or 99/100 valid rows immediately queryable** with only dependent money metrics partial, and recovery proof or honestly unresolved status. The precise SQL row/savepoint design, metadata persistence and priority scheduler are still **unapproved**.

**Explicit future proposed owner:** `POS0-order-recovery` (not a GitHub PR, not in dispatchable `queue.tasks`, no owner authorization). **Candidate exactly scoped existing paths to approve or narrow later:** `lib/pos/toast/dayImport.ts`, `lib/pos/toast/dayImport.test.ts`, `lib/pos/toast/scheduler.ts`, `lib/pos/toast/scheduler.test.ts`, `lib/pos/toast/missingDays.ts`, `lib/pos/toast/missingDays.test.ts`, `lib/pos/toast/liveArchive.server.ts`, `lib/pos/toast/liveArchive.test.ts`, `lib/pos/toast/rollupRetries.ts`, plus a new owner-approved next-free migration and disposable SQL integration file. Each path is a **proposal only**, checked against currently open #398/#400 (no runtime conflict) but not reserved against later concurrent work. Owner must choose exact SQL row-isolation/partial-day rule, reserve files and migration number, name PR/base/prerequisites and authorize coding. POS0f owns final proof, POS0e owns shared reader/status, not SQL importer rewrite.

**Executable release gate for that separately approved PR and POS0f:** migrated disposable Postgres injects one database-only failure amid 99 valid orders, and archive RPC failure before subsequent valid pages. Prove 99 idempotent durable outcomes; redacted bad identity and bounded replay; no complete/financially verified day with remaining exceptions; next days, cafés and payment-gap repairs proceed; prior certified days, costs, tips and receipts unchanged. Replay #189/#203/#264/#297 lease, 429, 100+-café rotating fairness, 5-day pacing, 5-date cap, 1h→24h, post-commit generation ACK and p50/p95/API/storage/rollback. Link actual CI and safe test data. **Not executed, not approved for runtime work.**

## Task POS0b

**D4A-specific acceptance:** Test `modifiedStartDate`/`modifiedEndDate` time-entry revisions, missed windows, provider vs Test Café identities, unknown-wage status across Staff/Payroll/Supervisor, independent `last_success_at` and bounded recovery. Never treat the daily coordinator tick as a completed labor refresh.

**Title:** Staff, jobs, shifts and time entries — all permitted fields, one current object
**Dependency:** POS0a field contract **and POS0e shared current-reader/retention foundation**. **State:** proposed until specific field/key approval.
**Likely existing code:** `lib/pos/toast/adapter.ts`, `laborSync.ts`, `operationalCopy.ts`,
`optionalSync.ts`; existing labor/staff canonical readers and archive snapshot writer. Reserve exact
exclusive files against active PRs before coding.

**How:** Fix the existing adapter's reduced response mapping without breaking payroll. Retain allowed
employee/job/shift/time-entry details, including provider job and shift references, break events, tip
fields, edit timestamps and actual provider flags **where supplied and permitted**. Store in existing
current-object record keyed by Toast identity, organize app-needed values into existing canonical tables
and refresh modified entries on bounded operational cadence. Join employee identity through existing
relationship keys; use the same café-local day logic and legitimate overtime/zero-pay definitions as
Staff and Money. **Do not** count a scheduled shift as worked or make a missing clock-in a verified zero.

**Must prove:** Field-by-field source/retention/retrieval parity; full history of genuine changed
timestamps/wages/tips/breaks with no duplicate snapshots; replay/reorder/partial/recovery; real
named-person answers for \"who worked on date?\" versus \"who is on shift now?\"; overnight and local
midnight; correct payroll/schedule parity and stale-source warnings. A late sync must never make AI
ask the owner to supply a POS-recorded attendance fact. **Tests:** adapter, SQL/RLS, CI integrated
read, screen/agent parity, stale/permission failure; existing order regressions stay green.

## Task POS0c

**D4A-specific acceptance:** For each actually permitted cash/stock/kitchen/availability operation, record source-native key, documented change signal or bounded validated fetch fallback, independent last-good/failure/204/403 status and no diagnostic-reader fallback. Prove no phantom stock zero, no duplicate cash, screen/Supervisor parity.

**Title:** Cash, stock, kitchen and dynamic availability — current operational objects
**Dependency:** POS0a field contract **and POS0e operational reader/retention foundation**. **State:** proposed until specific field/key approval.

**How:** Extend **existing** Toast client/job/current-object writer, not `toast_raw_samples` as a
second ongoing source. Cover accessible `cashmgmt/v1/entries`, `cashmgmt/v1/deposits`,
`stock/v1/inventory`, `kitchen/v1/export/itemFulfillments`, kitchen stations,
restaurant availability and ordering schedule, plus operational endpoints from the current matrix.
Use provider-native stable keys and genuine modification dates when documented; otherwise use a
documented stable identity/version rule, never import-run ID. Keep operational snapshot/status distinct
from event totals and retain source freshness. Current Toast's missing KDS capability, HTTP 204 or a
partial stock list must **not** be treated as verified no work/no inventory.

**Must prove:** Each permitted field in each successful response is retrievable by Supervisor from the
current object; no duplicate cash effects, phantom stock zero or inferred kitchen timings; same-data
replay, changed object and full recoverable backoff; bounded polling, per-location auth and explicit
unavailable reasons; current screen/card evidence agrees with canonical facts. **Tests:** SQL/RLS,
mock Standard API, changed/repeated/timeouts/429/403/204, multi-café isolation, agent parity.

## Task POS0d



**Nov 8 owner-approved experiment clock (Spec 0002 §3.2):** For Toast-verified price experiments, measurement begins at the actual validated publication observation instant, **not** owner's approval/Done or next café morning. Day 1 = the next **24 elapsed hours** from verification; successive windows are also rolling 24-hour periods, until the agreed N×24 hours. If the café is still open after the final boundary, continue through that day's actual closing time and report those extra trading hours **separately**. A 24-hour period is not 24 hours of trading. Existing `sales.server.ts` and `priceExperiment.ts` use daily `business_date` rollups and cannot substantiate these rolling windows; a future owner-authorized implementation must verify order-level timestamps, accurate published-price as-of, operating hours/timezone, DST, source freshness, money integrity, cancellations and no invented intraday totals on disposable DB. [Approved clock & test contract](https://github.com/killbill2792/aicafe/blob/feat/aicafe-task-POS0a/specs/0002-pos-change-verified-experiment-activation.md#32-owner-approved-measurement-clock-rolling-24-hour-periods-plus-final-closing-extension-2026-11-08). PR #398/#400 are documentation/guard work, not an authorization for this runtime implementation.

**Nov 7 follow-up — pending Toast price experiment must proactively notify owner:** When price plan is approved but the source-verified published Toast price has not changed, Supervisor continues a waiting-on-Toast state, sends a status reminder after a few hours, again next café morning and at a bounded follow-up cadence until verification/cancellation. Distinguish last successful provider check timestamp from outage/stale status; never claim “still $7 now” if Toast was not checked. Clicking manual Done is not source confirmation. On validated Toast publication with correct item/size/price, activate experiment immediately, stop pending reminders and record timestamp/partial business-day exposure; rolling 24-hour periods plus the last trading-day close extension are now approved in Spec 0002 §3.2. Reuse authenticated owner inbox/Operating Board/notification gateway and existing coordinator—no new reminder service/full-menu polling. **Owner-approved cadence (2026-11-08):** first proactive reminder approximately two hours after approval while Toast confirmation is still pending; one later local-day follow-up if needed; a next-morning reminder if still waiting; **no more than two proactive reminders per café-local day per pending experiment**, continued within that cap until source verification or cancellation. Use eligible owner notification channels/preferences, idempotency and correct source-check freshness; channel-specific integration remains implementation design, not permission to send now. Source/notification idempotency and tenant-isolation proof required. [Spec 0002 §3.1](https://github.com/killbill2792/aicafe/blob/feat/aicafe-task-POS0a/specs/0002-pos-change-verified-experiment-activation.md#31-pending-toast-reminders--owner-approved-requirement-2026-11-07-and-cadence-2026-11-08).

**Nov 7 owner clarification — automatic first-match and POS-confirmed experiments:** Owner selected **Option A**: normal Toast menu import and unambiguous legacy owner-recipe association are automatic, **without** a review click for every matching product; apply source-scoped GUID/alias first, then only an independently defined, auditable deterministic legacy match, with ambiguous/conflicting size/recipe kept for owner review. DO NOT equate a local menu-price edit or experiment proposal with a Toast publish. Supervisor's price-test start/duration must wait for **actual validated Toast published-price evidence**; owner Done alone cannot start monitoring. Read [spec 0001 §8.1](https://github.com/killbill2792/aicafe/blob/feat/aicafe-task-POS0a/specs/0001-d4c-toast-menu-authority-and-owner-review.md#81-cross-domain-boundary-proposed-price-and-staff-experiments-owner-clarified-2026-11-07) and [spec 0002 — POS-confirmed experiment activation (IN REVIEW)](https://github.com/killbill2792/aicafe/blob/feat/aicafe-task-POS0a/specs/0002-pos-change-verified-experiment-activation.md). **Verified gap:** priceExperiment manual_done currently sets next-day monitoring without source check; menuPriceChange local price history can be treated as an operationally verified price change. Do not dispatch code or assign shared experiment files until a separate owner-accepted plan and exclusive ownership are recorded; POS0d provides Toast source price evidence, registered Supervisor experiment owner performs lifecycle fix, POS0f verifies final parity. Staff plans inherit source confirmation but their true authoritative provider is a separate unresolved design question.

**Canonical owner-decision handoff — D4C spec (IN REVIEW, no implementation authorization):** [specs/0001 — Toast-first menu authority, unpublished owner review, and historical variant safety](https://github.com/killbill2792/aicafe/blob/feat/aicafe-task-POS0a/specs/0001-d4c-toast-menu-authority-and-owner-review.md) on draft #398. Read this **before** planning menu/import-review actions or tests: it consolidates approved Toast-first onboarding, published-only Menu, owner-added draft → publish in Toast → verified link, recipe preservation, confirmed unpublish/inactive and republish, one product with real size options, source-version-gated fetch and historical 563-line safety. Decisions in §8 remain open; do not promote the implementation approval gate or represent the spec as Accepted. POS0d owns future menu/catalog semantics; POS0f owns final Supervisor/screen parity; exclusive UI/server-action file ownership is unassigned.

**D4A-specific acceptance:** Reuse publication/version metadata and a single validated full menu snapshot only after confirmed change or bounded repair; prove no duplicate unchanged-version GETs, no local-day-triggered full download, no absent/unsold-item deletion, and preserve historical recipes, sizes and mapped cents.

**D4C owner-approved lifecycle and preservation ([#398 decision](https://github.com/killbill2792/aicafe/pull/398#issuecomment-6714937954); architecture only):** Preserve D4A metadata/change-driven cadence; never fetch a whole menu every 10 minutes. Trace `optionalSync.ts` metadata, `adapter.ts` Menus V2, `operationalCopy.ts` → `operationalStaging.ts`, `lib/pos/syncCatalog.ts`, and actual SQL removal/relationship consumers. Compare source restaurant/version/reference completeness and use one validated published snapshot across stages once a real publication change or bounded repair warrants it. Only a complete authenticated version-consistent published menu can mark missing provider item/modifier/relationships **inactive**, not deleted; a republished stable GUID reactivates without duplicates. Preserve owner-owned recipes/ingredients/edits, prior names/prices/versions, exact size/option IDs and historic sales. Reject absence on empty/partial/unauthorized/wrong-restaurant/mismatched-version/late/invalid-reference responses; preserve last-good status and retry boundedly. Zero sales and ambiguous historical size are never removal evidence. Require owner confirmation and full dependency/history audit for **any** permanent deletion; never erase historical transactions.

**D4C POS0d future executed acceptance:** Source-shaped metadata unchanged/changed, publication lag and changed-between-fetch versions; one complete snapshot/no duplicate full GET, failures and missing references do not retire; actual unpublish makes provider publication inactive only, republish same GUID restores it, historical orders and owner edits survive; migrated disposable SQL + real registered Supervisor/screen same-café status/parity, negative wrong-café and failure proof, source and DB cost/rollback. A specific physical schema, file-by-file source/consumer contract, approved exclusive files and migrations remain **OPEN** pending #398 final spec and separate owner authorization. This draft does **not** implement or dispatch POS0d.

**Title:** Remaining Standard setup/configuration/menu/device/partner endpoints
**Dependency:** POS0a field contract **and POS0e operational reader/retention foundation**. **State:** proposed until specific field/key approval.

**How:** Reuse the existing menu, restaurant, job/setup and archive logic. Retain permitted fields
from menus V2, configuration collections and detail-by-ID lookups, payment/configuration fields,
restaurant/partner info, packaging, device info and other eligible Standard GETs from the matrix.
Use the existing 10-minute sync to check supported metadata/version/modified signals; fetch full setup objects only when changed, within Toast API limits; preserve menu price history, identities
and discounts. An ID-scoped call without any eligible GUID is `missing_resource_guid`, not `zero`.
ERA needs separate Analytics authorization and Menus V3 is not counted as a Standard failure.

**Must prove:** Every eligible endpoint/field mapped once, discoverable and current; precision of
menu/prices/discounts, existing item/fee/financial screen parity, privacy, idempotence and version
changes. Every unavailable field documents permission/provider reason and verification date.
**Tests:** endpoint inventory, adapter, disposable DB, auth scope, changed setup, parity, regression.

## Task POS0e

**D4A/D4B shared-reader acceptance:** Actual provider `received/stored/provisional/reconciled/financially_verified/incomplete/stale` definitions and per-family freshness are shared with screen calculations, not fabricated from 10-minute ticks, incomplete days, or 77 separate cost-refresh retries.

**Title:** Universal discover/query of all retained fields through ONE shared foundation
**Dependency:** POS0a field contract. **State:** **FIRST proposed shared foundation** before POS0b–d; exact source/field/key approval and single-file ownership required.

**How:** **FIRST retire all active diagnostic-backed operational readers**: update existing `toast_records_for`, `cv_cash`, `cv_inventory`, `cv_kitchen`, `cv_dining_options` and any remaining canonical source from **current stored object data only**, with a new additive migration and a final-schema negative dependency test. Keep diagnostic captures for independent audit until safe cleanup; NEVER fall back to them for business answers. Existing tests in `scripts/toast-db-integration.sql` / `scripts/ai-toast-records-sql-integration.sql` that presently assert diagnostic-backed facts must instead assert their exclusion and current-source positive evidence. Correct binding `docs/rules/pos-data.md` and data-dictionary notes after changing final SQL, without modifying historical migrations. In the **same exclusive shared foundation ownership**, repair `lib/pos/toast/redact.ts` and its tests to retain every permitted customer/employee/contact/notes/stable ID field while excluding PAN/CVV/track and reusable payment/authentication secrets. Then extend the existing `toast_records_for` / canonical view, `ai_query_view`,
`describe_data`, `query_data` and dictionary to use **current** allowed records (including non-order
objects), with business-ID and field-level authorization. This first generic reader must support future POS0b/c/d object kinds without another per-family reader; avoid any arbitrary model-authored SQL.
Reuse known employee/time-entry, order/check/item/payment and other stable IDs for controlled
relationship traversal/aggregation; do not add a canonical view per owner question. Keep bounded
DB-computed results, pagination/coverage summaries and actor/provenance. Trace `get_staff`,
`get_sales`, `get_profit`, `get_schedule` and screen callers: specialized results may be concise,
but their underlying facts and canonical computations must be shared. Keep actual screen-number
definitions and `calculate` separate and unchanged unless a proven defect needs a minimal fix.

**Early foundation acceptance before POS0b–d:** Seed synthetic authoritative staff/time-entry/cash/stock/kitchen and diagnostic-only conflicting values in migrated disposable Supabase. Assert that the *same existing* `describe_data` and `query_data` can query current objects and **cannot** return sample-only values; `ai_toast_fields` no longer limits its field universe to 30 recent rows/200 paths; no change to imported order totals or screen calculations. Confirm named fields (including personal data permitted by Toast) survive the existing safe writer and cross-café requests remain denied. This foundation establishes generic capability, not claims that the future endpoint sync jobs are already implemented. Do not merge while diagnostic SQL lineage remains active.

**Must prove:** The exact same current staff/time-entry and order/payment evidence is available
to universal queries and applicable screens; previously absent labor details can now be retrieved.
Questions \"who worked today?\", \"who is on shift now?\", historical tips/job/revisions, stock,
cash, kitchen, config and unfamiliar cross-domain questions use the **existing** query tool(s).
An unsatisfied question returns source coverage/missing evidence, not a fabricated answer or an owner
request for POS data. **Tests:** one SQL query reader/consumer contract, no cross-tenant access,
field allowlists, invalid paths/SQL rejected, real agent loop with seeded data, dates/money parity.

## Task POS0f

**D4A/D4B final non-regression acceptance:** After all migrated SQL, rerun changed/unchanged/version/partial/failure family sync and 99+1 bad-SQL order tests, plus #189/#203/#264/#297 fairness, pacing, payment-gap and derivative cost-queue ownership. Real registered Supervisor and screens must show identical truthful coverage; no old diagnostic lineage.

**Title:** Enforce complete Standard API → storage → shared reader → Supervisor acceptance
**Dependency:** POS0e foundation + POS0b, POS0c and POS0d. **State:** proposed. This is the **priority gate** for E2/PR6/PR9/PR10
and thus every downstream PR6–PR17 task.

**Mandatory diagnostic retirement:** After the final active SQL/view and all operational code consumers prove zero diagnostic dependency, separately check the test-café mirror (`scripts/sync-cafe-data.mjs`), workflow, leases, fixtures, table grants and actual database table size. Retire the old daily raw capture and its mirroring if no longer justified; **delete obsolete diagnostics by a new migration only when authorized and proven safe**, with dry-run counts, zero dependent objects and rollback/retention decision. Do not leave compatibility aliases for Supervisor. The previous SQL diagnostic test must remain or be replaced by an isolated diagnostics-only test until physical removal is completed. Update current docs to describe the final state, not intended future state.

**How:** Build/strengthen **executable** coverage tests driven by the up-to-date operation/field
contract. An endpoint × field status matrix is generated by tests, not an old fixed total or a manual
`[x]` list. Check for every eligible field: Toast-shaped response → safety filter → existing writer
→ one current object and change history → discoverability → permitted `query_data` retrieval →
at least one full Supervisor-turn question, with deterministic SQL/fixture truth. Compare relevant
screen metric projections directly with Supervisor. Replace misleading fixtures/assertions that hid
gaps (e.g. inserting labor only into an older capture rather than normal labor sync) and update any
tests changed by the correct architecture. Never delete valid historical regressions or weaken
precision/privacy checks to manufacture a green build.

**Required executed proofs (not optional/skip):** fresh spec/registry diff; field-by-field
round-trip for all available Standard response families; identical replay and genuine edit/change
log; privacy and per-café RLS; pagination and bounded tokens; current versus stale/unknown/failed
captured truth; dynamic-date and timezone; old and new sources don't double-count; full order
regression; staff/timecard + name join; sales/payments/cents and screen parity; stock/cash/kitchen;
one unfamiliar cross-domain agent query. Run real SQL against a **disposable migrated Supabase** in
CI and link the executed job (no skipped acceptance, no paid AI requirement for numeric/fact checks).
Real-café data verification is read-only and owner-authorized; write/deploy/permission changes are
separate approval gates. Record for every endpoint: stored? allowed? complete field set? current?
Supervisor reads? screen parity? reason/date of exception? Final-head CI and Codex must be clean,
then post-merge consumer proof before `POS0f = integrated_proven`.

**Never mark POS0f done with** just merged commits, an old October capture, mock-only unit tests,
a green job that skipped SQL/agent assertions, or a claim \"AI can read all data\" without field-level
evidence. All older PRs and the current order-storage design remain intact.

## Task E2: E2 required seeded browser CI (GitHub Actions only; no Vercel preview)

- **Depends:** POS0f integrated proof, with E1 #369 and B2 #374 existing foundations. Not approved to dispatch until these gates are verified.
- **Result:** Required targeted Playwright in GitHub Actions against a locally started Next.js app and disposable seeded Supabase database; record actual executed browser scenarios.
- **Scope to verify/assign:** Existing CI/browser harness, disposable seeded auth and PR check integration; no preview deployment, no Vercel builds, no production connection. Assign exact exclusive files on current main before implementation.
- **Must prove:** A changed UI/browser flow runs its applicable real Playwright scenario with CI job/artifact link; backend-only changes are not delayed by irrelevant screenshots; no production accounts or side effects; skipped required browser proof is NOT a pass.
- **Tests:** db, e2e, security and relevant browser artifact proof in GitHub Actions only. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`, `playwright-cli`.

## Task 6: Durable worker and cross-turn execution

- **Depends:** 5 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Leased worker resumes one AI loop safely under budgets and authorization.
- **Scope to verify/assign:** lib/ai/supervisor/runs/*; new worker route; usage adapter. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Two workers cannot claim the same step; Restart resumes after verified earlier steps without repeating effects; Timeout/budget/cancel retains a truthful persisted status.
- **Tests:** unit, db, failure; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 7: Self-directed routines/prioritization

- **Depends:** 6 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Self-managed schedules and proactive priority decisions with due-once triggers.
- **Scope to verify/assign:** lib/ai/supervisor/routines/*; existing commitment/attention adapters. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** One routine occurrence makes one run across retries/DST; Owner may pause and revoke without stopping unrelated routine work; New evidence can trigger independent prioritization and owner notice.
- **Tests:** unit, db, failure; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 8a: Experiment cutover parity

- **Depends:** 7 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Experiments cutover with parity and single writer.
- **Scope to verify/assign:** existing lib/ai/supervisor/loop/* experiment cron. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Existing experiment observations and reports match before/after cutover; No duplicate runs or notices; Old cron disabled only after verified parity and rollback.
- **Tests:** unit, db, acceptance; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 8b: Events cutover parity

- **Depends:** 7 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Events cutover with parity and single writer.
- **Scope to verify/assign:** existing lib/events/* lookahead cron. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Events research/observation/report parity across current local day boundaries; Only one authoritative event monitor and notice writer; A missing/research-failed event is not called absent.
- **Tests:** unit, db, acceptance; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 8c: Morning brief cutover parity

- **Depends:** 7 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Brief cutover with timezone/delivery parity and single writer.
- **Scope to verify/assign:** lib/operating/briefSchedule.ts and existing morningBrief delivery path. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** One brief per verified owner/café-local day and preopening deadline; Provider failure remains visible/retriable; No duplicate sends or silent skips.
- **Tests:** unit, db, acceptance; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 9: Rolling operational memory

- **Depends:** 5 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Rolling thread memory with provenance and no cached financial facts.
- **Scope to verify/assign:** lib/ai/agent/history.ts, memory.server.ts and ai_threads summary. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Remember decisions/preferences across a reopened thread; No cached business money in summary, reread authoritative data; Forget/change and tenant isolation verified.
- **Tests:** unit, db, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 10: Individual approval and standing mandate gateway

- **Depends:** 5 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** One effect gateway supporting individual approval and OTP-backed standing authorization.
- **Scope to verify/assign:** existing supervisor proposals/approvals; auth-backed mandate authorization and receipts. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Individual approval and matching standing authorization both pass same effect gateway; Phone step-up binds exact owner/café/action/limit/revision; replay/expiry/revocation fail; Effect receipt uncertain state cannot be double committed.
- **Tests:** unit, db, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `testing-api-security-with-owasp-top-10`, `exploiting-idor-vulnerabilities`, `pr`.

## Task 11: Gmail and reusable connector security boundary

- **Depends:** 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Secure connector registry and Gmail end-to-end.
- **Scope to verify/assign:** new integration adapter plus existing tools/approval gateway. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Authorize/connect/disconnect Gmail and respect scopes; Draft/read/send only through permitted action with provider receipt; Timed-out send reconciles before retry; token not model-visible.
- **Tests:** unit, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `testing-api-security-with-owasp-top-10`, `playwright-cli`, `pr`.

## Task 12: General file/spreadsheet/browser/computer use

- **Depends:** 6, 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Files/spreadsheets/PDF/browser use with controlled external effects.
- **Scope to verify/assign:** existing attachment/file paths and new isolated browser adapter. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Read a permitted CSV/XLSX/PDF with column provenance and bounded data; Browser can inspect a permitted site but webpage instructions cannot change authority; Write attempt requires gateway permission and verified receipt.
- **Tests:** unit, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `testing-api-security-with-owasp-top-10`, `playwright-cli`, `pr`.

## Task 13a: Canonical staff schedule/labor reads and planning

- **Depends:** 6, 7 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Canonical scheduling reads and labor parity.
- **Scope to verify/assign:** lib/scheduling/*; lib/ai/agent/tools/draftSchedule.ts; canonical Staff readers. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Staff availability and projected demand produce valid schedule with canonical labor cost; No available staff/partial timecards truthfully handled; Exact parity to Staff view.
- **Tests:** unit, db, parity; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `e2e-testing-patterns`, `pr`.

## Task 13b: Mandate-controlled schedule publication and worker messaging

- **Depends:** 13a, 10, 11 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Mandate-controlled schedule publishing and messaging receipts.
- **Scope to verify/assign:** lib/actions/staffDraftInPlace.ts; existing approval + outbound transports. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner approval or valid mandate publishes one correct schedule; Authorized staff messages have verified delivery attempts; Mandate revoke before send prevents effect.
- **Tests:** unit, db, e2e, receipt; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `e2e-testing-patterns`, `pr`.

## Task 13c: Shift response/coverage lifecycle

- **Depends:** 13b (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Staff response, absences and shift coverage lifecycle.
- **Scope to verify/assign:** existing Staff scheduling acceptance/response readers and records. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Staff accepts/declines and coverage state updates once; No silent status success on a sent-only message; Missing staff coverage escalates without duplicate notices.
- **Tests:** unit, db, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `e2e-testing-patterns`, `pr`.

## Task 13d: Recruitment/leave/onboarding supported actions and human decision gates

- **Depends:** 13a, 10, 11 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Recruitment, leave, onboarding and human decision gates.
- **Scope to verify/assign:** Staff records plus authorized external posting/interview integrations. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Vacancy/interview/onboarding pipeline uses actual evidence, not presumed consent; No prohibited autonomous hiring/firing; Candidate data isolation and retention respected.
- **Tests:** unit, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `e2e-testing-patterns`, `pr`.

## Task 14a: Inventory/recipe/consumption evidence

- **Depends:** 6, 9 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Stock/recipe/consumption sources and uncertainty.
- **Scope to verify/assign:** existing inventory/menu/recipe evidence readers; no duplicate ledger. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Stock/recipe and consumption evidence retain source + freshness; Unknown quantity never becomes zero; No duplicate count from repeated source records.
- **Tests:** unit, db, parity; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 14b: Supplier/quote/PO domain lifecycle

- **Depends:** 14a, 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Vendor quotes and purchase order lifecycle.
- **Scope to verify/assign:** existing purchasing/bills records; vendor quote and PO domain contract. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Vendor quotes with units/currency/date are comparable or labeled incomplete; One PO state per key, history and duplicate protection; Owner approval boundary present.
- **Tests:** unit, db, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 14c: Authorized vendor communication and ordering

- **Depends:** 14b, 11, 12 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Vendor communications/order execution and receipts.
- **Scope to verify/assign:** approved connector/browser action adapters and vendor receipt ledger. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Only authorized vendor action executes; Provider timeout enters uncertain state; no duplicate order; Approval expires/revokes without further sends.
- **Tests:** unit, e2e, receipt; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 14d: Receiving/invoice matching and exception handling

- **Depends:** 14c (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Deliveries and invoice reconciliation.
- **Scope to verify/assign:** purchase receiving, invoice and expense readers; canonical money engine. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Partial receipt and mismatched invoice remain open exceptions; Duplicate invoice rejected; Expense/money parity with canonical metrics.
- **Tests:** unit, db, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 14e: Cashflow/payables administration and payment boundary

- **Depends:** 14d, 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Cash flow, bills and payable preparation with payment boundary.
- **Scope to verify/assign:** existing financial readers and preparation workflow; no unapproved fund movement. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Bills and cash needs accurately sourced, known vs projected labeled; Payments stay preparation-only absent explicit authorized lawful integration; No unverified settlement reported paid.
- **Tests:** unit, db, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 15a: Operating priority and anomaly escalation

- **Depends:** 7, 9 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Prioritization and alert escalation using one inbox.
- **Scope to verify/assign:** lib/attention/* and operating_tasks/notifyOwner. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Supervisor initiates priority work from events and operational evidence; One attention/inbox lifecycle and suppressed duplicates; High urgency and missing evidence escalated truthfully.
- **Tests:** unit, db, failure; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 15b: Equipment/maintenance coordination with evidence

- **Depends:** 15a, 10, 11 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Maintenance and equipment coordination.
- **Scope to verify/assign:** operating_tasks plus equipment/maintenance evidence adapters. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Maintenance incident assigned to authorized staff/vendor and tracked; Request sent is not repair completed; Late or unverified resolution remains visible.
- **Tests:** unit, e2e, receipt; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `vitest`, `supabase`, `pr`.

## Task 15c: Fleet resilience/queue fairness/recovery operational proof

- **Depends:** 6, 7, 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** System outages, concurrency, queue fairness and catch-up.
- **Scope to verify/assign:** existing worker/routines resiliency and health reads. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Concurrent cafés progress under fairness/budget caps; Stalled lease and missed routine recover once; Owner offline doesn't freeze permitted work.
- **Tests:** unit, db, failure; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `supabase-postgres-best-practices`, `vitest`, `pr`.

## Task 15d: Untrusted external content/identity/revocation hardening

- **Depends:** 10, 11, 12 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Prompt-injection and provider/cafe access revocation.
- **Scope to verify/assign:** connector and browser authorization/trust handling. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Untrusted email/website prompts cannot authorize actions; Revoked connector/café access stops new effects; No cross-tenant leakage/secret logs.
- **Tests:** unit, security, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `supabase`, `testing-api-security-with-owasp-top-10`, `exploiting-idor-vulnerabilities`, `pr`.

## Task 16a: Owner mandate grant/revoke and OTP step-up experience

- **Depends:** 10 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Owner approval and OTP mandate grant/revoke UI.
- **Scope to verify/assign:** existing Supervisor chat approval controls + Supabase owner auth. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner deliberately grants/revokes scoped mandate with step-up; Individual approval still works; chat phrase alone cannot grant; Mobile errors/expired code visible.
- **Tests:** e2e, security, preview; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `pr`.

## Task 16b: Owner-visible durable work, results, exceptions

- **Depends:** 6, 9 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Chat progress, retries and receipts.
- **Scope to verify/assign:** Supervisor chat/Operations status cards and runs reader. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner sees queued/running/approval/failed/completed run with true receipts; Refresh/reconnect shows persisted state; No duplicated approval card on resume.
- **Tests:** e2e, preview; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `pr`.

## Task 16c: Owner connector and computer access controls

- **Depends:** 11, 12 (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Account, connector and browser permission controls.
- **Scope to verify/assign:** owner-facing authorized connectors/files/browser controls. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner can link/revoke and understand scope of external access; Revocation reflected before new work; Safe file/browser error and retry displayed.
- **Tests:** e2e, security, preview; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `pr`.

## Task 16d: Accessible responsive owner acceptance

- **Depends:** 16a, 16b, 16c (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Responsive accessible final owner UX.
- **Scope to verify/assign:** existing responsive chat and operations screens; no new dashboard. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** 390px mobile and desktop owner journeys work with keyboard/tap targets; No second required dashboard; Conditional screenshots/traces only for changed UI flows.
- **Tests:** e2e, visual, preview; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `web-design-guidelines`, `pr`.

## Task 17a: Required CI E2E gate and evidence audit

- **Depends:** E2, 16d (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Required E2E gate evidence and branch protection.
- **Scope to verify/assign:** existing PR baseline/E2 targeted check wiring. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Required CI acceptance recognizes actual test execution vs skip; Branch protection accurately reflects available checks; No irrelevant browser gate for backend-only PR.
- **Tests:** e2e, ci, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `gh-fix-ci`, `pr`.

## Task 17b: Cross-domain deterministic business scenario suite

- **Depends:** 8a, 8b, 8c, 13c, 13d, 14e, 15b, 16d (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Cross-domain deterministic acceptance suite.
- **Scope to verify/assign:** cross-domain fixtures + existing golden eval suites. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Unfamiliar café questions combine canonical data with exact numbers; Staff/supply/finance/events/brief owner journeys verify real state transitions; Permissions and missing data negatives covered.
- **Tests:** db, e2e, receipt, parity; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `gh-fix-ci`, `pr`.

## Task 17c: Unattended multi-day outage/autonomy simulation

- **Depends:** 17b, 15c, 15d (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Multi-day autonomous failure simulation.
- **Scope to verify/assign:** disposable multi-day operations simulation. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Multi-day unattended run recovers worker/provider failures; Standing mandate and individual approval both exercised; No duplicate side effects across retries.
- **Tests:** failure, db, e2e; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `gh-fix-ci`, `pr`.

## Task 17d: Isolated preview readiness and smoke acceptance

- **Depends:** 17c (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Safe preview smoke and artifacts.
- **Scope to verify/assign:** isolated preview/deployment smoke harness. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Seeded isolated preview runs owner-facing scenario; Preview never touches production systems; Required evidence URLs/artifacts exist for UI changes.
- **Tests:** preview, e2e, security; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `e2e-testing-patterns`, `gh-fix-ci`, `pr`.

## Task 17e: Owner-authorized live pilot and final release evidence

- **Depends:** 17d, 17a (open prerequisite → stacked draft; merge after proven integration).
- **Result:** Owner-authorized live pilot and certified release.
- **Scope to verify/assign:** owner-authorized pilot/release checklist and evidence. Exclusive editable paths must be decided against current main and open PRs before coding.
- **Must prove:** Owner-authorized pilot verifies live sources and actions; Rollback, audit and incident procedures exercised; Actual release readiness distinguished from merged code.
- **Tests:** pilot, release; optional targeted browser/preview only when relevant; required tests cannot be skipped. **Skills:** `playwright-cli`, `gh-fix-ci`, `pr`.

