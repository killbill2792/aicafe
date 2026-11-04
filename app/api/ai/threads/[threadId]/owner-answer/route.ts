import {z} from "zod";
import {authenticatedConversationContext,ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {conversationJson,conversationError,parseInput,readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {clarifyBlockSchema} from "@/lib/ai/conversations/contracts";
import {validateOwnerAnswers} from "@/lib/ownerFacts/answers";
import {saveOwnerFactAnswers,forgetOwnerFact} from "@/lib/ownerFacts/store.server";
import {splitOwnerAnswers} from "@/lib/ownerFacts/change";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const schema=z.strictObject({
 questionId:z.uuid(),locale:z.enum(["en","es","ar"]),
 answers:z.array(z.strictObject({fieldKey:z.string().min(1).max(90),value:z.string().max(1000),
  forget:z.boolean().optional()})).min(1).max(6)
});
type Params={params:Promise<{threadId:string}>};
export async function POST(request:Request,{params}:Params){
 try{
  requireSameOrigin(request);
  const {threadId}=await params;
  if(!z.uuid().safeParse(threadId).success)throw new ConversationApiError(400,"invalid_thread");
  const input=parseInput(schema,await readBoundedJson(request));
  const {scope,service}=await authenticatedConversationContext();
  await service.getThread(threadId);
  // Trust only a persisted card in the authenticated café/thread, never fields
  // supplied by the browser. Newest messages are first.
  const page=await service.listMessages(threadId,0);
  const match=page.items.find(message=>message.role==="supervisor"&&
   message.blocks?.some(b=>b&&typeof b==="object"&&"questionId" in b&&b.questionId===input.questionId));
  const block=(match?.blocks??[]).map(b=>clarifyBlockSchema.safeParse(b))
   .find(x=>x.success&&x.data.kind==="facts"&&x.data.questionId===input.questionId);
  if(!block?.success||block.data.kind!=="facts")throw new ConversationApiError(404,"owner_question_not_found");
  if(page.items.some(m=>m.role==="owner"&&match&&
    (m.createdAt>match.createdAt||(m.createdAt===match.createdAt&&m.id>match.id))))
    throw new ConversationApiError(409,"owner_question_superseded");
  // The card decides what is kept: "this question only" answers are never saved
  // (the owner's answer still reaches the chat as their next message), and only a
  // change card can forget a saved fact.
  let split:ReturnType<typeof splitOwnerAnswers>;
  let answers:ReturnType<typeof validateOwnerAnswers>=[];
  try{
   split=splitOwnerAnswers(block.data,input.answers);
   if(split.keep.length)answers=validateOwnerAnswers(block.data.fields,split.keep,input.locale);
  }catch{throw new ConversationApiError(422,"invalid_owner_answers");}
  let forgotten=0;
  for(const key of split.forget)if(await forgetOwnerFact(scope.businessId,key))forgotten++;
  const saved=answers.length?await saveOwnerFactAnswers(scope.businessId,answers):[];
  return conversationJson({saved:true,writeThroughApplied:saved.every(row=>row.writeThroughApplied),
   remembered:saved.length,forgotten});
 }catch(error){return conversationError(error);}
}
