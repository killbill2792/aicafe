import { describe, expect, it } from "vitest";
import { optimizeOliviaWeek } from "./plannerEngine";
import {
  applyOliviaWhatIfOverlay, compareOliviaScenarios,
  type OliviaWhatIfOverride,
} from "./oliviaWhatIfOverlay";
import type { PlannerCoverage, PlannerEmployee, PlannerInput } from "./plannerTypes";

const monday = "2026-10-12";
const recurring = (day: number, start = "09:00", end = "17:00") => ({
  day_of_week: day, start_local: start, end_local: end, overnight: false,
  effective_from: "2026-01-01", effective_to: null, confirmation: "owner_confirmed" as const,
});
const employee = (id: string, options: Partial<PlannerEmployee> = {}): PlannerEmployee => ({
  id, displayName: id, active: true,
  recurring: [0, 1, 2, 3, 4, 5, 6].map(d => recurring(d)),
  exceptions: [], qualifications: [{ code: "barista", validFrom: "2026-01-01", confirmed: true }],
  wage: { wage_period: "hour", wage_amount_cents: 1600, default_hourly_wage_cents: null },
  provenance: "known_paid", ...options,
});
const coverage = (id: string, opts: Partial<PlannerCoverage> = {}): PlannerCoverage => ({
  id, locationId: "a", dayOfWeek: 1, localDate: null, effectiveFrom: monday,
  effectiveTo: null, start_local: "09:00", end_local: "11:00", overnight: false,
  minHeadcount: 1, qualificationCode: "barista", priority: "required", ...opts,
});
const input = (people: PlannerEmployee[], requirements: PlannerCoverage[],
  other: Partial<PlannerInput> = {}): PlannerInput => ({
  horizonStart: monday,
  locations: [{ id: "a", timezone: "America/Los_Angeles" }],
  employees: people, coverage: requirements,
  slotMinutes: 60, burden: { rate: 0.12, status: "estimate" }, ...other,
});

