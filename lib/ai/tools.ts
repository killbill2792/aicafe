import type { CafeStateService } from "@/lib/operating/cafeState";
import type { CafeDecision, CafeSignal, CafeStatePeriod } from "@/lib/operating/types";
import type { DecisionStore } from "@/lib/operating/decisions";

export interface CafeToolset {
  getCafeSummary(businessId: string): ReturnType<CafeStateService["getCurrentState"]>;
  getProfitability(businessId: string, period: CafeStatePeriod): Promise<unknown>;
  getProductEconomics(businessId: string, productId: string): Promise<unknown>;
  getSalesTrend(businessId: string, period: CafeStatePeriod): Promise<unknown>;
  getPricingRecommendation(businessId: string, productId: string): Promise<unknown>;
  getExpenseChanges(businessId: string, period: CafeStatePeriod): Promise<unknown>;
  getLaborMetrics(businessId: string, period: CafeStatePeriod): Promise<unknown>;
  getInventoryStatus(businessId: string): Promise<unknown>;
  getActiveSignals(businessId: string): Promise<CafeSignal[]>;
  getDecisionHistory(businessId: string): Promise<CafeDecision[]>;
  getOperatingSnapshot(businessId: string): Promise<{ signals: CafeSignal[]; decisions: CafeDecision[] }>;
}

/** Allow-listed projections only: an AI provider never receives a database client. */
export class StructuredCafeTools implements CafeToolset {
  constructor(private states: CafeStateService, private decisions: DecisionStore, private signalReader: (businessId: string) => Promise<CafeSignal[]>) {}
  getCafeSummary(businessId: string) { return this.states.getCurrentState(businessId); }
  async getProfitability(businessId: string, period: CafeStatePeriod) { return (await this.states.getHistoricalState(businessId, period)).profitability; }
  async getProductEconomics(businessId: string, productId: string) { const state = await this.states.getCurrentState(businessId); return state.products.available ? state.products.value.find((p) => p.id === productId) ?? null : null; }
  async getSalesTrend(businessId: string, period: CafeStatePeriod) { return (await this.states.getHistoricalState(businessId, period)).sales; }
  async getPricingRecommendation(businessId: string, productId: string) { const state = await this.states.getCurrentState(businessId); return state.pricingRecommendations.available ? state.pricingRecommendations.value[productId] ?? null : null; }
  async getExpenseChanges(businessId: string, period: CafeStatePeriod) { return (await this.states.getHistoricalState(businessId, period)).expenses; }
  async getLaborMetrics(businessId: string, period: CafeStatePeriod) { const state = await this.states.getHistoricalState(businessId, period); return state.sales.available ? state.sales.value.map(({ date, wagesCents, staffTaxCents }) => ({ date, staffCostCents: wagesCents + staffTaxCents })) : state.sales; }
  async getInventoryStatus(businessId: string) { return (await this.states.getCurrentState(businessId)).inventory; }
  getActiveSignals(businessId: string) { return this.signalReader(businessId); }
  getDecisionHistory(businessId: string) { return this.decisions.getDecisionHistory(businessId); }
  async getOperatingSnapshot(businessId: string) { return { signals: await this.getActiveSignals(businessId), decisions: await this.getDecisionHistory(businessId) }; }
}
