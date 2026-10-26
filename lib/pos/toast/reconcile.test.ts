import {beforeEach,describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
const mocked=vi.hoisted(()=>({mode:"internal",request:vi.fn(),requestDay:vi.fn(),getDay:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./client",async()=>{
 const {z}=await import("zod");
 class ToastApiError extends Error{constructor(public category:string){super(category);}}
 return {GUID:z.uuid(),ToastApiError,createToastClient:()=>({request:mocked.request})};
});
vi.mock("./checkMode",()=>({detectToastCheckMode:async()=>mocked.mode,setToastCheckMode:vi.fn(async(_db:unknown,_b:string,mode:string)=>{mocked.mode=mode;})}));
vi.mock("./analyticsClient",()=>({createToastAnalyticsClient:()=>({
 requestDay:mocked.requestDay,getDay:mocked.getDay})}));
vi.mock("./adapter",()=>({toastMoneyCents:(v:number)=>Math.round(v*100)}));
vi.mock("./dayParser",()=>({parseToastDayPage:()=>({orders:[],unparsed:[]})}));
import {reconcileToastDays,internalOrderProof} from "./reconcile";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const location="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const payment="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const report="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const day="2026-10-16";
const p={businessId:business,restaurantGuid:restaurant,locationId:location,
 timeZone:"America/Los_Angeles",closeoutHour:4};
const checksum=createHash("sha256").update("[]").digest("hex");
const status=()=>({business_date:day,import_state:"imported",recon_state:"pending",
 orders_snapshot_sha256:checksum,net_sales_cents:10000,order_count:1,
 discounts_cents:0,refunds_cents:0,unparsed_count:0,warnings:{},
 imported_at:"2026-10-17T10:00:00Z",last_recon_attempt_at:null as string|null,
 recon_source:null as string|null,analytics_state:null as string|null,
 internal_state:null as string|null,internal_reasons:[] as string[],paid_other_day:0,
 reconciled_at:null as string|null,payment_repull_at:null as string|null,
 last_error_category:null as string|null});
function fakeDb(analytics:boolean){
 mocked.mode=analytics?"official":"internal";
 const item={...status(),rechecking_reason:null as string|null},writes:Record<string,unknown>[]=[];
 let batch:Array<Record<string,unknown>>|null=null;
 const selection={or:[] as string[],is:[] as string[]};
 const calls:string[]=[];let certifiedVoids=false;
 const cacheRows:Record<string,unknown>[]=[];let job:Record<string,unknown>|null=null;
 let matchedOrder:Record<string,unknown>|null=null,otherDay:Record<string,unknown>|null=null;
 const db={
  from(table:string){
   const filters:Record<string,unknown>={};
   let patch:Record<string,unknown>|null=null,queryOr="",queryLimit=Infinity;
   const q={
    select(_s:string){return q;},eq(k:string,v:unknown){filters[k]=v;return q;},
    in(_k:string,_v:unknown[]){return q;},
    or(expr:string){if(table==="toast_day_status"&&!patch){selection.or.push(expr);queryOr=expr;}return q;},
    is(k:string){if(table==="toast_day_status"&&!patch)selection.is.push(k);return q;},
    order(_k:string,_opts?:unknown){return q;},limit(n:number){queryLimit=n;return q;},range(_s:number,_e:number){return q;},delete(){return q;},
    update(value:Record<string,unknown>){patch=value;return q;},
    upsert(value:Record<string,unknown>){
     if(table==="toast_internal_check_cache")cacheRows.push(value);
     return {error:null};
    },
    async maybeSingle(){
     if(table==="toast_day_status"&&patch){
      // PostgREST UPDATE ... WHERE imported_at=... RETURNING must reject
      // stale reconciliation work after a newer canonical import.
      const target=batch?.find(row=>row.business_date===filters.business_date)??item;
      if(filters.imported_at!==target.imported_at)return {data:null,error:null};
      writes.push(patch);Object.assign(target,patch);
      return {data:{business_date:target.business_date},error:null};
     }
     if(table==="toast_analytics_credentials")
      return {data:analytics?{business_id:business,verified_at:"2026-10-17"}:null,error:null};
     if(table==="toast_analytics_jobs")return {data:job,error:null};
     if(table==="orders")return {data:matchedOrder,error:null};
     if(table==="toast_day_status"&&filters.business_date)
      return {data:otherDay,error:null};
     return {data:null,error:null};
    },
    then(yes:(v:unknown)=>unknown,no?:((e:unknown)=>unknown)){
     if(table==="toast_day_status"&&patch){writes.push(patch);Object.assign(item,patch);}
     const days=batch??(item.rechecking_reason?[]:[item]);
     const eligible=days.filter(d=>{
      if(d.rechecking_reason)return false;
      const state=d.recon_state as string;
      if(!["pending","mismatch","analytics_timeout"].includes(state)&&
       !(queryOr.includes("recon_state.eq.checked_internal")&&state==="checked_internal"&&
         d.analytics_state==="pending"))return false;
      const stamp=d.last_recon_attempt_at as string|null;
      return !stamp||Date.now()-Date.parse(stamp)>(state==="pending"?9:60)*60000;
     }).sort((a,b)=>(a.last_recon_attempt_at?1:0)-(b.last_recon_attempt_at?1:0)||
       String(b.business_date).localeCompare(String(a.business_date))).slice(0,queryLimit);
     const data=table==="toast_day_status"&&!patch?eligible:
      table==="toast_internal_check_cache"?cacheRows:[];
     return Promise.resolve({data,error:null}).then(yes,no);
    }
   };return q;
  },
  async rpc(name:string){calls.push(name);
   if(name==="toast_certify_day_voids"){
    certifiedVoids=["matched","checked_internal"].includes(item.recon_state);
    return {data:certifiedVoids,error:null};
   }
   return {data:true,error:null};
  }
 };
 return {db:db as unknown as SupabaseClient,
  item:item as ReturnType<typeof status>&{internal_state?:string;rechecking_reason:string|null},
  selection,writes,calls,cacheRows,get certifiedVoids(){return certifiedVoids;},
  setJob(value:Record<string,unknown>){job=value;},
  setOrder(value:Record<string,unknown>|null){matchedOrder=value;},
  setOtherDay(value:Record<string,unknown>|null){otherDay=value;},
   setBatch(value:Array<Record<string,unknown>>){batch=value;}};
}
const orderWithAutoGratAndGiftCard=()=>[{
 guid:"11111111-1111-4111-8111-111111111111",
 checks:[{paymentStatus:"CLOSED",amount:50,taxAmount:4,
  appliedServiceCharges:[{gratuity:true,chargeAmount:8}],
  appliedDiscounts:[],
  selections:[{price:20,deferred:false},{price:30,deferred:true}],
  payments:[{guid:payment,amount:62,tipAmount:3,paymentStatus:"CAPTURED"}]}]
}];
beforeEach(()=>{mocked.request.mockReset();mocked.requestDay.mockReset();
 mocked.getDay.mockReset();mocked.requestDay.mockResolvedValue(report);
 mocked.request.mockImplementation(async(path:string)=>
  path.includes("paidBusinessDate")?[payment]:orderWithAutoGratAndGiftCard());
});
describe("Toast independent check proof (25, auto-gratuity, deferred gifts)",()=>{
 it("accepts an auto-gratuity payment and deferred gift-card check without double counting",()=>{
  const proof=internalOrderProof(orderWithAutoGratAndGiftCard(),p,day,checksum,0);
  expect(proof.reasons).toEqual([]);
  expect(proof.paidGuids.has(payment)).toBe(true);
 });
 it("rejects the check when auto gratuity is counted twice",()=>{
  const orders=orderWithAutoGratAndGiftCard();
  orders[0].checks[0].payments[0].amount=70;
  expect(internalOrderProof(orders,p,day,checksum,0).reasons)
   .toContain("check_payment_mismatch");
 });
 it("flags a missing check payment GUID rather than treating the check as verified",()=>{
  const orders=orderWithAutoGratAndGiftCard() as unknown as Array<Record<string,unknown>>;
  const rawCheck=(orders[0].checks as Array<Record<string,unknown>>)[0];
  (rawCheck.payments as Array<Record<string,unknown>>)[0].guid=null;
  expect(internalOrderProof(orders,p,day,checksum,0).reasons)
   .toContain("missing_payment_guid");
 });
});
describe("Toast reconciliation paths: ERA 202, matched, mismatch and internal",()=>{
 it("marks ERA +4 cents matched, preserving integer-cent delta",async()=>{
  const f=fakeDb(true);mocked.getDay.mockResolvedValue({pending:false,rows:[{
   restaurantGuid:restaurant,businessDate:"20261016",netSalesAmount:100.04,
   ordersCount:1,discountAmount:0,refundAmount:0,voidOrdersCount:0
  }]});
  expect(await reconcileToastDays(f.db,p,Date.now()+20000)).toBe(1);
  expect(f.item).toMatchObject({recon_state:"matched",delta_net_cents:4});
  expect(f.calls).toContain("toast_certify_day_voids");
 });
 it("keeps a $12.30 ERA mismatch visible with signed delta",async()=>{
  const f=fakeDb(true);mocked.getDay.mockResolvedValue({pending:false,rows:[{
   restaurantGuid:restaurant,businessDate:"20261016",netSalesAmount:112.30,
   ordersCount:1,discountAmount:0,refundAmount:0,voidOrdersCount:0
  }]});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"mismatch",delta_net_cents:1230});
  expect(f.item.internal_state).toBe("matched");
  expect(f.calls.filter(name=>name==="toast_certify_day_voids")).toHaveLength(2);
  expect(f.certifiedVoids).toBe(false);
 });
 it("keeps the successful internal check visible while ERA is pending",async()=>{
  const f=fakeDb(true);mocked.getDay.mockResolvedValue({pending:true});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"checked_internal",analytics_state:"pending",internal_state:"matched"});
  expect(f.calls).toContain("toast_certify_day_voids");
 });
 it("uses paid GUIDs and consistent check math for non-ERA internal certification",async()=>{
  const f=fakeDb(false);
  expect(await reconcileToastDays(f.db,p,Date.now()+20000)).toBe(1);
  expect(f.item).toMatchObject({recon_state:"checked_internal",recon_source:"internal"});
  expect(f.calls).toContain("toast_certify_day_voids");
 });
 it("missing API-paid GUID flags mismatch without hiding the imported sales",async()=>{
  const f=fakeDb(false);
  mocked.request.mockImplementation(async(path:string)=>
   path.includes("paidBusinessDate")?[]:path.includes("/payments/")?{guid:payment,orderGuid:"11111111-1111-4111-8111-111111111111",paidBusinessDate:20260901}:orderWithAutoGratAndGiftCard());
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"mismatch",import_state:"imported"});
  expect(f.item.recon_state).toBe("mismatch");
 });
});

