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
 paymentStatus:"unknown";
};
export function summarizeInvoiceClaims(rows:readonly InvoiceClaimRow[],asOf:string,truncated:boolean){
 const unavailable=(reason:string)=>({coverage:"incomplete" as const,missing:[reason],
   recordedClaimCount:null,claims:[] as Claim[],claimDetailsTruncated:false,
   recordedClaimTotalsByCurrency:[] as {currency:string;recordedClaimCents:number}[],
   outstandingPaymentCents:null,settledPaymentCents:null});
 if(truncated)return unavailable("supplier_invoice_history_truncated");
 if(!validDate(asOf))return unavailable("cafe_date_unavailable");
 const latest=new Map<string,Claim>();
 for(const row of rows){
  const revision=exactInteger(row.revision),total=exactInteger(row.total_cents);
  if(!row.id||!row.supplier_id||!row.invoice_reference||!revision||total===null||
   !/^[A-Z]{3}$/.test(row.currency_code)||!validDate(row.issued_on)||
   (row.due_on!==null&&!validDate(row.due_on)))return unavailable("supplier_invoice_evidence_invalid");
  const key=JSON.stringify([row.supplier_id,row.invoice_reference]);
  const old=latest.get(key);
  if(old&&(old.purchaseOrderId!==row.purchase_order_id||old.currency!==row.currency_code||
     old.revision===revision))return unavailable("supplier_invoice_identity_ambiguous");
  if(old&&old.revision>revision)continue;
  latest.set(key,{invoiceId:row.id,supplierId:row.supplier_id,purchaseOrderId:row.purchase_order_id,
   invoiceReference:row.invoice_reference,revision,issuedOn:row.issued_on,dueOn:row.due_on,
   currency:row.currency_code,recordedClaimCents:total,paymentStatus:"unknown",
   dueDatePosition:row.due_on===null?"undated":row.due_on<asOf?"before_as_of":
     row.due_on===asOf?"on_as_of":"after_as_of"});
 }
 const all=[...latest.values()].sort((a,b)=>
  (a.dueOn??"").localeCompare(b.dueOn??"")||a.invoiceId.localeCompare(b.invoiceId));
 const totals=new Map<string,number>();
 for(const claim of all){
  const total=(totals.get(claim.currency)??0)+claim.recordedClaimCents;
  if(!Number.isSafeInteger(total))return unavailable("supplier_invoice_total_out_of_range");
  totals.set(claim.currency,total);
 }
 return {coverage:"recorded_claims_only" as const,missing:["settlementEvidenceMissing","allObligationsCoverageUnknown"],
   recordedClaimCount:all.length,claims:all.slice(0,20),claimDetailsTruncated:all.length>20,
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
   ...(balances.length>20?["statementAccountDetailsTruncated"]:[]),...(!rows.length?["statementEvidenceMissing"]:[])]};
}
