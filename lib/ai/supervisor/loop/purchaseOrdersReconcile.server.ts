import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {OwnerLoopScope} from "./engine";
import {SupervisorEffectGateway} from "./effectGateway.server";
import {supplierPurchaseOrderCapabilityId} from "./purchaseOrders.server";

type ScopedRecovery=Pick<SupervisorEffectGateway,"reconcileSupplierPurchaseOrder">;
type PendingRow={id:string;business_id:string;owner_user_id:string;thread_id:string;
 revision:number;locale:OwnerLoopScope["locale"];status:string;updated_at:string};
export type PurchaseOrderRecovery={checked:number;verified:number;uncertain:number;failed:number};

/** The existing 15-minute Supervisor worker recovers a lost HTTP response by
 * checking only durable PO receipts. It NEVER calls commit again or sends a
 * supplier order. Failed/uncertain rows rotate in the same existing queue
 * rather than starving other cafés. */
export async function reconcilePendingSupplierPurchaseOrders(
 db:SupabaseClient,gateway:ScopedRecovery=new SupervisorEffectGateway(),
 now:Date=new Date()
):Promise<PurchaseOrderRecovery>{
 const cutoff=new Date(now.getTime()-5*60_000).toISOString();
 const read=await db.from("supervisor_proposals")
  .select("id,business_id,owner_user_id,thread_id,revision,locale,status,updated_at")
  .eq("capability_id",supplierPurchaseOrderCapabilityId)
  .eq("status","executing")
  .lte("updated_at",cutoff)
  .order("monitor_checked_at",{ascending:true,nullsFirst:true})
  .order("id",{ascending:true}).limit(25);
 if(read.error)throw new Error("supplier_po_reconciliation_queue_unavailable");
 const result:PurchaseOrderRecovery={checked:(read.data??[]).length,verified:0,uncertain:0,failed:0};
 for(const row of (read.data??[]) as PendingRow[]){
  const scope:OwnerLoopScope={businessId:row.business_id,
    ownerUserId:row.owner_user_id,threadId:row.thread_id,locale:row.locale};
  try{
   const reconciled=await gateway.reconcileSupplierPurchaseOrder(scope,row.id,row.revision);
   if(reconciled.status==="committed")result.verified++;
   else result.uncertain++;
  }catch{
   result.failed++;
  }finally{
   // A missing receipt is NOT authorization to retry the supplier PO effect.
   // Cursor rotation gives new and other café attempts a bounded opportunity.
   const rotated=await db.from("supervisor_proposals")
    .update({monitor_checked_at:now.toISOString()})
    .eq("business_id",row.business_id).eq("owner_user_id",row.owner_user_id)
    .eq("id",row.id).eq("revision",row.revision).eq("status","executing");
   if(rotated.error)result.failed++;
  }
 }
 return result;
}
