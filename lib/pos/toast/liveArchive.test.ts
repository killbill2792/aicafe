import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {isFinishedToastOrder,liveArchivePage} from "./liveArchive";
import {archiveLiveToastOrders} from "./liveArchive.server";
import {redactToastRaw} from "./redact";
import {stableToastOrderPage} from "./stableOrder";
import {readToastTodaySoFar,clearTodaySoFarCache} from "./todaySoFar.server";

const g=(n:number)=>`cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12,"0")}`;
const business="aaaaaaaa-0000-4000-8000-000000000001";
const r1="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function order(n:number,status="CLOSED",extra:Record<string,unknown>={}){
 return {guid:g(n),businessDate:20261103,modifiedDate:"2026-11-03T21:00:00.000+0000",
  customer:{guid:g(900+n),firstName:"Ana",email:"ana@example.com"},
  checks:[{guid:g(100+n),paymentStatus:status,
   // Toast returns GUID lists in a different order on each download.
   selections:[{guid:g(300+n),displayName:"Mocha"},{guid:g(200+n),displayName:"Latte",
    appliedDiscounts:[{guid:g(400+n),name:"Dental Students & Faculty",discountAmount:0.85}]}]}],
  ...extra};
}

describe("which of today's orders are kept during the day",()=>{
 it("keeps closed, voided and deleted orders and leaves open or unpaid ones for later",()=>{
  expect(isFinishedToastOrder(order(1,"CLOSED"))).toBe(true);
  expect(isFinishedToastOrder(order(2,"OPEN"))).toBe(false);
  // Paid but not closed: a tip can still be added.
  expect(isFinishedToastOrder(order(3,"PAID"))).toBe(false);
  expect(isFinishedToastOrder(order(4,"OPEN",{voided:true}))).toBe(true);
  expect(isFinishedToastOrder(order(5,"OPEN",{deleted:true}))).toBe(true);
  expect(isFinishedToastOrder({...order(6),checks:[order(6).checks[0],{guid:g(7),paymentStatus:"OPEN"}]})).toBe(false);
  expect(isFinishedToastOrder({...order(8),checks:[order(8).checks[0],{guid:g(9),paymentStatus:"OPEN",voided:true}]})).toBe(true);
  expect(isFinishedToastOrder({guid:g(10),checks:[]})).toBe(false);
  expect(isFinishedToastOrder(null)).toBe(false);
 });

 it("prepares a page exactly as the 5 AM import does, so an unchanged order is recognised then",()=>{
  const page=[order(1),order(2,"OPEN"),order(3)];
  const kept=liveArchivePage(page);
  const asImport=stableToastOrderPage(redactToastRaw(page,0,"",undefined,"orders") as unknown[]);
  expect(kept).toEqual([asImport[0],asImport[2]]);
  // Personal details are gone; the discount name (business data) stays.
  expect(JSON.stringify(kept)).not.toContain("ana@example.com");
  expect(JSON.stringify(kept)).not.toContain("Ana");
  expect(JSON.stringify(kept)).toContain("Dental Students & Faculty");
  // The same order downloaded with its lists in another order is byte-identical.
  const shuffled={...order(1),checks:[{...order(1).checks[0],selections:[...order(1).checks[0].selections].reverse()}]};
  expect(JSON.stringify(liveArchivePage([shuffled]))).toBe(JSON.stringify(liveArchivePage([order(1)])));
 });
});

describe("archiveLiveToastOrders",()=>{
 function admin(results:Array<{data:unknown;error:unknown}>){
  const rpc=vi.fn(async()=>results.shift()??{data:0,error:null});
  return {db:{rpc} as unknown as SupabaseClient,rpc};
 }

 it("sends each page's finished orders once and skips pages with none",async()=>{
  const {db,rpc}=admin([{data:2,error:null},{data:1,error:null}]);
  const saved=await archiveLiveToastOrders(db,business,r1,"2026-11-03",
   [[order(1),order(2)],[order(3,"OPEN")],[order(4)]]);
  expect(saved).toBe(3);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenNthCalledWith(1,"toast_archive_live_orders",{p_business_id:business,
   p_restaurant_guid:r1,p_business_date:"2026-11-03",p_payload:liveArchivePage([order(1),order(2)])});
 });

 it("stops on a database error without throwing, logging the code only",async()=>{
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  const {db,rpc}=admin([{data:null,error:{code:"57014",message:"secret details"}}]);
  expect(await archiveLiveToastOrders(db,business,r1,"2026-11-03",[[order(1)],[order(2)]])).toBe(0);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("toast_live_archive_failed",{code:"57014"});
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret details");
  warn.mockRestore();
 });
});

describe("the live reading hands its own download to the order keeper",()=>{
 const zone="America/Los_Angeles";
 const now=new Date("2026-11-03T21:30:00Z");
 function db(){
  const q={select:()=>q,eq:()=>q,not:async()=>({data:[{restaurant_guid:r1,toast_time_zone:zone,closeout_hour:4}],error:null})};
  return {from:()=>q} as unknown as SupabaseClient;
 }

 it("passes the downloaded pages once, and not again from the cache",async()=>{
  clearTodaySoFarCache();
  const rows=[order(1)];
  const request=vi.fn(async()=>rows);
  const keep=vi.fn(async()=>{});
  await readToastTodaySoFar(db(),business,now,request,keep);
  expect(request).toHaveBeenCalledTimes(1);
  expect(keep).toHaveBeenCalledWith(r1,"2026-11-03",[rows]);
  await readToastTodaySoFar(db(),business,new Date(now.getTime()+60_000),request,keep);
  expect(keep).toHaveBeenCalledTimes(1);
 });

 it("gives the same reading when keeping the orders fails",async()=>{
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  clearTodaySoFarCache();
  const request=vi.fn(async()=>[order(1),order(2,"OPEN")]);
  const plain=await readToastTodaySoFar(db(),business,now,request);
  clearTodaySoFarCache();
  const failing=await readToastTodaySoFar(db(),business,now,request,async()=>{throw new Error("db down");});
  expect(failing).toEqual(plain);
  expect(warn).toHaveBeenCalledWith("toast_live_pages_unsaved");
  warn.mockRestore();
 });
});
