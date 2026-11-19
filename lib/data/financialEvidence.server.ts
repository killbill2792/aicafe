import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {simulationOwnerReader} from "@/lib/ai/supervisor/loop/simulationOwner.server";
import {summarizeInvoiceClaims,summarizeStatementBalances,summarizeRecurringObligations,summarizeBillClaims,historicalCashStress,statementTransactions,
 type InvoiceClaimRow,type StatementBalanceRow,type SettlementEvidenceRow,type RecurringObligationRow,type BillClaimRow} from "@/lib/metrics/core/cashflow";

type Scope={businessId:string;ownerUserId:string;verifiedReadClient?:SupabaseClient};
export type FinanceSelection={statementUploadId?:string|null;rowOffset?:number|null;horizonDays?:number|null;invoiceOffset?:number|null;invoiceReference?:string|null};
export async function readFinancialStatement(scope:Scope,uploadId:string){
 const {client}=await simulationOwnerReader(scope);
 const {data,error}=await client.from("uploads").select("id,financial_source_sha256,financial_account_key,financial_currency,financial_transactions,financial_to")
  .eq("business_id",scope.businessId).eq("financial_owner_user_id",scope.ownerUserId)
  .eq("kind","statement").eq("status","done").eq("id",uploadId).maybeSingle();
 await simulationOwnerReader(scope);
 const transactions=statementTransactions(data?.financial_transactions);
 if(error||!data||!transactions||typeof data.financial_source_sha256!=="string"||
   typeof data.financial_account_key!=="string"||typeof data.financial_currency!=="string")
  throw new Error("statement_source_unavailable");
 return {uploadId:data.id,sourceHash:data.financial_source_sha256,accountKey:data.financial_account_key,
  currency:data.financial_currency,asOf:data.financial_to,transactions};
}