describe("applyOliviaWhatIfOverlay", () => {
  it("never mutates the original snapshot", () => {
    const base = input([employee("ava")], [coverage("c1")]);
    const snapshot = JSON.stringify(base);
    const result = applyOliviaWhatIfOverlay(base, [
      { kind: "temporary_unavailable", employeeId: "ava", localDate: monday },
    ]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("rejects an unknown employee id", () => {
    const base = input([employee("ava")], [coverage("c1")]);
    const result = applyOliviaWhatIfOverlay(base, [
      { kind: "temporary_unavailable", employeeId: "ghost", localDate: monday },
    ]);
    expect(result).toEqual({ ok: false, error: "employee_not_found" });
  });

  it("rejects a date outside the requested horizon week", () => {
    const base = input([employee("ava")], [coverage("c1")]);
    const result = applyOliviaWhatIfOverlay(base, [
      { kind: "temporary_unavailable", employeeId: "ava", localDate: "2026-11-01" },
    ]);
    expect(result).toEqual({ ok: false, error: "date_out_of_range" });
  });

  it("rejects an empty or oversized override list", () => {
    const base = input([employee("ava")], [coverage("c1")]);
    expect(applyOliviaWhatIfOverlay(base, [])).toEqual({ ok: false, error: "no_overrides" });
    const many: OliviaWhatIfOverride[] = Array.from({ length: 21 }, () => (
      { kind: "reduce_weekly_minutes", employeeId: "ava", maxWeeklyMinutes: 60 }
    ));
    expect(applyOliviaWhatIfOverlay(base, many)).toEqual({ ok: false, error: "too_many_overrides" });
  });

  it("never raises an existing weekly cap, only lowers it by minimum", () => {
    const base = input([employee("ava", { maxWeeklyMinutes: 600 })], [coverage("c1")]);
    const raised = applyOliviaWhatIfOverlay(base, [
      { kind: "reduce_weekly_minutes", employeeId: "ava", maxWeeklyMinutes: 900 },
    ]);
    expect(raised.ok).toBe(true);
    if (raised.ok) expect(raised.input.employees[0].maxWeeklyMinutes).toBe(600);
    const lowered = applyOliviaWhatIfOverlay(base, [
      { kind: "reduce_weekly_minutes", employeeId: "ava", maxWeeklyMinutes: 300 },
    ]);
    expect(lowered.ok).toBe(true);
    if (lowered.ok) expect(lowered.input.employees[0].maxWeeklyMinutes).toBe(300);
  });

  it("rejects a weekly cap reduced below the employee's recorded minimum hours", () => {
    const base = input([employee("ava", { minWeeklyMinutes: 480 })], [coverage("c1")]);
    const result = applyOliviaWhatIfOverlay(base, [
      { kind: "reduce_weekly_minutes", employeeId: "ava", maxWeeklyMinutes: 120 },
    ]);
    expect(result).toEqual({ ok: false, error: "below_minimum_hours" });
  });

  it("combines a daily cap override with any existing same-date cap by minimum", () => {
    const base = input([employee("ava", {
      exceptions: [{ local_date: monday, exception_type: "hours_cap", max_minutes: 240,
        confirmation: "owner_confirmed" }],
    })], [coverage("c1")]);
    const result = applyOliviaWhatIfOverlay(base, [
      { kind: "reduce_daily_minutes", employeeId: "ava", localDate: monday, maxMinutes: 360 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const caps = result.input.employees[0].exceptions
      .filter(e => e.exception_type === "hours_cap" && e.local_date === monday)
      .map(e => e.max_minutes);
    expect(caps.sort()).toEqual([240, 360]);
  });

  it("marks a full-day hypothetical absence as an unavailable exception, not a positive grant", () => {
    const base = input([employee("ava")], [coverage("c1")]);
    const result = applyOliviaWhatIfOverlay(base, [
      { kind: "temporary_unavailable", employeeId: "ava", localDate: monday },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [exception] = result.input.employees[0].exceptions;
    expect(exception).toEqual({
      local_date: monday, exception_type: "unavailable",
      start_local: null, end_local: null, confirmation: "owner_confirmed",
    });
  });

  it("leaves untargeted employees and the rest of the snapshot untouched", () => {
    const base = input([employee("ava"), employee("ben")], [coverage("c1")],
      { pinned: [], replanAsOf: "2026-10-12T00:00:00.000Z" });
    const result = applyOliviaWhatIfOverlay(base, [
      { kind: "temporary_unavailable", employeeId: "ava", localDate: monday },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.employees[1]).toBe(base.employees[1]);
    expect(result.input.pinned).toBe(base.pinned);
    expect(result.input.replanAsOf).toBe(base.replanAsOf);
  });
});

describe("compareOliviaScenarios", () => {
  it("reports changed:false when shifts and gaps are byte-identical", () => {
    const requests = [1].map(day => coverage(String(day), { dayOfWeek: day }));
    const base = input([employee("ava", { recurring: [recurring(1)] })], requests);
    const plan = optimizeOliviaWeek(base);
    const comparison = compareOliviaScenarios(plan.best!, plan.best!);
    expect(comparison.changed).toBe(false);
    expect(comparison.ownerMinutesDifference).toBe(0);
    expect(comparison.gapsDifference).toBe(0);
  });

  it("reports changed:true and the exact cost/coverage delta for a real re-optimization", () => {
    const requests = [coverage("c1", { dayOfWeek: 1 })];
    const five = [
      employee("ava", { recurring: [recurring(1, "09:00", "11:00")] }),
      employee("ben", { recurring: [recurring(1, "09:00", "11:00")] }),
    ];
    const baselineInput = input(five, requests);
    const baselinePlan = optimizeOliviaWeek(baselineInput);
    expect(baselinePlan.status).toBe("feasible");
    expect(baselinePlan.best?.shifts.some(s => s.employeeId === "ava")).toBe(true);

    // Hypothetical: Ava is unavailable Monday morning. Ben must cover instead.
    const overlay = applyOliviaWhatIfOverlay(baselineInput, [
      { kind: "temporary_unavailable", employeeId: "ava", localDate: monday,
        window: { startLocal: "00:00", endLocal: "12:00", overnight: false } },
    ]);
    expect(overlay.ok).toBe(true);
    if (!overlay.ok) return;
    const alternatePlan = optimizeOliviaWeek(overlay.input);
    expect(alternatePlan.status).toBe("feasible");
    expect(alternatePlan.best?.shifts.every(s => s.employeeId !== "ava")).toBe(true);
    expect(alternatePlan.best?.shifts.some(s => s.employeeId === "ben")).toBe(true);

    const comparison = compareOliviaScenarios(baselinePlan.best!, alternatePlan.best!);
    expect(comparison.changed).toBe(true);
    expect(comparison.completeCoverageBefore).toBe(true);
    expect(comparison.completeCoverageAfter).toBe(true);
  });

  it("surfaces a justified infeasibility instead of a false coverage claim when nobody is left", () => {
    const requests = [coverage("c1", { dayOfWeek: 1 })];
    const solo = input([employee("ava", { recurring: [recurring(1, "09:00", "11:00")] })], requests);
    const baselinePlan = optimizeOliviaWeek(solo);
    expect(baselinePlan.status).toBe("feasible");

    const overlay = applyOliviaWhatIfOverlay(solo, [
      { kind: "temporary_unavailable", employeeId: "ava", localDate: monday },
    ]);
    expect(overlay.ok).toBe(true);
    if (!overlay.ok) return;
    const alternatePlan = optimizeOliviaWeek(overlay.input);
    expect(alternatePlan.status).toBe("infeasible");
    expect(alternatePlan.best?.completeCoverage).toBe(false);
    expect(alternatePlan.best?.gaps.length).toBeGreaterThan(0);

    const comparison = compareOliviaScenarios(baselinePlan.best!, alternatePlan.best!);
    expect(comparison.changed).toBe(true);
    expect(comparison.completeCoverageBefore).toBe(true);
    expect(comparison.completeCoverageAfter).toBe(false);
    expect(comparison.gapsDifference).toBeGreaterThan(0);
  });

  it("does not claim a change when the hypothetical override has no observable effect", () => {
    const requests = [coverage("c1", { dayOfWeek: 1 })];
    const five = [
      employee("ava", { recurring: [recurring(1, "09:00", "11:00")] }),
      employee("ben", { recurring: [recurring(1, "09:00", "11:00")] }),
    ];
    const baselineInput = input(five, requests);
    const baselinePlan = optimizeOliviaWeek(baselineInput);

    // Ben is unavailable on a day he was never scheduled -- no real effect.
    const overlay = applyOliviaWhatIfOverlay(baselineInput, [
      { kind: "temporary_unavailable", employeeId: "ben", localDate: "2026-10-15" },
    ]);
    expect(overlay.ok).toBe(true);
    if (!overlay.ok) return;
    const alternatePlan = optimizeOliviaWeek(overlay.input);
    const comparison = compareOliviaScenarios(baselinePlan.best!, alternatePlan.best!);
    expect(comparison.changed).toBe(false);
  });
});
