import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/scheduling/oliviaCapabilities.server", () => ({
  executeOliviaReadCapability: vi.fn(),
}));
vi.mock("@/lib/metrics/p1Readers.server", () => ({
  authorizedOwnerP1: vi.fn(),
}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server", () => ({
  readAuthorizedAtomicP1SourceSnapshot: vi.fn(),
}));

import { createSupervisorToolRegistry, type SupervisorToolCall } from "./toolRegistry.server";
import { executeOliviaReadCapability } from "@/lib/scheduling/oliviaCapabilities.server";
import { authorizedOwnerP1 } from "@/lib/metrics/p1Readers.server";
import { readAuthorizedAtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { AtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";

const olivia = vi.mocked(executeOliviaReadCapability);
const ownerP1 = vi.mocked(authorizedOwnerP1);
const atomicRpc = vi.mocked(readAuthorizedAtomicP1SourceSnapshot);

const businessId = "a0000000-0000-4000-8000-000000000999";
const avaId = "a0000000-0000-4000-8000-000000000001";
const benId = "a0000000-0000-4000-8000-000000000002";
const locationId = "a0000000-0000-4000-8000-000000000020";
const monday = "2026-10-12";
const iso = (h: string) => monday + "T" + h + ":00:00.000Z";

const tools = {} as unknown as BusinessScopedCafeTools;
const registry = createSupervisorToolRegistry({ tools, asOf: monday, cafeName: "Sample",
  timezone: "America/Los_Angeles", readRules: async () => [] });
const execute = (name: SupervisorToolCall["name"], args: Record<string, unknown>, index = 1) =>
  registry({ name, arguments: args, call_id: "c" + index }, index);

beforeEach(() => {
  olivia.mockReset();
  ownerP1.mockReset();
  atomicRpc.mockReset();
  ownerP1.mockResolvedValue({
    tools: {} as BusinessScopedCafeTools,
    identity: { businessId, currency: "USD", cafeName: "Sample", timezone: "America/Los_Angeles", asOf: monday },
  });
});

describe("olivia_availability", () => {
  it("resolves an unambiguous employee and shows their real availability state", async () => {
    olivia.mockResolvedValue({
      ok: true, version: 1, status: "ok", capability: "olivia.availability.read",
      source: { owner: "olivia", businessId, kind: "stored_availability", consistency: "provisional" },
      employees: [
        { employeeId: avaId, displayName: "Ava", active: true, state: "confirmed",
          recurring: [], exceptions: [], hourLimits: [], preferences: [], qualifications: [], compensation: [] },
        { employeeId: benId, displayName: "Ben", active: true, state: "missing",
          recurring: [], exceptions: [], hourLimits: [], preferences: [], qualifications: [], compensation: [] },
      ],
    });
    const result = await execute("olivia_availability", { employee_name: "Ava" });
    expect(result.facts).toContainEqual(expect.objectContaining({ label: "Matching employees", value: 1 }));
    expect(result.insights.some(i => i.text.includes("Ava") && i.text.includes("confirmed"))).toBe(true);
    expect(result.data).toMatchObject({ employees: [{ id: avaId, name: "Ava" }] });
  });

  it("flags an ambiguous name instead of guessing which employee is meant", async () => {
    olivia.mockResolvedValue({
      ok: true, version: 1, status: "ok", capability: "olivia.availability.read",
      source: { owner: "olivia", businessId, kind: "stored_availability", consistency: "provisional" },
      employees: [
        { employeeId: avaId, displayName: "Sam", active: true, state: "confirmed",
          recurring: [], exceptions: [], hourLimits: [], preferences: [], qualifications: [], compensation: [] },
        { employeeId: benId, displayName: "Sam", active: true, state: "confirmed",
          recurring: [], exceptions: [], hourLimits: [], preferences: [], qualifications: [], compensation: [] },
      ],
    });
    const result = await execute("olivia_availability", { employee_name: "Sam" });
    expect(result.status).toBe("partial");
    expect(result.insights.some(i => i.text.includes("More than one employee matches"))).toBe(true);
  });

  it("fails closed when Olivia reports unauthorized/disabled without fabricating a roster", async () => {
    olivia.mockResolvedValue({ ok: false, version: 1, status: "error", capability: "olivia.availability.read",
      error: { code: "disabled", retryable: false, message: "x" } });
    const result = await execute("olivia_availability", { employee_name: null });
    expect(result.status).toBe("unavailable");
    expect(result.facts).toEqual([]);
  });
});

describe("olivia_schedule preview", () => {
  const shift = { employeeId: avaId, locationId, startAt: iso("09"), endAt: iso("17"),
    paidMinutes: 480, breaks: [], pinned: false };
  const scenario = {
    objective: "cash" as const, shifts: [shift],
    gaps: [{ coverageId: "a0000000-0000-4000-8000-000000000040", locationId,
      startAt: iso("17"), endAt: iso("19"), qualificationCode: "barista",
      missingHeadcount: 1, reason: "no_confirmed_availability" as const }],
    completeCoverage: false, hardConstraintsSatisfied: true, ownerMinutes: 0,
    cost: { cashWagesCents: 6400, allocatedSalaryCents: 0, loadedPayrollCents: 7168,
      ownerOpportunityCents: 0, ownerMinutes: 0, costState: "verified" as const, missingWageEmployeeIds: [] },
    preferencePenalty: 0, exploredNodes: 10, legalReview: "unverified_profile" as const,
  };

  it("renders real shift and gap evidence with café-local times, never raw UTC", async () => {
    olivia.mockResolvedValue({
      ok: true, version: 1, status: "ok", capability: "olivia.schedule.preview",
      source: { owner: "olivia", businessId, kind: "trusted_preview", consistency: "provisional" },
      plan: { status: "feasible", horizonStart: monday, horizonEnd: "2026-10-18",
        scenarios: [scenario], best: scenario, comparisons: [], warnings: [], proof: "complete_candidate_solution" },
      selectedScenario: scenario, previewRevision: 0, notices: [],
      blockers: [], employeeNames: { [avaId]: "Ava" }, locationNames: { [locationId]: "Main" },
      frozenShiftKeys: [], disposition: "proposal_only",
    });
    const result = await execute("olivia_schedule", { action: "preview", week: monday, objective: null, overrides: null });
    expect(result.facts).toContainEqual(expect.objectContaining({ label: "Loaded weekly labor cost", value: 7168 }));
    expect(result.facts).toContainEqual(expect.objectContaining({ label: "Uncovered coverage slots", value: 1 }));
    expect(result.status).toBe("partial");
    expect(result.insights.some(i => i.text.startsWith("Ava: Mon ") && i.text.includes(" to "))).toBe(true);
    expect(result.insights.some(i => i.text.includes("not a saved or published schedule"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(iso("09"));
  });

  it("rejects a week argument that is not a Monday", async () => {
    const result = await execute("olivia_schedule", { action: "preview", week: "2026-10-13", objective: null, overrides: null });
    expect(result.status).toBe("unavailable");
    expect(olivia).not.toHaveBeenCalled();
  });

  it("surfaces actionable setup blockers instead of claiming a plan", async () => {
    olivia.mockResolvedValue({ ok: false, version: 1, status: "error", capability: "olivia.schedule.preview",
      error: { code: "missing_inputs", retryable: false, message: "x" },
      blockers: [{ code: "no_coverage" }] });
    const result = await execute("olivia_schedule", { action: "preview", week: monday, objective: null, overrides: null });
    expect(result.status).toBe("unavailable");
    expect(result.insights.some(i => i.text.includes("Setup needed: no coverage"))).toBe(true);
  });
});

describe("olivia_schedule what_if", () => {
  const altShift = { employeeId: benId, locationId, startAt: iso("09"), endAt: iso("17"),
    paidMinutes: 480, breaks: [], pinned: false };
  const comparisonBase = {
    ownerMinutesDifference: 0, cashWagesDifferenceCents: 100, loadedPayrollDifferenceCents: 112, gapsDifference: 0,
    completeCoverageBefore: true, completeCoverageAfter: true,
  };

  it("reports a real recomputed alternate and a nonzero cost delta", async () => {
    olivia.mockResolvedValue({
      ok: true, version: 1, status: "ok", capability: "olivia.schedule.whatIf",
      source: { owner: "olivia", businessId, kind: "trusted_preview", consistency: "provisional" },
      baselineScenario: null, alternateScenario: { ...{
        objective: "cash" as const, shifts: [altShift], gaps: [], completeCoverage: true,
        hardConstraintsSatisfied: true, ownerMinutes: 0,
        cost: { cashWagesCents: 6500, allocatedSalaryCents: 0, loadedPayrollCents: 7280,
          ownerOpportunityCents: 0, ownerMinutes: 0, costState: "verified" as const, missingWageEmployeeIds: [] },
        preferencePenalty: 0, exploredNodes: 5, legalReview: "unverified_profile" as const,
      } },
      baselineStatus: "feasible", baselineProof: "complete_candidate_solution",
      baselineWarnings: [], alternateStatus: "feasible", alternateProof: "complete_candidate_solution",
      alternateWarnings: [], comparison: { ...comparisonBase, changed: true },
      overridesApplied: [{ kind: "temporary_unavailable", employeeId: avaId, localDate: monday }],
      notices: [], employeeNames: { [avaId]: "Ava", [benId]: "Ben" }, locationNames: { [locationId]: "Main" },
      disposition: "hypothetical_simulation_only",
    });
    const result = await execute("olivia_schedule", { action: "what_if", week: monday, objective: null,
      overrides: [{ kind: "temporary_unavailable", employee_id: avaId, local_date: monday,
        start_local: null, end_local: null, overnight: null, max_weekly_minutes: null, max_minutes: null }] });
    expect(result.facts).toContainEqual(expect.objectContaining({ label: "Schedule changed by this scenario", value: 1 }));
    expect(result.facts).toContainEqual(expect.objectContaining({ label: "Change in cash wages", value: 100 }));
    expect(result.insights.some(i => i.text.includes("Ben: Mon "))).toBe(true);
    expect(result.insights.some(i => i.text.includes("no effect"))).toBe(false);
  });

  it("never claims an effect when the override changed nothing", async () => {
    olivia.mockResolvedValue({
      ok: true, version: 1, status: "ok", capability: "olivia.schedule.whatIf",
      source: { owner: "olivia", businessId, kind: "trusted_preview", consistency: "provisional" },
      baselineScenario: null, alternateScenario: null,
      baselineStatus: "feasible", baselineProof: "complete_candidate_solution", baselineWarnings: [],
      alternateStatus: "feasible", alternateProof: "complete_candidate_solution", alternateWarnings: [],
      comparison: { ...comparisonBase, cashWagesDifferenceCents: 0, changed: false },
      overridesApplied: [], notices: [], employeeNames: {}, locationNames: {},
      disposition: "hypothetical_simulation_only",
    });
    const result = await execute("olivia_schedule", { action: "what_if", week: monday, objective: null,
      overrides: [{ kind: "temporary_unavailable", employee_id: benId, local_date: "2026-10-15",
        start_local: null, end_local: null, overnight: null, max_weekly_minutes: null, max_minutes: null }] });
    expect(result.insights.some(i => i.text.includes("does not affect the proposed schedule"))).toBe(true);
  });

  it("requires at least one override for a what_if request", async () => {
    const result = await execute("olivia_schedule", { action: "what_if", week: monday, objective: null, overrides: null });
    expect(result.status).toBe("unavailable");
    expect(olivia).not.toHaveBeenCalled();
  });

  it("rejects a structurally invalid override before calling Olivia", async () => {
    const result = await execute("olivia_schedule", { action: "what_if", week: monday, objective: null,
      overrides: [{ kind: "reduce_weekly_minutes", employee_id: avaId, local_date: null,
        start_local: null, end_local: null, overnight: null, max_weekly_minutes: null, max_minutes: null }] });
    expect(result.status).toBe("unavailable");
    expect(olivia).not.toHaveBeenCalled();
  });
});

describe("alex_pricing_review / alex_pricing_what_if (real pricing math, mocked snapshot only)", () => {
  const productId = "a0000000-0000-4000-8000-000000000001";
  const ingredientId = "a0000000-0000-4000-8000-000000000100";
  const snapshot = {
    contract: "p1.authoritative_snapshot.v1", businessId, revision: "100",
    timezone: "America/Los_Angeles", currency: "USD",
    payroll: { rate: 0.12, status: "confirmed", source: "business" },
    sources: {
      menu: [{ id: productId, name: "Latte 12 oz", price_cents: 525, is_active: true,
        category: "ESPRESSO_DRINK" }],
      ingredients: [{ id: ingredientId, name: "Milk", base_unit: "ml" }],
      ingredientPrices: [{ id: "a0000000-0000-4000-8000-000000000200",
        ingredient_id: ingredientId, effective_from: "2026-09-01",
        cost_per_base_unit_micros: 100000, source: "manual" }],
      recipes: [{ menu_item_id: productId, ingredient_id: ingredientId, quantity: 200 }],
      employees: [], dailyRollups: [], expenses: [], recurringCosts: [], imports: [],
    },
    truncated: { menu: false, ingredients: false, ingredientPrices: false,
      recipes: false, employees: false, dailyRollups: false, expenses: false,
      recurringCosts: false, imports: false },
    coverage: "not_proven_by_revision",
  } as AtomicP1SourceSnapshot;

  beforeEach(() => {
    atomicRpc.mockResolvedValue({ status: "available", snapshot });
  });

  it("reviews a specifically named product with real recipe-based ingredient cost", async () => {
    const result = await execute("alex_pricing_review", {
      selection: "specific_name", product_name: "Latte 12 oz", product_id: null, offset: 0, limit: 25 });
    expect(result.facts).toContainEqual(expect.objectContaining({ label: "Products reviewed", value: 1 }));
    expect(result.insights.some(i => i.text.includes("Latte 12 oz") && i.text.includes("ingredient cost $0.20"))).toBe(true);
  });

  it("runs a real 30% ingredient-multiplier what-if and reports the actual cost delta", async () => {
    const result = await execute("alex_pricing_what_if", {
      product_name: "Latte 12 oz", product_id: null,
      changes: [{ kind: "ingredient_multiplier", ingredient_id: ingredientId,
        from_ingredient_id: null, to_ingredient_id: null, multiplier_basis_points: 13000,
        cost_per_base_unit_micros: null, package_cost_cents: null, package_count: null,
        package_unit: null, quantity_value: null, quantity_unit: null }],
      selling_price_delta_cents: 50, selling_price_replace_cents: null,
      target_cost_ratio_bps: null, target_ingredient_margin_bps: null });
    expect(result.facts).toContainEqual(expect.objectContaining({ label: "Price change", value: 50 }));
    const delta = result.facts.find(f => f.label === "Ingredient cost change");
    expect(delta?.value).toBeGreaterThan(0);
    expect(result.insights.some(i => i.text.includes("conditional what-if only"))).toBe(true);
  });

  it("supports a target-only price recommendation with zero ingredient edits", async () => {
    const result = await execute("alex_pricing_what_if", {
      product_name: "Latte 12 oz", product_id: null, changes: [],
      selling_price_delta_cents: null, selling_price_replace_cents: null,
      target_cost_ratio_bps: 3000, target_ingredient_margin_bps: null,
    });
    expect(result.status).not.toBe("unavailable");
    expect(result.insights).toContainEqual(expect.objectContaining({
      text: expect.stringContaining("Conditional target price"),
    }));
    expect(result.insights.some(i => i.text.includes("no price or recipe has been changed"))).toBe(true);
  });

  it("rejects a pricing what-if with neither edits nor targets", async () => {
    const result = await execute("alex_pricing_what_if", {
      product_name: "Latte 12 oz", product_id: null, changes: [],
      selling_price_delta_cents: null, selling_price_replace_cents: null,
      target_cost_ratio_bps: null, target_ingredient_margin_bps: null,
    });
    expect(result.status).toBe("unavailable");
  });

  it("fails closed without calling Alex when both a name and an invalid change are absent", async () => {
    const result = await execute("alex_pricing_review", {
      selection: "specific_name", product_name: null, product_id: null, offset: 0, limit: 25 });
    expect(result.status).toBe("unavailable");
    expect(atomicRpc).not.toHaveBeenCalled();
  });
});
