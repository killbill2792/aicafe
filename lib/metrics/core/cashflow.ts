/** Recorded supplier claims are not verified unpaid liabilities or cash movements.
 * Preserve currency, current revision, document date and unknown payment status.
 * No assumed cash, account coverage, settlement or invoice-to-PO multiplication. */
export type InvoiceClaimRow={
 id:string; supplier_id:string; purchase_order_id:string|null; invoice_reference:string;
 revision:number|string; issued_on:string; due_on:string|null;
 currency_code:string; total_cents:number|string;
};
const exactInteger=(value:number|string):number|null=>{
 if(typeof value!=="number"&&(typeof value!=="string"||!/^\d+$/.test(value)))return null;
 const n=Number(value);
 return Number.isSafeInteger(n)&&n>=0?n:null;
};
const validDate=(value:string):boolean=>{
 if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+"T00:00:00Z");
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
};
type Claim={
 invoiceId:string; supplierId:string; purchaseOrderId:string|null; invoiceReference:string;
 revision:number; issuedOn:string; dueOn:string|null; currency:string; recordedClaimCents:number;
 dueDatePosition:"before_as_of"|"on_as_of"|"after_as_of"|"undated";
 paymentStatus:"unknown"|"documented_partial"|"documented_covered"|"revision_review";
 documentedAllocatedCents:number|null;uncoveredRecordedClaimCents:number|null;
};
export type SettlementEvidenceRow={
 id:string;financial_invoice_id:string;financial_kind:"settlement_evidence_linked"|"settlement_evidence_reversed";
 financial_allocation_cents:number|string;financial_reverses_id:string|null;source_revision:number|string;
 financial_tx_date:string;financial_upload_id:string;financial_row_index:number|string;
};
export function summarizeInvoiceClaims(rows:readonly InvoiceClaimRow[],asOf:string,truncated:boolean,
 settlements:readonly SettlementEvidenceRow[]|null=null,claimOffset=0){
 const unavailable=(reason:string)=>({coverage:"incomplete" as const,missing:[reason],
   recordedClaimCount:null,claims:[] as Claim[],claimDetailsTruncated:false,claimNextOffset:null as number|null,documentedSettlementLinks:[] as {eventId:string;invoiceId:string;uploadId:string;rowIndex:number|null;transactionDate:string;linkedCents:number;documentedRemainingCents:number}[],
   recordedClaimTotalsByCurrency:[] as {currency:string;recordedClaimCents:number}[],
   outstandingPaymentCents:null,settledPaymentCents:null});
 if(truncated)return unavailable("supplier_invoice_history_truncated");
 if(!validDate(asOf))return unavailable("cafe_date_unavailable");
 if(!Number.isSafeInteger(claimOffset)||claimOffset<0)return unavailable("supplier_invoice_offset_invalid");
 const latest=new Map<string,Claim>();
 for(const row of rows){
  const revision=exactInteger(row.revision),total=exactInteger(row.total_cents);
  if(!row.id||!row.supplier_id||!row.invoice_reference||!revision||total===null||
   !/^[A-Z]{3}$/.test(row.currency_code)||!validDate(row.issued_on)||
   (row.due_on!==null&&!validDate(row.due_on)))return unavailable("supplier_invoice_evidence_invalid");
  if(row.issued_on>asOf)continue;
  const key=JSON.stringify([row.supplier_id,row.invoice_reference]);
  const old=latest.get(key);
  if(old&&(old.purchaseOrderId!==row.purchase_order_id||old.currency!==row.currency_code||
     old.revision===revision))return unavailable("supplier_invoice_identity_ambiguous");
  if(old&&old.revision>revision)continue;
  latest.set(key,{invoiceId:row.id,supplierId:row.supplier_id,purchaseOrderId:row.purchase_order_id,
   invoiceReference:row.invoice_reference,revision,issuedOn:row.issued_on,dueOn:row.due_on,
   currency:row.currency_code,recordedClaimCents:total,paymentStatus:"unknown",documentedAllocatedCents:null,uncoveredRecordedClaimCents:null,
   dueDatePosition:row.due_on===null?"undated":row.due_on<asOf?"before_as_of":
     row.due_on===asOf?"on_as_of":"after_as_of"});
 }
 const all=[...latest.values()].sort((a,b)=>
  (a.dueOn??"").localeCompare(b.dueOn??"")||a.invoiceId.localeCompare(b.invoiceId));
 const totals=new Map<string,number>();
 const rowById=new Map(rows.map(r=>[r.id,r]));
 const net=new Map<string,number>(),links=new Map<string,{row:SettlementEvidenceRow;amount:number;reversed:number}>();
 const settlementMissing:string[]=[];
 let settlementValid=settlements!==null;
 for(const event of settlements??[]){
  const invoice=rowById.get(event.financial_invoice_id), amount=exactInteger(event.financial_allocation_cents);
  if(!invoice||!amount||!event.id||!validDate(event.financial_tx_date)||
   exactInteger(invoice.revision)!==exactInteger(event.source_revision)){settlementValid=false;break;}
  if(event.financial_tx_date>asOf)continue;
  if(event.financial_kind==="settlement_evidence_linked"){
   if(event.financial_reverses_id!==null||links.has(event.id)){settlementValid=false;break;}
   links.set(event.id,{row:event,amount,reversed:0});
  }else if(event.financial_kind!=="settlement_evidence_reversed"){settlementValid=false;break;}
 }
 if(settlementValid)for(const event of settlements??[]){
  if(event.financial_kind!=="settlement_evidence_reversed"||event.financial_tx_date>asOf)continue;
  const linked=event.financial_reverses_id?links.get(event.financial_reverses_id):undefined;
  const amount=exactInteger(event.financial_allocation_cents);
  if(!linked||!amount||linked.row.financial_invoice_id!==event.financial_invoice_id||
    linked.row.financial_tx_date>event.financial_tx_date||linked.reversed+amount>linked.amount){
   settlementValid=false;break;
  }
  linked.reversed+=amount;
 }
 if(settlementValid)for(const {row,amount,reversed} of links.values()){
  const n=(net.get(row.financial_invoice_id)??0)+amount-reversed;
  const invoice=rowById.get(row.financial_invoice_id);
  if(!invoice||!Number.isSafeInteger(n)||n<0||n>(exactInteger(invoice.total_cents)??-1)){settlementValid=false;break;}
  net.set(row.financial_invoice_id,n);
 }
 if(!settlementValid)settlementMissing.push("settlementEvidenceUnavailable");
 else for(const claim of all){
  const earlier=rows.some(r=>r.supplier_id===claim.supplierId&&r.invoice_reference===claim.invoiceReference&&
   r.id!==claim.invoiceId&&(net.get(r.id)??0)>0);
  if(earlier){claim.paymentStatus="revision_review";settlementMissing.push("priorInvoiceRevisionSettlementUnresolved");continue;}
  const allocated=net.get(claim.invoiceId)??0;
  claim.documentedAllocatedCents=allocated;
  claim.uncoveredRecordedClaimCents=claim.recordedClaimCents-allocated;
  claim.paymentStatus=allocated===0?"unknown":allocated===claim.recordedClaimCents?"documented_covered":"documented_partial";
 }
 // Put unresolved/current work before settled history, then use the stable
 // due-date/ID order. Select the page after computing payment evidence.
 all.sort((a,b)=>Number(a.paymentStatus==="documented_covered")-Number(b.paymentStatus==="documented_covered")||
  (a.dueOn??"").localeCompare(b.dueOn??"")||a.invoiceId.localeCompare(b.invoiceId));
 const page=all.slice(claimOffset,claimOffset+20);
 const pageIdentities=new Set(page.map(c=>JSON.stringify([c.supplierId,c.invoiceReference])));
 const linkDetails=settlementValid?[...links.entries()].filter(([,v])=>{
  const row=rowById.get(v.row.financial_invoice_id);
  return v.amount>v.reversed&&row&&pageIdentities.has(JSON.stringify([row.supplier_id,row.invoice_reference]));
 }).sort(([a],[b])=>a.localeCompare(b)).slice(0,20).map(([eventId,v])=>({
  eventId,invoiceId:v.row.financial_invoice_id,uploadId:v.row.financial_upload_id,
  rowIndex:exactInteger(v.row.financial_row_index),transactionDate:v.row.financial_tx_date,
  linkedCents:v.amount,documentedRemainingCents:v.amount-v.reversed})):[];
 for(const claim of all){
  const total=(totals.get(claim.currency)??0)+claim.recordedClaimCents;
  if(!Number.isSafeInteger(total))return unavailable("supplier_invoice_total_out_of_range");
  totals.set(claim.currency,total);
 }
 return {coverage:"recorded_claims_only" as const,missing:[...new Set([...settlementMissing,"allObligationsCoverageUnknown","unrecordedPaymentCoverageUnknown",...(settlementValid?[]:["settlementEvidenceMissing"])])],documentedSettlementLinks:linkDetails,
   recordedClaimCount:all.length,claims:page,claimDetailsTruncated:page.length<all.length,
   claimNextOffset:claimOffset+20<all.length?claimOffset+20:null,
   recordedClaimTotalsByCurrency:[...totals].sort(([a],[b])=>a.localeCompare(b))
      .map(([currency,recordedClaimCents])=>({currency,recordedClaimCents})),
   outstandingPaymentCents:null,settledPaymentCents:null};
}

