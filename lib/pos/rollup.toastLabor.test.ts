import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
vi.mock("./processingFeeEstimate.server",()=>({
 ensureOwnerConfirmedProcessingFeeEstimateForDay:vi.fn()
}));
import {recomputeDailyRollup} from "./rollup";

const day="2026-08-22";
const toastOrder={id:"one",pos_order_id:"toast:restaurant:order",
 net_sales_cents:10000,processing_fee_provider:"toast",toast_excluded:false,superseded_by:null};
const planned={id:"planned",source_type:"owner_schedule",wage_source:"owner",
 clock_in:"2026-08-22T18:00:00Z",clock_out:"2026-08-22T19:00:00Z",
 hourly_wage_cents:2000,breaks:[]};
const actual={...planned,id:"actual",source_type:"connected_pos",
 wage_source:"pos",hourly_wage_cents:1800,pos_timecard_id:"toast:restaurant:shift"};
type TimecardFixture=Omit<typeof planned,"hourly_wage_cents">&{
 hourly_wage_cents:number|null;pos_timecard_id?:string;
 provider_regular_hours?:number|null;provider_overtime_hours?:number|null;
};
function previewDb(timecards:Array<TimecardFixture>,orders=[toastOrder],staged:Array<Record<string,unknown>>=[]){
 const from=(table:string)=>{
  const q={
   select:()=>q,eq:()=>q,lt:()=>q,or:()=>q,order:()=>q,in:()=>q,
   lte:()=>q,gte:()=>q,
   range:async(start:number,end:number)=>({
    data:(table==="orders"?orders:table==="timecards"?timecards:table==="toast_labor_entries"?staged:[]).slice(start,end+1),
    error:null
   }),
   single:async()=>({data:{timezone:"America/Los_Angeles",
    payroll_tax_rate:0.12,payroll_tax_rate_source:"system_estimate"},error:null}),
   maybeSingle:async()=>({data:null,error:null}),
   upsert:()=>{throw Error("dry-run wrote to database");}
  };
  return q;
 };
 return {from} as unknown as SupabaseClient;
}
describe("Toast sales with no paid shifts",()=>{
 it("does not certify planned hours as actual or known wages",async()=>{
  const result=await recomputeDailyRollup(previewDb([planned]),"business",day,{dryRun:true});
  expect(result).toMatchObject({labor_wage_status:"missing",
   staff_wages_cents:null,staff_tax_cents:null,net_sales_cents:10000});
 });
 it("treats a sale with zero shifts as missing, not zero-dollar actual payroll",async()=>{
  const result=await recomputeDailyRollup(previewDb([]),"business",day,{dryRun:true});
  expect(result).toMatchObject({labor_wage_status:"missing",
   staff_wages_cents:null,staff_tax_cents:null});
 });
 it("counts verified paid shifts but never an overlapping owner plan",async()=>{
  const result=await recomputeDailyRollup(previewDb([planned,actual]),"business",day,{dryRun:true});
  expect(result).toMatchObject({labor_wage_status:"actual",
   staff_wages_cents:1800,staff_tax_cents:216});
 });
});

const providerShift=(n:number,wage:number|null)=>({
 ...actual,id:"s"+n,pos_timecard_id:"toast:restaurant:"+n,
 hourly_wage_cents:wage,clock_in:"2026-08-22T18:00:00Z",
 clock_out:"2026-08-22T19:00:00Z",
 provider_regular_hours:1,provider_overtime_hours:0,
});
const stagedShift=(n:number,wage:number|null)=>({
 restaurant_guid:"restaurant",external_time_entry_id:String(n),
 clock_in:"2026-08-22T18:00:00Z",clock_out:"2026-08-22T19:00:00Z",
 hourly_wage_cents:wage,provider_regular_hours:1,provider_overtime_hours:0,
 deleted:false
});
describe("daily rollup guards incomplete Toast attendance",()=>{
 it("does not call six of seven staged shifts complete, even if six wages are known",async()=>{
  const source=Array.from({length:7},(_,i)=>stagedShift(i,i===0?null:1800));
  const timecards=source.slice(0,6).map((_,i)=>providerShift(i,i===0?0:1800));
  const result=await recomputeDailyRollup(previewDb(timecards,[toastOrder],source),"business",day,{dryRun:true});
  expect(result).toMatchObject({labor_wage_status:"missing",
   staff_wages_cents:null,staff_tax_cents:null});
 });
 it("certifies all seven imported shifts with genuine Toast-omitted $0 wage",async()=>{
  const source=Array.from({length:7},(_,i)=>stagedShift(i,i===0?null:1800));
  const timecards=source.map((_,i)=>providerShift(i,i===0?0:1800));
  const result=await recomputeDailyRollup(previewDb(timecards,[toastOrder],source),"business",day,{dryRun:true});
  expect(result).toMatchObject({labor_wage_status:"actual",
   staff_wages_cents:10800,staff_tax_cents:1296});
 });
 it("never computes full payroll tax from a known-only subtotal with an unknown wage",async()=>{
  const cards=[providerShift(0,null),providerShift(1,1800)];
  const result=await recomputeDailyRollup(previewDb(cards),"business",day,{dryRun:true});
  expect(result).toMatchObject({labor_wage_status:"missing",
   staff_wages_cents:null,staff_tax_cents:null});
 });
});
