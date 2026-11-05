import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/toastDayTrust.server",()=>({
 readToastDayTrust:vi.fn(async()=>({blocked:new Set(),quality:[],notes:[]}))
}));
import {dataQueryTools} from "./dataQuery";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input={view:"cv_orders",columns:["source","guest_count","business_date"],
 filters:null,group_by:null,metrics:null,date_from:"2026-10-17",
 date_to:"2026-10-20",order_by:null,limit:25};
describe("one bounded canonical SQL view path for plain and aggregate queries",()=>{
 it("scopes plain rows to the same screen view, café and business dates",async()=>{
  const rpc=vi.fn(async()=>({data:{
   rows:[{source:"toast",guest_count:3,business_date:"2026-10-20"}],
   sourceCount:1,sourceMix:{toast:1},hasIncomplete:false,truncated:false
  },error:null}));
  const db={rpc} as never;
  const result=await dataQueryTools.query_data.execute(input,{db,businessId:business});
  expect(rpc).toHaveBeenCalledExactlyOnceWith("ai_query_view",expect.objectContaining({
   p_business_id:business,p_view:"cv_orders",
   p_date_from:"2026-10-17",p_date_to:"2026-10-20",
   p_columns:["source","guest_count","business_date"],p_limit:25
  }));
  expect(result).toMatchObject({source:"canonical_data",empty:false,sourceMix:{toast:1}});
  expect(result.rows).toEqual([{source:"toast",guest_count:3,business_date:"2026-10-20"}]);
 });
 it("does not hide recorded rows because their day is incomplete",async()=>{
  const rpc=vi.fn(async()=>({data:{
   rows:[{source:"toast",status:"open",guest_count:null}],
   sourceCount:1,sourceMix:{toast:1},hasIncomplete:true,
   currentDayIncomplete:true,truncated:false
  },error:null}));
  const result=await dataQueryTools.query_data.execute(input,{db:{rpc} as never,businessId:business});
  expect(result.empty).toBe(false);
  expect(result.missing).toEqual(expect.arrayContaining(["incompleteEvidence","currentDayIncomplete"]));
  expect(result.rows).toHaveLength(1);
 });
 it("an errored query is a failure, never invented zero records",async()=>{
  const rpc=vi.fn(async()=>({data:null,error:{message:"no database"}}));
  const result=await dataQueryTools.query_data.execute(input,{db:{rpc} as never,businessId:business});
  expect(result.error).toBe("source_read_failed");
  expect(result.missing).toContain("source_read_failed");
  expect(result.rows).toEqual([]);
 });
});
