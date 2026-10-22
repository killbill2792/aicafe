import { z } from "zod";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { averageOrderValueCents, netSalesCentsForPeriod, ownerProfitCentsForPeriod,
  staffCostCentsForPeriod } from "@/lib/calc/profit";
import { roundHalfUpToCent } from "@/lib/calc/money";
import { paidHoursForTimecard } from "@/lib/calc/staff";
import { evaluateRecipeCost, resolveProductCost } from "@/lib/calc/ingredients";
import type { DailyFacts, RecipeLine, Timecard } from "@/lib/calc/types";

export const metricKeySchema = z.enum([
  "net_sales", "orders", "avg_ticket", "item_units", "item_revenue", "item_margin",
  "cogs_pct", "labor_cost", "labor_pct", "sales_per_labor_hour", "operating_margin",
  "net_profit", "ingredient_unit_cost",
]);
export type MetricKey = z.infer<typeof metricKeySchema>;
export type MetricUnit = "cents" | "bps" | "count" | "ratio";
export type MetricParams = Record<string, unknown>;
export type MetricResult = { value: number | null; coverage: number; missing: string[] };
export type ItemEvidence = {
  itemId: string; units: number; revenueCents: number;
  recipeLines: RecipeLine[];
  ingredientPriceMicros: Record<string,number>;
  ownerCostCents: number | null;
};
export type MetricDailyInput = {
  date: string;
  facts?: DailyFacts;
  items?: ItemEvidence[];
  orders?: Array<{ closedAt: string; netSalesCents: number }>;
  timecards?: Timecard[];
  ingredientPriceMicros?: Record<string,number>;
  runningCostsCents?: number;
  timezone?: string;
};
type Definition = {
  key: MetricKey; unit: MetricUnit;
  paramsSchema: z.ZodType<MetricParams>;
  compute: (day: MetricDailyInput, params: MetricParams) => MetricResult;
};
const empty = z.strictObject({});
const item = z.strictObject({ itemId: z.uuid() });
const ingredient = z.strictObject({ ingredientId: z.uuid() });
const hours = z.strictObject({
  fromHour: z.number().int().min(0).max(23),
  toHour: z.number().int().min(1).max(24),
}).refine(p => p.toHour > p.fromHour, "toHour must be after fromHour");
const missing = (reason: string): MetricResult => ({ value: null, coverage: 0, missing: [reason] });
const known = (value: number): MetricResult =>
  Number.isFinite(value) ? { value, coverage: 1, missing: [] } : missing("invalidValue");
const sales = (day: MetricDailyInput): DailyFacts | null =>
  day.facts && day.facts.salesDataStatus === "actual" ? day.facts : null;
const ratioBps = (part: number, total: number): MetricResult =>
  total > 0 ? known(Math.round(part * 10000 / total)) : missing("noSalesDenominator");
