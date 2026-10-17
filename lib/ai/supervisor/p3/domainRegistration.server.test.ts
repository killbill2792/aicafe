import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/scheduling/oliviaCapabilities.server", () => ({ executeOliviaReadCapability: vi.fn() }));
vi.mock("@/lib/pricing/alexCapabilities.server", () => ({
  buildAlexPricingRegistrations: () => [{
    id: "alex.pricing.batch_review.v1", version: 1, owner: "alex", mode: "read", availability: "shadow",
    purpose: "stub", sourceIds: ["x"], canonicalReaderIds: ["x"], allowedPurposes: ["pricing_review"],
    inputSchema: { safeParse: () => ({ success: true, data: {} }) },
    outputSchema: { safeParse: () => ({ success: true, data: {} }) },
    schemaContract: { id: "x.v1", registrationId: "x", version: 1, inputSchemaFingerprint: "a", outputSchemaFingerprint: "b" },
    requiredRole: "owner", sensitivity: "financial",
    budgets: { maxOperations: 1, timeoutMs: 1000, maxResultBytes: 1000, maxInputBytes: 1000, maxRangeDays: 365 },
    requiresApproval: false, effectPolicy: "deny", read: async () => ({ status: "unavailable", value: null, reason: "x" }),
  }, {}],
}));

import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { createP3ReadRegistry } from "./sourceRegistry.server";
import { buildAlexP3Registrations } from "@/lib/pricing/alexP3Capabilities.server";
import { buildOliviaP3Registrations } from "@/lib/scheduling/oliviaP3Capabilities.server";
import { ALEX_P3_REVIEW_ID } from "@/lib/pricing/alexP3Capabilities.server";
import { OLIVIA_P3_SCHEDULE_PREVIEW_ID, OLIVIA_P3_WHATIF_ID } from
  "@/lib/scheduling/oliviaP3Capabilities.server";

const scope = {
  role: "owner" as const, businessId: "cafe-fixture",
  identity: { businessId: "cafe-fixture", asOf: "2026-10-19", timezone: "America/Los_Angeles", currency: "USD" },
  tools: {} as BusinessScopedCafeTools, shadowEnabled: true,
};

describe("P3 registry wiring (exact shape used by runP3Turn.server.ts)", () => {
  it("discovers P1 financial sources alongside the newly registered Olivia and Alex capabilities", () => {
    const registry = createP3ReadRegistry([
      ...buildAlexP3Registrations(), ...buildOliviaP3Registrations(),
    ]);
    const ids = registry.discover(scope).map(d => d.id);
    expect(ids).toContain(ALEX_P3_REVIEW_ID);
    expect(ids).toContain(OLIVIA_P3_SCHEDULE_PREVIEW_ID);
    expect(ids).toContain(OLIVIA_P3_WHATIF_ID);
    // The pre-existing P1 financial/sales/staff sources must still be present — this is additive, not a replacement.
    expect(ids.length).toBeGreaterThan(2);
  });
});
