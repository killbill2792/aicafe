import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PlannerInput, PlannerScenario, PlannerShift } from "@/lib/calc/scheduling/plannerTypes";
import { optimizeOliviaWeek } from "@/lib/calc/scheduling/plannerEngine";
import { validateOliviaAssignments } from "@/lib/calc/scheduling/plannerValidate";
import { requireSchedulingOwner } from "./foundation.server";

/**
 * PR3 draft-only boundary. This service MUST be invoked only by a future
 * trusted source loader, never directly with caller/model-supplied snapshots.
 * It does not approve, publish, materialize timecards or notify anyone.
 */
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionsSchema = z.object({
  horizonStart: date,
  expectedRevision: z.number().int().min(0),
  requestKey: uuid,
  objective: z.enum(["cash", "owner_time", "balanced"]),
}).strict();

export type DraftSaveResult =
  | { ok: true; seriesId: string; revisionId: string; revision: number; replayed: boolean;
      scenario: PlannerScenario }
  | { ok: false; error: "disabled" | "unauthorized" | "invalid_input" |
      "conflict" | "storage_unavailable" | "no_scenario" };

function snapshotDigest(input: PlannerInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Internal-only: caller must load the entire owner-scoped planner snapshot.
 * A partial or otherwise untrusted snapshot could create a misleading draft;
 * publication will require a separate authoritative re-read and revalidation.
 */
export async function createOliviaDraftFromTrustedSnapshot(
  rawOptions: unknown,
  input: PlannerInput,
): Promise<DraftSaveResult> {
  if (process.env.SCHEDULING_FOUNDATION_ENABLED !== "true" ||
      process.env.SCHEDULING_PR3_DRAFTS_ENABLED !== "true") {
    return { ok: false, error: "disabled" };
  }
  const options = optionsSchema.safeParse(rawOptions);
  if (!options.success || input.horizonStart !== options.data.horizonStart)
    return { ok: false, error: "invalid_input" };
  const owner = await requireSchedulingOwner();
  if (!owner) return { ok: false, error: "unauthorized" };

  let scenario: PlannerScenario;
  try {
    const result = optimizeOliviaWeek(input);
    const selected = result.scenarios.find(s => s.objective === options.data.objective);
    if (!selected) return { ok: false, error: "no_scenario" };
    const validated = validateOliviaAssignments(input, selected.shifts);
    // A partial draft may be retained for owner review with explicit gaps,
    // but NEVER infer that it is safe to publish.
    if (!validated.valid || !selected.hardConstraintsSatisfied)
      return { ok: false, error: "invalid_input" };
    scenario = selected;
  } catch {
    return { ok: false, error: "invalid_input" };
  }

  const normalizedShifts: PlannerShift[] = scenario.shifts.map(s => ({
    employeeId: s.employeeId, locationId: s.locationId,
    startAt: s.startAt, endAt: s.endAt, paidMinutes: s.paidMinutes,
    breaks: s.breaks.map(b => ({ ...b })), pinned: s.pinned,
  }));
  const sourceDigest = snapshotDigest(input);
  try {
    const { data, error } = await owner.supabase.rpc("scheduling_create_plan_draft", {
      p_business_id: owner.businessId,
      p_horizon_start: options.data.horizonStart,
      p_expected_revision: options.data.expectedRevision,
      p_source_digest: sourceDigest,
      p_planner_input: input,
      p_scenario: scenario,
      p_shifts: normalizedShifts,
      p_request_key: options.data.requestKey,
    });
    if (error || !data) return { ok: false, error: "storage_unavailable" };
    const row = data as Record<string, unknown>;
    if (row.conflict === true) return { ok: false, error: "conflict" };
    if (!uuid.safeParse(row.seriesId).success ||
        !uuid.safeParse(row.revisionId).success ||
        !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 ||
        typeof row.replayed !== "boolean") {
      return { ok: false, error: "storage_unavailable" };
    }
    return {
      ok: true, seriesId: row.seriesId as string,
      revisionId: row.revisionId as string, revision: row.revision as number,
      replayed: row.replayed as boolean, scenario,
    };
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
}

/** Generating request keys is server-side for future authenticated entrypoints. */
export function newOliviaDraftRequestKey(): string { return randomUUID(); }
