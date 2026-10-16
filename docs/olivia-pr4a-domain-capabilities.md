# Olivia PR4A — Typed Domain Capability Foundation (read/preview only)

**Tracking:** [#74](https://github.com/killbill2792/aicafe/issues/74)
**Scope:** Olivia-owned contracts and a server-side adapter, independent of Universal Supervisor.
**Baseline:** `main` at `248159c7c4df3c9fdc651f54d501b9b05c0dca0f`. PR #89 is **open, separate, and unmerged**; nothing here depends on its commits.
**Release status:** Not deployed, registered, enabled, or connected to Supervisor. No database migrations, feature flags, or live tenant data were changed.

## Capabilities and schemas

All requests use strict Zod input validation, literal `version: 1`, and reject unknown fields such as `businessId`, client-supplied employee records, costs, wages or SQL. Call `executeOliviaReadCapability(raw: unknown)` **only from an authenticated trusted server integration**. PR4A deliberately adds no endpoint, model tool, registry entry, or UI integration.

| Capability | Accepted fields | Trusted result | Semantics |
| --- | --- | --- | --- |
| `olivia.availability.read` | `version: 1`; optional `employeeId: UUID` | owner-café roster ID/name/active, source-confirmed recurring rules, date exceptions including approved leave/unavailable, hour limits, preference windows, qualifications, compensation provenance | Per-worker `state: confirmed / unconfirmed / missing` summarizes available evidence, **not availability for every date**. Confirmed exceptions marked `unavailable`/leave remain explicit; they never create positive availability. Missing wages are not verified zero. |
| `olivia.schedule.preview` | `version: 1`, `week: Monday YYYY-MM-DD`; optional `options.objective` (cash, owner_time, balanced), `expectedRevision` (0–500), `expectedSourceDigest` (SHA-256 hex) | PR2 `PlannerResult` with all scenarios, optional selected objective, assignments, exact UTC uncovered intervals, cost states/cents, owner minutes, warnings, blockers, source digest and preview head | **Proposal only**, no draft saved and no publication. Existing PR3 trusted inputs cap solver resources (`maxNodes: 12000`, `beamWidth: 24`). This contract does **not** accept arbitrary solver budgets, staffing or hourly sales. Manual owner-entered coverage works without POS. |
| `olivia.schedule.history.read` | `version: 1`, `week` | immutable revision listing (draft/approved/published/superseded), current head and official published revision pointer | No revision inferred from draft status. A published pointer must resolve to a published record. |
| `olivia.schedule.revision.read` | `version: 1`, `week`, `revisionId: UUID` | existing version/\`revisionStatus\`, source digest and validated persisted assignments matched against the stored scenario, plus head/published pointers | Read-only; reject malformed, missing, or mismatching persisted shifts. Draft is not approved; approved is not published. |

**Response contract:** `ok: true, version: 1, status: "ok", capability, source, …` or `ok: false, version: 1, status: "error", capability, error: { code, retryable, message }`. Source metadata identifies the authenticated café and labels a multi-query source/preview `provisional`. All successful responses are parsed against strict output schemas. Safe errors are bounded and contain no SQL/provider details.

**Resource limits:** 500 people per availability read, 5,000 entries per record class, 500 revisions, 200 shifts per persisted revision; excess/partial source data fail rather than being silently truncated. The underlying PR1 complete foundation reader also has its own pagination and consistency limits. Version increments require a new reviewed contract, not a silent shape change.

## Existing domain services reused

- PR1A/PR1B: `requireSchedulingOwner`, `readSchedulingFoundation`, `foundationRecordSchemas` and canonical wage-provenance sanitation. This adapter does not write availability.
- PR2: `optimizeOliviaWeek`, called **through** the existing PR3 trusted `previewOliviaWeek` service. No duplicate optimizer, cost calculator, DST math or coverage logic.
- PR3: `previewOliviaWeek`, `readOliviaPlanHistory` and `readOliviaPlanRevision`. The underlying source loader `loadOliviaWeekFromSavedStaff` owns scoped employee/coverage/constraint validation, qualified workers, published commitments and the trusted source fingerprint/token. The adapter additionally checks persisted assignment evidence on revision reads.
- PR3 existing owner-only edit/transition services `saveOliviaEditedDraft` and `transitionOliviaPlan` are **not called/imported by the executor**. Their optimistic revision/source/owner checks remain authoritative for later integration.

## Authorization, provenance and failure policy

1. Owner identity and selected café are resolved using the existing trusted server membership boundary, not model/client values. Manager, employee, demo, foreign tenant and forged-employee access must fail closed. The adapter rechecks owner/café context across async domain reads to avoid a mid-request café switch.
2. All employee lookups and revision-assignment reads are restricted by trusted `business_id`. Unknown IDs return `not_found` without revealing whether another café has that employee or revision.
3. Raw stored source rows are projected through the Olivia field schemas. Confirmation flags are never promoted; confirmed negative leave remains negative evidence. A worker whose only stored availability is unconfirmed is not automatically eligible.
4. Preview never writes. Do not equate `unknown` cash costs with `0`; the optimizer already models missing qualifications, split/overnight/DST, cross-location overlap, protected published shifts and exact gaps. It does not invent POS data, labor rules or owner-worker identity.
5. Preview digest and revision options can detect stale client state. PR3 publication still **independently reloads sources, validates the legal profile and assignments and enforces transactional CAS/source tokens**. A PR4A preview is *not* an authority to publish.
6. Malformed domain responses, inconsistent DB revisions, partial reads, missing providers and exceptions fail with stable error codes. No client- or AI-generated sentence is accepted as evidence an owner action occurred.

## Future owner-action intents — not executable

`futureOliviaOwnerIntentSchemas` declares **edit**, **approve** and **publish** payload shapes for a later review. These are **not** part of `oliviaReadRequestSchema`; the PR4A executor rejects them. In PR4B, only explicitly authenticated owner-confirmed actions may call the existing `saveOliviaEditedDraft` / `transitionOliviaPlan` boundaries with canonical reloaded source, revision CAS, legal checks, idempotency and persisted read-back. No LLM response, generalized capability caller or manager/employee may approve/publish. There is no new publication pathway, external worker messaging, payroll write, or acceptance signal.

## Verification

Run from this branch with repository dependencies installed:

```bash
npx tsc --noEmit
npm run test
npx eslint lib/scheduling/oliviaCapabilityContracts.ts lib/scheduling/oliviaCapabilities.server.ts lib/scheduling/oliviaCapabilities.server.test.ts
npm run build
git diff --check origin/main...HEAD
```

**Existing domain regression coverage:** `lib/calc/scheduling/plannerEngine.test.ts`, `plannerValidate.test.ts`, `availability.test.ts`, and PR3 planner/input/draft/publication tests cover the five-worker manual/no-POS case, qualification/cost uncertainty, confirmed leave, multi-location collisions, overnight/DST, source/revision conflicts and unmodified payroll/timecard protection. PR4A adapter tests additionally cover strict payloads, owner/café boundary changes, unsafe provider responses, missing vs unconfirmed vs confirmed, official revision pointers, and assignment read-back matching.

**CI results (2026-10-16, code HEAD `d6f904e998cc5334e695c80a074c8e7b255236f6`):** [AI CAFE Pull Request Baseline](https://github.com/killbill2792/aicafe/actions/runs/38920410049) **success** (strict TypeScript, 164 Vitest files / **1,196 passing tests**, changed-code lint, production build, Git diff whitespace); [Olivia PR 1B Availability UI Verification](https://github.com/killbill2792/aicafe/actions/runs/38920410219) **success** (full Vitest, typecheck, scoped scheduling lint/build/whitespace, and disposable Supabase migration, RLS, SQL and concurrent-owner tests). These checks ran in **GitHub Actions**, not locally or in a staging/production café. Passing CI does not constitute authenticated staging validation, human owner acceptance, or approval to deploy. The documentation-only final commit will be checked separately by CI; it does not change the tested Olivia executable code.

## Explicit PR4B dependencies / known limits

- Separately approved Supervisor typed domain registry/tool integration with central owner policy and bounded request processing. **No Supervisor files may be changed here.**
- Owner confirmation and restricted execution wiring for PR3 **existing** edit, approve, publish; source/revision/BusinessContext conflict binding and persisted result acknowledgement, rechecked under the authoritative PR3 transaction.
- Optional model-facing natural-language resolution of week, employee and location ambiguity with hard authorization checks; no guessed identities or assumed leave confirmation.
- More granular date-specific availability summaries and localized presentation remain future integration work; this foundation reports stored records and evidence, not a universal per-day calendar oracle.
- Independently reviewed staging migration/flag gate, human browser tests and complete release acceptance remain separate from PR4A, as tracked in #74 and PR #89. **PR4A does not cherry-pick #89 or modify it.**

**Explicit exclusions:** `lib/ai/conversations/**`, Supervisor prompts/tools/routing/registry/UI/endpoints, Alex/Maya/Leo, `lib/data/materializeSchedule.ts`, legacy payroll/attendance, finance/profit, Toast/Square/CSV, deployment config, feature flags, and database migrations.
