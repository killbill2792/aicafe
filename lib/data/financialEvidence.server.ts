import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {simulationOwnerReader} from "@/lib/ai/supervisor/loop/simulationOwner.server";
import {summarizeInvoiceClaims,summarizeStatementBalances,type InvoiceClaimRow,type StatementBalanceRow} from "@/lib/metrics/core/cashflow";

/** Independent authorized reads: one unavailable source cannot hide the other. */
export async function readFinancialEvidence(scope:{businessId:string;ownerUserId:string;
 verifiedReadClient?:SupabaseClient},asOf:string){
 const {client}=await simulationOwnerReader(scope);
 const limit=500;
 const [invoices,statements]=await Promise.allSettled([
  client.from("supplier_invoices").select("id,supplier_id,purchase_order_id,invoice_reference,revision,issued_on,due_on,currency_code,total_cents")
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .order("revision",{ascending:false}).order("id").limit(limit+1),
  client.from("uploads").select("id,financial_account_key,financial_currency,financial_from,financial_to,financial_closing_cents,financial_source_sha256")
   .eq("business_id",scope.businessId).eq("financial_owner_user_id",scope.ownerUserId)
   .eq("kind","statement").eq("status","done").order("financial_to",{ascending:false}).order("id").limit(limit+1)
 ]);
 await simulationOwnerReader(scope);
 const invoiceOk=invoices.status==="fulfilled"&&!invoices.value.error;
 const statementOk=statements.status==="fulfilled"&&!statements.value.error;
 const rows=(invoiceOk?invoices.value.data??[]:[]) as InvoiceClaimRow[];
 const balances=(statementOk?statements.value.data??[]:[]) as StatementBalanceRow[];
 const claims=summarizeInvoiceClaims(rows,asOf,!invoiceOk||rows.length>limit);
 const cash=summarizeStatementBalances(balances,asOf,!statementOk||balances.length>limit);
 return {...claims,...cash,missing:[...(invoiceOk?claims.missing:["supplierInvoiceEvidenceUnavailable"]),
  ...cash.statementMissing,...(statementOk?[]:["statementEvidenceUnavailable"])]};
}