describe("PR H per-day fallbacks and cross-day payments",()=>{
 it("a revoked ERA permission still completes internal checking in the same tick",async()=>{
  const f=fakeDb(true);const {ToastApiError}=await import("./client");
  mocked.requestDay.mockRejectedValue(new ToastApiError("missing_permissions"));
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("checked_internal");expect(mocked.mode).toBe("internal");
  expect(f.item.last_recon_attempt_at).toBeTruthy();
 });
 it("accepts a tab payment on tomorrow's business day as information",async()=>{
  const f=fakeDb(false),rows=orderWithAutoGratAndGiftCard();
  mocked.request.mockImplementation(async(path:string)=>path.includes("paidBusinessDate")?[]:
   path.includes("/payments/")?{guid:payment,orderGuid:rows[0].guid,paidBusinessDate:20261017}:rows);
  // paidBusinessDate on the source and the independent payment detail agree.
  Object.assign(rows[0].checks[0].payments[0],{paidBusinessDate:20261017});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"checked_internal",paid_other_day:1});
 });
 it("2,500 payments are checked without a schema size exception",async()=>{
  const f=fakeDb(false),rows=orderWithAutoGratAndGiftCard();
  const guids=Array.from({length:2500},(_,i)=>"11111111-1111-4111-8111-"+String(i).padStart(12,"0"));
  const each=rows[0].checks[0].payments[0];
  rows[0].checks[0].payments=guids.map(guid=>({...each,guid,amount:0}));
  rows[0].checks[0].payments[0].amount=62;
  mocked.request.mockImplementation(async(path:string)=>path.includes("paidBusinessDate")?guids:rows);
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("checked_internal");
  expect(mocked.request).toHaveBeenCalledTimes(2);
 });
 it("over 20,000 payments has a typed failure and does not hide imported revenue",async()=>{
  const f=fakeDb(false);
  mocked.request.mockImplementation(async(path:string)=>path.includes("paidBusinessDate")?Array(20001).fill(payment):orderWithAutoGratAndGiftCard());
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({import_state:"imported",last_error_category:"too_many_payments"});
 });
});

