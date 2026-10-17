import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  owner: vi.fn(),
  loadOliviaWeekFromSavedStaff: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./foundation.server", () => ({
  requireSchedulingOwner: m.owner,
  readSchedulingFoundation: vi.fn(),
}));
vi.mock("./planInput.server", () => ({
  loadOliviaWeekFromSavedStaff: m.loadOliviaWeekFromSavedStaff,
}));
vi.mock("@/lib/actions/oliviaPlanning", () => ({
  previewOliviaWeek: vi.fn(), readOliviaPlanHistory: vi.fn(), readOliviaPlanRevision: vi.fn(),
}));

import { executeOliviaReadCapability } from "./oliviaCapabilities.server";
import { oliviaSnapshotDigest } from "./planDrafts.server";
import type { PlannerEmployee, PlannerInput } from "@/lib/calc/scheduling/plannerTypes";

const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const businessId = uid(901);
const otherBusinessId = uid(902);
const avaId = uid(1);
const benId = uid(2);
const locationId = uid(20);
const monday = "2026-10-12";

const recurring = (day: number, start = "09:00", end = "17:00") => ({
  day_of_week: day, start_local: start, end_local: end, overnight: false,
  effective_from: "2026-01-01", effective_to: null, confirmation: "owner_confirmed" as const,
});
const employee = (id: string, name: string, options: Partial<PlannerEmployee> = {}): PlannerEmployee => ({
  id, displayName: name, active: true,
  recurring: [recurring(1, "09:00", "11:00")],
  exceptions: [], qualifications: [{ code: "barista", validFrom: "2026-01-01", confirmed: true }],
  wage: { wage_period: "hour", wage_amount_cents: 1600, default_hourly_wage_cents: null },
  provenance: "known_paid", ...options,
});
function trustedInput(): PlannerInput {
  return {
    horizonStart: monday,
    locations: [{ id: locationId, timezone: "America/Los_Angeles" }],
    employees: [employee(avaId, "Ava"), employee(benId, "Ben")],
    coverage: [{
      id: uid(40), locationId, dayOfWeek: 1, localDate: null, effectiveFrom: monday,
      effectiveTo: null, start_local: "09:00", end_local: "11:00", overnight: false,
      minHeadcount: 1, qualificationCode: "barista", priority: "required",
    }],
    slotMinutes: 60, burden: { rate: 0.12, status: "estimate" },
  };
}
function loaded(overrides: Partial<Awaited<ReturnType<typeof m.loadOliviaWeekFromSavedStaff>>> = {}) {
  const input = trustedInput();
  return {
    ok: true as const, businessId, sourceFingerprint: "fp-1", sourceToken: "a".repeat(32),
    locationNames: { [locationId]: "Main" }, warnings: [], notices: [], blockers: [],
    input, ...overrides,
  };
}
const whatIf = (overrides: unknown, options?: Record<string, unknown>) => ({
  capability: "olivia.schedule.whatIf", version: 1, week: monday, overrides,
  ...(options ? { options } : {}),
});

beforeEach(() => {
  m.owner.mockReset();
  m.loadOliviaWeekFromSavedStaff.mockReset();
  m.owner.mockResolvedValue({ businessId, supabase: {} });
});

describe("olivia.schedule.whatIf", () => {
  it("runs the real optimizer twice and reports an actual coverage/cost delta", async () => {
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(loaded());
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday,
        window: { startLocal: "00:00", endLocal: "12:00", overnight: false } },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok || result.capability !== "olivia.schedule.whatIf") throw new Error("unexpected");
    expect(result.baselineScenario?.shifts.some(s => s.employeeId === avaId)).toBe(true);
    expect(result.alternateScenario?.shifts.every(s => s.employeeId !== avaId)).toBe(true);
    expect(result.alternateScenario?.shifts.some(s => s.employeeId === benId)).toBe(true);
    expect(result.comparison?.changed).toBe(true);
    expect(result.disposition).toBe("hypothetical_simulation_only");
    expect(result.overridesApplied).toHaveLength(1);
  });

  it("reports changed:false for an override with no observable effect", async () => {
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(loaded());
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: benId, localDate: "2026-10-15" },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok || result.capability !== "olivia.schedule.whatIf") throw new Error("unexpected");
    expect(result.comparison?.changed).toBe(false);
  });

  it("rejects an override naming an employee the trusted loader never resolved", async () => {
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(loaded());
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: uid(999), localDate: monday },
    ]));
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("surfaces actionable setup blockers instead of a false simulation", async () => {
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(loaded({ blockers: [{ code: "no_coverage" }] }));
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday },
    ]));
    expect(result).toMatchObject({ ok: false, error: { code: "missing_inputs" },
      blockers: [{ code: "no_coverage" }] });
  });

  it("rejects a stale expected source digest without running any simulation", async () => {
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(loaded());
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday },
    ], { expectedSourceDigest: "f".repeat(64) }));
    expect(result).toMatchObject({ ok: false, error: { code: "source_changed" } });
  });

  it("accepts a matching expected source digest", async () => {
    const snapshot = loaded();
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(snapshot);
    const digest = oliviaSnapshotDigest(snapshot.input, snapshot.sourceFingerprint);
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday },
    ], { expectedSourceDigest: digest }));
    expect(result.ok).toBe(true);
  });

  it("reauthorizes before using the trusted snapshot if the active café changes mid-request", async () => {
    m.owner.mockResolvedValueOnce({ businessId, supabase: {} })
      .mockResolvedValueOnce({ businessId: otherBusinessId, supabase: {} });
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(loaded());
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday },
    ]));
    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("rejects a trusted snapshot resolved for a different café than the current session", async () => {
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(loaded({ businessId: otherBusinessId }));
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday },
    ]));
    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("fails closed when the trusted source loader is disabled", async () => {
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue({ ok: false, error: "disabled" });
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday },
    ]));
    expect(result).toMatchObject({ ok: false, error: { code: "disabled" } });
  });

  it("rejects malformed override payloads before touching the trusted loader", async () => {
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: "not-a-uuid", localDate: monday },
    ]));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(m.loadOliviaWeekFromSavedStaff).not.toHaveBeenCalled();
  });

  it("rejects an empty overrides array and an unauthenticated caller", async () => {
    const empty = await executeOliviaReadCapability(whatIf([]));
    expect(empty).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    m.owner.mockResolvedValue(null);
    const unauthed = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday },
    ]));
    expect(unauthed).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("rejects a weekly-hours override that would fall below recorded minimum hours", async () => {
    const snapshot = loaded();
    snapshot.input.employees[0].minWeeklyMinutes = 600;
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(snapshot);
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "reduce_weekly_minutes", employeeId: avaId, maxWeeklyMinutes: 60 },
    ]));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("selects a scenario by requested objective and documents an infeasible one as null", async () => {
    m.loadOliviaWeekFromSavedStaff.mockResolvedValue(loaded());
    const result = await executeOliviaReadCapability(whatIf([
      { kind: "temporary_unavailable", employeeId: avaId, localDate: monday },
    ], { objective: "cash" }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.capability !== "olivia.schedule.whatIf") throw new Error("unexpected");
    expect(result.baselineScenario?.objective).toBe("cash");
    expect(result.alternateScenario?.objective).toBe("cash");
  });
});
