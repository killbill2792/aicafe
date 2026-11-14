import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";

/** Look up a new immutable revision by its scoped ancestry; only the API
 * after authenticating the owner is allowed to invoke this reader. */
export async function latestEditedProposalId(
  scope:{businessId:string;ownerUserId:string;threadId:string},proposalId:string,
  capabilityId?:string
):Promise<string|null>{
  const db=createAdminSupabaseClient();
  if(capabilityId==="maya.supplier_purchase_order.v1"){
    // PO correction provenance is in a separate immutable scoped ledger:
    // supervisor_proposals.baseline itself is immutable by database trigger.
    const {data:link,error:linkError}=await db.from("supplier_po_draft_replacements")
      .select("replacement_id").eq("business_id",scope.businessId)
      .eq("owner_user_id",scope.ownerUserId)
      .eq("previous_id",proposalId).maybeSingle();
    if(linkError)throw new Error("Purchase-order replacement unavailable");
    return link?.replacement_id??null;
  }
  const {data,error}=await db.from("supervisor_proposals").select("id")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("thread_id",scope.threadId).contains("baseline",{editedFrom:proposalId})
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(error)throw new Error("Edited proposal unavailable");
  return data?.id??null;
}
