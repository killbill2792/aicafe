import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
vi.mock("./rawSample.server",()=>({captureToastRawSample:vi.fn()}));
import {runDailyToastCapture} from "./dailyCapture.server";

const a="aaaaaaaa-0000-4000-8000-000000000001";
const now=new Date("2026-10-29T16:00:00Z");

function fakeDb(opts:{mappings?:unknown[];coverage?:unknown[];mappingError?:boolean}={}){
 const chain=(result:{data:unknown;error:unknown})=>{
  const q={select:()=>q,not:()=>q,order:()=>q,gte:()=>q,limit:async()=>result};
  return q;
 };
 return {from:(table:string)=>table==="toast_location_mappings"
  ?chain({data:opts.mappings??[],error:opts.mappingError?{message:"down"}:null})
  :chain({data:opts.coverage??[],error:null})} as unknown as SupabaseClient;
}
const la={business_id:a,toast_time_zone:"America/Los_Angeles",closeout_hour:4};

describe("daily Toast capture run",()=>{
 it("captures each missing recent day and counts outcomes without IDs",async()=>{
  const capture=vi.fn()
   .mockResolvedValueOnce({captured:40,skipped:false,failed:0})
   .mockResolvedValueOnce({captured:12,skipped:false,failed:0,reason:"partial"})
   .mockResolvedValueOnce({captured:0,skipped:true,failed:0,reason:"cooldown"});
  const summary=await runDailyToastCapture(fakeDb({mappings:[la]}),now,50*60*1000,capture);
  expect(capture.mock.calls.map(c=>c[1])).toEqual(["2026-10-26","2026-10-27","2026-10-28"]);
  expect(summary).toEqual({planned:3,completed:1,partial:1,skipped:1,failed:0,deferred:0,
   reasons:["cooldown","partial"]});
  expect(JSON.stringify(summary)).not.toContain(a);
 });

 it("skips days whose latest capture is complete",async()=>{
  const capture=vi.fn().mockResolvedValue({captured:1,skipped:false,failed:0});
  const coverage=["2026-10-26","2026-10-27","2026-10-28"].map(business_date=>
   ({business_id:a,business_date,reason:"available"}));
  const summary=await runDailyToastCapture(fakeDb({mappings:[la],coverage}),now,50*60*1000,capture);
  expect(capture).not.toHaveBeenCalled();
  expect(summary.planned).toBe(0);
 });

 it("defers work that does not fit the time budget instead of starting it",async()=>{
  const capture=vi.fn();
  const summary=await runDailyToastCapture(fakeDb({mappings:[la]}),now,60_000,capture);
  expect(capture).not.toHaveBeenCalled();
  expect(summary).toMatchObject({planned:3,deferred:3});
 });

 it("reports a database failure as a failed run",async()=>{
  const summary=await runDailyToastCapture(fakeDb({mappingError:true}),now,50*60*1000,vi.fn());
  expect(summary).toMatchObject({failed:1,reasons:["db_error"]});
 });

 it("counts a thrown capture as a failure and continues with the next day",async()=>{
  const capture=vi.fn().mockRejectedValueOnce(new Error("secret token in message"))
   .mockResolvedValue({captured:5,skipped:false,failed:0});
  const summary=await runDailyToastCapture(fakeDb({mappings:[la]}),now,50*60*1000,capture);
  expect(summary).toMatchObject({failed:1,completed:2,reasons:["capture_threw"]});
  expect(JSON.stringify(summary)).not.toContain("secret");
 });
});
