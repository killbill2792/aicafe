import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("./client",async importOriginal=>{
 const original=await importOriginal<typeof import("./client")>();
 return {...original,createToastClient:()=>({request:mocks.request})};
});
import {redactToastRaw,toastFieldPaths,claimToastRawSample,captureToastRawSample} from "./rawSample.server";
import {ToastApiError} from "./client";
import type {SupabaseClient} from "@supabase/supabase-js";
const business="11111111-1111-4111-8111-111111111111";
const restaurant="22222222-2222-4222-8222-222222222222";
const payment="33333333-3333-4333-8333-333333333333";
function database(allowed=true,options:{noLocation?:boolean;mappingError?:boolean;leaseBusy?:boolean;leaseError?:boolean;claimError?:boolean}={}){
 const written:{table:string;row:Record<string,unknown>}[]=[];
 const rpc=vi.fn(async(name:string)=>({
   data:name==="toast_acquire_lease"?(options.leaseBusy?null:"lease-nonce"):
    name==="toast_claim_raw_sample"?allowed:null,
   error:name==="toast_acquire_lease"&&options.leaseError||
    name==="toast_claim_raw_sample"&&options.claimError?{message:"synthetic error"}:null
 }));
 const db={
  rpc,
  from(table:string){
   if(table==="toast_raw_samples")return {insert:async(row:Record<string,unknown>)=>{
    written.push({table,row});return {error:null};
   }};
   if(table==="toast_location_mappings"){
    const q={select:()=>q,eq:()=>q,not:()=>q,order:()=>q,
     limit:async()=>({data:options.noLocation?[]:[{restaurant_guid:restaurant}],
      error:options.mappingError?{message:"synthetic error"}:null})};
    return q;
   }
   throw new Error("Unexpected write or table "+table);
  }
 } as unknown as SupabaseClient;
 return {db,written,rpc};
}
beforeEach(()=>{mocks.request.mockReset();let tick=0;vi.spyOn(Date,"now").mockImplementation(()=>1700000000000+(tick++)*6000);});
describe("Toast raw diagnostics",()=>{
 it("redacts PII, card details, auth secrets at all depths",()=>{
  const raw={payments:[{cardType:"VISA",cardEntryMode:"KEYED",tipAmount:3,
   cardLast4:"1234",expiry:"12/29",cardholderName:"A Person",
   customer:{email:"a@example.com",phone:"555"},accessToken:"secret",
   payment:{authorizationCode:"abc",originalProcessingFee:0.12}}]};
  const safe=redactToastRaw(raw);
  const json=JSON.stringify(safe);
  for(const secret of ["1234","12/29","A Person","a@example.com","555","abc","accessToken","cardLast4","customer"])
   expect(json).not.toContain(secret);
  expect(json).toContain("cardEntryMode");
  expect(json).toContain("originalProcessingFee");
  expect(json).toContain("tipAmount");
 });
 it("strips unexpected guest and numeric contact identifiers, never persists arbitrary IDs",()=>{
  const json=JSON.stringify(redactToastRaw({
    guest:{guid:"cafe-guest-identifying-id",name:"Private Guest"},
    anonymousReference:{guid:"private-customer-guid",phoneDigits:4567891,
      pin:1234,externalId:"person-identifier",
      "john@example.com":12,"4242424242424242":"secret","1234":"should not persist"},
    type:"CREDIT",cardEntryMode:"CONTACTLESS",amount:16.5,originalProcessingFee:0.5
  }));
  expect(json).not.toContain("cafe-guest-identifying-id");
  expect(json).not.toContain("Private Guest");
  expect(json).not.toContain("private-customer-guid");
  expect(json).not.toContain("4567891");
  expect(json).not.toContain("1234");
  expect(json).not.toContain("person-identifier");
  expect(json).not.toContain("john@example.com");
  expect(json).not.toContain("4242424242424242");
  expect(json).not.toContain("should not persist");
  expect(json).not.toContain("\\\"1234\\\"");
  expect(json).toContain("CONTACTLESS");
  expect(json).toContain("originalProcessingFee");
 });
 it("retains Toast financial and labor numbers while removing private numbers",()=>{
  const sample=redactToastRaw({
   regularHours:6.5,overtimeHours:2,totalAmount:185.32,amount:14.5,
   tipAmount:2.1,mcaRepaymentAmount:0.15,originalProcessingFee:0.2,
   wagesTotal:125,unknownFinancialTotal:250.33,statementTotal:110,spanMinutes:45,
   phoneDigits:1234567890,customerId:1234,cardLast4:1234,
   employee:{hourlyWage:19.25,totalHours:8.5,firstName:"Private"}
  }) as Record<string,unknown>;
  for(const k of ["regularHours","overtimeHours","totalAmount","amount",
   "tipAmount","mcaRepaymentAmount","originalProcessingFee","wagesTotal",
   "unknownFinancialTotal","statementTotal","spanMinutes"])
   expect(typeof sample[k]).toBe("number");
  expect(JSON.stringify(sample)).not.toContain("1234567890");
  expect(JSON.stringify(sample)).not.toContain("1234");
  expect(JSON.stringify(sample)).not.toContain("Private");
 });
 it("extracts sorted unique nested field paths",()=>{
  expect(toastFieldPaths({payments:[{cardEntryMode:"TAP",refund:{amount:1}},{cardEntryMode:"SWIPE"}]}))
   .toEqual(["payments","payments[]","payments[].cardEntryMode","payments[].refund","payments[].refund.amount"]);
 });
 it("stores 403 as empty sample and only writes raw sample rows",async()=>{
  const {db,written}=database();
  mocks.request.mockRejectedValue(new ToastApiError("missing_permissions",403));
  const result=await captureToastRawSample(business,"2026-10-20",db);
  expect(result.captured).toBe(10);
  expect(written.every(w=>w.table==="toast_raw_samples")).toBe(true);
  expect(written.every(w=>Object.keys(w.row.sample as object).length===0)).toBe(true);
  expect(written.every(w=>w.row.http_status===403)).toBe(true);
 });
 it("uses a DB-backed cooldown and skips all Toast requests on rejection",async()=>{
  const {db,rpc,written}=database(false);
  const result=await captureToastRawSample(business,"2026-10-20",db);
  expect(result.skipped).toBe(true);
  expect(result.reason).toBe("cooldown");
  expect(rpc).toHaveBeenCalledWith("toast_acquire_lease",expect.objectContaining({p_business_id:business}));
  expect(rpc).toHaveBeenCalledWith("toast_release_lease",{p_nonce:"lease-nonce"});
  expect(mocks.request).not.toHaveBeenCalled();
  expect(written).toHaveLength(0);
 });
 it("distinguishes no verified location, busy lease, and database errors",async()=>{
  const cases=[
   {options:{noLocation:true},reason:"no_location"},
   {options:{leaseBusy:true},reason:"busy"},
   {options:{mappingError:true},reason:"db_error"},
   {options:{leaseError:true},reason:"db_error"},
   {options:{claimError:true},reason:"db_error"}
  ] as const;
  for(const {options,reason} of cases){
   mocks.request.mockClear();
   const {db}=database(true,options);
   const result=await captureToastRawSample(business,"2026-10-20",db);
   expect(result.reason).toBe(reason);
   expect(result.skipped).toBe(true);
   expect(mocks.request).not.toHaveBeenCalled();
  }
 });
 it("follows up at most five payment GUIDs and bounds arrays",async()=>{
  const {db,written}=database();
  mocks.request.mockImplementation(async(path:string)=>{
   if(path.startsWith("/orders/v2/payments?"))return Array(8).fill(payment);
   return [{cardType:"VISA",cardLast4:"1234",amount:12}];
  });
  await captureToastRawSample(business,"2026-10-20",db);
  expect(mocks.request.mock.calls.filter(c=>String(c[0]).startsWith("/orders/v2/payments/"))).toHaveLength(5);
  expect(written.every(w=>w.table==="toast_raw_samples")).toBe(true);
 });
 it("preserves bounded menu modifier reference paths without customer information",async()=>{
  const {db,written}=database();
  mocks.request.mockImplementation(async(path:string)=>{
   if(path==="/menus/v2/menus")return {
    menus:[{menuGroups:[{menuItems:[{guid:payment,price:2.5,name:"Latte"}]}]}],
    modifierGroupReferences:{"0":{guid:payment,minimumSelections:1},
      "1":{guid:payment},"2":{guid:payment},"3":{guid:payment}},
    modifierOptionReferences:{"0":{guid:payment,price:0.5},"1":{guid:payment},
      "2":{guid:payment},"3":{guid:payment}}
   };
   return [];
  });
  await captureToastRawSample(business,"2026-10-20",db);
  const menu=written.find(w=>w.row.endpoint==="menus/v2/menus")?.row;
  expect(menu).toBeDefined();
  const paths=menu?.field_paths as string[];
  expect(paths).toContain("modifierGroupReferences.0.guid");
  expect(paths).toContain("modifierOptionReferences.0.price");
  expect(paths).not.toContain("modifierOptionReferences.3.guid");
  expect(JSON.stringify(menu?.sample)).not.toContain(payment);
 });
 it("holds and releases the shared restaurant sync lease",async()=>{
  const {db,rpc}=database();
  mocks.request.mockResolvedValue([]);
  await captureToastRawSample(business,"2026-10-20",db);
  const calls=rpc.mock.calls.map(c=>c[0]);
  expect(calls).toContain("toast_acquire_lease");
  expect(calls).toContain("toast_release_lease");
  expect(calls.indexOf("toast_acquire_lease")).toBeLessThan(calls.indexOf("toast_claim_raw_sample"));
  expect(calls.indexOf("toast_claim_raw_sample")).toBeLessThan(calls.indexOf("toast_release_lease"));
 });
 it("claim uses database function, not a process-local timer",async()=>{
  const {db,rpc}=database();
  expect(await claimToastRawSample(db,business,restaurant,"2026-10-20")).toBe(true);
  expect(rpc).toHaveBeenCalledWith("toast_claim_raw_sample",expect.objectContaining({p_business_id:business}));
 });
});
