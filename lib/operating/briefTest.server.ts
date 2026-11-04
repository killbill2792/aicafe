import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {runCafeBrief,type CafeBriefResult} from "./dailyBrief.server";
import {briefOutboxHook,dispatchDueMorningBriefs,BRIEF_SEND_MIGRATION,whatsappBriefSendReady} from "@/lib/whatsapp/morningBriefDelivery.server";
import {providerBlockers} from "@/lib/whatsapp/transport.server";

/** Admin "Send test brief now": the same producer, outbox and dispatcher as the
 * cron. It skips ONLY the time-of-day rule. It sends today's brief (one per café,
 * owner and local day), so the scheduled run will not send a second one today. */
export type TestBriefVerdict={sent:boolean;step:string;reason:string;details?:Record<string,unknown>};
export type TestBriefReport={verdict:TestBriefVerdict;settings:{name:string;on:boolean}[];
  migrationReady:boolean;result:CafeBriefResult|null;
  dispatch:{accepted:number;reason?:string;details?:Record<string,unknown>}|null;
  outbox:Array<{ownerUserId:string;state:string;failureCode:string|null}>};

export function briefSettings():{name:string;on:boolean}[]{
  const blocked=new Set(providerBlockers("daily_brief"));
  return [
    {name:"DAILY_BRIEF_ENABLED",on:process.env.DAILY_BRIEF_ENABLED==="true"},
    ...["WHATSAPP_PROVIDER_SEND_ENABLED","WHATSAPP_POLICY_APPROVED","WHATSAPP_OWNER_BRIEF_SEND_ENABLED",
      "WHATSAPP_TEMPLATE_APPROVED","META_WHATSAPP_TOKEN","WHATSAPP_PHONE_NUMBER_ID (must be the Meta test number)"]
      .map(name=>({name,on:!blocked.has(name)})),
  ];
}

/** The first thing that stopped the brief, in the order the brief runs. */
export function testBriefVerdict(r:Omit<TestBriefReport,"verdict">):TestBriefVerdict{
  const off=r.settings.find(s=>!s.on&&s.name==="DAILY_BRIEF_ENABLED");
  if(off)return {sent:false,step:"settings",reason:"setting_off",details:{settings:[off.name]}};
  const result=r.result;
  if(!result)return {sent:false,step:"brief",reason:"brief_unavailable"};
  if(!result.owners.length)return {sent:false,step:result.step,reason:result.reason,details:result.details};
  const owner=result.owners.find(o=>o.whatsapp.outcome==="queued")??result.owners[0];
  if(owner.inApp.outcome==="failed"||owner.inApp.outcome==="skipped")
    return {sent:false,step:owner.inApp.step,reason:owner.inApp.reason,details:owner.inApp.details};
  if(owner.whatsapp.outcome!=="queued")
    return {sent:false,step:owner.whatsapp.step,reason:owner.whatsapp.reason,details:owner.whatsapp.details};
  const row=r.outbox.find(o=>o.ownerUserId===owner.ownerUserId);
  if(row&&["accepted","sent","delivered","read"].includes(row.state))
    return {sent:true,step:"meta",reason:"meta_accepted",details:{state:row.state}};
  if(row&&(row.state==="failed"||row.state==="uncertain"))
    return {sent:false,step:"meta",reason:row.failureCode??row.state,details:{state:row.state}};
  if(r.dispatch?.reason)return {sent:false,step:"dispatch",reason:r.dispatch.reason,details:r.dispatch.details};
  return {sent:false,step:"dispatch",reason:"queued_not_sent_yet",details:{state:row?.state??"unknown"}};
}

export async function sendTestBrief(db:SupabaseClient,businessId:string,now=new Date()):Promise<TestBriefReport|null>{
  const {data:b,error}=await db.from("businesses").select("id,name,timezone,currency,is_demo")
    .eq("id",businessId).maybeSingle();
  if(error)throw new Error("business_unavailable");
  if(!b)return null;
  const settings=briefSettings();
  const migrationReady=await whatsappBriefSendReady(db);
  const base={settings,migrationReady,result:null,dispatch:null,outbox:[]};
  if(process.env.DAILY_BRIEF_ENABLED!=="true")
    return {...base,verdict:testBriefVerdict(base)};
  const result=await runCafeBrief(db,b,now,{kind:"test",outbox:briefOutboxHook(db,now)});
  const dispatch=await dispatchDueMorningBriefs(db);
  const rows=result.localDate?await db.from("whatsapp_outbox").select("owner_user_id,state,failure_code")
    .eq("business_id",b.id).eq("kind","daily_brief").eq("business_date",result.localDate).limit(20):null;
  const outbox=(rows?.data??[]).map(o=>({ownerUserId:String(o.owner_user_id),state:String(o.state),
    failureCode:o.failure_code??null}));
  const report={settings,migrationReady,result,dispatch,outbox};
  const verdict=testBriefVerdict(report);
  return {...report,verdict:!migrationReady&&verdict.reason==="whatsapp_setting_off"
    ?{...verdict,details:{...verdict.details,migration:BRIEF_SEND_MIGRATION+" (not applied)"}}:verdict};
}
