import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {listOwnerRoutinesAcrossThreads,changeOwnerRoutine} from "@/lib/ai/supervisor/routines/repository.server";
import {z} from "zod";

export const runtime="nodejs";
export const dynamic="force-dynamic";

/** The existing routine ledger, scoped to the currently authenticated owner/café.
 * GET is read-only; authenticated chat turns and same-origin controls can
 * change a routine through the ONE revision-fenced repository RPC. */
export async function GET(){
  try{
    const {scope}=await authenticatedConversationContext();
    const routines=await listOwnerRoutinesAcrossThreads(scope,await createServerSupabaseClient());
    return conversationJson({routines});
  }catch(error){return conversationError(error);}
}


const mutation=z.strictObject({
  action:z.enum(["pause","resume","delete"]),
  routineId:z.uuid(),
  revision:z.number().int().positive(),
});

/** Compact routine controls are real owner-scoped mutations, not optimistic
 * front-end status labels. The source thread comes from the verified DB row,
 * not the browser; SQL CAS rejects a stale revision or revoked owner. */
export async function POST(request:Request){
  try{
    requireSameOrigin(request);
    const input=parseInput(mutation,await readBoundedJson(request));
    const {scope}=await authenticatedConversationContext();
    const client=await createServerSupabaseClient();
    const read=await client.from("supervisor_routines")
      .select("*")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("id",input.routineId).maybeSingle();
    if(read.error)throw read.error;
    const stored=read.data as (typeof read.data & {execution_mode?:string});
    if(!stored||stored.execution_mode==="watch"||
       read.data.status==="revoked")throw Error("Routine unavailable");
    const status=input.action==="pause"?"paused":
      input.action==="resume"?"active":"revoked";
    const saved=await changeOwnerRoutine({
      id:input.routineId,revision:input.revision,status,
    },{scope,threadId:read.data.thread_id,client});
    return conversationJson({routine:saved});
  }catch(error){return conversationError(error);}
}
