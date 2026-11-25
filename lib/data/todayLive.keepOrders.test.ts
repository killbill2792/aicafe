import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const provider=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/pos/toast/todaySoFar.server",()=>({readToastTodaySoFar:provider}));
import {todaySoFarForBusiness} from "./todayLive.server";
const now=new Date("2026-11-03T21:30:00Z");
const reading={provisional:true,businessDate:"2026-11-03",readAt:now.toISOString(),netSalesCents:100,
 grossSalesCents:100,discountsCents:0,refundsCents:0,tipCents:0,orders:1,openChecks:1,unparsedOrders:0,
 topItems:[],locationsRead:1,locationsFailed:0,truncated:false};
function db(saved:boolean){
 const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:saved?{reading,read_at:reading.readAt}:null,error:null})};
 const m={select:()=>m,eq:()=>m,not:()=>m,limit:()=>m,maybeSingle:async()=>({data:{toast_time_zone:"America/Los_Angeles",closeout_hour:4},error:null})};
 return {from:(t:string)=>t==="toast_location_mappings"?m:q} as never;
}
describe("retired full-day collection",()=>{
 it("legacy keepOrders callers and normal readers use the same shared snapshot",async()=>{
  expect(await todaySoFarForBusiness(db(true),"cafe",{now,keepOrders:true})).toMatchObject({available:true,value:{openChecks:1}});
  expect(await todaySoFarForBusiness(db(true),"cafe",{now})).toMatchObject({available:true,value:{openChecks:1}});
  expect(provider).not.toHaveBeenCalled();
 });
 it("never downloads the full day when no shared snapshot is ready",async()=>{
  expect(await todaySoFarForBusiness(db(false),"cafe",{now,keepOrders:true})).toMatchObject({available:false});
  expect(provider).not.toHaveBeenCalled();
 });
});
