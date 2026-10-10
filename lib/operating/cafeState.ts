import type { BusinessSnapshot } from "@/lib/data/types";
import type { PricingResult, DataQuality } from "@/lib/calc";
import {
  netSalesCentsForPeriod,
  totalCostsCentsForPeriod,
  ownerProfitCentsForPeriod,
  runningCostsForPeriodCents,
  runningCostsForPeriodCentsByCategory,
  allocateIntegerCentsByCategory,
  roundHalfUpToCent,
  ratio,
  staffCostCentsForPeriod,
} from "@/lib/calc";
import type { CafeState, CafeStatePeriod, KnownSlice } from "./types";

export interface CafeStateService {
  getCurrentState(businessId: string): Promise<CafeState>;
  getHistoricalState(businessId: string, period: CafeStatePeriod): Promise<CafeState>;
}

export type SnapshotLoader = (businessId: string, period?: CafeStatePeriod) => Promise<BusinessSnapshot>;
export type CanonicalPricingItem = { id: string; pricing: PricingResult | null };
export type CanonicalPricingLoader = (businessId: string) => Promise<CanonicalPricingItem[]>;

/**
 * Composes ONLY pre-existing read sources. The pricing loader is explicitly opt-in:
 * absent data must remain unavailable rather than be synthesized by the Supervisor.
 */
export class SnapshotCafeStateService implements CafeStateService {
  constructor(private load: SnapshotLoader, private loadPricing?: CanonicalPricingLoader) {}

  async getCurrentState(businessId: string): Promise<CafeState> {
    const snapshot = await this.load(businessId);
    assertSnapshotBusiness(snapshot, businessId);
    const pricing = this.loadPricing ? await this.loadPricing(businessId) : undefined;
    return cafeStateFromSnapshot(snapshot, undefined, pricing);
  }

  async getHistoricalState(businessId: string, period: CafeStatePeriod): Promise<CafeState> {
    const snapshot = await this.load(businessId, period);
    assertSnapshotBusiness(snapshot, businessId);
    // Current pricing is not historical pricing. Never attach today's suggestion to a past period.
    return cafeStateFromSnapshot(snapshot, period);
  }
}

function assertSnapshotBusiness(snapshot: BusinessSnapshot, businessId: string) {
  if (!businessId || snapshot.business.id !== businessId) {
    throw new Error("Café snapshot business mismatch");
  }
}

function unavailable<T>(...missingInputs: string[]): KnownSlice<T> {
  return { available: false, value: null, quality: { level: "low", missingInputs, estimatedInputs: [], staleInputs: [] } };
}

function quality(missingInputs: string[], estimatedInputs: string[]): DataQuality {
  const missing = [...new Set(missingInputs)];
  const estimates = [...new Set(estimatedInputs)];
  return {
    level: missing.length > 0 ? "low" : estimates.length > 0 ? "medium" : "high",
    missingInputs: missing,
    estimatedInputs: estimates,
    staleInputs: [],
  };
}

function known<T>(value: T, dataQuality: DataQuality): KnownSlice<T> {
  return { available: true, value, quality: dataQuality };
}

function validDate(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}

function expectedCalendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Only the loaded calendar month is supported. A 28-day list of recent sales is NOT
 * a substitute for prior-month bill evidence, and missing dates are NOT zero-sales days.
 */
function supportedPeriod(snapshot: BusinessSnapshot, period: CafeStatePeriod): boolean {
  return validDate(period.from) && validDate(period.to) && period.from <= period.to &&
    period.from >= `${snapshot.monthKey}-01` &&
    period.to <= snapshot.todayDateStr &&
    period.from.slice(0, 7) === snapshot.monthKey &&
    period.to.slice(0, 7) === snapshot.monthKey;
}

/**
 * Projects the SAME deterministic facts as Home and Money. There is no new pricing,
 * cost calculation, or inferred demand here. All unsupported facts fail closed.
 */
