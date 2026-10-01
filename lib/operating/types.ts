import type { BusinessSettings, MenuItemSnapshot, RunningCostLine } from "@/lib/data/types";
import type { BusinessEconomicsResult, Confidence, DailyFacts, DataQuality, PricingResult } from "@/lib/calc";

export type CafeStatePeriod = { from: string; to: string };
export type KnownSlice<T> = { available: true; value: T; quality: DataQuality } | { available: false; value: null; quality: DataQuality };
export type CafeState = {
  asOf: string;
  period: CafeStatePeriod;
  business: BusinessSettings;
  products: KnownSlice<MenuItemSnapshot[]>;
  sales: KnownSlice<DailyFacts[]>;
  expenses: KnownSlice<RunningCostLine[]>;
  profitability: KnownSlice<BusinessEconomicsResult>;
  pricingRecommendations: KnownSlice<Record<string, PricingResult>>;
  inventory: KnownSlice<never>;
  suppliers: KnownSlice<never>;
  dataQuality: DataQuality;
};

export const CAFE_SIGNAL_TYPES = [
  "INGREDIENT_COST_INCREASED", "PRODUCT_COST_CHANGED", "PRODUCT_PROFITABILITY_DECLINED", "PRODUCT_HIGH_CONTRIBUTION",
  "SALES_INCREASED", "SALES_DECLINED", "LABOR_COST_CHANGED", "EXPENSE_INCREASED", "OPERATING_MARGIN_DECLINED",
  "PRICE_REVIEW_REQUIRED", "INVENTORY_LOW", "STOCKOUT_RISK", "SUPPLIER_COST_CHANGED", "DATA_INCOMPLETE",
] as const;
export type CafeSignalType = (typeof CAFE_SIGNAL_TYPES)[number];
export type SignalEvidence = { source: string; field: string; value: number | string | boolean | null; observedAt?: string };
export type CafeSignal = {
  id: string;
  type: CafeSignalType;
  entityType?: string;
  entityId?: string;
  currentValue?: number;
  previousValue?: number;
  changePercent?: number;
  period?: string;
  severity: "info" | "warning" | "critical";
  confidence: Confidence;
  evidence: SignalEvidence[];
  dataQuality: DataQuality;
};

export type DecisionType = "PRICE_CHANGE" | "INVENTORY_ORDER" | "STAFFING_CHANGE" | "SUPPLIER_CHANGE" | "MENU_CHANGE" | "PROMOTION" | "COST_REDUCTION";
export type DecisionStatus = "recommended" | "accepted" | "rejected" | "executed" | "dismissed" | "review_later";
export type AutonomyLevel = 1 | 2 | 3 | 4;
export type StructuredRecommendation = { action: string; parameters: Record<string, string | number | boolean | null> };
export type ExpectedImpact = { metric: string; amountCents?: number; percent?: number; period?: string };
export type DecisionProvenance = { calculationVersion: string; dataSnapshot: Record<string, unknown>; assumptions: string[]; ai?: { provider: string; model: string } };
export type CafeDecision = {
  id: string; businessId: string; type: DecisionType; entityType?: string; entityId?: string;
  recommendation: StructuredRecommendation; supportingSignalIds: string[]; confidence: Confidence;
  expectedImpact?: ExpectedImpact; status: DecisionStatus; autonomyLevel: AutonomyLevel;
  provenance: DecisionProvenance; createdAt: Date;
};
export type OutcomeMetric = { metric: string; beforeValue: number | null; afterValue: number | null; unit: "cents" | "count" | "percent" };
export type DecisionOutcome = { id: string; businessId: string; decisionId: string; measurementPeriod: CafeStatePeriod; metrics: OutcomeMetric[]; notes?: string; recordedAt: Date };

export type CafeDomainEventType = "IngredientCostUpdated" | "SaleImported" | "ExpenseUpdated" | "PayrollUpdated" | "PriceChanged" | "InventoryUpdated";
export type CafeDomainEvent = { id: string; type: CafeDomainEventType; businessId: string; entityId?: string; occurredAt: string; payload: Record<string, string | number | boolean | null> };

export type ForecastKind = "demand" | "revenue" | "inventory" | "labor" | "profit";
export type NumericForecast = { kind: ForecastKind; period: CafeStatePeriod; points: { date: string; value: number }[]; confidence: Confidence; method: string; dataQuality: DataQuality };
export interface ForecastProvider { forecast(kind: ForecastKind, state: CafeState, period: CafeStatePeriod): Promise<NumericForecast | null>; }
