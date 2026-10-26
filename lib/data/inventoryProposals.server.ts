import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";

/** IDs only; approvals still go through the original scoped proposal endpoint. */
export async function readPendingInventoryProposals():Promise<Array<{id:string;threadId:string}>>{
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)throw new Error("sign_in_required");
 const businessId=await getActiveBusinessId(user.id);
 const {data:membership,error}=await db.from("memberships").select("role,businesses(is_demo)")
  .eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
 const raw=membership?.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
 if(error||membership?.role!=="owner"||
  (Array.isArray(raw)?raw[0]?.is_demo:raw?.is_demo)!==false)throw new Error("owner_required");
 const {data,error:readError}=await createAdminSupabaseClient()
  .from("supervisor_proposals").select("id,thread_id")
  .eq("business_id",businessId).eq("owner_user_id",user.id)
  .eq("capability_id","maya.inventory_purchase.v1")
  .in("status",["draft","approved","executing"])
  .order("created_at",{ascending:false}).limit(100);
 if(readError||!data)throw new Error("inventory_proposals_unavailable");
 return data.map(row=>({id:row.id,threadId:row.thread_id}));
}
