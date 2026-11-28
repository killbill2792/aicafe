import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("./processingFeeEstimate.server",()=>({ensureOwnerConfirmedProcessingFeeEstimateForDay:vi.fn()}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {recomputeDailyRollup} from "./rollup";

describe("large canonical daily rollup preview",()=>{
 it("recomputes all 1,205 orders and order lines without truncating the day",async()=>{
  const ids=Array.from({length:1205},(_,i)=>"order-"+String(i).padStart(4,"0"));
  const orders=ids.map((order_ref,i)=>({order_ref,net_sales_cents:100,pos_order_id:"square:"+i,processing_fee_provider:"square"}));
  const lines=ids.map(()=>({menu_item_id:null,quantity:1}));
  const orderRanges:number[][]=[],lineRanges:number[][]=[];
  const db={from:(table:string)=>{
   const chain={
    select:()=>chain,eq:()=>chain,gte:()=>chain,lte:()=>chain,lt:()=>chain,or:()=>chain,order:()=>chain,
    in:()=>chain,
    range:async(first:number,last:number)=>{
     if(table==="cv_orders")orderRanges.push([first,last]);
     if(table==="cv_item_sales")lineRanges.push([first,last]);
     const rows=table==="cv_orders"?orders:table==="cv_item_sales"?lines:[];
     return {data:rows.slice(first,last+1),error:null};
    },
    single:async()=>({data:table==="businesses"?{timezone:"America/Los_Angeles",
      payroll_tax_rate:0.12,payroll_tax_rate_source:"system_estimate"}:null,error:null}),
    maybeSingle:async()=>({data:null,error:null}),
    upsert:()=>{throw new Error("dry-run attempted to write");}
   };
   return chain;
  }} as unknown as SupabaseClient;
  const preview=await recomputeDailyRollup(db,"business","2026-08-22",{dryRun:true});
  expect(preview).toMatchObject({net_sales_cents:120500,orders_count:1205,drinks_count:1205});
  expect(orderRanges).toEqual([[0,499],[500,999],[1000,1499]]);
  expect(lineRanges).toEqual(orderRanges);
 });
});