const itemValue = (day: MetricDailyInput, params: MetricParams, field: "units" | "revenue" | "margin"): MetricResult => {
  const id = String(params.itemId);
  if (!sales(day) || !day.items) return missing("itemSalesCoverage");
  const row = day.items.find(i => i.itemId === id);
  if (!row) return known(0); // covered item sales; no lines for this item is a real zero
  if (field === "units") return known(row.units);
  if (field === "revenue") return known(row.revenueCents);
  const recipe = evaluateRecipeCost(row.recipeLines, row.ingredientPriceMicros);
  const resolved = resolveProductCost(recipe, row.ownerCostCents);
  if (resolved.costCents === null) return missing("itemCost");
  return known(roundHalfUpToCent(row.revenueCents - row.units * resolved.costCents));
};
const hourly = (day: MetricDailyInput, params: MetricParams): MetricResult => {
  if (!sales(day) || !day.orders || !day.timecards || !day.timezone) return missing("hourlySalesOrTimecards");
  const parsed = hours.parse(params);
  const start = fromZonedTime(day.date + "T" + String(parsed.fromHour).padStart(2,"0") + ":00:00",day.timezone);
  const endDate = parsed.toHour === 24 ? new Date(Date.parse(day.date + "T12:00:00Z") + 86400000).toISOString().slice(0,10) : day.date;
  const endHour = parsed.toHour === 24 ? 0 : parsed.toHour;
  const end = fromZonedTime(endDate + "T" + String(endHour).padStart(2,"0") + ":00:00",day.timezone);
  if (end <= start) return missing("invalidHourlyWindow");
  const revenue = day.orders.filter(o => {
    const ms=Date.parse(o.closedAt);
    return Number.isFinite(ms) && ms >= start.getTime() && ms < end.getTime() &&
      formatInTimeZone(o.closedAt,day.timezone!) .slice(0,10) === day.date;
  }).reduce((n,o)=>n+o.netSalesCents,0);
  let paid=0;
  for(const tc of day.timecards){
    if(!tc.clockOut) return missing("openTimecard");
    const a = Math.max(start.getTime(),Date.parse(tc.clockIn));
    const b = Math.min(end.getTime(),Date.parse(tc.clockOut));
    if(b<=a)continue;
    const clipped:Timecard = { ...tc, clockIn:new Date(a).toISOString(),clockOut:new Date(b).toISOString(),
      breaks:tc.breaks.map(br => ({...br,start:new Date(Math.max(a,Date.parse(br.start))).toISOString(),
        end:new Date(Math.max(a,Math.min(b,Date.parse(br.end)))).toISOString()})) };
    paid+=paidHoursForTimecard(clipped,new Date(b));
  }
  return paid > 0 ? known(roundHalfUpToCent(revenue/paid)) : missing("noLaborHours");
};
export const metricCatalog: Record<MetricKey, Definition> = {
  net_sales:{key:"net_sales",unit:"cents",paramsSchema:empty,compute:(d)=>sales(d)?known(netSalesCentsForPeriod([d.facts!])):missing("sales")},
  orders:{key:"orders",unit:"count",paramsSchema:empty,compute:(d)=>sales(d)?known(d.facts!.ordersCount):missing("orders")},
  avg_ticket:{key:"avg_ticket",unit:"cents",paramsSchema:empty,compute:d=>sales(d)&&d.facts!.ordersCount>0?known(averageOrderValueCents(d.facts!.netSalesCents,d.facts!.ordersCount)):missing("orders")},
  item_units:{key:"item_units",unit:"count",paramsSchema:item,compute:(d,p)=>itemValue(d,p,"units")},
  item_revenue:{key:"item_revenue",unit:"cents",paramsSchema:item,compute:(d,p)=>itemValue(d,p,"revenue")},
  item_margin:{key:"item_margin",unit:"cents",paramsSchema:item,compute:(d,p)=>itemValue(d,p,"margin")},
  cogs_pct:{key:"cogs_pct",unit:"bps",paramsSchema:empty,compute:d=>sales(d)?ratioBps(d.facts!.ingredientsCents,d.facts!.netSalesCents):missing("salesOrCogs")},
  labor_cost:{key:"labor_cost",unit:"cents",paramsSchema:empty,compute:d=>d.facts?known(staffCostCentsForPeriod([d.facts])):missing("labor")},
  labor_pct:{key:"labor_pct",unit:"bps",paramsSchema:empty,compute:d=>sales(d)?ratioBps(staffCostCentsForPeriod([d.facts!]),d.facts!.netSalesCents):missing("salesOrLabor")},
  sales_per_labor_hour:{key:"sales_per_labor_hour",unit:"cents",paramsSchema:hours,compute:hourly},
  operating_margin:{key:"operating_margin",unit:"bps",paramsSchema:empty,compute:d=>sales(d)&&d.runningCostsCents!==undefined?
    ratioBps(ownerProfitCentsForPeriod([d.facts!],d.runningCostsCents),d.facts!.netSalesCents):missing("runningCostsOrSales")},
  net_profit:{key:"net_profit",unit:"cents",paramsSchema:empty,compute:d=>sales(d)&&d.runningCostsCents!==undefined?
    known(ownerProfitCentsForPeriod([d.facts!],d.runningCostsCents)):missing("runningCostsOrSales")},
  ingredient_unit_cost:{key:"ingredient_unit_cost",unit:"cents",paramsSchema:ingredient,compute:(d,p)=>
    d.ingredientPriceMicros?.[String(p.ingredientId)]!==undefined?
      known(roundHalfUpToCent(d.ingredientPriceMicros[String(p.ingredientId)]/1_000_000)):missing("ingredientPrice")},
};
export function computeMetric(key: MetricKey,params: MetricParams,day: MetricDailyInput): MetricResult {
  const entry=metricCatalog[key];
  return entry.compute(day,entry.paramsSchema.parse(params));
}
