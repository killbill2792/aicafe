import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {OwnerLoopScope} from "./engine";
import {SupervisorEffectGateway} from "./effectGateway.server";

type ScopedRecovery=Pick<SupervisorEffectGateway,"reconcileSupplierPurchaseOrder">;
type PendingRow={id:string;business_id:string;owner_user_id:string;thread_id:string;
 revision:number;locale:OwnerLoopScope["locale"]};
export type PurchaseOrderRecovery={checked:number;verified:number;uncertain:number;failed:number};

/** The existing Supervisor cron recovers uncertain PO outcomes from receipts
 * only. The global cursor lives on the original effect attempt ledger: the
 * supervisor_proposals immutable baseline and revision are never touched
 * merely to scan a queue, and no vendor effect can be resent here. */
export async function reconcilePendingSupplierPurchaseOrders(
 db:SupabaseClient,gateway:ScopedRecovery=new SupervisorEffectGateway(),
 now:Date=new Date()
):Promise<PurchaseOrderRecovery>{
 if(!Number.isFinite(now.getTime()))throw new Error("invalid_supplier_recovery_clock");
 const cutoff=new Date(now.getTime()-5*60_000).toISOString();
 const {data,error}=await db.rpc("supervisor_claim_supplier_po_recovery",{
  p_limit:25,p_cutoff:cutoff
 });
 if(error)throw new Error("supplier_po_reconciliation_queue_unavailable");
 const rows=(data??[]) as PendingRow[];
 const result:PurchaseOrderRecovery={checked:rows.length,verified:0,uncertain:0,failed:0};
 for(const row of rows){
  const scope:OwnerLoopScope={businessId:row.business_id,
   ownerUserId:row.owner_user_id,threadId:row.thread_id,locale:row.locale};
  try{
   const reconciled=await gateway.reconcileSupplierPurchaseOrder(scope,row.id,row.revision);
   if(reconciled.status==="committed")result.verified++;
   else result.uncertain++;
  }catch{
   result.failed++;
  }
 }
 return result;
}
