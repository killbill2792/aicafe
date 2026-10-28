import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("./client",async importOriginal=>{
 const original=await importOriginal<typeof import("./client")>();
 return {...original,createToastClient:()=>({request:mocks.request})};
});
import {redactToastRaw,toastFieldPaths,claimToastRawSample,captureToastRawSample} from "./rawSample.server";
import type {SupabaseClient} from "@supabase/supabase-js";
const business="11111111-1111-4111-8111-111111111111";
const restaurant="22222222-2222-4222-8222-222222222222";
const payment="33333333-3333-4333-8333-333333333333";
function database(allowed=true){
 const written:{table:string;row:Record<string,unknown>}[]=[];
 const rpc=vi.fn().mockResolvedValue({data:allowed,error:null});
 const db={
  rpc,
  from(table:string){
   if(table==="toast_raw_samples")return {insert:async(row:Record<string,unknown>)=>{
    written.push({table,row});return {error:null};
   }};
   if(table==="toast_location_mappings"){
    const q={select:()=>q,eq:()=>q,not:()=>q,order:()=>q,
     limit:async()=>({data:[{restaurant_guid:restaurant}],error:null})};
    return q;
   }
   throw new Error("Unexpected write or table "+table);
  }
 } as unknown as SupabaseClient;
 return {db,written,rpc};
}
beforeEach(()=>mocks.request.mockReset());
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
 });
 it("extracts sorted unique nested field paths",()=>{
  expect(toastFieldPaths({payments:[{cardEntryMode:"TAP",refund:{amount:1}},{cardEntryMode:"SWIPE"}]}))
   .toEqual(["payments","payments[]","payments[].cardEntryMode","payments[].refund","payments[].refund.amount"]);
 });
 it("stores 403 as empty sample and only writes raw sample rows",async()=>{
  const {db,written}=database();
  mocks.request.mockRejectedValue({status:403});
  const result=await captureToastRawSample(business,"2026-10-20",db);
  expect(result.captured).toBe(10);
  expect(written.every(w=>w.table==="toast_raw_samples")).toBe(true);
  expect(written.every(w=>Object.keys(w.row.sample as object).length===0)).toBe(true);
 });
 it("uses a DB-backed cooldown and skips all Toast requests on rejection",async()=>{
  const {db,rpc,written}=database(false);
  const result=await captureToastRawSample(business,"2026-10-20",db);
  expect(result.skipped).toBe(true);
  expect(rpc).toHaveBeenCalledOnce();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(written).toHaveLength(0);
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
 it("claim uses database function, not a process-local timer",async()=>{
  const {db,rpc}=database();
  expect(await claimToastRawSample(db,business,restaurant,"2026-10-20")).toBe(true);
  expect(rpc).toHaveBeenCalledWith("toast_claim_raw_sample",expect.objectContaining({p_business_id:business}));
 });
});
