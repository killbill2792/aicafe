import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));
const mockRead = vi.fn();
const mockSimulate = vi.fn();
vi.mock("./alexCapabilities.server", () => ({
  buildAlexPricingRegistrations: () => [{ read: mockRead }, { simulate: mockSimulate }],
}));
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { createP2Registry } from "@/lib/ai/supervisor/p2/registry";
import { buildAlexP3Registrations, ALEX_P3_REVIEW_ID, ALEX_P3_WHATIF_ID } from "./alexP3Capabilities.server";
import { presentRegisteredReads } from "@/lib/ai/supervisor/p3/readEvidencePresentation";

const scope = {
  role: "owner" as const, businessId: "cafe-fixture",
  identity: { businessId: "cafe-fixture", asOf: "2026-10-19", timezone: "America/Los_Angeles", currency: "USD" },
  tools: {} as BusinessScopedCafeTools, shadowEnabled: true,
};
const provenance = { sourceId: "p1.authoritative_snapshot.v1", canonicalReaderId: "alex.pricing.atomic_snapshot",
  sourceRevision: "rev-1", purpose: "pricing_review", asOf: "2026-10-19" };
// simulate() echoes the INPUT purpose (pricing_simulate), never pricing_review — using the
// wrong one here is exactly the bug a previous version of this file shipped (caught in review).
const simulateProvenance = { ...provenance, purpose: "pricing_simulate" };
const quality = { missingInputs: [], estimatedInputs: [], staleInputs: [] };

beforeEach(() => { mockRead.mockReset(); mockSimulate.mockReset(); });

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

