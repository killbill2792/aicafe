import { z } from "zod";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin }
  from "@/lib/ai/conversations/http.server";
import { activateOwnerInitiative } from "@/lib/data/initiatives.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const bodySchema=z.strictObject({revision:z.number().int().min(1)});
type Context={params:Promise<{id:string}>};
export async function POST(request:Request,context:Context) {
  try {
    requireSameOrigin(request);
    const id=parseInput(z.uuid(),(await context.params).id);
    const {revision}=parseInput(bodySchema,await readBoundedJson(request));
    const {scope}=await authenticatedConversationContext();
    const updated=await activateOwnerInitiative(scope,id,revision);
    return updated?conversationJson({id,status:"active",revision:updated.revision}):
      conversationJson({error:"stale_or_unavailable"},409);
  }catch(error){return conversationError(error);}
}
