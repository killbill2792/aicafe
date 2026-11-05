import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {getBusinessSnapshotFromDb} from "@/lib/data/snapshot.server";
import {readPrimaryLocation} from "@/lib/data/cafeLocation.server";
import {normalizeOpenHours} from "@/lib/business/openHours";
import {SnapshotCafeStateService} from "./cafeState";
import {briefMessageId,briefExtras,type BriefLocale} from "./dailyBrief";
import {briefSchedule,type BriefSchedule} from "./briefSchedule";
import {notifyOwner} from "./notifyOwner.server";
import {recordBriefRun,CAFE_OWNER_KEY,type BriefRunOutcome} from "./briefRuns.server";
import {readBriefEvidence,type BriefEvidenceResult} from "@/lib/whatsapp/morningBrief.server";
import {eligibleBriefBinding,prepareBoundBrief,type Blocked,type EligibleBrief} from "@/lib/whatsapp/morningBriefDelivery.server";
import {buildBriefContent,briefTemplateFields,renderMorningBrief} from "@/lib/whatsapp/morningBrief";
import {briefTemplateFor} from "@/lib/whatsapp/briefTemplates";
import type {BoundOwner} from "@/lib/whatsapp/identity.server";

/** The morning brief (AGENTS.md §4c). Every café gets one per owner and café-local
 * day, before it opens: per-café send time (briefSchedule), never blocked by a
 * missing extra, and every skip recorded with its step and reason.
 * One canonical snapshot and rollup per café, then one Supervisor message per owner. */
export type BriefRun={checked:number;sent:number;skipped:number;failed:number};
export type BriefRunKind="scheduled"|"test";
export type OutboxResult={outcome:"queued"}|(Blocked&{outcome:"skipped"|"failed"});
export type BriefOutboxHook=(input:{
  businessId:string;ownerUserId:string;threadId:string;websiteMessageId:string;
  businessName:string;currency:string|null;timezone:string;today:string;yesterday:string;now:Date;
  websiteText:string;eligible:EligibleBrief|null;sendBefore:string;
})=>Promise<OutboxResult|void>;
export type StepResult={step:string;outcome:BriefRunOutcome;reason:string;details?:Record<string,unknown>};
export type OwnerBriefResult={ownerUserId:string;inApp:StepResult;whatsapp:StepResult};
export type CafeBriefResult=StepResult&{businessId:string;localDate:string|null;
  schedule?:Pick<BriefSchedule,"phase"|"hoursSource"|"latestSendLocal"|"sendBefore">;
  missing?:string[];owners:OwnerBriefResult[]};

type Business={id:string;name?:string|null;currency:string|null;timezone:string|null;is_demo?:boolean|null};
type Historical=Awaited<ReturnType<SnapshotCafeStateService["getHistoricalState"]>>;
type CafeContext={db:SupabaseClient;b:Business&{timezone:string};schedule:BriefSchedule;now:Date;
  kind:BriefRunKind;evidence:BriefEvidenceResult;state:Historical|null;
  /** null = the attention count could not be read. */
  needsOwner:number|null;
  sendBefore:string;outbox?:BriefOutboxHook};

const states=(db:SupabaseClient)=>new SnapshotCafeStateService(
  async(id,period)=>getBusinessSnapshotFromDb(db,id,period??"month"));

/** Cron: every café, every 5 minutes; each café decides whether it is due. */
export async function sendDailyBriefs(db:SupabaseClient,now=new Date(),outbox?:BriefOutboxHook):Promise<BriefRun>{
  const run:BriefRun={checked:0,sent:0,skipped:0,failed:0};
  for(let offset=0;;offset+=100){
    const {data,error}=await db.from("businesses").select("id,name,timezone,currency,is_demo")
      .order("id",{ascending:true}).range(offset,offset+99);
    if(error)throw new Error("businesses_unavailable");
    for(const b of (data??[]) as Business[]){
      if(b.is_demo)continue; // Sample cafés have no owner to brief.
      const result=await runCafeBrief(db,b,now,{kind:"scheduled",outbox}).catch(()=>null);
      if(!result){run.checked++;run.failed++;continue;}
      if(result.reason==="not_due")continue;
      run.checked++;
      if(!result.owners.length){if(result.outcome==="failed")run.failed++;else run.skipped++;continue;}
      for(const owner of result.owners){
        if(owner.inApp.outcome==="sent"&&owner.inApp.reason==="posted")run.sent++;
        else if(owner.inApp.outcome==="failed")run.failed++;
        else run.skipped++;
      }
    }
    if((data??[]).length<100)break;
  }
  return run;
}

