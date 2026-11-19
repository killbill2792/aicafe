import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const auth=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/ai/supervisor/loop/simulationOwner.server",()=>({simulationOwnerReader:auth}));
import {readFinancialEvidence} from "./financialEvidence.server";
const scope={businessId:"cafe",ownerUserId:"owner"};
const row={id:"invoice",supplier_id:"supplier",purchase_order_id:"po",invoice_reference:"ref",
 revision:1,issued_on:"2026-11-01",due_on:"2026-11-18",currency_code:"CAD",total_cents:3000,
 business_id:"cafe",owner_user_id:"owner"};
function database(){
 const eq=vi.fn();
 const from=vi.fn(()=>{
  let result=[row,{...row,id:"other-cafe",business_id:"other"},
   {...row,id:"other-owner",owner_user_id:"other"}];
  const q={select(){return q},eq(field:string,value:unknown){eq(field,value);
    result=result.filter(r=>r[field as keyof typeof row]===value);return q},
    order(){return q},limit(n:number){result=result.slice(0,n);return q},
    then(ok:(value:unknown)=>unknown,fail?:(reason:unknown)=>unknown){
     return Promise.resolve({data:result,error:null}).then(ok,fail);
    }};
  return q;
 });
 return {client:{from} as unknown as SupabaseClient,from,eq};
}
describe("finance source owner boundary",()=>{
 it("filters both café and owner, reauthorizes and preserves unknown payment",async()=>{
  const db=database();auth.mockReset().mockResolvedValue({client:db.client});
  const r=await readFinancialEvidence(scope,"2026-11-18");
  expect(db.eq.mock.calls).toEqual([["business_id","cafe"],["owner_user_id","owner"]]);
  expect(auth).toHaveBeenCalledTimes(2);
  expect(r.claims).toHaveLength(1);
  expect(r.claims[0]).toMatchObject({invoiceId:"invoice",dueDatePosition:"on_as_of",paymentStatus:"unknown"});
  expect(r.outstandingPaymentCents).toBeNull();
 });
 it("does not query unauthorized scopes or return data after revocation",async()=>{
  const db=database();auth.mockReset().mockRejectedValueOnce(Error("unauthorized"));
  await expect(readFinancialEvidence(scope,"2026-11-18")).rejects.toThrow("unauthorized");
  expect(db.from).not.toHaveBeenCalled();
  auth.mockReset().mockResolvedValueOnce({client:db.client}).mockRejectedValueOnce(Error("revoked"));
  await expect(readFinancialEvidence(scope,"2026-11-18")).rejects.toThrow("revoked");
 });
});
