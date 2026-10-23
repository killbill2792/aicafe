import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";

/** Look up a new immutable revision by its scoped ancestry; only the API
 * after authenticating the owner is allowed to invoke this reader. */
export async function latestEditedProposalId(
  scope:{businessId:string;ownerUserId:string;threadId:string},proposalId:string
):Promise<string|null>{
  const db=createAdminSupabaseClient();
  const {data,error}=await db.from("supervisor_proposals").select("id")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("thread_id",scope.threadId).contains("baseline",{editedFrom:proposalId})
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(error)throw new Error("Edited proposal unavailable");
  return data?.id??null;
}
