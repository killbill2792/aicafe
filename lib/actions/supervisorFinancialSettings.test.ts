import {beforeEach,describe,expect,it,vi} from "vitest";

const state=vi.hoisted(()=>({
 role:"owner",demo:false,userId:"owner-one",
 writes:[] as Array<Record<string,unknown>>
}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({
 getActiveBusinessId:async()=> "cafe-one"
}));
vi.mock("@/lib/supabase/server",()=>({
 createServerSupabaseClient:async()=>({
  auth:{getUser:async()=>({data:{user:state.userId?{id:state.userId}:null}})},
  from:(table:string)=>{
   if(table==="memberships")return {
    select:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({
     data:{role:state.role},error:null
    })})})})
   };
   if(table==="businesses")return {
    select:()=>({eq:()=>({single:async()=>({
      data:{is_demo:state.demo},error:null
    })})}),
    update:(values:Record<string,unknown>)=>({
      eq:async(_column:string,_id:string)=>{
       state.writes.push(values);
       return {error:null};
      }
    })
   };
   throw new Error("Unexpected table "+table);
  }
 })
}));
import {saveSupervisorFinancialSettings} from "./supervisorFinancialSettings";

beforeEach(()=>{state.role="owner";state.demo=false;state.userId="owner-one";state.writes=[];});
describe("canonical owner payroll extras settings",()=>{
 it("saves extras to the migration-101 field without writing replacement payroll columns",async()=>{
  const result=await saveSupervisorFinancialSettings({
   ingredientPercent:32.5,ownerMonthlyPayrollExtrasCents:25000
  });
  expect(result).toEqual({ok:true});
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
   target_ingredient_cost_rate:0.325,
   owner_monthly_payroll_extras_cents:25000
  });
  expect(state.writes[0]).not.toHaveProperty("owner_monthly_payroll_cents");
  expect(state.writes[0]).not.toHaveProperty("owner_monthly_payroll_status");
 });
 it("preserves NULL for genuinely unknown extras instead of inventing $0",async()=>{
  await saveSupervisorFinancialSettings({
   ingredientPercent:null,ownerMonthlyPayrollExtrasCents:null
  });
  expect(state.writes[0]).toMatchObject({
   owner_monthly_payroll_extras_cents:null,
   target_ingredient_cost_rate:null
  });
 });
 it("rejects staff, demo owners and invalid extras without any write",async()=>{
  state.role="staff";
  expect((await saveSupervisorFinancialSettings({
   ingredientPercent:25,ownerMonthlyPayrollExtrasCents:5000
  })).ok).toBe(false);
  state.role="owner";state.demo=true;
  expect((await saveSupervisorFinancialSettings({
   ingredientPercent:25,ownerMonthlyPayrollExtrasCents:5000
  })).ok).toBe(false);
  state.demo=false;
  expect((await saveSupervisorFinancialSettings({
   ingredientPercent:25,ownerMonthlyPayrollExtrasCents:-1
  })).ok).toBe(false);
  expect(state.writes).toEqual([]);
 });
});
