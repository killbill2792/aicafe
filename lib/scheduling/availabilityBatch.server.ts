import "server-only";

import { availabilityBatchSchema } from "./availabilityBatchSchemas";
import { requireSchedulingOwner } from "./foundation.server";

export type AvailabilityBatchResult =
  | { ok: true; replayed: boolean; records: Array<{ id: string; revision: number }> }
  | { ok: false; error: "disabled" | "invalid_input" | "unauthorized" | "conflict" | "storage_unavailable" };

/** Atomic full-scope replacement; separate from legacy assignment/timecard actions. */
export async function saveAvailabilityBatch(input: unknown): Promise<AvailabilityBatchResult> {
  if (process.env.SCHEDULING_FOUNDATION_ENABLED !== "true" ||
      process.env.SCHEDULING_AVAILABILITY_UI_ENABLED !== "true") {
    return { ok: false, error: "disabled" };
  }
  const parsed = availabilityBatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const owner = await requireSchedulingOwner();
  if (!owner) return { ok: false, error: "unauthorized" };
  const data = parsed.data;
  try {
    const { data: result, error } = await owner.supabase.rpc("scheduling_save_availability_batch", {
      p_business_id: owner.businessId,
      p_employee_id: data.employeeId,
      p_location_id: data.locationId,
      p_kind: data.kind,
      p_scope: data.scope,
      p_expected: data.expected,
      p_desired: data.desired,
      p_request_key: data.requestKey,
    });
    if (error || !result) return { ok: false, error: "storage_unavailable" };
    const value = result as { replayed?: unknown; conflict?: unknown; records?: unknown };
    if (value.conflict === true) return { ok: false, error: "conflict" };
    if (typeof value.replayed !== "boolean" || !Array.isArray(value.records) ||
        value.records.some((row) => typeof row !== "object" || row === null ||
          typeof row.id !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 1)) {
      return { ok: false, error: "storage_unavailable" };
    }
    return { ok: true, replayed: value.replayed, records: value.records };
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
}
