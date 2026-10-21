/** Compatibility-only regression suite. Default conversational runtime acceptance
 * is in lib/ai/supervisor/investigation/runInvestigation.server.test.ts. */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/scheduling/oliviaCapabilities.server", () => ({
  executeOliviaReadCapability: vi.fn(),
}));
vi.mock("@/lib/metrics/p1Readers.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authorizedOwnerP1: vi.fn(),
}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server", () => ({
  readAuthorizedAtomicP1SourceSnapshot: vi.fn(),
}));

import { runLegacySupervisorTurn as runSupervisorTurn } from "./runSupervisorTurn.server";
import { executeOliviaReadCapability } from "@/lib/scheduling/oliviaCapabilities.server";
import { authorizedOwnerP1 } from "@/lib/metrics/p1Readers.server";
import { readAuthorizedAtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { AtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import type { RequestedGoal } from "./requestScope";

const olivia = vi.mocked(executeOliviaReadCapability);
const ownerP1 = vi.mocked(authorizedOwnerP1);
const atomicRpc = vi.mocked(readAuthorizedAtomicP1SourceSnapshot);

let originalKey: string | undefined;
beforeAll(() => { originalKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "mock-key"; });
afterAll(() => { if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });

const businessId = "a0000000-0000-4000-8000-000000000999";
const avaId = "a0000000-0000-4000-8000-000000000001";
const benId = "a0000000-0000-4000-8000-000000000002";
const locationId = "a0000000-0000-4000-8000-000000000020";
const monday = "2026-10-19";
const iso = (h: string) => monday + "T" + h + ":00:00.000Z";

const call = (name: string, args: object, id: string) =>
  ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id });
const finish = (ids: string[], insightIds: string[] = []) => ({ type: "message", content: [{
  type: "output_text", text: JSON.stringify({ headline: "Here is the recorded picture",
    summary: "Based on the available café records", fact_ids: ids, task_ids: [],
    insight_ids: insightIds, evidence_refs: [] }),
}] });
const response = (output: unknown[]) => new Response(JSON.stringify({ status: "completed",
  model: "gpt-6-luna", usage: { input_tokens: 100, output_tokens: 40 }, output }), { status: 200 });
const auditPayload = (goals: RequestedGoal[]) => new Response(JSON.stringify({ status: "completed",
  model: "gpt-6-luna", usage: { input_tokens: 0, output_tokens: 0 }, output: [{ type: "message",
    content: [{ type: "output_text", text: JSON.stringify({ complete: true, ambiguous: false, goals }) }] }] }), { status: 200 });

const scheduleGoal: RequestedGoal = { domain: "staff_schedule", period: "month_to_date",
  from: null, to: null, comparison_period: null, comparison_from: null, comparison_to: null };
const schedulePlanGoal: RequestedGoal = { ...scheduleGoal, domain: "schedule_preview" };
const pricingGoal: RequestedGoal = { domain: "pricing_review", period: "month_to_date",
  from: null, to: null, comparison_period: null, comparison_from: null, comparison_to: null };

/** Sequences provider responses: main-loop rounds in order, with the scope
 * audit transparently interleaved wherever runSupervisorTurn actually sends it.
 * P3 runs unconditionally ahead of the legacy loop now, so every request here
 * also gives P3 a clean, cheap, two-call non-productive handoff (no validated
 * capability selected) rather than letting it consume a legacy-shaped mock
 * response meant for a later round. */
function sequencedTransport(mainRounds: Response[], auditGoals: RequestedGoal[]) {
  let mainIndex = 0;
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { text?: { format?: { name?: string } } };
    const schema = body.text?.format?.name;
    if (schema === "supervisor_scope_audit") return auditPayload(auditGoals);
    if (schema === "p2_goal_audit") return response([{ type: "message", content: [
      { type: "output_text", text: JSON.stringify({ complete: true, clauses: ["."] }) }] }]);
    if (schema === "p2_capability_selection") return response([]);
    const next = mainRounds[mainIndex];
    mainIndex++;
    return next;
  });
}

const base = {
  locale: "en" as const, asOf: monday, cafeName: "Sample Café", timezone: "America/Los_Angeles",
  tools: {} as unknown as BusinessScopedCafeTools, history: [],
  readRules: async () => [],
};

beforeEach(() => {
  olivia.mockReset();
  ownerP1.mockReset();
  atomicRpc.mockReset();
  ownerP1.mockResolvedValue({
    tools: {} as BusinessScopedCafeTools,
    identity: { businessId, currency: "USD", cafeName: "Sample", timezone: "America/Los_Angeles", asOf: monday },
  });
});

