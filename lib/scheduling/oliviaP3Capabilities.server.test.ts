import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./oliviaCapabilities.server", () => ({ executeOliviaReadCapability: vi.fn() }));

import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { createP2Registry } from "@/lib/ai/supervisor/p2/registry";
import { executeOliviaReadCapability } from "./oliviaCapabilities.server";
type OliviaResponse = Awaited<ReturnType<typeof executeOliviaReadCapability>>;
import {
  buildOliviaP3Registrations, OLIVIA_P3_SCHEDULE_PREVIEW_ID, OLIVIA_P3_WHATIF_ID,
} from "./oliviaP3Capabilities.server";
import { presentRegisteredReads } from "@/lib/ai/supervisor/p3/readEvidencePresentation";

const olivia = vi.mocked(executeOliviaReadCapability);
const scope = {
  role: "owner" as const, businessId: "cafe-fixture",
  identity: { businessId: "cafe-fixture", asOf: "2026-10-19", timezone: "America/Los_Angeles", currency: "USD" },
  tools: {} as BusinessScopedCafeTools, shadowEnabled: true,
};
const feasiblePlan = {
  ok: true, version: 1, status: "ok", capability: "olivia.schedule.preview" as const,
  source: { owner: "olivia" as const, businessId: "cafe-fixture", kind: "trusted_preview" as const,
    consistency: "provisional" as const },
  plan: { status: "feasible" as const, horizonStart: "2026-10-19", horizonEnd: "2026-10-25",
    scenarios: [], best: null, comparisons: [], warnings: [], proof: "complete_candidate_solution" },
  selectedScenario: {
    objective: "cash" as const,
    shifts: [{ employeeId: "emp-1", locationId: "loc-1", startAt: "2026-10-19T09:00:00.000Z",
      endAt: "2026-10-19T17:00:00.000Z", paidMinutes: 480, breaks: [], pinned: false }],
    gaps: [], completeCoverage: true, hardConstraintsSatisfied: true,
    ownerMinutes: 0, cost: { cashWagesCents: 7168, allocatedSalaryCents: 0, loadedPayrollCents: 7168,
      ownerOpportunityCents: 0, ownerMinutes: 0, costState: "verified" as const, missingWageEmployeeIds: [] },
    preferencePenalty: 0, exploredNodes: 1, legalReview: "unverified_profile" as const,
  },
  previewRevision: 0, notices: [], blockers: [], employeeNames: {}, locationNames: {},
  frozenShiftKeys: [], disposition: "proposal_only" as const,
};

beforeEach(() => { olivia.mockReset(); });

describe("Olivia P3 schedule-preview registration", () => {
  it("registers cleanly into the P2/P3 capability registry and is discoverable", () => {
    const [registration] = buildOliviaP3Registrations();
    const registry = createP2Registry([registration]);
    const discovered = registry.discover(scope);
    expect(discovered.map(d => d.id)).toContain(OLIVIA_P3_SCHEDULE_PREVIEW_ID);
  });

  it("presents a feasible preview as a real, owner-readable block (not raw internals)", async () => {
    olivia.mockResolvedValue(feasiblePlan as OliviaResponse);
    const [registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, { purpose: "schedule_preview", week: "2026-10-19" });
    expect(raw).toMatchObject({ status: "partial", id: "olivia.schedule.preview" });
    const view = presentRegisteredReads({
      evidence: [{ clause: "schedule", capabilityId: "p3." + "olivia.schedule.preview" + ".v1",
        status: "partial", result: raw as Record<string, unknown>, reason: null }],
      includedClauses: ["schedule"], businessId: scope.businessId, asOf: scope.identity.asOf, locale: "en",
    });
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("Schedule preview"))).toBe(true);
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("$71.68"))).toBe(true);
    expect(view.evidence.length).toBeGreaterThan(0);
  });

  it("returns unavailable, never a fabricated schedule, when Olivia reports disabled", async () => {
    olivia.mockResolvedValue({ ok: false, capability: "olivia.schedule.preview", version: 1, status: "error",
      error: { code: "disabled", retryable: false, message: "Olivia scheduling is not enabled." } });
    const [registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, { purpose: "schedule_preview", week: "2026-10-19" });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "disabled" });
  });

  it("returns unavailable, not zero, when the plan is infeasible", async () => {
    olivia.mockResolvedValue(
      { ...feasiblePlan, plan: { ...feasiblePlan.plan, status: "infeasible" } } as OliviaResponse,
    );
    const [registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, { purpose: "schedule_preview", week: "2026-10-19" });
    expect(raw).toMatchObject({ status: "unavailable" });
  });
});