/** One café's brief. The cron and the admin "Send test brief now" button both
 * come here; a test run skips only the time-of-day rule. */
export async function runCafeBrief(db:SupabaseClient,b:Business,now:Date,
  opts:{kind:BriefRunKind;outbox?:BriefOutboxHook}):Promise<CafeBriefResult>{
  const utcDay=now.toISOString().slice(0,10);
  const cafeStep=async(localDate:string,r:StepResult,extra:Partial<CafeBriefResult>={}):Promise<CafeBriefResult>=>{
    // Which send time applied (incl. "default_unknown_hours") is in every record.
    const hours=extra.schedule?{latestSend:extra.schedule.latestSendLocal,hours:extra.schedule.hoursSource}:{};
    await recordBriefRun(db,{businessId:b.id,localDate,ownerKey:CAFE_OWNER_KEY,channel:"in_app",
      runKind:opts.kind,...r,details:{...hours,...r.details}},now);
    return {...r,businessId:b.id,localDate,owners:[],...extra};
  };
  if(!b.timezone)return cafeStep(utcDay,{step:"schedule",outcome:"skipped",reason:"no_timezone"});
  const timezone=b.timezone;
  const location=await readPrimaryLocation(db,b.id).catch(()=>null);
  let schedule:BriefSchedule;
  try{schedule=briefSchedule(now,timezone,normalizeOpenHours(location?.open_hours));}
  catch{return cafeStep(utcDay,{step:"schedule",outcome:"skipped",reason:"invalid_timezone"});}
  const scheduleInfo={phase:schedule.phase,hoursSource:schedule.hoursSource,
    latestSendLocal:schedule.latestSendLocal,sendBefore:schedule.sendBefore};
  const scheduleDetails={latestSend:schedule.latestSendLocal,hours:schedule.hoursSource};
  const test=opts.kind==="test";
  if(!test&&(schedule.phase==="early"||schedule.phase==="done"))
    return {step:"schedule",outcome:"waiting",reason:"not_due",businessId:b.id,
      localDate:schedule.today,schedule:scheduleInfo,owners:[]};
  if(test&&b.is_demo)return cafeStep(schedule.today,
    {step:"cafe",outcome:"skipped",reason:"demo_cafe"},{schedule:scheduleInfo});

  const evidence=await readBriefEvidence(db,{businessId:b.id,businessName:b.name??"",
    currency:b.currency},schedule,now);
  const missing=evidence.content.missing;
  // Wait for yesterday's POS data only while there is still time before the latest send.
  if(!test&&schedule.phase==="window"&&!evidence.posComplete)
    return cafeStep(schedule.today,{step:"pos_sync",outcome:"waiting",
      reason:"yesterday_pos_data_not_complete",details:{...scheduleDetails,missing}},
      {schedule:scheduleInfo,missing});
  if(!evidence.content.hasSomethingToSay)
    return cafeStep(schedule.today,{step:"content",outcome:"skipped",reason:"nothing_to_say",
      details:{missing}},{schedule:scheduleInfo,missing});

  const owners:string[]=[];
  for(let ownerOffset=0;;ownerOffset+=100){
    const page=await db.from("memberships").select("user_id")
      .eq("business_id",b.id).eq("role","owner")
      .order("created_at",{ascending:true}).order("user_id",{ascending:true})
      .range(ownerOffset,ownerOffset+99);
    if(page.error)return cafeStep(schedule.today,{step:"owners",outcome:"failed",reason:"owners_unavailable"},
      {schedule:scheduleInfo,missing});
    owners.push(...(page.data??[]).map(row=>row.user_id));
    if((page.data??[]).length<100)break;
  }
  if(!owners.length)return cafeStep(schedule.today,{step:"owners",outcome:"skipped",reason:"no_owner"},
    {schedule:scheduleInfo,missing});
  // Cost unavailability must not suppress verified sales: the legacy text labels missing costs.
  const state:Historical|null=await states(db).getHistoricalState(b.id,
    {from:schedule.yesterday,to:schedule.yesterday}).catch(()=>null);
  // The same read-only inbox reader as Home, the Inbox and chat: one count everywhere.
  // An unreadable inbox says nothing about it (null), never "nothing needs you".
  const needsOwner=await import("@/lib/attention/getAttentionItems.server")
    .then(({readCafeNeedsYou})=>readCafeNeedsYou({client:db,businessId:b.id}))
    .then(summary=>summary.count).catch(()=>null);
  // A test after opening still gets a short window to leave the outbox.
  const sendBefore=test?new Date(Math.max(Date.parse(schedule.sendBefore),
    now.getTime()+30*60_000)).toISOString():schedule.sendBefore;
  const ctx:CafeContext={db,b:{...b,timezone},schedule,now,kind:opts.kind,evidence,state,
    needsOwner,sendBefore,outbox:opts.outbox};
  const results:OwnerBriefResult[]=[];
  for(const ownerId of [...new Set(owners)]){
    let result:OwnerBriefResult;
    try{result=await sendOne(ctx,ownerId);}
    catch{result={ownerUserId:ownerId,inApp:{step:"in_app",outcome:"failed",reason:"brief_write_failed"},
      whatsapp:{step:"whatsapp",outcome:"skipped",reason:"in_app_brief_failed"}};}
    for(const channel of ["in_app","whatsapp"] as const){
      const r=channel==="in_app"?result.inApp:result.whatsapp;
      // A re-run of an already posted brief keeps the first "posted" record.
      if(r.reason==="already_sent"||r.reason==="already_handled")continue;
      await recordBriefRun(db,{businessId:b.id,localDate:schedule.today,ownerKey:ownerId,channel,
        runKind:opts.kind,...r,details:{...scheduleDetails,phase:schedule.phase,missing,...r.details}},now);
    }
    results.push(result);
  }
  const sent=results.some(r=>r.inApp.outcome==="sent");
  return {step:"brief",outcome:sent?"sent":results.every(r=>r.inApp.outcome==="failed")?"failed":"skipped",
    reason:sent?"done":"see_owners",businessId:b.id,localDate:schedule.today,
    schedule:scheduleInfo,missing,owners:results};
}

