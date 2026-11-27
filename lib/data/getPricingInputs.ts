import "server-only";
import { readDailyFacts } from "./dailyFacts.server";
import { readRunningCostLines } from "./runningCostLines.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import { subDays } from "date-fns";
import { type DailyFacts, type ProductCostSource, type RecipeCostStatus } from "@/lib/calc";
import type { MenuItemCategoryCode } from "@/lib/constants";
import { trustedOrderCountForProcessingFeeEstimate } from "@/lib/pos/processingFeeEstimate";
import {getOwnerConfirmedProcessingFeePlans} from "@/lib/pos/processingFeeEstimate.server";
import {cardFeesForDays} from "@/lib/metrics/core/fees";
import { menuPriceSourceBasis, type MenuPriceSourceBasis } from "@/lib/calc/menuPriceSourceBasis";
import {readProductCosts} from "./productCosts.server";
import { timeReader } from "@/lib/perf/timeReader.server";
import { ordersMayAffectPricing } from "./pricingOrderGate";
import type {MenuCatalogRow} from "./menuCatalog.server";

/** `productCostCents` is the fractional (unrounded) cost when `recipeStatus === "READY"`, and `0`
 * otherwise (safe for the aggregate sums below — a NO_RECIPE/MISSING_INGREDIENT_COST item should
 * contribute nothing to monthlyVariableProductCostCents, not a fabricated number). `productCostStatus`
 * is the same RecipeCostStatus getMenuItemsForEdit.ts already derives via evaluateRecipeCost — this
 * file now calls that same shared function instead of reimplementing its own cost+completeness
 * check, which previously could disagree with getMenuItemsForEdit's own READY/NO_RECIPE verdict. */
export type PricingItemInput = { id: string; name: string; category: MenuItemCategoryCode; currentPriceCents: number; productCostCents: number; productCostStatus: RecipeCostStatus; productCostSource?: ProductCostSource | null; productCostQuality?: "actual" | "estimated"; unitsSoldInWindow: number };
export type PricingBusinessInput = { currency?:string|null; windowDays: number; daysWithSalesInWindow: number; totalOrdersInWindow: number; monthlyRevenueCents: number; monthlyWagesCents?: number | null; monthlyStaffCostCents: number | null; monthlyOperatingCostCents: number; monthlyVariableProductCostCents: number; monthlyProcessingFeesCents: number; processingFeeNotes?:string[]; processingFeesStatus: "actual" | "estimated" | "missing"; productCostsStatus?: "actual" | "estimated" | "missing"; targetOperatingMargin?: number; targetOperatingMarginStatus?: "default" | "confirmed"; payrollTaxRateStatus?: "estimated" | "confirmed"; payrollCostsStatus?: "actual" | "estimated" | "missing"; operatingCostsStatus?: "actual" | "estimated" | "missing" };

/** Known-only rollup wages cannot establish complete monthly payroll. */
export function monthlyPayrollFromDays(days: Pick<DailyFacts,
  "wagesCents"|"staffTaxCents"|"laborWageStatus"|"staffTaxStatus">[],scale:number){
  const complete=days.length>0&&days.every(day=>
    day.laborWageStatus!=="missing"&&day.laborWageStatus!==undefined&&
    day.wagesCents!==null&&day.staffTaxCents!==null);
  if(!complete)return {monthlyWagesCents:null,monthlyStaffCostCents:null,
    payrollCostsStatus:"missing" as const};
  const monthlyWagesCents=Math.round(days.reduce((sum,day)=>sum+day.wagesCents!,0)*scale);
  const monthlyStaffCostCents=Math.round(days.reduce((sum,day)=>
    sum+day.wagesCents!+day.staffTaxCents!,0)*scale);
  return {monthlyWagesCents,monthlyStaffCostCents,
    payrollCostsStatus:days.every(day=>day.staffTaxStatus==="actual"&&day.laborWageStatus==="actual")?
      "actual" as const:"estimated" as const};
}

