"use server";

import { z } from "zod";
import { loadOliviaWeekFromSavedStaff } from "@/lib/scheduling/planInput.server";
import { createOliviaDraftFromTrustedSnapshot, oliviaSnapshotDigest } from "@/lib/scheduling/planDrafts.server";
import { optimizeOliviaWeek } from "@/lib/calc/scheduling/plannerEngine";
import type { PlannerResult } from "@/lib/calc/scheduling/plannerTypes";
import { requireSchedulingOwner } from "@/lib/scheduling/foundation.server";

const args = z.object({
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
const saveArgs = args.extend({
  objective: z.enum(["cash", "owner_time", "balanced"]),
  expectedRevision: z.number().int().min(0),
  requestKey: z.string().uuid(),
  expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function previewOliviaWeek(raw: unknown): Promise<
  | { ok: true; plan: PlannerResult; warnings: string[]; blockers: string[]; employees: Record<string,string>; locations: Record<string,string>; locationNames: Record<string,string>; sourceDigest: string }
  | { ok: false; error: string }
> {
  const parsed = args.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const loaded = await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.blockers.length) return {
    ok: false, error: loaded.blockers.join(" "),
  };
  try {
    const plan = optimizeOliviaWeek(loaded.input);
    return { ok: true, plan, warnings: loaded.warnings, blockers: loaded.blockers,
      employees: Object.fromEntries(loaded.input.employees.map(e => [e.id, e.displayName])),
      locations: Object.fromEntries(loaded.input.locations.map(l => [l.id, l.timezone])),
      locationNames: loaded.locationNames,
      sourceDigest: oliviaSnapshotDigest(loaded.input, loaded.sourceFingerprint) };
  } catch {
    return { ok: false, error: "The saved scheduling inputs cannot yet form a valid plan. Review availability, coverage and location timezones." };
  }
}

/** Saves a revision of a real snapshot. Never trusts preview results or
 * any caller-supplied planner input, employees, wages, assignments or digest.
 */
export async function saveOliviaWeekDraft(raw: unknown) {
  const parsed = saveArgs.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "invalid_input" as const };
  const loaded = await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if (!loaded.ok) return { ok: false as const, error: loaded.error };
  if (loaded.blockers.length) return { ok: false as const, error: "missing_coverage" as const };
  if (parsed.data.objective === "owner_time" &&
      !loaded.input.employees.some(employee => employee.isOwner === true))
    return { ok: false as const, error: "owner_link_missing" as const };
  // A preview is informative, not authority. Refuse to save a different roster
  // after wages, availability, coverage or selected café facts have changed.
  if (oliviaSnapshotDigest(loaded.input) !== parsed.data.expectedSourceDigest)
    return { ok: false as const, error: "source_changed" as const };
  return createOliviaDraftFromTrustedSnapshot({
    horizonStart: parsed.data.week,
    objective: parsed.data.objective,
    expectedRevision: parsed.data.expectedRevision,
    requestKey: parsed.data.requestKey,
  }, loaded.input, loaded.businessId, loaded.sourceFingerprint);
}

export async function readOliviaPlanHistory(raw: unknown) {
  const parsed = args.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "invalid_input" as const };
  if (process.env.SCHEDULING_FOUNDATION_ENABLED !== "true" ||
      process.env.SCHEDULING_PR3_DRAFTS_ENABLED !== "true")
    return { ok: false as const, error: "disabled" as const };
  const owner = await requireSchedulingOwner();
  if (!owner) return { ok: false as const, error: "unauthorized" as const };
  const { data: series, error } = await owner.supabase
    .from("scheduling_plan_series")
    .select("id,current_revision,published_revision")
    .eq("business_id", owner.businessId)
    .eq("horizon_start", parsed.data.week).maybeSingle();
  if (error) return { ok: false as const, error: "storage_unavailable" as const };
  if (!series) return { ok: true as const, currentRevision: 0, publishedRevision: null,
    revisions: [] as Array<{revision:number;status:string;id:string;created_at:string}> };
  const { data: revisions, error: revisionError } = await owner.supabase
    .from("scheduling_plan_revisions")
    .select("id,revision,status,created_at")
    .eq("business_id", owner.businessId)
    .eq("series_id", series.id)
    .order("revision", { ascending: false }).limit(501);
  if (revisionError || !revisions || revisions.length > 500 ||
      (series.current_revision as number) > 500 ||
      ((series.current_revision as number) > 0 &&
        revisions[0]?.revision !== series.current_revision))
    return { ok: false as const, error: "history_too_large_or_unavailable" as const };
  return { ok: true as const, currentRevision: series.current_revision as number,
    publishedRevision: series.published_revision as number | null, revisions };
}
