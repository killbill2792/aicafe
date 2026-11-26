import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({from:vi.fn()}));
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
  auth:{getUser:async()=>({data:{user:{id:"owner"}}})},from:state.from,
})}));
vi.mock("@/lib/pos/processingFeeEstimate.server",()=>({
  getOwnerConfirmedProcessingFeePlans:async()=>[],ownerConfirmedPlanForDate:()=>null,
}));
import {getProcessingFeeEstimateSetup} from "./getProcessingFeeEstimateSetup";

describe("Processing fees canonical screen inputs",()=>{
  const cafe="cafe-a";
  const dates=["2026-11-01","2026-11-02","2026-11-03","2026-11-04"];
  const fixtures:Record<string,unknown[]> = {
    memberships:[{business_id:cafe,businesses:{is_demo:false,timezone:"UTC",currency:"EUR"}}],
    cv_sales_days:dates.map((business_date,i)=>({business_date,net_sales_cents:i===3?0:10000})),
    cv_card_fees:[
      {business_date:dates[0],amount_cents:300,status:"actual",source_type:"connected_pos_actual",provider:"Toast"},
      {business_date:dates[1],amount_cents:250,status:"estimated",source_type:"owner_confirmed_estimate",provider:"Toast"},
    ],
    pos_connections:[{provider:"Toast",status:"active"}],
    cv_orders:[{business_date:dates[1],pos_order_id:"toast:order",net_sales_cents:10000,processing_fee_provider:"Toast"}],
  };
  const filters:Array<[string,string,unknown]>=[];
  const columns:Record<string,string>={};
  let failure:string|null=null;
  beforeEach(()=>{
    vi.clearAllMocks();filters.length=0;failure=null;
    state.from.mockImplementation((table:string)=>{
      if(!(table in fixtures))throw Error("Unexpected noncanonical input: "+table);
      const result=table===failure?{data:null,error:new Error("offline")}:{data:fixtures[table],error:null};
      const q={
        select:(value:string)=>{columns[table]=value;return q;},
        eq:(key:string,value:unknown)=>{filters.push([table,key,value]);return q;},
        gte:()=>q,lte:()=>q,order:()=>q,is:()=>q,
        then:(resolve:(value:typeof result)=>unknown)=>Promise.resolve(result).then(resolve),
      };
      return q;
    });
  });
  it("uses the scoped canonical daily sales and selected fee facts, including missing days",async()=>{
    const result=await getProcessingFeeEstimateSetup();
    expect(result.coverage).toEqual({salesDays:3,actualDays:1,estimatedDays:1,missingDays:1});
    expect(result.coverageDays).toEqual([
      {date:dates[2],status:"missing"},{date:dates[1],status:"estimated"},{date:dates[0],status:"actual"},
    ]);
    expect(result.sourceSummary).toMatchObject({actualFeeCents:300,actualProviders:["Toast"],
      processorCount:1,currency:"EUR",trustedOrderDays:1,untrustedFeeDates:[dates[2]]});
    expect(columns.cv_card_fees).toContain("source_type:data->>sourceType");
    expect(columns.cv_card_fees).toContain("provider:data->>provider");
    for(const table of ["cv_sales_days","cv_card_fees","cv_orders","pos_connections"])
      expect(filters).toContainEqual([table,"business_id",cafe]);
    expect(state.from).not.toHaveBeenCalledWith("daily_rollups");
    expect(state.from).not.toHaveBeenCalledWith("processing_fee_daily_facts");
  });
  it("does not turn an unavailable view into zero fees",async()=>{
    failure="cv_card_fees";
    await expect(getProcessingFeeEstimateSetup()).rejects.toThrow("offline");
  });
});
