import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {GUID} from "./client";
import {z} from "zod";

/** Credentials are managed only by owners. Service-role is obtained after session authorization. */
export async function authorizeToastOwner(businessId:string) {
  if(!GUID.safeParse(businessId).success)return null;
  const client=await createServerSupabaseClient();
  const {data:{user},error:authError}=await client.auth.getUser();
  if(authError||!user)return null;
  const {data:member,error}=await client.from("memberships").select("role")
    .eq("business_id",businessId).eq("user_id",user.id).eq("role","owner").maybeSingle();
  if(error||!member)return null;
  const {data:business,error:businessError}=await client.from("businesses")
    .select("is_demo").eq("id",businessId).single();
  if(businessError||!business||business.is_demo)return null;
  return createAdminSupabaseClient();
}
export const setupSchema=z.object({
  businessId:GUID,
  apiUrl:z.string().min(1).max(250),
  clientId:z.string().min(1).max(500),
  clientSecret:z.string().min(1).max(5000),
  locations:z.array(z.object({location_id:GUID,restaurant_guid:GUID})).min(1).max(50),
}).strict();
