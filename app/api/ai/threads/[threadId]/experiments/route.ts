import {z} from "zod";
import {formatInTimeZone} from "date-fns-tz";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin}
  from "@/lib/ai/conversations/http.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {supervisorLoopRegistry,priceExperimentCapabilityId}
  from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import {simulateLoop,proposeLoop,approveLoop,commitLoop,
  confirmManualLoop,monitorLoop,utcDateOffset,type OwnerLoopScope} from "@/lib/ai/supervisor/loop/engine";
export const runtime="nodejs";export const dynamic="force-dynamic";
type Params={params:Promise<{threadId:string}>};
const uuid=z.uuid();
const action=z.discriminatedUnion("action",[
 z.strictObject({action:z.literal("simulate"),productId:uuid,increaseCents:z.number().int().safe().positive().max(100000)}),
 z.strictObject({action:z.literal("propose"),productId:uuid,increaseCents:z.number().int().safe().positive().max(100000),
   requestKey:uuid,locale:z.enum(["en","es","ar"])}),
 z.strictObject({action:z.literal("approve"),proposalId:uuid,revision:z.number().int().positive()}),
 z.strictObject({action:z.literal("reject"),proposalId:uuid,revision:z.number().int().positive()}),
 z.strictObject({action:z.literal("commit"),proposalId:uuid,revision:z.number().int().positive()}),
 z.strictObject({action:z.literal("manual_done"),proposalId:uuid,revision:z.number().int().positive()}),
 z.strictObject({action:z.literal("report"),proposalId:uuid}),
]);
async function context(threadId:string,locale:"en"|"es"|"ar"="en"){
 const {scope,service}=await authenticatedConversationContext();
 await service.getThread(uuid.parse(threadId));
 return {service,scope:{...scope,threadId,locale} as OwnerLoopScope};
}
export async function GET(request:Request,{params}:Params){
 try{
  const {threadId}=await params;
  const {scope}=await context(threadId);
  const db=createAdminSupabaseClient();
  const {data,error}=await db.from("supervisor_proposals")
    .select("id,capability_id,revision,status,canonical_effect_payload,baseline,monitoring_start_date,created_at")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("thread_id",threadId).order("created_at",{ascending:false}).limit(30);
  if(error)throw error;
  const selected=new URL(request.url).searchParams.get("proposal");
  const proposals=[...(data??[])];
  // A deep link from an old Operations task still opens that *exact*
  // experiment even when it is older than the recent-proposals page.
  if(selected&&uuid.safeParse(selected).success&&!proposals.some(p=>p.id===selected)){
    const requested=await db.from("supervisor_proposals")
      .select("id,capability_id,revision,status,canonical_effect_payload,baseline,monitoring_start_date,created_at")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("thread_id",threadId).eq("id",selected).maybeSingle();
    if(requested.error)throw requested.error;
    if(requested.data)proposals.unshift(requested.data);
  }
  const catalog=(await getMenuControlCenter()).filter(item=>item.active)
    .map(({id,name,priceCents})=>({id,name,priceCents}));
  return conversationJson({proposals,catalog});
 }catch(error){return conversationError(error);}
}
export async function POST(request:Request,{params}:Params){
 try{
  requireSameOrigin(request);
  const {threadId}=await params;
  const input=parseInput(action,await readBoundedJson(request));
  const {scope:base}=await context(threadId);
  await assertCafeAiAccess(base.businessId);
  const scope={...base,locale:input.action==="propose"?input.locale:base.locale};
  const repo=new SupabaseLoopRepository();
  switch(input.action){
   case "simulate":return conversationJson({simulation:await simulateLoop(scope,
       supervisorLoopRegistry,priceExperimentCapabilityId,
       {productId:input.productId,increaseCents:input.increaseCents})});
   case "propose":return conversationJson({proposal:await proposeLoop(scope,
       supervisorLoopRegistry,repo,priceExperimentCapabilityId,
       {productId:input.productId,increaseCents:input.increaseCents},input.requestKey)});
   case "approve":return conversationJson({proposal:await approveLoop(scope,repo,input.proposalId,input.revision)});
   case "reject":return conversationJson({proposal:await repo.transition(scope,
       input.proposalId,input.revision,"reject")});
   case "commit":return conversationJson(await commitLoop(scope,supervisorLoopRegistry,
       repo,input.proposalId,input.revision));
   case "manual_done":{
     const db=createAdminSupabaseClient();
     const {data,error}=await db.from("businesses").select("timezone")
       .eq("id",scope.businessId).single();
     if(error||!data)throw new Error("Owner business timezone unavailable");
     const now=formatInTimeZone(new Date(),data.timezone||"America/Los_Angeles","yyyy-MM-dd");
     const start=utcDateOffset(now,1);
     return conversationJson({proposal:await confirmManualLoop(scope,repo,input.proposalId,
       input.revision,start)});
   }
   case "report":{
     const p=await repo.load(scope,input.proposalId);
     if(p.status==="monitored"){
       const db=createAdminSupabaseClient();
       const {data,error}=await db.from("supervisor_reports")
         .select("status,report").eq("business_id",scope.businessId)
         .eq("proposal_id",p.id).maybeSingle();
       if(error)throw error;
       return conversationJson({report:data??null});
     }
     const db=createAdminSupabaseClient();
     const {data,error}=await db.from("businesses").select("timezone")
       .eq("id",scope.businessId).single();
     if(error||!data)throw new Error("Owner business timezone unavailable");
     const today=formatInTimeZone(new Date(),data.timezone||"America/Los_Angeles","yyyy-MM-dd");
     const report=await monitorLoop(scope,supervisorLoopRegistry,repo,p,utcDateOffset(today,-1),true);
     return conversationJson({report});
   }
  }
 }catch(error){return conversationError(error);}
}
