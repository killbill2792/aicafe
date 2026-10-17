import "server-only";
import { z } from "zod";
import { executeOliviaReadCapability } from "./oliviaCapabilities.server";
import { matchesOwnerScheduleDates } from "./whatIfOwnerDates";
import { isWholeNamedEntity } from "@/lib/ai/supervisor/p3/entityMatch";
import { oliviaWeek, type OliviaWhatIfOverrideInput } from "./oliviaCapabilityContracts";
import { schemaFingerprint, type ReadRegistration, type TrustedReadScope } from
  "@/lib/ai/supervisor/p2/registry";

/**
 * Exposes Olivia's existing, independently reviewed `olivia.schedule.preview`
 * read capability (merged PR2/PR4A) to the P3 dynamic registry, so an
 * open-ended Supervisor question can discover and read it the same way it
 * already discovers P1 financial sources. This file adds NO new scheduling
 * math: every number below is copied unchanged from the real optimizer's own
 * output. Write/publish/approve capabilities are never reachable from here.
 */
export const OLIVIA_P3_SCHEDULE_PREVIEW_ID = "p3.olivia.schedule.preview.v1" as const;

const inputSchema = z.strictObject({
  purpose: z.literal("schedule_preview"),
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const previewRow = z.strictObject({
  name: z.string().min(1).max(160),
  loadedLaborCostCents: z.number().int().safe().min(0).max(100_000_000),
  shiftCount: z.number().int().min(0).max(500),
});
const provenanceSchema = z.strictObject({
  sourceId: z.literal("olivia.schedule_foundation"),
  canonicalReaderId: z.literal("olivia.schedule.preview"),
  sourceRevision: z.null(),
  purpose: z.literal("schedule_preview"),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const qualitySchema = z.strictObject({
  missingInputs: z.array(z.string().max(80)).max(50),
  estimatedInputs: z.array(z.string().max(80)).max(50),
  staleInputs: z.array(z.string().max(80)).max(50),
});
export const oliviaP3PreviewOutputSchema = z.union([
  z.strictObject({ status: z.literal("unavailable"), value: z.null(), reason: z.string().min(1).max(100) }),
  z.strictObject({
    status: z.enum(["verified", "partial"]), id: z.literal("olivia.schedule.preview"),
    value: z.array(previewRow).max(1), provenance: provenanceSchema, quality: qualitySchema,
  }),
]);

/**
 * Olivia's "what if a worker is out / has fewer hours" simulation, exposed to
 * the P3 dynamic registry the same way as Alex's pricing what-if. Reuses the
 * existing, independently reviewed `olivia.schedule.whatIf` read capability
 * directly (PR4A-2) -- this file adds NO new scheduling math.
 *
 * `olivia.schedule.whatIf` identifies every override by the worker's internal
 * employeeId (a UUID resolved earlier from the trusted roster). An owner's
 * turn can only name a worker by their display name, and P3's one-shot
 * capability selection has no prior-read step to resolve a name to an id
 * first (the same limitation documented for Alex's ingredient-substitution
 * exclusion above). Rather than leaving this unreachable the way Alex's
 * ingredient-change scenario was deliberately left out, this capability
 * resolves each name to the trusted roster itself, inside `read()`, using
 * the EXISTING `olivia.schedule.foundation`-backed `olivia.availability.read`
 * capability -- never a model-supplied or guessed id.
 */
export const OLIVIA_P3_WHATIF_ID = "p3.olivia.schedule.what_if.v1" as const;
const OLIVIA_P3_MAX_WHAT_IF_OVERRIDES = 5;
const wallTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const whatIfDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const employeeName = z.string().trim().min(1).max(240);
const whatIfOverrideInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("temporary_unavailable"), employeeName,
    localDate: whatIfDate,
    window: z.strictObject({
      startLocal: wallTime, endLocal: wallTime, overnight: z.boolean(),
    }).refine(w => w.startLocal !== w.endLocal && w.overnight === (w.endLocal < w.startLocal),
      "Window overnight flag must match the start/end ordering").optional(),
  }),
  z.strictObject({
    kind: z.literal("reduce_weekly_minutes"), employeeName,
    maxWeeklyMinutes: z.number().int().min(0).max(10080),
  }),
  z.strictObject({
    kind: z.literal("reduce_daily_minutes"), employeeName,
    localDate: whatIfDate, maxMinutes: z.number().int().min(0).max(1440),
  }),
]);
const whatIfInputSchema = z.strictObject({
  purpose: z.literal("schedule_what_if"),
  week: oliviaWeek,
  overrides: z.array(whatIfOverrideInputSchema).min(1).max(OLIVIA_P3_MAX_WHAT_IF_OVERRIDES),
  objective: z.enum(["cash", "owner_time", "balanced"]).optional(),
});
const signedCents = z.number().int().min(-100_000_000).max(100_000_000).nullable();
// Structured, not a pre-assembled English sentence: the presentation layer (which already
// knows the owner's locale) renders each line through the EN/ES/AR catalogs. Building the
// sentence here baked raw English ("unavailable", "all day", "capped at") into every
// locale. Caught in review (PR #108, round 4).
const overrideSummaryItem = z.strictObject({
  kind: z.enum(["temporary_unavailable", "reduce_weekly_minutes", "reduce_daily_minutes"]),
  employeeName: z.string().min(1).max(240),
  localDate: whatIfDate.nullable(),
  startLocal: wallTime.nullable(), endLocal: wallTime.nullable(),
  maxWeeklyMinutes: z.number().int().min(0).max(10080).nullable(),
  maxMinutes: z.number().int().min(0).max(1440).nullable(),
});
const whatIfRow = z.strictObject({
  name: z.string().min(1).max(160),
  // One structured entry per override (worker, date/window or minute cap -- whichever the
  // override kind actually carries) built directly from the SAME validated input the
  // simulation ran on, not re-derived or guessed. Lets the owner catch capability selection
  // emitting a valid-but-wrong parameter (e.g. 240 minutes instead of 120, the wrong day,
  // the wrong window) the same way the date/name echo already lets them catch a wrong day
  // or wrong worker. Caught in review (PR #108, round 3).
  overridesSummary: z.array(overrideSummaryItem).min(1).max(OLIVIA_P3_MAX_WHAT_IF_OVERRIDES),
  objective: z.enum(["cash", "owner_time", "balanced"]).nullable(),
  alternateStatus: z.enum(["feasible", "infeasible", "unproven"]),
  changed: z.boolean().nullable(),
  completeCoverageAfter: z.boolean().nullable(),
  gapsDifference: z.number().int().nullable(),
  loadedPayrollDifferenceCents: signedCents,
  ownerMinutesDifference: z.number().int().nullable(),
  cashWagesDifferenceCents: signedCents,
  salaryAllocationIncluded: z.boolean(),
  laborCostEstimated: z.boolean(),
  // The planner's own legalReview/warnings/notices are real caveats on an
  // otherwise-clean-looking "feasible" result (e.g. break/labor-law
  // compliance was never independently reviewed) -- always publishing empty
  // quality arrays here silently dropped them. Caught in review (PR #108).
  legalReviewUnverified: z.boolean(),
  hasAdditionalCaveats: z.boolean(),
});
const whatIfProvenanceSchema = z.strictObject({
  sourceId: z.literal("olivia.schedule_foundation"),
  canonicalReaderId: z.literal("olivia.schedule.whatIf"),
  sourceRevision: z.null(),
  purpose: z.literal("schedule_what_if"),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const whatIfQualitySchema = z.strictObject({
  missingInputs: z.array(z.string().max(80)).max(50),
  estimatedInputs: z.array(z.string().max(80)).max(50),
  staleInputs: z.array(z.string().max(80)).max(50),
});
export const oliviaP3WhatIfOutputSchema = z.union([
  z.strictObject({ status: z.literal("unavailable"), value: z.null(), reason: z.string().min(1).max(100) }),
  z.strictObject({
    status: z.literal("partial"), id: z.literal("olivia.schedule.what_if"),
    value: z.array(whatIfRow).length(1), provenance: whatIfProvenanceSchema, quality: whatIfQualitySchema,
  }),
]);
/** Resolves every requested worker name against the trusted roster for the active
 * café. A name that matches no one, or more than one active worker, is reported
 * unavailable rather than guessing -- an owner-named worker is never confused
 * with another by a case/whitespace difference alone, and never silently
 * resolved to the wrong one of two same-named staff. */
async function resolveEmployeeNames(
  overrides: readonly z.output<typeof whatIfOverrideInputSchema>[],
  businessId: string,
): Promise<
  { ok: true; overrides: OliviaWhatIfOverrideInput[]; requestedNames: ReadonlyMap<string, string> } |
  { ok: false; reason: string }
> {
  const roster = await executeOliviaReadCapability({ capability: "olivia.availability.read", version: 1 });
  if (!roster.ok || roster.capability !== "olivia.availability.read")
    return { ok: false, reason: !roster.ok ? roster.error.code : "unexpected_capability" };
  if (roster.source.businessId !== businessId)
    return { ok: false, reason: "unauthorized" };
  const byName = new Map<string, string[]>();
  for (const employee of roster.employees) {
    if (!employee.active) continue;
    const key = employee.displayName.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), employee.employeeId]);
  }
  const resolved: OliviaWhatIfOverrideInput[] = [];
  // Binds each resolved id back to the exact name the owner's turn asked for, so the
  // caller can re-verify identity against the LATER whatIf read's own authoritative
  // employeeNames -- a roster read and the simulation it feeds are two separate trusted
  // reads, and a rename landing between them must never silently answer about the wrong
  // worker under the name the owner actually asked about. Caught in review (PR #108).
  const requestedNames = new Map<string, string>();
  for (const override of overrides) {
    const ids = byName.get(override.employeeName.trim().toLowerCase());
    if (!ids || ids.length === 0) return { ok: false, reason: "employee_not_found" };
    if (ids.length > 1) return { ok: false, reason: "ambiguous_employee_name" };
    const employeeId = ids[0];
    requestedNames.set(employeeId, override.employeeName.trim());
    switch (override.kind) {
      case "temporary_unavailable":
        resolved.push({
          kind: "temporary_unavailable", employeeId, localDate: override.localDate,
          ...(override.window ? { window: override.window } : {}),
        });
        break;
      case "reduce_weekly_minutes":
        resolved.push({
          kind: "reduce_weekly_minutes", employeeId, maxWeeklyMinutes: override.maxWeeklyMinutes,
        });
        break;
      case "reduce_daily_minutes":
        resolved.push({
          kind: "reduce_daily_minutes", employeeId, localDate: override.localDate,
          maxMinutes: override.maxMinutes,
        });
        break;
    }
  }
  return { ok: true, overrides: resolved, requestedNames };
}

