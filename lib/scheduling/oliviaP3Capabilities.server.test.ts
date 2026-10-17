import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./oliviaCapabilities.server", () => ({ executeOliviaReadCapability: vi.fn() }));

import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { createP2Registry } from "@/lib/ai/supervisor/p2/registry";
import { executeOliviaReadCapability } from "./oliviaCapabilities.server";
type OliviaResponse = Awaited<ReturnType<typeof executeOliviaReadCapability>>;
import { buildOliviaP3Registrations, OLIVIA_P3_SCHEDULE_PREVIEW_ID } from "./oliviaP3Capabilities.server";
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
