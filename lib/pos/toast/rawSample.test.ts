import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("./client",async original=>{
 const m=await original<typeof import("./client")>();
 return {...m,createToastClient:()=>({request:mocks.request})};
});
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
  if(table==="toast_raw_samples")return {insert:async(row:Record<string,unknown>)=>{writes.push(row);return {error:null};}};
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
  for(const bad of ["guest-guid","employee-guid","card-guid","Private City",
   "Private Nick","Private Code","Private Worker","Private Cardholder",
   "networkId","1234567","person@example.com","someone"])expect(json).not.toContain(bad);
  expect(json).toContain("Latte @ 3pm");
  expect(json).toContain("hourlyWage");
  expect(json).toContain("regularHours");
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
  const getters=TOAST_READ_ENDPOINTS.filter(e=>e.scope!=="unsupported");
  expect(getters).toHaveLength(88);
  expect(new Set(getters.map(e=>e.endpoint)).size).toBe(88);
  expect(getters.every(e=>e.doc.startsWith("https://doc.toasttab.com/openapi/"))).toBe(true);
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
