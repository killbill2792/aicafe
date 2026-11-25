import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const provider=vi.hoisted(()=>vi.fn());
vi.mock("./client",async original=>({...await original<typeof import("./client")>(),createToastClient:()=>({request:provider})}));
import {orderRecoveryCadence,orderRecoveryWindow,toastShouldPollOrders,prepareIncrementalOrderPage,pollToastOrderRevisions} from "./orderRecovery";
describe("webhook-primary incremental fallback",()=>{
 it("uses the same ten-minute live recovery even with a configured webhook",()=>{
  expect(orderRecoveryCadence(true,false)).toBe(600000);
  expect(orderRecoveryCadence(true,true)).toBe(600000);
  expect(orderRecoveryCadence(false,false)).toBe(Infinity);
  expect(orderRecoveryCadence(false,true)).toBe(Infinity);
 });
 it("recovers a missed month without jumping to recent dates",()=>{
  const cursor="2026-10-01T08:00:00Z";
  const result=orderRecoveryWindow(cursor,new Date("2026-11-25T08:00:00Z"),new Date("2026-11-25T10:00:00Z"));
  expect(result?.since.toISOString()).toBe("2026-10-01T07:58:00.000Z");
  expect(result?.until.toISOString()).toBe("2026-10-01T09:00:00.000Z");
 });
 it("keeps overlap and delays the newest two minutes",()=>{
  const result=orderRecoveryWindow("2026-11-25T09:50:00Z",new Date("2026-11-25T08:00:00Z"),new Date("2026-11-25T10:00:00Z"));
  expect(result?.since.toISOString()).toBe("2026-11-25T09:48:00.000Z");
  expect(result?.until.toISOString()).toBe("2026-11-25T09:58:00.000Z");
  expect(orderRecoveryWindow("2026-11-25T09:58:00Z",new Date("2026-11-25T08:00:00Z"),new Date("2026-11-25T10:00:00Z"))).toBeNull();
 });
});

it("stops known closed hours after one closing catch-up; unknown hours stay live",()=>{
 const hours={mon:[["08:00","16:00"]] as [string,string][]};
 const now=new Date("2026-11-24T00:10:00Z");
 expect(toastShouldPollOrders(hours,"America/Los_Angeles",now,"2026-11-23T23:58:00Z")).toBe(true);
 expect(toastShouldPollOrders(hours,"America/Los_Angeles",now,"2026-11-24T00:08:00Z")).toBe(false);
 expect(toastShouldPollOrders(null,"America/Los_Angeles",now,null)).toBe(true);
});

it("isolates bad identity, date, timestamp and wrong-day rows from valid revisions",()=>{
 const scope={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",restaurantGuid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",timezone:"America/Los_Angeles",closeoutHour:4};
 const good={guid:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",businessDate:20261124,modifiedDate:"2026-11-25T10:00:00Z",checks:[]};
 const result=prepareIncrementalOrderPage(scope,[{...good,guid:null},good,{...good,businessDate:20260231},
  {...good,modifiedDate:"invalid"},{...good,businessDate:20261123}],"2026-11-24");
 expect(result.prepared).toHaveLength(1);
 expect(result.unparsed.map(x=>x.source_index)).toEqual([1,3,4,5]);
 expect(result.unparsed[0].order_guid).toBeNull();
 expect(result.unparsed.every(x=>x.raw_sha256.length===64)).toBe(true);
 expect(result.unparsed.every(x=>!("payload" in x))).toBe(true);
});

it("saves valid revisions from a malformed full page and its subsequent page without certifying the window",async()=>{
 const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",restaurantGuid="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const locationId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 const now=new Date("2026-11-25T20:10:00Z"),day="2026-11-25";
 const cursor="2026-11-25T19:58:00Z";
 const row=(n:number)=>({guid:"dddddddd-dddd-4ddd-8ddd-"+String(n).padStart(12,"0"),
  businessDate:20261125,modifiedDate:"2026-11-25T20:00:00Z",checks:[]});
 provider.mockReset().mockResolvedValueOnce([row(1),{...row(2),guid:null},...Array.from({length:98},(_,i)=>row(i+3))])
  .mockResolvedValueOnce([row(101)]);
 let progress:Record<string,unknown>|null=null;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==="toast_claim_poll")return {data:"lease",error:null};
  if(name==="toast_commit_canonical_order_page"){
   if(args.p_has_more){
    progress={window_since:args.p_since,window_until:args.p_until,next_page:2,bootstrap_day:null};
    return {data:{changed:99,complete:false,incomplete:false},error:null};
   }
   return {data:{changed:1,complete:false,incomplete:true},error:null};
  }
  if(name==="toast_finish_poll")return {data:true,error:null};
  throw Error("unexpected RPC "+name);
 });
 const db={rpc,from:(table:string)=>{
  const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({error:null,data:
   table==="toast_location_mappings"?{verified_at:now.toISOString(),toast_time_zone:"America/Los_Angeles",closeout_hour:4}:
   table==="locations"?{open_hours:null}:table==="toast_sync_health"?{canonical_order_poll_at:cursor,canonical_live_day:day}:progress})};
  return q;
 }} as unknown as Parameters<typeof pollToastOrderRevisions>[0];
 await expect(pollToastOrderRevisions(db,{businessId,restaurantGuid,locationId},now,Date.now()+60000)).rejects.toMatchObject({category:"invalid_response"});
 const pages=rpc.mock.calls.filter(([name])=>name==="toast_commit_canonical_order_page").map(([,args])=>args);
 expect(pages).toHaveLength(2);
 expect(pages[0]).toMatchObject({p_page:1,p_has_more:true,p_unparsed:[{source_index:2,order_guid:null}]});
 expect(pages[0].p_rows).toHaveLength(99);
 expect(pages[1]).toMatchObject({p_page:2,p_has_more:false,p_unparsed:[]});
 expect(pages[1].p_rows).toHaveLength(1);
 expect(rpc).toHaveBeenCalledWith("toast_finish_poll",expect.objectContaining({p_success:false,p_cursor_at:null,p_failure:"invalid_response"}));
});
