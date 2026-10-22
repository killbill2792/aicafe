import { describe,expect,it } from "vitest";
import { computeMetric,metricCatalog,type MetricDailyInput } from "./catalog";

const itemId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ingredientId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const recorded:MetricDailyInput={
  date:"2026-10-21",
  facts:{date:"2026-10-21",netSalesCents:20000,ordersCount:20,drinksCount:23,
    ingredientsCents:6000,wagesCents:5000,staffTaxCents:600,
    cardFeesCents:400,voidsCents:0,salesDataStatus:"actual"},
  items:[{itemId,units:4,revenueCents:2800,
    recipeLines:[{ingredientId,quantity:2}],
    ingredientPriceMicros:{[ingredientId]:1_000_000},ownerCostCents:90}],
  ingredientPriceMicros:{[ingredientId]:1_000_000},
  runningCostsCents:1000,
  orders:[{closedAt:"2026-10-21T18:00:00Z",netSalesCents:16000}],
  timecards:[{clockIn:"2026-10-21T17:00:00Z",clockOut:"2026-10-21T19:00:00Z",
    hourlyWageCents:2000,breaks:[]}],
  timezone:"America/Los_Angeles",
};
describe("M1 typed metric catalog",()=>{
  it("uses canonical sales and margin calculators",()=>{
    expect(computeMetric("net_sales",{},recorded).value).toBe(20000);
    expect(computeMetric("orders",{},recorded).value).toBe(20);
    expect(computeMetric("avg_ticket",{},recorded).value).toBe(1000);
    expect(computeMetric("item_units",{itemId},recorded).value).toBe(4);
    expect(computeMetric("item_revenue",{itemId},recorded).value).toBe(2800);
    expect(computeMetric("item_margin",{itemId},recorded).value).toBe(2792);
    expect(computeMetric("labor_cost",{},recorded).value).toBe(5600);
    expect(computeMetric("labor_pct",{},recorded).value).toBe(2800);
    expect(computeMetric("cogs_pct",{},recorded).value).toBe(3000);
    expect(computeMetric("net_profit",{},recorded).value).toBe(7000);
    expect(computeMetric("ingredient_unit_cost",{ingredientId},recorded).value).toBe(1);
  });
  it("requires real coverage and does not turn missing data into zero",()=>{
    const missingDay:MetricDailyInput={date:"2026-10-20"};
    for(const key of ["net_sales","orders","cogs_pct","labor_cost","net_profit"] as const){
      const result=computeMetric(key,{},missingDay);
      expect(result.value).toBeNull();
      expect(result.coverage).toBeLessThan(1);
      expect(result.missing.length).toBeGreaterThan(0);
    }
    expect(computeMetric("item_margin",{itemId}, {...recorded,items:undefined}).value).toBeNull();
    expect(computeMetric("net_profit",{}, {...recorded,runningCostsCents:undefined}).value).toBeNull();
  });
  it("rejects malformed hour range and reports labor-hour gaps",()=>{
    expect(()=>computeMetric("sales_per_labor_hour",{fromHour:18,toHour:9},recorded)).toThrow();
    const result=computeMetric("sales_per_labor_hour",{fromHour:9,toHour:10},recorded);
    expect(result.value).toBeNull();
    expect(result.coverage).toBe(0);
    const covered=computeMetric("sales_per_labor_hour",{fromHour:10,toHour:12},recorded);
    expect(covered).toEqual({value:8000,coverage:1,missing:[]});
  });
  it("has the requested catalog and validated metric parameters",()=>{
    expect(Object.keys(metricCatalog)).toHaveLength(13);
    expect(metricCatalog.item_units.paramsSchema.safeParse({itemId:"invalid"}).success).toBe(false);
  });
});
