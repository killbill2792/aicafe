import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";

const normalize=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/gu," ").trim();

/** True when this owner already has the SAME question open and unanswered on another investigation. The owner is
 * asked a given question once, not once per alert; the new investigation reports its findings without repeating it. */
export async function openQuestionAlreadyAsked(db:SupabaseClient,
  scope:{businessId:string;ownerUserId:string;sourceType:string;sourceId:string},question:string):Promise<boolean>{
  const open=await db.from("supervisor_investigations").select("source_type,source_id,pending_question_id")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("phase","awaiting_owner").is("last_owner_answer_id",null).not("pending_question_id","is",null).limit(200);
  if(open.error)throw open.error;
  const ids=(open.data??[]).filter(row=>!(row.source_type===scope.sourceType&&row.source_id===scope.sourceId))
    .map(row=>String(row.pending_question_id));
  if(!ids.length)return false;
  const messages=await db.from("ai_messages").select("structured_content")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).in("id",ids).limit(200);
  if(messages.error)throw messages.error;
  const wanted=normalize(question);
  for(const message of messages.data??[]){
    const blocks=Array.isArray(message.structured_content)?message.structured_content:[];
    for(const block of blocks){
      if(block&&typeof block==="object"&&(block as {type?:unknown}).type==="clarify"&&
        typeof (block as {question?:unknown}).question==="string"&&
        normalize((block as {question:string}).question)===wanted)return true;
    }
  }
  return false;
}
