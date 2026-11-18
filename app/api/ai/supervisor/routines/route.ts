import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {listOwnerRoutinesAcrossThreads} from "@/lib/ai/supervisor/routines/repository.server";

export const runtime="nodejs";
export const dynamic="force-dynamic";

/** The existing routine ledger, scoped to the currently authenticated owner/café.
 * This is read-only: only verified chat turns may create/change a routine. */
export async function GET(){
  try{
    const {scope}=await authenticatedConversationContext();
    const routines=await listOwnerRoutinesAcrossThreads(scope,await createServerSupabaseClient());
    return conversationJson({routines});
  }catch(error){return conversationError(error);}
}
