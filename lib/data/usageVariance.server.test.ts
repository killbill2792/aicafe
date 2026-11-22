import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {readUsageOrderLines} from "./usageVariance.server";

describe("owner-scoped October usage reader",()=>{
 it("paginates orders first and reads only exact authorized parent IDs, without a global child join",async()=>{
  const orders=Array.from({length:221},(_,n)=>({id:"owner-order-"+n,businessDate:"2026-10-15"}));
  const calls:Array<{ids:string[];from:number;to:number}>=[];
  const rows=await readUsageOrderLines(orders,async(ids,from,to)=>{
   calls.push({ids,from,to});
   return {data:ids.map(order_id=>({order_id,id:"line-"+order_id})).slice(from,to+1),error:null};
  });
  expect(rows).toHaveLength(221);
  expect(rows.every(r=>r.orders.id===r.order_id)).toBe(true);
  expect(calls.map(c=>c.ids.length).sort((a,b)=>a-b)).toEqual([21,100,100]);
  expect(calls.every(c=>c.from===0&&c.to===499)).toBe(true);
  expect(new Set(calls.flatMap(c=>c.ids))).toEqual(new Set(orders.map(o=>o.id)));
 });
 it("fetches the second child page after exactly 500 rows without dropping the 501st",async()=>{
  const pages:Array<[number,number]>=[];
  const records=Array.from({length:501},(_,i)=>({id:"line-"+i,order_id:"owner-order"}));
  const rows=await readUsageOrderLines([{id:"owner-order"}],async(ids,from,to)=>{
   expect(ids).toEqual(["owner-order"]);
   pages.push([from,to]);
   return {data:records.slice(from,to+1),error:null};
  });
  expect(rows).toHaveLength(501);
  expect(pages).toEqual([[0,499],[500,999]]);
 });
 it("rejects any child row whose parent was not returned by the owner-scoped source",async()=>{
  await expect(readUsageOrderLines([{id:"allowed"}],async()=>({
   data:[{id:"line-from-another-cafe",order_id:"foreign"}],error:null
  }))).rejects.toThrow("usage_source_scope_mismatch");
 });
 it("fails closed on a bound rather than treating truncated source data as complete",async()=>{
  await expect(readUsageOrderLines([{id:"owner"}],async()=>({
   data:[{order_id:"owner"},{order_id:"owner"}],error:null
  }),2)).rejects.toThrow("usage_rows_exceed_safe_limit");
 });
 it("keeps Postgres statement timeouts distinguishable from missing purchase evidence",async()=>{
  await expect(readUsageOrderLines([{id:"owner"}],async()=>({
   data:null,error:{code:"57014",message:"statement timeout"}
  }))).rejects.toThrow("usage_source_timeout");
 });
});