describe("Alex P3 pricing-what-if registration (self-contained, no prior lookup needed)", () => {
  it("registers cleanly into the P2/P3 capability registry and is discoverable", () => {
    const [, whatIf] = buildAlexP3Registrations();
    const registry = createP2Registry([whatIf]);
    expect(registry.discover(scope).map(d => d.id)).toContain(ALEX_P3_WHATIF_ID);
  });

  it("reuses Alex's real simulate() output with no new math, and presents a real block " +
    "for a target-only scenario (no selling price applied)", async () => {
    mockSimulate.mockResolvedValue({
      status: "conditional", mode: "simulate", proposal: null, executedEffects: 0,
      provenance: simulateProvenance, quality,
      value: { currency: "USD", productId: "11111111-1111-1111-1111-111111111111", name: "Oat Latte 16oz",
        before: {}, after: {}, priceDeltaCents: 0, ingredientCostDeltaCents: 0,
        // simulateFromAtomicSnapshot never applies an unselected target as a hypothetical
        // price, so this is always exactly 0 for a target-only request — a real result,
        // in the exact real production order (own-cost caveats first, then the
        // ingredient-only caveat), not the convenient order a prior version of this test used.
        ingredientContributionDeltaCents: 0, targetPriceCents: 600, targetBasisPoints: 7000,
        assumptions: ["owner_hypothetical_not_recorded", "recorded_cost_freshness_not_proven",
          "ingredient_only_excludes_labor_fees_rent_and_demand"],
        persisted: false },
    });
    const [, whatIf] = buildAlexP3Registrations();
    const raw = await whatIf.read(scope, { purpose: "pricing_simulate",
      product: { exactName: "Oat Latte 16oz" }, changes: [],
      targetIngredientMarginBps: 7000 });
    expect(raw).toMatchObject({ status: "partial", id: "alex.pricing.what_if",
      // Both unapplied-target zeros must be nulled out (never presented as a real "no
      // change"/"no impact" result), and the decision-critical ingredient-only caveat
      // must survive the 2-code cap even though it is NOT in the first two array
      // positions — all real findings in review (rounds 4 and 6).
      value: [expect.objectContaining({ priceDeltaCents: null, ingredientContributionDeltaCents: null,
        assumptionCodes: ["ingredient_only_excludes_labor_fees_rent_and_demand",
          "recorded_cost_freshness_not_proven"] })] });
    expect(mockSimulate).toHaveBeenCalledWith(scope, expect.objectContaining({
      product: { exactName: "Oat Latte 16oz" },
    }), undefined);
    const view = presentRegisteredReads({
      evidence: [{ clause: "what if", capabilityId: ALEX_P3_WHATIF_ID, status: "partial",
        result: raw as Record<string, unknown>, reason: null }],
      includedClauses: ["what if"], businessId: scope.businessId, asOf: scope.identity.asOf, locale: "en",
    });
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("Pricing what-if"))).toBe(true);
    expect(view.blocks.some(b => b.type === "text" && b.text.includes("$6.00"))).toBe(true);
    // Never a misleading "Price change: $0.00" or "Ingredient-only contribution change:
    // $0.00" next to the nonzero target price — both fields are omitted entirely, not
    // shown as a false zero. (Ingredient cost change is legitimately $0.00 here, since
    // this capability never allows ingredient changes at all, so only the other two
    // labels are checked, not "$0.00" anywhere.)
    const allTextForZeroCheck = view.blocks.filter(b => b.type === "text").map(b => b.text).join(" ");
    expect(allTextForZeroCheck).not.toContain("Price change");
    expect(allTextForZeroCheck).not.toContain("Ingredient-only contribution change");
    // The simulator's caveat is shown as localized plain language, never the raw internal
    // code — passing the raw code straight through to an owner (ES/AR included) was a real
    // finding in review.
    const allText = view.blocks.filter(b => b.type === "text").map(b => b.text).join(" ");
    expect(allText).toContain("Ingredient cost only");
    expect(allText).not.toContain("ingredient_only_excludes_labor_fees_rent_and_demand");
  });

  it("keeps the real margin-impact number when a selling price is actually applied " +
    "(not a target-only request), and drops the irrelevant no-target caveat in favor " +
    "of the real cost-freshness one", async () => {
    mockSimulate.mockResolvedValue({
      status: "conditional", mode: "simulate", proposal: null, executedEffects: 0,
      provenance: simulateProvenance, quality,
      value: { currency: "USD", productId: "11111111-1111-1111-1111-111111111111", name: "Oat Latte 16oz",
        before: {}, after: {}, priceDeltaCents: 50, ingredientCostDeltaCents: 0,
        ingredientContributionDeltaCents: 50, targetPriceCents: null, targetBasisPoints: null,
        // Real production order for a selling-price-only request: no_target_selected_no_target_price
        // is always last (no target was requested at all here).
        assumptions: ["owner_hypothetical_not_recorded", "recorded_cost_freshness_not_proven",
          "ingredient_only_excludes_labor_fees_rent_and_demand", "no_target_selected_no_target_price"],
        persisted: false },
    });
    const [, whatIf] = buildAlexP3Registrations();
    const raw = await whatIf.read(scope, { purpose: "pricing_simulate",
      product: { exactName: "Oat Latte 16oz" }, changes: [],
      sellingPrice: { kind: "delta", deltaCents: 50 } });
    // A real applied price change produces a real margin delta — it must NOT be nulled
    // out the way an unapplied target-only delta is.
    expect(raw).toMatchObject({ status: "partial",
      // no_target_selected_no_target_price only explains an already-absent field (no
      // target was requested) and must never crowd out the cost-freshness caveat under
      // the 2-code cap -- a real finding in review (round 8).
      value: [expect.objectContaining({ ingredientContributionDeltaCents: 50,
        assumptionCodes: ["ingredient_only_excludes_labor_fees_rent_and_demand",
          "recorded_cost_freshness_not_proven"] })] });
  });

  it("returns unavailable, not a targetless 'success', when a target was requested " +
    "but the product has no priced cost basis to compute it from", async () => {
    mockSimulate.mockResolvedValue({
      // simulateFromAtomicSnapshot really does return "partial" (missing inputs, not a
      // hard failure) with targetPriceCents null here -- publishing that as-is would
      // silently drop the one answer the owner asked for.
      status: "partial", mode: "simulate", proposal: null, executedEffects: 0,
      provenance: simulateProvenance,
      quality: { missingInputs: ["owner_total_cost_fallback_not_in_atomic_snapshot"],
        estimatedInputs: [], staleInputs: [] },
      value: { currency: "USD", productId: "11111111-1111-1111-1111-111111111111", name: "Oat Latte 16oz",
        before: {}, after: {}, priceDeltaCents: 0, ingredientCostDeltaCents: 0,
        ingredientContributionDeltaCents: 0, targetPriceCents: null, targetBasisPoints: 7000,
        assumptions: ["owner_hypothetical_not_recorded", "recorded_cost_freshness_not_proven"],
        persisted: false },
    });
    const [, whatIf] = buildAlexP3Registrations();
    const raw = await whatIf.read(scope, { purpose: "pricing_simulate",
      product: { exactName: "Oat Latte 16oz" }, changes: [], targetIngredientMarginBps: 7000 });
    expect(raw).toMatchObject({ status: "unavailable", value: null,
      reason: "owner_total_cost_fallback_not_in_atomic_snapshot" });
  });

  it("returns unavailable, not a price-echo 'success', when a selling-price change was " +
    "requested but its margin impact has no priced cost basis to compute it from", async () => {
    mockSimulate.mockResolvedValue({
      // A recorded selling price with no priced recipe/owner-total cost: the price delta
      // is real, but the margin impact genuinely cannot be computed -- NOT the same as
      // the target-only "unapplied" null handled elsewhere.
      status: "partial", mode: "simulate", proposal: null, executedEffects: 0,
      provenance: simulateProvenance,
      quality: { missingInputs: ["owner_total_cost_missing"], estimatedInputs: [], staleInputs: [] },
      value: { currency: "USD", productId: "11111111-1111-1111-1111-111111111111", name: "Oat Latte 16oz",
        before: {}, after: {}, priceDeltaCents: 50, ingredientCostDeltaCents: null,
        ingredientContributionDeltaCents: null, targetPriceCents: null, targetBasisPoints: null,
        assumptions: ["owner_hypothetical_not_recorded", "recorded_cost_freshness_not_proven"],
        persisted: false },
    });
    const [, whatIf] = buildAlexP3Registrations();
    const raw = await whatIf.read(scope, { purpose: "pricing_simulate",
      product: { exactName: "Oat Latte 16oz" }, changes: [],
      sellingPrice: { kind: "delta", deltaCents: 50 } });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "owner_total_cost_missing" });
  });

  it("rejects a no-op what-if (no selling price, no target) before it ever reaches the " +
    "simulator, instead of silently comparing the product with itself", async () => {
    const [, whatIf] = buildAlexP3Registrations();
    const registry = createP2Registry([whatIf]);
    const result = await registry.invoke(scope, ALEX_P3_WHATIF_ID,
      { purpose: "pricing_simulate", product: { exactName: "Oat Latte 16oz" }, changes: [] });
    expect(result).toMatchObject({ status: "unavailable" });
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  it("returns unavailable, never a fabricated scenario, when Alex's simulator denies it", async () => {
    mockSimulate.mockResolvedValue({ status: "unavailable", mode: "simulate", proposal: null,
      executedEffects: 0, reason: "ambiguous_product_name", value: null });
    const [, whatIf] = buildAlexP3Registrations();
    const raw = await whatIf.read(scope, { purpose: "pricing_simulate",
      product: { exactName: "Latte" }, changes: [] });
    expect(raw).toMatchObject({ status: "unavailable", value: null, reason: "ambiguous_product_name" });
  });

  it("the real registry.invoke() path accepts a successful simulate() result end to end " +
    "(a wrong provenance.purpose here silently became 'invalid_result', not a thrown error — " +
    "calling .read() directly, as the other tests do, could not have caught that)", async () => {
    mockSimulate.mockResolvedValue({
      status: "conditional", mode: "simulate", proposal: null, executedEffects: 0,
      provenance: simulateProvenance, quality,
      value: { currency: "USD", productId: "11111111-1111-1111-1111-111111111111", name: "Oat Latte 16oz",
        before: {}, after: {}, priceDeltaCents: 50, ingredientCostDeltaCents: -20,
        ingredientContributionDeltaCents: 70, targetPriceCents: 600, targetBasisPoints: 7000,
        assumptions: [], persisted: false },
    });
    const [, whatIf] = buildAlexP3Registrations();
    const registry = createP2Registry([whatIf]);
    const result = await registry.invoke(scope, ALEX_P3_WHATIF_ID, { purpose: "pricing_simulate",
      product: { exactName: "Oat Latte 16oz" }, changes: [], targetIngredientMarginBps: 7000 });
    expect(result).toMatchObject({ status: "partial", value: [{ name: "Oat Latte 16oz", targetPriceCents: 600 }] });
  });

  it("rejects an ingredient-substitution attempt at the schema level (no ingredient id the " +
    "model could have legitimately supplied)", () => {
    const [, whatIf] = buildAlexP3Registrations();
    const registry = createP2Registry([whatIf]);
    const discovered = registry.discover(scope).find(d => d.id === ALEX_P3_WHATIF_ID)!;
    // changes is typed/advertised as an empty tuple — the model cannot populate an
    // ingredient_multiplier/replace_ingredient/etc. entry even if it tried to.
    expect(discovered.inputJsonSchema).toMatchObject({
      properties: expect.objectContaining({ changes: expect.objectContaining({ maxItems: 0 }) }),
    });
  });
});
