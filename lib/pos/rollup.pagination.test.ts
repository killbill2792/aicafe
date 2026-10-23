import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("./processingFeeEstimate.server",()=>({ensureOwnerConfirmedProcessingFeeEstimateForDay:vi.fn()}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {recomputeDailyRollup} from "./rollup";

describe("large canonical daily rollup preview",()=>{
 it("recomputes all 1,205 orders and order lines without truncating the day",async()=>{
  const ids=Array.from({length:1205},(_,i)=>"order-"+String(i).padStart(4,"0"));
  const orders=ids.map((id,i)=>({id,net_sales_cents:100,pos_order_id:"square:"+i,processing_fee_provider:"square"}));
  const lines=ids.map((order_id,i)=>({id:"line-"+String(i).padStart(4,"0"),order_id,
    menu_item_id:null,quantity:1,net_sales_cents:100,voided:false}));
  const orderRanges:number[][]=[];
  const db={from:(table:string)=>{
   const filters:Record<string,unknown>={};
   const chain={
    select:()=>chain,eq:()=>chain,gte:()=>chain,lte:()=>chain,order:()=>chain,
    in:(key:string,values:string[])=>{filters[key]=values;return chain;},
    range:async(first:number,last:number)=>{
     if(table==="orders")orderRanges.push([first,last]);
     let rows:unknown[]=table==="orders"?orders:table==="order_lines"?lines:[];
     if(table==="order_lines"){
      const allowed=new Set(filters.order_id as string[]);
      rows=lines.filter(line=>allowed.has(line.order_id));
     }
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
 });
});