export type StatementBalanceRow={
 id:string;financial_account_key:string;financial_currency:string;financial_from:string;
 financial_to:string;financial_closing_cents:number|string;financial_source_sha256:string;
};
type DocumentedBalance={uploadId:string;accountKey:string;currency:string;from:string;asOf:string;
 closingCents:number;source:"owner_confirmed_statement";freshness:"dated_not_live"};
/** Select one latest statement per account, never sum snapshots or currencies.
 * A conflicting latest period or unknown account coverage is explicitly unresolved. */
export function summarizeStatementBalances(rows:readonly StatementBalanceRow[],asOf:string,truncated:boolean){
 const unavailable=(reason:string)=>({documentedAccountBalances:[] as DocumentedBalance[],
  statementCoverage:"incomplete" as const,statementMissing:[reason,"bankAccountCoverageUnknown"]});
 if(truncated||!validDate(asOf))return unavailable("statementHistoryIncomplete");
 const latest=new Map<string,DocumentedBalance>(), conflicts=new Set<string>();
 const keysByHash=new Map<string,string>();
 for(const r of [...rows].sort((a,b)=>String(b.financial_to).localeCompare(String(a.financial_to)))){
  const n=r.financial_closing_cents;
  const amount=typeof n==="number"?n:typeof n==="string"&&/^-?\d+$/.test(n)?Number(n):NaN;
  if(!r.id||!validDate(r.financial_from)||!validDate(r.financial_to)||r.financial_from>r.financial_to||
   !/^[0-9a-f]{64}$/.test(r.financial_account_key)||!/^[0-9a-f]{64}$/.test(r.financial_source_sha256)||
   !/^[A-Z]{3}$/.test(r.financial_currency)||!Number.isSafeInteger(amount))return unavailable("statementEvidenceInvalid");
  if(r.financial_to>asOf)continue;
  const key=r.financial_account_key;
  const previous=keysByHash.get(r.financial_source_sha256);
  if(previous&&previous!==key){conflicts.add(previous);conflicts.add(key);}
  keysByHash.set(r.financial_source_sha256,key);
  const old=latest.get(key);
  if(old){
   if(old.currency!==r.financial_currency||(old.asOf===r.financial_to&&old.closingCents!==amount))conflicts.add(key);
   continue;
  }
  latest.set(key,{uploadId:r.id,accountKey:key,currency:r.financial_currency,from:r.financial_from,
   asOf:r.financial_to,closingCents:amount,source:"owner_confirmed_statement",freshness:"dated_not_live"});
 }
 const balances=[...latest.entries()].filter(([key])=>!conflicts.has(key)).map(([,v])=>v);
 return {documentedAccountBalances:balances.slice(0,20),statementCoverage:"recorded_accounts_only" as const,
  statementMissing:["bankAccountCoverageUnknown",...(conflicts.size?["statementBalanceConflict"]:[]),
   ...(balances.length>20?["statementAccountDetailsTruncated"]:[]),...(!balances.length?["statementEvidenceMissing"]:[])]};
}