/** The in-app brief is already saved: a WhatsApp error is recorded, never lost. */
async function callOutbox(hook:BriefOutboxHook,input:Parameters<BriefOutboxHook>[0]):Promise<OutboxResult|void>{
  try{return await hook(input);}
  catch{return {outcome:"failed",reason:"whatsapp_enqueue_error"};}
}

async function sendOne(ctx:CafeContext,ownerId:string):Promise<OwnerBriefResult>{
  const {db,b,schedule,now,evidence}=ctx;
  const done=(inApp:StepResult,whatsapp:StepResult):OwnerBriefResult=>({ownerUserId:ownerId,inApp,whatsapp});
  const fromHook=(r:OutboxResult|void|null,blocked:Blocked|null):StepResult=>
    blocked?{step:"whatsapp",outcome:"skipped",...blocked}:
    !r?{step:"whatsapp",outcome:"skipped",reason:"whatsapp_not_configured"}:
    r.outcome==="queued"?{step:"whatsapp",outcome:"queued",reason:"queued_for_send"}:
    {step:"whatsapp",...r};
  let messageId=briefMessageId(b.id,schedule.today,ownerId);
  const columns="id,business_id,thread_id,owner_user_id,structured_content";
  let sent=await db.from("ai_messages").select(columns).eq("id",messageId).maybeSingle();
  if(sent.error)throw sent.error;
  // A previously deployed café-only message belongs to ONE original owner.
  if(!sent.data){
    const old=await db.from("ai_messages").select(columns)
      .eq("id",briefMessageId(b.id,schedule.today)).maybeSingle();
    if(old.error)throw old.error;
    if(old.data?.owner_user_id===ownerId){sent=old;messageId=old.data.id;}
  }
  const persisted=sent.data;
  if(!persisted&&schedule.phase==="missed"&&ctx.kind==="scheduled")
    return done({step:"schedule",outcome:"skipped",reason:"missed_send_window",
      details:{opensAt:schedule.sendBefore}},
      {step:"whatsapp",outcome:"skipped",reason:"missed_send_window"});
  // Already posted: nothing to redo, and after the café's deadline nothing to re-offer.
  if(persisted&&(!ctx.outbox||(ctx.kind==="scheduled"&&now.getTime()>=Date.parse(ctx.sendBefore))))
    return done({step:"in_app",outcome:"sent",reason:"already_sent"},
      {step:"whatsapp",outcome:"skipped",reason:"already_handled"});
  if(persisted&&(persisted.business_id!==b.id||persisted.owner_user_id!==ownerId||!persisted.thread_id))
    return done({step:"in_app",outcome:"skipped",reason:"saved_brief_scope_mismatch"},
      {step:"whatsapp",outcome:"skipped",reason:"saved_brief_scope_mismatch"});
  // Revalidate owner membership even on retry; a service-role read is not ownership.
  const owner=await db.from("memberships").select("user_id").eq("business_id",b.id)
    .eq("role","owner").eq("user_id",ownerId).maybeSingle();
  if(owner.error)throw owner.error;
  if(owner.data?.user_id!==ownerId)return done({step:"owner",outcome:"skipped",reason:"not_an_owner"},
    {step:"whatsapp",outcome:"skipped",reason:"not_an_owner"});
  const scope={businessId:b.id,ownerUserId:ownerId,businessName:b.name??"",
    currency:b.currency,timezone:b.timezone,today:schedule.today,yesterday:schedule.yesterday};
  // Optional WhatsApp setup/reader failures must NEVER block the in-app brief.
  const bindingCheck:{binding:BoundOwner}|Blocked=ctx.outbox
    ?await eligibleBriefBinding(db,scope).catch(()=>({reason:"whatsapp_binding_read_failed"}))
    :{reason:"whatsapp_not_configured"};
  const binding="binding" in bindingCheck?bindingCheck.binding:null;
  const threadQuery=()=>db.from("ai_threads").select("id").eq("business_id",b.id)
    .eq("owner_user_id",ownerId);
  let thread=await (persisted?threadQuery().eq("id",persisted.thread_id).maybeSingle():
    binding?threadQuery().eq("id",binding.threadId).maybeSingle():
    threadQuery().order("last_message_at",{ascending:false,nullsFirst:false})
      .limit(1).maybeSingle());
  if(!persisted&&binding&&!thread.data&&!thread.error){
    thread=await threadQuery().order("last_message_at",{ascending:false,nullsFirst:false})
      .limit(1).maybeSingle();
  }
  if(thread.error)throw thread.error;
  if(!thread.data||(persisted&&thread.data.id!==persisted.thread_id))
    return done({step:"thread",outcome:"skipped",reason:"no_chat_thread"},
      {step:"whatsapp",outcome:"skipped",reason:"no_chat_thread"});
  const threadId=thread.data.id as string;
  const prepared=binding?prepareBoundBrief(evidence.content,binding,threadId):null;
  const eligible=prepared&&"brief" in prepared?prepared.brief:null;
  const localeResult=await db.from("supervisor_proposals").select("locale")
    .eq("business_id",b.id).eq("owner_user_id",ownerId)
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  const locale:BriefLocale=localeResult.data?.locale==="es"||localeResult.data?.locale==="ar"
    ?localeResult.data.locale:"en";
  // Meta needs the same certified net sales the screens show. Block WhatsApp only
  // when both numbers are known and disagree.
  const p=ctx.state?.profitability;
  const net=evidence.content.netSales;
  const disagree=Boolean(eligible&&net.known&&p?.available&&p.value.netSalesCents!==net.cents);
  const blocked:Blocked|null=!binding?bindingCheck as Blocked:
    prepared&&!("brief" in prepared)?prepared:
    disagree?{reason:"numbers_disagree_with_snapshot"}:null;
  const matched=blocked?null:eligible;
  const hookInput=(websiteText:string)=>({...scope,threadId,websiteMessageId:messageId,now,
    websiteText,eligible:matched,sendBefore:ctx.sendBefore});

  if(persisted){
    const stored=persisted.structured_content as Array<{type?:string;text?:string}>|null;
    const websiteText=stored?.find(block=>block.type==="text")?.text;
    if(!websiteText)throw new Error("daily_brief_website_message_missing");
    // A previous run might have committed ai_messages and crashed before the
    // Operations upsert. Repair the SAME inbox row without a second notification.
    const taskId="daily-brief:"+schedule.today+":"+ownerId;
    const existingTask=await db.from("operating_tasks").select("id")
      .eq("business_id",b.id).eq("id",taskId).maybeSingle();
    if(existingTask.error)throw existingTask.error;
    const legacyTask=await db.from("operating_tasks").select("id")
      .eq("business_id",b.id).eq("id","daily-brief:"+schedule.today).maybeSingle();
    if(legacyTask.error)throw legacyTask.error;
    if(!existingTask.data&&!legacyTask.data){
      const recovered=await db.from("operating_tasks").upsert({
        business_id:b.id,id:taskId,agent_id:"leo",kind:"daily_brief",
        status:"watching",confidence:"low",
        payload:{ownerUserId:ownerId,businessDate:schedule.yesterday,
          threadId,messageId,text:websiteText},
        evidence:[{source:"historical_rollups",facts:{businessDate:schedule.yesterday}}],
      },{onConflict:"business_id,id",ignoreDuplicates:true});
      if(recovered.error)throw recovered.error;
    }
    // English owners saw the template text itself: offer only that exact text.
    const sameText=!matched||locale!=="en"||websiteText.startsWith(matched.websiteText);
    const r=await callOutbox(ctx.outbox!,{...hookInput(websiteText),eligible:sameText?matched:null});
    return done({step:"in_app",outcome:"sent",reason:"already_sent"},
      fromHook(r,blocked??(sameText?null:{reason:"saved_brief_text_differs"})));
  }
  const complete=ctx.state?.businessCosts.completeness==="complete";
  // Every owner gets the full brief (sales, items, best seller, event) in their
  // language, whether or not WhatsApp is set up. English owners see exactly the
  // template text WhatsApp sends; the extra line adds costs and what needs them.
  const template=matched?.prepared.template??briefTemplateFor(evidence.content.event.kind==="today");
  const briefBody=locale==="en"?matched?.websiteText??renderMorningBrief({template,
    fields:briefTemplateFields(evidence.content,template)}):
    renderMorningBrief({template,fields:briefTemplateFields(
      buildBriefContent(evidence.evidence,now,locale),template)},locale);
  const extras=briefExtras({locale,currency:b.currency,needsOwner:ctx.needsOwner,
    costs:net.known&&p?.available&&p.value.netSalesCents===net.cents?{totalCostsCents:p.value.totalCostsCents,
      ownerProfitCents:p.value.ownerProfitCents,complete}:null});
  const text=extras?briefBody+"\n\n"+extras:briefBody;
  const notice=await notifyOwner(db,{
    businessId:b.id,ownerUserId:ownerId,threadId,
    taskId:"daily-brief:"+schedule.today+":"+ownerId,
    kind:"daily_brief",localDate:schedule.today,important:true,required:true,
  },async()=>{
  const inserted=await db.from("ai_messages").insert({
    id:messageId,business_id:b.id,thread_id:threadId,owner_user_id:ownerId,author_user_id:null,
    role:"supervisor",content_type:"blocks",text_content:null,structured_content:[{type:"text",text}],
    grounding:{status:net.known&&complete?"estimated":"partial",
      intent:"cafe_overview",evidence:[{source:"historical_rollups",
        identifier:"daily-brief:"+schedule.yesterday,asOf:schedule.today}]},
  });
  if(inserted.error){
    if(inserted.error.code==="23505")return done({step:"in_app",outcome:"sent",reason:"already_sent"},
      {step:"whatsapp",outcome:"skipped",reason:"already_handled_by_another_run"});
    throw inserted.error;
  }
  // One task per owner/day; retire only THIS owner's previous tasks.
  const taskId="daily-brief:"+schedule.today+":"+ownerId;
  const task=await db.from("operating_tasks").upsert({business_id:b.id,id:taskId,agent_id:"leo",
    kind:"daily_brief",status:"watching",confidence:complete?"high":"low",
    payload:{ownerUserId:ownerId,businessDate:schedule.yesterday,threadId,messageId,text},
    evidence:[{source:"historical_rollups",facts:{businessDate:schedule.yesterday}}]},
    {onConflict:"business_id,id",ignoreDuplicates:true});
  if(task.error)throw task.error;
  const retired=await db.from("operating_tasks").update({
    status:"expired",resolved_at:now.toISOString(),updated_at:now.toISOString()})
    .eq("business_id",b.id).eq("kind","daily_brief")
    .eq("payload->>ownerUserId",ownerId).eq("status","watching").neq("id",taskId);
  if(retired.error)throw retired.error;
  const r=ctx.outbox?await callOutbox(ctx.outbox,hookInput(text)):null;
  return done({step:"in_app",outcome:"sent",reason:"posted",
    details:{late:schedule.phase==="late",posComplete:evidence.posComplete}},fromHook(r,blocked));
  });
  if(!notice.result)throw new Error("Required morning brief notice was not published");
  return notice.result;
}
