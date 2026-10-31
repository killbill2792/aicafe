import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {getBusinessSnapshotFromDb} from "@/lib/data/snapshot.server";
import {SnapshotCafeStateService} from "./cafeState";
import {briefDue,briefMessageId,briefText,type BriefLocale} from "./dailyBrief";

export type BriefRun={checked:number;sent:number;skipped:number;failed:number};
/** PR A will supply a verified, default-OFF durable-outbox adapter after it merges.
 * A callback is never a provider send and must be idempotent for retries. */
export type BriefOutboxHook=(input:{
  businessId:string;ownerUserId:string;threadId:string;websiteMessageId:string;
  businessName:string;currency:string|null;timezone:string;today:string;yesterday:string;now:Date;
  websiteText:string;
})=>Promise<void>;

/** Morning brief: one short message per café per day in the owner's latest
 * thread. Yesterday's numbers come from the same reader as the chat's
 * "how did yesterday go" answer. Off unless DAILY_BRIEF_ENABLED=true. */
export async function sendDailyBriefs(db:SupabaseClient,now=new Date(),outbox?:BriefOutboxHook):Promise<BriefRun>{
  const run:BriefRun={checked:0,sent:0,skipped:0,failed:0};
  const states=new SnapshotCafeStateService(async(id,period)=>getBusinessSnapshotFromDb(db,id,period??"month"));
  for(let offset=0;;offset+=100){
    const {data,error}=await db.from("businesses").select("id,name,timezone,currency,is_demo")
      .order("id",{ascending:true}).range(offset,offset+99);
    if(error)throw new Error("businesses_unavailable");
    for(const b of data??[]){
      if(b.is_demo||!b.timezone)continue;
      const when=briefDue(now,b.timezone);
      if(!when.due)continue;
      run.checked++;
      try{
        if(await sendOne(db,states,b as {id:string;name?:string;currency:string|null;timezone:string},when,now,outbox))run.sent++;else run.skipped++;
      }catch{run.failed++;}
    }
    if((data??[]).length<100)break;
  }
  return run;
}

async function sendOne(db:SupabaseClient,states:SnapshotCafeStateService,b:{id:string;name?:string;currency:string|null;timezone:string},
  when:{today:string;yesterday:string},now:Date,outbox?:BriefOutboxHook):Promise<boolean>{
  const messageId=briefMessageId(b.id,when.today);
  const sent=await db.from("ai_messages")
    .select("id,business_id,thread_id,owner_user_id,structured_content").eq("id",messageId).maybeSingle();
  if(sent.error)throw sent.error;
  if(sent.data&&!outbox)return false;
  // Never switch an existing message to whichever owner/thread is latest today.
  const persisted=sent.data;
  if(persisted&&(!persisted.owner_user_id||!persisted.thread_id||
    persisted.business_id!==b.id))return false;
  const ownerQuery=db.from("memberships").select("user_id").eq("business_id",b.id).eq("role","owner");
  const owner=await (persisted
    ?ownerQuery.eq("user_id",persisted.owner_user_id).limit(1).maybeSingle()
    :ownerQuery.order("created_at",{ascending:true}).limit(1).maybeSingle());
  if(owner.error)throw owner.error;
  if(!owner.data||(persisted&&owner.data.user_id!==persisted.owner_user_id))return false;
  // Revalidate the persisted thread belongs to the same café and owner.
  const threadQuery=db.from("ai_threads").select("id").eq("business_id",b.id)
    .eq("owner_user_id",owner.data.user_id);
  const thread=await (persisted
    ?threadQuery.eq("id",persisted.thread_id).limit(1).maybeSingle()
    :threadQuery.order("last_message_at",{ascending:false,nullsFirst:false}).limit(1).maybeSingle());
  if(thread.error)throw thread.error;
  if(!thread.data||(persisted&&thread.data.id!==persisted.thread_id))return false;
  if(persisted){
    const stored=persisted.structured_content as Array<{type?:string;text?:string}>|null;
    const websiteText=stored?.find(block=>block.type==="text")?.text;
    if(!websiteText)throw new Error("daily_brief_website_message_missing");
    await outbox!({businessId:b.id,ownerUserId:owner.data.user_id,threadId:thread.data.id,
      websiteMessageId:messageId,businessName:b.name??"",currency:b.currency,timezone:b.timezone,
      today:when.today,yesterday:when.yesterday,now,websiteText});
    return false;
  }
  const [state,tasks,lastLocale]=await Promise.all([
    states.getHistoricalState(b.id,{from:when.yesterday,to:when.yesterday}),
    db.from("operating_tasks").select("id",{count:"exact",head:true}).eq("business_id",b.id).eq("status","needs_owner"),
    db.from("supervisor_proposals").select("locale").eq("business_id",b.id).eq("owner_user_id",owner.data.user_id)
      .order("created_at",{ascending:false}).limit(1).maybeSingle(),
  ]);
  if(tasks.error)throw tasks.error;
  const locale:BriefLocale=lastLocale.data?.locale==="es"||lastLocale.data?.locale==="ar"?lastLocale.data.locale:"en";
  const p=state.profitability;
  const text=briefText({locale,currency:b.currency,needsOwner:tasks.count??0,
    // A recorded zero or negative day is still yesterday's result, not missing data.
    yesterday:p.available?{netSalesCents:p.value.netSalesCents,
      totalCostsCents:p.value.totalCostsCents,ownerProfitCents:p.value.ownerProfitCents,
      complete:state.businessCosts.completeness==="complete"}:null});
  const inserted=await db.from("ai_messages").insert({
    id:messageId,business_id:b.id,thread_id:thread.data.id,owner_user_id:owner.data.user_id,author_user_id:null,
    role:"supervisor",content_type:"blocks",text_content:null,structured_content:[{type:"text",text}],
    grounding:{status:p.available&&state.businessCosts.completeness==="complete"?"estimated":"partial",
      intent:"cafe_overview",evidence:[{source:"historical_rollups",identifier:"daily-brief:"+when.yesterday,asOf:when.today}]},
  });
  if(inserted.error){if(inserted.error.code==="23505")return false;throw inserted.error;}
  // The same brief in the Operations inbox: one "watching" item per day, and
  // the previous day's brief is retired so only the latest stays open.
  const taskId="daily-brief:"+when.today;
  const task=await db.from("operating_tasks").upsert({business_id:b.id,id:taskId,agent_id:"leo",kind:"daily_brief",
    status:"watching",confidence:state.businessCosts.completeness==="complete"?"high":"low",
    payload:{businessDate:when.yesterday,threadId:thread.data.id,messageId,text},
    evidence:[{source:"historical_rollups",facts:{businessDate:when.yesterday}}]},
    {onConflict:"business_id,id",ignoreDuplicates:true});
  if(task.error)throw task.error;
  const retired=await db.from("operating_tasks").update({status:"expired",resolved_at:new Date().toISOString(),
    updated_at:new Date().toISOString()}).eq("business_id",b.id).eq("kind","daily_brief")
    .eq("status","watching").neq("id",taskId);
  if(retired.error)throw retired.error;
  // PR A's durable recipient/day outbox will own send idempotency.
  if(outbox){
    await outbox({businessId:b.id,ownerUserId:owner.data.user_id,threadId:thread.data.id,
      websiteMessageId:messageId,businessName:b.name??"",currency:b.currency,timezone:b.timezone,
      today:when.today,yesterday:when.yesterday,now,websiteText:text});
  }
  return true;
}
