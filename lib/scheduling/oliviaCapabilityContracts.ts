import { z } from "zod";
import { foundationRecordSchemas } from "./foundationSchemas";

/**
 * Olivia-owned wire contract only. Nothing here registers tools or grants a
 * caller permission to run an owner action. PR4B owns Supervisor wiring.
 */
export const OLIVIA_CAPABILITY_VERSION = 1 as const;
export const oliviaUuid = z.string().uuid();
const nonnegative = z.number().int().min(0);
// Cents must remain exact: JavaScript loses integer precision above MAX_SAFE_INTEGER.
const cents = nonnegative.max(Number.MAX_SAFE_INTEGER).nullable();
const signedCents = z.number().int().min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER).nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, "Invalid civil date");
export const oliviaWeek = date.refine(value =>
  new Date(value + "T00:00:00Z").getUTCDay() === 1, "Week must start Monday");
const objective = z.enum(["cash", "owner_time", "balanced"]);
export const oliviaReadRequestSchema = z.discriminatedUnion("capability", [
  z.object({capability:z.literal("olivia.availability.read"),version:z.literal(1),
    employeeId:oliviaUuid.optional()}).strict(),
  z.object({capability:z.literal("olivia.schedule.preview"),version:z.literal(1),
    week:oliviaWeek,options:z.object({
      objective:objective.optional(),
      expectedSourceDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
      expectedRevision:nonnegative.max(500).optional(),
    }).strict().optional()}).strict(),
  z.object({capability:z.literal("olivia.schedule.history.read"),version:z.literal(1),
    week:oliviaWeek}).strict(),
  z.object({capability:z.literal("olivia.schedule.revision.read"),version:z.literal(1),
    week:oliviaWeek,revisionId:oliviaUuid}).strict(),
]);
export type OliviaReadRequest = z.infer<typeof oliviaReadRequestSchema>;
export type OliviaReadCapability = OliviaReadRequest["capability"];

const record = <T extends z.ZodRawShape>(shape:T) =>
  z.object({
    id:oliviaUuid,revision:z.number().int().positive(),...shape,
    created_at:z.string().datetime({offset:true}).optional(),
    updated_at:z.string().datetime({offset:true}).optional(),
    updated_by:oliviaUuid.nullable().optional(),
    confirmed_at:z.string().datetime({offset:true}).nullable().optional(),
    confirmed_by:oliviaUuid.nullable().optional(),
  }).strip();
export const oliviaStoredSchemas = {
  recurring:record(foundationRecordSchemas.availability_rule.shape),
  exception:record(foundationRecordSchemas.availability_exception.shape),
  hours:record(foundationRecordSchemas.preferences.shape),
  preferenceWindow:record(foundationRecordSchemas.preference_window.shape),
  qualification:record(foundationRecordSchemas.qualification.shape),
  compensation:record({
    ...foundationRecordSchemas.compensation.shape,
    eligibility_verified_by:oliviaUuid.nullable().optional(),
    eligibility_verified_at:z.string().nullable().optional(),
  }),
};
const recordLimit = 5000;
// Explicit PR4A response cap: large but valid PR2 plans are reported as
// capacity_exceeded by the adapter, never mislabeled as corrupt evidence.
export const OLIVIA_MAX_GAPS_PER_SCENARIO = 20_000;
export const OLIVIA_MAX_SAVED_SHIFTS = 200;
export const OLIVIA_MAX_PREVIEW_BLOCKERS = 20_002; // PR3: at most 20k workers + 2 global blockers.
export const oliviaAvailabilityEmployeeSchema = z.object({
  employeeId:oliviaUuid,displayName:z.string().min(1).max(240),active:z.boolean(),
  state:z.enum(["confirmed","unconfirmed","missing","unavailable"]),
  recurring:z.array(oliviaStoredSchemas.recurring).max(recordLimit),
  exceptions:z.array(oliviaStoredSchemas.exception).max(recordLimit),
  hourLimits:z.array(oliviaStoredSchemas.hours).max(recordLimit),
  preferences:z.array(oliviaStoredSchemas.preferenceWindow).max(recordLimit),
  qualifications:z.array(oliviaStoredSchemas.qualification).max(recordLimit),
  compensation:z.array(oliviaStoredSchemas.compensation).max(recordLimit),
}).strict();

