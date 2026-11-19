import {describe,expect,it} from "vitest";
import {summarizeInvoiceClaims,summarizeStatementBalances,summarizeRecurringObligations,summarizeBillClaims,historicalCashStress,type InvoiceClaimRow} from "./cashflow";
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

it("excludes invoice claims not yet issued on the requested as-of date",()=>{
 expect(summarizeInvoiceClaims([{...a,issued_on:"2026-11-19"}],asOf,false).recordedClaimCount).toBe(0);
});

describe("documented invoice settlement and recurring dates",()=>{
 const debit={id:"debit",financial_invoice_id:a.id,financial_kind:"settlement_evidence_linked" as const,
  financial_allocation_cents:5000,financial_reverses_id:null,source_revision:1,financial_tx_date:"2026-11-10",
  financial_upload_id:"statement",financial_row_index:0};
 const credit={...debit,id:"credit",financial_kind:"settlement_evidence_reversed" as const,
  financial_allocation_cents:1000,financial_reverses_id:debit.id,financial_row_index:1,financial_tx_date:"2026-11-11"};
 it("reports only documented partial/covered quantities; never all-business outstanding cash",()=>{
  const partial=summarizeInvoiceClaims([a],asOf,false,[debit,credit]);
  expect(partial.claims[0]).toMatchObject({paymentStatus:"documented_partial",documentedAllocatedCents:4000,uncoveredRecordedClaimCents:6000});
  expect(partial.outstandingPaymentCents).toBeNull();
  expect(summarizeInvoiceClaims([a],asOf,false,[{...debit,financial_allocation_cents:10000}]).claims[0].paymentStatus).toBe("documented_covered");
 });
 it("does not inherit earlier allocations after a revision",()=>{
  expect(summarizeInvoiceClaims([a,{...a,id:"new",revision:2}],asOf,false,[debit]).claims[0]).toMatchObject({
   paymentStatus:"revision_review",documentedAllocatedCents:null,uncoveredRecordedClaimCents:null});
 });
 it("fails closed on unsupported reversal and excessive allocations",()=>{
  for(const events of [[credit],[{...debit,financial_allocation_cents:20000}],[debit,{...credit,financial_allocation_cents:5001}]]){
   expect(summarizeInvoiceClaims([a],asOf,false,events).claims[0].documentedAllocatedCents).toBeNull();
  }
 });
 it("keeps unambiguous monthly due dates projected and other terms undated",()=>{
  const bill={id:"rent",label:"Rent",amount_cents:10000,frequency:"monthly",due_day:31,is_estimate:false,
   active_from:"2026-01-01",active_to:null};
  const r=summarizeRecurringObligations([bill,{...bill,id:"weekly",frequency:"weekly"}],"2026-02-15",false);
  expect(r.recurringObligations.find(v=>v.id==="rent")).toMatchObject({nextProjectedDueOn:"2026-03-31",paymentStatus:"unknown"});
  expect(r.recurringObligations.find(v=>v.id==="weekly")?.nextProjectedDueOn).toBeNull();
  expect(r.recurringMissing).toContain("recurringDueDateUnknown");
 });
});

it("keeps dated bill claims separate from recurring settings and retains unknown payment",()=>{
 const bill={id:"one",financial_bill_payee:"municipality",financial_bill_reference:"ref",financial_bill_revision:1,
  financial_bill_issued_on:"2026-11-01",financial_bill_due_on:"2026-11-20",financial_bill_amount_cents:4200,financial_currency:"CAD"};
 const result=summarizeBillClaims([bill,{...bill,id:"two",financial_bill_revision:2,financial_bill_amount_cents:4500}],asOf,false);
 expect(result.billClaimCount).toBe(1);
 expect(result.billClaims[0]).toMatchObject({uploadId:"two",recordedClaimCents:4500,paymentStatus:"unknown"});
 expect(summarizeBillClaims([bill],asOf,true).billClaimCount).toBeNull();
});

it("estimates only conditional dated cash exposure and never adds overlapping source classes",()=>{
 const cash=summarizeStatementBalances([{id:"s",financial_account_key:"a".repeat(64),financial_currency:"CAD",
  financial_from:"2026-10-01",financial_to:"2026-10-31",financial_closing_cents:5000,financial_source_sha256:"b".repeat(64)}],asOf,false);
 const bill={id:"claim",financial_bill_payee:"municipality",financial_bill_reference:"ref",financial_bill_revision:1,
  financial_bill_issued_on:"2026-11-01",financial_bill_due_on:"2026-11-20",financial_bill_amount_cents:4200,financial_currency:"CAD"};
 const projected=historicalCashStress(asOf,30,cash,summarizeInvoiceClaims([a],asOf,false,[]),
  summarizeBillClaims([bill],asOf,false),summarizeRecurringObligations([],asOf,false));
 expect(projected).toHaveLength(2);
 expect(projected[0]).toMatchObject({sourceClass:"supplier_claims",conditionalShortfallCents:5000,balanceAsOf:"2026-10-31"});
 expect(projected[1]).toMatchObject({sourceClass:"dated_bill_claims",conditionalRemainingCents:800});
 expect(projected[0].assumptions).toContain("account and payment coverage unknown");
});

it("prioritizes an actionable standalone invoice over twenty covered earlier claims and pages the rest",()=>{
 const covered=Array.from({length:20},(_,i)=>({...a,id:"covered-"+String(i).padStart(2,"0"),
  invoice_reference:"covered-"+i,due_on:"2026-11-02",purchase_order_id:null}));
 const open={...a,id:"actionable",invoice_reference:"open-later",due_on:"2026-11-20",purchase_order_id:null};
 const rows=[...covered,open];
 const events=covered.map((r,i)=>({id:"event-"+i,financial_invoice_id:r.id,
  financial_kind:"settlement_evidence_linked" as const,financial_allocation_cents:10000,
  financial_reverses_id:null,source_revision:1,financial_tx_date:"2026-11-02",
  financial_upload_id:"statement",financial_row_index:i}));
 const first=summarizeInvoiceClaims(rows,asOf,false,events);
 expect(first.claims[0]).toMatchObject({invoiceId:"actionable",paymentStatus:"unknown",purchaseOrderId:null});
 expect(first.claimNextOffset).toBe(20);
 const next=summarizeInvoiceClaims(rows,asOf,false,events,first.claimNextOffset!);
 expect(next.claims).toHaveLength(1);expect(next.claims[0].paymentStatus).toBe("documented_covered");
 expect(next.claimNextOffset).toBeNull();
 expect(new Set([...first.claims,...next.claims].map(c=>c.invoiceId)).size).toBe(21);
 expect(next.recordedClaimTotalsByCurrency).toEqual(first.recordedClaimTotalsByCurrency);
 expect(next.documentedSettlementLinks[0].invoiceId).toBe(next.claims[0].invoiceId);
 expect(next.claimDetailsTruncated).toBe(true);
});