/** Domains array entry for `createP3ReadRegistry`. Read-only/simulate; never writes
 * availability, a draft, an approval or a publication. */
export function buildOliviaP3Registrations(): readonly [ReadRegistration, ReadRegistration] {
  return [{
    id: OLIVIA_P3_SCHEDULE_PREVIEW_ID, version: 1 as const, owner: "olivia",
    mode: "read" as const, availability: "shadow" as const,
    purpose: "Read-only summary (loaded weekly labor cost, planned shift count) of a feasible " +
      "seven-day schedule preview from the existing reviewed Olivia optimizer. Never writes, " +
      "approves, publishes or contacts a worker.",
    sourceIds: ["olivia.schedule_foundation"],
    canonicalReaderIds: ["olivia.schedule.preview"],
    allowedPurposes: ["schedule_preview"],
    inputSchema, outputSchema: oliviaP3PreviewOutputSchema,
    schemaContract: {
      id: OLIVIA_P3_SCHEDULE_PREVIEW_ID + ".v1", registrationId: OLIVIA_P3_SCHEDULE_PREVIEW_ID,
      version: 1 as const,
      inputSchemaFingerprint: schemaFingerprint(inputSchema),
      outputSchemaFingerprint: schemaFingerprint(oliviaP3PreviewOutputSchema),
    },
    requiredRole: "owner" as const, sensitivity: "staff" as const,
    budgets: { maxOperations: 1, timeoutMs: 10000, maxResultBytes: 20000, maxInputBytes: 2000, maxRangeDays: 7 },
    requiresApproval: false as const, effectPolicy: "deny" as const,
    async read(scope: TrustedReadScope, rawInput: unknown) {
      const input = rawInput as z.output<typeof inputSchema>;
      const response = await executeOliviaReadCapability({
        capability: "olivia.schedule.preview", version: 1, week: input.week,
      });
      if (!response.ok || response.capability !== "olivia.schedule.preview")
        return { status: "unavailable" as const, value: null,
          reason: !response.ok ? response.error.code : "unexpected_capability" };
      if (response.source.businessId !== scope.businessId)
        return { status: "unavailable" as const, value: null, reason: "unauthorized" };
      const { plan, selectedScenario } = response;
      if (plan.status !== "feasible" || !selectedScenario || selectedScenario.cost.loadedPayrollCents === null)
        return { status: "unavailable" as const, value: null,
          reason: plan.status !== "feasible" ? "no_feasible_schedule" : "wage_data_incomplete" };
      return {
        status: "partial" as const, id: "olivia.schedule.preview" as const,
        value: [{
          name: plan.horizonStart + " – " + plan.horizonEnd,
          loadedLaborCostCents: selectedScenario.cost.loadedPayrollCents,
          shiftCount: selectedScenario.shifts.length,
        }],
        provenance: {
          sourceId: "olivia.schedule_foundation" as const,
          canonicalReaderId: "olivia.schedule.preview" as const,
          sourceRevision: null, purpose: "schedule_preview" as const, asOf: scope.identity.asOf,
        },
        quality: { missingInputs: [], estimatedInputs: [], staleInputs: [] },
      };
    },
  }, {
    id: OLIVIA_P3_WHATIF_ID, version: 1 as const, owner: "olivia",
    resultKind: "owner_parameterized_simulation" as const,
    mode: "read" as const, availability: "shadow" as const,
    purpose: "Read-only what-if: runs the existing reviewed Olivia optimizer twice (once " +
      "unmodified, once with one or more named workers made temporarily unavailable or hour-" +
      "capped) and reports the real coverage/cost delta. Workers are named by their display " +
      "name, resolved against the trusted roster -- never a model-supplied id. Never writes " +
      "availability, a draft, an approval or a publication.",
    sourceIds: ["olivia.schedule_foundation"],
    canonicalReaderIds: ["olivia.schedule.whatIf"],
    allowedPurposes: ["schedule_what_if"],
    inputSchema: whatIfInputSchema, outputSchema: oliviaP3WhatIfOutputSchema,
    schemaContract: {
      id: OLIVIA_P3_WHATIF_ID + ".v1", registrationId: OLIVIA_P3_WHATIF_ID, version: 1 as const,
      inputSchemaFingerprint: schemaFingerprint(whatIfInputSchema),
      outputSchemaFingerprint: schemaFingerprint(oliviaP3WhatIfOutputSchema),
    },
    requiredRole: "owner" as const, sensitivity: "staff" as const,
    budgets: { maxOperations: 1, timeoutMs: 10000, maxResultBytes: 20000, maxInputBytes: 10000, maxRangeDays: 7 },
    requiresApproval: false as const, effectPolicy: "deny" as const,
    async read(scope: TrustedReadScope, rawInput: unknown) {
      const input = rawInput as z.output<typeof whatIfInputSchema>;
      if (scope.ownerClause && (!matchesOwnerScheduleDates(input, scope.ownerClause, scope.identity.asOf) ||
        input.overrides.some(o => !isWholeNamedEntity(scope.ownerContext ?? scope.ownerClause!, o.employeeName, []))))
        return { status: "unavailable" as const, value: null, reason: "invalid_input" };
      const resolution = await resolveEmployeeNames(input.overrides, scope.businessId);
      if (!resolution.ok) return { status: "unavailable" as const, value: null, reason: resolution.reason };
      const raw = await executeOliviaReadCapability({
        capability: "olivia.schedule.whatIf", version: 1, week: input.week,
        overrides: resolution.overrides,
        ...(input.objective ? { options: { objective: input.objective } } : {}),
      });
      if (!raw.ok || raw.capability !== "olivia.schedule.whatIf")
        return { status: "unavailable" as const, value: null,
          reason: !raw.ok ? raw.error.code : "unexpected_capability" };
      if (raw.source.businessId !== scope.businessId)
        return { status: "unavailable" as const, value: null, reason: "unauthorized" };
      // The roster read and this simulation are two separate trusted reads; a staff
      // record change landing between them (e.g. a rename) must never be silently
      // presented as answering about the name the owner actually asked for. Reusing
      // the EXISTING "source_changed" reason -- already localized -- rather than a new one.
      for (const [employeeId, requestedName] of resolution.requestedNames) {
        const current = raw.employeeNames[employeeId];
        if (!current || current.trim().toLowerCase() !== requestedName.toLowerCase())
          return { status: "unavailable" as const, value: null, reason: "source_changed" };
        if (Object.values(raw.employeeNames).filter(name =>
          name.trim().toLowerCase() === requestedName.toLowerCase()).length !== 1)
          return { status: "unavailable" as const, value: null, reason: "ambiguous_employee_name" };
      }
      // One structured entry per override, built from the SAME validated input the
      // simulation ran on (worker, date/window or minute cap, whichever the override kind
      // carries) -- lets the owner catch capability selection emitting a valid-but-wrong
      // parameter (wrong duration, wrong window, wrong day), the same way the resolved
      // worker name lets them catch a wrong worker. The presentation layer renders this
      // through the locale catalogs; no English prose is assembled here.
      // Caught in review (PR #108, rounds 2, 3 and 4).
      const overridesSummary = input.overrides.slice(0, OLIVIA_P3_MAX_WHAT_IF_OVERRIDES).map(o => ({
        kind: o.kind, employeeName: o.employeeName,
        localDate: o.kind === "reduce_weekly_minutes" ? null : o.localDate,
        startLocal: o.kind === "temporary_unavailable" ? o.window?.startLocal ?? null : null,
        endLocal: o.kind === "temporary_unavailable" ? o.window?.endLocal ?? null : null,
        maxWeeklyMinutes: o.kind === "reduce_weekly_minutes" ? o.maxWeeklyMinutes : null,
        maxMinutes: o.kind === "reduce_daily_minutes" ? o.maxMinutes : null,
      }));
      const name = input.week;
      const legalReviewUnverified = [raw.baselineScenario, raw.alternateScenario]
        .some(s => s !== null && s.legalReview !== "verified_profile");
      const hasAdditionalCaveats = raw.baselineWarnings.length > 0 || raw.alternateWarnings.length > 0 ||
        raw.notices.length > 0;
      return {
        status: "partial" as const, id: "olivia.schedule.what_if" as const,
        value: [{
          name, overridesSummary, objective: raw.alternateScenario?.objective ?? null,
          alternateStatus: raw.alternateStatus,
          changed: raw.comparison?.changed ?? null,
          completeCoverageAfter: raw.comparison?.completeCoverageAfter ?? null,
          gapsDifference: raw.comparison?.gapsDifference ?? null,
          loadedPayrollDifferenceCents: raw.comparison?.loadedPayrollDifferenceCents ?? null,
          ownerMinutesDifference: raw.comparison?.ownerMinutesDifference ?? null,
          cashWagesDifferenceCents: raw.comparison?.cashWagesDifferenceCents ?? null,
          salaryAllocationIncluded: [raw.baselineScenario, raw.alternateScenario]
            .some(s => s !== null && (s.cost.allocatedSalaryCents ?? 0) > 0),
          laborCostEstimated: [raw.baselineScenario, raw.alternateScenario]
            .some(s => s !== null && s.cost.costState === "estimate"),
          legalReviewUnverified, hasAdditionalCaveats,
        }],
        provenance: {
          sourceId: "olivia.schedule_foundation" as const,
          canonicalReaderId: "olivia.schedule.whatIf" as const,
          sourceRevision: null, purpose: "schedule_what_if" as const, asOf: scope.identity.asOf,
        },
        quality: { missingInputs: [], estimatedInputs: [], staleInputs: [] },
      };
    },
  }];
}