/** Independent authorized reads: one unavailable source cannot hide the other. */
export async function readFinancialEvidence(scope:Scope,asOf:string,selection:FinanceSelection={}){
 const {client}=await simulationOwnerReader(scope);
 const limit=500;
 const invoiceReferenceFilter=selection.invoiceReference?.trim().toLowerCase()||null;
 let invoiceQuery=client.from("supplier_invoices").select("id,supplier_id,purchase_order_id,invoice_reference,revision,issued_on,due_on,currency_code,total_cents")
  .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId);
 if(invoiceReferenceFilter)invoiceQuery=invoiceQuery.eq("invoice_reference",invoiceReferenceFilter);
 const invoiceRead=Promise.resolve(invoiceQuery.order("revision",{ascending:false}).order("id").limit(limit+1));
 const eventQuery=()=>client.from("purchase_reconciliation_events").select("id,financial_invoice_id,financial_kind,financial_allocation_cents,financial_reverses_id,financial_tx_date,source_revision,financial_upload_id,financial_row_index")
  .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
  .in("financial_kind",["settlement_evidence_linked","settlement_evidence_reversed"]);
 const scopedEvents=async()=>{
  const result=await invoiceRead;
  if(result.error||!result.data||result.data.length>limit)throw Error("supplier_invoice_history_incomplete");
  const ids=result.data.map(r=>r.id);
  // Bound URL length and total rows; never interpret incomplete allocation
  // history as zero. Include every prior revision of the selected reference.
  const entries:unknown[]=[];
  for(let i=0;i<ids.length;i+=50){
   const page=await eventQuery().in("financial_invoice_id",ids.slice(i,i+50)).order("id").limit(limit+1);
   if(page.error||!page.data)throw Error("supplier_invoice_settlement_unavailable");
   entries.push(...page.data);
   if(entries.length>limit)throw Error("supplier_invoice_settlement_truncated");
  }
  return {data:entries,error:null};
 };
 const [invoices,statements,events,bills,datedBills]=await Promise.allSettled([
  invoiceRead,
  client.from("uploads").select("id,financial_account_key,financial_currency,financial_from,financial_to,financial_closing_cents,financial_source_sha256")
   .eq("business_id",scope.businessId).eq("financial_owner_user_id",scope.ownerUserId)
   .eq("kind","statement").eq("status","done").order("financial_to",{ascending:false}).order("id").limit(limit+1),
  invoiceReferenceFilter?scopedEvents():eventQuery().order("id").limit(limit+1),
  client.from("recurring_costs").select("id,label,amount_cents,frequency,due_day,is_estimate,active_from,active_to")
   .eq("business_id",scope.businessId).order("id").limit(limit+1),
  client.from("uploads").select("id,financial_bill_payee,financial_bill_reference,financial_bill_revision,financial_bill_issued_on,financial_bill_due_on,financial_bill_amount_cents,financial_currency")
   .eq("business_id",scope.businessId).eq("financial_owner_user_id",scope.ownerUserId).eq("kind","bill_claim")
   .eq("status","done").order("financial_bill_revision",{ascending:false}).order("id").limit(limit+1)
 ]);
 let selectedStatement:null|{uploadId:string;currency:string;asOf:string;rows:{i:number;date:string;amountCents:number;balanceCents:number}[];rowCount:number;nextRowOffset:number|null}=null;
 const selectedMissing:string[]=[];
 if(selection.statementUploadId){
  try{
   const source=await readFinancialStatement(scope,selection.statementUploadId);
   const offset=selection.rowOffset??0,rows=[...source.transactions].sort((a,b)=>a.i-b.i);
   selectedStatement={uploadId:source.uploadId,currency:source.currency,asOf:source.asOf,
    rows:rows.slice(offset,offset+25),rowCount:rows.length,nextRowOffset:offset+25<rows.length?offset+25:null};
  }catch{selectedMissing.push("selectedStatementUnavailable");}
 }
 await simulationOwnerReader(scope);
 const invoiceOk=invoices.status==="fulfilled"&&!invoices.value.error;
 const statementOk=statements.status==="fulfilled"&&!statements.value.error;
 const eventsOk=events.status==="fulfilled"&&!events.value.error;
 const billsOk=bills.status==="fulfilled"&&!bills.value.error;
 const rows=(invoiceOk?invoices.value.data??[]:[]) as InvoiceClaimRow[];
 const balances=(statementOk?statements.value.data??[]:[]) as StatementBalanceRow[];
 const entries=(eventsOk?events.value.data??[]:[]) as SettlementEvidenceRow[];
 const configured=(billsOk?bills.value.data??[]:[]) as RecurringObligationRow[];
 const claims=summarizeInvoiceClaims(rows,asOf,!invoiceOk||rows.length>limit,eventsOk&&entries.length<=limit?entries:null,selection.invoiceOffset??0);
 const cash=summarizeStatementBalances(balances,asOf,!statementOk||balances.length>limit);
 const recurring=summarizeRecurringObligations(configured,asOf,!billsOk||configured.length>limit);
 const datedOk=datedBills.status==="fulfilled"&&!datedBills.value.error;
 const dated=(datedOk?datedBills.value.data??[]:[]) as BillClaimRow[];
 const billClaims=summarizeBillClaims(dated,asOf,!datedOk||dated.length>limit);
 // Filtered or paginated detail is not whole-café projected exposure.
 const conditionalStress=historicalCashStress(asOf,selection.horizonDays??30,cash,
  {...claims,claimDetailsTruncated:claims.claimDetailsTruncated||invoiceReferenceFilter!==null||(selection.invoiceOffset??0)>0},billClaims,recurring);
 return {...claims,...cash,...recurring,...billClaims,invoiceReferenceFilter,selectedStatement,conditionalStress,
  missing:[...(invoiceOk?claims.missing:["supplierInvoiceEvidenceUnavailable"]),
  ...cash.statementMissing,...recurring.recurringMissing,...billClaims.billClaimMissing,...selectedMissing,...(statementOk?[]:["statementEvidenceUnavailable"])]};
}
