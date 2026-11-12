import {z} from "zod";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin}
  from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createMandateChallenge,readMandates,revokeMandate,verifyMandateChallenge}
  from "@/lib/ai/supervisor/loop/mandates.server";
export const runtime="nodejs";export const dynamic="force-dynamic";
type Params={params:Promise<{threadId:string}>};
const uuid=z.uuid(),revision=z.number().int().positive();
const actions=z.discriminatedUnion("action",[
 z.strictObject({action:z.literal("challenge"),factorId:uuid,
  limitValue:z.literal(5),
  expiresAt:z.iso.datetime({offset:true}),mandateId:uuid.optional(),revision:revision.optional()})
  .refine(v=>Boolean(v.mandateId)===Boolean(v.revision),{message:"mandate_revision_required"}),
 z.strictObject({action:z.literal("verify"),challengeId:uuid,code:z.string().trim().min(1).max(32)}),
 z.strictObject({action:z.literal("revoke"),mandateId:uuid,revision}),
]);
async function context(threadId:string){
 const {scope,service}=await authenticatedConversationContext();
 await service.getThread(uuid.parse(threadId));
 return scope;
}
export async function GET(_request:Request,{params}:Params){
 try{
  const scope=await context((await params).threadId);
  return conversationJson({mandates:await readMandates(scope)});
 }catch(error){return conversationError(error);}
}
export async function POST(request:Request,{params}:Params){
 try{
  requireSameOrigin(request);
  const scope=await context((await params).threadId);
  const input=parseInput(actions,await readBoundedJson(request));
  if(input.action==="revoke")
   return conversationJson({mandate:await revokeMandate(scope,input.mandateId,input.revision)});
  const client=await createServerSupabaseClient();
  if(input.action==="challenge"){
   const challenge=await createMandateChallenge(scope,client,{
    factorId:input.factorId,limitValue:input.limitValue,expiresAt:input.expiresAt,
    ...(input.mandateId?{mandateId:input.mandateId,revision:input.revision}:{}),
   });
   return conversationJson({challenge});
  }
  const mandate=await verifyMandateChallenge(scope,client,{
   challengeId:input.challengeId,code:input.code,
  });
  return conversationJson({mandate});
 }catch(error){return conversationError(error);}
}
