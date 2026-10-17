/**
 * Olivia PR4A-2 pure hypothetical overlay. No DB, no auth, no AI: a deterministic
 * transform of an already-trusted PlannerInput snapshot for a single transient
 * what-if simulation. Every override can only SUBTRACT from recorded availability
 * or LOWER an existing hour cap -- it can never invent positive availability,
 * raise a cap, or touch anything outside employees[]. The caller's snapshot is
 * reused by reference wherever an employee is not targeted; nothing is mutated
 * in place, so the same loaded PlannerInput stays safe to reuse for a baseline run.
 */
import type { AvailabilityException } from "./availability";
import { normalizeSchedulingWallTime } from "./availability";
import { civilDateAdd } from "./plannerClock";
import type { PlannerEmployee, PlannerInput, PlannerScenario } from "./plannerTypes";

export type OliviaTemporaryUnavailableOverride = {
  kind: "temporary_unavailable";
  employeeId: string;
  /** Civil date, must fall within the requested horizon week. */
  localDate: string;
  /** Omit for a full-day hypothetical absence. */
  window?: { startLocal: string; endLocal: string; overnight: boolean };
};
export type OliviaReduceWeeklyMinutesOverride = {
  kind: "reduce_weekly_minutes";
  employeeId: string;
  /** Combined with any existing cap by MIN -- this can only lower the cap. */
  maxWeeklyMinutes: number;
};
export type OliviaReduceDailyMinutesOverride = {
  kind: "reduce_daily_minutes";
  employeeId: string;
  localDate: string;
  /** Combined with any existing same-date cap by MIN. */
  maxMinutes: number;
};
export type OliviaWhatIfOverride =
  | OliviaTemporaryUnavailableOverride
  | OliviaReduceWeeklyMinutesOverride
  | OliviaReduceDailyMinutesOverride;

export type OliviaOverlayError =
  | "no_overrides" | "too_many_overrides" | "employee_not_found"
  | "date_out_of_range" | "invalid_window" | "below_minimum_hours";
export type OliviaOverlayResult =
  | { ok: true; input: PlannerInput; applied: readonly OliviaWhatIfOverride[] }
  | { ok: false; error: OliviaOverlayError };

export const OLIVIA_MAX_WHAT_IF_OVERRIDES = 20;

export function applyOliviaWhatIfOverlay(
  input: PlannerInput, overrides: readonly OliviaWhatIfOverride[],
): OliviaOverlayResult {
  if (overrides.length === 0) return { ok: false, error: "no_overrides" };
  if (overrides.length > OLIVIA_MAX_WHAT_IF_OVERRIDES)
    return { ok: false, error: "too_many_overrides" };
  let horizonEnd: string;
  try {
    horizonEnd = civilDateAdd(input.horizonStart, 6);
  } catch {
    return { ok: false, error: "date_out_of_range" };
  }
  const byId = new Map(input.employees.map(e => [e.id, e]));
  type Patch = { exceptions: AvailabilityException[]; maxWeeklyMinutes?: number | null };
  const patches = new Map<string, Patch>();
  const patchFor = (id: string): Patch => {
    let patch = patches.get(id);
    if (!patch) { patch = { exceptions: [] }; patches.set(id, patch); }
    return patch;
  };
  for (const override of overrides) {
    const employee = byId.get(override.employeeId);
    if (!employee) return { ok: false, error: "employee_not_found" };
    if (override.kind !== "reduce_weekly_minutes" &&
        (override.localDate < input.horizonStart || override.localDate > horizonEnd))
      return { ok: false, error: "date_out_of_range" };
    try {
      switch (override.kind) {
        case "temporary_unavailable": {
          const patch = patchFor(override.employeeId);
          if (override.window) {
            patch.exceptions.push({
              local_date: override.localDate, exception_type: "unavailable",
              start_local: normalizeSchedulingWallTime(override.window.startLocal),
              end_local: normalizeSchedulingWallTime(override.window.endLocal),
              overnight: override.window.overnight,
              confirmation: "owner_confirmed",
            });
          } else {
            patch.exceptions.push({
              local_date: override.localDate, exception_type: "unavailable",
              start_local: null, end_local: null, confirmation: "owner_confirmed",
            });
          }
          break;
        }
        case "reduce_daily_minutes": {
          patchFor(override.employeeId).exceptions.push({
            local_date: override.localDate, exception_type: "hours_cap",
            max_minutes: override.maxMinutes, confirmation: "owner_confirmed",
          });
          break;
        }
        case "reduce_weekly_minutes": {
          const patch = patchFor(override.employeeId);
          const current = patch.maxWeeklyMinutes !== undefined
            ? patch.maxWeeklyMinutes : employee.maxWeeklyMinutes ?? null;
          const next = current === null
            ? override.maxWeeklyMinutes : Math.min(current, override.maxWeeklyMinutes);
          if (employee.minWeeklyMinutes != null && next < employee.minWeeklyMinutes)
            return { ok: false, error: "below_minimum_hours" };
          patch.maxWeeklyMinutes = next;
          break;
        }
      }
    } catch {
      return { ok: false, error: "invalid_window" };
    }
  }
  const employees: PlannerEmployee[] = input.employees.map(employee => {
    const patch = patches.get(employee.id);
    if (!patch) return employee;
    return {
      ...employee,
      exceptions: [...employee.exceptions, ...patch.exceptions],
      ...(patch.maxWeeklyMinutes !== undefined
        ? { maxWeeklyMinutes: patch.maxWeeklyMinutes } : {}),
    };
  });
  return { ok: true, input: { ...input, employees }, applied: overrides };
}

export type OliviaScenarioComparison = {
  ownerMinutesDifference: number;
  cashWagesDifferenceCents: number | null;
  loadedPayrollDifferenceCents: number | null;
  gapsDifference: number;
  completeCoverageBefore: boolean;
  completeCoverageAfter: boolean;
  /** True only when the alternate scenario's shifts or gaps actually differ
   * from the baseline. An override that structurally applied but changed
   * nothing observable must never be reported as a change. */
  changed: boolean;
};

export function compareOliviaScenarios(
  baseline: PlannerScenario, alternate: PlannerScenario,
): OliviaScenarioComparison {
  const delta = (left: number | null, right: number | null): number | null =>
    left === null || right === null ? null : right - left;
  const sameShifts = JSON.stringify(baseline.shifts) === JSON.stringify(alternate.shifts);
  const sameGaps = JSON.stringify(baseline.gaps) === JSON.stringify(alternate.gaps);
  return {
    ownerMinutesDifference: alternate.ownerMinutes - baseline.ownerMinutes,
    cashWagesDifferenceCents: delta(baseline.cost.cashWagesCents, alternate.cost.cashWagesCents),
    loadedPayrollDifferenceCents:
      delta(baseline.cost.loadedPayrollCents, alternate.cost.loadedPayrollCents),
    gapsDifference: alternate.gaps.length - baseline.gaps.length,
    completeCoverageBefore: baseline.completeCoverage,
    completeCoverageAfter: alternate.completeCoverage,
    changed: !(sameShifts && sameGaps),
  };
}