const utc = z.string().datetime({offset:true});
export const oliviaShiftSchema = z.object({
  employeeId:oliviaUuid,locationId:oliviaUuid,startAt:utc,endAt:utc,
  paidMinutes:nonnegative.max(1440),
  breaks:z.array(z.object({startAt:utc,endAt:utc,paid:z.boolean()}).strict()).max(24),
  pinned:z.boolean(),
}).strict();
const costSchema=z.object({
  cashWagesCents:cents,allocatedSalaryCents:cents,loadedPayrollCents:cents,
  ownerOpportunityCents:cents,ownerMinutes:nonnegative,
  costState:z.enum(["verified","estimate","unavailable"]),
  missingWageEmployeeIds:z.array(oliviaUuid).max(500),
}).strict();
export const oliviaScenarioSchema=z.object({
  objective,shifts:z.array(oliviaShiftSchema).max(OLIVIA_MAX_SAVED_SHIFTS),
  gaps:z.array(z.object({
    coverageId:oliviaUuid,locationId:oliviaUuid,startAt:utc,endAt:utc,
    qualificationCode:z.string().nullable(),missingHeadcount:nonnegative,
    reason:z.enum(["no_active_staff","qualification_missing","no_confirmed_availability",
      "capacity_or_overlap","break_or_rest_constraint","daily_hour_limit",
      "weekly_hour_limit","date_specific_cap","pinned_conflict","solver_budget",
      "handoff_overlap_missing"]),
  }).strict()).max(OLIVIA_MAX_GAPS_PER_SCENARIO),
  completeCoverage:z.boolean(),hardConstraintsSatisfied:z.boolean(),
  ownerMinutes:nonnegative,cost:costSchema,preferencePenalty:z.number().finite(),
  exploredNodes:nonnegative,legalReview:z.enum(["verified_profile","unverified_profile"]),
}).strict();
export const oliviaPlanSchema=z.object({
  status:z.enum(["feasible","infeasible","unproven"]),
  horizonStart:oliviaWeek,horizonEnd:date,
  scenarios:z.array(oliviaScenarioSchema).max(3),
  best:oliviaScenarioSchema.nullable(),
  comparisons:z.array(z.object({
    left:objective,right:objective,ownerMinutesDifference:z.number().int(),
    cashWagesDifferenceCents:signedCents,
    loadedPayrollDifferenceCents:signedCents,
  }).strict()).max(6),
  warnings:z.array(z.string().max(1000)).max(100),
  proof:z.enum(["complete_candidate_solution","required_slot_has_no_eligible_worker",
    "search_budget_exhausted","candidate_constraints_unresolved"]),
}).strict();
/** PR2's read-only planner may produce more than PR3 can persist. Validate
 * every field/element before classifying a valid overflow as capacity; only
 * the original bounded schemas are permitted for a successful capability.
 */
