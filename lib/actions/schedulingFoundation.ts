"use server";

import {
  executeFoundationCommand,
  readSchedulingFoundation,
  requireSchedulingOwner,
} from "@/lib/scheduling/foundation.server";
import { saveAvailabilityBatch } from "@/lib/scheduling/availabilityBatch.server";

/**
 * Typed, owner-only manual scheduling foundation operations.
 * No Supervisor/Olivia chat tool is registered in PR 1A.
 * Both functions are default-off until the reviewed migration is applied.
 */
export async function saveSchedulingFoundationRecord(input: unknown) {
  return executeFoundationCommand(input);
}

export async function getSchedulingFoundationRecords() {
  return readSchedulingFoundation();
}

/** PR 1B: all-or-nothing employee availability set update. */
export async function saveStaffAvailabilityBatch(input: unknown) {
  return saveAvailabilityBatch(input);
}

/** Owner-scoped location/timezone choices for coverage forms. */
export async function getSchedulingLocationOptions() {
  if (process.env.SCHEDULING_FOUNDATION_ENABLED !== "true" ||
      process.env.SCHEDULING_AVAILABILITY_UI_ENABLED !== "true") {
    return { ok: false as const, error: "disabled" as const };
  }
  const owner = await requireSchedulingOwner();
  if (!owner) return { ok: false as const, error: "unauthorized" as const };
  const [locations, business] = await Promise.all([
    owner.supabase.from("locations").select("id,name,timezone")
      .eq("business_id", owner.businessId).order("name").limit(500),
    owner.supabase.from("businesses").select("timezone")
      .eq("id", owner.businessId).single(),
  ]);
  if (locations.error || business.error || !locations.data || !business.data)
    return { ok: false as const, error: "storage_unavailable" as const };
  return { ok: true as const, locations: locations.data,
    businessTimezone: business.data.timezone as string };
}