it("a 48-hour ERA timeout keeps internal evidence and stamps the attempt",async()=>{
 const f=fakeDb(true);f.setJob({report_request_guid:report,requested_at:new Date(Date.now()-49*3600000).toISOString(),state:"pending"});
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.item).toMatchObject({recon_state:"checked_internal",analytics_state:"missing",internal_state:"matched"});
 expect(f.item.last_recon_attempt_at).toBeTruthy();expect(mocked.getDay).not.toHaveBeenCalled();
});
it("an interrupted multi-page internal proof resumes the saved page on its next attempt",async()=>{
 const f=fakeDb(false);const {ToastApiError}=await import("./client");
 let interrupted=true,page1Reads=0;
 mocked.request.mockImplementation(async(path:string)=>{
  if(path.includes("paidBusinessDate"))return [payment];
  if(path.endsWith("page=1")){page1Reads++;return Array.from({length:100},()=>orderWithAutoGratAndGiftCard()[0]);}
  if(interrupted)throw new ToastApiError("timeout");
  return [];
 });
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.cacheRows.some(row=>row.cache_key==="orders:1")).toBe(true);
 interrupted=false;f.item.last_recon_attempt_at=null;
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.item.recon_state).toBe("checked_internal");expect(page1Reads).toBe(1);
});