export const oliviaOverflowScenarioSchema=oliviaScenarioSchema.extend({
  shifts:z.array(oliviaShiftSchema),
  gaps:z.array(oliviaScenarioSchema.shape.gaps.element),
});
export const oliviaOverflowPlanSchema=oliviaPlanSchema.extend({
  scenarios:z.array(oliviaOverflowScenarioSchema).max(3),
  best:oliviaOverflowScenarioSchema.nullable(),
  warnings:z.array(z.string().max(1000)),
});
export const oliviaRevisionStatusSchema=z.enum(["draft","approved","published","superseded"]);
const source=z.object({
  owner:z.literal("olivia"),businessId:oliviaUuid,
  kind:z.enum(["stored_availability","stored_revisions","stored_revision","trusted_preview"]),
  consistency:z.enum(["stored","provisional"]),
  sourceDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const header=z.object({ok:z.literal(true),version:z.literal(1),
  status:z.literal("ok"),source}).strict();
export const oliviaAvailabilityResponseSchema=header.extend({
  capability:z.literal("olivia.availability.read"),
  employees:z.array(oliviaAvailabilityEmployeeSchema).max(500),
}).strict();
// PR3's source loader can emit up to three notices per employee, plus six
// global notices. Each scanned source table permits 20,000 rows. Preserving all
// notices avoids incorrectly rejecting a valid preview with >100 warnings.
const MAX_PREVIEW_NOTICES = 3 * 20_000 + 6;
const notice=z.object({code:z.enum(["wage_unknown","availability_missing","unconfirmed_absence",
  "coverage_unconfirmed","no_active_staff","limits_missing","legacy_schedules",
  "policy_unverified","source_provisional"]),employeeName:z.string().optional()}).strict();
export const oliviaCapabilityBlockerSchema=z.object({code:z.enum(["no_location","no_coverage","conflicting_limits"]),
  employeeName:z.string().optional()}).strict();
export const oliviaPreviewResponseSchema=header.extend({
  capability:z.literal("olivia.schedule.preview"),plan:oliviaPlanSchema,
  selectedScenario:oliviaScenarioSchema.nullable(),
  previewRevision:nonnegative.max(500),
  notices:z.array(notice).max(MAX_PREVIEW_NOTICES),
  blockers:z.array(oliviaCapabilityBlockerSchema).max(OLIVIA_MAX_PREVIEW_BLOCKERS),
  employeeNames:z.record(oliviaUuid,z.string().max(240)),
  locationNames:z.record(oliviaUuid,z.string().max(240)),
  frozenShiftKeys:z.array(z.string().max(500)).max(200),
  disposition:z.literal("proposal_only"),
}).strict();
export const oliviaHistoryResponseSchema=header.extend({
  capability:z.literal("olivia.schedule.history.read"),
  currentRevision:nonnegative.max(500),
  publishedRevision:nonnegative.max(500).nullable(),
  revisions:z.array(z.object({
    id:oliviaUuid,revision:z.number().int().min(1).max(500),
    status:oliviaRevisionStatusSchema,created_at:utc,
  }).strict()).max(500),
}).strict();
export const oliviaRevisionResponseSchema=header.extend({
  capability:z.literal("olivia.schedule.revision.read"),
  revisionId:oliviaUuid,revision:z.number().int().min(1).max(500),
  revisionStatus:oliviaRevisionStatusSchema,currentRevision:nonnegative.max(500),
  publishedRevision:nonnegative.max(500).nullable(),
  sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),
  scenario:oliviaScenarioSchema,
  assignments:z.array(oliviaShiftSchema).max(200),
  disposition:z.literal("stored_read_only"),
}).strict();
export const oliviaCapabilityErrorSchema=z.object({
  ok:z.literal(false),version:z.literal(1),status:z.literal("error"),
  capability:z.enum(["olivia.availability.read","olivia.schedule.preview",
    "olivia.schedule.history.read","olivia.schedule.revision.read","invalid_request"]),
  error:z.object({code:z.enum(["invalid_input","unauthorized","disabled","not_found",
    "missing_inputs","source_changed","revision_conflict","invalid_record",
    "storage_unavailable","planner_unavailable","capacity_exceeded"]),
    retryable:z.boolean(),message:z.string().max(180)}).strict(),
  blockers:z.array(oliviaCapabilityBlockerSchema).min(1).max(OLIVIA_MAX_PREVIEW_BLOCKERS).optional(),
}).strict();
export const oliviaReadResponseSchema=z.union([
  oliviaAvailabilityResponseSchema,oliviaPreviewResponseSchema,
  oliviaHistoryResponseSchema,oliviaRevisionResponseSchema,oliviaCapabilityErrorSchema,
]);
export type OliviaReadResponse=z.infer<typeof oliviaReadResponseSchema>;

/** Declarative future intents, not callable capabilities. PR4B must route
 * owner confirmation to EXISTING PR3 services and transaction safeguards. */
export const futureOliviaOwnerIntentSchemas={
  edit:z.object({
    capability:z.literal("olivia.schedule.edit"),version:z.literal(1),
    week:oliviaWeek,baseRevisionId:oliviaUuid,
    expectedRevision:z.number().int().min(1).max(499),
    expectedSourceDigest:z.string().regex(/^[a-f0-9]{64}$/),
    requestKey:oliviaUuid,objective,
    shifts:z.array(oliviaShiftSchema).max(200),
  }).strict(),
  approve:z.object({
    capability:z.literal("olivia.schedule.approve"),version:z.literal(1),
    week:oliviaWeek,revisionId:oliviaUuid,
    expectedRevision:z.number().int().min(1).max(500),requestKey:oliviaUuid,
  }).strict(),
  publish:z.object({
    capability:z.literal("olivia.schedule.publish"),version:z.literal(1),
    week:oliviaWeek,revisionId:oliviaUuid,
    expectedRevision:z.number().int().min(1).max(500),requestKey:oliviaUuid,
  }).strict(),
} as const;
