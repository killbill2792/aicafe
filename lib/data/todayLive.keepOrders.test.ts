import {describe,expect,it,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const live=vi.hoisted(()=>({read:vi.fn(),archive:vi.fn()}));
vi.mock("@/lib/pos/toast/todaySoFar.server",()=>({readToastTodaySoFar:live.read}));
vi.mock("@/lib/pos/toast/liveArchive.server",()=>({archiveLiveToastOrders:live.archive}));
import {todaySoFarForBusiness} from "./todayLive.server";

const reading=(readAt:string)=>({provisional:true,businessDate:"2026-11-03",readAt,netSalesCents:100,grossSalesCents:100,
 discountsCents:0,refundsCents:0,tipCents:0,orders:1,openChecks:0,unparsedOrders:0,topItems:[],locationsRead:1,locationsFailed:0,truncated:false});
function fakeDb(saved?:{readAt:string}){
 const q={select:()=>q,eq:()=>q,upsert:async()=>({error:null}),
  maybeSingle:async()=>({data:saved?{reading:reading(saved.readAt),read_at:saved.readAt}:null,error:null})};
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
 it("the job downloads and files orders even when Home or the chat saved a reading a minute ago",async()=>{
  const db=fakeDb({readAt:new Date(now.getTime()-60_000).toISOString()});
  await todaySoFarForBusiness(db,"cafe",{now,keepOrders:true});
  expect(live.read).toHaveBeenCalledTimes(1);
  expect(live.archive).toHaveBeenCalledWith(db,"cafe","rest-1","2026-11-03",pages);
 });
 it("Home and the chat reuse that recent reading and save no orders",async()=>{
  const read=await todaySoFarForBusiness(fakeDb({readAt:new Date(now.getTime()-60_000).toISOString()}),"cafe",{now});
  expect(read).toMatchObject({available:true,value:{businessDate:"2026-11-03"}});
  expect(live.read).not.toHaveBeenCalled();
 });
 it("Home and the chat read without saving orders",async()=>{
  await todaySoFarForBusiness(fakeDb(),"cafe",{now});
  expect(live.read.mock.calls[0][4]).toBeUndefined();
  expect(live.archive).not.toHaveBeenCalled();
 });
});