export function cafeStateFromSnapshot(
  snapshot: BusinessSnapshot,
  period: CafeStatePeriod = { from: `${snapshot.monthKey}-01`, to: snapshot.todayDateStr },
  canonicalPricing?: CanonicalPricingItem[],
): CafeState {
  const inRange = supportedPeriod(snapshot, period);
  const days = inRange
    ? snapshot.monthActualDays.filter((day) => day.date >= period.from && day.date <= period.to && day.salesDataStatus !== "missing")
    : [];
  const expectedDays = inRange ? expectedCalendarDays(period.from, period.to) : 0;
  const observedDays = new Set(days.map((day) => day.date)).size;
  const missingSales = inRange && observedDays !== expectedDays;
  const recorded = inRange
    ? (snapshot.monthRecordedDays ?? snapshot.monthActualDays).filter((day) => day.date >= period.from && day.date <= period.to)
    : [];

  const expenseMissing = snapshot.runningCostLines
    .filter((line) => line.isMissing && line.isExpected)
    .map((line) => `expense:${line.categoryCode}`);
  const expenseEstimated = snapshot.runningCostLines
    .filter((line) => line.isEstimate && line.amountCents > 0)
    .map((line) => `expense:${line.categoryCode}`);
  const missingProductCosts = snapshot.menuItems
    .filter((item) => item.quantitySoldLast28Days > 0 && item.costStatus !== "READY")
    .map((item) => `productCost:${item.id}`);
  const estimatedProductCosts = snapshot.menuItems
    .filter((item) => item.quantitySoldLast28Days > 0 && item.costQuality === "estimated")
    .map((item) => `productCost:${item.id}`);
  const feeMissing = days
    .filter((day) => day.netSalesCents > 0 && day.cardFeesStatus === "missing")
    .map((day) => `cardFees:${day.date}`);
  const feeEstimated = days
    .filter((day) => day.cardFeesStatus === "estimated")
    .map((day) => `cardFees:${day.date}`);
  const taxEstimated = recorded
    .filter((day) => day.staffTaxStatus === "estimated")
    .map((day) => `staffTax:${day.date}`);
  const basicMissing = [
    ...(!inRange ? ["periodOutsideLoadedMonth"] : []),
    ...(missingSales ? [`salesCoverage:${observedDays}/${expectedDays}`] : []),
  ];
  const observedQuality = quality([...basicMissing, ...feeMissing], [...feeEstimated, ...taxEstimated]);
  const financialQuality = quality(
    [...basicMissing, ...feeMissing, ...expenseMissing, ...missingProductCosts],
    [...expenseEstimated, ...feeEstimated, ...taxEstimated, ...estimatedProductCosts],
  );

  const labor = recorded.map((day) => ({
    date: day.date,
    wagesCents: day.wagesCents,
    staffTaxCents: day.staffTaxCents,
    loadedStaffCostCents: staffCostCentsForPeriod([day]),
  }));
  const laborDayCount = new Set(labor.map((day) => day.date)).size;
  const laborQuality = quality(
    [
      ...(!inRange ? ["periodOutsideLoadedMonth"] : []),
      ...(laborDayCount !== expectedDays ? [`laborCoverage:${laborDayCount}/${expectedDays}`] : []),
    ],
    taxEstimated,
  );

  const allProductIds = new Set(snapshot.menuItems.map((item) => item.id));
  const pricingByItem: Record<string, PricingResult> = {};
  if (canonicalPricing) {
    for (const item of canonicalPricing) {
      // The canonical menu source is scoped to the same business by its loader. Still
      // deny any returned item not in this already-validated café snapshot.
      if (item.pricing && allProductIds.has(item.id)) pricingByItem[item.id] = item.pricing;
    }
  }
  const pricingQuality = quality(
    Object.entries(pricingByItem).flatMap(([id, result]) => result.dataQuality.missingInputs.map((input) => `pricing:${id}:${input}`)),
    Object.entries(pricingByItem).flatMap(([id, result]) => result.dataQuality.estimatedInputs.map((input) => `pricing:${id}:${input}`)),
  );

  // Monthly running costs must be *calendar-prorated* over the requested range.
  // Full-month costs against today's or sparse sales gave a fictional loss.
  const monthlyLines = snapshot.runningCostLines.map((line) => ({
    categoryCode: line.categoryCode,
    monthKey: snapshot.monthKey,
    amountCents: line.amountCents,
    isEstimate: line.isEstimate,
    isMissing: line.isMissing,
  }));
  const running = inRange ? runningCostsForPeriodCents(monthlyLines, period.from, period.to) : 0;
  // Reuse the SAME cent-safe largest-remainder allocator used by Money's category
  // breakdown, so an arbitrary supported range's detail rows reconcile to the
  // aggregate rounded operating costs even when individual lines have fractional cents.
  const rawByCategory = inRange
    ? runningCostsForPeriodCentsByCategory(monthlyLines, period.from, period.to)
    : new Map<string, number>();
  const allocated = allocateIntegerCentsByCategory(new Map(
    snapshot.runningCostLines
      .filter((line) => !line.isMissing)
      .map((line) => [line.categoryCode, rawByCategory.get(line.categoryCode) ?? 0]),
  ), roundHalfUpToCent(running));
  const periodExpenses = snapshot.runningCostLines.map((line) => ({
    ...line,
    amountCents: line.isMissing ? 0 : allocated.get(line.categoryCode) ?? 0,
  }));
  const salesCents = netSalesCentsForPeriod(days);
  const totalCosts = totalCostsCentsForPeriod(days, running);
  const profit = ownerProfitCentsForPeriod(days, running);
  const financials = {
    netSalesCents: salesCents,
    totalCostsCents: roundHalfUpToCent(totalCosts),
    ownerProfitCents: roundHalfUpToCent(profit),
    operatingMargin: ratio(profit, salesCents),
    coveredSalesDays: observedDays,
    expectedSalesDays: expectedDays,
  };

  return {
    asOf: snapshot.todayDateStr,
    period,
    business: snapshot.business,
    products: known(snapshot.menuItems, quality(missingProductCosts, estimatedProductCosts)),
    sales: !inRange ? unavailable("periodOutsideLoadedMonth") : days.length ? known(days, observedQuality) : unavailable(...basicMissing, "salesHistory"),
    expenses: !inRange ? unavailable("periodOutsideLoadedMonth") : known(periodExpenses, quality(expenseMissing, expenseEstimated)),
    profitability: financialQuality.missingInputs.length || observedDays === 0
      ? { available: false, value: null, quality: financialQuality }
      : known(financials, financialQuality),
    labor: !inRange ? unavailable("periodOutsideLoadedMonth") : labor.length ? known(labor, laborQuality) : unavailable("laborHistory"),
    pricingRecommendations: canonicalPricing === undefined
      ? unavailable("pricingRecommendations")
      : known(pricingByItem, pricingQuality),
    inventory: unavailable("inventory"),
    suppliers: unavailable("suppliers"),
    dataQuality: financialQuality,
  };
}
