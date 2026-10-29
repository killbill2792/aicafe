import {describe,expect,it,vi} from "vitest";
import {queueToastPaymentGaps} from "./paymentGaps";

function fakeDb(days:Array<{business_date:string;order_count:number}>,withPayments:Set<string>){
 const rpc=vi.fn(async()=>({data:"run",error:null}));
 const from=(table:string)=>{
  const filters:Record<string,unknown>={};
  const q={select:()=>q,gte:()=>q,lt:()=>q,order:()=>q,
   eq:(k:string,v:unknown)=>{filters[k]=v;
    // The payments count query ends with the business_date filter.
    if(table==="toast_payment_facts"&&k==="business_date")
     return Promise.resolve({count:withPayments.has(String(v))?12:0,error:null});
    return q;},
   limit:async()=>({data:days,error:null})};
  return q;
 };
 return {db:{from,rpc} as never,rpc};
}
const m={business_id:"a0000000-0000-4000-8000-000000000001",restaurant_guid:"b0000000-0000-4000-8000-000000000001"};
describe("Toast payment gap re-pulls",()=>{
 it("queues imported days with orders but no saved payments, newest first, a few per run",async()=>{
  const days=Array.from({length:8},(_,i)=>({business_date:"2026-10-2"+(8-i),order_count:i===3?0:100}));
  const {db,rpc}=fakeDb(days,new Set(["2026-10-28","2026-10-26"]));
  const queued=await queueToastPaymentGaps(db,m,"2026-10-29",Date.now()+60_000);
  // 28 and 26 have payments, 25 has no orders.
  expect(queued).toEqual(["2026-10-27","2026-10-24","2026-10-23","2026-10-22","2026-10-21"]);
  expect(rpc).toHaveBeenCalledWith("toast_queue_owner_repull",
   {p_business_id:m.business_id,p_restaurant_guid:m.restaurant_guid,p_date:"2026-10-27"});
 });
 it("queues nothing when every day has its payments",async()=>{
  const {db,rpc}=fakeDb([{business_date:"2026-10-28",order_count:90}],new Set(["2026-10-28"]));
  expect(await queueToastPaymentGaps(db,m,"2026-10-29",Date.now()+60_000)).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
 });
});