it("uses one AND-composed OR query and excludes closeout recovery imports",async()=>{
 const f=fakeDb(false);
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.selection.or).toHaveLength(1);
 expect(f.selection.or[0]).toContain("recon_state.in.(pending,mismatch,analytics_timeout)");
 expect(f.selection.or[0]).toContain("last_recon_attempt_at.is.null");
 expect(f.selection.is).toContain("rechecking_reason");
 const recovering=fakeDb(false);recovering.item.rechecking_reason="closeout_changed";
 expect(await reconcileToastDays(recovering.db,p,Date.now()+20000)).toBe(0);
 expect(mocked.request).toHaveBeenCalledTimes(2);
});
it("rejects corrupt order checks instead of crashing or certifying",async()=>{
 const f=fakeDb(false),rows=[{guid:"11111111-1111-4111-8111-111111111111",checks:{payments:"malformed"}}];
 mocked.request.mockImplementation(async(path:string)=>path.includes("paidBusinessDate")?[]:rows);
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.item).toMatchObject({recon_state:"mismatch",last_error_category:null});
 expect(f.certifiedVoids).toBe(false);
});
it("rejects non-array check payments without void certification",async()=>{
 const f=fakeDb(false),rows=[{guid:"11111111-1111-4111-8111-111111111111",checks:[{payments:"broken"}]}];
 mocked.request.mockImplementation(async(path:string)=>path.includes("paidBusinessDate")?[]:rows);
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.item.recon_state).toBe("mismatch");
 expect(f.certifiedVoids).toBe(false);
});

