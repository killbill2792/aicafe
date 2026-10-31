import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import type {OwnerLoopScope} from "./engine";

/** Only the inert simulate path may use this explicitly verified read client.
 * The eventual approval/commit routes never receive it. */
export async function simulationOwnerReader(scope:Pick<OwnerLoopScope,"businessId"|"ownerUserId"|"verifiedReadClient">){
 const explicit=Boolean(scope.verifiedReadClient);
 const client=scope.verifiedReadClient??await createServerSupabaseClient();
 if(!explicit){
   const {data:{user},error}=await client.auth.getUser();
   if(error||!user||user.id!==scope.ownerUserId||await getActiveBusinessId(user.id)!==scope.businessId)
     throw new Error("owner_required");
 }
 const [{data:membership,error:membershipError},{data:business,error:businessError}]=await Promise.all([
   client.from("memberships").select("role").eq("business_id",scope.businessId)
     .eq("user_id",scope.ownerUserId).maybeSingle(),
   client.from("businesses").select("is_demo").eq("id",scope.businessId).maybeSingle(),
 ]);
 if(membershipError||businessError||membership?.role!=="owner"||!business||business.is_demo)
   throw new Error("owner_required");
 return {client,explicit};
}
