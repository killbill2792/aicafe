import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {fromZonedTime} from "date-fns-tz";
import {activeBinding,type BoundOwner} from "./identity.server";
import {enqueueWhatsApp,dispatchOutboundOnce} from "./queue.server";
import {providerAllowed} from "./transport.server";
import {validTemplateFields} from "./transport";
import {briefWindow,briefDue} from "@/lib/operating/dailyBrief";
import {readPreparedMorningBrief} from "./morningBrief.server";
import {renderMorningBrief,type PreparedMorningBrief} from "./morningBrief";

export type BriefScope={businessId:string;ownerUserId:string;threadId?:string;
  businessName:string;currency:string|null;timezone:string;today:string;yesterday:string};
export type EligibleBrief={binding:BoundOwner;prepared:PreparedMorningBrief;websiteText:string};

/** Read only PR A's explicitly selected, consented recipient. Never create a binding,
 * silently select a café, or infer WhatsApp ownership from the website session. */
export async function eligibleBriefBinding(db:SupabaseClient,scope:Omit<BriefScope,"threadId">):
 Promise<BoundOwner|null>{
  if(!providerAllowed("daily_brief")||
     process.env.WHATSAPP_OWNER_REPLY_SEND_ENABLED!=="true"||
     process.env.WHATSAPP_MONITOR_FOLLOWUP_APPROVED!=="true")return null;
  const {data,error}=await db.from("whatsapp_owner_bindings").select("id")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("opted_in",true).is("revoked_at",null).limit(2);
  if(error||data?.length!==1)return null;
  const binding=await activeBinding(data[0].id);
  return binding?.businessId===scope.businessId&&binding.ownerUserId===scope.ownerUserId?binding:null;
}

/** A free-form follow-up can be promised only if the existing owner-opened
 * service window covers the café's operating-day observation horizon.
 * Any missing/invalid timestamp fails closed; a provider-send flag alone is NOT permission. */
function followupWindowCoversDay(binding:BoundOwner,scope:BriefScope,now:Date):boolean{
  const opened=Date.parse(binding.lastOwnerMessageAt??"");
  if(!Number.isFinite(opened)||opened>now.getTime()||now.getTime()-opened>=86_400_000)return false;
  const horizon=fromZonedTime(scope.today+"T20:00:00",scope.timezone).getTime();
  return Number.isFinite(horizon)&&opened+86_400_000>horizon;
}

/** Producer uses these EXACT parameters for the website copy and durable outbox.
 * No second event search, financial math or notification state. */
export async function prepareBoundBrief(db:SupabaseClient,scope:BriefScope,now:Date,
  binding:BoundOwner|null):Promise<EligibleBrief|null>{
  if(!binding||!scope.threadId||binding.threadId!==scope.threadId)return null;
  const w=briefWindow(now,scope.timezone);
  if(!w.readyToPublish||!w.beforeDeadline||!followupWindowCoversDay(binding,scope,now))return null;
  const prepared=await readPreparedMorningBrief(db,{...scope,verifiedBinding:true,
    followupPermitted:true},now);
  if(!prepared||!validTemplateFields(prepared.parameters))return null;
  return {binding,prepared,websiteText:renderMorningBrief(prepared.parameters)};
}

/** Queue one per (café, owner, local today), anchored to the original web brief.
 * PR A owns all unique indexes, verified bindings and actual provider dispatch. */
export async function enqueueBoundBrief(input:EligibleBrief,scope:BriefScope,
  websiteMessageId:string,now:Date):Promise<void>{
  const w=briefWindow(now,scope.timezone);
  if(!w.readyToPublish||!w.beforeDeadline||!providerAllowed("daily_brief")||
    input.binding.businessId!==scope.businessId||
    input.binding.ownerUserId!==scope.ownerUserId||
    input.binding.threadId!==scope.threadId)return;
  const live=await activeBinding(input.binding.id);
  if(!live||live.businessId!==scope.businessId||live.ownerUserId!==scope.ownerUserId||
     live.threadId!==scope.threadId||!followupWindowCoversDay(live,scope,now))return;
  await enqueueWhatsApp(live.id,
    ["daily-brief",scope.businessId,scope.ownerUserId,scope.today].join(":"),
    {kind:"daily_brief",fields:input.prepared.parameters},
    {source:"canonical_daily_brief",period:input.prepared.businessDate,
      eventId:input.prepared.provenance.eventId,
      monitorId:input.prepared.provenance.monitorProposalId,
      readerSources:input.prepared.provenance},
    websiteMessageId,undefined,scope.today);
}

/** Send only through PR A's canonical worker and only when the staged SQL
 * claim-deadline guard is installed. No alternative queue or provider client.
 * A final request-time check prevents a lease obtained at 05:59:59 from
 * initiating a Meta send after 06:00. */
function briefFollowupAllowed():boolean{
  return providerAllowed("daily_brief")&&
    process.env.WHATSAPP_OWNER_REPLY_SEND_ENABLED==="true"&&
    process.env.WHATSAPP_MONITOR_FOLLOWUP_APPROVED==="true";
}
export async function dispatchDueMorningBriefs(db:SupabaseClient,
  send:typeof fetch=fetch,clock:()=>Date=()=>new Date()):Promise<number>{
  if(!briefFollowupAllowed())return 0;
  const {data:ready,error}=await db.rpc("whatsapp_brief_dispatch_ready");
  if(error||ready!==true)return 0;
  const guardedSend:typeof fetch=async(url,init)=>{
    const rejected=()=>new Response(null,{status:400});
    if(!briefFollowupAllowed())return rejected();
    if(typeof init?.body!=="string")return rejected();
    let to:string;
    try{
      const envelope=JSON.parse(init.body) as {to?:unknown;type?:unknown};
      if(envelope.type!=="template"||typeof envelope.to!=="string")return rejected();
      to=envelope.to;
    }catch{return rejected();}
    const {data:bindings,error:bindingError}=await db.from("whatsapp_owner_bindings")
      .select("id").eq("wa_id",to).eq("opted_in",true).is("revoked_at",null).limit(2);
    if(bindingError||bindings?.length!==1)return rejected();
    const bound=await activeBinding(bindings[0].id);
    if(!bound||bound.waId!==to)return rejected();
    const [lease,cafe]=await Promise.all([
      db.from("whatsapp_outbox").select("business_date")
        .eq("binding_id",bound.id).eq("kind","daily_brief").eq("state","leased").limit(2),
      db.from("businesses").select("timezone").eq("id",bound.businessId).maybeSingle(),
    ]);
    if(lease.error||cafe.error||lease.data?.length!==1||!cafe.data?.timezone)return rejected();
    const actual=clock(),due=briefDue(actual,cafe.data.timezone);
    const window=briefWindow(actual,cafe.data.timezone);
    if(!due.due||!window.readyToPublish||!window.beforeDeadline||
       due.today!==lease.data[0].business_date||!briefFollowupAllowed())return rejected();
    return send(url,init);
  };
  let accepted=0;
  for(let i=0;i<10;i++){
    const state=await dispatchOutboundOnce("daily_brief",guardedSend);
    if(state==="empty"||state==="disabled")break;
    if(state==="accepted")accepted++;
    if(state==="retry"||state==="uncertain")break;
  }
  return accepted;
}