describe("unmatched payment GUID must not certify omitted or stale orders",()=>{
 const extra="ffffffff-ffff-4fff-8fff-ffffffffffff";
 const orderId="11111111-1111-4111-8111-111111111111";
 function prepare(excluded:boolean,orderDay:string,importState:"imported"|"missing"="imported",
  remoteOrderDay=orderDay,unparsedCount=0){
  const f=fakeDb(false);
  f.setOrder({id:"canonical-order",toast_excluded:excluded,business_date:orderDay});
  f.setOtherDay({import_state:importState,rechecking_reason:null,
   unparsed_count:unparsedCount,coverage_complete:unparsedCount===0});
  mocked.request.mockImplementation(async(path:string)=>{
   if(path.includes("paidBusinessDate"))return [payment,extra];
   if(path.includes("/payments/"+extra))return {
    guid:extra,orderGuid:orderId,paidBusinessDate:20261016};
   if(path.includes("/orders/"+orderId))return {
    guid:orderId,businessDate:Number(remoteOrderDay.replaceAll("-",""))};
   return orderWithAutoGratAndGiftCard();
  });
  return f;
 }
 it.each([
  ["a same-day order",false,day],
  ["a soft-excluded same-day order",true,day],
  ["an excluded cross-day order",true,"2026-10-15"]
 ] as const)("rejects extra payment attributed to %s",async(_name,excluded,date)=>{
  const f=prepare(excluded,date);
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("mismatch");
  expect(f.item.internal_state).toBe("mismatch");
  expect(f.certifiedVoids).toBe(false);
  expect(f.writes.some(w=>(w.internal_reasons as string[]|undefined)?.includes("unknown_payment_order")))
   .toBe(true);
 });
 it("accepts an active imported cross-day order without requeueing",async()=>{
  const f=prepare(false,"2026-10-15");
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("checked_internal");
  expect(f.calls).not.toContain("toast_queue_backfill");
 });
 it("queues recovery rather than certifying an unimported cross-day order",async()=>{
  const f=prepare(false,"2026-10-15","missing");
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("pending");
  expect(f.calls).toContain("toast_queue_backfill");
  expect(f.certifiedVoids).toBe(false);
 });
 it("never certifies a retained cross-day order after a partial, unparsed import",async()=>{
  const f=prepare(false,"2026-10-15","imported","2026-10-15",1);
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("pending");
  expect(f.calls).toContain("toast_queue_backfill");
  expect(f.certifiedVoids).toBe(false);
 });
 it("rejects a stale canonical cross-day date when live Toast now says same-day",async()=>{
  const f=prepare(false,"2026-10-15","imported",day,1);
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("mismatch");
  expect(f.certifiedVoids).toBe(false);
 });
 it("queues both sides of a newly moved order date",async()=>{
  const f=prepare(false,"2026-10-14","imported","2026-10-15");
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("pending");
  expect(f.calls.filter(name=>name==="toast_queue_backfill").length).toBeGreaterThanOrEqual(2);
 });
});


