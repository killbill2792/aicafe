import {z} from "zod";
import {authenticatedConversationContext,ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {pushAvailable,pushDeviceHash,sealPushSubscription,validatePushSubscription} from "@/lib/ai/supervisor/routines/push.server";
export const runtime="nodejs";export const dynamic="force-dynamic";
const endpoint=z.string().url().max(2048);
const subscription=z.strictObject({
  endpoint,
  keys:z.strictObject({p256dh:z.string().min(40).max(200),auth:z.string().min(12).max(100)}),
  // PushSubscription.toJSON() commonly includes this null browser field.
  expirationTime:z.number().nullable().optional(),
});
const register=z.strictObject({consent:z.literal(true),subscription});
const check=z.strictObject({checkEndpoint:endpoint});
const revoke=z.union([z.strictObject({all:z.literal(true)}),
  z.strictObject({endpoint})]);
function ensureReady(){
  if(!pushAvailable())throw new ConversationApiError(503,"push_disabled");
}
export async function GET(){
  try{
    const {scope}=await authenticatedConversationContext();
    if(!pushAvailable())return conversationJson({available:false,subscribed:false,publicKey:null});
    const db=createAdminSupabaseClient();
    // Consent is per browser and café, not "any of this owner's devices".
    // The browser separately looks up its own endpoint with POST.
    void scope;
    return conversationJson({available:true,subscribed:false,
      publicKey:process.env.SUPERVISOR_PUSH_VAPID_PUBLIC_KEY??null});
  }catch(error){return conversationError(error);}
}
export async function POST(request:Request){
  try{
    requireSameOrigin(request);ensureReady();
    const body=await readBoundedJson(request);
    const {scope}=await authenticatedConversationContext();
    const db=createAdminSupabaseClient();
    if(body&&typeof body==="object"&&!Array.isArray(body)&&
      "checkEndpoint" in body){
      const {checkEndpoint}=parseInput(check,body);
      const {data,error}=await db.from("u4_push_subscriptions")
        .select("device_hash").eq("business_id",scope.businessId)
        .eq("owner_user_id",scope.ownerUserId)
        .eq("device_hash",pushDeviceHash(checkEndpoint))
        .is("revoked_at",null).maybeSingle();
      if(error)throw error;
      return conversationJson({available:true,subscribed:!!data});
    }
    const {consent,subscription:raw}=parseInput(register,body);
    if(consent!==true)throw new ConversationApiError(422,"push_consent_required");
    const sub=validatePushSubscription(raw);
    const hash=pushDeviceHash(sub.endpoint);
    const {data,error}=await db.from("u4_push_subscriptions")
      .select("device_hash").eq("business_id",scope.businessId)
      .eq("owner_user_id",scope.ownerUserId).is("revoked_at",null).limit(4);
    if(error)throw error;
    if((data??[]).length>=3&&!(data??[]).some(row=>row.device_hash===hash))
      throw new ConversationApiError(422,"push_device_limit");
    const now=new Date().toISOString();
    const result=await db.from("u4_push_subscriptions").upsert({
      business_id:scope.businessId,owner_user_id:scope.ownerUserId,
      device_hash:hash,sealed_subscription:sealPushSubscription(sub),
      consent_at:now,revoked_at:null,updated_at:now,
    },{onConflict:"business_id,owner_user_id,device_hash"});
    if(result.error)throw result.error;
    return conversationJson({available:true,subscribed:true});
  }catch(error){return conversationError(error);}
}
export async function DELETE(request:Request){
  try{
    requireSameOrigin(request);
    const selection=parseInput(revoke,await readBoundedJson(request));
    // Sign-out revokes every café on every device; a device-off action revokes
    // this endpoint for the owner across cafés, not another device.
    const client=await createServerSupabaseClient();
    const {data:{user},error:authError}=await client.auth.getUser();
    if(authError||!user)throw new ConversationApiError(401,"authentication_required");
    const db=createAdminSupabaseClient();
    let query=db.from("u4_push_subscriptions")
      .update({revoked_at:new Date().toISOString(),updated_at:new Date().toISOString()})
      .eq("owner_user_id",user.id).is("revoked_at",null);
    if("endpoint" in selection)query=query.eq("device_hash",pushDeviceHash(selection.endpoint));
    const {error}=await query;
    if(error)throw error;
    return conversationJson({available:pushAvailable(),subscribed:false});
  }catch(error){return conversationError(error);}
}
