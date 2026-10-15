import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";

/**
 * Platform P1: read-only, checked-in inventory, not the P2 model/tool registry.
 * New facts must be accounted for here; no generic SQL or model-selected table.
 * Strict schema identity and selector versions are pinned, not caller provided.
 */
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T12:00:00Z");
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
export const period = z.strictObject({ from: day, to: day }).refine(
  p => p.from <= p.to && (Date.parse(p.to + "T12:00:00Z") - Date.parse(p.from + "T12:00:00Z")) / 86400000 < 366,
  { message: "Unsupported period" },
);
export const money = z.number().int().safe();
export const count = z.number().int().safe().nonnegative();
const finite = z.number().finite();
const text = z.string().max(500);
export const quality = z.strictObject({
  level: z.enum(["low", "medium", "high"]),
  missingInputs: z.array(text).max(200),
  estimatedInputs: z.array(text).max(200),
  staleInputs: z.array(text).max(200),
});
export const slice = <T extends z.ZodType>(schema: T) => z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(true), value: schema, quality }),
  z.strictObject({ available: z.literal(false), value: z.null(), quality }),
]);
const dateValue = day;
const product = z.strictObject({
  id: text, name: text, priceCents: money, prepSeconds: count,
  category: z.enum(["food", "drink"]), active: z.boolean().optional(),
  ingredientsCentsToday: money, hasRecipe: z.boolean(),
  costStatus: z.enum(["READY", "NO_RECIPE", "MISSING_INGREDIENT_COST"]),
  costSource: z.enum(["recipe", "owner_total"]).nullable().optional(),
  recipeCostCents: money.nullable().optional(),
  recipeCostStatus: z.enum(["READY", "NO_RECIPE", "MISSING_INGREDIENT_COST"]).optional(),
  ownerTotalCostCents: money.nullable().optional(),
  costDifferenceCents: money.nullable().optional(),
  costQuality: z.enum(["actual", "estimated"]).nullable().optional(),
  quantitySoldLast28Days: count,
});
const daily = z.strictObject({
  date: dateValue, netSalesCents: money, ordersCount: count, drinksCount: count,
  ingredientsCents: money, wagesCents: money, staffTaxCents: money,
  staffTaxStatus: z.enum(["estimated","actual"]).optional(),
  staffTaxSource: text.optional(), salesDataStatus: z.enum(["actual","missing"]).optional(),
  cardFeesCents: money, cardFeesStatus: z.enum(["actual","estimated","missing"]).optional(), voidsCents: money,
});
const costLine = z.strictObject({
  categoryCode: z.enum(["rent","utilities_power","water","internet","insurance","loan","software","supplies","repairs","ingredients","other"]),
  label: text, amountCents: money, isEstimate: z.boolean(), isMissing: z.boolean(), isExpected: z.boolean().optional(),
});
const profitability = z.strictObject({
  netSalesCents: money, totalCostsCents: money, ownerProfitCents: money, operatingMargin: finite,
  coveredSalesDays: count, expectedSalesDays: count,
}).refine(v => v.coveredSalesDays <= v.expectedSalesDays, "Invalid coverage");
const costs = z.strictObject({
  period: period, knownTotalCents: money, completeness: z.enum(["complete","partial","unavailable"]),
  components: z.strictObject({ingredientsCents:money,loadedStaffCents:money,cardFeesCents:money,runningCostsCents:money}),
  observed: z.strictObject({ingredients:z.boolean(),loadedStaff:z.boolean(),cardFees:z.boolean(),runningCosts:z.boolean()}),
  missingInputs:z.array(text),estimatedInputs:z.array(text),
  coverage:z.strictObject({
    salesDays:count,laborDays:count,expectedDays:count,missingProductCostCount:count,
    itemSalesCovered:z.boolean(),soldProductCount:count.nullable(),estimatedProductCostCount:count,
    historicalIngredientCostsProven:z.boolean(),
    soldProductIds:z.array(text),missingProductCostIds:z.array(text),estimatedProductCostIds:z.array(text),
    missingFeeDays:count,missingOperatingCategories:z.array(z.strictObject({code:text,label:text})),
  }),
});
const pricing = z.strictObject({
  productCostCents:money.nullable(),baselinePriceCents:money.nullable(),
  calculatedSuggestedPriceCents:money.nullable(),currentPriceCents:money,
  recommendedPriceCents:money.nullable(),calculationMode:z.enum(["BENCHMARK","BUSINESS_ADJUSTED"]),
  businessAdjustmentFactor:finite,confidence:z.enum(["LOW","MEDIUM","HIGH"]),
  status:z.enum(["NEW_PRICE","KEEP_CURRENT_PRICE","REVIEW_PRICE","PRICE_UNAVAILABLE"]),
  explanationCode:z.enum(["BENCHMARK_EXPLAINER","BUSINESS_ADJUSTED_EXPLAINER","INCOMPLETE_DATA_EXPLAINER"]),
  assumptions:z.array(text),signals:z.array(text),
  explanationInputs:z.record(z.string(),z.union([finite,z.string(),z.boolean()])),
  dataQuality:quality,
  warnings:z.array(z.enum(["BUSINESS_ADJUSTMENT_CAPPED","CATEGORY_PRICE_OUTLIER","CATEGORY_COST_PERCENT_OUTLIER","INCOMPLETE_RECIPE","LOW_SAMPLE_SIZE"])),
}).superRefine((r,ctx)=>{
  if(r.status==="PRICE_UNAVAILABLE" && r.recommendedPriceCents!==null)
    ctx.addIssue({code:"custom",message:"Unavailable price must be null"});
  if(r.status!=="PRICE_UNAVAILABLE" && (r.productCostCents===null || r.recommendedPriceCents===null))
    ctx.addIssue({code:"custom",message:"Ready price must be grounded"});
});
const task = z.strictObject({
  id:text,businessId:text,agentId:z.enum(["alex","olivia","maya","leo"]),
  kind:z.enum(["price_review","staff_coverage","supply_check","money_update","data_quality"]),
  entityType:text.optional(),entityId:text.optional(),
  status:z.enum(["watching","needs_response","needs_owner","handled","expired"]),
  payload:z.record(z.string(),z.union([text,finite,z.boolean(),z.null()])),
  confidence:z.enum(["low","medium","high"]),
  evidence:z.array(z.strictObject({source:text,facts:z.record(z.string(),z.union([text,finite,z.boolean(),z.null()]))})),
  createdAt:z.string().datetime({offset:true}),resolvedAt:z.string().datetime({offset:true}).optional(),
});
const person = z.strictObject({
  name:text,role:text.nullable(),sourceType:z.enum(["owner_schedule","owner_manual","connected_pos","imported","ai_cafe"]).optional(),
  sourceProvider:text.nullable().optional(),start:z.string().datetime({offset:true}),
  breakStatus:z.string(),isSchedulePrediction:z.boolean(),
});
export const values = {
  "business.profile": z.strictObject({
    businessId:text,name:text,timezone:text,currency:text,openedOn:day.nullable(),
    locations:z.array(z.strictObject({id:text,name:text,addressLine1:text.nullable(),
      city:text.nullable(),region:text.nullable(),countryCode:text.nullable()})).max(100),
  }),
  "menu.recipe": z.strictObject({
    id:text,name:text,priceCents:money,costStatus:z.enum(["READY","NO_RECIPE","MISSING_INGREDIENT_COST"]),
    recipe:z.array(z.strictObject({ingredientId:text,ingredientName:text,
      baseUnit:z.enum(["g","ml","each"]),quantity:finite.nonnegative(),
      displayUnit:text.nullable(),displayQuantity:finite.nullable(),
      priceSource:z.enum(["manual","receipt","statement","invoice"]).nullable()})).max(200),
  }),
  "menu.ingredients": z.array(z.strictObject({id:text,name:text,baseUnit:z.enum(["g","ml","each"])})).max(500),
  "labor.employee_wages": z.array(z.strictObject({
    id:text,name:text,role:text.nullable(),active:z.boolean(),
    defaultHourlyWageCents:money.nullable(),wagePeriod:z.enum(["hour","month","year"]),
    wageAmountCents:money.nullable(),wageKnown:z.boolean(),
  }).refine(row=>row.wageKnown===(row.defaultHourlyWageCents!==null||row.wageAmountCents!==null))).max(500),
  "supplies.quotes": z.strictObject({
    items:z.array(z.strictObject({id:text,supplierName:text,itemName:text,priceCents:money,
      packageCount:count,packageUnit:z.enum(["each","oz","lb","kg","gal","liter","case"]),
      sourceKind:z.enum(["supplier_email","supplier_quote","public_listing"]),
      sourceUrl:z.string().url().nullable(),quotedOn:day,
      evidenceStatus:z.literal("owner_reported"),createdAt:z.string().datetime({offset:true})})).max(40),
    truncated:z.boolean(),
  }),
  "team.owner_rules": z.strictObject({
    rules:z.array(z.strictObject({id:text,agentId:z.enum(["supervisor","alex","olivia","maya","leo"]),
      instruction:z.string().max(1000),status:z.literal("active"),version:count,
      updatedAt:z.string().datetime({offset:true}),isExecutionAuthority:z.literal(false)})).max(20),
    truncated:z.boolean(),
  }),
  "labor.availability_foundation": z.strictObject({
    enabled:z.literal(true),
    recordCounts:z.strictObject({
      availability_rule:count,availability_exception:count,preferences:count,
      preference_window:count,qualification_type:count,qualification:count,
      coverage:count,compensation:count,
    }),
  }),
  "money.expense_entries": z.array(z.strictObject({
    id:text,spentOn:day,categoryCode:text,amountCents:money,
    status:z.enum(["actual","estimated"]),source:text,
  })).max(500),
  "money.profitability": profitability,
  "money.business_costs": costs,
  "menu.product_economics": product,
  "sales.daily": z.array(daily).max(366),
  "pricing.recommendation": pricing,
  "money.expense_categories": z.array(costLine).max(100),
  "money.monthly_bills": z.strictObject({totalCents:money}),
  "money.recorded_spending": z.strictObject({totalCents:money}),
  "sales.item_units": z.array(z.strictObject({id:text,name:text,category:z.enum(["drink","food"]),units:count})).max(500),
  "sales.item_coverage": z.strictObject({covered:z.boolean(),sources:z.array(text).max(5),from:day.nullable(),through:day.nullable()}),
  "menu.catalog": z.array(z.strictObject({id:text,name:text,category:z.enum(["drink","food"]),active:z.boolean(),priceCents:money})).max(500),
  "labor.attendance": z.strictObject({timecardCount:count,onClockCount:count}).refine(v=>v.onClockCount<=v.timecardCount),
  "labor.current_staff": z.strictObject({count:count,asOf:z.string().datetime({offset:true}),people:z.array(person).max(15)}),
  "labor.recurring_assignments": z.strictObject({
    source:z.literal("owner_recurring_schedule"),from:day,to:day,
    shifts:z.array(z.strictObject({displayName:text.nullable(),dayOfWeek:z.number().int().min(0).max(6),
      startTime:z.string().regex(/^\d\d:\d\d$/),endTime:z.string().regex(/^\d\d:\d\d$/),
      effectiveFrom:day,effectiveTo:day.nullable()})).max(30),
  }),
  "money.break_even": z.strictObject({
    drinksNeededPerDay:count,drinksPerHour:finite.nonnegative(),todayDrinks:count.nullable(),
    dailyCostsToCoverCents:money,averageMoneyLeftPerDrinkCents:money,progressPercent:finite.nullable(),
  }),
  "labor.daily_costs": z.array(z.strictObject({date:day,wagesCents:money,staffTaxCents:money,loadedStaffCostCents:money})).max(366),
  "team.tasks": z.array(task).max(1000),
} as const;

