import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {supervisorHistoricalReaders} from "./supervisorReads.server";
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
