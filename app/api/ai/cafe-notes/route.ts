import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {z} from "zod";

export const runtime="nodejs";
export const dynamic="force-dynamic";

/** What Supervisor has learned about this café, read with the owner's own session (RLS), newest first. */
export async function GET(){
  try{
    const {scope}=await authenticatedConversationContext();
    const db=await createServerSupabaseClient();
    const {data,error}=await db.from("cafe_notes").select("topic,note,basis,created_at,confirmed_at")
      .eq("business_id",scope.businessId).is("retired_at",null).order("created_at",{ascending:false}).limit(100);
    if(error)throw new Error("cafe_notes_unavailable");
    return conversationJson({notes:data??[]});
  }catch(error){return conversationError(error);}
}

const forget=z.strictObject({action:z.literal("forget"),topic:z.string().regex(/^[a-z][a-z0-9_.:-]{0,79}$/)});

/** Forgetting keeps the history row (retired, not deleted); the database checks the owner. */
export async function POST(request:Request){
  try{
    requireSameOrigin(request);
    const {scope}=await authenticatedConversationContext();
    const input=parseInput(forget,await readBoundedJson(request));
    const db=await createServerSupabaseClient();
    const {data,error}=await db.rpc("forget_cafe_note",{p_business_id:scope.businessId,p_topic:input.topic});
    if(error)throw new Error("cafe_note_not_forgotten");
    return conversationJson({forgotten:data===true});
  }catch(error){return conversationError(error);}
}
