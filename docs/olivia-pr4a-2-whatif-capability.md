# Olivia PR4A-2 — What-if simulation capability (read/simulate only)

**Tracking:** [#74](https://github.com/killbill2792/aicafe/issues/74)
**Scope:** one additive Olivia-owned capability, `olivia.schedule.whatIf`, layered on the
already-merged PR4A adapter (`lib/scheduling/oliviaCapabilities.server.ts`,
`lib/scheduling/oliviaCapabilityContracts.ts`). Independent of the Universal Supervisor;
no central registry, prompt, routing or UI file is touched.
**Baseline:** latest `main` after PR #94 (Supervisor P3 authoritative integration).
**Release status:** not registered, activated, or connected to Supervisor. No migration,
flag or production change. This PR is pure addition to Olivia-owned files.

## Why this exists

The merged PR4A adapter already exposes `olivia.availability.read`, `olivia.schedule.preview`,
`olivia.schedule.history.read` and `olivia.schedule.revision.read` — all read-only, all bound to
the actual recorded/saved snapshot. None of them can answer a conversational follow-up like:

> "What if I don't work Monday mornings and Sarah works fewer hours? Show the coverage and
> cost difference."

That requires running the PR2 pure optimizer against a **temporary, non-persisted** variant of
the trusted snapshot, while proving the variant can never claim more availability or hours than
what the owner actually confirmed. `olivia.schedule.whatIf` adds exactly that, as a fifth
capability on the same `executeOliviaReadCapability(raw)` entrypoint Kill Bill 1 already calls
for the other four.

## New capability contract (version 1)

Request (`lib/scheduling/oliviaCapabilityContracts.ts`):

```ts
{
  capability: "olivia.schedule.whatIf", version: 1,
  week: "YYYY-MM-DD" /* Monday */,
  overrides: OliviaWhatIfOverride[], // 1..20
  options?: { objective?: "cash"|"owner_time"|"balanced"; expectedSourceDigest?: string },
}
```

`OliviaWhatIfOverride` is a strict discriminated union (`lib/calc/scheduling/oliviaWhatIfOverlay.ts`,
mirrored 1:1 by `oliviaWhatIfOverrideSchema`):

| kind | fields | effect |
| --- | --- | --- |
| `temporary_unavailable` | `employeeId`, `localDate`, optional `window: {startLocal, endLocal, overnight}` | Adds an in-memory `unavailable` exception for that date/window (or the whole day). Pure subtraction. |
| `reduce_weekly_minutes` | `employeeId`, `maxWeeklyMinutes` | Combines with any existing weekly cap by **minimum** — can only lower it. Rejected with `invalid_input` if the result would fall below the employee's recorded `minWeeklyMinutes`. |
| `reduce_daily_minutes` | `employeeId`, `localDate`, `maxMinutes` | Adds an in-memory `hours_cap` exception for that date; combined with any existing same-date cap by the planner's own `Math.min(...)` aggregation. |

**Every override kind can only subtract availability or lower a cap — never grant more hours or
invent a positive window.** This is enforced structurally (see "Safety argument" below), not by
convention.

Response (`oliviaWhatIfResponseSchema`): `ok:true` carries `baselineScenario`,
`alternateScenario` (both reuse the existing `oliviaScenarioSchema` — same shape as
`olivia.schedule.preview`'s scenarios), a `comparison` block, `overridesApplied` (echo of the
validated input), `notices`, `employeeNames`, `locationNames`, and
`disposition: "hypothetical_simulation_only"`.

```ts
comparison: {
  ownerMinutesDifference: number;
  cashWagesDifferenceCents: number | null;
  loadedPayrollDifferenceCents: number | null;
  gapsDifference: number;
  completeCoverageBefore: boolean;
  completeCoverageAfter: boolean;
  changed: boolean; // computed from actual shift/gap diff, never from the override list
} | null
```

`changed` is the field Kill Bill 1's reply-composer must check before telling the owner anything
was affected: it is computed by diffing the baseline and alternate scenarios' actual `shifts` and
`gaps`, so a structurally-applied override with zero real effect (e.g. "Ben is unavailable on a
day he was never scheduled anyway") reports `changed:false` and must be described to the owner as
having no effect — never as "applied."

Errors reuse the **existing** error taxonomy only (no new error code was introduced):
`invalid_input`, `unauthorized`, `disabled`, `not_found` (unknown/unresolved `employeeId`),
`missing_inputs` (+ `blockers`, same shape as preview), `source_changed`, `invalid_record`,
`storage_unavailable`, `planner_unavailable`, `capacity_exceeded`.

## How it's wired

- `lib/calc/scheduling/oliviaWhatIfOverlay.ts` (new, pure, no I/O, no zod): `applyOliviaWhatIfOverlay`
  and `compareOliviaScenarios`. Collocated Vitest coverage in
  `oliviaWhatIfOverlay.test.ts` (13 tests), including two full `optimizeOliviaWeek` runs proving a
  real coverage/cost delta and a real infeasibility, and one proving a no-op override reports
  `changed:false`.
- `lib/scheduling/oliviaCapabilityContracts.ts`: additive discriminated-union member + new
  response/comparison schemas. Every existing capability's shape is untouched.
- `lib/scheduling/oliviaCapabilities.server.ts`: new `readWhatIf()` function, reusing the exact
  same `requireSchedulingOwner` / `loadOliviaWeekFromSavedStaff` / `optimizeOliviaWeek` /
  `isCanonicalOliviaWeekResult` / `oliviaOverflowPlanSchema` building blocks `readPreview` already
  uses, plus a new switch case in `executeOliviaReadCapability`. **No DB write call of any kind is
  imported into this file.**
- `lib/scheduling/oliviaWhatIf.server.test.ts` (new, 13 tests): mocks only
  `requireSchedulingOwner` and `loadOliviaWeekFromSavedStaff` — the PR2 optimizer runs for real,
  so the happy-path test is evidence of an actual re-optimization, not a mocked result.

## Safety argument (why this can't fabricate availability)

1. Every `employeeId` in `overrides` is checked against the roster `loadOliviaWeekFromSavedStaff`
   actually resolved for the authenticated owner's café **before** the overlay or optimizer run.
   An unknown, cross-tenant, or model-invented ID fails `not_found` and never reaches the planner.
2. `temporary_unavailable` only ever appends an `AvailabilityException` of type `unavailable`.
   `effectiveAvailabilityForDate` (`lib/calc/scheduling/availability.ts`) only ever *subtracts*
   `unavailable` windows from positive recorded windows — it has no code path that treats an
   `unavailable` exception as a grant.
3. `reduce_weekly_minutes` and `reduce_daily_minutes` both combine with any existing recorded cap
   by `Math.min(...)` (the weekly one explicitly in the overlay function; the daily one
   automatically, because `plannerEngine.ts`/`availability.ts` already take the min across every
   `hours_cap` exception for a date, recorded or hypothetical). Neither path can produce a higher
   effective cap than what was already recorded.
4. `reduce_weekly_minutes` additionally refuses (`invalid_input`) to go below the employee's
   recorded `minWeeklyMinutes`, instead of silently handing an inconsistent snapshot to the
   optimizer's own `assert(e.minWeeklyMinutes<=e.maxWeeklyMinutes)` invariant.
5. The overlay never touches `coverage`, `locations`, `pinned`, `startedPublishedShifts`,
   `historicalShiftWageRates`, `ruleProfile`, or any other field of the trusted `PlannerInput` —
   only the targeted employees' `exceptions`/`maxWeeklyMinutes`, and only additively/downward.
6. The pure overlay function never mutates its input (verified by a dedicated test comparing a
   `JSON.stringify` snapshot of the original input before/after).
7. Both the baseline and the alternate `PlannerResult` are independently validated with the exact
   same `oliviaOverflowPlanSchema` + `isCanonicalOliviaWeekResult` + oversize checks that
   `olivia.schedule.preview` already uses, so a malformed or oversized optimizer output fails
   closed the same way for both runs.
8. The alternate scenario's digest is **never** compared to or substituted for a real
   `olivia.schedule.preview` `sourceDigest`. `expectedSourceDigest` here is checked against the
   real trusted snapshot (via the existing `oliviaSnapshotDigest`) only to catch mid-conversation
   staleness — it never certifies the hypothetical result as persistable.

## Integration guidance for Kill Bill 1

This capability plugs into the central typed registry exactly like the other four Olivia
capabilities (none of which are wired yet either). Suggested registration shape, matching
`lib/ai/supervisor/p2/registry.ts`'s `SimulateRegistration`:

```ts
{
  id: "olivia.schedule.whatif.v1", version: 1, mode: "simulate", availability: "shadow",
  owner: "olivia",
  purpose: "Compare a baseline seven-day schedule against an owner hypothetical (temporary unavailability or reduced hours) using the same deterministic optimizer, with no write.",
  sourceIds: ["olivia.schedule"], canonicalReaderIds: ["olivia.schedule.whatIf"],
  allowedPurposes: ["scheduling_whatif"],
  inputSchema: oliviaWhatIfRequestSchema /* the discriminated-union member above, extracted */,
  outputSchema: oliviaWhatIfResponseSchema,
  requiredRole: "owner", sensitivity: "staff",
  budgets: { maxOperations: 1, timeoutMs: 10000, maxResultBytes: 100000, maxInputBytes: 10000, maxRangeDays: 7 },
  requiresApproval: false, effectPolicy: "deny",
  async simulate(scope, input) {
    return executeOliviaReadCapability({ capability: "olivia.schedule.whatIf", version: 1, ...input });
  },
}
```

Suggested conversation flow for the model:
1. Model calls `olivia.availability.read` (existing) to resolve "Sarah"/"I" to an exact
   `employeeId`, exactly as it must already do for other follow-ups. Ambiguous/unknown names are
   the model's job to clarify — this capability only accepts resolved UUIDs.
2. Model calls `olivia.schedule.preview` (existing) to get the baseline, optionally capturing its
   `sourceDigest`.
3. On a hypothetical follow-up, model calls `olivia.schedule.whatIf` with that same `week`,
   the resolved `employeeId`s, and (optionally) the captured `expectedSourceDigest`.
4. The model must read `comparison.changed` before composing its reply. If `false`, the correct
   owner-facing sentence is "that change wouldn't affect next week's schedule or cost" — never
   "I applied that change."
5. If `alternateScenario` is `null` (requested `options.objective` had no feasible scenario) or
   `alternatePlan` status is `infeasible`, the reply must state the specific uncovered gaps from
   `alternateScenario?.gaps` / the comparison deltas — never claim a schedule was produced.

## Verification run

```
npx tsc --noEmit                 # clean (one unrelated pre-existing xlsx CDN resolution note, see below)
npx vitest run                   # 179 files / 1393 passed, 1 skipped — zero regressions
npx eslint <changed files>       # clean
npm run build                    # clean production build
git diff --check                 # clean
```

**Environment note:** this sandbox's network policy blocks `cdn.sheetjs.com`, the registry
`xlsx` is pinned to in `package.json` (unrelated pre-existing dependency used only by bank
statement CSV/XLSX upload, nowhere near scheduling). `npm ci` therefore cannot complete here.
Verification above ran after installing all other dependencies and substituting a local,
uncommitted stub for `xlsx` purely to exercise `tsc`/`npm run build`; `package.json` and
`package-lock.json` are unchanged in this PR's diff, and a real CI runner with normal network
access resolves the real package. This does not affect any file in Olivia's scope.

## Explicit exclusions (unchanged from PR4A)

`lib/ai/conversations/**`, Supervisor prompts/tools/routing/registry/UI/endpoints, Alex/Maya/Leo,
`lib/data/materializeSchedule.ts`, legacy payroll/attendance, finance/profit, Toast/Square/CSV,
deployment config, feature flags, database migrations, PR #89. No write capability of any kind is
added, exported, or made reachable. `saveOliviaEditedDraft`, `transitionOliviaPlan`,
`createOliviaScheduleDraftCommand`, `commitOliviaConfirmedAvailability` are not imported by this
file and are unaffected.
