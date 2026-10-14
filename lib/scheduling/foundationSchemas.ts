import { z } from "zod";

// PR 1A: input shapes, not scheduling calculations. Feasibility and time
// precedence belong exclusively to pure lib/calc/scheduling functions.
const id = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const weekday = z.number().int().min(0).max(6);
const source = z.enum(["owner_direct", "worker_reported_by_owner"]);
const confirmation = z.enum(["unconfirmed", "owner_confirmed"]);
const attribution = { source, confirmation };
const optionalLocation = { location_id: id.nullable().optional() };
const timeWindow = { start_local: time, end_local: time, overnight: z.boolean() };
const effectiveDates = { effective_from: date, effective_to: date.nullable().optional() };
const minutesWeek = z.number().int().min(0).max(10080);
const minutesDay = z.number().int().min(0).max(1440);
const qualificationCode = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

export const foundationRecordSchemas = {
  availability_rule: z.object({
    employee_id: id, ...optionalLocation, day_of_week: weekday,
    ...timeWindow, ...effectiveDates, ...attribution,
  }).strict(),
  availability_exception: z.object({
    employee_id: id, ...optionalLocation, local_date: date,
    exception_type: z.enum(["unavailable", "approved_leave", "replace_day", "add_available", "hours_cap"]),
    start_local: time.nullable().optional(), end_local: time.nullable().optional(),
    overnight: z.boolean().default(false),
    max_minutes: minutesDay.nullable().optional(), ...attribution,
  }).strict(),
  preferences: z.object({
    employee_id: id, ...effectiveDates, min_weekly_minutes: minutesWeek,
    desired_weekly_minutes: minutesWeek.nullable().optional(),
    max_weekly_minutes: minutesWeek.nullable().optional(),
    max_daily_minutes: minutesDay.nullable().optional(), ...attribution,
  }).strict(),
  preference_window: z.object({
    employee_id: id, day_of_week: weekday, ...timeWindow, ...effectiveDates,
    preference: z.enum(["prefer", "avoid"]), strength: z.enum(["soft", "hard"]),
    ...attribution,
  }).strict(),
  qualification_type: z.object({
    code: qualificationCode, display_name: z.string().trim().min(1).max(80),
    active: z.boolean().default(true),
  }).strict(),
  qualification: z.object({
    employee_id: id, ...optionalLocation, qualification_code: qualificationCode,
    valid_from: date, valid_to: date.nullable().optional(), ...attribution,
  }).strict(),
  coverage: z.object({
    location_id: id, day_of_week: weekday.nullable().optional(), local_date: date.nullable().optional(),
    effective_from: date.nullable().optional(), effective_to: date.nullable().optional(),
    ...timeWindow, min_headcount: z.number().int().min(0).max(50),
    qualification_code: qualificationCode.nullable().optional(),
    min_overlap_minutes: minutesDay.default(0),
    priority: z.enum(["required", "advisory"]).default("required"), ...attribution,
  }).strict(),
  compensation: z.object({
    employee_id: id,
    cash_cost_state: z.enum(["unknown", "known_paid", "salary_conversion_pending", "known_eligible_zero"]),
    eligibility_reference: z.string().trim().min(8).max(240).nullable().optional(),
  }).strict(),
} as const;

export type FoundationKind = keyof typeof foundationRecordSchemas;

export const foundationCommandSchema = z.object({
  kind: z.enum([
    "availability_rule", "availability_exception", "preferences", "preference_window",
    "qualification_type", "qualification", "coverage", "compensation",
  ]),
  action: z.enum(["create", "update", "delete"]),
  id: id.optional(),
  expectedRevision: z.number().int().positive().optional(),
  data: z.unknown().optional(),
}).strict().superRefine((command, ctx) => {
  if (command.action !== "create" && (!command.id || !command.expectedRevision)) {
    ctx.addIssue({ code: "custom", message: "A record ID and revision are required for edits." });
  }
  if (command.action === "create" && (command.id || command.expectedRevision)) {
    ctx.addIssue({ code: "custom", message: "New records cannot supply IDs or revisions." });
  }
  if (command.action !== "delete" && command.data === undefined) {
    ctx.addIssue({ code: "custom", message: "Record data are required." });
  }
  if (command.action === "delete" && command.data !== undefined) {
    ctx.addIssue({ code: "custom", message: "Delete must not include record data." });
  }
});

export const foundationTables: Record<FoundationKind, string> = {
  availability_rule: "staff_availability_rules",
  availability_exception: "staff_availability_exceptions",
  preferences: "staff_scheduling_preferences",
  preference_window: "staff_preference_windows",
  qualification_type: "scheduling_qualification_types",
  qualification: "staff_qualifications",
  coverage: "scheduling_coverage_requirements",
  compensation: "staff_scheduling_compensation",
};

/**
 * This function checks permitted fields/values before a database write.
 * Temporal precedence, overlap and other deterministic scheduling rules are
 * implemented in lib/calc/scheduling, not here.
 */
export function parseFoundationRecord(kind: FoundationKind, value: unknown): Record<string, unknown> {
  // All schemas are strict, disallow business_id, actor IDs, versions and timestamps.
  return foundationRecordSchemas[kind].parse(value) as Record<string, unknown>;
}
