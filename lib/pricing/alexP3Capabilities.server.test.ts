import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));
const mockRead = vi.fn();
vi.mock("./alexCapabilities.server", () => ({
  buildAlexPricingRegistrations: () => [{ read: mockRead }, {}],
}));

import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { createP2Registry } from "@/lib/ai/supervisor/p2/registry";
import { buildAlexP3Registrations, ALEX_P3_REVIEW_ID } from "./alexP3Capabilities.server";
import { presentRegisteredReads } from "@/lib/ai/supervisor/p3/readEvidencePresentation";

const scope = {
  role: "owner" as const, businessId: "cafe-fixture",
  identity: { businessId: "cafe-fixture", asOf: "2026-10-19", timezone: "America/Los_Angeles", currency: "USD" },
  tools: {} as BusinessScopedCafeTools, shadowEnabled: true,
};
const provenance = { sourceId: "p1.authoritative_snapshot.v1", canonicalReaderId: "alex.pricing.atomic_snapshot",
  sourceRevision: "rev-1", purpose: "pricing_review", asOf: "2026-10-19" };
const quality = { missingInputs: [], estimatedInputs: [], staleInputs: [] };

beforeEach(() => { mockRead.mockReset(); });

describe("Alex P3 pricing-review registration", () => {
  it("registers cleanly into the P2/P3 capability registry and is discoverable", () => {
    const [registration] = buildAlexP3Registrations();
    const registry = createP2Registry([registration]);
    expect(registry.discover(scope).map(d => d.id)).toContain(ALEX_P3_REVIEW_ID);
  });

  it("reshapes Alex's real review result into a presentable block with no new math", async () => {
    mockRead.mockResolvedValue({
      status: "verified", provenance, quality,
      value: { currency: "USD", items: [
        { name: "Oat Latte 16oz", status: "ready", currentPriceCents: 550,
          ingredientCostCents: 180, currentRecommendationCents: 600 },
        { name: "Broken Item", status: "unavailable", currentPriceCents: null,
          ingredientCostCents: null, currentRecommendationCents: null },
      ], totalSelected: 2, offset: 0, hasMore: false, omittedUnsupported: 0 },
    });
    const [registration] = buildAlexP3Registrations();
    const raw = await registration.read(scope, { purpose: "pricing_review" });
    expect(raw).toMatchObject({ status: "verified", id: "alex.pricing.review" });
    const value = (raw as { value: unknown[] }).value;
    expect(value).toHaveLength(1); // the "unavailable" row is excluded, never shown as a ready price
    const view = presentRegisteredReads({
      evidence: [{ clause: "pricing", capabilityId: "p3.alex.pricing.review.v1",
        status: "verified", result: raw as Record<string, unknown>, reason: null }],
      includedClauses: ["pricing"], businessId: scope.businessId, asOf: scope.identity.asOf, locale: "en",
    });
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("Menu pricing review"))).toBe(true);
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("$5.50"))).toBe(true);
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("$6.00"))).toBe(true);
  });

  it("returns unavailable, not an empty price list, when Alex denies the read", async () => {
    mockRead.mockResolvedValue({ status: "unavailable", value: null, reason: "source_scope_mismatch" });
    const [registration] = buildAlexP3Registrations();
    const raw = await registration.read(scope, { purpose: "pricing_review" });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "source_scope_mismatch" });
  });
});
