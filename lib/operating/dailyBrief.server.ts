import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {getBusinessSnapshotFromDb} from "@/lib/data/snapshot.server";
import {SnapshotCafeStateService} from "./cafeState";
import {briefDue,briefMessageId,briefText,briefWindow,type BriefLocale} from "./dailyBrief";
import {readDailyFactRows} from "@/lib/data/dailyFacts.server";
import {eligibleBriefBinding,prepareBoundBrief,type EligibleBrief} from "@/lib/whatsapp/morningBriefDelivery.server";

export type BriefRun={checked:number;sent:number;skipped:number;failed:number};
export type BriefOutboxHook=(input:{
  businessId:string;ownerUserId:string;threadId:string;websiteMessageId:string;
  businessName:string;currency:string|null;timezone:string;today:string;yesterday:string;now:Date;
  websiteText:string;eligible:EligibleBrief|null;
})=>Promise<void>;

type Business={id:string;name?:string;currency:string|null;timezone:string};
type Daily=Awaited<ReturnType<typeof readDailyFactRows>>[number];
type Historical=Awaited<ReturnType<SnapshotCafeStateService["getHistoricalState"]>>;

/** One café-local morning window, one canonical historical snapshot and rollup
 * per café, then a distinct authorized Supervisor message per owner. No second
 * financial reader, message system or per-owner duplicate Operations notification. */
export async function sendDailyBriefs(db:SupabaseClient,now=new Date(),outbox?:BriefOutboxHook):Promise<BriefRun>{
  const run:BriefRun={checked:0,sent:0,skipped:0,failed:0};
  const states=new SnapshotCafeStateService(async(id,period)=>getBusinessSnapshotFromDb(db,id,period??"month"));
  for(let offset=0;;offset+=100){
    const {data,error}=await db.from("businesses").select("id,name,timezone,currency,is_demo")
      .order("id",{ascending:true}).range(offset,offset+99);
    if(error)throw new Error("businesses_unavailable");
    for(const b of data??[]){
      if(b.is_demo||!b.timezone)continue;
      const when=briefDue(now,b.timezone),w=briefWindow(now,b.timezone);
      if(!when.due)continue;
      run.checked++;
      if(!w.readyToPublish){run.skipped++;continue;}
      try{
        const rows=await readDailyFactRows(db,b.id,when.yesterday,when.yesterday);
        const daily=rows.length===1&&rows[0].business_date===when.yesterday&&
          rows[0].sales_data_status==="actual"&&Number.isSafeInteger(rows[0].net_sales_cents)
          ?rows[0]:null;
        // Toast closeout may arrive between 05:00 and 05:50. Do not permanently
        // publish a no-sales message while there is still time to receive it.
        if(w.beforeDeadline&&!daily){run.skipped++;continue;}
        const owners:string[]=[];
        for(let ownerOffset=0;;ownerOffset+=100){
          const page=await db.from("memberships").select("user_id")
            .eq("business_id",b.id).eq("role","owner")
            .order("created_at",{ascending:true}).order("user_id",{ascending:true})
            .range(ownerOffset,ownerOffset+99);
          if(page.error)throw page.error;
          owners.push(...(page.data??[]).map(row=>row.user_id));
          if((page.data??[]).length<100)break;
        }
        if(!owners.length){run.skipped++;continue;}
        // Cost unavailability must not suppress verified sales. The existing
        // briefText receives only actual evidence and labels missing costs.
        const state:Historical|null=await states.getHistoricalState(b.id,
          {from:when.yesterday,to:when.yesterday}).catch(()=>null);
        const tasks=await db.from("operating_tasks").select("id",{count:"exact",head:true})
          .eq("business_id",b.id).eq("status","needs_owner");
        if(tasks.error)throw tasks.error;
        for(const ownerId of [...new Set(owners)]){
          try{
            if(await sendOne(db,b as Business,ownerId,when,now,daily,state,tasks.count??0,outbox))
              run.sent++;
            else run.skipped++;
          }catch{run.failed++;}
        }
      }catch{run.failed++;}
    }
    if((data??[]).length<100)break;
  }
  return run;
}