const roster = (employees: Array<{ employeeId: string; displayName: string; active?: boolean }>) => ({
  ok: true, version: 1, status: "ok", capability: "olivia.availability.read" as const,
  source: { owner: "olivia" as const, businessId: "cafe-fixture", kind: "stored_availability" as const,
    consistency: "provisional" as const },
  employees: employees.map(e => ({
    employeeId: e.employeeId, displayName: e.displayName, active: e.active ?? true,
    state: "confirmed" as const, recurring: [], exceptions: [], hourLimits: [],
    preferences: [], qualifications: [], compensation: [],
  })),
});
const whatIfResult = (overrides: Record<string, unknown> = {}) => ({
  ok: true, version: 1, status: "ok", capability: "olivia.schedule.whatIf" as const,
  source: { owner: "olivia" as const, businessId: "cafe-fixture", kind: "trusted_preview" as const,
    consistency: "provisional" as const },
  baselineScenario: null, alternateScenario: null,
  baselineStatus: "feasible" as const, baselineProof: "complete_candidate_solution" as const, baselineWarnings: [],
  alternateStatus: "feasible" as const, alternateProof: "complete_candidate_solution" as const, alternateWarnings: [],
  comparison: {
    ownerMinutesDifference: 0, cashWagesDifferenceCents: -1600, loadedPayrollDifferenceCents: -1792,
    gapsDifference: 0, completeCoverageBefore: true, completeCoverageAfter: true, changed: true,
  },
  overridesApplied: [], notices: [], employeeNames: { "emp-1": "Ava" }, locationNames: {},
  disposition: "hypothetical_simulation_only" as const,
  ...overrides,
});

