# AI CAFE — Supervisor investigation, SQL research, labor evidence and onboarding: issues for architecture review

**Status:** Owner authorized implementation on PR #561. Changes below are on this PR branch; deployment, migration, environment rollout and merger must be verified separately. This document preserves the evidence snapshot and the full acceptance checklist.
**Evidence basis:** Privately held source and infrastructure audit, November 2026. Identifiers, provider configuration, usage records, and owner emails have been omitted. This PR includes synthetic tests only.
**Scope:** Record root causes, implementation decisions, code changes, tests and production acceptance. Explicit owner request authorized implementing PR #561, but source commits are not themselves proof of a production deployment.
**Related implementations:** [#560](https://github.com/killbill2792/aicafe/pull/560) (verified-Toast eligibility and daily-brief safeguards, merged November 23 (was open at audit)); [#547](https://github.com/killbill2792/aicafe/pull/547) (U3 SQL research, merged but not production-activated); [#553](https://github.com/killbill2792/aicafe/pull/553) (Toast sources and **hourly sales**); [#405](https://github.com/killbill2792/aicafe/pull/405) (Toast labor ingestion). Do not create a parallel implementation of these changes.

## A. Desired end-to-end customer behavior (not yet an approved architecture)

1. Customer registers. No shared demo/test-café ownership; the customer belongs only to their own stable café UUID, regardless of repeated display names.
2. Customer connects their own Toast integration. Absence/unverified/disconnected Toast must not schedule paid unattended business analysis.
3. Toast sync captures orders, *hourly sales*, staff time entries, clock-in/out and whatever break evidence Toast actually provides. Track missing inputs and provenance; don't invent unreported break punches.
4. Supervisor answers real owner questions using correctly scoped canonical data, with sufficient detail for time-entry and meal-break questions; reports whether evidence is present, missing, partial, stale or uncertain.
5. A rule produces an alert. An investigation may run **once for new actionable evidence**, persist a durable finding or precise owner question, then await actual new evidence or an answer. A technical failure must not create endless paid re-analysis.
6. U4 owner-requested routines and optional unsolicited U4 Watch are separate decisions/consents; the owner should not be charged for duplicative work.

## B. Tenant identity and eligibility (sanitized)

The review included a verified, non-demo Toast tenant, disconnected non-demo tenants and a historical shared-demo fixture. Matching café display names are not identifiers. Service and owner actions must use immutable business UUIDs, and only a verified Toast connection makes a real café eligible for scheduled paid investigations. Existing demo and owner records must not be destructively cleaned up until the separate signup migration and owner-specific navigation acceptance pass.

Raw owner identities, Supabase project identifiers, integration status by named customer, order counts and operational usage evidence are retained in restricted operational systems, **not** this public pull-request artifact.

## C. Confirmed findings

### P0-1 — automatic investigation retries are causing repeated paid work without new evidence or owner input

**Trigger path:** Toast / canonical data -> `lib/alerts/generate.ts` or `lib/alerts/businessAnomalies.server.ts` -> `public.alerts` / `public.operating_tasks` -> `readActionablePriorities` / `enqueueInvestigationsForOwner` -> `supervisor_enqueue_investigation` -> `supervisor_claim_investigation` -> `processDueInvestigations` from `/api/cron/refresh-derived`. Alert colour is *presentation*, not the trigger; the rules, source identity, priority and queue admission decide.

**Sanitized fault pattern:** Unchanged open meal-break alerts, business-anomaly coverage gaps and staffing observations generated repeated leased model calls while owner questions remained unanswered. A historical daily brief also entered the incident queue. Counts, dates, owner email addresses and attributable per-source spending are not included in the repository; the disposable regression tests reproduce the loop.

**Exact code/SQL reasons:**
- `supervisor_fail_investigation` increments `failure_count` to max 5; after five errors it schedules `next_retry_at = now + 6 hours` **forever**, never terminally pausing the paid worker.
- `lib/ai/supervisor/routines/investigation.server.ts`'s silent `awaiting_owner` recheck applies only while `lastOwnerUpdate` is **under 24 hours**, `last_error` is empty, and evidence remains identical. Once the window expires, or an error exists, the model can run again even with no owner response.
- Re-queue reads priorities with `includeNotified: true`; the alert/task remaining open means it stays eligible without a meaningful source-change requirement.
- One `daily-brief:2026-10-31` investigation is still active with `model_incomplete` and repeated attempts in late November. Review why daily briefs enter the paid incident queue.

**Evidence:** `public.supervisor_investigations`, `public.supervisor_system_usage_events`, `public.alerts`; code `supabase/migrations/20261116000001_supervisor_system_usage_quota.sql`, `lib/ai/supervisor/routines/investigation.server.ts`, `lib/ai/supervisor/routines/dispatch.server.ts`.

**Owner requirement:** Preserve unresolved alerts for visibility but do not repeat paid investigation until there is *relevant new evidence*, an *actual owner response*, or an *explicit authorized retry*. Decide retry semantics for truly transient failures separately. Do not mark absence of evidence as a confirmed fact.

### P0-1A — owner-confirmed workflow requirement: incident-scoped, evidence-triggered wakeups (sample dates)

**Required behavior, not yet implemented:** The Supervisor investigates a *specific* issue, sends one evidence-backed report or actionable question to the owner, and enters a durable waiting/blocked state when an owner action or missing evidence is needed. The regular Toast poll and deterministic data checks continue, but **the paid AI worker is not scheduled solely because time has passed, the issue is still open, or unrelated records have changed**.

**Precise example:** A shift for an employee on sample dates is missing clock-in/out evidence. Luna identifies the specific employee, local business date, and scheduled shift; reports the gap once; and waits. A Toast import on sample dates that contains an unrelated shift for sample dates **must not** wake or restart the sample dates investigation. If a late-arriving, verified sample dates time entry belonging to *that same shift* appears, its clock-in/out facts are compared with the missing evidence for the sample dates issue. A deterministic check may resolve the gap without AI. Otherwise Luna runs at most one scoped follow-up with the newly changed facts and existing checkpoint; do not re-investigate the entire week or other employees.

**Proposed design contract to discuss:**

1. **Issue identity:** Persist a stable identity tied to business UUID, issue type, business-local date (or exact date range for period-based issues), and the relevant entity (employee + scheduled shift / provider time-entry identity; order, SKU, supplier line, etc. for other issues). Missing-provider-ID cases must reconcile to the eventual late-arriving entry without assuming any record on the same day is a match. Period-based issues explicitly declare which input dates/rows form their dependency range; do not force every issue to a single date.
2. **Read dependency snapshot:** Save the fields and source identities actually used to reach the finding, an evidence fingerprint of *business facts* (not sync timestamps), and the last handled version. This is an issue-specific dependency set, not a business-global or table-global data version.
3. **Cheap targeted wake filter:** Toast ingestion can emit changed row/key/date summaries through the existing refresh and source-change workflow. Compare changed keys to each waiting issue's declared dependencies; **unrelated date, employee, shift or field changes cause no investigation wake or model charge**. A repeated identical Toast payload also causes no wake.
4. **State semantics:** New actionable evidence -> one bounded investigation -> owner report -> `awaiting_owner` when action is required, `awaiting_source` when data is missing, `blocked` on an exhausted technical failure, `resolved` when proven fixed, `ignored` when explicitly dismissed. These are conceptual states for architecture review; reuse/extend the existing SQL lifecycle rather than inventing a second job platform. Waiting is durable until an authorized matching event, not 24 hours.
5. **Relevant change:** If the exact missing fields arrive, recompute that issue's evidence and decision. Auto-resolve with a cheap verified rule when possible, and inform the owner without a fresh model turn; if an interpretation is required, resume the same incident with only the **delta + prior findings**. Keep owner-needed approval pending if new evidence doesn't satisfy it; never create a second identical owner question.
6. **Owner response / deliberate action:** An answer to the saved question or an explicit owner retry/ignore/resolve action is matched to that exact incident. The same response is consumed at most once. An unrelated owner message or later unrelated Toast date is not a wake signal.
7. **Failure and notification boundaries:** Temporary provider/network/DB errors may have a small, bounded technical retry policy, with error-specific backoff. Missing business evidence and unanswered questions are **not** transient failures. After a limit, preserve the incident and surface the blocker; optional non-AI reminders may operate separately but cannot re-run the investigation. Budget and source-auth checks remain mandatory.
8. **Watch/U4 overlap:** If U4 Watch observes the same incident, it references the existing saved investigation and version; it must not launch another paid analysis of unchanged source evidence.

**Non-negotiable future acceptance:**
- Missing sample dates shift clock-out -> exactly one issue/report; no duplicate questions.
- A new sample dates timecard for any person -> sample dates issue remains asleep; **zero paid model calls** attributable to it.
- A different employee's sample dates clock-out -> original employee's sample dates issue remains asleep.
- The exact sample dates employee/shift's previously missing clock-out arrives -> only that incident is reconsidered; when deterministic evidence proves it is fixed, zero AI calls are necessary.
- Toast repeats the same exact record 20 times -> no repeated investigations or notifications.
- Owner never answers the sample dates question for weeks -> keep it visibly pending, with zero additional AI analysis; an optional reminder must not manufacture a new owner answer.
- Related source changes while owner approval is pending -> update the same incident with the relevant delta, never duplicate an approval question or treat a fresh timestamp as proof.
- Cross-midnight shifts and café-local dates, altered provider time-entry IDs, overlapping shifts and partial/open entries receive explicit identity and quality tests.
- Multi-day staffing/sales investigations can reopen only when facts inside their **declared comparison window** materially change, not when any day anywhere in the café changes.

**Existing reuse points:** `supervisor_investigations` (`stable_key`, `source_id`, `revision_hash`, `episode_id`, `evidence`, `pending_question_id`, `last_owner_answer_id`), `supervisor_enqueue_investigation`, `supervisor_claim_investigation`, `supervisor_finish_investigation`, `supervisor_fail_investigation`, and the existing source-change refresh scheduler. Determine how to represent dependency fingerprints and data-scoped wakeups with minimal schema change. Do **not** use `alerts.created_at`, Toast sync timestamps, daily cron ticks, or a global business version as a proxy for a relevant change.

### P0-2 — Supervisor fails to answer recorded clock-in/out and meal-break questions despite Toast data

**Sanitized reproduction:** Authorized owner asked for a prior week's actual clock-in/out, worked hours and documented lunch breaks. Canonical timecard records existed, but the original agent-turn path either failed before tools or returned aggregate labor summaries without individual timecard details. The new owner-scoped reader and tests use synthetic timecards. Unrecorded breaks are not proof that breaks did not occur.

**Problem classification:** Data exists at ingestion/canonical level; the conversational tool path and research configuration fail to retrieve and explain it. Diagnose the exact tool input/source-mapping failure before assuming Toast did not sync.

**Acceptance question:** For an authorized owner asking for the prior week's timecard details, return employee, local date, clock-in/out, hours and whether a qualifying *documented* break exists; explicitly distinguish no recorded break, partial/unreadable record, still-clocked-in and a confirmed compliance judgment. Cite source provenance and data freshness. Test with original owner queries, not only synthetic totals.

**References:** `lib/ai/agent/tools/staff.ts`, `lib/ai/supervisorReads.server.ts`, `lib/ai/agent/tools/dataQuery.ts`, `public.cv_labor_entries`, `u3_research.timecards`.

### P1-3 — U3 relational SQL search was shipped but is not activated in production

- PR [#547](https://github.com/killbill2792/aicafe/pull/547) merged and the governed `u3_research` schema/views exist.
- Production Vercel has **neither** `AICAFE_RESEARCH_SQL_ENABLED` nor `AICAFE_RESEARCH_DATABASE_URL`.
- `aicafe_research` DB role was observed with `rolcanlogin=false`. A dedicated least-privilege connection, credentials, scoped session policy and acceptance are prerequisites—not merely setting `SQL_ENABLED=true`.
- `query_data` intentionally falls back to a limited canonical-view mode if SQL is unavailable; some questions need authorized relational timecards/provenance that the legacy tool cannot answer.

**Architecture decisions:** Who provisions/rotates the research login? How are tenant UUID, owner/unattended mode, date window, SELECT-only relation catalog, RLS/security-barrier, timeouts, query row and cost limits enforced? What is the failure fallback and what gets logged without secrets?

**Acceptance:** Positive owner timecard query and off-turn aggregate query; cross-tenant denial; forbidden table/DDL denial; bounded time/rows and SQL injection resistance; missing source surfaces `unavailable` rather than fabricated zero.

### P1-4 — signup still has demo dependencies even though auto-grant was disabled

- Desired: **register -> create uniquely owned café UUID -> connect Toast -> import -> activate analysis**. No access to shared shared demo for new registrants; display name `My café` cannot be used for identity.
- The production trigger `on_auth_user_created_demo_access` and its function were removed in an earlier authorized migration; the related source changes were merged in PR #560; onboarding must remain separately tenant-safe.
- Existing shared demo memberships exist in historical records; `getActiveBusinessId.ts` still falls back to fixed `DEMO_BUSINESS_ID` when no memberships/real café. App onboarding is five-step and permits skipping Toast; `ensureOwnBusiness` creates a non-demo café on onboarding.
- shared demo demo contains synthetic sample data, and the user wants it removed from customer-facing production. Deleting demo data before replacing hardcoded fallback would break sign-in/onboarding paths.

**Architecture questions:** Where should a newly authenticated owner with no café land? What is the exact Toast-required state and allowed read-only/setup experience before Toast verification? How are existing demo memberships safely revoked without touching unrelated auth identities? Where should demo/test fixtures live?

**References:** `supabase/migrations/20260926000009_new_user_demo_access.sql`, `lib/data/getActiveBusinessId.ts`, `lib/actions/onboarding.ts`, `app/[locale]/onboarding/page.tsx`, `lib/auth/requireUser.ts`.

### P1-5 — Toast eligibility rollout and stale queues need closure; **do not duplicate PR #560**

- Verified Toast is the current admission rule for paid background investigation and derived refresh in the **production database**; disconnected/unlinked synthetic fixture cafés must not be automatically analyzed.
- The corresponding source migration and daily-brief application gate were merged in **PR #560** on November 23; verify it against this branch and the pending migration.
- Audit all unattended entry points, claim paths, fallbacks, delivery paths and current queued work. Enforce eligibility by business UUID + verified credential state, not café names; never silently hide a requested owner action.

**Acceptance:** Unconnected café retains access to Toast setup but receives no *paid automatic* business investigation, periodic derived research or morning brief; connected café proceeds; disconnect pauses new work; reconnect resumes only eligible new evidence; same-named cafés remain isolated.

### P2-6 — Automatic investigations and U4 Watch overlap in business purpose but are not the same mechanism

- **Automatic investigations:** react to an existing `alerts` or `operating_tasks` source; currently active.
- **U4 owner objectives:** owner explicitly schedules one-time/daily/weekly work; `SUPERVISOR_U4_ENABLED` absent/off in production, no saved routines.
- **U4 Watch:** unsolicited periodic review to discover potential concerns, distinct consent/cost; `SUPERVISOR_U4_WATCH_ENABLED` absent/off.
- **U4 push:** separate optional delivery; flag absent/off.
- Architecture must specify whether the same evidence may activate both an incident and a Watch report, how Watch reuses existing incident/evidence state, and how to avoid double-billing or duplicate owner notifications. **No U4/Watch activation now.**

**Reference:** `lib/ai/supervisor/routines/dispatch.server.ts`, `lib/ai/supervisor/routines/objective.server.ts`.

## D. Configuration and release controls (sanitized)

- The restricted research SQL account must remain NOLOGIN until verified non-BYPASSRLS read-only access and the server-only credential are provisioned. `AICAFE_RESEARCH_SQL_ENABLED` must stay off until isolation, query scope, and credential checks pass.
- Existing Toast setup and autonomous Supervisor flags must be audited in their own protected environment, not copied into the PR. No credential, production UUID, bearer token, account address or financial usage snapshot belongs here.
- Leave `SUPERVISOR_U4_ENABLED`, `SUPERVISOR_U4_WATCH_ENABLED` and `SUPERVISOR_U4_PUSH_ENABLED` off during the incident deduplication rollout.
- No feature flag should be used to bypass the incident lease/owner-answer/security tests. This PR does not deploy or activate production secrets.

## E. Architecture decisions still required (do not implement until explicitly approved)

1. **Incident identity / deduplication:** by source UUID + substantive evidence revision? incident episode versus daily alert? Same-source reopen policy; grouped owner questions across related timecards.
2. **Lifecycle:** clarify `new`, `collect`, `investigate`, `awaiting_owner`, `blocked`, `resolved`, `ignored`, `superseded`. Should owner no-answer or owner "ignore" be durable until genuine source change? Keep notifications separate from paid analysis.
3. **Retries:** transient provider failure versus `model_incomplete`, `storage_failed`, missing evidence, unanswered owner question, and explicitly ignored/resolved issues. Decide bounded attempts, stop/pause state, cooldown, and manual reopen.
4. **Source change:** What exactly counts as new information (Toast revision, previously absent data, owner response, new published schedule, revised recipe, new day)? Do not reset merely because cron ran or a timestamp changed.
5. **SQL research activation:** least-privilege login and ownership, row/time/cost/privacy budget, source catalog, timecard query semantics, read observability, rollout and rollback. Do not invent a second Supervisor tool architecture.
6. **Meal-break evidence:** documented break versus employee no-break attestation versus unverified assumption. Staff privacy and local timezone; no legal conclusion from empty `breaks`.
7. **Watch versus incidents:** whether Watch should consume or propose incidents, avoid duplicate analyses, owner consent, budgets and alert fatigue.
8. **Onboarding / demo decommission:** no shared demo grants or fallback, Toast-first owner journey, preserve unrelated auth identities; determine fixture strategy outside production.
9. **PR #560 interface:** agree acceptance of verified-Toast gate across cron/brief/queue; implement remaining policy separately only after architecture approved.

## F. Proposed acceptance scenarios for future approved implementation

- Same meal-break incident, owner question pending for 3+ days, source unchanged: **zero additional paid model calls**; original alert and pending question remain visible.
- A missing clock-out for a specific sample dates employee/shift is **not** woken by a sample dates clock-out or a different employee's sample dates entry; only a matching shift-level evidence change can wake it. Automatic resolution requires no paid model turn.
- Owner replies with an attributed answer: exactly one authorized wake on the **same incident**, no duplicate question; owner says ignore -> future retries stop unless explicit valid reopen condition.
- New verified Toast revision changes the original event: one bounded reconsideration; same data redelivered twice -> no repeat paid work.
- `model_incomplete` five times and no evidence change: state remains visible as blocked; **no six-hour paid loop indefinitely**. Genuine transient outage has bounded, observable recovery rules.
- Stale October daily-brief row cannot consume November paid incident analysis without explicit current-source justification.
- the verified fixture café owner asks for sample dates clock records: Supervisor reads source-backed closed entries, dates/hours and missing recorded break evidence; never says no breaks were actually taken.
- Two different café UUIDs share display name `My café`: owner only sees their own Toast records. Unverified Toast -> no automatic paid analysis.
- New signup: no shared demo membership and no demo fallback; Toast setup path works for a user with no connected POS; existing owners remain unaffected.
- SQL credential failure: clear "SQL research unavailable" rather than invented business answer. Attempted cross-tenant or non-SELECT SQL denied.
- With U4 Watch off, incident automation still operates; enabling U4 objectives alone **never** enables unsolicited Watch.
- Model usage accounting distinguishes attempts, model calls, issues, alerts, owners and estimated USD; retry reduction measured before/after without hiding unresolved issues.

## G. Implemented on PR #561 — verify the exact head before merge

- `supabase/migrations/20261123231500_supervisor_incident_change_gated_retries.sql`: use the existing incident identity and owner thread; pause an unanswered owner question durably; only a changed source-revision/linked answer can wake it; cap transient failures at three and block recurring paid attempts; exclude historical daily-brief tasks from the incident queue. **No new agent or cron.** The new trigger preserves PR #560's existing verified-Toast claim gate.
- `lib/ai/supervisor/routines/priority.ts`, `lib/alerts/generate.ts`: preserve source-specific change fingerprints; a different date/employee/shift or merely a new reporting date must not wake the existing incident. Corrected matching timecard evidence updates that exact alert; reopened source closure/authorization is explicitly distinguished from an unchanged owner's ignored issue.
- `lib/ai/supervisor/routines/investigation.server.ts`, `investigation.ts`: retain prior evidence, linked owner response and episode when relevant facts change; remove the 24-hour paid reanalysis loophole.
- `lib/ai/supervisorReads.server.ts` and `lib/ai/agent/tools/staff.ts`: expose bounded owner-scoped, timestamped actual labor punches, local dates, elapsed hours and precise break evidence without hallucinating an undocumented break as a proven compliance violation. Missing wages cannot suppress those real punches.
- `lib/ai/agent/tools/u3ResearchConnection.ts`, `u3SqlResearch.server.ts`: allow only the restricted aicafe_research role on the exact direct project or correctly scoped Supabase pooler, reject cross-project and privileged credentials.
- `lib/data/getActiveBusinessId.ts`, `getActiveCafeName.ts`, `app/[locale]/onboarding/page.tsx`, `components/onboarding/RegisterChoice.tsx`: remove the shared shared demo business fallback and replace the onboarding wizard with a direct private-café Toast connection path.
- Corresponding changed unit, database, and browser-mapping tests require a fresh exact-head CI run. The initial CI failures were diagnosed and are being resolved on this branch.

## H. Remaining release acceptance gates — not automatic

1. **GitHub:** exact-head TypeScript/ESLint, full Vitest, migration/DB security and recurrence tests, seeded Playwright, production build, prompts/evaluator acceptance and fresh clean Codex review. Do not merge with unresolved failures/findings.
2. **Migration order:** reconcile with and preserve PR #560's verified-Toast SQL gate; test new owner question wake and cross-tenant scope on a migrated disposable database. Apply approved migration to production only after safe merge and verification.
3. **Research activation:** the restricted research account currently starts with NOLOGIN. Provision its private login, verify non-BYPASSRLS owner isolation and SQL admission, then set `AICAFE_RESEARCH_DATABASE_URL` and `AICAFE_RESEARCH_SQL_ENABLED=true` as Vercel **server-only** production secrets. Until then governed SQL research is **not live**. Never use a Supabase admin password.
4. **Post-deploy owner acceptance:** repeat the actual sample dates the verified fixture café timecard questions and verify source-backed clock-in/out, duration, break evidence and timestamps; no fabricated lunch-break findings.
5. **Retry and spending evidence:** same open meal-break issue with no owner answer produces zero additional paid AI model attempts for multiple cron cycles/days; an unrelated Toast date or employee punch also produces zero. A matching late arrival causes one bounded event-specific reconsideration or deterministic resolution.
6. **Onboarding:** new user only sees their own café, never the shared shared demo dataset, and can connect Toast. Do not delete preexisting shared demo records/memberships until every real owner and backfill path is protected.
7. **U4 / Watch:** leave `SUPERVISOR_U4_ENABLED`, `SUPERVISOR_U4_WATCH_ENABLED`, and `SUPERVISOR_U4_PUSH_ENABLED` off. The automatic incident fix is independent from those flags.
8. **PR #560:** maintain its separate Toast eligibility and daily-brief changes; do not claim #561 completes an unmerged #560.
