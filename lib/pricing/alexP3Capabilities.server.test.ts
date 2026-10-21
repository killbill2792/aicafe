import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));
const mockRead = vi.fn();
const mockSimulate = vi.fn();
vi.mock("./alexOwnerInput.server",()=>({
  alexMissingIngredientCost:vi.fn(async()=>null),
  alexProductCatalogResolution:vi.fn(async()=>null),
}));
vi.mock("./alexCapabilities.server", () => ({
  buildAlexPricingRegistrations: () => [{ read: mockRead }, { simulate: mockSimulate }],
}));
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { createP2Registry } from "@/lib/ai/supervisor/p2/registry";
import { buildAlexP3Registrations, ALEX_P3_REVIEW_ID, ALEX_P3_WHATIF_ID } from "./alexP3Capabilities.server";
import {alexProductCatalogResolution,alexMissingIngredientCost} from "./alexOwnerInput.server";
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

beforeEach(() => { mockRead.mockReset(); mockSimulate.mockReset();
  vi.mocked(alexProductCatalogResolution).mockReset().mockResolvedValue(null);
  vi.mocked(alexMissingIngredientCost).mockReset().mockResolvedValue(null);
});

describe("Alex P3 pricing-review registration", () => {
  it("passes the source-resolved product ID into ingredient-cost help",async()=>{
    const chosenId="a0000000-0000-4000-8000-000000000012";
    vi.mocked(alexProductCatalogResolution).mockResolvedValueOnce({productId:chosenId});
    mockRead.mockResolvedValue({status:"unavailable",value:null,reason:"missing_inputs"});
    const [reg]=buildAlexP3Registrations();
    await reg.read({...scope,durableOwnerInput:true,ownerClause:"Latte ingredient price"},
      {purpose:"pricing_review",product:{exactName:"Latte"}});
    expect(alexMissingIngredientCost).toHaveBeenCalledWith(
      expect.anything(),{productId:chosenId});
  });

  it("keeps an authoritative zero-match result as verified source evidence",async()=>{
    vi.mocked(alexProductCatalogResolution).mockResolvedValueOnce({
      kind:"zero_match",exactName:"Espresso",sourceRevision:"catalog-10",
    });
    const [registration]=buildAlexP3Registrations();
    const registry=createP2Registry([registration]);
    const result=await registry.invoke({...scope,durableOwnerInput:true,
      ownerClause:"Is Espresso on my active menu?"},ALEX_P3_REVIEW_ID,
      {purpose:"pricing_review",product:{exactName:"Espresso"}});
    expect(result).toMatchObject({status:"verified",id:"alex.pricing.catalog_zero_match",
      value:{requestedName:"Espresso",matchingActiveCount:0},
      provenance:{sourceRevision:"catalog-10",purpose:"pricing_review"}});
    expect(mockRead).not.toHaveBeenCalled();
  });

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

  it("includes a 'partial' item -- the normal, honestly-disclosed state for any real " +
    "recipe-priced item (evaluateItem marks recorded ingredient prices freshness-" +
    "unverified, so a real item is essentially never literally 'ready') -- not just " +
    "'ready'; filtering to 'ready' only meant this capability returned no_ready_items " +
    "for any real café. Caught while testing an unrelated fix in PR #106.", async () => {
    mockRead.mockResolvedValue({
      status: "partial", provenance, quality,
      value: { currency: "USD", items: [
        { name: "Oat Latte 16oz", status: "partial", currentPriceCents: 550,
          ingredientCostCents: 180, currentRecommendationCents: 600 },
      ], totalSelected: 1, offset: 0, hasMore: false, omittedUnsupported: 0 },
    });
    const [registration] = buildAlexP3Registrations();
    const raw = await registration.read(scope, { purpose: "pricing_review" });
    expect(raw).toMatchObject({ status: "partial", id: "alex.pricing.review",
      value: [expect.objectContaining({ name: "Oat Latte 16oz", currentPriceCents: 550 })] });
  });

  it("the real registry.invoke() path accepts a realistic long per-item stale-input " +
    "string -- a long product name plus a reason plus a 36-char ingredient UUID can " +
    "exceed a tight length cap and silently fail OUTPUT validation (registry.invoke " +
    "returns unavailable, not a thrown error), discarding an otherwise-good partial " +
    "read. Caught while testing an unrelated fix in PR #106.", async () => {
    const longName = "A".repeat(160);
    mockRead.mockResolvedValue({
      status: "partial", provenance,
      quality: { missingInputs: [], estimatedInputs: [],
        staleInputs: [longName + ":ingredient_price_freshness_unverified:" +
          "a0000000-0000-4000-8000-000000000100"] },
      value: { currency: "USD", items: [
        { name: longName, status: "partial", currentPriceCents: 550,
          ingredientCostCents: 180, currentRecommendationCents: null },
      ], totalSelected: 1, offset: 0, hasMore: false, omittedUnsupported: 0 },
    });
    const [registration] = buildAlexP3Registrations();
    const registry = createP2Registry([registration]);
    const result = await registry.invoke(scope, ALEX_P3_REVIEW_ID, { purpose: "pricing_review" });
    expect(result).toMatchObject({ status: "partial",
      value: [expect.objectContaining({ name: longName })] });
  });
});

