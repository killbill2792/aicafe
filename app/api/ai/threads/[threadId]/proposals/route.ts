import {z} from "zod";
import {proposalRequestKey} from "@/lib/ai/supervisor/loop/requestKeys";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin}
  from "@/lib/ai/conversations/http.server";
import {latestEditedProposalId} from "@/lib/data/proposalEdits.server";
import {ownerMenuPrice} from "@/lib/data/proposalPrices.server";
import {approveLoop,commitLoop,simulateLoop,effectHash,assertProposalScope,type OwnerLoopScope,type LoopProposal}
  from "@/lib/ai/supervisor/loop/engine";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {menuPriceChangeCapabilityId,StaleProposalError}
  from "@/lib/ai/supervisor/loop/menuPriceChange.server";
export const runtime="nodejs";export const dynamic="force-dynamic";
type Params={params:Promise<{threadId:string}>};
const uuid=z.uuid(),revision=z.number().int().positive();
const price=z.number().int().safe().positive().max(100000);
const actions=z.discriminatedUnion("action",[
  z.strictObject({action:z.literal("approve"),proposalId:uuid,revision}),
  z.strictObject({action:z.literal("cancel"),proposalId:uuid,revision}),
  z.strictObject({action:z.literal("edit"),proposalId:uuid,revision,newPriceCents:price}),
]);
async function context(threadId:string){
  const {scope,service}=await authenticatedConversationContext();
  const id=uuid.parse(threadId);
  await service.getThread(id);
  return {...scope,threadId:id,locale:"en" as const} satisfies OwnerLoopScope;
}
const card=(p:LoopProposal,state?:string)=>({
  proposalId:p.id,revision:p.revision,
  state:state??({draft:"pending",approved:"applying",executing:"applying",
    committed:"applied",monitored:"applied",rejected:"cancelled",
    expired:"cancelled",manual_pending:"applying",manual_confirmed:"applied"} as Record<string,string>)[p.status]??"failed",
  capabilityId:p.capabilityId,...(p.canonicalEffectPayload as Record<string,unknown>),
  editedByOwner:p.baseline.editedByOwner===true,
});
async function view(scope:OwnerLoopScope,repo:SupabaseLoopRepository,p:LoopProposal){
  // Follow immutable edit ancestry so an old chat block always opens the latest draft.
  // Every child has the same owner/business/thread scope; never use an unscoped lookup.
  for(let depth=0;p.status==="rejected"&&depth<20;depth++){
    const childId=await latestEditedProposalId(scope,p.id);
    if(!childId)break;
    p=await repo.load(scope,childId);
    assertProposalScope(scope,p);
  }
  assertProposalScope(scope,p);
  if(p.capabilityId!==menuPriceChangeCapabilityId)return null;
  const effect=supervisorLoopRegistry.get(menuPriceChangeCapabilityId).parseEffect(p.canonicalEffectPayload);
  if(p.status==="executing"){
    const current=await ownerMenuPrice(scope,String(effect.productId));
    if(current===effect.newPriceCents)return card(p,"applied");
    return card(p,"applying");
  }
  if(p.status==="draft"){
    const current=await ownerMenuPrice(scope,String(effect.productId));
    if(current!==effect.oldPriceCents)return {...card(p,"stale"),currentPriceCents:current};
  }
  return card(p);
}
export async function GET(request:Request,{params}:Params){
  try{
    const scope=await context((await params).threadId);
    const raw=new URL(request.url).searchParams.get("ids")??"";
    const ids=[...new Set(raw.split(",").filter(Boolean))];
    if(ids.length>30||ids.some(id=>!uuid.safeParse(id).success))
      return conversationJson({error:"invalid_ids"},422);
    const repo=new SupabaseLoopRepository();
    const cards=await Promise.all(ids.map(async id=>{
      try{return await view(scope,repo,await repo.load(scope,id));}
      catch{return null;}
    }));
    return conversationJson({cards:cards.filter(Boolean)});
  }catch(error){return conversationError(error);}
}
export async function POST(request:Request,{params}:Params){
  try{
    requireSameOrigin(request);
    const scope=await context((await params).threadId);
    const input=parseInput(actions,await readBoundedJson(request));
    const repo=new SupabaseLoopRepository();
    let p:LoopProposal;
    try{p=await repo.load(scope,input.proposalId);}
    catch{return conversationJson({error:"proposal_not_found"},404);}
    assertProposalScope(scope,p);
    if(p.capabilityId!==menuPriceChangeCapabilityId)return conversationJson({error:"proposal_not_found"},404);
    if(p.revision!==input.revision||p.status!=="draft")
      return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
    if(input.action==="cancel"){
      try{return conversationJson({proposal:card(await repo.transition(scope,p.id,p.revision,"reject"))});}
      catch{return conversationJson({state:"conflict",proposal:await view(scope,repo,await repo.load(scope,p.id))},409);}
    }
    const effect=supervisorLoopRegistry.get(menuPriceChangeCapabilityId).parseEffect(p.canonicalEffectPayload);
    const current=await ownerMenuPrice(scope,String(effect.productId));
    if(current!==effect.oldPriceCents)
      return conversationJson({state:"stale",currentPriceCents:current,proposal:{...card(p,"stale"),currentPriceCents:current}},409);
    if(input.action==="edit"){
      if(input.newPriceCents===current)return conversationJson({state:"unchanged"},422);
      // Validate the replacement against the current authorized menu BEFORE
      // rejecting its old revision; a failed simulation leaves the original intact.
      const simulation=await simulateLoop({...scope,locale:p.locale},supervisorLoopRegistry,menuPriceChangeCapabilityId,
        {productId:effect.productId,newPriceCents:input.newPriceCents});
      const canonical=supervisorLoopRegistry.get(menuPriceChangeCapabilityId).parseEffect(simulation.effect);
      // A replacement is a distinct immutable proposal. Never execute while editing.
      let old:LoopProposal;
      try{old=await repo.transition(scope,p.id,p.revision,"reject");}
      catch{return conversationJson({state:"conflict",proposal:await view(scope,repo,await repo.load(scope,p.id))},409);}
      const key=proposalRequestKey(p.id,JSON.stringify({revision:p.revision,newPriceCents:input.newPriceCents}));
      const next=await repo.create({...scope,locale:p.locale},key,{businessId:scope.businessId,
        ownerUserId:scope.ownerUserId,threadId:scope.threadId,
        capabilityId:menuPriceChangeCapabilityId,capabilityVersion:1,
        canonicalEffectPayload:canonical,effectHash:effectHash(canonical),
        baseline:{...simulation.baseline,editedByOwner:true,editedFrom:old.id},
        monitorSpec:simulation.monitorSpec,locale:p.locale});
      return conversationJson({proposal:card(next),replaced:card(old,"edited")});
    }
    try{
      const approved=await approveLoop(scope,repo,p.id,p.revision);
      const committed=await commitLoop(scope,supervisorLoopRegistry,repo,p.id,approved.revision);
      return conversationJson({proposal:card(committed.proposal)});
    }catch(error){
      if(error instanceof StaleProposalError)return conversationJson({
        state:"stale",currentPriceCents:error.currentPriceCents,
        proposal:{...card(p,"stale"),currentPriceCents:error.currentPriceCents}},409);
      const latest=await repo.load(scope,p.id);
      if(latest.status==="draft"||latest.status==="approved")
        return conversationJson({state:"conflict",proposal:await view(scope,repo,latest)},409);
      return conversationJson({proposal:await view(scope,repo,latest)},latest.status==="executing"?500:200);
    }
  }catch(error){return conversationError(error);}
}
