import {z} from "zod";
import {authenticatedConversationContext,ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin}
  from "@/lib/ai/conversations/http.server";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {readSupervisorCafeIdentity} from "@/lib/ai/cafeTools.server";
import {readSavedEventTimeline,readEventChecklist} from "@/lib/data/cafeEvents.server";
import {readOwnerProposals} from "@/lib/ai/supervisor/loop/reads.server";
import {eventReadinessCapabilityId} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import {utcDateOffset} from "@/lib/ai/supervisor/loop/engine";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const uuid=z.uuid();
const tickInput=z.strictObject({
  proposalId:uuid,actionIndex:z.number().int().min(0).max(2),
  state:z.enum(["done","dismissed"]),
});

/** Saved facts and existing Supervisor plans only. No search, cron or AI generation on open. */
export async function GET(request:Request){
  try{
    const {scope}=await authenticatedConversationContext();
    await assertCafeAiAccess(scope.businessId);
    const db=await createServerSupabaseClient();
    const proposalId=new URL(request.url).searchParams.get("proposalId");
    if(proposalId){
      const id=uuid.parse(proposalId);
      const proposals=await readOwnerProposals(db,scope,{
        id,capabilityId:eventReadinessCapabilityId,limit:1,
      });
      if(proposals.length!==1)throw new ConversationApiError(404,"event_plan_not_found");
      return conversationJson({ticks:await readEventChecklist(db,scope.businessId,id)});
    }
    const identity=await readSupervisorCafeIdentity(scope.businessId);
    const today=identity.asOf;
    const timeline=await readSavedEventTimeline(db,scope,utcDateOffset(today,-14),utcDateOffset(today,14));
    return conversationJson({today,currency:identity.currency,...timeline});
  }catch(error){return conversationError(error);}
}

/** Ticking a plan is the owner's explicit action, never the AI's. RLS verifies
 * ownership and the already committed event-readiness proposal again. */
export async function POST(request:Request){
  try{
    requireSameOrigin(request);
    const {scope}=await authenticatedConversationContext();
    await assertCafeAiAccess(scope.businessId);
    const input=parseInput(tickInput,await readBoundedJson(request));
    const db=await createServerSupabaseClient();
    const proposals=await readOwnerProposals(db,scope,{
      id:input.proposalId,capabilityId:eventReadinessCapabilityId,limit:1,
    });
    const proposal=proposals[0];
    const effect=proposal?.canonical_effect_payload as {actions?:unknown}|undefined;
    if(!proposal||!["committed","monitored"].includes(proposal.status))
      throw new ConversationApiError(409,"event_plan_not_approved");
    if(!Array.isArray(effect?.actions)||input.actionIndex>=effect.actions.length)
      throw new ConversationApiError(422,"invalid_event_action");
    const {error}=await db.from("cafe_event_checklist").upsert({
      business_id:scope.businessId,proposal_id:input.proposalId,
      action_index:input.actionIndex,state:input.state,updated_by:scope.ownerUserId,
      updated_at:new Date().toISOString(),
    },{onConflict:"business_id,proposal_id,action_index"});
    if(error)throw error;
    return conversationJson({actionIndex:input.actionIndex,state:input.state});
  }catch(error){return conversationError(error);}
}
