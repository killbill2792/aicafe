# Olivia post-PR3 staging readiness and compatibility audit

Status: **NOT release-approved**. This document records code-inspection evidence and reproducible gates, not a claim of staging/production acceptance.

## Scope and starting baseline

- Repository: `killbill2792/aicafe`; baseline `main` at `248159c7c4df3c9fdc651f54d501b9b05c0dca0f` (2026-10-16).
- Prerequisite Olivia PR #85 was merged 2026-10-15. Tracking issue: #74.
- Olivia retains its existing owner flow: add staff → enter availability, qualifications, compensation and coverage → generate seven-day proposal → edit a new immutable revision → approve exact revision → publish → read official version → revise and republish.
- No shared attendance materializer, payroll/finance calculation, POS adapter, other specialist or Supervisor code is changed by this hardening work.
- Neighboring unmerged PRs #87 (different feature area) and #88 (CSV) should be rechecked for conflicts before merging this PR.

## Findings and protective behavior

1. **Fixed in Olivia transition validation:** `planPublication.server.ts` previously compared schema-parsed scenario break objects against raw JSONB break objects. PostgreSQL JSONB does not guarantee the original object-key ordering, so an otherwise identical shift with a break could be rejected as `invalid_shifts`. The saved assignment now passes through the same strict shift schema before the identity comparison. Added tests for reordered valid break keys and invalid break data.
2. **Existing legacy compatibility gate remains active:** `scheduling_pr3_publish` returns `legacy_conflict` if a proposed worker has an active legacy `staff_schedules` record effective during the publication week or immediately preceding overnight-spill day. This is deliberately conservative, even if times appear non-overlapping, because old recurring schedules feed predicted timecards. Added disposable SQL assertions that legacy data stays intact, fresh source tokens are required, the official pointer is not advanced, and an existing imported actual timecard remains unchanged.
3. **Publication is not attendance:** `scheduling_plan_assignments` and official pointers are separate from `timecards`. Proposed and published shifts must never be reported as actual worked hours, payroll expense, worker acceptance or a delivered notification.
4. **Owner authority:** scheduling RPCs must validate current authenticated owner membership, selected business, exact revision/source tokens and reviewed labor rules. SQL approval/publication endpoints are service-role-only; the direct authenticated draft RPC cannot publish. The disposable PR3 concurrency runner now exercises two real concurrent co-owner connections, distinct approval/publication keys, cross-week and cross-location rest conflicts, exactly-once audit, tenant RLS, timeout-equivalent response loss/retry and transactional rollback recovery. Actual network fault injection in a deployed browser remains unverified.
5. **Unknown wages and no POS:** a missing rate is unknown, never confirmed zero. The manually entered coverage and availability path is independent of POS; no sales-hour demand or implied cash-payroll facts may be invented.

## Olivia migration / feature-flag inventory

The Olivia migrations on the baseline main are applied in filename order in the disposable harness:

- `20261014000060_olivia_scheduling_foundation.sql`
- `20261014000061_olivia_availability_batch.sql`
- `20261014000062_olivia_coverage_concurrency.sql`
- `20261014000063_olivia_qualification_concurrency.sql`
- `20261015000064_olivia_plan_drafts.sql`
- `20261016000065_olivia_approval_publication.sql`
- `20261016000066_olivia_labor_rule_reviews.sql`
- `20261016000067_olivia_revision_limit.sql`

Keep these **disabled** in staging/production until a separate owner-approved release decision:

```env
SCHEDULING_FOUNDATION_ENABLED=false
SCHEDULING_AVAILABILITY_UI_ENABLED=false
SCHEDULING_PR3_DRAFTS_ENABLED=false
SCHEDULING_PR3_PUBLICATION_ENABLED=false
```

The explicit string `"true"` activates the corresponding gates. These values are desired rollout settings, **not** verification of an environment's currently configured values. No staging credentials or migration ledger were available for this review; the environment is **unverified**.

## Reproducible verification

Run against the **final PR HEAD**, not a prior merged commit:

```sh
npm ci
npx tsc --noEmit
npm run test
npx eslint "lib/scheduling/*.ts" "lib/calc/scheduling/*.ts" "components/staff/*.tsx"
npm run build
git diff --check origin/main...HEAD
```

For disposable Postgres, use the existing `Olivia PR 1B Availability UI Verification` GitHub Actions workflow: it replays all migrations locally and runs `scripts/olivia-pr1b-rls.sql`, which in turn executes `scripts/olivia-pr3-publication-rls.sql` using `\\ir`. This script tests service-only publication, different-key publication retry, published pointer/audit uniqueness, cross-week rest, historical-shift preservation, revision caps, legacy conflict and timecard non-mutation. The Olivia PR1B disposable workflow also executes `scripts/olivia-pr3-concurrency.py` with two independent co-owner sessions, cross-location/week conflicts, transaction rollback, tenant denial and imported actual-attendance preservation. Treat a skipped/failed workflow as **not verified**.

