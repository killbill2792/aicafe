"use server";

import { z } from "zod";
import { loadOliviaWeekFromSavedStaff, type OliviaBlocker, type OliviaNotice } from "@/lib/scheduling/planInput.server";
import { createOliviaDraftFromTrustedSnapshot, oliviaSnapshotDigest } from "@/lib/scheduling/planDrafts.server";
import { optimizeOliviaWeek } from "@/lib/calc/scheduling/plannerEngine";
import type { PlannerResult } from "@/lib/calc/scheduling/plannerTypes";
import { requireSchedulingOwner } from "@/lib/scheduling/foundation.server";
import { editDraftSchema, saveOliviaEditedDraft } from "@/lib/scheduling/planEdits.server";
import {transitionOliviaPlan} from "@/lib/scheduling/planPublication.server";
import {laborReviewCommandSchema,readOliviaRuleReview,saveOliviaRuleReview} from "@/lib/scheduling/planPolicy.server";
import type { PlannerScenario } from "@/lib/calc/scheduling/plannerTypes";

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
  | { ok: true; plan: PlannerResult; notices: OliviaNotice[]; blockers: OliviaBlocker[]; employees: Record<string,string>; locations: Record<string,string>; locationNames: Record<string,string>; sourceDigest: string; previewRevision: number }
  | { ok: false; error: string; blockers?: OliviaBlocker[] }
> {
  const parsed = args.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const loaded = await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.blockers.length) return {
    ok: false, error: "missing_inputs", blockers: loaded.blockers,
  };
  // Capture the draft head at the start of this proposal. Saving MUST use
  // precisely this revision, never a later history refresh from a co-owner.
  const owner = await requireSchedulingOwner();
  if (!owner || owner.businessId !== loaded.businessId)
    return { ok:false, error:"unauthorized" };
  const head = await owner.supabase.from("scheduling_plan_series")
    .select("current_revision").eq("business_id",loaded.businessId)
    .eq("horizon_start",parsed.data.week).maybeSingle();
  if (head.error || (head.data &&
      (!Number.isSafeInteger(head.data.current_revision) ||
       head.data.current_revision < 0 || head.data.current_revision > 500)))
    return {ok:false,error:"storage_unavailable"};
  const previewRevision = head.data?.current_revision ?? 0;
  try {
    const plan = optimizeOliviaWeek(loaded.input);
    return { ok: true, plan, notices: loaded.notices, blockers: loaded.blockers,
      employees: Object.fromEntries(loaded.input.employees.map(e => [e.id, e.displayName])),
      locations: Object.fromEntries(loaded.input.locations.map(l => [l.id, l.timezone])),
      locationNames: loaded.locationNames, previewRevision,
      sourceDigest: oliviaSnapshotDigest(loaded.input, loaded.sourceFingerprint) };
  } catch {
    return { ok: false, error: "planner_unavailable" };
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
  if (loaded.blockers.length) return { ok: false as const, error: "missing_inputs" as const };
  if (parsed.data.objective === "owner_time" &&
      !loaded.input.employees.some(employee => employee.isOwner === true))
    return { ok: false as const, error: "owner_link_missing" as const };
  // A preview is informative, not authority. Refuse to save a different roster
  // after wages, availability, coverage or selected café facts have changed.
  if (oliviaSnapshotDigest(loaded.input, loaded.sourceFingerprint) !== parsed.data.expectedSourceDigest)
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

/** The only new owner write here is an inert, validated, immutable draft.
 * Approval and publication are intentionally absent until atomic DB gates exist.
 */
export async function saveOliviaWeekEdit(raw:unknown) {
  const parsed=editDraftSchema.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  const loaded=await loadOliviaWeekFromSavedStaff(parsed.data.horizonStart);
  if(!loaded.ok)return {ok:false as const,error:loaded.error};
  if(loaded.blockers.length)return {ok:false as const,error:"missing_inputs" as const};
  return saveOliviaEditedDraft(parsed.data,loaded.input,loaded.businessId,
    loaded.sourceFingerprint);
}

const revisionArgs=args.extend({
  revisionId:z.string().uuid(),
}).strict();

/** Owner-scoped read for selecting and editing an already-persisted draft.
 * Never returns an approval or publication permission token.
 */
export async function readOliviaPlanRevision(raw:unknown) {
  const parsed=revisionArgs.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED!=="true")
    return {ok:false as const,error:"disabled" as const};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false as const,error:"unauthorized" as const};
  const {data:series,error:seriesError}=await owner.supabase
    .from("scheduling_plan_series").select("id,current_revision,published_revision")
    .eq("business_id",owner.businessId)
    .eq("horizon_start",parsed.data.week).maybeSingle();
  if(seriesError)return {ok:false as const,error:"storage_unavailable" as const};
  if(!series)return {ok:false as const,error:"not_found" as const};
  const {data:revision,error:revisionError}=await owner.supabase
    .from("scheduling_plan_revisions")
    .select("id,revision,status,scenario,source_digest")
    .eq("business_id",owner.businessId)
    .eq("series_id",series.id)
    .eq("id",parsed.data.revisionId).maybeSingle();
  if(revisionError)return {ok:false as const,error:"storage_unavailable" as const};
  if(!revision)return {ok:false as const,error:"not_found" as const};
  const scenario=revision.scenario as PlannerScenario | null;
  if(!scenario || !Array.isArray(scenario.shifts))
    return {ok:false as const,error:"invalid_record" as const};
  return {ok:true as const,revision:revision.revision as number,
    status:revision.status as string,currentRevision:series.current_revision as number,
    publishedRevision:series.published_revision as number|null,
    scenario,sourceDigest:revision.source_digest as string};
}

