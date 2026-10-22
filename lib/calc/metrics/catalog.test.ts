import { describe,expect,it } from "vitest";
import { computeMetric,metricCatalog,verifiedDailyCogs,type MetricDailyInput } from "./catalog";

const itemId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ingredientId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const recorded:MetricDailyInput={
  date:"2026-10-21",
  facts:{date:"2026-10-21",netSalesCents:20000,ordersCount:20,drinksCount:23,
    ingredientsCents:6000,wagesCents:5000,staffTaxCents:600,
    cardFeesCents:400,voidsCents:0,salesDataStatus:"actual",staffTaxStatus:"actual"},
  items:[{itemId,units:4,revenueCents:2800,
    recipeLines:[{ingredientId,quantity:2}],
    ingredientPriceMicros:{[ingredientId]:1_000_000},ownerCostCents:90}],
  ingredientPriceMicros:{[ingredientId]:1_000_000},
  runningCostsCents:1000,
  orders:[{closedAt:"2026-10-21T18:00:00Z",netSalesCents:16000}],
  timecards:[{clockIn:"2026-10-21T17:00:00Z",clockOut:"2026-10-21T19:00:00Z",
    hourlyWageCents:2000,breaks:[]}],
  timezone:"America/Los_Angeles",
  cogsCoverageVerified:true,laborCoverageVerified:true,itemRevenueVerified:true,attendanceCoverageVerified:true,
  transactionCountVerified:true,
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
    expect(computeMetric("ingredient_unit_cost",{ingredientId},recorded).value).toBe(1_000_000);
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
    expect(computeMetric("cogs_pct",{}, {...recorded,cogsCoverageVerified:false}).value).toBeNull();
    expect(computeMetric("item_margin",{itemId},{...recorded,items:[{...recorded.items![0],hasUnverifiedModifiers:true}]}).invalidatesPrevious).toBe(true);
    expect(computeMetric("item_units",{itemId},{...recorded,items:undefined,itemCoverageInvalidated:true}).invalidatesPrevious).toBe(true);
    expect(computeMetric("item_revenue",{itemId},{...recorded,items:undefined,itemCoverageInvalidated:false}).invalidatesPrevious).toBe(false);
    expect(computeMetric("orders",{}, {...recorded,transactionCountVerified:false}).value).toBeNull();
    expect(computeMetric("avg_ticket",{}, {...recorded,transactionCountVerified:false}).value).toBeNull();
    expect(computeMetric("item_margin",{itemId},{...recorded,items:[{...recorded.items![0],hasUnverifiedModifiers:true}]}).value).toBeNull();
    expect(computeMetric("ingredient_unit_cost",{ingredientId},{...recorded,ingredientPriceMicros:{[ingredientId]:100000}}).value).toBe(100000);
    expect(computeMetric("ingredient_unit_cost",{ingredientId},{...recorded,ingredientPriceMicros:{[ingredientId]:150000}}).value).toBe(150000);
    expect(computeMetric("labor_cost",{}, {...recorded,laborCoverageVerified:false}).value).toBeNull();
    expect(computeMetric("labor_pct",{}, {...recorded,facts:{...recorded.facts!,staffTaxStatus:"estimated"}}).value).toBeNull();
    expect(computeMetric("item_revenue",{itemId}, {...recorded,itemRevenueVerified:false}).coverage).toBe(0);
    expect(computeMetric("sales_per_labor_hour",{fromHour:10,toHour:11},{...recorded,attendanceCoverageVerified:false}).value).toBeNull();
  });
  it("never promotes owner schedules or partially imported timecards to confirmed attendance",()=>{
    const schedule={...recorded,attendanceCoverageVerified:false,
      attendanceSources:["owner_schedule"]};
    expect(computeMetric("sales_per_labor_hour",{fromHour:10,toHour:12},schedule).coverage).toBe(0);
    const partial={...recorded,attendanceCoverageVerified:false,
      attendanceSources:["connected_pos","imported"]};
    expect(computeMetric("sales_per_labor_hour",{fromHour:10,toHour:12},partial).value).toBeNull();
  });
  it("rejects malformed hour range and reports labor-hour gaps",()=>{
    expect(()=>computeMetric("sales_per_labor_hour",{fromHour:18,toHour:9},recorded)).toThrow();
    const result=computeMetric("sales_per_labor_hour",{fromHour:9,toHour:10},recorded);
    expect(result.value).toBeNull();
    expect(result.coverage).toBe(0);
    const covered=computeMetric("sales_per_labor_hour",{fromHour:10,toHour:12},recorded);
    expect(covered).toEqual({value:8000,coverage:1,missing:[]});
  });
  it("proves COGS only when every cost is known and the rollup reconciles",()=>{
    expect(verifiedDailyCogs(recorded.items!,8)).toBe(true);
    expect(verifiedDailyCogs(recorded.items!,9)).toBe(false);
    const incomplete={...recorded.items![0],recipeLines:[],ownerCostCents:null};
    expect(verifiedDailyCogs([incomplete],0)).toBe(false);
    expect(verifiedDailyCogs([],0)).toBe(true);
    expect(computeMetric("cogs_pct",{},{
      ...recorded,facts:{...recorded.facts!,ingredientsCents:8},
      cogsCoverageVerified:verifiedDailyCogs(recorded.items!,8),
    }).value).toBe(4);
  });
  it("has the requested catalog and validated metric parameters",()=>{
    expect(Object.keys(metricCatalog)).toHaveLength(13);
    expect(metricCatalog.item_units.paramsSchema.safeParse({itemId:"invalid"}).success).toBe(false);
  });
});