describe("Olivia P3 schedule-what-if registration", () => {
  it("registers cleanly into the P2/P3 capability registry and is discoverable", () => {
    const registrations = buildOliviaP3Registrations();
    const registry = createP2Registry(registrations);
    const discovered = registry.discover(scope);
    expect(discovered.map(d => d.id)).toContain(OLIVIA_P3_WHATIF_ID);
  });

  it("resolves a named worker to the trusted roster and reports the real coverage/cost delta", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      return whatIfResult() as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({
      status: "partial", id: "olivia.schedule.what_if",
      value: [{ alternateStatus: "feasible", changed: true, completeCoverageAfter: true,
        gapsDifference: 0, loadedPayrollDifferenceCents: -1792 }],
    });
    expect(olivia).toHaveBeenCalledWith(expect.objectContaining({ capability: "olivia.availability.read" }));
    expect(olivia).toHaveBeenCalledWith(expect.objectContaining({
      capability: "olivia.schedule.whatIf",
      overrides: [{ kind: "temporary_unavailable", employeeId: "emp-1", localDate: "2026-10-20" }],
    }));
  });

  it("reports an infeasible alternate's status instead of discarding it as unavailable", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      return whatIfResult({ alternateStatus: "infeasible", alternateProof: "required_slot_has_no_eligible_worker",
        comparison: null }) as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({
      status: "partial", id: "olivia.schedule.what_if",
      value: [{ alternateStatus: "infeasible", changed: null, completeCoverageAfter: null,
        gapsDifference: null, loadedPayrollDifferenceCents: null }],
    });
  });

  it("reports unavailable when no active worker matches the requested name", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ben" }]) as OliviaResponse;
      throw new Error("must not call the real simulation for an unresolved name");
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "employee_not_found" });
  });

  it("reports unavailable, never guesses, when two active workers share the requested name", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([
          { employeeId: "emp-1", displayName: "Ava" }, { employeeId: "emp-2", displayName: "ava" },
        ]) as OliviaResponse;
      throw new Error("must not call the real simulation for an ambiguous name");
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "ambiguous_employee_name" });
  });

  it("ignores an inactive worker's name match and reports employee_not_found", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava", active: false }]) as OliviaResponse;
      throw new Error("must not call the real simulation for an inactive-only match");
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "employee_not_found" });
  });

  it("surfaces the underlying capability's own error code when the roster read is disabled", async () => {
    olivia.mockResolvedValue({ ok: false, capability: "olivia.availability.read", version: 1, status: "error",
      error: { code: "disabled", retryable: false, message: "Olivia scheduling is not enabled." } } as OliviaResponse);
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "disabled" });
  });

  it("reports source_changed instead of silently answering about the wrong worker when a " +
    "rename lands between the roster read and the simulation", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      // The simulation's OWN authoritative employeeNames now says "Sam" for emp-1 --
      // as if a rename landed between the roster read and this later trusted read.
      return whatIfResult({ employeeNames: { "emp-1": "Sam" } }) as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "source_changed" });
  });

  it("surfaces that legal/break compliance was never independently reviewed, instead of " +
    "presenting a feasible schedule as caveat-free", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      return whatIfResult({
        alternateScenario: { objective: "cash", shifts: [], gaps: [], completeCoverage: true,
          hardConstraintsSatisfied: true, ownerMinutes: 0,
          cost: { cashWagesCents: 0, allocatedSalaryCents: 0, loadedPayrollCents: 0, ownerOpportunityCents: 0,
            ownerMinutes: 0, costState: "verified", missingWageEmployeeIds: [] },
          preferencePenalty: 0, exploredNodes: 1, legalReview: "unverified_profile" },
      }) as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({ status: "partial", value: [{ legalReviewUnverified: true }] });
  });

  it("surfaces that the planner reported additional warnings/notices, instead of silently " +
    "dropping them", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      return whatIfResult({ alternateWarnings: ["Search budget exhausted before full proof"] }) as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    expect(raw).toMatchObject({ status: "partial", value: [{ hasAdditionalCaveats: true }] });
  });

  it("echoes every override's worker, date/window or minute cap back in the result, so an " +
    "owner can catch capability selection emitting a valid but wrong parameter", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      return whatIfResult({alternateScenario:feasiblePlan.selectedScenario}) as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20",
        window: { startLocal: "09:00", endLocal: "12:00", overnight: false } }],
      objective: "cash",
    });
    expect(raw).toMatchObject({
      status: "partial",
      value: [{ name: "2026-10-19", objective: "cash",
        overridesSummary: [{ kind: "temporary_unavailable", employeeName: "Ava",
          localDate: "2026-10-20", startLocal: "09:00", endLocal: "12:00" }] }],
    });
  });

  it("echoes a weekly/daily minute-cap override's actual limit, not just the worker/date", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      return whatIfResult() as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "reduce_weekly_minutes", employeeName: "Ava", maxWeeklyMinutes: 120 }],
    });
    expect(raw).toMatchObject({
      status: "partial",
      value: [{ objective: null,
        overridesSummary: [{ kind: "reduce_weekly_minutes", employeeName: "Ava", maxWeeklyMinutes: 120 }] }],
    });
  });

  it("presents a real coverage/cost delta as an owner-readable block (not raw internals)", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      return whatIfResult() as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    const view = presentRegisteredReads({
      evidence: [{ clause: "whatif", capabilityId: "p3." + "olivia.schedule.what_if" + ".v1",
        status: "partial", result: raw as Record<string, unknown>, reason: null }],
      includedClauses: ["whatif"], businessId: scope.businessId, asOf: scope.identity.asOf, locale: "en",
    });
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("Schedule what-if"))).toBe(true);
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("feasible"))).toBe(true);
    expect(view.evidence.length).toBeGreaterThan(0);
  });

  it("renders the override summary fully localized for a Spanish or Arabic owner, with no " +
    "raw English words leaking through", async () => {
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: "Ava" }]) as OliviaResponse;
      return whatIfResult() as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "temporary_unavailable", employeeName: "Ava", localDate: "2026-10-20" }],
    });
    for (const locale of ["es", "ar"] as const) {
      const view = presentRegisteredReads({
        evidence: [{ clause: "whatif", capabilityId: "p3." + "olivia.schedule.what_if" + ".v1",
          status: "partial", result: raw as Record<string, unknown>, reason: null }],
        includedClauses: ["whatif"], businessId: scope.businessId, asOf: scope.identity.asOf, locale,
      });
      const summaryLine = view.blocks.find(b => b.type === "text" && b.text.includes("Ava"));
      expect(summaryLine).toBeDefined();
      if (summaryLine?.type === "text") {
        expect(summaryLine.text).not.toMatch(/\bunavailable\b/i);
        expect(summaryLine.text).not.toMatch(/\ball day\b/i);
      }
    }
  });

  it("still shows the override summary for an employee name longer than the generic " +
    "120-char presentation cutoff, as long as it is within the schema's own bound", async () => {
    const longName = "A".repeat(130);
    olivia.mockImplementation(async (request: unknown) => {
      const r = request as { capability: string };
      if (r.capability === "olivia.availability.read")
        return roster([{ employeeId: "emp-1", displayName: longName }]) as OliviaResponse;
      return whatIfResult({ employeeNames: { "emp-1": longName } }) as OliviaResponse;
    });
    const [, registration] = buildOliviaP3Registrations();
    const raw = await registration.read(scope, {
      purpose: "schedule_what_if", week: "2026-10-19",
      overrides: [{ kind: "reduce_weekly_minutes", employeeName: longName, maxWeeklyMinutes: 120 }],
    });
    const view = presentRegisteredReads({
      evidence: [{ clause: "whatif", capabilityId: "p3." + "olivia.schedule.what_if" + ".v1",
        status: "partial", result: raw as Record<string, unknown>, reason: null }],
      includedClauses: ["whatif"], businessId: scope.businessId, asOf: scope.identity.asOf, locale: "en",
    });
    expect(view.blocks.some(b => b.type === "text" && b.text.includes(longName))).toBe(true);
  });
});