export async function approveOliviaWeek(raw:unknown) {
  return transitionOliviaPlan(raw,"approve");
}
export async function publishOliviaWeek(raw:unknown) {
  return transitionOliviaPlan(raw,"publish");
}

/** Published Olivia assignments are explicitly planned shifts, not attendance.
 * No legacy timecards or financial calculations are read or written here.
 */
export async function readOliviaPublishedWeek(raw:unknown) {
  const parsed=args.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED!=="true")
    return {ok:false as const,error:"disabled" as const};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false as const,error:"unauthorized" as const};
  const {data:series,error:seriesError}=await owner.supabase
    .from("scheduling_plan_series").select("id,published_revision")
    .eq("business_id",owner.businessId).eq("horizon_start",parsed.data.week)
    .maybeSingle();
  if(seriesError)return {ok:false as const,error:"storage_unavailable" as const};
  if(!series||series.published_revision===null)
    return {ok:true as const,publishedRevision:null,assignments:[]};
  const {data:revision,error:revError}=await owner.supabase
    .from("scheduling_plan_revisions").select("id,revision,status")
    .eq("business_id",owner.businessId).eq("series_id",series.id)
    .eq("revision",series.published_revision).maybeSingle();
  if(revError || !revision || revision.status!=="published")
    return {ok:false as const,error:"storage_unavailable" as const};
  const {data:assignments,error:assignError}=await owner.supabase
    .from("scheduling_plan_assignments")
    .select("id,employee_id,location_id,starts_at,ends_at,paid_minutes,breaks")
    .eq("business_id",owner.businessId)
    .eq("plan_revision_id",revision.id)
    .order("starts_at",{ascending:true}).limit(201);
  if(assignError||!assignments||assignments.length>200)
    return {ok:false as const,error:"storage_unavailable" as const};
  return {ok:true as const,publishedRevision:revision.revision as number,
    assignments};
}

export async function readOliviaLaborRuleContext(raw:unknown){
  const parsed=args.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  const loaded=await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if(!loaded.ok)return {ok:false as const,error:loaded.error};
  const review=await readOliviaRuleReview();
  if(!review.ok)return review;
  return {ok:true as const,reviewRevision:review.revision,
    profile:review.profile,reviewedAt:review.reviewedAt,
    locations:loaded.input.locations.map(loc=>({
      id:loc.id,name:loaded.locationNames[loc.id]??loc.id,
    })),
    employees:loaded.input.employees.map(e=>({id:e.id,name:e.displayName}))};
}
export async function saveOliviaLaborRuleReview(raw:unknown){
  const parsed=z.object({week:args.shape.week,
    review:laborReviewCommandSchema}).strict().safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  const loaded=await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if(!loaded.ok)return {ok:false as const,error:loaded.error};
  // Other missing coverage does not prevent a lawful review of this location
  // or worker rule set; the user must still resolve it before publication.
  return saveOliviaRuleReview(parsed.data.review,loaded.input,loaded.businessId);
}
