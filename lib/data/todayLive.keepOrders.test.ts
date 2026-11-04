import {describe,expect,it,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const live=vi.hoisted(()=>({read:vi.fn(),archive:vi.fn()}));
vi.mock("@/lib/pos/toast/todaySoFar.server",()=>({readToastTodaySoFar:live.read}));
vi.mock("@/lib/pos/toast/liveArchive.server",()=>({archiveLiveToastOrders:live.archive}));
import {todaySoFarForBusiness} from "./todayLive.server";

function fakeDb(){
 const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:null,error:null}),upsert:async()=>({error:null})};
 const m={select:()=>m,eq:()=>m,not:()=>m,limit:()=>m,
  maybeSingle:async()=>({data:{toast_time_zone:"America/Los_Angeles",closeout_hour:4},error:null})};
 return {from:(t:string)=>t==="toast_location_mappings"?m:q} as never;
}
const now=new Date("2026-11-03T21:30:00Z");
const pages=[[{guid:"cccccccc-cccc-4ccc-8ccc-000000000001"}]];
beforeEach(()=>{
 live.read.mockReset();live.archive.mockReset();
 live.read.mockImplementation(async(_db:unknown,_b:string,_now:Date,_req:unknown,
  keep?:(r:string,d:string,p:unknown[][])=>Promise<void>)=>{
  await keep?.("rest-1","2026-11-03",pages);
  return {available:false,missing:["todayLiveReadFailed"]};
 });
});

describe("only the 15-minute job keeps today's orders",()=>{
 it("the job files the pages it downloaded",async()=>{
  const db=fakeDb();
  await todaySoFarForBusiness(db,"cafe",{now,keepOrders:true});
  expect(live.archive).toHaveBeenCalledWith(db,"cafe","rest-1","2026-11-03",pages);
 });
 it("Home and the chat read without saving orders",async()=>{
  await todaySoFarForBusiness(fakeDb(),"cafe",{now});
  expect(live.read.mock.calls[0][4]).toBeUndefined();
  expect(live.archive).not.toHaveBeenCalled();
 });
});