it("uses the optimizer's selected objective even when the input omitted a priority", async () => {
  olivia.mockImplementation(async request => {
    if ((request as {capability:string}).capability === "olivia.availability.read")
      return roster([{employeeId:"emp-1",displayName:"Ava"}]) as OliviaResponse;
    return whatIfResult({alternateScenario:{...feasiblePlan.selectedScenario,objective:"owner_time"}}) as OliviaResponse;
  });
  const [,registration]=buildOliviaP3Registrations();
  expect(await registration.read(scope,{purpose:"schedule_what_if",week:"2026-10-19",
    overrides:[{kind:"reduce_weekly_minutes",employeeName:"Ava",maxWeeklyMinutes:120}]}))
    .toMatchObject({value:[{objective:"owner_time"}]});
});

it("rejects a newly ambiguous name in the simulation snapshot", async () => {
  olivia.mockImplementation(async request => {
    if ((request as {capability:string}).capability === "olivia.availability.read")
      return roster([{employeeId:"emp-1",displayName:"Ava"}]) as OliviaResponse;
    return whatIfResult({employeeNames:{"emp-1":"Ava","emp-2":" ava "}}) as OliviaResponse;
  });
  const [,registration]=buildOliviaP3Registrations();
  expect(await registration.read(scope,{purpose:"schedule_what_if",week:"2026-10-19",
    overrides:[{kind:"reduce_weekly_minutes",employeeName:"Ava",maxWeeklyMinutes:120}]}))
    .toMatchObject({status:"unavailable",reason:"ambiguous_employee_name"});
});

