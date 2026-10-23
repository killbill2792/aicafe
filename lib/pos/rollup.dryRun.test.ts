import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const fee=vi.hoisted(()=>({ensure:vi.fn()}));
vi.mock("./processingFeeEstimate.server",()=>({ensureOwnerConfirmedProcessingFeeEstimateForDay:fee.ensure}));
import {recomputeDailyRollup} from "./rollup";
import type {SupabaseClient} from "@supabase/supabase-js";

describe("Raj Cafe daily rollup dry-run safety",()=>{
 it("calculates through the production rollup engine without any database writes",async()=>{
  const accessed:string[]=[];
  const from=(table:string)=>{
   accessed.push(table);
   const chain={
    select:()=>chain,eq:()=>chain,gte:()=>chain,lte:()=>chain,order:()=>chain,
    single:async()=>({data:{timezone:"America/Los_Angeles",payroll_tax_rate:0.12,payroll_tax_rate_source:"system_estimate"},error:null}),
    maybeSingle:async()=>({data:null,error:null}),
    then:(cb:(v:{data:unknown[];error:null})=>unknown)=>Promise.resolve({data:[],error:null}).then(cb),
    upsert:()=>{throw Error("dry-run attempted a write")},
    insert:()=>{throw Error("dry-run attempted a write")},
    update:()=>{throw Error("dry-run attempted a write")},
    delete:()=>{throw Error("dry-run attempted a write")},
   };
   return chain;
  };
  fee.ensure.mockClear();
  const actual=await recomputeDailyRollup({from} as unknown as SupabaseClient,"b","2026-08-22",{dryRun:true});
  expect(actual).toMatchObject({business_id:"b",business_date:"2026-08-22",orders_count:0,net_sales_cents:0});
  expect(accessed).toContain("daily_rollups");
  expect(fee.ensure).not.toHaveBeenCalled();
 });
});