describe("Analytics evidence durability and retriable official work",()=>{
 it("keeps a confirmed external mismatch visible when ERA is rate limited on retry",async()=>{
  const f=fakeDb(true);
  Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:"matched",analytics_state:"available",delta_net_cents:1230});
  const {ToastApiError}=await import("./client");
  mocked.requestDay.mockRejectedValue(new ToastApiError("rate_limited"));
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"mismatch",recon_source:"toast_analytics",
   analytics_state:"pending",delta_net_cents:1230});
  expect(f.certifiedVoids).toBe(false);
  expect(mocked.request).not.toHaveBeenCalled();
 });
 it("keeps a confirmed external mismatch on a 48-hour timeout, not internal fallback",async()=>{
  const f=fakeDb(true);
  Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:"matched",analytics_state:"available"});
  f.setJob({report_request_guid:report,requested_at:new Date(Date.now()-49*3600000).toISOString(),state:"pending"});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"mismatch",analytics_state:"missing"});
  expect(mocked.mode).toBe("internal");
  expect(f.certifiedVoids).toBe(false);
 });
 it.each(["rate_limited","invalid_response","unavailable"] as const)(
  "leaves first failed external check retryable after %s",async(category)=>{
  const f=fakeDb(true);
  const {ToastApiError}=await import("./client");
  mocked.requestDay.mockRejectedValue(new ToastApiError(category));
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"checked_internal",internal_state:"matched",
   analytics_state:"pending",last_error_category:category});
  f.item.last_recon_attempt_at=null;
  mocked.requestDay.mockResolvedValue(report);
  mocked.getDay.mockResolvedValue({pending:true});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(mocked.requestDay).toHaveBeenCalledTimes(2);
  expect(f.item.analytics_state).toBe("pending");
 });
 it("only a fresh matching ERA comparison clears a prior mismatch warning",async()=>{
  const f=fakeDb(true);
  Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:"matched",analytics_state:"pending",
   warnings:{reconciliation_mismatch:1,analytics_timeout:1}});
  mocked.getDay.mockResolvedValue({pending:false,rows:[{
   restaurantGuid:restaurant,businessDate:"20261016",netSalesAmount:100,
   ordersCount:1,discountAmount:0,refundAmount:0,voidOrdersCount:0
  }]});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"matched",analytics_state:"available",
   last_error_category:null});
  expect(f.item.warnings).not.toHaveProperty("reconciliation_mismatch");
  expect(f.item.warnings).not.toHaveProperty("analytics_timeout");
 });
});

it("reprobes a previously missing report after separate Analytics credentials recover",async()=>{
 const f=fakeDb(true);
 Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
  internal_state:"matched",analytics_state:"pending"});
 f.setJob({report_request_guid:report,requested_at:new Date(Date.now()-49*3600000).toISOString(),state:"missing"});
 mocked.requestDay.mockResolvedValue(report);
 mocked.getDay.mockResolvedValue({pending:true});
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(mocked.requestDay).toHaveBeenCalledTimes(1);
 expect(f.item).toMatchObject({recon_state:"mismatch",analytics_state:"pending"});
});

it("discards a verdict for an older imported generation without overwriting the new one",async()=>{
 const f=fakeDb(false);
 const later="2026-10-19T12:00:00Z";
 mocked.request.mockImplementation(async(path:string)=>{
  if(path.includes("paidBusinessDate")){
   f.item.imported_at=later;
   return [payment];
  }
  return orderWithAutoGratAndGiftCard();
 });
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.item.imported_at).toBe(later);
 expect(f.item.recon_state).toBe("pending");
 expect(f.item).not.toHaveProperty("last_error_category");
 expect(f.writes).toHaveLength(0);
 expect(f.calls).not.toContain("toast_certify_day_voids");
});

it("an accepted 202 without an Analytics report GUID stays pending without a provider error",async()=>{
 const f=fakeDb(true);
 mocked.requestDay.mockResolvedValue(null);
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.item).toMatchObject({recon_state:"checked_internal",
  internal_state:"matched",analytics_state:"pending",last_error_category:null});
 expect(mocked.getDay).not.toHaveBeenCalled();
});

