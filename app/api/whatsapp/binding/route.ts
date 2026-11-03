import {z} from "zod";
import {authenticatedConversationContext,ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {TEST_PHONE_NUMBER_ID} from "@/lib/whatsapp/transport";

export const runtime="nodejs";
export const dynamic="force-dynamic";

export const connectInput=z.strictObject({
  threadId:z.uuid(),
  consent:z.literal(true),
});

async function context(){
  const {scope,service}=await authenticatedConversationContext();
  const db=await createServerSupabaseClient();
  const {data:{user},error}=await db.auth.getUser();
  if(error||!user)throw new ConversationApiError(401,"authentication_required");
  return {scope,service,db,user};
}

export async function GET(){
  try{
    const {scope,service,db,user}=await context();
    const [{data:bindings,error},threads]=await Promise.all([
      db.from("whatsapp_owner_bindings")
        .select("id,thread_id,wa_id,opted_in")
        .eq("business_id",scope.businessId)
        .eq("owner_user_id",scope.ownerUserId)
        .eq("phone_number_id",TEST_PHONE_NUMBER_ID)
        .eq("opted_in",true)
        .is("revoked_at",null)
        .limit(1),
      service.listThreads(0),
    ]);
    if(error)throw error;
    const verifiedPhone=user.phone_confirmed_at&&typeof user.phone==="string"&&
      /^\+[1-9][0-9]{7,14}$/.test(user.phone)?user.phone:null;
    const active=bindings?.[0]??null;
    return conversationJson({
      verifiedPhone,
      binding:active?{id:active.id,threadId:active.thread_id,
        phoneMatches:verifiedPhone!==null&&active.wa_id===verifiedPhone.slice(1)}:null,
      threads:threads.items.map(thread=>({id:thread.id,title:thread.title})),
      businessId:scope.businessId,
    });
  }catch(error){return conversationError(error);}
}

/** Signed-in, confirmed phone only; never trust a phone or café ID from a request. */
export async function POST(request:Request){
  try{
    requireSameOrigin(request);
    const input=parseInput(connectInput,await readBoundedJson(request));
    const {scope,db,user}=await context();
    const phone=user.phone;
    if(!user.phone_confirmed_at||!phone||!/^\+[1-9][0-9]{7,14}$/.test(phone))
      throw new ConversationApiError(422,"verified_phone_required");
    const {data:thread,error:threadError}=await db.from("ai_threads")
      .select("id").eq("id",input.threadId).eq("business_id",scope.businessId)
      .eq("owner_user_id",scope.ownerUserId).maybeSingle();
    if(threadError)throw threadError;
    if(!thread)throw new ConversationApiError(404,"thread_not_owned");
    const {data:existing,error:existingError}=await db.from("whatsapp_owner_bindings")
      .select("id,thread_id,wa_id").eq("business_id",scope.businessId)
      .eq("owner_user_id",scope.ownerUserId).eq("phone_number_id",TEST_PHONE_NUMBER_ID)
      .eq("opted_in",true).is("revoked_at",null).limit(1);
    if(existingError)throw existingError;
    if(existing?.length){
      if(existing[0].thread_id===input.threadId&&existing[0].wa_id===phone.slice(1))
        return conversationJson({connected:true});
      throw new ConversationApiError(409,"disconnect_existing_binding_first");
    }
    const {error}=await db.from("whatsapp_owner_bindings").insert({
      phone_number_id:TEST_PHONE_NUMBER_ID,wa_id:phone.slice(1),
      business_id:scope.businessId,owner_user_id:scope.ownerUserId,
      thread_id:input.threadId,opted_in:true,
      verified_at:user.phone_confirmed_at,consent_at:new Date().toISOString(),
    });
    if(error){
      if(error.code==="23505")throw new ConversationApiError(409,"phone_already_connected");
      throw error;
    }
    return conversationJson({connected:true},201);
  }catch(error){return conversationError(error);}
}

export async function DELETE(request:Request){
  try{
    requireSameOrigin(request);
    const {scope,db}=await context();
    const {data:bindings,error:lookupError}=await db.from("whatsapp_owner_bindings")
      .select("id").eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("phone_number_id",TEST_PHONE_NUMBER_ID).eq("opted_in",true)
      .is("revoked_at",null).limit(1);
    if(lookupError)throw lookupError;
    if(!bindings?.length)return conversationJson({connected:false});
    const {error}=await db.from("whatsapp_owner_bindings")
      .update({opted_in:false,revoked_at:new Date().toISOString()})
      .eq("id",bindings[0].id).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId);
    if(error)throw error;
    return conversationJson({connected:false});
  }catch(error){return conversationError(error);}
}
