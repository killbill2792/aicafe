import {describe,expect,it,vi} from "vitest";
import {mayRetryDay,missingDayCandidates,queueToastMissingDays,retryWaitMs} from "./missingDays";

const H=3600_000;
const imported=(business_date:string,extra:Record<string,unknown>={})=>({business_date,
 import_state:"imported",order_count:100,coverage_complete:true,unparsed_count:0,...extra});

function fakeDb(days:Array<Record<string,unknown>>,withPayments:Set<string>,
 runs:Array<Record<string,unknown>>=[]){
 const rpc=vi.fn(async()=>({data:"run",error:null}));
 const counted:string[]=[];
 const from=(table:string)=>{
  const q={select:()=>q,gte:()=>q,lt:()=>q,order:()=>q,in:()=>q,
   eq:(k:string,v:unknown)=>{
    // The payments count query ends with the business_date filter.
    if(table==="toast_payment_facts"&&k==="business_date"){
     counted.push(String(v));
     return Promise.resolve({count:withPayments.has(String(v))?12:0,error:null});
    }
    return q;},
   limit:async()=>({data:table==="toast_sync_runs"?runs:days,error:null})};
  return q;
 };
 return {db:{from,rpc} as never,rpc,counted};
}
const m={business_id:"a0000000-0000-4000-8000-000000000001",restaurant_guid:"b0000000-0000-4000-8000-000000000001"};
const queuedDates=(rpc:ReturnType<typeof vi.fn>)=>rpc.mock.calls.map(c=>(c as unknown as [string,{p_date:string}])[1].p_date);

describe("retry waits",()=>{
 it("grows from one hour and stops at once a day",()=>{
  expect([0,1,2,3,4,5,6,9].map(retryWaitMs)).toEqual([0,H,2*H,4*H,8*H,16*H,24*H,24*H]);
 });
 it("never re-pulls a day that is already queued or running",()=>{
  expect(mayRetryDay("2026-10-20",[{requested_from:"2026-10-20",requested_to:"2026-10-20",
   state:"paused_rate_limited",started_at:null}],Date.now())).toBe(false);
 });
 it("waits longer after each try and forgets tries older than three days",()=>{
  const now=Date.parse("2026-10-30T12:00:00Z");
  const run=(hoursAgo:number)=>({requested_from:"2026-10-20",requested_to:"2026-10-20",
   state:"completed",started_at:new Date(now-hoursAgo*H).toISOString()});
  expect(mayRetryDay("2026-10-20",[run(0.5)],now)).toBe(false);
  expect(mayRetryDay("2026-10-20",[run(1.5)],now)).toBe(true);
  // Three tries: the next one waits four hours after the latest.
  expect(mayRetryDay("2026-10-20",[run(3),run(10),run(20)],now)).toBe(false);
  expect(mayRetryDay("2026-10-20",[run(5),run(10),run(20)],now)).toBe(true);
  expect(mayRetryDay("2026-10-20",[run(80),run(90)],now)).toBe(true);
 });
 it("counts a multi-day backfill as a try for every day it covers",()=>{
  const now=Date.parse("2026-10-30T12:00:00Z");
  expect(mayRetryDay("2026-10-15",[{requested_from:"2026-10-01",requested_to:"2026-10-28",
   state:"completed",started_at:new Date(now-10*60000).toISOString()}],now)).toBe(false);
 });
});

describe("which days are missing",()=>{
 it("finds gaps, failed and incomplete days from the first imported day, newest first",()=>{
  const days=[imported("2026-10-20"),{...imported("2026-10-22"),import_state:"failed"},
   imported("2026-10-24",{coverage_complete:false}),imported("2026-10-25",{unparsed_count:2}),
   imported("2026-10-26"),imported("2026-10-27"),imported("2026-10-28")];
  expect(missingDayCandidates(days,"2026-10-29",null)).toEqual([
   {date:"2026-10-25",reason:"incomplete"},{date:"2026-10-24",reason:"incomplete"},
   {date:"2026-10-23",reason:"not_imported"},{date:"2026-10-22",reason:"not_imported"},
   {date:"2026-10-21",reason:"not_imported"}]);
 });
 it("leaves an unimported yesterday to the daily import but repairs an incomplete one",()=>{
  expect(missingDayCandidates([imported("2026-10-27")],"2026-10-29",null)).toEqual([]);
  expect(missingDayCandidates([imported("2026-10-27"),imported("2026-10-28",{coverage_complete:false})],
   "2026-10-29",null)).toEqual([{date:"2026-10-28",reason:"incomplete"}]);
 });
});

describe("queueing only the missing days",()=>{
 it("re-pulls missing days and days without card fees, newest first, a few per run",async()=>{
  const days=Array.from({length:8},(_,i)=>imported("2026-10-2"+(8-i),{order_count:i===3?0:100}))
   .filter(d=>d.business_date!=="2026-10-24");
  const {db,rpc}=fakeDb(days,new Set(["2026-10-28","2026-10-26","2026-10-22"]));
  const queued=await queueToastMissingDays(db,m,"2026-10-29",Date.now()+60_000);
  // 28, 26 and 22 have payments, 25 has no orders, 24 was never imported.
  expect(queued).toEqual([{date:"2026-10-27",reason:"no_fees"},{date:"2026-10-24",reason:"not_imported"},
   {date:"2026-10-23",reason:"no_fees"},{date:"2026-10-21",reason:"no_fees"}]);
  expect(rpc).toHaveBeenCalledWith("toast_queue_owner_repull",
   {p_business_id:m.business_id,p_restaurant_guid:m.restaurant_guid,p_date:"2026-10-27"});
 });
 it("queues nothing when every day is complete",async()=>{
  const {db,rpc}=fakeDb([imported("2026-10-28")],new Set(["2026-10-28"]));
  expect(await queueToastMissingDays(db,m,"2026-10-29",Date.now()+60_000)).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
 });
 it("skips a day tried recently and does not even count its payments",async()=>{
  const now=Date.now();
  const {db,rpc,counted}=fakeDb([imported("2026-10-27"),imported("2026-10-28")],new Set(),
   [{requested_from:"2026-10-28",requested_to:"2026-10-28",state:"completed",
    started_at:new Date(now-20*60000).toISOString()}]);
  await queueToastMissingDays(db,m,"2026-10-29",now+60_000,now);
  expect(queuedDates(rpc)).toEqual(["2026-10-27"]);
  expect(counted).toEqual(["2026-10-27"]);
 });
 it("leaves a café with no imported history to its first backfill",async()=>{
  const {db,rpc}=fakeDb([],new Set());
  expect(await queueToastMissingDays(db,m,"2026-10-29",Date.now()+60_000)).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
 });
});