async function sendOne(db:SupabaseClient,b:Business,ownerId:string,
  when:{today:string;yesterday:string},now:Date,daily:Daily|null,
  state:Historical|null,needsOwner:number,outbox?:BriefOutboxHook):Promise<boolean>{
  let messageId=briefMessageId(b.id,when.today,ownerId);
  const columns="id,business_id,thread_id,owner_user_id,structured_content";
  let sent=await db.from("ai_messages").select(columns).eq("id",messageId).maybeSingle();
  if(sent.error)throw sent.error;
  // A previously deployed café-only message belongs to ONE original owner.
  // Reuse it rather than create a duplicate for that owner during rollout.
  if(!sent.data){
    const old=await db.from("ai_messages").select(columns)
      .eq("id",briefMessageId(b.id,when.today)).maybeSingle();
    if(old.error)throw old.error;
    if(old.data?.owner_user_id===ownerId){sent=old;messageId=old.data.id;}
  }
  if(sent.data&&!outbox)return false;
  const persisted=sent.data;
  if(persisted&&(persisted.business_id!==b.id||
    persisted.owner_user_id!==ownerId||!persisted.thread_id))return false;
  // Revalidate owner membership even on retry; service-role reads alone do not
  // confer the right to send a cross-café briefing.
  const owner=await db.from("memberships").select("user_id").eq("business_id",b.id)
    .eq("role","owner").eq("user_id",ownerId).maybeSingle();
  if(owner.error)throw owner.error;
  if(owner.data?.user_id!==ownerId)return false;
  const scope={businessId:b.id,ownerUserId:ownerId,businessName:b.name??"",
    currency:b.currency,timezone:b.timezone,today:when.today,yesterday:when.yesterday};
  // Optional WhatsApp setup/reader failures must NEVER block the in-app brief.
  const binding=outbox?await eligibleBriefBinding(db,scope).catch(()=>null):null;
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
  if(!thread.data||(persisted&&thread.data.id!==persisted.thread_id))return false;
  const eligible=outbox?await prepareBoundBrief(db,{...scope,threadId:thread.data.id},
    now,binding).catch(()=>null):null;
  if(persisted){
    const stored=persisted.structured_content as Array<{type?:string;text?:string}>|null;
    const websiteText=stored?.find(block=>block.type==="text")?.text;
    if(!websiteText)throw new Error("daily_brief_website_message_missing");
    // A previous run might have committed ai_messages and crashed before the
    // Operations upsert. Repair the SAME inbox row without creating a second
    // notification or reviving a handled/expired task.
    const taskId="daily-brief:"+when.today+":"+ownerId;
    const existingTask=await db.from("operating_tasks").select("id")
      .eq("business_id",b.id).eq("id",taskId).maybeSingle();
    if(existingTask.error)throw existingTask.error;
    const legacyTask=await db.from("operating_tasks").select("id")
      .eq("business_id",b.id).eq("id","daily-brief:"+when.today).maybeSingle();
    if(legacyTask.error)throw legacyTask.error;
    if(!existingTask.data&&!legacyTask.data){
      const recovered=await db.from("operating_tasks").upsert({
        business_id:b.id,id:taskId,agent_id:"leo",kind:"daily_brief",
        status:"watching",confidence:"low",
        payload:{ownerUserId:ownerId,businessDate:when.yesterday,
          threadId:thread.data.id,messageId,text:websiteText},
        evidence:[{source:"historical_rollups",facts:{businessDate:when.yesterday}}],
      },{onConflict:"business_id,id",ignoreDuplicates:true});
      if(recovered.error)throw recovered.error;
    }
    await outbox!({...scope,threadId:thread.data.id,websiteMessageId:messageId,
      now,websiteText,eligible:eligible?.websiteText===websiteText?eligible:null});
    return false;
  }
  const localeResult=await db.from("supervisor_proposals").select("locale")
    .eq("business_id",b.id).eq("owner_user_id",ownerId)
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  const locale:BriefLocale=localeResult.data?.locale==="es"||localeResult.data?.locale==="ar"
    ?localeResult.data.locale:"en";
  const p=state?.profitability;
  const sameNet=Boolean(daily&&p?.available&&p.value.netSalesCents===daily.net_sales_cents);
  const legacyText=briefText({locale,currency:b.currency,needsOwner,
    yesterday:sameNet&&p?.available?{netSalesCents:p.value.netSalesCents,
      totalCostsCents:p.value.totalCostsCents,ownerProfitCents:p.value.ownerProfitCents,
      complete:state?.businessCosts.completeness==="complete"}:null,
    verifiedNetSalesCents:daily?.net_sales_cents??null});
  // Meta needs certified net sales, not complete wage/bill profitability.
  // Only block on a snapshot disagreement when that snapshot is available.
  const matched=locale==="en"&&eligible&&daily&&
    (!p?.available||sameNet)&&eligible.prepared.netSalesCents===daily.net_sales_cents
    ?eligible:null;
  const text=matched?matched.websiteText:legacyText;
  const inserted=await db.from("ai_messages").insert({
    id:messageId,business_id:b.id,thread_id:thread.data.id,owner_user_id:ownerId,author_user_id:null,
    role:"supervisor",content_type:"blocks",text_content:null,structured_content:[{type:"text",text}],
    grounding:{status:sameNet&&state?.businessCosts.completeness==="complete"?"estimated":"partial",
      intent:"cafe_overview",evidence:[{source:"historical_rollups",
        identifier:"daily-brief:"+when.yesterday,asOf:when.today}]},
  });
  if(inserted.error){if(inserted.error.code==="23505")return false;throw inserted.error;}
  // One task per owner/day, protected by owner-scoped RLS in staged migration 134.
  // Retire only THIS owner's previous tasks, never another owner's current brief.
  const taskId="daily-brief:"+when.today+":"+ownerId;
  const task=await db.from("operating_tasks").upsert({business_id:b.id,id:taskId,agent_id:"leo",
    kind:"daily_brief",status:"watching",
    confidence:state?.businessCosts.completeness==="complete"?"high":"low",
    payload:{ownerUserId:ownerId,businessDate:when.yesterday,
      threadId:thread.data.id,messageId,text},
    evidence:[{source:"historical_rollups",facts:{businessDate:when.yesterday}}]},
    {onConflict:"business_id,id",ignoreDuplicates:true});
  if(task.error)throw task.error;
  const retired=await db.from("operating_tasks").update({
    status:"expired",resolved_at:now.toISOString(),updated_at:now.toISOString()})
    .eq("business_id",b.id).eq("kind","daily_brief")
    .eq("payload->>ownerUserId",ownerId).eq("status","watching").neq("id",taskId);
  if(retired.error)throw retired.error;
  if(outbox)await outbox({...scope,threadId:thread.data.id,websiteMessageId:messageId,
    now,websiteText:text,eligible:matched});
  return true;
}
