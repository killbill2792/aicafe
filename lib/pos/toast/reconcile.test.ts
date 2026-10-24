import {beforeEach,describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
const mocked=vi.hoisted(()=>({request:vi.fn(),requestDay:vi.fn(),getDay:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./client",async()=>{
 const {z}=await import("zod");
 class ToastApiError extends Error{constructor(public category:string){super(category);}}
 return {GUID:z.uuid(),ToastApiError,createToastClient:()=>({request:mocked.request})};
});
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
 imported_at:"2026-10-17T10:00:00Z",last_recon_attempt_at:null as string|null});
function fakeDb(analytics:boolean){
 const item=status(),writes:Record<string,unknown>[]=[];
 const calls:string[]=[];
 const db={
  from(table:string){
   const filters:Record<string,unknown>={};
   let patch:Record<string,unknown>|null=null;
   const q={
    select(_s:string){return q;},eq(k:string,v:unknown){filters[k]=v;return q;},
    in(_k:string,_v:unknown[]){return q;},order(_k:string){return q;},limit(_n:number){return q;},
    update(value:Record<string,unknown>){patch=value;return q;},
    upsert(_x:unknown){return {error:null};},
    async maybeSingle(){
     if(table==="toast_analytics_credentials")
      return {data:analytics?{business_id:business,verified_at:"2026-10-17"}:null,error:null};
     if(table==="toast_analytics_jobs")return {data:null,error:null};
     return {data:null,error:null};
    },
    then(yes:(v:unknown)=>unknown,no?:((e:unknown)=>unknown)){
     if(table==="toast_day_status"&&patch){writes.push(patch);Object.assign(item,patch);}
     const data=table==="toast_day_status"&&!patch?[item]:
      table==="toast_void_facts"?[]:[];
     return Promise.resolve({data,error:null}).then(yes,no);
    }
   };return q;
  },
  async rpc(name:string){calls.push(name);return {data:true,error:null};}
 };
 return {db:db as unknown as SupabaseClient,item,writes,calls};
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
  expect(f.calls).not.toContain("toast_certify_day_voids");
 });
 it("keeps ERA 202 pending instead of fabricating a settlement",async()=>{
  const f=fakeDb(true);mocked.getDay.mockResolvedValue({pending:true});
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"pending",analytics_state:"pending"});
  expect(f.calls).not.toContain("toast_certify_day_voids");
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
   path.includes("paidBusinessDate")?[]:orderWithAutoGratAndGiftCard());
  await reconcileToastDays(f.db,p,Date.now()+20000);
  expect(f.item).toMatchObject({recon_state:"mismatch",import_state:"imported"});
  expect(f.calls).not.toContain("toast_certify_day_voids");
 });
});