export type RecurringObligationRow={id:string;label:string;amount_cents:number|string;frequency:string;due_day:number|null;
 is_estimate:boolean;active_from:string;active_to:string|null};
export function summarizeRecurringObligations(rows:readonly RecurringObligationRow[],asOf:string,truncated:boolean){
 const result:{recurringObligations:Array<{id:string;label:string;configuredAmountCents:number;frequency:string;dueDay:number|null;nextProjectedDueOn:string|null;estimated:boolean;paymentStatus:"unknown"}>;
 recurringMissing:string[]}={recurringObligations:[],recurringMissing:[]};
 if(truncated||!validDate(asOf)){result.recurringMissing.push("recurringObligationsUnavailable");return result;}
 for(const row of rows){
  const amount=exactInteger(row.amount_cents);
  if(amount===null||!validDate(row.active_from)||(row.active_to!==null&&!validDate(row.active_to))||
   !["monthly","weekly","quarterly","yearly"].includes(row.frequency)){
   result.recurringMissing.push("recurringObligationInvalid");continue;
  }
  if(row.active_to!==null&&row.active_to<asOf)continue;
  let due:string|null=null;
  // Only monthly due_day has an unambiguous next calendar occurrence.
  // Never assume the last day for a missing 29/30/31 date or invent a quarterly phase.
  if(row.frequency==="monthly"&&Number.isInteger(row.due_day)&&row.due_day!>=1&&row.due_day!<=31){
   const start=row.active_from>asOf?row.active_from:asOf;
   const d=new Date(start.slice(0,7)+"-01T12:00:00Z");
   for(let m=0;m<3;m++){
    const candidate=d.toISOString().slice(0,7)+"-"+String(row.due_day).padStart(2,"0");
    if(validDate(candidate)&&candidate>=start&&(row.active_to===null||candidate<=row.active_to)){due=candidate;break;}
    d.setUTCMonth(d.getUTCMonth()+1);
   }
  }
  if(due===null)result.recurringMissing.push("recurringDueDateUnknown");
  result.recurringObligations.push({id:row.id,label:row.label.slice(0,140),configuredAmountCents:amount,
   frequency:row.frequency,dueDay:row.due_day,nextProjectedDueOn:due,estimated:row.is_estimate,paymentStatus:"unknown"});
 }
 result.recurringObligations.sort((a,b)=>(a.nextProjectedDueOn??"9999").localeCompare(b.nextProjectedDueOn??"9999")||a.id.localeCompare(b.id));
 if(result.recurringObligations.length>20){result.recurringObligations=result.recurringObligations.slice(0,20);result.recurringMissing.push("recurringObligationDetailsTruncated");}
 result.recurringMissing=[...new Set(result.recurringMissing)];
 return result;
}

