# Reported Supervisor gaps: café time, Toast data and reminders

**Source:** Owner-supplied AI Cafe mobile screenshots and accompanying report, November 21, 2026. **Status: symptoms to investigate; not independently reproduced; no architecture or implementation approved.** This PR is documentation-only and must remain a draft until the owner decides next steps.

## Observations and questions (not confirmed root causes)

1. **Café local time.** The saved café profile shows **Pacific Time — Los Angeles**, while the Supervisor refuses “remind me in 30 mins about total sales,” saying it lacks current café local time and asking the owner to specify San Francisco time. The screenshot does not establish whether time context, a current clock, settings loading or tool registration failed.
2. **Reminder persistence and delivery.** After providing a normal/absolute time, the owner reports the Supervisor said the reminder was created, but it is unknown whether a persisted reminder exists, whether it will execute, where any notification is delivered (chat, push, otherwise), or how success/failure is confirmed. **A model's “created” statement is not a delivery receipt.**
3. **Hourly sales from Toast.** The owner expects hourly sales but cannot obtain them reliably. It is unknown whether the permitted Toast API/account exposes the necessary source data, whether ingestion/retention/aggregation captures it, or whether current registered Supervisor tools can answer.
4. **Customers and repeat visits.** The owner cannot see customer names/repeat customers, despite previous PR work described as extracting cardholder names. The live source fields, actual stored identity/matching behavior, authorized privacy constraints, completeness and tool/view availability are unverified. Do **not** infer customer identity from a card token or assume Toast provides names.
5. **Wastage and inventory read.** The October wastage screenshot states the inventory-variance read failed and ingredient costs are missing for **55 menu items**; the reported **$50.38** ingredient cost is explicitly incomplete. Root cause of the read failure and any missing source/recipe costs is unverified. Other labor/fee figures do not establish wastage.
6. **Source provenance and answer certainty.** The owner sees a profit estimate with a breakdown and “Not checked against your records,” raising the question of when facts are sourced, estimated or unverified. This does not prove the displayed financial numbers are incorrect.
7. **Concise notifications vs verified action.** The owner wants short notices, but also needs to distinguish a claimed action, a persisted routine/reminder, and actual delivery. Do not interpret short UI copy as evidence that an external effect occurred.

## What we can substantiate from supplied screenshots

- Saved profile: Seiyun Yemeni Coffee / Seiyun Cafe, USD, `Pacific Time — Los Angeles`, address in San Francisco.
- Supervisor's relative-time reminder refusal despite that saved timezone.
- Supervisor's incomplete October wastage response and its own disclosure of missing cost information.
- The later reminder acknowledgement, hourly sales problems and customer/repeat-name gap are **owner-reported**, not supported by independent records, logs or provider response inspection.
- Screenshots were supplied in the project conversation and are not copied to this repository; this document does not embed customer data or secrets.

## Unknowns for a later owner architecture discussion

- Which time source and timezone are authoritative for the current conversation and relative reminders?
- Was a reminder persisted, which existing scheduler executes it, and what delivery channel and receipt can be observed?
- What hourly sales/customer/cardholder data are permitted and available in Toast, which fields are actually persisted, and what are the privacy/matching rules?
- Why did the inventory-variance read fail? Where are the missing ingredient costs?
- What does “Not checked against your records” mean for each data source, estimate and cited answer?
- Which symptoms reproduce on an authorized café/account, without access to another tenant's data?

## Explicit non-scope / ownership

**No design, architecture, accepted scope, implementation, database/connector change, customer matching logic, notification channel or live test is approved in this PR.** The owner explicitly requested only the problem statement and will decide architecture and scope later.

This independent documentation PR does not alter or depend on serverless packaging PR551, staff PR550 or Task17's existing work. It must not be treated as implementing, testing or resolving any listed symptom.


---

# OWNER-APPROVED IMPLEMENTATION CONTRACT — SOURCE/DATA WORKSTREAM (#553)

**Decision:** On November 21, 2026, the owner approved consolidation into at most two active implementation PRs and directed this existing PR to become the Toast/source implementation. The previous report above is preserved as the original observation history; its "no architecture approved" statement is now superseded only for the bounded source-plane scope below. This is a **draft implementation contract**: code, CI, Codex and release are **not yet proven**. All reminder/worker/notifications/UI fixes belong to the separate independent operational-intelligence PR, **not this PR**. Task17 remains separate.

## Source-truth corrections already verified — no repeat investigation