describe("recovery timers and finished Analytics reports",()=>{
 it("refreshes an old completed ERA report rather than treating it as a global timeout",async()=>{
  const f=fakeDb(true);
  Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:"matched",analytics_state:"available"});
  f.setJob({report_request_guid:report,requested_at:new Date(Date.now()-72*3600000).toISOString(),
   state:"available"});
  const fresh="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  mocked.requestDay.mockResolvedValue(fresh);
  mocked.getDay.mockResolvedValue({pending:true});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(mocked.requestDay).toHaveBeenCalledTimes(1);
  expect(mocked.getDay).toHaveBeenCalledWith(fresh);
  expect(mocked.mode).toBe("official");
  expect(f.item).toMatchObject({recon_state:"mismatch",analytics_state:"pending",
   recon_source:"toast_analytics"});
  expect(f.certifiedVoids).toBe(false);
 });
 it("still falls back for a genuinely unfinished 49-hour ERA report",async()=>{
  const f=fakeDb(true);
  f.setJob({report_request_guid:report,
   requested_at:new Date(Date.now()-49*3600000).toISOString(),state:"pending"});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(mocked.mode).toBe("internal");
  expect(mocked.requestDay).not.toHaveBeenCalled();
  expect(mocked.getDay).not.toHaveBeenCalled();
  expect(f.item.analytics_state).toBe("missing");
 });
 it("clears payment recovery only when a genuine internal verdict is reached",async()=>{
  const f=fakeDb(false);
  Object.assign(f.item,{payment_repull_at:new Date(Date.now()-3600000).toISOString()});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"checked_internal",payment_repull_at:null});
  expect(f.writes).toContainEqual(expect.objectContaining({payment_repull_at:null}));
 });
});

it("escalates cross-day payment recovery at its original deadline even after reimports",async()=>{
 const f=fakeDb(false);
 const extra="ffffffff-ffff-4fff-8fff-ffffffffffff";
 const orderId="11111111-1111-4111-8111-111111111111";
 const started=new Date(Date.now()-7*3600000).toISOString();
 Object.assign(f.item,{payment_repull_at:started});
 f.setOrder({id:"canonical-order",toast_excluded:false,business_date:"2026-10-15"});
 f.setOtherDay({import_state:"imported",rechecking_reason:null,
  unparsed_count:1,coverage_complete:false});
 mocked.request.mockImplementation(async(path:string)=>{
  if(path.includes("paidBusinessDate"))return [payment,extra];
  if(path.includes("/payments/"+extra))return {
   guid:extra,orderGuid:orderId,paidBusinessDate:20261016};
  if(path.includes("/orders/"+orderId))return {
   guid:orderId,businessDate:20261015};
  return orderWithAutoGratAndGiftCard();
 });
 await reconcileToastDays(f.db,p,Date.now()+20000);
 expect(f.item).toMatchObject({recon_state:"mismatch",internal_state:"mismatch",
  payment_repull_at:null});
 expect(f.writes.some(w=>(w.internal_reasons as string[]|undefined)
  ?.includes("unknown_payment_order"))).toBe(true);
 expect(f.calls).not.toContain("toast_queue_backfill");
 expect(f.certifiedVoids).toBe(false);
});

describe("recovered Analytics pending reports",()=>{
 it("202 acceptance retires a 503 error without hiding an established mismatch",async()=>{
  const f=fakeDb(true);
  Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:"matched",analytics_state:"pending",last_error_category:"unavailable",
   warnings:{reconciliation_mismatch:1,analytics_timeout:1}});
  mocked.requestDay.mockResolvedValue(null);
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"mismatch",recon_source:"toast_analytics",
   analytics_state:"pending",last_error_category:null});
  expect(f.item.warnings).toHaveProperty("reconciliation_mismatch",1);
  expect(f.item.warnings).not.toHaveProperty("analytics_timeout");
  expect(f.certifiedVoids).toBe(false);
 });
 it("polling a pending report retires a 429 error but preserves prior ERA mismatch",async()=>{
  const f=fakeDb(true);
  Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:"matched",last_error_category:"rate_limited",
   warnings:{reconciliation_mismatch:1}});
  f.setJob({state:"pending",report_request_guid:report,
   requested_at:new Date(Date.now()-3600000).toISOString()});
  mocked.getDay.mockResolvedValue({pending:true});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(mocked.requestDay).not.toHaveBeenCalled();
  expect(f.item).toMatchObject({recon_state:"mismatch",recon_source:"toast_analytics",
   analytics_state:"pending",last_error_category:null});
  expect(f.item.warnings).toHaveProperty("reconciliation_mismatch",1);
 });
});