export type SupportedId = keyof typeof values;
export const PUBLIC_TOOL_METHODS = [
  "getCafeSummary","getProfitability","getBusinessCostSummary","getProductEconomics",
  "getSalesTrend","getPricingRecommendation","getExpenseSummary","getMonthlyBills",
  "getRecordedExpenses","getProductSales","getItemSalesCoverage","getMenuCatalog",
  "getStaffAttendance","getCurrentStaff","getRecurringSchedule","getBreakEven",
  "getExpenseChanges","getLaborMetrics","getInventoryStatus","getTeamTasks",
  "getActiveSignals","getDecisionHistory","getOperatingSnapshot",
] as const satisfies readonly (keyof BusinessScopedCafeTools)[];

export const readers = {
  "business.profile":"readP1BusinessProfile",
  "menu.recipe":"readP1Recipe",
  "menu.ingredients":"readP1Ingredients",
  "labor.employee_wages":"readP1EmployeeWages",
  "supplies.quotes":"readP1SupplierQuotes",
  "team.owner_rules":"readP1OwnerRules",
  "labor.availability_foundation":"readP1SchedulingFoundation",
  "money.expense_entries":"readP1ExpenseEntries",
  "money.profitability":"getProfitability",
  "money.business_costs":"getBusinessCostSummary",
  "menu.product_economics":"getProductEconomics",
  "sales.daily":"getSalesTrend",
  "pricing.recommendation":"getPricingRecommendation",
  "money.expense_categories":"getExpenseSummary",
  "money.monthly_bills":"getMonthlyBills",
  "money.recorded_spending":"getRecordedExpenses",
  "sales.item_units":"getProductSales",
  "sales.item_coverage":"getItemSalesCoverage",
  "menu.catalog":"getMenuCatalog",
  "labor.attendance":"getStaffAttendance",
  "labor.current_staff":"getCurrentStaff",
  "labor.recurring_assignments":"getRecurringSchedule",
  "money.break_even":"getBreakEven",
  "labor.daily_costs":"getLaborMetrics",
  "team.tasks":"getTeamTasks",
} as const satisfies Record<SupportedId,string>;

