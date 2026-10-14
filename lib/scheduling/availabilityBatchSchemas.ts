import { z } from "zod";
import { foundationRecordSchemas } from "./foundationSchemas";

// The client supplies only record identity, local-date scope and intent.
// Tenant and actor are always resolved from the authenticated server session.
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const common = {
  employeeId: uuid,
  locationId: uuid.nullable(),
  requestKey: uuid,
  expected: z.array(z.object({
    id: uuid, revision: z.number().int().positive(),
  }).strict()).max(200),
};

export const availabilityBatchSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("availability_rule"),
    scope: z.object({
      effective_from: date, effective_to: date.nullable(),
    }).strict(),
    desired: z.array(z.object({
      id: uuid.optional(),
      data: foundationRecordSchemas.availability_rule,
    }).strict()).max(200),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal("availability_exception"),
    scope: z.object({ local_date: date }).strict(),
    desired: z.array(z.object({
      id: uuid.optional(),
      data: foundationRecordSchemas.availability_exception,
    }).strict()).max(200),
  }).strict(),
]).superRefine((batch, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of batch.desired.entries()) {
    if (item.id && ids.has(item.id)) {
      ctx.addIssue({ code: "custom", message: "Duplicate record ID", path: ["desired", index, "id"] });
    }
    if (item.id) ids.add(item.id);
    if (item.data.employee_id !== batch.employeeId ||
        (item.data.location_id ?? null) !== batch.locationId) {
      ctx.addIssue({ code: "custom", message: "Employee/location scope mismatch", path: ["desired", index] });
    }
    if (batch.kind === "availability_rule") {
      const data = item.data as z.infer<typeof foundationRecordSchemas.availability_rule>;
      if (data.effective_from !== batch.scope.effective_from ||
          (data.effective_to ?? null) !== batch.scope.effective_to) {
        ctx.addIssue({ code: "custom", message: "Recurring effective date mismatch", path: ["desired", index] });
      }
    } else if ((item.data as z.infer<typeof foundationRecordSchemas.availability_exception>).local_date
              !== batch.scope.local_date) {
      ctx.addIssue({ code: "custom", message: "Exception date mismatch", path: ["desired", index] });
    }
  }
  const expectedIds = batch.expected.map((row) => row.id);
  if (new Set(expectedIds).size !== expectedIds.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate expected record ID", path: ["expected"] });
  }
  if ([...ids].some((id) => !expectedIds.includes(id))) {
    ctx.addIssue({ code: "custom", message: "Edited ID missing from expected manifest", path: ["desired"] });
  }
});

export type AvailabilityBatchInput = z.infer<typeof availabilityBatchSchema>;
