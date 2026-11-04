import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {activeBinding,type BoundOwner} from "./identity.server";
import {enqueueWhatsApp,dispatchOutboundOnce} from "./queue.server";
import {providerAllowed,providerBlockers} from "./transport.server";
import {localClock} from "@/lib/pos/toast/scheduleDates";
import {briefTemplateFor} from "./briefTemplates";
import {prepareMorningBrief,renderMorningBrief,type BriefContent,type PreparedMorningBrief} from "./morningBrief";

/** The morning brief is an approved Meta TEMPLATE. Meta allows a template at any
 * time, so this path never checks the 24-hour customer-service window (that rule
 * is only for free text: whatsappFreeTextAllowed in ./supervisor). Safety kept:
 * only a verified, opted-in, non-revoked owner binding; every send flag; the
 * Meta test phone number; no replay on an ambiguous Meta response (queue).
 * Every "no" carries a reason so the caller can record it. */
export const BRIEF_SEND_MIGRATION="20261104000148_morning_brief_send_window.sql";
export type BriefScope={businessId:string;ownerUserId:string;threadId?:string;
  businessName:string;currency:string|null;timezone:string;today:string;yesterday:string};
export type Blocked={reason:string;details?:Record<string,unknown>};
export type EligibleBrief={binding:BoundOwner;prepared:PreparedMorningBrief;websiteText:string};

/** Read only the explicitly selected, consented recipient. Never create a binding,
 * silently select a café, or infer WhatsApp ownership from the website session. */
export async function eligibleBriefBinding(db:SupabaseClient,scope:Omit<BriefScope,"threadId">):
 Promise<{binding:BoundOwner}|Blocked>{
  const settings=providerBlockers("daily_brief");
  if(settings.length)return {reason:"whatsapp_setting_off",details:{settings}};
  const {data,error}=await db.from("whatsapp_owner_bindings").select("id")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("opted_in",true).is("revoked_at",null).limit(2);
  if(error)return {reason:"whatsapp_binding_read_failed"};
  if(!data?.length)return {reason:"no_linked_whatsapp_number"};
  if(data.length>1)return {reason:"more_than_one_whatsapp_binding"};
  const binding=await activeBinding(data[0].id);
  if(!binding)return {reason:"whatsapp_binding_not_verified"};
  if(binding.businessId!==scope.businessId||binding.ownerUserId!==scope.ownerUserId)
    return {reason:"whatsapp_binding_other_cafe"};
  return {binding};
}

/** The exact template blanks the website copy and the outbox both use. */
export function prepareBoundBrief(content:BriefContent,binding:BoundOwner,threadId:string):
 {brief:EligibleBrief}|Blocked{
  if(binding.threadId!==threadId)return {reason:"whatsapp_binding_thread_mismatch"};
  const template=briefTemplateFor(content.event.kind==="today");
  const prepared=prepareMorningBrief(content,template);
  if(!prepared)return {reason:"invalid_template_blanks",details:{template:template.name}};
  return {brief:{binding,prepared,websiteText:renderMorningBrief(prepared)}};
}

/** The deadline-aware outbox claim (migration 148) is installed. */
export async function whatsappBriefSendReady(db:SupabaseClient):Promise<boolean>{
  const {data,error}=await db.rpc("whatsapp_brief_send_window_ready");
  return !error&&data===true;
}