/** Nonexposed surfaces cannot silently become "supported" or free model tools. */
export const classified = {
  getCafeSummary:{kind:"restricted",reason:"Includes mixed personal and financial state; use bounded projections"},
  getExpenseChanges:{kind:"unsupported",reason:"Comparable historical cost series not implemented"},
  getInventoryStatus:{kind:"unsupported",reason:"No verified stock counts or inventory feed"},
  getActiveSignals:{kind:"restricted",reason:"Raw signal evidence not a public typed record contract"},
  getDecisionHistory:{kind:"restricted",reason:"Decision provenance may contain sensitive internal snapshots"},
  getOperatingSnapshot:{kind:"restricted",reason:"Composite raw signal and decision provenance"},
} as const;
export const additionalSurfaces = {
  orders_raw:{kind:"restricted",source:"lib/pos/square/adapter.ts",reason:"No authorized P1 raw-order service with complete coverage"},
  attachments_extraction:{kind:"unsupported",source:"lib/ai/conversations/attachments.ts",reason:"Attachment storage is not verified parsing"},
  bank_feed:{kind:"unsupported",source:"lib/operating/cafeState.ts",reason:"No consented bank feed"},
  verified_waste:{kind:"unsupported",source:"lib/operating/cafeState.ts",reason:"No verified waste ledger"},
  scheduling_optimizer:{kind:"unsupported",source:"lib/calc/scheduling/availability.ts",reason:"Optimizer and publication not shipped"},
  worker_acceptance:{kind:"unsupported",source:"lib/scheduling/foundation.server.ts",reason:"Schedule is not worker acceptance"},
} as const;

