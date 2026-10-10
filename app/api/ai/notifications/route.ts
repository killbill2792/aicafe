import {z} from "zod";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
export const runtime="nodejs";export const dynamic="force-dynamic";
const input=z.strictObject({optIn:z.boolean()});
export async function GET(){
 try{
  const {scope}=await authenticatedConversationContext();
  const db=await createServerSupabaseClient();
  const {data,error}=await db.from("ai_owner_notifications").select("opted_in, updated_at")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).maybeSingle();
  if(error)throw error;
  return conversationJson({optIn:data?.opted_in===true,updatedAt:data?.updated_at??null});
 }catch(error){return conversationError(error);}
}
export async function POST(request:Request){
 try{
  requireSameOrigin(request);
  const {optIn}=parseInput(input,await readBoundedJson(request));
  const {scope}=await authenticatedConversationContext();
  const db=await createServerSupabaseClient();
  if(!optIn){
   const {error}=await db.from("ai_owner_notifications").update({
    opted_in:false,updated_at:new Date().toISOString(),
   }).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId);
   if(error)throw error;
   return conversationJson({optIn:false});
  }
  const {data:{user}}=await db.auth.getUser();
  if(!user?.phone||!user.phone_confirmed_at||!/^\+[1-9][0-9]{7,14}$/.test(user.phone))
   throw new ConversationApiError(422,"verified_phone_required");
  const now=new Date().toISOString();
  const {error}=await db.from("ai_owner_notifications").upsert({
   business_id:scope.businessId,owner_user_id:scope.ownerUserId,
   phone_e164:user.phone,opted_in:true,consent_at:now,updated_at:now,
  },{onConflict:"business_id,owner_user_id"});
  if(error)throw error;
  return conversationJson({optIn:true});
 }catch(error){return conversationError(error);}
}
