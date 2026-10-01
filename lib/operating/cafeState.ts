import type { BusinessSnapshot } from "@/lib/data/types";
import { businessEconomics } from "@/lib/calc";
import type { CafeState, CafeStatePeriod, KnownSlice } from "./types";

export interface CafeStateService {
  getCurrentState(businessId: string): Promise<CafeState>;
  getHistoricalState(businessId: string, period: CafeStatePeriod): Promise<CafeState>;
}

export type SnapshotLoader = (businessId: string, period?: CafeStatePeriod) => Promise<BusinessSnapshot>;

/** Concrete composition boundary: loaders may use Supabase today and another read store later. */
export class SnapshotCafeStateService implements CafeStateService {
  constructor(private load: SnapshotLoader) {}
  async getCurrentState(businessId: string): Promise<CafeState> {
    return cafeStateFromSnapshot(await this.load(businessId));
  }
  async getHistoricalState(businessId: string, period: CafeStatePeriod): Promise<CafeState> {
    return cafeStateFromSnapshot(await this.load(businessId, period), period);
  }
}

const missing = <T>(input: string): KnownSlice<T> => ({ available: false, value: null, quality: { level: "low", missingInputs: [input], estimatedInputs: [], staleInputs: [] } });

/** Adapts the existing screen snapshot without manufacturing domains the product does not store. */
export function cafeStateFromSnapshot(snapshot: BusinessSnapshot, period?: CafeStatePeriod): CafeState {
  const days = period
    ? snapshot.monthActualDays.filter((day) => day.date >= period.from && day.date <= period.to)
    : snapshot.monthActualDays;
  const quality = { level: days.length > 0 ? "high" as const : "low" as const, missingInputs: days.length > 0 ? [] : ["salesHistory"], estimatedInputs: snapshot.runningCostLines.filter((line) => line.isEstimate).map((line) => `expense:${line.categoryCode}`), staleInputs: [] };
  const revenue = days.reduce((sum, day) => sum + day.netSalesCents, 0);
  const variable = days.reduce((sum, day) => sum + day.ingredientsCents + day.cardFeesCents, 0);
  const staff = days.reduce((sum, day) => sum + day.wagesCents + day.staffTaxCents, 0);
  const operating = snapshot.runningCostLines.reduce((sum, line) => sum + line.amountCents, 0);
  const known = <T>(value: T): KnownSlice<T> => ({ available: true, value, quality });
  const actualPeriod = period ?? { from: days[0]?.date ?? snapshot.todayDateStr, to: snapshot.todayDateStr };
  return {
    asOf: snapshot.todayDateStr, period: actualPeriod, business: snapshot.business,
    products: known(snapshot.menuItems), sales: known(days), expenses: known(snapshot.runningCostLines),
    profitability: known(businessEconomics({ monthlyRevenueCents: revenue, monthlyVariableProductCostCents: variable, monthlyStaffCostCents: staff, monthlyOperatingCostCents: operating })),
    pricingRecommendations: missing("pricingRecommendations"), inventory: missing("inventory"), suppliers: missing("suppliers"), dataQuality: quality,
  };
}
