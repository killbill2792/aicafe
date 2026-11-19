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
function database(failingTable?:string,extraInvoices:typeof row[]=[],extraEvents:Record<string,unknown>[]=[]) {
 const eq=vi.fn();
 const from=vi.fn((table:string)=>{
  let result:Record<string,unknown>[]=table==="purchase_reconciliation_events"?[...extraEvents]:table!=="supplier_invoices"?[]:[row,{...row,id:"other-cafe",business_id:"other"},
   {...row,id:"other-owner",owner_user_id:"other"},...extraInvoices];
  const q={select(){return q},eq(field:string,value:unknown){eq(field,value);
    result=result.filter(r=>r[field]===value);return q},
    in(field:string,values:unknown[]){result=result.filter(r=>values.includes(r[field]));return q},order(){return q},limit(n:number){result=result.slice(0,n);return q},
    then(ok:(value:unknown)=>unknown,fail?:(reason:unknown)=>unknown){
     return Promise.resolve(table===failingTable?{data:null,error:{message:"source unavailable"}}:{data:result,error:null}).then(ok,fail);
    }};
  return q;
 });
 return {client:{from} as unknown as SupabaseClient,from,eq};
}
describe("finance source owner boundary",()=>{
 it("filters both café and owner, reauthorizes and preserves unknown payment",async()=>{
  const db=database();auth.mockReset().mockResolvedValue({client:db.client});
  const r=await readFinancialEvidence(scope,"2026-11-18");
  expect(db.eq.mock.calls).toEqual([["business_id","cafe"],["owner_user_id","owner"],["business_id","cafe"],["financial_owner_user_id","owner"],["kind","statement"],["status","done"],["business_id","cafe"],["owner_user_id","owner"],["business_id","cafe"],["business_id","cafe"],["financial_owner_user_id","owner"],["kind","bill_claim"],["status","done"]]);
  expect(auth).toHaveBeenCalledTimes(2);
  expect(r.claims).toHaveLength(1);
  expect(r.claims[0]).toMatchObject({invoiceId:"invoice",dueDatePosition:"on_as_of",paymentStatus:"unknown"});
  expect(r.outstandingPaymentCents).toBeNull();
 });
 it("retains invoice evidence when the statement source fails",async()=>{
  const db=database("uploads");auth.mockReset().mockResolvedValue({client:db.client});
  const r=await readFinancialEvidence(scope,"2026-11-18");
  expect(r.recordedClaimCount).toBe(1);
  expect(r.documentedAccountBalances).toEqual([]);
  expect(r.missing).toContain("statementEvidenceUnavailable");
 });
 it("retrieves an exact standalone invoice and its own allocations beyond the global history limit",async()=>{
  const history=Array.from({length:510},(_,i)=>({...row,id:"historic-"+i,invoice_reference:"historic-"+i}));
  const target={...row,id:"target",invoice_reference:"last-document",purchase_order_id:null as unknown as string};
  const db=database(undefined,[...history,target,{...target,id:"foreign",business_id:"other"},
    {...target,id:"foreign-owner",owner_user_id:"other"}],[{id:"allocation",business_id:"cafe",owner_user_id:"owner",
     financial_invoice_id:"target",financial_kind:"settlement_evidence_linked",financial_allocation_cents:1000,
     financial_reverses_id:null,source_revision:1,financial_tx_date:"2026-11-12",financial_upload_id:"statement",financial_row_index:0},
    {id:"foreign-allocation",business_id:"other",owner_user_id:"owner",financial_invoice_id:"target",financial_kind:"settlement_evidence_linked"}]);
  auth.mockReset().mockResolvedValue({client:db.client});
  expect((await readFinancialEvidence(scope,"2026-11-18")).recordedClaimCount).toBeNull();
  const selected=await readFinancialEvidence(scope,"2026-11-18",{invoiceReference:"LAST-DOCUMENT"});
  expect(selected.invoiceReferenceFilter).toBe("last-document");
  expect(selected.claims).toEqual([expect.objectContaining({invoiceId:"target",purchaseOrderId:null,documentedAllocatedCents:1000,paymentStatus:"documented_partial"})]);
  expect(selected.documentedSettlementLinks).toEqual([expect.objectContaining({eventId:"allocation",invoiceId:"target"})]);
  expect(selected.conditionalStress.filter(r=>r.sourceClass==="supplier_claims")).toEqual([]);
 });
 it("does not query unauthorized scopes or return data after revocation",async()=>{
  const db=database();auth.mockReset().mockRejectedValueOnce(Error("unauthorized"));
  await expect(readFinancialEvidence(scope,"2026-11-18")).rejects.toThrow("unauthorized");
  expect(db.from).not.toHaveBeenCalled();
  auth.mockReset().mockResolvedValueOnce({client:db.client}).mockRejectedValueOnce(Error("revoked"));
  await expect(readFinancialEvidence(scope,"2026-11-18")).rejects.toThrow("revoked");
 });
});
