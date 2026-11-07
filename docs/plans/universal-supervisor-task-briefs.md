# Universal Supervisor — coding-agent task briefs (proposal)

**MANDATORY POS0 PRE-CODING SOURCE-AUTHORITY GATE:** Before opening/editing POS0b–POS0f, read **[docs/rules/pos-data.md](../rules/pos-data.md)** in full (the binding single authority for current versus diagnostic data, names, retirement and proof), then AGENTS.md, current main code and the [POS0a actual-source audit](toast-standard-api-coverage-matrix.md). In the **first** PR body, reproduce the table/classification for `toast_raw_records` (**OPERATIONAL_CURRENT**), `toast_raw_changes` (**CHANGE_LOG**), `toast_raw_samples` (**LEGACY_DIAGNOSTIC_ONLY**), `toast_raw_samples_latest` (**LEGACY_DIAGNOSTIC_ONLY**), typed/staged operational facts and the existing `toast_records_for` / `describe_data` / `query_data` consumers. List the **exact source→field→object key→writer→reader→Supervisor/screen** chain and the old diagnostic consumers to retire. Include literal `source_authority_checked: yes`, with links to the files inspected and current-head source proof. **This string is a review declaration, not a substitute for proof.** If a coder cannot verify the classification, they must not invent another store, reader or fixture. No POS0 source-family PR may claim done if its newly stored data is not answerable via the real existing Supervisor tools and a non-diagnostic test.

**Sequence correction:** The **existing POS0e task moves ahead of POS0b/c/d as the shared reader and global retained-field foundation**. POS0e first cuts off operational consumers of `toast_raw_samples`, repairs the existing global safe-field policy and provides schema-backed discovery/current-object reads. Then POS0b–d extend that reader with their distinct source families (parallel disjoint files); POS0f is the final all-family proof and explicitly retires obsolete diagnostic capture/mirror/rows **only after** all active consumers are gone. The queue JSON dependencies must match this order. This is a **reordering of the existing six tasks**, not a second agent or data system; POS0e alone owns globally shared reader/redactor files and b/c/d must not edit those in parallel. No production data deletion solely on plan approval.

**Read once:** `AGENTS.md`, `PROGRESS.md`, [agent operations](universal-supervisor-agent-operations.md), [queue](universal-supervisor-queue.json), and the three AI CAFE skills in `.claude/skills/`. Each coding chat opens the task's relevant listed existing skills and verifies its own current code/PR scope. The **one common lifecycle** (stacked draft immediately, one PR/chat, current-head CI, Codex review and resolved threads, rebase when dependency merges, integration proof, merge) is in `aicafe-pr-lifecycle`; do not duplicate it in each task.

**Status:** these are proposed requirements until owner-approved architecture and exclusive editable paths are recorded. Do not assume the Grok-local PR6–PR12 briefs were retrieved. A merged prerequisite is not automatically proven. **Browser screenshots only when a changed UI/browser owner journey needs them.** No production deploy or action without separate owner authorization.

**Short coding prompt:** `Use connected GitHub plugin. Read AGENTS.md + PROGRESS.md and load aicafe-pr-lifecycle, aicafe-dependency-check, aicafe-proof-gate and TASK_ID skills. Implement the approved brief for TASK_ID from docs/plans/universal-supervisor-task-briefs.md. Open a draft PR immediately (stack on open dependency branch); own it through CI/Codex/resolve/review/rebase/merge. Verify prerequisite behavior and required acceptance with actual executed evidence. Only touch assigned paths; no production changes.`

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
**Exclusive file:** `docs/plans/toast-standard-api-coverage-matrix.md`. No runtime code, migrations
or live provider writes. Reuse the repository's official operation inventory, current online Toast API
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

## Task POS0b

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

