import "server-only";
import {createHash} from "node:crypto";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {accessStatus,normalizeCode,validCode,type CafeAccess} from "@/lib/access/status";
export type OwnerAccess={businessId:string;userId:string;access:CafeAccess};
export async function getCafeAccess(businessId:string):Promise<CafeAccess>{
  const client=createAdminSupabaseClient();
  const [{data,error},{data:business,error:tzError}]=await Promise.all([
   client.from("cafe_access").select("mode,access_end").eq("business_id",businessId).maybeSingle(),
   client.from("businesses").select("timezone").eq("id",businessId).maybeSingle(),
  ]);
  if(tzError)throw tzError;
  // Only a not-yet-installed migration fails open; never turn outages into free access.
  if(error && !["42P01","PGRST205"].includes(error.code??"")) throw error;
  return accessStatus(data, new Date(),business?.timezone||"UTC");
}
export async function requireOwnerAccessScope():Promise<OwnerAccess>{
  const client=await createServerSupabaseClient();
  const {data:{user},error}=await client.auth.getUser();
  if(error||!user)throw new ConversationApiError(401,"authentication_required");
  const businessId=await getActiveBusinessId(user.id);
  const {data:membership,error:membershipError}=await client.from("memberships").select("role")
    .eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
  if(membershipError)throw membershipError;
  if(membership?.role!=="owner")throw new ConversationApiError(403,"owner_access_required");
  return {businessId,userId:user.id,access:await getCafeAccess(businessId)};
}
export async function assertCafeAiAccess(businessId:string):Promise<void>{
  if(!(await getCafeAccess(businessId)).active)throw new ConversationApiError(403,"access_expired");
}
export function accessCodeHash(raw:string):string{
  if(!validCode(raw))throw new ConversationApiError(422,"invalid_code");
  return createHash("sha256").update(normalizeCode(raw),"utf8").digest("hex");
}

/** A service-role RPC owns capacity, throttling, and admin-override locking. */
export async function redeemCafeFreeCode(businessId:string,ownerId:string,code:string):
 Promise<{status:string;access_end?:string}>{
 const {data,error}=await createAdminSupabaseClient().rpc("redeem_free_access_code",{
  p_business_id:businessId,
  p_code_hash:createHash("sha256").update(normalizeCode(code),"utf8").digest("hex"),
  p_owner_id:ownerId,
 });
 if(error)throw error;
 return data as {status:string;access_end?:string};
}