const owners = {money:"leo",sales:"leo",menu:"alex",pricing:"alex",labor:"olivia",team:"supervisor",business:"supervisor",supplies:"maya"} as const;
export const purposePolicies = {
  "business.profile":["selected_business_profile"],
  "menu.recipe":["owner_recipe_review"],
  "menu.ingredients":["owner_ingredient_catalog"],
  "labor.employee_wages":["authorized_owner_wage_review"],
  "supplies.quotes":["owner_reported_quote_review"],
  "team.owner_rules":["active_owner_guidance_read"],
  "labor.availability_foundation":["activated_manual_staffing_foundation"],
  "money.expense_entries":["recorded_expense_entry_review"],
  "money.profitability":["actual_period_financial_review"],
  "money.business_costs":["actual_period_cost_review"],
  "menu.product_economics":["current_recipe_cost_review"],
  "sales.daily":["actual_daily_sales"],
  "pricing.recommendation":["current_pricing_review"],
  "money.expense_categories":["actual_period_expense_review"],
  "money.monthly_bills":["recurring_obligation_review"],
  "money.recorded_spending":["recorded_actual_spending"],
  "sales.item_units":["covered_item_sales"],
  "sales.item_coverage":["item_sales_coverage_check"],
  "menu.catalog":["menu_catalog_review"],
  "labor.attendance":["recorded_attendance"],
  "labor.current_staff":["current_staff_view"],
  "labor.recurring_assignments":["future_owner_assignment_review"],
  "money.break_even":["current_break_even_review"],
  "labor.daily_costs":["recorded_labor_cost_review"],
  "team.tasks":["owner_task_review"],
} as const satisfies Record<SupportedId,readonly [string,...string[]]>;