/** Queue one per (café, owner, local today), anchored to the saved web brief. */
export async function enqueueBoundBrief(db:SupabaseClient,input:EligibleBrief,scope:BriefScope,
  websiteMessageId:string,sendBefore:string,now:Date):Promise<{outcome:"queued"}|(Blocked&{outcome:"skipped"|"failed"})>{
  const settings=providerBlockers("daily_brief");
  if(settings.length)return {outcome:"skipped",reason:"whatsapp_setting_off",details:{settings}};
  if(!(Date.parse(sendBefore)>now.getTime()))
    return {outcome:"skipped",reason:"past_send_deadline",details:{sendBefore}};
  if(input.binding.businessId!==scope.businessId||input.binding.ownerUserId!==scope.ownerUserId||
    input.binding.threadId!==scope.threadId)return {outcome:"skipped",reason:"whatsapp_binding_scope_mismatch"};
  if(!await whatsappBriefSendReady(db))
    return {outcome:"skipped",reason:"migration_missing",details:{migration:BRIEF_SEND_MIGRATION}};
  const live=await activeBinding(input.binding.id);
  if(!live||live.businessId!==scope.businessId||live.ownerUserId!==scope.ownerUserId||
     live.threadId!==scope.threadId)return {outcome:"skipped",reason:"whatsapp_binding_not_verified"};
  try{
    await enqueueWhatsApp(live.id,
      ["daily-brief",scope.businessId,scope.ownerUserId,scope.today].join(":"),
      {kind:"daily_brief",template:input.prepared.template.name,fields:input.prepared.fields},
      {source:"canonical_daily_brief",period:input.prepared.businessDate,
        template:input.prepared.template.name,readerSources:input.prepared.provenance},
      websiteMessageId,undefined,scope.today,sendBefore);
  }catch{return {outcome:"failed",reason:"whatsapp_queue_unavailable"};}
  return {outcome:"queued"};
}

/** Send through the one canonical worker. A final request-time check makes sure
 * the leased brief is still before its own café deadline and on its local day. */
export async function dispatchDueMorningBriefs(db:SupabaseClient,
  send:typeof fetch=fetch,clock:()=>Date=()=>new Date()):Promise<{accepted:number}&Partial<Blocked>>{
  const settings=providerBlockers("daily_brief");
  if(settings.length)return {accepted:0,reason:"whatsapp_setting_off",details:{settings}};
  if(!await whatsappBriefSendReady(db))
    return {accepted:0,reason:"migration_missing",details:{migration:BRIEF_SEND_MIGRATION}};
  const guardedSend:typeof fetch=async(url,init)=>{
    const rejected=()=>new Response(null,{status:400});
    if(!providerAllowed("daily_brief"))return rejected();
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
      db.from("whatsapp_outbox").select("business_date,send_before")
        .eq("binding_id",bound.id).eq("kind","daily_brief").eq("state","leased").limit(2),
      db.from("businesses").select("timezone").eq("id",bound.businessId).maybeSingle(),
    ]);
    if(lease.error||cafe.error||lease.data?.length!==1||!cafe.data?.timezone)return rejected();
    const actual=clock(),deadline=Date.parse(String(lease.data[0].send_before??""));
    let today:string;
    try{today=localClock(actual,cafe.data.timezone).today;}catch{return rejected();}
    if(!(deadline>actual.getTime())||today!==lease.data[0].business_date||
      !providerAllowed("daily_brief"))return rejected();
    return send(url,init);
  };
  let accepted=0;
  for(let i=0;i<10;i++){
    const state=await dispatchOutboundOnce("daily_brief",guardedSend);
    if(state==="empty"||state==="disabled")break;
    if(state==="accepted")accepted++;
    if(state==="retry"||state==="uncertain")break;
  }
  return {accepted};
}

/** The one outbox hook for the morning brief, used by the cron and by the
 * admin "Send test brief now" button, so both take the same path. */
export function briefOutboxHook(db:SupabaseClient,now:Date){
  return async(input:{businessId:string;ownerUserId:string;threadId:string;websiteMessageId:string;
    businessName:string;currency:string|null;timezone:string;today:string;yesterday:string;
    eligible:EligibleBrief|null;sendBefore:string})=>{
    if(!input.eligible)return;
    return enqueueBoundBrief(db,input.eligible,{
      businessId:input.businessId,ownerUserId:input.ownerUserId,threadId:input.threadId,
      businessName:input.businessName,currency:input.currency,timezone:input.timezone,
      today:input.today,yesterday:input.yesterday},input.websiteMessageId,input.sendBefore,now);
  };
}
