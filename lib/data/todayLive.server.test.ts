import {describe,expect,it,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const live=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("@/lib/pos/toast/todaySoFar.server",()=>({readToastTodaySoFar:live.read}));
import {todaySoFarForBusiness,readSavedTodayLive} from "./todayLive.server";
import type {TodaySoFar} from "@/lib/pos/toast/todaySoFar";

const value=(readAt:string,over:Partial<TodaySoFar>={}):TodaySoFar=>({provisional:true,businessDate:"2026-10-29",readAt,
 netSalesCents:84_250,grossSalesCents:90_000,discountsCents:500,refundsCents:0,tipCents:1200,orders:61,openChecks:3,
 unparsedOrders:0,topItems:[{name:"Latte",quantity:20,netSalesCents:11_000}],locationsRead:1,locationsFailed:0,truncated:false,...over});
function fakeDb(saved:{reading:TodaySoFar;read_at:string}|null,error:{code:string}|null=null){
 const upsert=vi.fn(async()=>({error:null}));
 const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:saved,error}),upsert};
 // Los Angeles café, Toast day ends at 4am.
 const m={select:()=>m,eq:()=>m,not:()=>m,limit:()=>m,
  maybeSingle:async()=>({data:{toast_time_zone:"America/Los_Angeles",closeout_hour:4},error:null})};
 return {db:{from:(t:string)=>t==="toast_location_mappings"?m:q} as never,upsert};
}
const now=new Date("2026-10-29T17:20:00Z");
beforeEach(()=>live.read.mockReset());
describe("today so far: one saved reading for Home and chat",()=>{
 it("never reuses a reading saved before the café's closeout as the new day",async()=>{
  // Saved at 3:55am LA (business day Oct 28); now 4:05am LA (business day Oct 29).
  const {db}=fakeDb({reading:value("2026-10-29T10:55:00Z",{businessDate:"2026-10-28"}),read_at:"2026-10-29T10:55:00Z"});
  live.read.mockResolvedValue({available:true,value:value("2026-10-29T11:05:00Z",{netSalesCents:0,orders:0})});
  const r=await todaySoFarForBusiness(db,"cafe",{now:new Date("2026-10-29T11:05:00Z")});
  expect(live.read).toHaveBeenCalled();
  expect(r).toMatchObject({available:true,value:{netSalesCents:0}});
 });
 it("uses a reading saved in the last 15 minutes without calling Toast",async()=>{
  const {db}=fakeDb({reading:value("2026-10-29T17:10:00Z"),read_at:"2026-10-29T17:10:00Z"});
  const r=await todaySoFarForBusiness(db,"cafe",{now});
  expect(r).toMatchObject({available:true,value:{netSalesCents:84_250}});
  expect(live.read).not.toHaveBeenCalled();
 });
 it("reads Toast again when the reading is old, and saves the new one",async()=>{
  const {db,upsert}=fakeDb({reading:value("2026-10-29T16:50:00Z"),read_at:"2026-10-29T16:50:00Z"});
  live.read.mockResolvedValue({available:true,value:value("2026-10-29T17:20:00Z",{netSalesCents:90_000})});
  const r=await todaySoFarForBusiness(db,"cafe",{now});
  expect(r).toMatchObject({available:true,value:{netSalesCents:90_000}});
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({business_id:"cafe",net_sales_cents:90_000,orders:61}),{onConflict:"business_id"});
 });
 it("never saves a partial reading over the saved one",async()=>{
  const {db,upsert}=fakeDb(null);
  live.read.mockResolvedValue({available:true,value:value("2026-10-29T17:20:00Z",{locationsFailed:1})});
  await todaySoFarForBusiness(db,"cafe",{now});
  expect(upsert).not.toHaveBeenCalled();
 });
 it("works before the table is installed",async()=>{
  const {db}=fakeDb(null,{code:"42P01"});
  expect(await readSavedTodayLive(db,"cafe",now)).toBeNull();
 });
});