describe("Alex P3 pricing-what-if registration (self-contained, no prior lookup needed)", () => {
  it("resolves the product for ingredient-price gap detection in scenarios",async()=>{
    const chosenId="a0000000-0000-4000-8000-000000000012";
    vi.mocked(alexProductCatalogResolution).mockResolvedValueOnce({productId:chosenId});
    mockSimulate.mockResolvedValue({status:"unavailable",value:null,reason:"missing_inputs"});
    const [,whatIf]=buildAlexP3Registrations();
    await whatIf.read({...scope,durableOwnerInput:true,ownerClause:"Latte quantity"},
      {purpose:"pricing_simulate",product:{exactName:"Latte"},changes:[]});
    expect(alexMissingIngredientCost).toHaveBeenCalledWith(
      expect.anything(),{productId:chosenId});
  });

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
      // must survive the cap even though it is NOT in the first array position — all
      // real findings in review (rounds 4 and 6). Cap is 3, not 2 (round 9), so all 3
      // present codes here survive, in priority order.
      value: [expect.objectContaining({ priceDeltaCents: null, ingredientContributionDeltaCents: null,
        assumptionCodes: ["ingredient_only_excludes_labor_fees_rent_and_demand",
          "recorded_cost_freshness_not_proven", "owner_hypothetical_not_recorded"] })] });
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
      // the cap -- a real finding in review (round 8). Cap is 3, not 2 (round 9), so all
      // 3 OTHER present codes survive here.
      value: [expect.objectContaining({ ingredientContributionDeltaCents: 50,
        assumptionCodes: ["ingredient_only_excludes_labor_fees_rent_and_demand",
          "recorded_cost_freshness_not_proven", "owner_hypothetical_not_recorded"] })] });
  });

  it("labels an owner-entered total cost basis as an estimate, and keeps both the " +
    "aggregate-cost and cost-freshness caveats alongside the always-present " +
    "ingredient-only one", async () => {
    mockSimulate.mockResolvedValue({
      status: "conditional", mode: "simulate", proposal: null, executedEffects: 0,
      provenance: simulateProvenance,
      // quality.estimatedInputs carries "owner_total_cost_estimated" whenever costSource
      // is owner_total AND the owner marked that total as an estimate, not a recorded
      // actual figure (lib/pricing/alexPricing.ts).
      quality: { missingInputs: [], estimatedInputs: ["owner_total_cost_estimated"], staleInputs: [] },
      value: { currency: "USD", productId: "11111111-1111-1111-1111-111111111111", name: "Oat Latte 16oz",
        before: {}, after: {}, priceDeltaCents: 50, ingredientCostDeltaCents: 0,
        ingredientContributionDeltaCents: 30, targetPriceCents: null, targetBasisPoints: null,
        // Real production order when costSource is owner_total: the aggregate-cost caveat
        // is inserted between the two "own cost mechanics" codes and the ingredient-only one.
        assumptions: ["owner_hypothetical_not_recorded", "recorded_cost_freshness_not_proven",
          "owner_total_is_aggregate_not_ingredient_recipe",
          "ingredient_only_excludes_labor_fees_rent_and_demand"],
        persisted: false },
    });
    const [, whatIf] = buildAlexP3Registrations();
    const raw = await whatIf.read(scope, { purpose: "pricing_simulate",
      product: { exactName: "Oat Latte 16oz" }, changes: [],
      sellingPrice: { kind: "delta", deltaCents: 50 } });
    expect(raw).toMatchObject({ status: "partial",
      // Without the round-9 cap raise, the 2-code cap would keep only
      // ingredient_only_excludes_labor_fees_rent_and_demand and
      // owner_total_is_aggregate_not_ingredient_recipe, silently dropping the
      // cost-freshness caveat — the exact finding from review (round 9).
      value: [expect.objectContaining({ costBasisEstimated: true,
        assumptionCodes: ["ingredient_only_excludes_labor_fees_rent_and_demand",
          "owner_total_is_aggregate_not_ingredient_recipe", "recorded_cost_freshness_not_proven"] })] });
    const view = presentRegisteredReads({
      evidence: [{ clause: "what if", capabilityId: ALEX_P3_WHATIF_ID, status: "partial",
        result: raw as Record<string, unknown>, reason: null }],
      includedClauses: ["what if"], businessId: scope.businessId, asOf: scope.identity.asOf, locale: "en",
    });
    const allText = view.blocks.filter(b => b.type === "text").map(b => b.text).join(" ");
    expect(allText).toContain("owner-entered estimate");
    expect(allText).toContain("Ingredient cost freshness is not independently verified");
    expect(allText).not.toContain("owner_total_cost_estimated");
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

  it("discovers all canonical recipe what-if parameters by ingredient name", () => {
    const [,whatIf]=buildAlexP3Registrations();
    expect(whatIf.inputSchema.safeParse({purpose:"pricing_simulate",product:{exactName:"Latte"},
      changes:[{kind:"replace_ingredient",fromIngredientName:"Milk",toIngredientName:"Oat milk"}]}).success).toBe(true);
    expect(whatIf.inputSchema.safeParse({purpose:"pricing_simulate",product:{exactName:"Latte"},
      changes:[{kind:"replace_ingredient",fromIngredientId:"invented",toIngredientId:"invented"}]}).success).toBe(false);
  });
});
