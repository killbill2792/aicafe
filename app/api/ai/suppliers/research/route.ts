import {assertCafeAiAccess} from "@/lib/access/access.server";
import {authenticatedConversationContext,ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput} from "@/lib/ai/conversations/http.server";
import {researchQuery} from "@/lib/ai/suppliers/contracts";
import {researchEnabled,researchPublicSources} from "@/lib/ai/suppliers/research.server";
import {ownerPublicWebFetch,withOwnerPublicWebScope} from "@/lib/connectors/publicWeb.server";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(request:Request){
 try{
  const {scope}=await authenticatedConversationContext();
  await assertCafeAiAccess(scope.businessId);
  if(!researchEnabled())throw new ConversationApiError(503,"research_not_connected");
  const query=parseInput(researchQuery,new URL(request.url).searchParams.get("q")??"");
  const sources=await withOwnerPublicWebScope(scope,()=>researchPublicSources(query,ownerPublicWebFetch));
  return conversationJson({sources,verification:"unverified_search_snippet"});
 }catch(error){return conversationError(error);}
}
