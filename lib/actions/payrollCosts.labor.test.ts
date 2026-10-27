import {describe,expect,it,vi} from "vitest";

const state=vi.hoisted(()=>({
  rows:[] as Array<{business_date:string;staff_wages_cents:number|null;
    staff_tax_status:string;labor_wage_status:string}>,
  taxUpdates:[] as Array<Record<string,unknown>>,
}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>"real-cafe"}));
vi.mock("@/lib/supabase/server",()=>({
  createServerSupabaseClient:async()=>({
    auth:{getUser:async()=>({data:{user:{id:"owner"}}})},
    from:(table:string)=>{
      if(table==="memberships"){
        return {select:()=>({eq:()=>({eq:()=>({eq:()=>({
          maybeSingle:async()=>({data:{role:"owner",
            businesses:{is_demo:false,timezone:"UTC"}},error:null}),
        })})})})};
      }
      if(table==="businesses")return {update:()=>({
        eq:async()=>({error:null})})};
      if(table==="daily_rollups"){
        const read={eq:()=>({gte:()=>({
          lte:async()=>({data:state.rows,error:null})})})};
        return {
          select:()=>read,
          update:(payload:Record<string,unknown>)=>{
            state.taxUpdates.push(payload);
            return {eq:()=>({eq:()=>({eq:()=>({eq:()=>({eq:()=>({
              select:async()=>({data:[{business_date:"2026-10-23"}],error:null}),
            })})})})})};
          },
        };
      }
      throw new Error("Unexpected table "+table);
    },
  }),
}));
import {savePayrollCostAssumption} from "./payrollCosts";

describe("payroll tax assumptions and partial Toast wages",()=>{
  it("skips non-null known-only missing labor without blocking complete days",async()=>{
    state.taxUpdates.length=0;
    state.rows=[
      {business_date:"2026-10-22",staff_wages_cents:1250,
        staff_tax_status:"estimated",labor_wage_status:"missing"},
      {business_date:"2026-10-23",staff_wages_cents:1000,
        staff_tax_status:"estimated",labor_wage_status:"actual"},
    ];
    const result=await savePayrollCostAssumption({employerCostPercent:10});
    expect(result).toEqual({ok:true,refreshed:true});
    expect(state.taxUpdates).toHaveLength(1);
    expect(state.taxUpdates[0].staff_tax_cents).toBe(100);
  });
});
