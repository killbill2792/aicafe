import { z } from "zod";
import { availabilityBatchSchema } from "./availabilityBatchSchemas";
import { oliviaUuid, oliviaWeek } from "./oliviaCapabilityContracts";

/** Olivia PR4B-A only: strict domain wire shapes. Not a Supervisor tool. */
export const OLIVIA_COMMAND_VERSION = 1 as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "Invalid civil date");
const wall = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sourceToken = z.string().regex(/^[a-f0-9]{32}$/);
const source = z.enum(["owner_direct", "worker_reported_by_owner"]);
const employee = z.union([
  z.object({ employeeId: oliviaUuid }).strict(),
  z.object({ exactDisplayName: z.string().trim().min(1).max(240) }).strict(),
]);
const edit = <T extends z.ZodTypeAny>(data: T) => z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), data }).strict(),
  z.object({ action: z.literal("replace"), id: oliviaUuid,
    expectedRevision: z.number().int().positive(), data }).strict(),
  z.object({ action: z.literal("remove"), id: oliviaUuid,
    expectedRevision: z.number().int().positive() }).strict(),
]);
const window = z.object({
  day_of_week: z.number().int().min(0).max(6), start_local: wall,
  end_local: wall, overnight: z.boolean(), source,
}).strict();
const exception = z.object({
  exception_type: z.enum(["unavailable", "approved_leave", "replace_day", "add_available", "hours_cap"]),
  start_local: wall.nullable().optional(), end_local: wall.nullable().optional(),
  overnight: z.boolean(), max_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  source,
}).strict();
const recurringScope = z.object({
  effective_from: date, effective_to: date.nullable(),
}).strict().refine(v => v.effective_to === null || v.effective_to >= v.effective_from,
  "Invalid recurring date range");
const exceptionScope = z.object({ local_date: date }).strict();

export const oliviaPrepareAvailabilitySchema = z.object({
  capability: z.literal("olivia.availability.prepare"),
  version: z.literal(1),
  changes: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("availability_rule"), employee,
      locationId: oliviaUuid.nullable(), scope: recurringScope,
      operations: z.array(edit(window)).min(1).max(200) }).strict(),
    z.object({ kind: z.literal("availability_exception"), employee,
      locationId: oliviaUuid.nullable(), scope: exceptionScope,
      operations: z.array(edit(exception)).min(1).max(200) }).strict(),
  ])).min(1).max(40),
}).strict();

export const oliviaPreparedAvailabilitySchema = z.object({
  capability: z.literal("olivia.availability.commit"),
  version: z.literal(1),
  businessId: oliviaUuid,
  sourceToken,
  batches: z.array(availabilityBatchSchema).min(1).max(40),
  disposition: z.literal("requires_separate_authenticated_owner_action"),
}).strict();
export const oliviaConfirmedCommitSchema = z.object({
  capability: z.literal("olivia.availability.commit"),
  version: z.literal(1),
  proposal: oliviaPreparedAvailabilitySchema,
  proposalDigest: hash,
  requestKey: oliviaUuid,
}).strict();

export const oliviaCreateDraftSchema = z.object({
  capability: z.literal("olivia.schedule.draft.create"),
  version: z.literal(1), week: oliviaWeek,
  objective: z.enum(["cash", "owner_time", "balanced"]),
  expectedSourceDigest: hash,
  expectedRevision: z.number().int().min(0).max(499),
  requestKey: oliviaUuid,
}).strict();

export type OliviaPrepareAvailability = z.infer<typeof oliviaPrepareAvailabilitySchema>;
export type OliviaPreparedAvailability = z.infer<typeof oliviaPreparedAvailabilitySchema>;
export type OliviaConfirmedCommit = z.infer<typeof oliviaConfirmedCommitSchema>;
export type OliviaCreateDraft = z.infer<typeof oliviaCreateDraftSchema>;