export type StatementTransaction={i:number;date:string;amountCents:number;balanceCents:number};
export function statementTransactions(value:unknown):StatementTransaction[]|null{
 if(!Array.isArray(value)||value.length<2||value.length>10000)return null;
 const rows:StatementTransaction[]=[],indices=new Set<number>(),tuples=new Set<string>();
 for(const r of value){
  if(!r||typeof r!=="object"||!Number.isSafeInteger(r.i)||r.i<0||r.i>=value.length||indices.has(r.i)||
   !validDate(r.date)||!Number.isSafeInteger(r.amountCents)||!Number.isSafeInteger(r.balanceCents))return null;
  const k=JSON.stringify([r.date,r.amountCents,r.balanceCents]);
  if(tuples.has(k)&&r.amountCents!==0)return null;
  tuples.add(k);indices.add(r.i);rows.push({i:r.i,date:r.date,amountCents:r.amountCents,balanceCents:r.balanceCents});
 }
 return rows;
}

export type BillClaimRow={id:string;financial_bill_payee:string;financial_bill_reference:string;
 financial_bill_revision:number|string;financial_bill_issued_on:string;financial_bill_due_on:string|null;
 financial_bill_amount_cents:number|string;financial_currency:string};
export function summarizeBillClaims(rows:readonly BillClaimRow[],asOf:string,truncated:boolean){
 type Bill={uploadId:string;payee:string;reference:string;revision:number;issuedOn:string;dueOn:string|null;
  recordedClaimCents:number;currency:string;paymentStatus:"unknown"};
 const unavailable=()=>({billClaimCount:null,billClaims:[] as Bill[],billClaimDetailsTruncated:false,billClaimMissing:["datedBillEvidenceUnavailable"]});
 if(truncated||!validDate(asOf))return unavailable();
 const latest=new Map<string,Bill>();
 for(const r of rows){
  const amount=exactInteger(r.financial_bill_amount_cents),revision=exactInteger(r.financial_bill_revision);
  if(!r.id||!r.financial_bill_payee||!r.financial_bill_reference||!revision||!amount||!validDate(r.financial_bill_issued_on)
   ||(r.financial_bill_due_on!==null&&(!validDate(r.financial_bill_due_on)||r.financial_bill_due_on<r.financial_bill_issued_on))
   ||!/^[A-Z]{3}$/.test(r.financial_currency))return unavailable();
  if(r.financial_bill_issued_on>asOf)continue;
  const key=JSON.stringify([r.financial_bill_payee.toLowerCase(),r.financial_bill_reference]),old=latest.get(key);
  if(old&&(old.currency!==r.financial_currency||old.revision===revision))return unavailable();
  if(old&&old.revision>revision)continue;
  latest.set(key,{uploadId:r.id,payee:r.financial_bill_payee,reference:r.financial_bill_reference,revision,
   issuedOn:r.financial_bill_issued_on,dueOn:r.financial_bill_due_on,recordedClaimCents:amount,currency:r.financial_currency,paymentStatus:"unknown"});
 }
 const all=[...latest.values()].sort((a,b)=>(a.dueOn??"9999").localeCompare(b.dueOn??"9999")||a.uploadId.localeCompare(b.uploadId));
 return {billClaimCount:all.length,billClaims:all.slice(0,20),billClaimDetailsTruncated:all.length>20,
  billClaimMissing:["nonSupplierBillPaymentCoverageUnknown",...(all.length>20?["datedBillDetailsTruncated"]:[])]};
}

