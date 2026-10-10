import type { CafeStateService } from "@/lib/operating/cafeState";
import type { CafeDecision, CafeSignal, CafeStatePeriod, KnownSlice, CafePeriodProfitability, CafeLaborDay } from "@/lib/operating/types";
import type { DecisionStore } from "@/lib/operating/decisions";
import type { MenuItemSnapshot, RunningCostLine } from "@/lib/data/types";
import type { DailyFacts, PricingResult, DataQuality } from "@/lib/calc";

/** A read-only, evidence-carrying allow-list. The AI never receives a raw DB client. */
export interface CafeToolset {
  getCafeSummary(businessId: string): ReturnType<CafeStateService["getCurrentState"]>;
  getProfitability(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<CafePeriodProfitability>>;
  getProductEconomics(businessId: string, productId: string): Promise<KnownSlice<MenuItemSnapshot>>;
  getSalesTrend(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<DailyFacts[]>>;
  getPricingRecommendation(businessId: string, productId: string): Promise<KnownSlice<PricingResult>>;
  getExpenseSummary(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<RunningCostLine[]>>;
  /** No comparable previous expense history is wired yet. Do not invent a change. */
  getExpenseChanges(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<never>>;
  getLaborMetrics(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<CafeLaborDay[]>>;
  getInventoryStatus(businessId: string): Promise<KnownSlice<never>>;
  getActiveSignals(businessId: string): Promise<CafeSignal[]>;
  getDecisionHistory(businessId: string): Promise<CafeDecision[]>;
  getOperatingSnapshot(businessId: string): Promise<{ signals: CafeSignal[]; decisions: CafeDecision[] }>;
}

function missing<T>(...inputs: string[]): KnownSlice<T> {
  return { available: false, value: null, quality: { level: "low", missingInputs: inputs, estimatedInputs: [], staleInputs: [] } };
}

function productQuality(product: MenuItemSnapshot): DataQuality {
  const costMissing = product.costStatus !== "READY";
  const estimated = product.costQuality === "estimated";
  return {
    level: costMissing ? "low" : estimated ? "medium" : "high",
    missingInputs: costMissing ? [`productCost:${product.id}`] : [],
    estimatedInputs: estimated ? [`productCost:${product.id}`] : [],
    staleInputs: [],
  };
}

/** Allow-listed projections only: no generic query or database handle escapes this class. */
export class StructuredCafeTools implements CafeToolset {
  constructor(
    private states: CafeStateService,
    private decisions: DecisionStore,
    private signalReader: (businessId: string) => Promise<CafeSignal[]>,
  ) {}

  getCafeSummary(businessId: string) { return this.states.getCurrentState(businessId); }
  async getProfitability(businessId: string, period: CafeStatePeriod) {
    return (await this.states.getHistoricalState(businessId, period)).profitability;
  }
  async getProductEconomics(businessId: string, productId: string): Promise<KnownSlice<MenuItemSnapshot>> {
    if (!productId) return missing("productId");
    const state = await this.states.getCurrentState(businessId);
    if (!state.products.available) return state.products;
    const product = state.products.value.find((item) => item.id === productId);
    return product ? { available: true, value: product, quality: productQuality(product) } : missing(`product:${productId}`);
  }
  async getSalesTrend(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<DailyFacts[]>> {
    const slice = (await this.states.getHistoricalState(businessId, period)).sales;
    if (!slice.available) return slice;
    // A sparse date series is an observation, not evidence of a real trend. The
    // Supervisor may describe partial records only via getCafeSummary, never here.
    if (slice.quality.missingInputs.some((input) => input.startsWith("salesCoverage:"))) {
      return { available: false, value: null, quality: slice.quality };
    }
    return slice;
  }
  async getPricingRecommendation(businessId: string, productId: string): Promise<KnownSlice<PricingResult>> {
    if (!productId) return missing("productId");
    const state = await this.states.getCurrentState(businessId);
    if (!state.pricingRecommendations.available) return state.pricingRecommendations;
    const result = state.pricingRecommendations.value[productId];
    return result ? { available: true, value: result, quality: result.dataQuality } : missing(`pricingRecommendation:${productId}`);
  }
  async getExpenseSummary(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<RunningCostLine[]>> {
    return (await this.states.getHistoricalState(businessId, period)).expenses;
  }
  async getExpenseChanges(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<never>> {
    const current = await this.states.getHistoricalState(businessId, period);
    if (!current.expenses.available) return current.expenses;
    // The snapshot contains this month's costs, not a matched previous period.
    return missing("previousExpenseHistory");
  }
  async getLaborMetrics(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<CafeLaborDay[]>> {
    return (await this.states.getHistoricalState(businessId, period)).labor;
  }
  async getInventoryStatus(businessId: string): Promise<KnownSlice<never>> {
    return (await this.states.getCurrentState(businessId)).inventory;
  }
  getActiveSignals(businessId: string) { return this.signalReader(businessId); }
  async getDecisionHistory(businessId: string) {
    const decisions = await this.decisions.getDecisionHistory(businessId);
    if (decisions.some((decision) => decision.businessId !== businessId)) {
      throw new Error("Café decision business mismatch");
    }
    return decisions;
  }
  async getOperatingSnapshot(businessId: string) {
    const [signals, decisions] = await Promise.all([
      this.getActiveSignals(businessId),
      this.getDecisionHistory(businessId),
    ]);
    return { signals, decisions };
  }
}

/**
 * For the future Supervisor router: business identity is set by the authenticated
 * server, not accepted from AI-proposed tool arguments. No separate agent database.
 */
export class BusinessScopedCafeTools {
  constructor(private tools: CafeToolset, private businessId: string) {
    if (!businessId) throw new Error("Missing authorized café");
  }
  getCafeSummary() { return this.tools.getCafeSummary(this.businessId); }
  getProfitability(period: CafeStatePeriod) { return this.tools.getProfitability(this.businessId, period); }
  getProductEconomics(productId: string) { return this.tools.getProductEconomics(this.businessId, productId); }
  getSalesTrend(period: CafeStatePeriod) { return this.tools.getSalesTrend(this.businessId, period); }
  getPricingRecommendation(productId: string) { return this.tools.getPricingRecommendation(this.businessId, productId); }
  getExpenseSummary(period: CafeStatePeriod) { return this.tools.getExpenseSummary(this.businessId, period); }
  getExpenseChanges(period: CafeStatePeriod) { return this.tools.getExpenseChanges(this.businessId, period); }
  getLaborMetrics(period: CafeStatePeriod) { return this.tools.getLaborMetrics(this.businessId, period); }
  getInventoryStatus() { return this.tools.getInventoryStatus(this.businessId); }
  getActiveSignals() { return this.tools.getActiveSignals(this.businessId); }
  getDecisionHistory() { return this.tools.getDecisionHistory(this.businessId); }
  getOperatingSnapshot() { return this.tools.getOperatingSnapshot(this.businessId); }
}