export type P1Kind = "metric" | "entity_read" | "analysis";
export const metricIds = [
  "money.profitability","money.business_costs","money.monthly_bills","money.recorded_spending",
  "labor.attendance","money.break_even","labor.daily_costs",
] as const;
export const analysisIds = ["pricing.recommendation"] as const;
export function kindFor(id: SupportedId): P1Kind {
  return (analysisIds as readonly string[]).includes(id) ? "analysis"
    : (metricIds as readonly string[]).includes(id) ? "metric" : "entity_read";
}
export function ownerFor(id: SupportedId) { return owners[id.split(".")[0] as keyof typeof owners]; }
export const sourcePolicies = Object.fromEntries((Object.keys(values) as SupportedId[]).map(id=>[
  id,Object.fromEntries(purposePolicies[id].map(p=>[p,{
    canonicalReaderId:readers[id],readerContractVersion:1,
    selectorContractId:id+".selector",selectorContractVersion:1,
    sourcePurpose:p,precedencePolicyId:id+".canonical",precedencePolicyRevision:1,
    minCoverage:"partial_explicit",requiredSourceStatuses:["selected"],
  }])),
])) as Record<SupportedId,Record<string,{
  canonicalReaderId:string;readerContractVersion:number;selectorContractId:string;selectorContractVersion:number;
  sourcePurpose:string;precedencePolicyId:string;precedencePolicyRevision:number;
  minCoverage:string;requiredSourceStatuses:string[];
}>>;
export const inputFor = (id: SupportedId) => z.strictObject({
  id:z.literal(id), version:z.literal(1), purpose:z.enum(purposePolicies[id] as unknown as [string,...string[]]),
  ...(new Set(["money.profitability","money.business_costs","sales.daily","money.expense_categories","money.expense_entries",
    "money.recorded_spending","sales.item_units","sales.item_coverage","labor.attendance",
    "labor.recurring_assignments","labor.daily_costs"]).has(id) ? {period} : {}),
  ...(new Set(["menu.product_economics","pricing.recommendation","menu.recipe"]).has(id) ? {productId:z.string().min(1).max(120)} : {}),
});
export function discoverP1() {
  return (Object.keys(values) as SupportedId[]).map(id=>({
    id,version:1 as const,kind:kindFor(id),owner:ownerFor(id),
    canonicalReader:readers[id],allowedPurposes:purposePolicies[id],
    selectorContractId:id+".selector",selectorContractVersion:1,
    temporalBasis:"business_local" as const,
    granularity: id==="sales.daily"||id==="labor.daily_costs" ? "day" : "aggregate",
    unit: id==="money.monthly_bills"||id==="money.recorded_spending" ? "USD_cents" : "typed_record",
    sensitivity:id.startsWith("labor.")?"staff" as const:id.startsWith("money.")?"financial" as const:"normal" as const,
  }));
}