it("preserves five full-length worker names, distinct caps and result/caveats in every locale", async () => {
  const employees=Array.from({length:5},(_,i)=>({employeeId:"emp-"+i,displayName:String(i)+"A".repeat(239)}));
  olivia.mockImplementation(async request => {
    if ((request as {capability:string}).capability === "olivia.availability.read")
      return roster(employees) as OliviaResponse;
    return whatIfResult({employeeNames:Object.fromEntries(employees.map(e=>[e.employeeId,e.displayName])),
      alternateScenario:feasiblePlan.selectedScenario,alternateWarnings:["caution"]}) as OliviaResponse;
  });
  const registry=createP2Registry(buildOliviaP3Registrations());
  const raw=await registry.invoke(scope,OLIVIA_P3_WHATIF_ID,{purpose:"schedule_what_if",week:"2026-10-19",
    overrides:employees.map((e,i)=>({kind:"reduce_weekly_minutes",employeeName:e.displayName,maxWeeklyMinutes:120+i}))});
  expect(raw).toMatchObject({status:"partial"});
  for(const locale of ["en","es","ar"] as const){
    const view=presentRegisteredReads({evidence:[{clause:"whatif",capabilityId:OLIVIA_P3_WHATIF_ID,
      status:"partial",result:raw,reason:null}],includedClauses:["whatif"],businessId:scope.businessId,asOf:scope.identity.asOf,locale});
    const text=view.blocks.flatMap(b=>b.type==="text"?[b.text]:[]).join("\n");
    for(const e of employees)expect(text).toContain(e.displayName);
    expect(text).toContain(new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(-17.92));
    const catalog=(await import(`../../messages/${locale}.json`)).default.SupervisorRegisteredRead;
    expect(text).toContain(catalog.field_legalReviewUnverified);
    expect(text).toContain(catalog.field_hasAdditionalCaveats);
    for(const b of view.blocks)if(b.type==="text")expect(b.text.length).toBeLessThanOrEqual(1200);
  }
});

it("rejects a wrong worker or explicit date before reading private scheduling data", async () => {
  const [,registration]=buildOliviaP3Registrations();
  for(const input of [
    {employeeName:"Ben",localDate:"2026-10-20"},
    {employeeName:"Ava",localDate:"2026-10-21"},
  ])expect(await registration.read({...scope,ownerClause:"What if Ava cannot work 2026-10-20?"},
    {purpose:"schedule_what_if",week:"2026-10-19",overrides:[{kind:"temporary_unavailable",...input}]}))
    .toMatchObject({status:"unavailable",reason:"invalid_input"});
  expect(olivia).not.toHaveBeenCalled();
});

it("distinguishes modeled salary allocation and estimated labor from actual cash savings",async()=>{
  const scenario={...feasiblePlan.selectedScenario,cost:{...feasiblePlan.selectedScenario.cost,
    allocatedSalaryCents:1000,costState:"estimate"}};
  olivia.mockImplementation(async request=>(request as {capability:string}).capability==="olivia.availability.read"
    ?roster([{employeeId:"emp-1",displayName:"Ava"}]) as OliviaResponse
    :whatIfResult({alternateScenario:scenario}) as OliviaResponse);
  const [,registration]=buildOliviaP3Registrations();
  const raw=await registration.read(scope,{purpose:"schedule_what_if",week:"2026-10-19",
    overrides:[{kind:"reduce_weekly_minutes",employeeName:"Ava",maxWeeklyMinutes:120}]});
  expect(raw).toMatchObject({value:[{salaryAllocationIncluded:true,laborCostEstimated:true,
    cashWagesDifferenceCents:-1600,ownerMinutesDifference:0}]});
  const view=presentRegisteredReads({evidence:[{clause:"whatif",capabilityId:OLIVIA_P3_WHATIF_ID,
    status:"partial",result:raw,reason:null}],includedClauses:["whatif"],businessId:scope.businessId,
    asOf:scope.identity.asOf,locale:"en"});
  expect(view.blocks.some(b=>b.type==="text"&&b.text.includes("not verified incremental cash savings"))).toBe(true);
  expect(view.blocks.some(b=>b.type==="text"&&b.text.includes("Labor costs include estimates"))).toBe(true);
});

it.each(["roster","simulation"])("rejects an active-café switch during the %s read",async(stage)=>{
  olivia.mockImplementation(async request=>{
    if((request as {capability:string}).capability==="olivia.availability.read"){
      const result=roster([{employeeId:"emp-1",displayName:"Ava"}]);
      return {...result,source:{...result.source,businessId:stage==="roster"?"another-cafe":scope.businessId}} as OliviaResponse;
    }
    const result=whatIfResult();
    return {...result,source:{...result.source,businessId:"another-cafe"}} as OliviaResponse;
  });
  const [,registration]=buildOliviaP3Registrations();
  expect(await registration.read(scope,{purpose:"schedule_what_if",week:"2026-10-19",
    overrides:[{kind:"reduce_weekly_minutes",employeeName:"Ava",maxWeeklyMinutes:120}]}))
    .toMatchObject({status:"unavailable",reason:"unauthorized"});
  expect(olivia).toHaveBeenCalledTimes(stage==="roster"?1:2);
});
