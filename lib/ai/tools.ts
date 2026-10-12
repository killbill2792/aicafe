import type { CafeStateService } from "@/lib/operating/cafeState";
import type { CafeDecision, CafeSignal, CafeStatePeriod, KnownSlice, CafePeriodProfitability, CafeLaborDay, BusinessCostSummary } from "@/lib/operating/types";
import type { DecisionStore } from "@/lib/operating/decisions";
import type { OperatingTask } from "@/lib/operating/tasks";
import type { MenuItemSnapshot, RunningCostLine } from "@/lib/data/types";
import type { DailyFacts, PricingResult, DataQuality } from "@/lib/calc";
import type { MenuCatalogProduct, StaffAttendance } from "./supervisorReads.server";
import type { CurrentStaffProjection, ScheduleProjection, BreakEvenProjection } from "./conversations/domainProjections";
import type { MonthlyBills, RecordedExpenses, SoldProduct, ItemSalesCoverage } from "./supervisorFacts.server";

/** A read-only, evidence-carrying allow-list. The AI never receives a raw DB client. */
export interface CafeToolset {
  getCafeSummary(businessId: string): ReturnType<CafeStateService["getCurrentState"]>;
  getProfitability(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<CafePeriodProfitability>>;
  getBusinessCostSummary(businessId:string,period:CafeStatePeriod):Promise<BusinessCostSummary>;
  getProductEconomics(businessId: string, productId: string): Promise<KnownSlice<MenuItemSnapshot>>;
  getSalesTrend(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<DailyFacts[]>>;
  getPricingRecommendation(businessId: string, productId: string): Promise<KnownSlice<PricingResult>>;
  getExpenseSummary(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<RunningCostLine[]>>;
  /** No comparable previous expense history is wired yet. Do not invent a change. */
  getMonthlyBills(businessId: string): Promise<KnownSlice<MonthlyBills>>;
  getRecordedExpenses(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<RecordedExpenses>>;
  getProductSales(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<SoldProduct[]>>;
  getItemSalesCoverage(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<ItemSalesCoverage>>;
  getMenuCatalog(businessId: string): Promise<KnownSlice<MenuCatalogProduct[]>>;
  getStaffAttendance(businessId: string, period: CafeStatePeriod, timezone: string): Promise<KnownSlice<StaffAttendance>>;
  getCurrentStaff(businessId: string): Promise<KnownSlice<CurrentStaffProjection>>;
  getRecurringSchedule(businessId: string, period: CafeStatePeriod, asOf: string): Promise<KnownSlice<ScheduleProjection>>;
  getBreakEven(businessId: string): Promise<KnownSlice<BreakEvenProjection>>;
  getExpenseChanges(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<never>>;
  getLaborMetrics(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<CafeLaborDay[]>>;
  getInventoryStatus(businessId: string): Promise<KnownSlice<never>>;
  getTeamTasks(businessId: string): Promise<KnownSlice<OperatingTask[]>>;
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
    private taskReader?: (businessId: string) => Promise<OperatingTask[]>,
    private factReaders?: {
      monthlyBills: CafeToolset["getMonthlyBills"];
      recordedExpenses: CafeToolset["getRecordedExpenses"];
      productSales: CafeToolset["getProductSales"];
      itemSalesCoverage: CafeToolset["getItemSalesCoverage"];
    },
    private historicalReaders?: {
      salesTrend: CafeToolset["getSalesTrend"];
      menuCatalog: CafeToolset["getMenuCatalog"];
      staffAttendance: CafeToolset["getStaffAttendance"];
    },
    private domainReaders?: {
      currentStaff: CafeToolset["getCurrentStaff"];
      recurringSchedule: CafeToolset["getRecurringSchedule"];
      breakEven: CafeToolset["getBreakEven"];
    },
  ) {}

  getCafeSummary(businessId: string) { return this.states.getCurrentState(businessId); }
  async getProfitability(businessId: string, period: CafeStatePeriod) {
    return (await this.states.getHistoricalState(businessId, period)).profitability;
  }
  async getBusinessCostSummary(businessId:string,period:CafeStatePeriod){
    return (await this.states.getHistoricalState(businessId,period)).businessCosts;
  }
  async getProductEconomics(businessId: string, productId: string): Promise<KnownSlice<MenuItemSnapshot>> {
    if (!productId) return missing("productId");
    const state = await this.states.getCurrentState(businessId);
    if (!state.products.available) return state.products;
    const product = state.products.value.find((item) => item.id === productId);
    return product ? { available: true, value: product, quality: productQuality(product) } : missing(`product:${productId}`);
  }
  async getSalesTrend(businessId: string, period: CafeStatePeriod): Promise<KnownSlice<DailyFacts[]>> {
    if (this.historicalReaders) return this.historicalReaders.salesTrend(businessId, period);
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
  getMonthlyBills(businessId: string) {
    return this.factReaders?.monthlyBills(businessId) ?? Promise.resolve(missing<MonthlyBills>("recurringBills"));
  }
  getRecordedExpenses(businessId: string, period: CafeStatePeriod) {
    return this.factReaders?.recordedExpenses(businessId, period) ?? Promise.resolve(missing<RecordedExpenses>("actualExpenseEntries"));
  }
  getProductSales(businessId: string, period: CafeStatePeriod) {
    return this.factReaders?.productSales(businessId, period) ?? Promise.resolve(missing<SoldProduct[]>("itemSalesCoverage"));
  }
  getItemSalesCoverage(businessId: string, period: CafeStatePeriod) {
    return this.factReaders?.itemSalesCoverage(businessId, period) ??
      Promise.resolve(missing<ItemSalesCoverage>("itemSalesCoverageNotProven"));
  }
  getMenuCatalog(businessId: string) {
    return this.historicalReaders?.menuCatalog(businessId) ?? Promise.resolve(missing<MenuCatalogProduct[]>("menuCatalog"));
  }
  getStaffAttendance(businessId: string, period: CafeStatePeriod, timezone: string) {
    return this.historicalReaders?.staffAttendance(businessId, period, timezone) ??
      Promise.resolve(missing<StaffAttendance>("timecards"));
  }
  getCurrentStaff(businessId:string) {
    return this.domainReaders?.currentStaff(businessId) ?? Promise.resolve(missing<CurrentStaffProjection>("currentStaff"));
  }
  getRecurringSchedule(businessId:string,period:CafeStatePeriod,asOf:string) {
    return this.domainReaders?.recurringSchedule(businessId,period,asOf) ??
      Promise.resolve(missing<ScheduleProjection>("recurringSchedule"));
  }
  getBreakEven(businessId:string) {
    return this.domainReaders?.breakEven(businessId) ?? Promise.resolve(missing<BreakEvenProjection>("breakEven"));
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
  async getTeamTasks(businessId: string): Promise<KnownSlice<OperatingTask[]>> {
    if (!this.taskReader) return missing("operatingTasks");
    const tasks = await this.taskReader(businessId);
    if (tasks.some((task) => task.businessId !== businessId)) {
      throw new Error("Café task business mismatch");
    }
    return { available: true, value: tasks, quality: {
      level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [],
    } };
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
  getBusinessCostSummary(period:CafeStatePeriod){return this.tools.getBusinessCostSummary(this.businessId,period);}
  getProductEconomics(productId: string) { return this.tools.getProductEconomics(this.businessId, productId); }
  getSalesTrend(period: CafeStatePeriod) { return this.tools.getSalesTrend(this.businessId, period); }
  getPricingRecommendation(productId: string) { return this.tools.getPricingRecommendation(this.businessId, productId); }
  getExpenseSummary(period: CafeStatePeriod) { return this.tools.getExpenseSummary(this.businessId, period); }
  getMonthlyBills() { return this.tools.getMonthlyBills(this.businessId); }
  getRecordedExpenses(period: CafeStatePeriod) { return this.tools.getRecordedExpenses(this.businessId, period); }
  getProductSales(period: CafeStatePeriod) { return this.tools.getProductSales(this.businessId, period); }
  getItemSalesCoverage(period: CafeStatePeriod) { return this.tools.getItemSalesCoverage(this.businessId, period); }
  getMenuCatalog() { return this.tools.getMenuCatalog(this.businessId); }
  getStaffAttendance(period: CafeStatePeriod, timezone: string) {
    return this.tools.getStaffAttendance(this.businessId, period, timezone);
  }
  getCurrentStaff() {return this.tools.getCurrentStaff(this.businessId);}
  getRecurringSchedule(period:CafeStatePeriod,asOf:string) {return this.tools.getRecurringSchedule(this.businessId,period,asOf);}
  getBreakEven() {return this.tools.getBreakEven(this.businessId);}
  getExpenseChanges(period: CafeStatePeriod) { return this.tools.getExpenseChanges(this.businessId, period); }
  getLaborMetrics(period: CafeStatePeriod) { return this.tools.getLaborMetrics(this.businessId, period); }
  getInventoryStatus() { return this.tools.getInventoryStatus(this.businessId); }
  getTeamTasks() { return this.tools.getTeamTasks(this.businessId); }
  getActiveSignals() { return this.tools.getActiveSignals(this.businessId); }
  getDecisionHistory() { return this.tools.getDecisionHistory(this.businessId); }
  getOperatingSnapshot() { return this.tools.getOperatingSnapshot(this.businessId); }
}
