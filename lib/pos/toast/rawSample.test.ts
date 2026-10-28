import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({request:vi.fn(),eraRequest:vi.fn(),eraGet:vi.fn()}));
vi.mock("./client",async original=>{
 const m=await original<typeof import("./client")>();
 return {...m,createToastClient:()=>({request:mocks.request})};
});
vi.mock("./analyticsClient",()=>({createToastAnalyticsClient:()=>({
 requestRaw:mocks.eraRequest,getRaw:mocks.eraGet
})}));
import {OFFICIAL_TOAST_GET_PATHS} from "./officialGetPaths.fixture";
import {captureToastRawSample,redactToastRaw,toastFieldPaths,TOAST_READ_ENDPOINTS,claimToastRawSample} from "./rawSample.server";
import {ToastApiError} from "./client";
import type {SupabaseClient} from "@supabase/supabase-js";
const business="11111111-1111-4111-8111-111111111111";
const restaurant="22222222-2222-4222-8222-222222222222";
function database(allow=true){
 const writes:Record<string,unknown>[]=[];
 const rpc=vi.fn(async(name:string)=>({
  data:name==="toast_acquire_lease"?"11111111-1111-4111-8111-111111111111":
   name==="toast_claim_raw_sample"?allow:
   name==="toast_renew_raw_sample_lease"?true:null,error:null
 }));
 const db={rpc,from:(table:string)=>{
  if(table==="toast_raw_samples")return {insert:async(row:Record<string,unknown>|Record<string,unknown>[])=>{writes.push(...Array.isArray(row)?row:[row]);return {error:null};}};
  if(table==="toast_location_mappings"){
   const q={select:()=>q,eq:()=>q,not:()=>q,order:()=>q,
    limit:async()=>({data:[{restaurant_guid:restaurant}],error:null})};
   return q;
  }
  throw Error("unexpected table");
 }} as unknown as SupabaseClient;
 return {db,writes,rpc};
}
beforeEach(()=>{
 mocks.request.mockReset();
 mocks.eraRequest.mockReset().mockRejectedValue(new ToastApiError("missing_permissions",403));
 mocks.eraGet.mockReset().mockRejectedValue(new ToastApiError("missing_permissions",403));
 process.env.TOAST_CUSTOMER_HASH_KEY="test-only-32-byte-stable-hmac-key!!";
 vi.spyOn(globalThis,"setTimeout").mockImplementation(((fn:()=>void)=>{fn();return 0;}) as typeof setTimeout);
 let i=0;vi.spyOn(Date,"now").mockImplementation(()=>Date.parse("2026-10-20T00:00:00Z")+i++*1000);
});
describe("read-only Toast coverage diagnostics",()=>{
 it("retains business names/times, hours and wages and hashes repeat customer IDs",()=>{
  const a={customer:{guid:"customer-1",name:"Private Person",email:"pii@example.org"},
    guestId:"same-guest",cardPaymentId:"card-1",cardTokenId:"card-secret",
    name:"Latte",itemName:"Cappuccino",jobTitle:"Barista",diningOption:"Dine in",
    openedDate:"2026-10-20T07:00:00Z",amount:10.25,regularHours:8,wages:120,
    cardLast4:"1234",cardNumber:"4242424242424242",accessToken:"secret"};
  const s=redactToastRaw(a,0,"",process.env.TOAST_CUSTOMER_HASH_KEY);
  const json=JSON.stringify(s);
  for(const bad of ["Private Person","pii@example.org","same-guest","card-1","card-secret","1234","4242424242424242","accessToken"])
   expect(json).not.toContain(bad);
  for(const good of ["Latte","Barista","Dine in","2026-10-20T07:00:00Z","regularHours","wages","hmac:"])
   expect(json).toContain(good);
  expect(redactToastRaw(a,0,"",process.env.TOAST_CUSTOMER_HASH_KEY)).toEqual(s);
 });
 it("removes nested guest, employee and card PII including dynamic-key metadata",async()=>{
  const raw={customer:{guid:"guest-guid",city:"Private City",nickname:"Private Nick",
    unrelatedString:"Private Code",regularHours:8.5,totalAmount:28},
   employee:{guid:"employee-guid",name:"Private Worker",hourlyWage:25,regularHours:8},
   card:{guid:"card-guid",name:"Private Cardholder",networkId:1234567,cardType:"VISA"},
   "person@example.com":{customerId:"someone"},itemName:"Latte @ 3pm"};
  const safe=redactToastRaw(raw,0,"",process.env.TOAST_CUSTOMER_HASH_KEY);
  const json=JSON.stringify(safe);
  for(const bad of ["guest-guid","card-guid","Private City",
   "Private Nick","Private Code","Private Worker","Private Cardholder",
   "networkId","1234567","person@example.com","someone"])expect(json).not.toContain(bad);
  expect(json).toContain("Latte @ 3pm");
  expect(json).toContain("hourlyWage");
  expect(json).toContain("regularHours");
  expect(json).toContain("employee-guid"); // Employee GUID is a business identity, never a guest/card ID.
  const {db,writes}=database();
  mocks.request.mockImplementation(async(path:string)=>{
   if(path.startsWith("/orders/v2/ordersBulk?"))return [raw];
   return [];
  });
  await captureToastRawSample(business,"2026-10-20",db);
  const first=writes.find(w=>w.endpoint==="orders/v2/ordersBulk");
  const counts=first?.identifier_counts as Record<string,{present:number;filled:number}>;
  expect(counts["[].customer.guid"]).toEqual({present:1,filled:1});
  expect(counts["[].card.guid"]).toEqual({present:1,filled:1});
  expect(counts["[].*.customerId"]).toEqual({present:1,filled:1});
  expect(JSON.stringify(counts)).not.toContain("person@example.com");
 });
 it("matches the complete documented GET inventory without duplicates",()=>{
  const getters=TOAST_READ_ENDPOINTS.filter(e=>e.scope!=="unsupported"&&e.scope!=="era_request");
  expect(getters).toHaveLength(88);
  expect(new Set(getters.map(e=>e.endpoint)).size).toBe(88);
  expect(getters.map(e=>[e.endpoint,e.path,e.doc].join("|")).sort()).toEqual(OFFICIAL_TOAST_GET_PATHS); 
  expect(getters.every(e=>e.doc.startsWith("https://doc.toasttab.com/openapi/"))).toBe(true);
  expect(TOAST_READ_ENDPOINTS.filter(e=>e.scope==="era_request")).toHaveLength(9);
  expect(TOAST_READ_ENDPOINTS.filter(e=>e.scope==="unsupported")).toHaveLength(5);
 });
 it("retains menu selections but removes guest check and payment labels",()=>{
  const raw={checks:[{name:"Guest Alex",openedDate:"2026-10-20T09:05:00Z",
    selections:[{name:"Latte",price:5.5,modifiers:[{name:"Oat Milk",price:1}]}]}],
   payments:[{name:"Private card payer",amount:6.5,cardEntryMode:"TAP"}]};
  const json=JSON.stringify(redactToastRaw(raw,0,"",process.env.TOAST_CUSTOMER_HASH_KEY));
  for(const privateValue of ["Guest Alex","Private card payer"])expect(json).not.toContain(privateValue);
  for(const businessValue of ["Latte","Oat Milk","2026-10-20T09:05:00Z","TAP"])
   expect(json).toContain(businessValue);
 });
 it("keeps order, check, payment, discount, modifier and staff facts while removing personal fields",()=>{
  const order={
   guid:"11111111-1111-4111-8111-111111111112",orderNumber:451,
   revenueCenterGuid:"22222222-2222-4222-8222-222222222224",
   serverGuid:"33333333-3333-4333-8333-333333333333",
   employeeGuid:"44444444-4444-4444-8444-444444444444",
   openedDate:"2026-10-20T09:00:00Z",
   customer:{guid:"private-customer-id",name:"Jane Customer",email:"jane@example.com",phone:"415-555-1234"},
   checks:[{guid:"55555555-5555-4555-8555-555555555555",checkNumber:7,
    name:"Guest Jane",amount:24.50,refundStatus:"REFUNDED",status:"CLOSED",
    discounts:[{guid:"66666666-6666-4666-8666-666666666666",name:"Loyalty 10%"}],
    selections:[{name:"Cappuccino",unitPrice:6,modifiers:[{name:"Oat Milk",price:1}]}],
    payments:[{guid:"77777777-7777-4777-8777-777777777777",amount:24.50,
     cardType:"VISA",cardEntryMode:"TAP",refundStatus:"NONE",cardNumber:"4111111111111111",
     cardLast4:"1111",cardholderName:"Jane Customer",authToken:"private-token",
     customerId:"customer-id",loyaltyId:"loyalty-id",cardId:"card-id",
     email:"jane@example.com",streetAddress:"1 Private St",latitude:37.3,
     notes:"Jane is allergic"}]}]
  };
  const safe=redactToastRaw(order,0,"",process.env.TOAST_CUSTOMER_HASH_KEY);
  const text=JSON.stringify(safe);
  for(const kept of ["revenueCenterGuid","serverGuid","employeeGuid","checkNumber",
   "refundStatus","CLOSED","Loyalty 10%","Cappuccino","Oat Milk","cardEntryMode",
   "TAP","2026-10-20T09:00:00Z","77777777-7777-4777-8777-777777777777"])
   expect(text).toContain(kept);
  for(const privateValue of ["Jane Customer","Jane is allergic","4111111111111111",
   "jane@example.com","1 Private St","private-token","private-customer-id",
   "customer-id","loyalty-id","card-id","cardLast4","latitude"])
   expect(text).not.toContain(privateValue);
  expect((safe as typeof order).customer.guid).toMatch(/^hmac:[a-f0-9]{64}$/);
  const payment=((safe as typeof order).checks[0].payments[0]);
  expect(payment.customerId).toMatch(/^hmac:[a-f0-9]{64}$/);
  expect(payment.loyaltyId).toMatch(/^hmac:[a-f0-9]{64}$/);
  expect(payment.cardId).toMatch(/^hmac:[a-f0-9]{64}$/);
 });
 it("runs no-GET families first, then batches one skipped_time_budget row per untried endpoint",async()=>{
  const {db,writes}=database();
  mocks.request.mockResolvedValue([]);
  let counter=0;
  vi.spyOn(Date,"now").mockImplementation(()=>Date.parse("2026-10-20T00:00:00Z")+counter++*1000);
  const result=await captureToastRawSample(business,"2026-10-20",db,34000);
  expect(result.reason).toBe("partial");
  expect(result.failed).toBe(0);
  expect(writes).toHaveLength(TOAST_READ_ENDPOINTS.length);
  expect(new Set(writes.map(x=>x.endpoint)).size).toBe(TOAST_READ_ENDPOINTS.length);
  expect(writes.slice(0,5).every(x=>x.error_code==="no_get_operations")).toBe(true);
  expect(writes.some(x=>x.error_code==="skipped_time_budget")).toBe(true);
 });
 it("starts each of the nine ERA requests and stores completed 200 GET results",async()=>{
  const {db,writes}=database();
  mocks.request.mockRejectedValue(new ToastApiError("missing_permissions",403));
  mocks.eraRequest.mockResolvedValue({guid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",status:200});
  mocks.eraGet.mockResolvedValue({status:200,data:[{netSalesAmount:42,orderGuid:"ok",guestEmail:"private@example.org"}]});
  await captureToastRawSample(business,"2026-10-20",db);
  expect(mocks.eraRequest).toHaveBeenCalledTimes(9);
  expect(mocks.eraGet).toHaveBeenCalledTimes(10);
  expect(writes.filter(x=>String(x.endpoint).startsWith("era/v1/")&&x.http_status===200)).toHaveLength(19);
  expect(JSON.stringify(writes.filter(x=>String(x.endpoint).startsWith("era/v1/")))).not.toContain("private@example.org");
 });
 it("polls a pending 202 report until ready",async()=>{
  const {db,writes}=database();
  mocks.request.mockRejectedValue(new ToastApiError("missing_permissions",403));
  mocks.eraRequest.mockResolvedValue({guid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",status:200});
  mocks.eraGet.mockResolvedValue({status:200,data:[{netSalesAmount:10}]})
   .mockResolvedValueOnce({status:202,data:null});
  await captureToastRawSample(business,"2026-10-20",db);
  expect(mocks.eraGet).toHaveBeenCalledTimes(11);
  const metrics=writes.find(x=>x.endpoint==="era/v1/metrics/{reportRequestGuid}");
  expect(metrics?.http_status).toBe(200);
  expect(metrics?.error_code).toBeNull();
 });
 it("propagates 403 on the ERA report request and dependent GET as evidence",async()=>{
  const {db,writes}=database();
  mocks.request.mockRejectedValue(new ToastApiError("missing_permissions",403));
  await captureToastRawSample(business,"2026-10-20",db);
  const request=writes.find(x=>x.endpoint==="era/v1/metrics");
  const get=writes.find(x=>x.endpoint==="era/v1/metrics/{reportRequestGuid}");
  expect(request?.http_status).toBe(403);
  expect(get?.http_status).toBe(403);
  expect(get?.error_code).toBe("missing_permissions");
  expect(mocks.eraGet.mock.calls.filter(([path])=>String(path).includes("reportRequestGuid"))).toHaveLength(0);
  expect(mocks.eraGet).toHaveBeenCalledTimes(1);
 });
 it("keeps paths for nested arrays",()=>{
  expect(toastFieldPaths({items:[{name:"Latte",price:5}]})).toContain("items[].price");
 });
 it("attempts all catalog entries; records unavailable 403 and never writes outside diagnostics",async()=>{
  const {db,writes}=database();
  mocks.request.mockRejectedValue(new ToastApiError("missing_permissions",403));
  const result=await captureToastRawSample(business,"2026-10-20",db);
  expect(result.failed).toBe(0);
  expect(writes.length).toBe(TOAST_READ_ENDPOINTS.length);
  expect(writes.filter(w=>w.http_status===403).length).toBeGreaterThan(20);
  expect(writes.every(w=>typeof w.doc_url==="string"&&"field_paths"in w)).toBe(true);
  expect(mocks.request).toHaveBeenCalled();
 });
 it("records 204 without fabricating a successful payload",async()=>{
  const {db,writes}=database();
  mocks.request.mockRejectedValue(new ToastApiError("unavailable",204));
  await captureToastRawSample(business,"2026-10-20",db);
  expect(writes.some(w=>w.http_status===204)).toBe(true);
 });
 it("caps paged endpoints at twenty pages",async()=>{
  const {db,writes}=database();
  mocks.request.mockImplementation(async(path:string)=>{
   if(path.startsWith("/orders/v2/ordersBulk?"))return Array.from({length:100},()=>({amount:3}));
   return [];
  });
  await captureToastRawSample(business,"2026-10-20",db);
  const orderCalls=mocks.request.mock.calls.filter(([p])=>String(p).startsWith("/orders/v2/ordersBulk?"));
  expect(orderCalls).toHaveLength(20);
  expect(writes.some(w=>w.error_code==="page_cap")).toBe(true);
 });
 it("respects the database cooldown",async()=>{
  const {db,writes}=database(false);
  const result=await captureToastRawSample(business,"2026-10-20",db);
  expect(result.reason).toBe("cooldown");
  expect(writes).toHaveLength(0);
  expect(mocks.request).not.toHaveBeenCalled();
 });
 it("uses database-backed claim",async()=>{
  const {db,rpc}=database();
  expect(await claimToastRawSample(db,business,restaurant,"2026-10-20")).toBe(true);
  expect(rpc).toHaveBeenCalledWith("toast_claim_raw_sample",expect.any(Object));
 });
});
