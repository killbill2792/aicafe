import {describe,expect,it} from "vitest";
import {summarizeInvoiceClaims,summarizeStatementBalances,type InvoiceClaimRow} from "./cashflow";
const asOf="2026-11-18";
const a:InvoiceClaimRow={id:"first",supplier_id:"supplier",purchase_order_id:"po",
 invoice_reference:"invoice",revision:1,issued_on:"2026-11-01",due_on:"2026-11-17",
 currency_code:"CAD",total_cents:10000};
describe("recorded invoice claims",()=>{
 it("keeps the latest revision, separate currencies and unknown settlement",()=>{
  const r=summarizeInvoiceClaims([a,{...a,id:"revised",revision:2,total_cents:"7500"},
   {...a,id:"other",supplier_id:"another",currency_code:"EUR",due_on:null}],asOf,false);
  expect(r.recordedClaimCount).toBe(2);
  expect(r.recordedClaimTotalsByCurrency).toEqual([{currency:"CAD",recordedClaimCents:7500},
   {currency:"EUR",recordedClaimCents:10000}]);
  expect(r.claims.find(x=>x.invoiceId==="revised")).toMatchObject({
   dueDatePosition:"before_as_of",paymentStatus:"unknown",recordedClaimCents:7500});
  expect(r.outstandingPaymentCents).toBeNull();
  expect(r.settledPaymentCents).toBeNull();
 });
 it("distinguishes an empty recorded source from a zero liability",()=>{
  const r=summarizeInvoiceClaims([],asOf,false);
  expect(r.recordedClaimCount).toBe(0);
  expect(r.recordedClaimTotalsByCurrency).toEqual([]);
  expect(r.outstandingPaymentCents).toBeNull();
  expect(r.missing).toContain("allObligationsCoverageUnknown");
 });
 it("rejects incomplete history, ambiguous identity, invalid values and overflow",()=>{
  for(const rows of [[{...a,total_cents:"invalid"}],[{...a,due_on:"2026-02-30"}],
   [a,{...a,id:"collision",purchase_order_id:"other",revision:2}],
   [a,{...a,id:"duplicate"}],
   [{...a,total_cents:Number.MAX_SAFE_INTEGER},{...a,id:"b",invoice_reference:"b"}]]){
   expect(summarizeInvoiceClaims(rows,asOf,false).recordedClaimCount).toBeNull();
  }
  expect(summarizeInvoiceClaims([a],asOf,true).recordedClaimCount).toBeNull();
 });
 it("bounds details without truncating complete recorded-claim totals",()=>{
  const r=summarizeInvoiceClaims(Array.from({length:22},(_,i)=>({...a,id:String(i),
    invoice_reference:String(i),due_on:"2026-11-18"})),asOf,false);
  expect(r.recordedClaimCount).toBe(22);
  expect(r.claims).toHaveLength(20);
  expect(r.claimDetailsTruncated).toBe(true);
  expect(r.recordedClaimTotalsByCurrency).toEqual([{currency:"CAD",recordedClaimCents:220000}]);
 });
});

describe("historical statement evidence",()=>{
 const a={id:"s1",financial_account_key:"a".repeat(64),financial_currency:"CAD",financial_from:"2026-10-01",
  financial_to:"2026-10-31",financial_closing_cents:10000,financial_source_sha256:"b".repeat(64)};
 it("selects latest by account and preserves as-of, not current cash",()=>{
  const r=summarizeStatementBalances([a,{...a,id:"s2",financial_to:"2026-11-15",financial_closing_cents:12000,
   financial_source_sha256:"c".repeat(64)},{...a,id:"future",financial_to:"2026-12-31"}],asOf,false);
  expect(r.documentedAccountBalances).toEqual([expect.objectContaining({uploadId:"s2",asOf:"2026-11-15",
   closingCents:12000,freshness:"dated_not_live"})]);
  expect(r.statementMissing).toContain("bankAccountCoverageUnknown");
 });
 it("does not claim a balance for conflicting latest statements or truncated evidence",()=>{
  expect(summarizeStatementBalances([a,{...a,id:"different",financial_closing_cents:20000}],asOf,false).documentedAccountBalances).toEqual([]);
  expect(summarizeStatementBalances([a],asOf,true).documentedAccountBalances).toEqual([]);
 });
});