**Added automated acceptance:** true parallel approval/publish with different keys, atomic rollback and same-key recovery, cross-tenant negative access, cross-week/multi-location conflicts, imported actual-timecard non-mutation, EN/ES/AR message-key and ICU-placeholder parity, and SSR checks of local-time labels, touch-control classes and frozen shift-break controls. The existing pure optimizer suite covers a five-employee no-POS planning fixture, DST boundaries, qualifications/coverage, leave and wage provenance. **Still outstanding:** a connected five-employee owner workflow across UI and persisted database, real browser execution at ~360px/Arabic RTL/Spanish, actual staging migration ledger and environment flag inspection, provider/network fault injection, and broad salary/historical-financial baseline comparison. Automated tests are evidence for their exact assertions only; they do not confer owner acceptance.

## Owner-facing staging acceptance checklist

Use an **authorized test café and disposable staff identities**, not real payroll or production data:

- [ ] Confirm owner login and selected-café context; manager/employee and another-café actors cannot edit, approve, publish or read private revisions.
- [ ] Add five employees with different availability, verified skill types, min/max weekly and max daily hours, one missing wage, a confirmed leave date, and multiple locations.
- [ ] Add required opening, closing and qualified coverage; include a split and overnight shift, a boundary near a DST change, and an understaffed period. Use no POS connection.
- [ ] Generate a seven-day proposal. Confirm precise uncovered intervals/uncertainty; never invent assignments or call unknown wages zero.
- [ ] Edit/reassign/retime and manage breaks. A successful save must create a new revision; earlier approved/published assignments remain unchanged.
- [ ] Verify publication is unavailable before explicit owner approval and after stale staff, availability or rule edits.
- [ ] Approve the exact current version, publish it once and read the official version back; replay with a new request key and verify no duplicate pointer/audit entries.
- [ ] Edit and republish; verify started historical shifts remain byte-for-byte intact and future version supersession is accurate.
- [ ] Test an employee with an active legacy recurring schedule. Expect a plain-language publication block, no silent legacy replacement and unchanged predicted/actual timecards.
- [ ] Compare timecards, salary/payroll calculations and historical financial reports before/after. Planned schedule costs must not be treated as actual paid expenses; no worker contact or POS write.
- [ ] Repeat the owner journey in English, Spanish and Arabic RTL on desktop and ~360px mobile. Confirm keyboard focus, ~48px touch targets, local business date/time interpretation, warnings, loading/retry behavior and historical revision viewing.
- [ ] Record screenshots, anonymized query results, current test café ID, exact commit SHA and pass/fail per check. Never claim acceptance from code inspection alone.

## Staging-to-production hold points

1. **Owner approval first:** verify release branch and CI/reviews, migration order and complete ledger in staging **read-only** before authorizing any staging migration or feature activation.
2. Create a consistent backup/restore rehearsal and rollback plan with immutable schedule history retained; additive migrations are not automatically reversible by turning off flags. Never drop schedule/audit data as a quick rollback.
3. After separate permission, apply migrations to staging in order; validate RLS with separate owner, non-owner and cross-tenant identities; do not activate all flags simultaneously.
4. After separate permission, enable only the intended test café/tenant gates in staging and complete the manual acceptance checklist. Observe duplicate publications, legacy conflicts, source changes, and missing-input failures.
5. Require new approval for any production migration, flag activation or deployment. Emergency operational fallback is to **disable Olivia flags** while preserving persisted plan/audit history. A schema/data rollback requires a reviewed restoration plan.

## Open dependencies (not fixed by this PR)

- Safe coexistence with already-active `staff_schedules` cannot be guaranteed while shared legacy materialization treats those records as inputs for predicted timecards. Keep the publication block; a shared-system owner must design and authorize a non-duplicating bridge separately.
- A canonical owner-as-worker employee link is not proven; owner-time optimization must not assign a guessed worker identity.
- Actual staging migration ledger/credentials, production flag state, browser/mobile/RTL demonstrations and the full owner journey have **not** been verified here. Real database concurrency tests must pass on the final PR HEAD, but they do not replace staging acceptance.
- Labor-rule review records are owner attestations; the application does not certify jurisdiction-specific legal compliance.

**Merge and rollout remain separate human decisions.** This document does not authorize changes to deployment, production, Supervisor or the existing materializer.