/** A deliberately conditional stress test, never a prediction of present cash.
 * Compare individually with distinct source classes: bill claims and recurring
 * configuration can describe the same cost. Do not sum these scenarios or accounts.
 */
export function historicalCashStress(asOf:string,horizonDays:number,
 cash:ReturnType<typeof summarizeStatementBalances>,invoices:ReturnType<typeof summarizeInvoiceClaims>,
 bills:ReturnType<typeof summarizeBillClaims>,recurring:ReturnType<typeof summarizeRecurringObligations>){
 if(!validDate(asOf)||!Number.isInteger(horizonDays)||horizonDays<1||horizonDays>90)return [];
 const end=new Date(asOf+"T12:00:00Z");end.setUTCDate(end.getUTCDate()+horizonDays);
 const through=end.toISOString().slice(0,10);
 const results:Array<{uploadId:string;currency:string;balanceAsOf:string;through:string;startDocumentedCents:number;
  sourceClass:"supplier_claims"|"dated_bill_claims"|"recurring_configuration";conditionalExposureCents:number;
  conditionalRemainingCents:number;conditionalShortfallCents:number;assumptions:string[]}>=[];
 for(const balance of cash.documentedAccountBalances){
  const sources=[
   {kind:"supplier_claims" as const,complete:invoices.recordedClaimCount!==null&&!invoices.claimDetailsTruncated,
    rows:invoices.claims.filter(c=>c.currency===balance.currency&&c.dueOn!==null&&c.dueOn<=through&&c.paymentStatus!=="documented_covered")
     .map(c=>c.uncoveredRecordedClaimCents??c.recordedClaimCents)},
   {kind:"dated_bill_claims" as const,complete:bills.billClaimCount!==null&&!bills.billClaimDetailsTruncated,
    rows:bills.billClaims.filter(c=>c.currency===balance.currency&&c.dueOn!==null&&c.dueOn<=through).map(c=>c.recordedClaimCents)},
  ];
  for(const s of sources){
   if(!s.complete||!s.rows.length)continue;
   const exposure=s.rows.reduce((a,b)=>a+BigInt(b),BigInt(0)),remaining=BigInt(balance.closingCents)-exposure;
   if(exposure>BigInt(Number.MAX_SAFE_INTEGER)||remaining<BigInt(Number.MIN_SAFE_INTEGER))continue;
   results.push({uploadId:balance.uploadId,currency:balance.currency,balanceAsOf:balance.asOf,through,
    startDocumentedCents:balance.closingCents,sourceClass:s.kind,conditionalExposureCents:Number(exposure),
    conditionalRemainingCents:Number(remaining),conditionalShortfallCents:remaining<BigInt(0)?Number(-remaining):0,
    assumptions:["if historical balance remained unchanged","if listed amounts still require cash settlement from this account",
     "no additional deposits or other outflows assumed","undated obligations excluded","separate scenarios may overlap; do not sum",
     "account and payment coverage unknown"]});
  }
  // No currency is stored per recurring cost: without the café currency binding,
  // recurring amounts remain separately available, not included in any scenario.
 }
 void recurring;
 return results;
}
