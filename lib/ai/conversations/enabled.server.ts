import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {ConversationScope} from "./contracts";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authenticatedConversationContext, ConversationApiError } from "./auth.server";
import { supervisorChatConfigStatus, type SupervisorChatReadiness } from "./readiness";

/** Unlike the Phase 4 opt-in rollout, an absent flag no longer permanently
 * disables a fully installed chat. Setting it to "false" explicitly stops all
 * chat/attachment POSTs. Never enable if the secure reply writer is missing.
 */
export function isSupervisorChatConfigured(): boolean {
  return supervisorChatConfigStatus({
    configuredSupabase: isSupabaseConfigured(),
    serviceRolePresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    plannerKeyPresent: Boolean(process.env.OPENAI_API_KEY),
    featureFlag: process.env.SUPERVISOR_CHAT_ENABLED,
  }).enabled;
}

/** Home-only, owner-bound preflight. Fail closed without exposing credentials,
 * raw database errors, user records or the target café to the client.
 * This checks both the session's RLS SELECT and the reply writer's backend.
 */
export async function getSupervisorChatReadiness(signedIn: boolean): Promise<SupervisorChatReadiness> {
  if (!signedIn) return { enabled: false, reason: "owner_access_required" };
  const config = supervisorChatConfigStatus({
    configuredSupabase: isSupabaseConfigured(),
    serviceRolePresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    plannerKeyPresent: Boolean(process.env.OPENAI_API_KEY),
    featureFlag: process.env.SUPERVISOR_CHAT_ENABLED,
  });
  if (!config.enabled) return config;
  try {
    const { scope } = await authenticatedConversationContext();
    const session = await createServerSupabaseClient();
    const { error: threadError } = await session.from("ai_threads").select("id")
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId).limit(1);
    if (threadError) return { enabled: false, reason: "storage_unavailable" };
    const admin = createAdminSupabaseClient();
    const { error: writerError } = await admin.from("ai_messages").select("id")
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId).limit(1);
    if (writerError) return { enabled: false, reason: "storage_unavailable" };
    const { error: usageError } = await session.from("ai_usage_events").select("id")
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId).limit(1);
    if (usageError) return { enabled: false, reason: "storage_unavailable" };
    return { enabled: true, reason: null };
  } catch (error) {
    if (error instanceof ConversationApiError &&
      (error.status === 401 || error.status === 403)) {
      return { enabled: false, reason: "owner_access_required" };
    }
    return { enabled: false, reason: "storage_unavailable" };
  }
}

/** Same secured readiness checks without any cookie lookup. The caller must
 * have verified the signed/consented owner binding, current membership and
 * linked thread first (authorizedExternalConversation). A service-role client
 * cannot infer the active café; every read is scoped to the explicit owner. */
export async function getSupervisorChatReadinessForAuthorizedExternal(
 scope:ConversationScope,admin:SupabaseClient,
):Promise<SupervisorChatReadiness>{
 const config=supervisorChatConfigStatus({
   configuredSupabase:isSupabaseConfigured(),
   serviceRolePresent:Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
   plannerKeyPresent:Boolean(process.env.OPENAI_API_KEY),
   featureFlag:process.env.SUPERVISOR_CHAT_ENABLED,
 });
 if(!config.enabled)return config;
 if(!scope.businessId||!scope.ownerUserId)
   return {enabled:false,reason:"owner_access_required"};
 try{
   const [membership,threads,writer,usage]=await Promise.all([
     admin.from("memberships").select("role")
       .eq("business_id",scope.businessId).eq("user_id",scope.ownerUserId).maybeSingle(),
     admin.from("ai_threads").select("id")
       .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).limit(1),
     admin.from("ai_messages").select("id")
       .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).limit(1),
     admin.from("ai_usage_events").select("id")
       .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).limit(1),
   ]);
   if(membership.error||membership.data?.role!=="owner")
     return {enabled:false,reason:"owner_access_required"};
   if(threads.error||writer.error||usage.error)
     return {enabled:false,reason:"storage_unavailable"};
   return {enabled:true,reason:null};
 }catch{
   return {enabled:false,reason:"storage_unavailable"};
 }
}