1. **#555 is MERGED** as \`1036d28928cf262516162203d9cd7901aea5a1ff\`; the *real* trusted-main, existing-client Standard API probe [#44978913944](https://github.com/killbill2792/aicafe/actions/runs/44978913944) passed. It read 20 individual orders, 20 individual payments and one separate 20-order bulk page (unpaired). 19/20 individual checks had \`customer: null\`; one non-store check had a genuine guest object; all 20 had \`tabName\`. Among 20 payment-detail responses, tested cardholder names, \`cardPaymentId\`, card fingerprint, PAR and nested customer/guest objects were **absent in all 20**. No extra cardholder identity was hidden by reconciliation Zod **in this sample**. Transaction-specific \`networkTransactionIdentifier\` is **not** a repeat-person key. Never claim 20 sample points prove every order/café, or that the Toast Web Guestbook is accessible through Standard API. No Analytics/RMS upgrade; owner declined it.
2. **Existing source is real and extensive:** Standard Orders \`/orders/v2/ordersBulk\` (plus bounded individual detail/reconciliation) → existing \`redactToastRaw\` → \`toast_raw_records\` current and \`toast_raw_changes\` deltas → existing scoped \`toast_records_for\`, \`cv_*\`, \`ai_query_view\`, \`describe_data\`/\`query_data\`. Per-provider stable keys and owner/restaurant scope are authoritative; do not create another archive, reader, CRM, importer, manual CSV path or data model. A recent one-day query of \`toast_records_for\` produced check/tab display fields and its exact verified customer reference correctly. Current \`customer_visits_for\` could time out because it scans full historic source through its end date; optimize original authorized projection, not a second truth.
3. **Hourly gap is narrower:** historical \`hourly_sales_rollup\` / \`cv_sales_hours\` already work for closed dates. Current \`toast_today_live\` gives a provisional day total and source orders include paid/opened timestamps, but existing today tool does not expose source-reconciled live hourly buckets. Extend existing canonical reader and selected tool projection; do not create an hourly side ledger.
4. **Privacy:** live current order-payment JSON can contain \`first6Digits\` and \`ai_query_path('data.first6Digits')\` was admitted in the generic source query. This is unnecessary card-number fragment exposure; block at **both** existing ingress redaction and query-admission/read boundary, with backwards-compatible handling of already retained records and negative cross-café tests. **Do not** log or copy payment card fragments in tests, CI or PR.
5. **Inventory/cost:** an owner screenshot showed an October inventory-variance reader error and missing ingredient costs for 55 menu items; root cause, and per-item authoritative ingredient/recipe costs, remain unknown. Investigate only the actual existing failed reader and coverage markers; missing prices are **unknown**, not zero, and estimates must be labeled. Do not create cost or waste values from assumptions. Production test/refetch requires separate authorization.
6. **Guestbook boundary:** Toast Web Guestbook is an owner-managed Web UI/report, not a documented Standard Orders API guestbook endpoint. The #555 addendum reports no authenticated Guestbook export available in this session; do not invent a /guestbook API, demand CSV, silently add connector or infer identity joins. An actual authorized export and join-key proof would be a separate source decision, not a blocker for source-reliability work here.

## Field/source/writer/reader contract and keys

| Source fields | Current write/key | Consumers and required behavior |
| --- | --- | --- |
| Toast order GUID, check GUID, restaurant GUID, business date, \`paidDate\`/\`openedDate\`, payment amounts/refunds/voids | Existing current \`toast_raw_records\` by (business/restaurant, provider object type and provider GUID), with only changed-source deltas in \`toast_raw_changes\`; existing typed/rollup projections | Existing \`cv_sales_hours\` / \`ai_query_view\` / sales/today tools; expose arbitrary café-local hourly buckets for both historical and *provisional live* periods, using exactly shared net-sales and source completeness semantics, no double counting and no guessed UTC-to-café grouping |
| \`Check.customer.guid\`, guest first/last when provided, loyalty identifier when actually supplied, barista \`tabName\` | Same permitted JSON and existing #539 identity projection; no new identity store | Only verified guest/loyalty references can link return visits. \`tabName\` is a label, **not** a person or repeat identity. Never match by name, transaction GUID, PAN prefixes or last4; no unsupported card identity |
| Payment \`first6Digits\` / similar prohibited card-number fragments | Existing \`redactToastRaw\` filters before archive, plus independent \`ai_query_path\` / \`query_data\` field denial on existing stored data | No owner/agent generic query can retrieve disallowed fragments; legitimate sales/payment amount, type and fees remain intact |
| Inventory variance, recipe ingredient/unit costs and freshness/completeness | Existing inventory/recipe and cost records with their current keys, source states and cost calculators | Existing inventory/variance and profit tools; preserve incomplete labels and explain exactly which ingredient costs are unknown; no fabricated totals |

**No new customer/source table or endpoint.** If actual vetted SQL requires an additive migration, use a unique next migration number after checking current main, preserve prior migrations, invoker-RLS and existing tenant scope; demonstrate roll-forward and rollback. Any currently unknown source field remains explicitly unknown and cannot be treated as available.

## Exact implementation targets / ownership (existing modules only)

- \`lib/pos/toast/redact.ts\` — deny fragments while retaining allowed guest names and normal business facts.
- \`lib/ai/agent/tools/dataQuery.ts\`, \`lib/data/canonical/dictionary.ts\` and the **existing** \`ai_query_path\` SQL function in an additive \`supabase/migrations/*.sql\` — retain governed source discovery, deny sensitive paths, preserve source units, and expose genuine supported live hour groups via existing catalog/reader.
- Existing current-day reader and sales tool modules (\`lib/ai/agent/tools/today.ts\`, \`lib/ai/agent/tools/sales.ts\`, as actually present on main), plus existing \`cv_sales_hours\`/hourly projection SQL: reconcile live per-hour cents and eventual closed-day figures. Do **not** add a hardcoded hourly-sales intent router.
- Existing \`customer_visits_for\` / #539 **additive follow-on** SQL projection only to correct bounded source-read performance and preserve prior-visit identity semantics; no change to the old applied migration. Do not join on unproven identifiers.
- Existing inventory/variance/cost reader and its tests only as needed to reproduce and repair *verified* failures; first inspect actual reader identifiers and failure classification, then fix precisely. This is not authority to invent cost data.
- Corresponding existing \`lib/pos/toast\` sanitizer tests, registered agent/tool tests and \`scripts/toast-db-integration.sql\` source/tenant/lineage assertions; preserve full current-head regression suite.

**No changes to** \`app/api/cron/refresh-derived/route.ts\`, \`manage_commitment\`, U4 dispatch/checkpoints, \`notifyOwner\`, \`operating_tasks\` lifecycle, owner PWA/Operations/Profile, #552 staff question code, Task17 PRs, \`PROGRESS.md\` or production flags.

## Finish criteria — all must be EXECUTED, not merely documented

- [ ] Real source → current permitted storage → shared reader → registered owner tool/source-as-of parity demonstrated for live/current/closed hourly sales, with refunds/corrections, DST, incomplete day and two-café negative control; no new source writer.
- [ ] Historical hourly aggregates unchanged and customer/guest/loyalty identity behavior remains correct; 20-order #555 source result included honestly; cannot label ordinary walk-in \`tabName\` repeats as verified returning humans.
- [ ] Real PostgreSQL plan/measurement proves bounded \`customer_visits_for\` on a realistic historical dataset and correct complete-as-of visit numbering without a tenant/authorization bypass.
- [ ] Generic queries of prohibited card fragments DENIED against both fresh and previously stored payment payloads; allowed POS fields remain accessible; no privacy data in CI output.
- [ ] Inventory-variance source failure characterized by deterministic reproduction and existing-path repair where verified; ingredient-cost gaps remain explicit if truly absent.
- [ ] Applicable disposable migrated DB/security/RLS, TS/lint, complete tests, build, owner scenario and exact-head CI green; register relevant real Luna scenario but do not pay/run absent separate grant.
- [ ] Final exact-head Codex review clean, discussion/comment dispositions complete, up to date with main, and no production migration/actual data refetch/activation without separate release grant.

## COPY-PASTE CODING PROMPT — THIS SAME PR #553

**Implement this PR, do not open another.** Read latest main \`AGENTS.md\`, \`PROGRESS.md\`, \`docs/rules/{pos-data,ai-architecture,workflow-and-review,acceptance-quality}.md\` and this implementation contract first. Earlier #553 statements that architecture is undecided are superseded by the owner's Nov21 approval, but **do not broaden this source-plane scope**. First compare main and this head; keep the #555 source truth and update only the modules listed above. Work in this existing branch. Build actual verified live hourly buckets in the existing source/query path, block payment-card fragments at both data boundaries, repair bounded customer-history retrieval, and correct only reproduced inventory/recipe-cost reader failures. Create additive migrations only where required. Preserve original sources and owner/tenant scopes. Test true data-to-tool parity, unknown and adversarial sources, independent café isolation and SQL denial. Run and monitor all required CI, address red gates, obtain an authentic Codex review of the final tested head; do not declare success from a draft plan or green text alone. Leave Task17 and all operational/reminder/notification/worker work for the independent PR. No paid Luna runs or production changes.
