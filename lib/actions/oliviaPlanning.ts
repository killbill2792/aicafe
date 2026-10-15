"use server";

import { z } from "zod";
import { loadOliviaWeekFromSavedStaff } from "@/lib/scheduling/planInput.server";
import { createOliviaDraftFromTrustedSnapshot } from "@/lib/scheduling/planDrafts.server";
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
}).strict();

export async function previewOliviaWeek(raw: unknown): Promise<
  | { ok: true; plan: PlannerResult; warnings: string[]; blockers: string[] }
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
    return { ok: true, plan, warnings: loaded.warnings, blockers: loaded.blockers };
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
  return createOliviaDraftFromTrustedSnapshot({
    horizonStart: parsed.data.week,
    objective: parsed.data.objective,
    expectedRevision: parsed.data.expectedRevision,
    requestKey: parsed.data.requestKey,
  }, loaded.input);
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
    .order("revision", { ascending: false }).limit(500);
  if (revisionError || !revisions) return { ok: false as const, error: "storage_unavailable" as const };
  return { ok: true as const, currentRevision: series.current_revision as number,
    publishedRevision: series.published_revision as number | null, revisions };
}
