import {z} from "zod";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {proposalRequestKey} from "@/lib/ai/supervisor/loop/requestKeys";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin}
  from "@/lib/ai/conversations/http.server";
import {latestEditedProposalId} from "@/lib/data/proposalEdits.server";
import {ownerMenuPrice} from "@/lib/data/proposalPrices.server";
import {approveLoop,commitLoop,simulateLoop,effectHash,assertProposalScope,type OwnerLoopScope,type LoopProposal}
  from "@/lib/ai/supervisor/loop/engine";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import {supervisorLoopRegistry,priceExperimentCapabilityId} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {menuPriceChangeCapabilityId,StaleProposalError}
  from "@/lib/ai/supervisor/loop/menuPriceChange.server";
import {isStaffCapabilityId,readStaffProposalToken} from "@/lib/ai/supervisor/loop/staffProposals.server";
import {purchaseCapabilityId} from "@/lib/ai/supervisor/loop/purchases.server";
import {goalCapabilityId} from "@/lib/ai/supervisor/loop/goal.server";
import {eventReadinessCapabilityId} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import {gmailCapabilityId,gmailEffectSchema} from "@/lib/ai/supervisor/loop/gmail.server";
import {SupervisorEffectGateway} from "@/lib/ai/supervisor/loop/effectGateway.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {publishApprovedStaffSchedule} from "@/lib/scheduling/staffPublication.server";
/** The loop refused a second active proposal on the same item (engine ProposalOverlapError). */
function runningOverlap(error:unknown):{proposalId:string;status:string;endsOn:string|null}|null{
  if(!(error instanceof Error)||error.name!=="ProposalOverlapError"||!("running" in error))return null;
  const r=(error as Error&{running:{proposalId:string;status:string;endsOn:string|null}}).running;
  return {proposalId:r.proposalId,status:r.status,endsOn:r.endsOn};
}
export const runtime="nodejs";export const dynamic="force-dynamic";
type Params={params:Promise<{threadId:string}>};
const uuid=z.uuid(),revision=z.number().int().positive();
const price=z.number().int().safe().positive().max(100000);
const actions=z.discriminatedUnion("action",[
  z.strictObject({action:z.literal("approve"),proposalId:uuid,revision}),
  z.strictObject({action:z.literal("start"),proposalId:uuid,revision}),
  z.strictObject({action:z.literal("reconcile"),proposalId:uuid,revision}),
  z.strictObject({action:z.literal("cancel"),proposalId:uuid,revision}),
  z.strictObject({action:z.literal("edit"),proposalId:uuid,revision,newPriceCents:price}),
  z.strictObject({action:z.literal("edit_purchase"),proposalId:uuid,revision,
    ingredientId:uuid.nullable(),quantity:z.number().finite().positive().max(1e9),
    unit:z.string().trim().min(1).max(40),costCents:z.number().int().nonnegative().safe().nullable(),
    date:z.iso.date(),receiptVendor:z.string().trim().min(1).max(160).nullable().optional(),
    receiptTotalCents:z.number().int().positive().safe().nullable().optional()}),
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
    expired:"cancelled",stale:"stale",manual_pending:"applying",manual_confirmed:"applied"} as Record<string,string>)[p.status]??"failed",
  capabilityId:p.capabilityId,...(p.canonicalEffectPayload as Record<string,unknown>),
  editedByOwner:p.baseline.editedByOwner===true,
});
async function view(scope:OwnerLoopScope,repo:SupabaseLoopRepository,p:LoopProposal){
  const attempt=p.status==="executing"?await repo.effectAttempt(scope,p.id).catch(()=>null):null;
  const executionState=attempt?.state==="executing"?"applying":"uncertain";
  // Follow immutable edit ancestry so an old chat block always opens the latest draft.
  // Every child has the same owner/business/thread scope; never use an unscoped lookup.
  for(let depth=0;p.status==="rejected"&&depth<20;depth++){
    const childId=await latestEditedProposalId(scope,p.id);
    if(!childId)break;
    p=await repo.load(scope,childId);
    assertProposalScope(scope,p);
  }
  assertProposalScope(scope,p);
  if(p.capabilityId===purchaseCapabilityId){
    const effect=supervisorLoopRegistry.get(purchaseCapabilityId).parseEffect(p.canonicalEffectPayload);
    const db=await createServerSupabaseClient();
    const {data:ingredients,error}=await db.from("ingredients").select("id,name,base_unit")
      .eq("business_id",scope.businessId).order("name").limit(2000);
    if(error)throw new Error("purchase_ingredients_unavailable");
    return {...card(p),state:p.status==="executing"?executionState:card(p).state,
      subjectName:effect.name,purchase:effect,
      ingredientOptions:ingredients??[]};
  }
  if(isStaffCapabilityId(p.capabilityId)){
    const effect=p.capabilityVersion===1?p.canonicalEffectPayload as
      {preview:Array<{label:string;before:string;after:string}>;expectedToken:string}:
      supervisorLoopRegistry.get(p.capabilityId).parseEffect(p.canonicalEffectPayload) as
      {preview:Array<{field:string;label:string;before:unknown;after:unknown}>;expectedToken:string;
       dependencyScope:import("@/lib/ai/supervisor/loop/staffProposals.server").StaffDependencyScope};
    const data={...card(p),preview:effect.preview};
    if(p.capabilityVersion===1)return {...data,state:p.status==="committed"?"applied":"stale"};
    if(p.status==="draft"){
      try{
        if(await readStaffProposalToken(scope,(
          effect as {dependencyScope:import("@/lib/ai/supervisor/loop/staffProposals.server").StaffDependencyScope}
        ).dependencyScope)!==effect.expectedToken)return {...data,state:"stale"};
      }catch{return {...data,state:"stale"};}
    }
    const intent=p.canonicalEffectPayload as {operation?:string;
      payload?:{publish_and_notify?:boolean}};
    const publishAndNotify=intent.operation==="propose_send_schedule"&&
      intent.payload?.publish_and_notify===true;
    if(!publishAndNotify)return {...data,state:p.status==="approved"?"conflict":data.state};
    if(p.status!=="committed")return {...data,publishAndNotify,
      state:p.status==="approved"?"conflict":data.state};
    const db=await createServerSupabaseClient();
    const publication=await db.from("staff_schedule_publications")
      .select("id,week_start,published_at,snapshot")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("proposal_id",p.id).eq("status","published").maybeSingle();
    if(publication.error||!publication.data)return {...data,publishAndNotify,
      state:"applying",publication:{state:"pending"}};
    const receipts=await db.from("staff_schedule_deliveries")
      .select("employee_id,status").eq("business_id",scope.businessId)
      .eq("publication_id",publication.data.id).limit(201);
    if(receipts.error||!receipts.data)return {...data,publishAndNotify,
      state:"applying",publication:{state:"pending"}};
    const shifts=publication.data.snapshot as Array<{employee_id:string}>;
    const present=new Set(receipts.data.map(row=>row.employee_id));
    const expected=new Set(shifts.map(s=>s.employee_id));
    const counts=(status:string)=>receipts.data.filter(row=>row.status===status).length;
    return {...data,publishAndNotify,state:"applied",publication:{
      state:"published",week:publication.data.week_start,
      expected:expected.size,missing:[...expected].filter(id=>!present.has(id)).length,
      accepted:counts("sent"),delivered:counts("delivered"),read:counts("read"),
      pending:counts("prepared")+counts("sending"),failed:counts("failed"),
      uncertain:counts("uncertain")}};

  }
  if(p.capabilityId===gmailCapabilityId){
    const effect=gmailEffectSchema.parse(p.canonicalEffectPayload);
    return {...card(p,p.status==="executing"?executionState:undefined),
      gmail:{...effect},productName:"Gmail · "+effect.operation};
  }
  if(p.capabilityId===eventReadinessCapabilityId){
    const effect=supervisorLoopRegistry.get(eventReadinessCapabilityId).parseEffect(p.canonicalEffectPayload) as {
      summary:string;actions:Array<{area:string;action:string;reason:string}>;
    };
    return {...card(p,p.status==="executing"?executionState:undefined),productName:effect.summary,preview:effect.actions.map((a,i)=>({
      field:"action:"+i,label:a.area,before:null,
      after:{kind:"text" as const,text:a.action+" — "+a.reason},
    }))};
  }
  if(p.capabilityId===goalCapabilityId){
    // Goal effects carry their title; the card rows were built in the owner's language at proposal time.
    const effect=supervisorLoopRegistry.get(goalCapabilityId).parseEffect(p.canonicalEffectPayload) as {title:string};
    const preview=Array.isArray(p.baseline.preview)?p.baseline.preview:[];
    const state=({draft:"pending",approved:"applying",executing:executionState,committed:"tracking",
      monitored:"applied",rejected:"cancelled",expired:"cancelled"} as Record<string,string>)[p.status]??"failed";
    return {...card(p,state),productName:effect.title,preview};
  }
  if(p.capabilityId===priceExperimentCapabilityId){
    const effect=supervisorLoopRegistry.get(priceExperimentCapabilityId).parseEffect(p.canonicalEffectPayload);
    const preview=Array.isArray(effect.preview)?effect.preview:[
      {field:"price",label:"Price",before:{kind:"money",cents:effect.oldPriceCents},
       after:{kind:"money",cents:effect.newPriceCents}},
      {field:"duration",label:"Duration",before:null,after:{kind:"count",n:7,unit:"days"}},
    ];
    const data={...card(p,p.status==="executing"?executionState:undefined),preview};
    if(p.status==="draft"){
      const current=await ownerMenuPrice(scope,String(effect.productId));
      if(current!==effect.oldPriceCents)return {...data,state:"stale",currentPriceCents:current};
    }
    return {...data,state:p.status==="manual_pending"?"manual_pending":data.state};
  }
  if(p.capabilityId!==menuPriceChangeCapabilityId)return null;
  const effect=supervisorLoopRegistry.get(menuPriceChangeCapabilityId).parseEffect(p.canonicalEffectPayload);
  if(p.status==="executing"){
    // Matching the requested live menu price is not a durable receipt.
    // It may have changed for another reason. Only the canonical, scoped
    // reconciliation RPC may promote the ledger to committed.
    return card(p,executionState);
  }
  if(p.status==="stale")
    return {...card(p),currentPriceCents:await ownerMenuPrice(scope,String(effect.productId))};
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
    await assertCafeAiAccess(scope.businessId);
    const input=parseInput(actions,await readBoundedJson(request));
    const repo=new SupabaseLoopRepository();
    let p:LoopProposal;
    try{p=await repo.load(scope,input.proposalId);}
    catch{return conversationJson({error:"proposal_not_found"},404);}
    assertProposalScope(scope,p);
    if(input.action==="reconcile"){
      if(p.revision!==input.revision)return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
      // This POST only checks canonical receipts / inert transitions. It never
      // invokes a capability commit and cannot resend a failed provider action.
      if(p.status==="committed"||p.status==="manual_pending")
        return conversationJson({state:"applied",proposal:await view(scope,repo,p)});
      if(p.status!=="executing")
        return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
      try{
        const reconciled=p.capabilityId===gmailCapabilityId?
          await new SupervisorEffectGateway().reconcileGmail(scope,p.id,p.revision):
          await repo.reconcileEffect(scope,p.id,p.revision);
        return conversationJson({state:reconciled.status==="executing"?"uncertain":"applied",
          proposal:await view(scope,repo,reconciled)},reconciled.status==="executing"?409:200);
      }catch{
        // A reconciliation failure is not permission to retry the effect.
        return conversationJson({state:"uncertain",error:"effect_reconciliation_unavailable",
          proposal:await view(scope,repo,await repo.load(scope,p.id))},409);
      }
    }
    if(input.action==="start"&&p.capabilityId!==goalCapabilityId)
      return conversationJson({error:"standing_mandate_action_not_eligible"},403);
    const staff=isStaffCapabilityId(p.capabilityId);
    const purchase=p.capabilityId===purchaseCapabilityId;
    if(!staff&&!purchase&&p.capabilityId!==gmailCapabilityId&&p.capabilityId!==menuPriceChangeCapabilityId&&p.capabilityId!==priceExperimentCapabilityId&&
      p.capabilityId!==goalCapabilityId&&p.capabilityId!==eventReadinessCapabilityId)
      return conversationJson({error:"proposal_not_found"},404);
    if(p.capabilityId===gmailCapabilityId){
      if(input.action==="start"||input.action==="edit"||input.action==="edit_purchase")
        return conversationJson({error:"gmail_action_not_supported"},422);
      if(p.status==="committed")return conversationJson({proposal:await view(scope,repo,p)});
      if(p.revision!==input.revision||p.status!=="draft")
        return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
      if(input.action==="cancel")
        return conversationJson({proposal:await view(scope,repo,await repo.transition(scope,p.id,p.revision,"reject"))});
      if(input.action!=="approve")return conversationJson({error:"gmail_action_not_supported"},422);
      // A specific owner click on this immutable card is the only outbound authority.
      try{
        const approved=await approveLoop(scope,repo,p.id,p.revision,supervisorLoopRegistry);
        const finished=await commitLoop(scope,supervisorLoopRegistry,repo,p.id,approved.revision,"click");
        return conversationJson({proposal:await view(scope,repo,finished.proposal)});
      }catch{
        const latest=await repo.load(scope,p.id);
        return conversationJson({state:latest.status==="executing"?"uncertain":"conflict",
          error:latest.status==="executing"?"gmail_outcome_uncertain":"gmail_action_failed",
          proposal:await view(scope,repo,latest)},409);
      }
    }
    if(purchase){
      if(p.status==="committed")
        return conversationJson({state:"applied",proposal:await view(scope,repo,p)});
      if(input.action==="edit")
        return conversationJson({error:"purchase_edit_fields_required"},422);
      if(input.action==="edit_purchase"){
        if(p.status!=="draft"||p.revision!==input.revision)
          return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
        const current=supervisorLoopRegistry.get(purchaseCapabilityId).parseEffect(p.canonicalEffectPayload);
        const db=await createServerSupabaseClient();
        const selected=input.ingredientId
          ?await db.from("ingredients").select("id,name").eq("business_id",scope.businessId)
             .eq("id",input.ingredientId).maybeSingle():null;
        if(selected?.error||input.ingredientId&&!selected?.data)
          return conversationJson({state:"unchanged",error:"ingredient_not_found"},422);
        const newName=selected?.data?.name??current.name;
        const simulation=await simulateLoop({...scope,locale:p.locale},supervisorLoopRegistry,purchaseCapabilityId,{
          name:newName,ingredientId:input.ingredientId,quantity:input.quantity,
          unit:input.unit,costCents:input.costCents,date:input.date,source:current.source,
          receiptGroupId:current.receiptGroupId??null,receiptLineIndex:current.receiptLineIndex??null,
          receiptVendor:input.receiptVendor??current.receiptVendor??null,
          receiptTotalCents:input.receiptTotalCents??current.receiptTotalCents??null
        });
        const effect=supervisorLoopRegistry.get(purchaseCapabilityId).parseEffect(simulation.effect);
        try{
          const edited=await repo.editPurchaseDraft(scope,p.id,p.revision,effect,effectHash(effect));
          return conversationJson({proposal:await view(scope,repo,edited)});
        }catch{return conversationJson({state:"conflict",proposal:await view(scope,repo,await repo.load(scope,p.id))},409);}
      }
      if(input.action==="cancel"){
        if(p.status!=="draft"||p.revision!==input.revision)
          return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
        try{return conversationJson({proposal:await view(scope,repo,
          await repo.transition(scope,p.id,p.revision,"reject"))});}
        catch{return conversationJson({state:"conflict",proposal:await view(scope,repo,await repo.load(scope,p.id))},409);}
      }
      if(p.status==="executing")
        return conversationJson({state:"uncertain",error:"effect_outcome_uncertain",
          proposal:await view(scope,repo,p)},409);
      if(p.revision!==input.revision||!["draft","approved"].includes(p.status))
        return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
      const effect=supervisorLoopRegistry.get(purchaseCapabilityId).parseEffect(p.canonicalEffectPayload);
      if(!effect.ingredientId)
        return conversationJson({state:"unchanged",error:"ingredient_match_required",proposal:await view(scope,repo,p)},422);
      try{
        const approved=p.status==="draft"?await approveLoop(scope,repo,p.id,p.revision,supervisorLoopRegistry):p;
        const result=await commitLoop(scope,supervisorLoopRegistry,repo,p.id,approved.revision,"click");
        return conversationJson({proposal:await view(scope,repo,result.proposal)});
      }catch{
        const latest=await repo.load(scope,p.id);
        if(latest.status==="committed")return conversationJson({proposal:await view(scope,repo,latest)});
        return conversationJson({state:latest.status==="executing"?"uncertain":"conflict",
          error:latest.status==="executing"?"effect_outcome_uncertain":"purchase_save_failed",
          proposal:await view(scope,repo,latest)},409);
      }
    }
    if(staff){
      if(p.capabilityVersion===1)return conversationJson({state:"stale",proposal:await view(scope,repo,p)},409);
      // Task 13B: only a NEW approval with explicit publish_and_notify
      // can publish/send. Historic copy-ready approvals never acquire consent.
      const staffEffect=p.canonicalEffectPayload as {operation?:string;
        payload?:{publish_and_notify?:boolean}};
      const needsPublish=staffEffect.operation==="propose_send_schedule"&&
        staffEffect.payload?.publish_and_notify===true;
      if(p.status==="committed"&&needsPublish){
        try{
          const publication=await publishApprovedStaffSchedule(scope,p.id);
          return conversationJson({state:"published",publication,
            proposal:await view(scope,repo,p)});
        }catch{
          return conversationJson({state:"awaiting_publication",
            error:"publication_verification_pending",proposal:await view(scope,repo,p)},409);
        }
      }
      if(input.action==="edit")return conversationJson({error:"staff_edits_require_new_proposal"},422);
      if(p.revision!==input.revision||!["draft","approved"].includes(p.status))
        return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
      if(input.action==="cancel"){
        if(p.status!=="draft")return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
        try{return conversationJson({proposal:await view(scope,repo,
          await repo.transition(scope,p.id,p.revision,"reject"))});}
        catch{return conversationJson({state:"conflict",proposal:await view(scope,repo,
          await repo.load(scope,p.id))},409);}
      }
      // Only a persisted approval record enables the atomic SQL executor.
      // The SQL function independently locks source and compares the token.
      try{
        const approved=p.status==="draft"?await approveLoop(scope,repo,p.id,p.revision,supervisorLoopRegistry):p;
        const result=await repo.commitStaff(scope,p.id,approved.revision);
        if(result.state==="applied"&&needsPublish){
          try{
            const publication=await publishApprovedStaffSchedule(scope,p.id);
            return conversationJson({state:"published",publication,
              proposal:await view(scope,repo,result.proposal)});
          }catch{
            // The approval may already be committed; a routine reconciles
            // publication using its durable proposal receipt. Never retry
            // the staff proposal as a fresh effect.
            return conversationJson({state:"awaiting_publication",
              error:"publication_verification_pending",
              proposal:await view(scope,repo,result.proposal)},409);
          }
        }
        return conversationJson({state:result.state,proposal:await view(scope,repo,result.proposal)},
          result.state==="stale"?409:200);
      }catch{
        const latest=await repo.load(scope,p.id);
        // A lost HTTP response after a committed SQL transaction is not a
        // failed write. Read the durable ledger before showing Retry.
        if(latest.status==="committed"){
          if(needsPublish){
            try{
              const publication=await publishApprovedStaffSchedule(scope,p.id);
              return conversationJson({state:"published",publication,
                proposal:await view(scope,repo,latest)});
            }catch{return conversationJson({state:"awaiting_publication",
              error:"publication_verification_pending",
              proposal:await view(scope,repo,latest)},409);}
          }
          return conversationJson({state:"applied",proposal:await view(scope,repo,latest)});
        }
        if(latest.status==="stale")
          return conversationJson({state:"stale",proposal:await view(scope,repo,latest)},409);
        if(latest.status==="approved")
          return conversationJson({state:"conflict",proposal:await view(scope,repo,latest)},409);
        return conversationJson({error:"staff_approval_failed",
          proposal:await view(scope,repo,latest)},409);
      }
    }
    if(p.capabilityId===goalCapabilityId||p.capabilityId===eventReadinessCapabilityId){
      // Goal tracking is the only standing-mandate eligible capability. This
      // server-only action requires an active phone-MFA mandate; no chat text
      // or client-supplied authorization can manufacture one.
      if(input.action==="start"){
        if(p.capabilityId!==goalCapabilityId||p.revision!==input.revision||p.status!=="draft")
          return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
        try{
          const started=await commitLoop(scope,supervisorLoopRegistry,repo,p.id,p.revision,"mandate");
          return conversationJson({proposal:await view(scope,repo,started.proposal)});
        }catch{
          const latest=await repo.load(scope,p.id);
          return conversationJson({state:latest.status==="executing"?"uncertain":"conflict",
            error:latest.status==="executing"?"effect_outcome_uncertain":"standing_mandate_denied",
            proposal:await view(scope,repo,latest)},409);
        }
      }
      if(p.revision!==input.revision||p.status!=="draft")
        return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
      if(input.action!=="approve"&&input.action!=="cancel")return conversationJson({error:"plan_edit_not_supported"},422);
      try{
        if(input.action==="cancel")
          return conversationJson({proposal:await view(scope,repo,await repo.transition(scope,p.id,p.revision,"reject"))});
        const approved=await approveLoop(scope,repo,p.id,p.revision,supervisorLoopRegistry);
        const committed=await commitLoop(scope,supervisorLoopRegistry,repo,p.id,approved.revision,"click");
        return conversationJson({proposal:await view(scope,repo,committed.proposal)});
      }catch{
        const latest=await repo.load(scope,p.id);
        if(latest.status==="committed"||latest.status==="manual_pending")
          return conversationJson({proposal:await view(scope,repo,latest)});
        return conversationJson({state:latest.status==="executing"?"uncertain":"conflict",
          error:latest.status==="executing"?"effect_outcome_uncertain":"proposal_commit_failed",
          proposal:await view(scope,repo,latest)},409);
      }
    }
    if(p.capabilityId===priceExperimentCapabilityId){
      if(p.revision!==input.revision||p.status!=="draft")
        return conversationJson({state:"conflict",proposal:await view(scope,repo,p)},409);
      if(input.action==="edit")return conversationJson({error:"experiment_price_edit_not_supported"},422);
      if(input.action==="cancel"){
        try{return conversationJson({proposal:card(await repo.transition(scope,p.id,p.revision,"reject"))});}
        catch{return conversationJson({state:"conflict",proposal:await view(scope,repo,await repo.load(scope,p.id))},409);}
      }
      const effect=supervisorLoopRegistry.get(priceExperimentCapabilityId).parseEffect(p.canonicalEffectPayload);
      const current=await ownerMenuPrice(scope,String(effect.productId));
      if(current!==effect.oldPriceCents)
        return conversationJson({state:"stale",proposal:{...card(p,"stale"),currentPriceCents:current}},409);
      try{
        const approved=await approveLoop(scope,repo,p.id,p.revision,supervisorLoopRegistry);
        const committed=await commitLoop(scope,supervisorLoopRegistry,repo,p.id,approved.revision,"click");
        return conversationJson({proposal:await view(scope,repo,committed.proposal)});
      }catch(error){
        const latest=await repo.load(scope,p.id);
        const overlap=runningOverlap(error);
        if(overlap)return conversationJson({state:"conflict",error:"running_experiment_same_item",running:overlap,
          proposal:await view(scope,repo,latest)},409);
        if(latest.status==="manual_pending"||latest.status==="committed")
          return conversationJson({proposal:await view(scope,repo,latest)});
        return conversationJson({state:latest.status==="executing"?"uncertain":"conflict",
          error:latest.status==="executing"?"effect_outcome_uncertain":"proposal_commit_failed",
          proposal:await view(scope,repo,latest)},409);
      }
    }
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
      // One locked database transaction checks the old revision, rejects it,
      // and inserts its replacement. If INSERT fails, rejection rolls back.
      // An approval racing with Edit is serialized by the same proposal lock.
      const key=proposalRequestKey(p.id,JSON.stringify({revision:p.revision,newPriceCents:input.newPriceCents}));
      let replacement:Awaited<ReturnType<typeof repo.replacePriceDraft>>;
      try{
        replacement=await repo.replacePriceDraft(
          {...scope,locale:p.locale},p.id,p.revision,key,canonical,effectHash(canonical));
      }catch(error){
        const latest=await repo.load(scope,p.id);
        if(latest.status!=="draft"||latest.revision!==p.revision)
          return conversationJson({state:"conflict",proposal:await view(scope,repo,latest)},409);
        throw error; // The original draft remains actionable on a failed INSERT.
      }
      return conversationJson({proposal:card(replacement.proposal),
        replaced:card(replacement.replaced,"edited")});
    }
    try{
      const approved=await approveLoop(scope,repo,p.id,p.revision,supervisorLoopRegistry);
      const committed=await commitLoop(scope,supervisorLoopRegistry,repo,p.id,approved.revision,"click");
      return conversationJson({proposal:card(committed.proposal)});
    }catch(error){
      const overlap=runningOverlap(error);
      if(overlap)return conversationJson({state:"conflict",error:"running_experiment_same_item",running:overlap,
        proposal:card(await repo.load(scope,p.id))},409);
      if(error instanceof StaleProposalError){
        // Only StaleProposalError proves that no menu price/history write
        // happened. Persist that terminal result after the atomic claim;
        // never retry a potentially completed effect.
        const latest=await repo.load(scope,p.id);
        if(latest.status==="stale")
          return conversationJson({state:"stale",currentPriceCents:error.currentPriceCents,
            proposal:{...await view(scope,repo,latest),currentPriceCents:error.currentPriceCents}},409);
        if(latest.status==="executing")
          return conversationJson({state:"uncertain",error:"effect_outcome_uncertain",
            proposal:await view(scope,repo,latest)},409);
        return conversationJson({state:"conflict",proposal:await view(scope,repo,latest)},409);
      }
      const latest=await repo.load(scope,p.id);
      if(latest.status==="draft"||latest.status==="approved")
        return conversationJson({state:"conflict",proposal:await view(scope,repo,latest)},409);
      return conversationJson({proposal:await view(scope,repo,latest)},latest.status==="executing"?500:200);
    }
  }catch(error){return conversationError(error);}
}
