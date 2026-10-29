import {describe,it,expect,vi,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {supervisorHistoricalReaders} from "./supervisorReads.server";
import {buildDayWindows} from "@/lib/calc";
import {rowToDailyFacts} from "@/lib/data/runningCostCatalog";
type Row={business_date:string;sales_data_status:string|null;net_sales_cents:number;orders_count:number;drinks_count:number;
  ingredients_cents:number;staff_wages_cents:number;staff_tax_cents:number;staff_tax_status:string;
  staff_tax_source:string;card_fees_cents:number;card_fees_status:string;voids_cents:number};
const row=(status:string|null,sales=0,orders=0,date="2026-10-12"):Row=>({
  business_date:date,sales_data_status:status,net_sales_cents:sales,
  orders_count:orders,drinks_count:0,ingredients_cents:0,staff_wages_cents:0,
  staff_tax_cents:0,staff_tax_status:"missing",staff_tax_source:"unknown",
  card_fees_cents:0,card_fees_status:"missing",voids_cents:0,
});
function reader(rows:Row[]){
  const query={select:()=>query,eq:()=>query,gte:()=>query,lte:()=>query,
    order:()=>query,limit:async()=>({data:rows,error:null})};
  return supervisorHistoricalReaders({from:()=>query} as unknown as SupabaseClient,"my-cafe");
}
describe("Canonical sales status strictly distinguishes verified zero and missing",()=>{
  const period={from:"2026-10-12",to:"2026-10-12"};
  it("returns recorded verified $0 and 0 orders when status is explicitly actual",async()=>{
    const slice=await reader([row("actual")]).salesTrend("my-cafe",period);
    expect(slice.available).toBe(true);
    if(slice.available)expect(slice.value).toMatchObject([{date:"2026-10-12",
      netSalesCents:0,ordersCount:0}]);
  });
  it.each([null,"missing","unknown"])("never calls %s status actual or invents zero",async status=>{
    const slice=await reader([row(status)]).salesTrend("my-cafe",period);
    expect(slice.available).toBe(false);
    expect(slice.quality.missingInputs).toContain("noCoveredSalesRows");
  });
  it("preserves real positive sales and identifies partial date coverage",async()=>{
    const period={from:"2026-10-11",to:"2026-10-12"};
    const slice=await reader([row("actual",2500,3,"2026-10-11"),row(null,0,0)]).salesTrend("my-cafe",period);
    expect(slice.available).toBe(true);
    if(slice.available)expect(slice.value).toMatchObject([{date:"2026-10-11",
      netSalesCents:2500,ordersCount:3}]);
    expect(slice.quality.missingInputs).toContain("salesCoverage:1/2");
  });
  it("rejects cross-café reads before querying data",async()=>{
    await expect(reader([row("actual")]).salesTrend("other-cafe",period)).rejects.toThrow("scope");
  });
});


afterEach(()=>vi.unstubAllEnvs());
function pilotReader(rows:Row[],rpcDates:string[],canonicalToastDates:string[],broken=false,flags:unknown[]=[]){
 const rollup={select:()=>rollup,eq:()=>rollup,gte:()=>rollup,lte:()=>rollup,
  order:()=>rollup,limit:async()=>({data:rows,error:null})};
 const orders={select:()=>orders,eq:()=>orders,like:()=>orders,in:()=>orders,order:()=>orders,
  range:async(start:number,end:number)=>broken?{data:null,error:{message:"connection failed"}}:
   {data:canonicalToastDates.slice(start,end+1).map((business_date,i)=>({id:start+i,business_date})),error:null}};
 const flagsRead={select:()=>flagsRead,eq:()=>flagsRead,gte:()=>flagsRead,lte:()=>flagsRead,
  order:()=>flagsRead,range:async(a:number,b:number)=>broken?
    {data:null,error:{message:"status check unavailable"}}:{data:flags.slice(a,b+1),error:null}};
 const ownerFlags={select:()=>ownerFlags,eq:()=>ownerFlags,is:()=>ownerFlags,
  gte:()=>ownerFlags,lte:()=>ownerFlags,order:()=>ownerFlags,
  range:async()=>({data:[],error:null})};
 // Preserve the legacy coverage RPC and model the new pageable attention RPC.
 const attention=flags.map(flag=>({business_date:(flag as {business_date:string}).business_date,
  restaurant_guid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}));
 const rpc=vi.fn((name:string)=>name==="toast_attention_days"?
  {range:async(start:number,end:number)=>({data:attention.slice(start,end+1),error:null})}:
  Promise.resolve({data:name==="toast_check_evidence"?null:rpcDates.map(business_date=>({business_date})),error:null}));
 return supervisorHistoricalReaders({
  from:(table:string)=>table==="orders"?orders:table==="toast_day_status"?flagsRead:
   table==="toast_day_owner_flags"?ownerFlags:rollup,rpc
 } as unknown as SupabaseClient,"my-cafe");
}
describe("Toast source-scoped Supervisor coverage without changing aggregate formulas",()=>{
 it("preserves independently verified Square/CSV revenue on a Toast pilot-only day",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const day="2026-10-12",trend=await pilotReader([row("actual",4820,12,day)],
   [day],[]).salesTrend("my-cafe",{from:day,to:day});
  expect(trend.available).toBe(true);
  if(trend.available)expect(trend.value).toMatchObject([{date:day,netSalesCents:4820,ordersCount:12}]);
 });
 it("keeps Square revenue when the Toast import failed without imported Toast orders",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const day="2026-10-12",trend=await pilotReader([row("actual",4800,12,day)],
   [day],[],false,[{business_date:day,import_state:"failed",recon_state:"mismatch"}])
   .salesTrend("my-cafe",{from:day,to:day});
  expect(trend.available).toBe(true);
  if(trend.available)expect(trend.value).toMatchObject([{date:day,netSalesCents:4800}]);
  expect(trend.quality.missingInputs).toContain("toastFailedNoCanonicalSales:"+day);
 });
 it("preserves failed-import day totals with a caveat",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const day="2026-10-12",trend=await pilotReader([row("actual",5800,13,day)],
   [day],[day],false,[{business_date:day,import_state:"failed",recon_state:"mismatch"}]).salesTrend("my-cafe",{from:day,to:day});
  expect(trend.available).toBe(true);
  if(trend.available)expect(trend.value).toMatchObject([{date:day,netSalesCents:5800,ordersCount:13}]);
  expect(trend.quality.missingInputs).toContain("toastImportIncompleteDays:1:"+day+":0");
 });
 it("preserves other independently verified Square/CSV days in a partly mixed period",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const trend=await pilotReader([
   row("actual",4800,12,"2026-10-11"),
   row("actual",5800,13,"2026-10-12")
  ],["2026-10-12"],["2026-10-12"],false,[{business_date:"2026-10-12",import_state:"failed",recon_state:"mismatch"}])
   .salesTrend("my-cafe",{from:"2026-10-11",to:"2026-10-12"});
  expect(trend.available).toBe(true);
  if(trend.available){
   expect(trend.value).toMatchObject([{date:"2026-10-11",netSalesCents:4800},
     {date:"2026-10-12",netSalesCents:5800}]);
   expect(trend.quality.missingInputs).toContain("toastImportIncompleteDays:1:2026-10-12:0");
  }
 });
 it("Money screen and chat read matching cents from the same failed-import fixture",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const date="2026-10-12",fixture=[row("actual",5800,13,date)];
  const screen=buildDayWindows(fixture.map(item=>rowToDailyFacts({...item,
   sales_data_status:"actual" as const,staff_tax_status:"actual" as const,
   card_fees_status:"missing" as const})),date,"2026-10");
  const chat=await pilotReader(fixture,[date],[date],false,
   [{business_date:date,import_state:"failed",recon_state:"mismatch"}])
   .salesTrend("my-cafe",{from:date,to:date});
  expect(chat.available).toBe(true);
  if(!chat.available)return;
  expect(chat.value.map(day=>({date:day.date,netSalesCents:day.netSalesCents,ordersCount:day.ordersCount})))
   .toEqual(screen.monthActualDays.map(day=>({
    date:day.date,netSalesCents:day.netSalesCents,ordersCount:day.ordersCount
   })));
  expect(chat.quality.missingInputs).toContain("toastImportIncompleteDays:1:"+date+":0");
 });
 it("status read fails keeps stored days + one note",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const day="2026-10-12",trend=await pilotReader([row("actual",2500,2,day)],
   [day],[],true).salesTrend("my-cafe",{from:day,to:day});
  expect(trend.available).toBe(true);
  if(trend.available)expect(trend.value[0].netSalesCents).toBe(2500);
  expect(trend.quality.missingInputs).toEqual(["toastDayStatusUnavailable"]);
 });
 it("unstatused historical Toast orders stay visible but are labeled unchecked",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const day="2026-10-12",trend=await pilotReader([row("actual",5500,6,day)],
   [day],[day]).salesTrend("my-cafe",{from:day,to:day});
  expect(trend.available).toBe(true);
  if(trend.available)expect(trend.value).toMatchObject([{date:day,netSalesCents:5500}]);
  expect(trend.quality.missingInputs).toEqual(["toastDayStatusMissing:"+day]);
 });
 it("includes imported Toast sales despite legacy gate and marks mismatches",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const day="2026-10-12",trend=await pilotReader(
    [row("actual",8500,9,day)],[day],[day],false,
    [{business_date:day,import_state:"imported",recon_state:"mismatch"}]
  ).salesTrend("my-cafe",{from:day,to:day});
  expect(trend.available).toBe(true);
  if(trend.available)expect(trend.value[0].netSalesCents).toBe(8500);
  expect(trend.quality.missingInputs).not.toContain("toastDaysNeedLook:1:"+day+":0");
  expect(trend.quality.notes).toContain("toastDaysNeedLook:1:"+day+":0");
 });
 it("never turns a staff-only or Toast-modified-empty day into verified zero",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const day="2026-10-12",trend=await pilotReader([row("missing",0,0,day)],
   [day],[]).salesTrend("my-cafe",{from:day,to:day});
  expect(trend.available).toBe(false);
 });
});