export async function getPricingInputs(supabase: SupabaseClient, businessId: string, options: { attentionOnly?: boolean; profile?: "Menu" } = {}): Promise<{ items: PricingItemInput[]; business: PricingBusinessInput; menuPriceBasis: MenuPriceSourceBasis }> {
  // Keep all pricing math and evidence in this reader. Home's stages share the
  // existing per-request trace but emit no café, item or financial data.
  const measure = <T>(stage: string, read: () => Promise<T>): Promise<T> =>
    options.attentionOnly || options.profile ? timeReader(options.attentionOnly ? "Home" : "Menu", "pricing." + stage, read) : read();
  const { data: businessRow, error: businessError } = await measure("business", async () =>
    await supabase.from("businesses").select("timezone, currency, target_operating_margin, target_operating_margin_status, payroll_tax_rate_status").eq("id", businessId).single());
  if (businessError) throw businessError;
  if (!businessRow?.timezone) throw new Error("Café timezone missing");
  const timezone = businessRow.timezone;
  const today = new Date();
  const todayDateStr = formatInTimeZone(today, timezone, "yyyy-MM-dd");
  const firstOfMonth = todayDateStr.slice(0,7)+"-01";
  const windowDays = 90;
  const fromDateStr = formatInTimeZone(subDays(today, windowDays - 1), timezone, "yyyy-MM-dd");
  // Begin independent work together. Only the Home attention projection may
  // omit the trusted-order query, and only when even unlimited trusted orders
  // cannot change the canonical engine's BENCHMARK decision.
  const daysPromise = measure("dailyFacts", () => readDailyFacts(supabase, businessId, fromDateStr, todayDateStr));
  const readOrders = () => measure("trustedOrders", async () => await supabase.from("cv_orders")
    .select("business_date,pos_order_id:data->>pos_order_id,net_sales_cents,processing_fee_provider:data->>processing_fee_provider")
    .eq("business_id", businessId).eq("status","actual")
    .gte("business_date", fromDateStr).lte("business_date", todayDateStr));
  const ordersPromise = (async () => {
    if (options.attentionOnly) {
      const coveredDays = await daysPromise;
      if (!ordersMayAffectPricing(coveredDays.filter(day => day.netSalesCents > 0).length, windowDays)) {
        return { data: [], error: null };
      }
    }
    return readOrders();
  })();
  const [itemsResult, days, runningCosts, ordersResult, ownerFeePlans] = await Promise.all([
    supabase.rpc("menu_catalog_for",{p_business_id:businessId})
      .select("id,name,price_cents,category,prep_seconds").eq("is_active",true),
    daysPromise,
    measure("runningCosts", () => readRunningCostLines(supabase,businessId,firstOfMonth,todayDateStr)),
    ordersPromise,
    measure("feePlans", () => getOwnerConfirmedProcessingFeePlans(supabase, businessId)),
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (ordersResult.error) throw ordersResult.error;
  const rawItems = (itemsResult.data ?? []) as Pick<MenuCatalogRow,"id"|"name"|"price_cents"|"category"|"prep_seconds">[];
  const itemIds = rawItems.map((item) => item.id);
  const [costs,quantitiesResult]=await measure("recipeAndUnits",()=>Promise.all([
    readProductCosts(supabase,businessId,itemIds),
    itemIds.length?supabase.rpc("menu_item_quantities_sold",{p_business_id:businessId,p_from:fromDateStr,p_to:todayDateStr}):Promise.resolve({data:[],error:null}),
  ]));
  if(quantitiesResult.error)throw quantitiesResult.error;
  const units=new Map<string,number>((quantitiesResult.data??[]).map((row:{menu_item_id:string;total_quantity:number|string})=>[row.menu_item_id,Number(row.total_quantity)]));
  const items=rawItems.map(item=>{
    const cost=costs.get(item.id)!;
    const category = item.category === "food" ? "FOOD" : item.category === "drink" ? "ESPRESSO_DRINK" : item.category as MenuItemCategoryCode;
    return {
      id: item.id,
      name: item.name,
      category,
      currentPriceCents: item.price_cents ?? 0,
      productCostCents: cost.costCents ?? 0,
      productCostStatus: cost.status,
      productCostSource: cost.source,
      productCostQuality: cost.estimated ? "estimated" as const : "actual" as const,
      unitsSoldInWindow: units.get(item.id) ?? 0,
    };
  });
  const scale = 30 / windowDays;
  const monthlyRevenueCents = Math.round(days.reduce((sum, day) => sum + day.netSalesCents, 0) * scale);
  const {monthlyWagesCents,monthlyStaffCostCents,payrollCostsStatus} =
    monthlyPayrollFromDays(days,scale);
  // Use the same actual -> owner fee plan -> labeled estimate path as the Money screen.
  // A null/missing fee is NOT a verified zero. This reader never writes to the database.
  const feeResult=cardFeesForDays(days,ownerFeePlans);
  const monthlyProcessingFeesCents=Math.round(feeResult.amountCents*scale);
  const salesDayFeeStatuses = days.filter(day => day.netSalesCents > 0).map(day => day.cardFeesStatus ?? "missing");
  const processingFeesStatus = salesDayFeeStatuses.length === 0 || salesDayFeeStatuses.includes("missing")
    ? "missing"
    : salesDayFeeStatuses.includes("estimated") ? "estimated" : "actual";
  const ordersByDate = new Map<string, { posOrderId: string; netSalesCents: number; processingFeeProvider: string | null }[]>();
  for (const order of ordersResult.data ?? []) {
    const rows = ordersByDate.get(order.business_date) ?? [];
    rows.push({
      posOrderId: order.pos_order_id,
      netSalesCents: Number(order.net_sales_cents),
      processingFeeProvider: order.processing_fee_provider,
    });
    ordersByDate.set(order.business_date, rows);
  }
  const trustedOrdersInWindow = days.reduce((sum, day) => {
    const count = trustedOrderCountForProcessingFeeEstimate(
      ordersByDate.get(day.date) ?? [],
      day.netSalesCents,
    );
    return sum + (count ?? 0);
  }, 0);
  // Use the same SQL-backed monthly obligation/receipt evidence as Money.
  const totalItemPrepSecondsInWindow = 0; // period-aligned item mix unavailable
  const menuPriceBasis = menuPriceSourceBasis({
    days:days.map(day=>({
      businessDate:day.date,
      salesStatus:day.salesDataStatus??null,
      netSalesCents:day.netSalesCents,
      drinksCount:day.drinksCount,
      wagesCents:day.wagesCents,
      payrollTaxCents:day.staffTaxCents,
      laborWageStatus:day.laborWageStatus,
      payrollTaxStatus:day.staffTaxStatus??null,
      cardFeesCents:day.cardFeesCents??0,
      cardFeesStatus:day.cardFeesStatus??null,
    })),
    runningCosts,
    totalItemPrepSecondsInWindow,
    asOfBusinessDate:todayDateStr,
    // The current rollup does not persist an independent complete labor
    // reporting interval including zero-work days. Never infer coverage
    // from wages, sales, or tax estimates: keep payroll missing here so
    // the owner must confirm an explicit what-if amount on this screen.
  });
  // Keep a zero placeholder solely for legacy numeric callers. The
  // accompanying explicit missing status MUST be checked before any
  // business-adjusted recommendation/simulation can use this number.
  const monthlyOperatingCostCents = menuPriceBasis.monthlyRunningCents ?? 0;
  const operatingCostsStatus = menuPriceBasis.runningStatus==="missing"
    ? "missing" as const : menuPriceBasis.runningStatus==="recorded"
      ? "actual" as const:"estimated" as const;
  const productCostsStatus =
    items.some((item) => item.unitsSoldInWindow > 0 && item.productCostStatus !== "READY")
      ? "missing" as const
      : items.some((item) => item.unitsSoldInWindow > 0 && item.productCostQuality === "estimated")
        ? "estimated" as const
        : "actual" as const;
  const monthlyVariableProductCostCents = Math.round(items.reduce((sum, item) => sum + item.unitsSoldInWindow * item.productCostCents, 0) * scale);
  return { items, menuPriceBasis, business: { currency:businessRow.currency??null, windowDays, daysWithSalesInWindow: days.filter((day) => day.netSalesCents > 0).length, totalOrdersInWindow: trustedOrdersInWindow, monthlyRevenueCents, monthlyWagesCents, monthlyStaffCostCents, monthlyOperatingCostCents, monthlyVariableProductCostCents, monthlyProcessingFeesCents, processingFeeNotes:feeResult.notes, processingFeesStatus, productCostsStatus,
    targetOperatingMargin: Number(businessRow?.target_operating_margin ?? 0.15),
    targetOperatingMarginStatus: businessRow?.target_operating_margin_status ?? "default",
    payrollTaxRateStatus: businessRow?.payroll_tax_rate_status ?? "estimated",
    payrollCostsStatus,
    operatingCostsStatus,
  } };
}