describe("Real Supervisor conversation entrypoint invokes Olivia and Alex (acceptance)", () => {
  it("a natural-language scheduling request invokes the real Olivia optimizer and returns a 7-day preview", async () => {
    const scenario = {
      objective: "cash" as const,
      shifts: [{ employeeId: avaId, locationId, startAt: iso("09"), endAt: iso("17"),
        paidMinutes: 480, breaks: [], pinned: false }],
      gaps: [], completeCoverage: true, hardConstraintsSatisfied: true, ownerMinutes: 0,
      cost: { cashWagesCents: 6400, allocatedSalaryCents: 0, loadedPayrollCents: 7168,
        ownerOpportunityCents: 0, ownerMinutes: 0, costState: "verified" as const, missingWageEmployeeIds: [] },
      preferencePenalty: 0, exploredNodes: 10, legalReview: "unverified_profile" as const,
    };
    olivia.mockResolvedValue({
      ok: true, version: 1, status: "ok", capability: "olivia.schedule.preview",
      source: { owner: "olivia", businessId, kind: "trusted_preview", consistency: "provisional" },
      plan: { status: "feasible", horizonStart: monday, horizonEnd: "2026-10-25",
        scenarios: [scenario], best: scenario, comparisons: [], warnings: [], proof: "complete_candidate_solution" },
      selectedScenario: scenario, previewRevision: 0, notices: [], blockers: [],
      employeeNames: { [avaId]: "Ava" }, locationNames: { [locationId]: "Main" },
      frozenShiftKeys: [], disposition: "proposal_only",
    });
    const transport = sequencedTransport([
      response([call("declare_request_scope", { goals: [schedulePlanGoal] }, "scope"),
        call("olivia_schedule", { action: "preview", week: monday, objective: "cash", overrides: null }, "c1")]),
      response([finish(["t1:laborCost", "t1:shifts"], ["t1:shift0", "t1:disposition"])]),
    ], [schedulePlanGoal]);
    const { reply } = await runSupervisorTurn({ ...base,
      text: "Make next week's schedule using my available employees. Minimize labor costs." }, transport);
    expect(olivia).toHaveBeenCalledWith(expect.objectContaining({ capability: "olivia.schedule.preview", week: monday }));
    expect(reply.blocks).toContainEqual(expect.objectContaining({ type: "metric", label: "Loaded weekly labor cost", valueCents: 7168 }));
    expect(reply.blocks).toContainEqual(expect.objectContaining({ type: "count", label: "Planned shifts", value: 1 }));
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("Ava: Mon "))).toBe(true);
    expect(reply.blocks.some(b => b.type === "text" &&
      b.text.includes("New hours mentioned only in chat were not saved or applied"))).toBe(true);
  });

  it("a follow-up what-if resolves the employee name and triggers a real recomputation with a cost delta", async () => {
    olivia.mockImplementation(async (raw: unknown) => {
      const input = raw as { capability: string };
      if (input.capability === "olivia.availability.read") {
        return { ok: true, version: 1, status: "ok", capability: "olivia.availability.read",
          source: { owner: "olivia", businessId, kind: "stored_availability", consistency: "provisional" },
          employees: [{ employeeId: benId, displayName: "Ben", active: true, state: "confirmed",
            recurring: [], exceptions: [], hourLimits: [], preferences: [], qualifications: [], compensation: [] }] };
      }
      const altShift = { employeeId: benId, locationId, startAt: iso("09"), endAt: iso("17"),
        paidMinutes: 480, breaks: [], pinned: false };
      return { ok: true, version: 1, status: "ok", capability: "olivia.schedule.whatIf",
        source: { owner: "olivia", businessId, kind: "trusted_preview", consistency: "provisional" },
        baselineScenario: null, alternateScenario: { objective: "cash" as const, shifts: [altShift], gaps: [],
          completeCoverage: true, hardConstraintsSatisfied: true, ownerMinutes: 0,
          cost: { cashWagesCents: 6600, allocatedSalaryCents: 0, loadedPayrollCents: 7392, ownerOpportunityCents: 0,
            ownerMinutes: 0, costState: "verified" as const, missingWageEmployeeIds: [] },
          preferencePenalty: 0, exploredNodes: 8, legalReview: "unverified_profile" as const },
        baselineStatus: "feasible", baselineProof: "complete_candidate_solution", baselineWarnings: [],
        alternateStatus: "feasible", alternateProof: "complete_candidate_solution", alternateWarnings: [],
        comparison: { ownerMinutesDifference: 0, cashWagesDifferenceCents: 200, loadedPayrollDifferenceCents: 224, gapsDifference: 0,
          completeCoverageBefore: true, completeCoverageAfter: true, changed: true },
        overridesApplied: [{ kind: "temporary_unavailable", employeeId: benId, localDate: "2026-10-20" }],
        notices: [], employeeNames: { [benId]: "Ben" }, locationNames: { [locationId]: "Main" },
        disposition: "hypothetical_simulation_only" };
    });
    const transport = sequencedTransport([
      response([call("declare_request_scope", { goals: [scheduleGoal] }, "scope"),
        call("olivia_availability", { employee_name: "Ben" }, "c1")]),
      response([call("olivia_schedule", { action: "what_if", week: monday, objective: null,
        overrides: [{ kind: "temporary_unavailable", employee_id: benId, local_date: "2026-10-20",
          start_local: null, end_local: null, overnight: null, max_weekly_minutes: null, max_minutes: null }] }, "c2")]),
      response([finish(["t2:changed", "t2:costDelta"], ["t2:altShift0"])]),
    ], [scheduleGoal]);
    const { reply } = await runSupervisorTurn({ ...base, text: "What if Ben doesn't work Tuesday?" }, transport);
    expect(olivia).toHaveBeenCalledWith(expect.objectContaining({ capability: "olivia.availability.read" }));
    expect(olivia).toHaveBeenCalledWith(expect.objectContaining({ capability: "olivia.schedule.whatIf",
      overrides: [expect.objectContaining({ employeeId: benId })] }));
    expect(reply.blocks).toContainEqual(expect.objectContaining({ label: "Change in cash wages", valueCents: 200 }));
  });

  it("a menu pricing review request invokes the real Alex pricing math", async () => {
    const productId = avaId, ingredientId = "a0000000-0000-4000-8000-000000000100";
    atomicRpc.mockResolvedValue({ status: "available", snapshot: {
      contract: "p1.authoritative_snapshot.v1", businessId, revision: "100",
      timezone: "America/Los_Angeles", currency: "USD",
      payroll: { rate: 0.12, status: "confirmed", source: "business" },
      sources: {
        menu: [{ id: productId, name: "Latte 12 oz", price_cents: 525, is_active: true, category: "ESPRESSO_DRINK" }],
        ingredients: [{ id: ingredientId, name: "Milk", base_unit: "ml" }],
        ingredientPrices: [{ id: "a0000000-0000-4000-8000-000000000200", ingredient_id: ingredientId,
          effective_from: "2026-09-01", cost_per_base_unit_micros: 100000, source: "manual" }],
        recipes: [{ menu_item_id: productId, ingredient_id: ingredientId, quantity: 200 }],
        employees: [], dailyRollups: [], expenses: [], recurringCosts: [], imports: [],
      },
      truncated: { menu: false, ingredients: false, ingredientPrices: false, recipes: false, employees: false,
        dailyRollups: false, expenses: false, recurringCosts: false, imports: false },
      coverage: "not_proven_by_revision",
    } as AtomicP1SourceSnapshot });
    const transport = sequencedTransport([
      response([call("declare_request_scope", { goals: [pricingGoal] }, "scope"),
        call("alex_pricing_review", { selection: "all_active", product_name: null, product_id: null,
          offset: 0, limit: 25 }, "c1")]),
      response([finish(["t1:count"], ["t1:item0"])]),
    ], [pricingGoal]);
    const { reply } = await runSupervisorTurn({ ...base, text: "Review the pricing of my entire menu." }, transport);
    expect(atomicRpc).toHaveBeenCalled();
    expect(reply.blocks).toContainEqual(expect.objectContaining({ type: "count", label: "Products reviewed", value: 1 }));
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("Latte 12 oz"))).toBe(true);
  });

  it("a real pricing what-if question reaches Alex's capability and is presented to the " +
    "owner directly through P3 -- proving the reachability gap found in review is fixed, " +
    "not just that the capability computes correctly in isolation", async () => {
    const productId = avaId, ingredientId = "a0000000-0000-4000-8000-000000000100";
    atomicRpc.mockResolvedValue({ status: "available", snapshot: {
      contract: "p1.authoritative_snapshot.v1", businessId, revision: "100",
      timezone: "America/Los_Angeles", currency: "USD",
      payroll: { rate: 0.12, status: "confirmed", source: "business" },
      sources: {
        menu: [{ id: productId, name: "Latte 12 oz", price_cents: 525, is_active: true, category: "ESPRESSO_DRINK" }],
        ingredients: [{ id: ingredientId, name: "Milk", base_unit: "ml" }],
        ingredientPrices: [{ id: "a0000000-0000-4000-8000-000000000200", ingredient_id: ingredientId,
          effective_from: "2026-09-01", cost_per_base_unit_micros: 100000, source: "manual" }],
        recipes: [{ menu_item_id: productId, ingredient_id: ingredientId, quantity: 200 }],
        employees: [], dailyRollups: [], expenses: [], recurringCosts: [], imports: [],
      },
      truncated: { menu: false, ingredients: false, ingredientPrices: false, recipes: false, employees: false,
        dailyRollups: false, expenses: false, recurringCosts: false, imports: false },
      coverage: "not_proven_by_revision",
    } as AtomicP1SourceSnapshot });
    const question = "What if I raise the Latte 12 oz by 50 cents?";
    const requests: string[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        text?: { format?: { name?: string } };
      };
      const schema = body.text?.format?.name;
      requests.push(schema ?? "unexpected");
      if (schema === "p2_goal_audit") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, clauses: [question] }) }] }]);
      if (schema === "p2_capability_selection") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, choices: [{
          clause: question, capabilityId: "p3.alex.pricing.what_if.v1",
          inputJson: JSON.stringify({ purpose: "pricing_simulate",
            product: { exactName: "Latte 12 oz" }, changes: [],
            sellingPrice: { kind: "delta", deltaCents: 50 } }),
          reason: null }] }) }] }]);
      // This is the fix under test: the real OpenAI call would now be instructed
      // that a clause already answered by a registered capability (readableSourceClauses)
      // stays read_only even when phrased as a calculation, instead of missing_input.
      if (schema === "p3_expression_plans") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, plans: [{
          coveredClauses: [question], planJson: null, reason: "read_only" }] }) }] }]);
      throw new Error("unexpected transport call for schema " + String(schema));
    });
    const { reply } = await runSupervisorTurn({ ...base, text: question }, transport);
    expect(requests, "P3 provider schema sequence").toEqual(["p2_goal_audit", "p2_capability_selection", "p3_expression_plans"]);
    expect(reply.status, "P3 diagnostic: "+JSON.stringify({requests,reply})).toBe("partial");
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("Pricing what-if"))).toBe(true);
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("$0.50"))).toBe(true);
    // The generic "I don't have enough to answer this" fallback must NOT appear --
    // that would mean the real computed answer was discarded in favor of the
    // missing_input brush-off this fix exists to prevent.
    expect(reply.blocks.some(b => b.type === "warning" && b.code === "P3_MISSING_INPUT")).toBe(false);
  });

  it("a named ingredient quantity what-if reaches the real canonical simulator and is presented to the " +
    "owner directly through P3 -- proving the reachability gap found in review is fixed, " +
    "not just that the capability computes correctly in isolation", async () => {
    const productId = avaId, ingredientId = "a0000000-0000-4000-8000-000000000100";
    atomicRpc.mockResolvedValue({ status: "available", snapshot: {
      contract: "p1.authoritative_snapshot.v1", businessId, revision: "100",
      timezone: "America/Los_Angeles", currency: "USD",
      payroll: { rate: 0.12, status: "confirmed", source: "business" },
      sources: {
        menu: [{ id: productId, name: "Latte 12 oz", price_cents: 525, is_active: true, category: "ESPRESSO_DRINK" }],
        ingredients: [{ id: ingredientId, name: "Milk", base_unit: "ml" }],
        ingredientPrices: [{ id: "a0000000-0000-4000-8000-000000000200", ingredient_id: ingredientId,
          effective_from: "2026-09-01", cost_per_base_unit_micros: 100000, source: "manual" }],
        recipes: [{ menu_item_id: productId, ingredient_id: ingredientId, quantity: 200 }],
        employees: [], dailyRollups: [], expenses: [], recurringCosts: [], imports: [],
      },
      truncated: { menu: false, ingredients: false, ingredientPrices: false, recipes: false, employees: false,
        dailyRollups: false, expenses: false, recurringCosts: false, imports: false },
      coverage: "not_proven_by_revision",
    } as AtomicP1SourceSnapshot });
    const question = "What if the Latte 12 oz uses 300 ml of Milk?";
    const requests: string[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        text?: { format?: { name?: string } };
      };
      const schema = body.text?.format?.name;
      requests.push(schema ?? "unexpected");
      if (schema === "p2_goal_audit") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, clauses: [question] }) }] }]);
      if (schema === "p2_capability_selection") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, choices: [{
          clause: question, capabilityId: "p3.alex.pricing.what_if.v1",
          inputJson: JSON.stringify({ purpose: "pricing_simulate",
            product: { exactName: "Latte 12 oz" }, changes: [{kind:"set_quantity",
              ingredientName:"Milk",quantity:{value:300,unit:"ml"}}] }),
          reason: null }] }) }] }]);
      // This is the fix under test: the real OpenAI call would now be instructed
      // that a clause already answered by a registered capability (readableSourceClauses)
      // stays read_only even when phrased as a calculation, instead of missing_input.
      if (schema === "p3_expression_plans") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, plans: [{
          coveredClauses: [question], planJson: null, reason: "read_only" }] }) }] }]);
      throw new Error("unexpected transport call for schema " + String(schema));
    });
    const { reply } = await runSupervisorTurn({ ...base, text: question }, transport);
    expect(requests, "P3 provider schema sequence").toEqual(["p2_goal_audit", "p2_capability_selection", "p3_expression_plans"]);
    expect(reply.status, "P3 diagnostic: "+JSON.stringify({requests,reply})).toBe("partial");
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("Pricing what-if"))).toBe(true);
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("$0.10"))).toBe(true);
    // The generic "I don't have enough to answer this" fallback must NOT appear --
    // that would mean the real computed answer was discarded in favor of the
    // missing_input brush-off this fix exists to prevent.
    expect(reply.blocks.some(b => b.type === "warning" && b.code === "P3_MISSING_INPUT")).toBe(false);
  });

  it("a real schedule what-if question reaches Olivia's capability and is presented to the " +
    "owner directly through P3 -- proving the same reachability gap just closed for Alex's " +
    "pricing what-if is also closed for Olivia's schedule what-if", async () => {
    atomicRpc.mockResolvedValue({ status: "unavailable", reason: "rpc_not_installed" });
    olivia.mockImplementation(async (raw: unknown) => {
      const input = raw as { capability: string };
      if (input.capability === "olivia.availability.read") {
        return { ok: true, version: 1, status: "ok", capability: "olivia.availability.read",
          source: { owner: "olivia", businessId, kind: "stored_availability", consistency: "provisional" },
          employees: [{ employeeId: benId, displayName: "Ben", active: true, state: "confirmed",
            recurring: [], exceptions: [], hourLimits: [], preferences: [], qualifications: [], compensation: [] }] };
      }
      return { ok: true, version: 1, status: "ok", capability: "olivia.schedule.whatIf",
        source: { owner: "olivia", businessId, kind: "trusted_preview", consistency: "provisional" },
        baselineScenario: null, alternateScenario: null,
        baselineStatus: "feasible", baselineProof: "complete_candidate_solution", baselineWarnings: [],
        alternateStatus: "feasible", alternateProof: "complete_candidate_solution", alternateWarnings: [],
        comparison: { ownerMinutesDifference: 0, cashWagesDifferenceCents: 200, loadedPayrollDifferenceCents: 224,
          gapsDifference: 0, completeCoverageBefore: true, completeCoverageAfter: true, changed: true },
        overridesApplied: [{ kind: "temporary_unavailable", employeeId: benId, localDate: "2026-10-20" }],
        notices: [], employeeNames: { [benId]: "Ben" }, locationNames: { [locationId]: "Main" },
        disposition: "hypothetical_simulation_only" };
    });
    const question = "What if Ben doesn't work Tuesday?";
    const requests: string[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { text?: { format?: { name?: string } } };
      const schema = body.text?.format?.name;
      requests.push(schema ?? "unexpected");
      if (schema === "p2_goal_audit") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, clauses: [question] }) }] }]);
      if (schema === "p2_capability_selection") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, choices: [{
          clause: question, capabilityId: "p3.olivia.schedule.what_if.v1",
          inputJson: JSON.stringify({ purpose: "schedule_what_if", week: monday,
            overrides: [{ kind: "temporary_unavailable", employeeName: "Ben", localDate: "2026-10-20" }] }),
          reason: null }] }) }] }]);
      if (schema === "p3_expression_plans") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, plans: [{
          coveredClauses: [question], planJson: null, reason: "read_only" }] }) }] }]);
      throw new Error("unexpected transport call for schema " + String(schema));
    });
    const { reply } = await runSupervisorTurn({ ...base, text: question }, transport);
    expect(requests).toEqual(["p2_goal_audit", "p2_capability_selection", "p3_expression_plans"]);
    expect(olivia).toHaveBeenCalledWith(expect.objectContaining({ capability: "olivia.availability.read" }));
    expect(olivia).toHaveBeenCalledWith(expect.objectContaining({ capability: "olivia.schedule.whatIf",
      overrides: [expect.objectContaining({ employeeId: benId })] }));
    expect(reply.status).toBe("partial");
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("Schedule what-if"))).toBe(true);
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("feasible"))).toBe(true);
    // The generic "I don't have enough to answer this" fallback must NOT appear --
    // that would mean the real computed answer was discarded in favor of the
    // missing_input brush-off this fix exists to prevent.
    expect(reply.blocks.some(b => b.type === "warning" && b.code === "P3_MISSING_INPUT")).toBe(false);
  });

  it("surfaces the capability's own specific reason for an ambiguous product name, " +
    "instead of a generic 'missing input' brush-off", async () => {
    const idA = avaId, idB = benId, ingredientId = "a0000000-0000-4000-8000-000000000100";
    atomicRpc.mockResolvedValue({ status: "available", snapshot: {
      contract: "p1.authoritative_snapshot.v1", businessId, revision: "100",
      timezone: "America/Los_Angeles", currency: "USD",
      payroll: { rate: 0.12, status: "confirmed", source: "business" },
      sources: {
        // Two active items share the exact same name -- what-if can't resolve
        // which one the owner means by name alone.
        menu: [
          { id: idA, name: "Latte 12 oz", price_cents: 525, is_active: true, category: "ESPRESSO_DRINK" },
          { id: idB, name: "Latte 12 oz", price_cents: 550, is_active: true, category: "ESPRESSO_DRINK" },
        ],
        ingredients: [{ id: ingredientId, name: "Milk", base_unit: "ml" }],
        ingredientPrices: [{ id: "a0000000-0000-4000-8000-000000000200", ingredient_id: ingredientId,
          effective_from: "2026-09-01", cost_per_base_unit_micros: 100000, source: "manual" }],
        recipes: [], employees: [], dailyRollups: [], expenses: [], recurringCosts: [], imports: [],
      },
      truncated: { menu: false, ingredients: false, ingredientPrices: false, recipes: false, employees: false,
        dailyRollups: false, expenses: false, recurringCosts: false, imports: false },
      coverage: "not_proven_by_revision",
    } as AtomicP1SourceSnapshot });
    const question = "What if I raise the Latte 12 oz by 50 cents?";
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { text?: { format?: { name?: string } } };
      const schema = body.text?.format?.name;
      if (schema === "p2_goal_audit") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, clauses: [question] }) }] }]);
      if (schema === "p2_capability_selection") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, choices: [{
          clause: question, capabilityId: "p3.alex.pricing.what_if.v1",
          inputJson: JSON.stringify({ purpose: "pricing_simulate",
            product: { exactName: "Latte 12 oz" }, changes: [],
            sellingPrice: { kind: "delta", deltaCents: 50 } }),
          reason: null }] }) }] }]);
      // The ambiguous-name read failed, so this clause is correctly NOT in
      // readableSourceClauses; the model classifies it missing_input as instructed.
      if (schema === "p3_expression_plans") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, plans: [{
          coveredClauses: [question], planJson: null, reason: "missing_input" }] }) }] }]);
      throw new Error("unexpected transport call for schema " + String(schema));
    });
    const { reply } = await runSupervisorTurn({ ...base, text: question }, transport);
    const warning = reply.blocks.find(b => b.type === "warning" && b.code === "P3_MISSING_INPUT");
    expect(warning).toMatchObject({ text: expect.stringContaining("More than one active menu item") });
    // The raw internal reason code must never leak to the owner, in any language.
    expect(JSON.stringify(reply.blocks)).not.toContain("ambiguous_canonical_name_use_product_id");
  });

  it("never drops a failed clause's explanation just because a DIFFERENT clause's " +
    "failure reason happened to be specific -- the generic warning still covers " +
    "whatever isn't in the known reason map", async () => {
    const idA = avaId, idB = benId, ingredientId = "a0000000-0000-4000-8000-000000000100";
    atomicRpc.mockResolvedValue({ status: "available", snapshot: {
      contract: "p1.authoritative_snapshot.v1", businessId, revision: "100",
      timezone: "America/Los_Angeles", currency: "USD",
      payroll: { rate: 0.12, status: "confirmed", source: "business" },
      sources: {
        menu: [
          { id: idA, name: "Latte 12 oz", price_cents: 525, is_active: true, category: "ESPRESSO_DRINK" },
          { id: idB, name: "Latte 12 oz", price_cents: 550, is_active: true, category: "ESPRESSO_DRINK" },
        ],
        ingredients: [{ id: ingredientId, name: "Milk", base_unit: "ml" }],
        ingredientPrices: [{ id: "a0000000-0000-4000-8000-000000000200", ingredient_id: ingredientId,
          effective_from: "2026-09-01", cost_per_base_unit_micros: 100000, source: "manual" }],
        recipes: [], employees: [], dailyRollups: [], expenses: [], recurringCosts: [], imports: [],
      },
      truncated: { menu: false, ingredients: false, ingredientPrices: false, recipes: false, employees: false,
        dailyRollups: false, expenses: false, recurringCosts: false, imports: false },
      coverage: "not_proven_by_revision",
    } as AtomicP1SourceSnapshot });
    const clauseA = "What if I raise the Latte 12 oz by 50 cents?";
    const clauseB = "Can I see a schedule preview for next week?";
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { text?: { format?: { name?: string } } };
      const schema = body.text?.format?.name;
      if (schema === "p2_goal_audit") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, clauses: [clauseA, clauseB] }) }] }]);
      if (schema === "p2_capability_selection") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, choices: [
          { clause: clauseA, capabilityId: "p3.alex.pricing.what_if.v1",
            inputJson: JSON.stringify({ purpose: "pricing_simulate",
              product: { exactName: "Latte 12 oz" }, changes: [],
              sellingPrice: { kind: "delta", deltaCents: 50 } }),
            reason: null },
          // A capability id the server registry does not recognize -- shadow.server.ts's
          // own "unknown_capability" reason, which is deliberately NOT in the known
          // reason map, to prove the fallback covers it.
          { clause: clauseB, capabilityId: "p3.nonexistent.capability.v1",
            inputJson: JSON.stringify({ purpose: "schedule_preview" }), reason: null },
        ] }) }] }]);
      if (schema === "p3_expression_plans") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, plans: [{
          coveredClauses: [clauseA, clauseB], planJson: null, reason: "missing_input" }] }) }] }]);
      throw new Error("unexpected transport call for schema " + String(schema));
    });
    const { reply } = await runSupervisorTurn({ ...base, text: clauseA + " " + clauseB }, transport);
    const warnings = reply.blocks.filter(b => b.type === "warning" && b.code === "P3_MISSING_INPUT");
    // Clause A's specific reason must still appear...
    expect(warnings.some(b => b.type === "warning" &&
      b.text.includes("More than one active menu item"))).toBe(true);
    // ...and clause B's unmapped failure must NOT be silently dropped: the generic
    // explanation covers it instead of vanishing entirely.
    expect(warnings.some(b => b.type === "warning" &&
      b.text.includes("Required records or inputs are missing"))).toBe(true);
    expect(JSON.stringify(reply.blocks)).not.toContain("unknown_capability");
  });

  it("never treats Alex's plain pricing REVIEW (current, unchanged prices -- no owner " +
    "hypothetical at all) as a completed simulation for a calculation-shaped clause", async () => {
    const productId = avaId, ingredientId = "a0000000-0000-4000-8000-000000000100";
    atomicRpc.mockResolvedValue({ status: "available", snapshot: {
      contract: "p1.authoritative_snapshot.v1", businessId, revision: "100",
      timezone: "America/Los_Angeles", currency: "USD",
      payroll: { rate: 0.12, status: "confirmed", source: "business" },
      sources: {
        menu: [{ id: productId, name: "Latte 12 oz", price_cents: 525, is_active: true, category: "ESPRESSO_DRINK" }],
        ingredients: [{ id: ingredientId, name: "Milk", base_unit: "ml" }],
        ingredientPrices: [{ id: "a0000000-0000-4000-8000-000000000200", ingredient_id: ingredientId,
          effective_from: "2026-09-01", cost_per_base_unit_micros: 100000, source: "manual" }],
        recipes: [{ menu_item_id: productId, ingredient_id: ingredientId, quantity: 200 }],
        employees: [], dailyRollups: [], expenses: [], recurringCosts: [], imports: [],
      },
      truncated: { menu: false, ingredients: false, ingredientPrices: false, recipes: false, employees: false,
        dailyRollups: false, expenses: false, recurringCosts: false, imports: false },
      coverage: "not_proven_by_revision",
    } as AtomicP1SourceSnapshot });
    // Phrased as a calculation (a hypothetical total revenue change), but the plan
    // selector picks the plain review capability -- which only ever reads CURRENT,
    // unchanged prices and cannot encode or satisfy this request at all.
    const question = "What would my total menu revenue be if I raised every price by 10%?";
    const requests: Array<Record<string, unknown>> = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { text?: { format?: { name?: string } } };
      requests.push(body);
      const schema = body.text?.format?.name;
      if (schema === "p2_goal_audit") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, clauses: [question] }) }] }]);
      if (schema === "p2_capability_selection") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, choices: [{
          clause: question, capabilityId: "p3.alex.pricing.review.v1",
          inputJson: JSON.stringify({ purpose: "pricing_review" }), reason: null }] }) }] }]);
      if (schema === "p3_expression_plans") return response([{ type: "message", content: [
        { type: "output_text", text: JSON.stringify({ complete: true, plans: [{
          coveredClauses: [question], planJson: null, reason: "missing_input" }] }) }] }]);
      throw new Error("unexpected transport call for schema " + String(schema));
    });
    await runSupervisorTurn({ ...base, text: question }, transport);
    const compositionRequest = requests.find(r =>
      (r.text as { format?: { name?: string } } | undefined)?.format?.name === "p3_expression_plans");
    const payload = JSON.parse(
      (compositionRequest!.input as Array<{ content: string }>)[0].content,
    ) as { readableSourceClauses: string[]; completedSimulationClauses: string[] };
    // The review read succeeded, so the clause is a readable source...
    expect(payload.readableSourceClauses).toContain(question);
    // ...but it is NOT a completed simulation: the review never saw or applied the
    // owner's requested 10% change, so presenting it as read_only would show an
    // unchanged price list as if it answered the hypothetical. Caught in review
    // (round 3 of PR #106).
    expect(payload.completedSimulationClauses).not.toContain(question);
  });

  it("a combined scheduling + pricing request preserves both goals in one reply", async () => {
    const scenario = {
      objective: "cash" as const, shifts: [], gaps: [{
        coverageId: "a0000000-0000-4000-8000-000000000040", locationId, startAt: iso("09"),
        endAt: iso("11"), qualificationCode: "barista", missingHeadcount: 1,
        reason: "no_active_staff" as const }],
      completeCoverage: false, hardConstraintsSatisfied: true, ownerMinutes: 0,
      cost: { cashWagesCents: null, allocatedSalaryCents: null, loadedPayrollCents: null,
        ownerOpportunityCents: 0, ownerMinutes: 0, costState: "unavailable" as const, missingWageEmployeeIds: [] },
      preferencePenalty: 0, exploredNodes: 1, legalReview: "unverified_profile" as const,
    };
    olivia.mockResolvedValue({
      ok: true, version: 1, status: "ok", capability: "olivia.schedule.preview",
      source: { owner: "olivia", businessId, kind: "trusted_preview", consistency: "provisional" },
      plan: { status: "infeasible", horizonStart: monday, horizonEnd: "2026-10-25", scenarios: [scenario],
        best: scenario, comparisons: [], warnings: [], proof: "required_slot_has_no_eligible_worker" },
      selectedScenario: scenario, previewRevision: 0, notices: [], blockers: [],
      employeeNames: {}, locationNames: { [locationId]: "Main" }, frozenShiftKeys: [], disposition: "proposal_only",
    });
    const productId = avaId, ingredientId = "a0000000-0000-4000-8000-000000000100";
    atomicRpc.mockResolvedValue({ status: "available", snapshot: {
      contract: "p1.authoritative_snapshot.v1", businessId, revision: "100",
      timezone: "America/Los_Angeles", currency: "USD",
      payroll: { rate: 0.12, status: "confirmed", source: "business" },
      sources: {
        menu: [{ id: productId, name: "Latte 12 oz", price_cents: 525, is_active: true, category: "ESPRESSO_DRINK" }],
        ingredients: [{ id: ingredientId, name: "Milk", base_unit: "ml" }],
        ingredientPrices: [{ id: "a0000000-0000-4000-8000-000000000200", ingredient_id: ingredientId,
          effective_from: "2026-09-01", cost_per_base_unit_micros: 100000, source: "manual" }],
        recipes: [{ menu_item_id: productId, ingredient_id: ingredientId, quantity: 200 }],
        employees: [], dailyRollups: [], expenses: [], recurringCosts: [], imports: [],
      },
      truncated: { menu: false, ingredients: false, ingredientPrices: false, recipes: false, employees: false,
        dailyRollups: false, expenses: false, recurringCosts: false, imports: false },
      coverage: "not_proven_by_revision",
    } as AtomicP1SourceSnapshot });
    const transport = sequencedTransport([
      response([call("declare_request_scope", { goals: [scheduleGoal, pricingGoal] }, "scope"),
        call("olivia_schedule", { action: "preview", week: monday, objective: "cash", overrides: null }, "c1"),
        call("alex_pricing_review", { selection: "all_active", product_name: null, product_id: null,
          offset: 0, limit: 25 }, "c2")]),
      response([finish(["t1:gaps", "t2:count"], ["t1:gap0", "t2:item0"])]),
    ], [scheduleGoal, pricingGoal]);
    const { reply } = await runSupervisorTurn({ ...base,
      text: "Reduce labor costs and tell me if my menu prices need review." }, transport);
    expect(reply.blocks).toContainEqual(expect.objectContaining({ label: "Uncovered coverage slots" }));
    expect(reply.blocks).toContainEqual(expect.objectContaining({ label: "Products reviewed" }));
    expect(reply.status).toBe("partial");
  });

  it("asks for disambiguation instead of guessing when two employees share a name", async () => {
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
    const transport = sequencedTransport([
      response([call("declare_request_scope", { goals: [scheduleGoal] }, "scope"),
        call("olivia_availability", { employee_name: "Sam" }, "c1")]),
      response([finish([], ["t1:ambiguous"])]),
    ], [scheduleGoal]);
    const { reply } = await runSupervisorTurn({ ...base, text: "Can Sam close on Friday instead?" }, transport);
    expect(olivia).toHaveBeenCalledTimes(1);
    expect(reply.blocks.some(b => b.type === "text" && b.text.includes("More than one employee matches"))).toBe(true);
  });

  it("keeps an audited Alex pricing turn alive after two successful but unproductive P3 OpenAI calls", async () => {
    // Production regression: P3 consumed two completed Responses, fell back
    // without reading a café tool, then legacy's first Responses succeeded but
    // the mandatory semantic audit had no remaining model-call allowance.
    const productId=avaId, ingredientId="a0000000-0000-4000-8000-000000000100";
    atomicRpc.mockResolvedValue({status:"available",snapshot:{
      contract:"p1.authoritative_snapshot.v1",businessId,revision:"100",
      timezone:"America/Los_Angeles",currency:"USD",
      payroll:{rate:0.12,status:"confirmed",source:"business"},
      sources:{
        menu:[{id:productId,name:"Dirty Cardamom Iced 12oz",price_cents:650,
          is_active:true,category:"ESPRESSO_DRINK"}],
        ingredients:[{id:ingredientId,name:"Milk",base_unit:"ml"}],
        ingredientPrices:[{id:"a0000000-0000-4000-8000-000000000200",
          ingredient_id:ingredientId,effective_from:"2026-09-01",
          cost_per_base_unit_micros:100000,source:"manual"}],
        recipes:[{menu_item_id:productId,ingredient_id:ingredientId,quantity:200}],
        employees:[],dailyRollups:[],expenses:[],recurringCosts:[],imports:[],
      },
      truncated:{menu:false,ingredients:false,ingredientPrices:false,
        recipes:false,employees:false,dailyRollups:false,expenses:false,
        recurringCosts:false,imports:false},
      coverage:"not_proven_by_revision",
    } as AtomicP1SourceSnapshot});
    const question="How much should I charge for Dirty Cardamom Iced 12oz?";
    const requests:string[]=[];
    const diagnostics:Array<{stage:string;legacyFallbackReason?:string}>=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body)) as {
        text?:{format?:{name?:string}};tool_choice?:string;
      };
      const schema=body.text?.format?.name;
      requests.push(schema??body.tool_choice??"legacy_final");
      if(schema==="p2_goal_audit")
        return response([{type:"message",content:[{type:"output_text",
          text:JSON.stringify({complete:true,clauses:[question]})}]}]);
      if(schema==="p2_capability_selection")
        return response([]); // No validated P3 read: hand off to the legacy registry.
      if(schema==="supervisor_scope_audit")return auditPayload([pricingGoal]);
      if(body.tool_choice==="required")
        return response([
          call("declare_request_scope",{goals:[pricingGoal]},"scope"),
          call("alex_pricing_review",{selection:"specific_name",
            product_name:"Dirty Cardamom Iced 12oz",product_id:null,
            offset:0,limit:25},"c1"),
        ]);
      return response([finish(["t1:count"],["t1:item0"])]);
    });
    const result=await runSupervisorTurn({...base,text:question,
      onDiagnostic:d=>diagnostics.push(d)},transport);
    expect(requests).toEqual(["p2_goal_audit","p2_capability_selection",
      "supervisor_final","supervisor_scope_audit","supervisor_final"]);
    expect(result.usage).toMatchObject({modelCallCount:5,toolCallCount:1});
    expect(result.reply.blocks).toContainEqual(expect.objectContaining({
      type:"count",label:"Products reviewed",value:1,
    }));
    expect(result.reply.blocks.some(b=>b.type==="text" &&
      b.text.includes("Dirty Cardamom Iced 12oz"))).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage:"legacy_fallback",legacyFallbackReason:"p3_not_completed",
    }));
  });


  it("returns real scheduling setup blockers after the same two-call P3 fallthrough", async () => {
    // P3 is intentionally unproductive for a specialist schedule request.
    atomicRpc.mockResolvedValue({status:"unavailable",reason:"rpc_not_installed"});
    olivia.mockResolvedValue({ok:false,version:1,status:"error",
      capability:"olivia.schedule.preview",error:{
        code:"missing_inputs",retryable:false,message:"missing coverage"},
      blockers:[{code:"no_coverage"}]});
    const question="These are my workers' times for next week. Please make a schedule " +
      "for the café's 7 a.m. to 8 p.m. operating hours.";
    const requests:string[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body)) as {
        text?:{format?:{name?:string}};tool_choice?:string;
      };
      const schema=body.text?.format?.name;
      requests.push(schema??body.tool_choice??"legacy_final");
      if(schema==="p2_goal_audit")return response([{type:"message",content:[
        {type:"output_text",text:JSON.stringify({complete:true,clauses:[question]})}]}]);
      if(schema==="p2_capability_selection")return response([]);
      if(schema==="supervisor_scope_audit")return auditPayload([schedulePlanGoal]);
      if(body.tool_choice==="required")return response([
        call("declare_request_scope",{goals:[schedulePlanGoal]},"scope"),
        call("olivia_schedule",{action:"preview",week:monday,objective:"cash",overrides:null},"c1"),
      ]);
      return response([finish([],[])]);
    });
    const {reply,usage}=await runSupervisorTurn({...base,text:question},transport);
    expect(requests).toEqual(["p2_goal_audit","p2_capability_selection",
      "supervisor_final","supervisor_scope_audit","supervisor_final"]);
    expect(usage).toMatchObject({modelCallCount:5,toolCallCount:1});
    expect(olivia).toHaveBeenCalledTimes(1);
    expect(reply.blocks).toContainEqual(expect.objectContaining({
      type:"text",text:expect.stringContaining("Setup needed: no coverage"),
    }));
    expect(reply.blocks.some(b=>b.type==="text" && b.text.includes("Which exact dates"))).toBe(false);
  });

});