describe("owner check scheduling invariants",()=>{
 it("I2: a cached internal mismatch reruns proof instead of reusing mismatch",async()=>{
  const f=fakeDb(false);
  Object.assign(f.item,{recon_state:"mismatch",internal_state:"mismatch",
   last_recon_attempt_at:null,internal_reasons:["invalid_checks"]});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(mocked.request).toHaveBeenCalledWith(
   expect.stringContaining("/orders/v2/ordersBulk"),restaurant,expect.anything(),expect.anything());
  expect(f.item).toMatchObject({recon_state:"checked_internal",internal_state:"matched"});
  expect(f.item.last_recon_attempt_at).not.toBeNull();
 });
 it("I3: 61 cached official-pending days cannot starve a newer pending task",async()=>{
  const f=fakeDb(false);
  const old=Array.from({length:61},(_,i)=>({...status(),
   business_date:new Date(Date.UTC(2026,9,1+i)).toISOString().slice(0,10),
   recon_state:"checked_internal",internal_state:"matched",
   analytics_state:"pending",last_recon_attempt_at:null}));
  const newcomer={...status(),business_date:"2026-09-20",
   internal_state:null as string|null,analytics_state:null,recon_state:"pending",
   last_recon_attempt_at:null};
  f.setBatch([...old,newcomer]);
  await reconcileToastDays(f.db,p,Date.now()+20000);
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(newcomer.last_recon_attempt_at).not.toBeNull();
  expect(newcomer.recon_state).toBe("checked_internal");
  expect(f.selection.or.every(expr=>!expr.includes("recon_state.eq.checked_internal"))).toBe(true);
 });
 it("I3: a cached internal match keeps a prior official mismatch and advances its cursor",async()=>{
  const f=fakeDb(false);
  Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:"matched",last_recon_attempt_at:null});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("mismatch");
  expect(f.item.recon_source).toBe("toast_analytics");
  expect(f.item.last_recon_attempt_at).not.toBeNull();
 });
 it("I1: payment recovery never changes an established ERA mismatch into pending",async()=>{
  const f=fakeDb(false);
  Object.assign(f.item,{recon_state:"mismatch",recon_source:"toast_analytics",
   internal_state:null,payment_repull_at:null});
  const extra="ffffffff-ffff-4fff-8fff-ffffffffffff";
  const orderId="11111111-1111-4111-8111-111111111111";
  f.setOrder({id:"canonical",toast_excluded:false,business_date:"2026-10-15"});
  f.setOtherDay({import_state:"imported",unparsed_count:1,coverage_complete:false,
   rechecking_reason:null});
  mocked.request.mockImplementation(async(path:string)=>{
   if(path.includes("paidBusinessDate"))return [payment,extra];
   if(path.includes("/payments/"+extra))return {
    guid:extra,orderGuid:orderId,paidBusinessDate:20261016};
   if(path.includes("/orders/"+orderId))return {guid:orderId,businessDate:20261015};
   return orderWithAutoGratAndGiftCard();
  });
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item.recon_state).toBe("mismatch");
  expect(f.item.recon_source).toBe("toast_analytics");
  expect(f.item.internal_state).toBeNull();
  expect(f.item.payment_repull_at).toBeTruthy();
 });
});
