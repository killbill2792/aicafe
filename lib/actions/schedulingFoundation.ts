"use server";

import {
  executeFoundationCommand,
  readSchedulingFoundation,
  requireSchedulingOwner,
} from "@/lib/scheduling/foundation.server";
import { saveAvailabilityBatch } from "@/lib/scheduling/availabilityBatch.server";
import { localDateInZone } from "@/lib/scheduling/localDate";

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
    owner.supabase.from("locations").select("id,name,timezone", { count: "exact" })
      .eq("business_id", owner.businessId).order("name").limit(500),
    owner.supabase.from("businesses").select("timezone")
      .eq("id", owner.businessId).single(),
  ]);
  if (locations.error || business.error || !locations.data || !business.data ||
      locations.count === null || locations.count > locations.data.length)
    return { ok: false as const, error: "storage_unavailable" as const };
  try {
    const timezone=business.data.timezone as string;
    const now=new Date();
    const businessTodayLocal=localDateInZone(now,timezone);
    return { ok: true as const,
      locations: locations.data.map(loc=>({
        id:loc.id as string,name:loc.name as string,
        timezone:loc.timezone as string|null,
        todayLocal:localDateInZone(now,(loc.timezone as string|null)||timezone),
      })),
      businessTimezone:timezone,businessTodayLocal };
  } catch {
    return { ok:false as const,error:"storage_unavailable" as const };
  }
}
