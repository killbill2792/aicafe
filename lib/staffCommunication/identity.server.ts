import "server-only";
import {cache} from "react";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";

/** Restrict linked employee accounts before the general owner onboarding
 * can create a new business through its service-role bootstrap path. This
 * check never accepts a café or worker ID from a browser. */
export const isLinkedStaffUser=cache(async function isLinkedStaffUser(userId:string):Promise<boolean>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId))
  throw new Error("staff_identity_invalid");
 const {data,error}=await createAdminSupabaseClient().from("employees")
  .select("id").eq("staff_auth_user_id",userId).limit(1);
 if(error||!data)throw new Error("staff_identity_unavailable");
 return data.length>0;
});
