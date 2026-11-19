import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {simulationOwnerReader} from "@/lib/ai/supervisor/loop/simulationOwner.server";
import {summarizeInvoiceClaims,type InvoiceClaimRow} from "@/lib/metrics/core/cashflow";

/** New cross-order financial view of the existing restricted invoice evidence.
 * Only an authenticated owner scope can supply the IDs. Never expose bank
 * credentials, source document text or financial mutation authority. */
export async function readFinancialEvidence(scope:{businessId:string;ownerUserId:string;
 verifiedReadClient?:SupabaseClient},asOf:string){
 const {client}=await simulationOwnerReader(scope);
 const limit=500;
 const result=await client.from("supplier_invoices")
  .select("id,supplier_id,purchase_order_id,invoice_reference,revision,issued_on,due_on,currency_code,total_cents")
  .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
  .order("revision",{ascending:false}).order("id").limit(limit+1);
 if(result.error)throw new Error("supplier_invoice_evidence_unavailable");
 // Repeat authorization after the read, before returning owner-private facts.
 await simulationOwnerReader({...scope,verifiedReadClient:client});
 const rows=(result.data??[]) as InvoiceClaimRow[];
 return summarizeInvoiceClaims(rows,asOf,rows.length>limit);
}
