import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {localDateAt,dueScheduleOnDate} from "./calendar";
import {choosePriorities} from "./priority";
import {claimRoutineOccurrence,finishRoutineOccurrence,listRoutineOccurrenceCandidates} from "./repository.server";
import {postPriorityNotice} from "./notices.server";
import {executeClaimedObjective} from "./objective.server";
import {followUpStaffPublicationForBusiness} from "@/lib/scheduling/staffPublication.server";
import type {PriorityDecision,PrioritySource,RoutineRecord} from "./contracts";

export type RoutineDispatchResult={
  routinesChecked:number;runs:number;notices:number;failed:number;
  evidenceChecks:number;investigationsQueued:number;
};
type DbRow={id:string;[field:string]:unknown};
const batchLimit=100;
type Scope={businessId:string;ownerUserId:string;threadId:string;localDate:string};
function safeSeverity(payload:unknown):string|null{
  if(!payload||typeof payload!=="object")return null;
  const severity=(payload as Record<string,unknown>).severity;
  return severity==="critical"||severity==="high"?severity:null;
}
/** Read existing authoritative alert/task rows; do NOT use cached café money or
 * infer that a missing/failed provider is a verified zero. */
export async function readActionablePriorities(db:SupabaseClient,scope:Scope,
  now:Date,options?:{includeNotified?:boolean;limit?:number}):Promise<PriorityDecision[]>{
  const [alerts,tasks,purchaseDrafts,approvedOrders]=await Promise.all([
    db.from("alerts").select("id,kind,status,payload,created_at")
      .eq("business_id",scope.businessId).in("status",["new","seen"])
      .order("created_at",{ascending:false}).limit(batchLimit),
    db.from("operating_tasks")
      .select("id,kind,status,due_at,confidence,evidence,created_at,owner_user_id")
      .eq("business_id",scope.businessId)
      .in("status",options?.includeNotified?["needs_owner","needs_response","watching"]:
        ["needs_owner","needs_response"])
      .not("kind","in","(priority_notice,commitment,event_plan,event_change,event_report)")
      .or("owner_user_id.is.null,owner_user_id.eq."+scope.ownerUserId)
      .order("created_at",{ascending:false}).limit(batchLimit),
    // The canonical approved-order proposal is the source; do not infer
    // stockouts, create new purchase drafts, or invent owner authorization.
    // Supplier purchase-order drafts belong to the approval notice lane.
    // Do not read them for the investigation-only queue: SQL does not accept
    // supplier_po, and a pending draft must never starve café incidents.
    options?.includeNotified?Promise.resolve({data:[] as DbRow[],error:null}):
      db.from("supervisor_proposals")
      .select("id,thread_id,created_at,status,revision")
      .eq("business_id",scope.businessId)
      .eq("owner_user_id",scope.ownerUserId)
      .eq("capability_id","maya.supplier_purchase_order.v1")
      .eq("status","draft")
      .lte("created_at",new Date(now.getTime()-2*60*60_000).toISOString())
      .order("created_at",{ascending:true}).limit(batchLimit),
    options?.includeNotified?Promise.resolve({data:[] as DbRow[],error:null}):
      db.from("purchase_orders").select("id,proposal_id,approved_at,revision,status")
        .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
        .eq("status","approved_for_ordering")
        .lte("approved_at",new Date(now.getTime()-2*60*60_000).toISOString())
        .order("approved_at",{ascending:true}).limit(batchLimit),
  ]);
  if(alerts.error||tasks.error||purchaseDrafts.error||approvedOrders.error)
    throw alerts.error??tasks.error??purchaseDrafts.error??approvedOrders.error;
  const sources:PrioritySource[]=[];
  for(const raw of (alerts.data??[]) as DbRow[]){
    const payload=raw.payload as Record<string,unknown>|null;
    sources.push({
      businessId:scope.businessId,ownerUserId:scope.ownerUserId,
      sourceType:"alert",sourceId:String(raw.id),kind:String(raw.kind),
      status:String(raw.status),createdAt:String(raw.created_at),
      severity:safeSeverity(payload),
      dedupeKey:typeof payload?.dedupeKey==="string"?payload.dedupeKey:null,
      evidence:payload??null,
    });
  }
  for(const raw of (tasks.data??[]) as DbRow[]){
    // Defense in depth if a custom/mock adapter fails to apply the DB filter:
    // never re-notify commitments or a previously generated priority notice.
    if(["commitment","priority_notice","event_plan","event_change","event_report"].includes(String(raw.kind)))continue;
    if(raw.owner_user_id&&raw.owner_user_id!==scope.ownerUserId)continue;
    sources.push({
      businessId:scope.businessId,ownerUserId:scope.ownerUserId,
      sourceType:"operating_task",sourceId:String(raw.id),
      kind:String(raw.kind),status:String(raw.status),
      dueAt:typeof raw.due_at==="string"?raw.due_at:null,
      confidence:typeof raw.confidence==="string"?raw.confidence:null,
      createdAt:String(raw.created_at),evidence:raw.evidence??null,
    });
  }
  for(const raw of (purchaseDrafts.data??[]) as DbRow[]){
    if(typeof raw.id!=="string"||typeof raw.thread_id!=="string"||
      typeof raw.created_at!=="string"||raw.status!=="draft")continue;
    sources.push({
      businessId:scope.businessId,ownerUserId:scope.ownerUserId,
      sourceType:"supplier_po",sourceId:raw.id,sourceThreadId:raw.thread_id,
      kind:"supplier_po_approval",status:"draft",createdAt:raw.created_at,
      evidence:{revision:raw.revision,status:"draft"}
    });
  }
  // Use the existing routine, owner inbox and notice SQL, never a second
  // vendor-follow-up scheduler. Missing channels remain actionable evidence.
  const open=approvedOrders.data??[];
  if(open.length){
    const ids=open.map(x=>x.id);
    const [origins,dispatches,reports]=await Promise.all([
      db.from("supervisor_proposals").select("id,thread_id")
        .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
        .in("id",open.map(x=>x.proposal_id)),
      db.from("purchase_order_dispatches").select("purchase_order_id,state")
        .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
        .in("purchase_order_id",ids),
      db.from("purchase_order_channel_reports").select("purchase_order_id,outcome,reported_at")
        .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
        .in("purchase_order_id",ids).order("reported_at",{ascending:false}).limit(batchLimit*4)
    ]);
    if(origins.error||dispatches.error||reports.error)
      throw new Error("supplier_dispatch_priority_source_unavailable");
    for(const order of open){
      const origin=(origins.data??[]).find(x=>x.id===order.proposal_id);
      if(!origin?.thread_id)continue;
      const last=(reports.data??[]).find(x=>x.purchase_order_id===order.id);
      if(last&&["supplier_accepted","supplier_declined"].includes(last.outcome))continue;
      const dispatch=(dispatches.data??[]).find(x=>x.purchase_order_id===order.id);
      sources.push({businessId:scope.businessId,ownerUserId:scope.ownerUserId,
        sourceType:"supplier_dispatch",sourceId:order.id,sourceThreadId:origin.thread_id,
        kind:"supplier_order_followup",status:"approved_for_ordering",
        createdAt:order.approved_at,
        evidence:{revision:order.revision,
          dispatchState:dispatch?.state??"not_prepared",
          ownerReportedOutcome:last?.outcome??null}});
    }
  }
  // Rank the whole bounded source batch before applying the fresh-notice cap.
  // An existing notice is a receipt for that exact revision, not a reason to
  // starve later actionable sources while the first three stay open.
  // Filter BEFORE the ranking/batch cap: >25 old purchase drafts cannot
  // push urgent staff, inventory or revenue incidents out of the queue.
  const eligible=options?.includeNotified?
    sources.filter(source=>source.sourceType==="alert"||
      source.sourceType==="operating_task"):sources;
  const ranked=choosePriorities(eligible,now,batchLimit*2,
    {includeWatching:options?.includeNotified===true});
  if(ranked.length===0)return [];
  // Durable autonomous investigation must examine known unresolved issues even
  // when an earlier generic notice was already delivered. The notice path
  // below still excludes that revision and cannot spam duplicate inbox tasks.
  if(options?.includeNotified)return ranked.slice(0,Math.max(0,Math.min(batchLimit,options.limit??25)));
  const {data:receipts,error:receiptError}=await db.from("operating_tasks")
    .select("dedupe_key").eq("business_id",scope.businessId)
    .eq("owner_user_id",scope.ownerUserId).eq("kind","priority_notice")
    .in("dedupe_key",ranked.map(decision=>decision.stableKey))
    .limit(ranked.length);
  if(receiptError)throw receiptError;
  const notified=new Set((receipts??[]).map(row=>String(row.dedupe_key)));
  return ranked.filter(decision=>!notified.has(decision.stableKey)).slice(0,3);
}
async function postForOwner(db:SupabaseClient,scope:Scope,now:Date,
  opts?:{routine:{id:string;runId:string;leaseToken:string}},
):Promise<{posted:number;checked:number}>{
  const priorities=await readActionablePriorities(db,scope,now);
  let posted=0;
  for(const decision of priorities){
    // Purchasing approval belongs in the saved proposal's original chat,
    // not an arbitrary latest owner thread. SQL rechecks both memberships.
    const target=["supplier_po","supplier_dispatch"].includes(decision.source.sourceType)?
      decision.source.sourceThreadId??scope.threadId:scope.threadId;
    const outcome=await postPriorityNotice(db,{...scope,...opts,threadId:target},decision,now);
    if(outcome==="posted")posted++;
  }
  return {posted,checked:priorities.length};
}
type RoutineRow={
  business_id:string;id:string;owner_user_id:string;thread_id:string;
  title:string;cadence:"daily"|"weekly";weekdays:number[];
  local_time:string;timezone:string;status:"active"|"paused"|"revoked";
  revision:number;created_at:string;updated_at:string;
  execution_mode?:"priority"|"objective"|"watch";objective_text?:string|null;
  objective_source_message_id?:string|null;objective_updates?:unknown;
};
function parseRoutine(row:RoutineRow):RoutineRecord{
  return {
    businessId:row.business_id,id:row.id,ownerUserId:row.owner_user_id,threadId:row.thread_id,
    title:row.title,cadence:row.cadence,weekdays:row.weekdays,
    localTime:String(row.local_time).slice(0,5),timezone:row.timezone,
    status:row.status,revision:row.revision,
    createdAt:row.created_at,updatedAt:row.updated_at,
    executionMode:row.execution_mode??"priority",
    objectiveText:row.objective_text??null,
    objectiveSourceMessageId:row.objective_source_message_id??null,
    objectiveUpdates:Array.isArray(row.objective_updates)?row.objective_updates.filter(v=>
      v&&typeof v==="object"&&typeof v.sourceMessageId==="string"&&
      typeof v.text==="string"&&Number.isSafeInteger(v.revision)):[],
  };
}
type OwnerScope={ownerUserId:string;threadId:string};
/** The existing refresh-derived cron calls this once per café *after* alert
 * generation. Every owner with actionable evidence receives change-driven notices,
 * even on dates where no routine is due. No new AI worker, event loop or inbox. */
export async function dispatchRoutinesForBusiness(db:SupabaseClient,businessId:string,
  timezone:string,now:Date,
  enqueueInvestigations?:(db:SupabaseClient,scope:Scope,now:Date)=>Promise<number>,
):Promise<RoutineDispatchResult>{
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid routine now");
  const started=Date.now();
  // Keep the scheduler's supplied instant, but account for real elapsed
  // execution when issuing/acknowledging leases later in this invocation.
  const tickNow=()=>new Date(now.getTime()+Math.max(0,Date.now()-started));
  const localDate=localDateAt(now,timezone);
  const result:RoutineDispatchResult={routinesChecked:0,runs:0,notices:0,failed:0,evidenceChecks:0,investigationsQueued:0};
  const [ownerRows,threadRows,routineRows]=await Promise.all([
    db.from("memberships").select("user_id").eq("business_id",businessId)
      .eq("role","owner").order("user_id",{ascending:true}).limit(batchLimit),
    db.from("ai_threads").select("id,owner_user_id").eq("business_id",businessId)
      .order("updated_at",{ascending:false}).limit(batchLimit*2),
    db.from("supervisor_routines").select("*")
      .eq("business_id",businessId).eq("status","active")
      .order("created_at",{ascending:true}).limit(batchLimit),
  ]);
  if(ownerRows.error||threadRows.error||routineRows.error)
    throw ownerRows.error??threadRows.error??routineRows.error;
  const owners=new Set((ownerRows.data??[]).map(row=>row.user_id));
  const threads=new Map<string,string>();
  for(const row of threadRows.data??[]){
    if(owners.has(row.owner_user_id)&&!threads.has(row.owner_user_id))
      threads.set(row.owner_user_id,row.id);
  }
  const routines=((routineRows.data??[]) as RoutineRow[]).map(parseRoutine);
  // A leased model execution is bounded to one objective per café tick so
  // it cannot starve source refresh, chat or unrelated incident investigation.
  const u4Enabled=process.env.SUPERVISOR_U4_ENABLED==="true";
  let objectiveExecutions=0;
  // Task 13B publication uses the same refresh tick; never omit existing
  // approved staff delivery and owner-visible exception reconciliation.
  try{await followUpStaffPublicationForBusiness(db,businessId,localDate);}
  catch{result.failed++;}
  // Reuse this existing refresh cycle: current published shifts become
  // worker-scoped requests. A changed/removed shift cancels stale prompts.
  const sync=await db.rpc("staff_channel_sync_shift_requests",{p_business_id:businessId});
  if(sync.error)result.failed++;
  else{
    const unanswered=await db.rpc("staff_channel_escalate_unanswered",{p_business_id:businessId});
    if(unanswered.error)result.failed++;
  }
  // Task13D source-verifies approved leave and expires recruitment references in this same tick.
  const coordinated=await db.rpc("staff_coordination_reconcile",{p_business_id:businessId});
  if(coordinated.error)result.failed++;
  // Source-change notices remain independent from the due schedule.
  for(const ownerUserId of owners){
    let threadId=threads.get(ownerUserId);
    if(!threadId){
      try{
        const opened=await db.rpc("supervisor_ensure_proactive_thread",{p_business_id:businessId,p_owner_user_id:ownerUserId});
        if(opened.error)throw opened.error;
        if(typeof opened.data==="string")threadId=opened.data;
      }catch{result.failed++;continue;}
      // Null is a successful no-work result, not an outage. A failed RPC is handled above.
      if(!threadId)continue;
    }
    // The default autonomous review is a SYSTEM-origin routine (hidden from
    // owner-created routines). Its SQL identity and original owner/thread
    // binding are verified; no fake owner chat utterance is inserted.
    if(u4Enabled){
      try{
        const configured=process.env.SUPERVISOR_U4_WATCH_LOCAL_TIME??"09:00";
        if(!/^([01]\d|2[0-3]):[0-5]\d$/u.test(configured))
          throw Error("u4_invalid_watch_local_time");
        const watch=await db.rpc("u4_ensure_watch_routine",{
          p_business_id:businessId,p_owner_user_id:ownerUserId,
          p_thread_id:threadId,p_local_time:configured,
        });
        if(watch.error||typeof watch.data!=="string")throw Error("u4_watch_unavailable");
      }catch{result.failed++;}
    }
    try{
      const done=await postForOwner(db,{businessId,ownerUserId,threadId,localDate},now);
      result.evidenceChecks+=done.checked;
      result.notices+=done.posted;
    }catch{result.failed++;}
    // The existing tick projects durable source tasks before queuing the same
    // Supervisor investigator. No separate receiving cron or owner message.
    try{
      const receiving=await db.rpc("supervisor_sync_supplier_receiving_tasks",{
        p_business_id:businessId,p_owner_user_id:ownerUserId,p_now:now.toISOString(),
      });
      if(receiving.error)result.failed++;
    }catch{result.failed++;}
    try{
      const finance=await db.rpc("supervisor_sync_financial_review",{p_business_id:businessId,p_owner_user_id:ownerUserId,p_now:now.toISOString()});
      if(finance.error)result.failed++;
    }catch{result.failed++;}
    // This is the SAME verified owner/thread selected for the notice scanner.
    // A failed notice cannot prevent persistent investigation, and vice versa.
    if(enqueueInvestigations){
      try{result.investigationsQueued+=await enqueueInvestigations(db,
        {businessId,ownerUserId,threadId,localDate},now);}
      catch{result.failed++;}
    }
  }
  for(const routine of routines){
    result.routinesChecked++;
    if(!owners.has(routine.ownerUserId)||routine.timezone!==timezone){
      result.failed++;continue;
    }
    // Read persisted retries and missed dates, not just today's date. Each
    // candidate uses the same occurrence identity and fenced claim as before.
    // At most five candidates per routine per tick; later ticks catch up.
    let candidates:Awaited<ReturnType<typeof listRoutineOccurrenceCandidates>>;
    try{
      candidates=await listRoutineOccurrenceCandidates(db,{
        businessId,routineId:routine.id,revision:routine.revision,now,
      });
    }catch{result.failed++;continue;}
    for(const candidate of candidates){
      if(routine.executionMode!=="priority"&&
        (!u4Enabled||objectiveExecutions>=1))break;
      let lease:{runId:string;leaseToken:string;revision:number}|null=null;
      try{
        const claimAt=tickNow();
        const due=candidate.scheduledForUtc?new Date(candidate.scheduledForUtc):
          dueScheduleOnDate(routine,routine.timezone,candidate.localDate,claimAt);
        if(!due||!Number.isFinite(due.getTime())||due.getTime()<Date.parse(routine.updatedAt)||
          due.getTime()>claimAt.getTime())continue;
        lease=await claimRoutineOccurrence(db,{businessId,routineId:routine.id,
          revision:routine.revision,localDate:candidate.localDate,dueAt:due,now:claimAt});
        if(!lease)continue;
        if(routine.executionMode==="objective"||routine.executionMode==="watch"){
          objectiveExecutions++;
          const outcome=await executeClaimedObjective(db,{
            routine,lease,localDate:candidate.localDate,
          });
          result.runs++;
          result.evidenceChecks+=outcome.sourceCount;
          if(routine.executionMode==="objective"||outcome.attention==="attention")
            result.notices++;
          continue;
        }
        // A missed occurrence is a check of CURRENT evidence, never a claim
        // we checked historically or a replay of a prior external action.
        const asOf=tickNow();
        const done=await postForOwner(db,{
          businessId,ownerUserId:routine.ownerUserId,threadId:routine.threadId,
          localDate:localDateAt(asOf,timezone),
        },asOf,{routine:{id:routine.id,runId:lease.runId,leaseToken:lease.leaseToken}});
        const finished=await finishRoutineOccurrence(db,{
          businessId,routineId:routine.id,runId:lease.runId,
          leaseToken:lease.leaseToken,success:true,
          receiptRef:"priority-check:"+done.checked,now:tickNow(),
        });
        if(!finished)throw new Error("Routine lease lost before completion");
        result.runs++;
        result.notices+=done.posted;
        result.evidenceChecks+=done.checked;
      }catch{
        result.failed++;
        if(lease){
          try{
            await finishRoutineOccurrence(db,{
              businessId,routineId:routine.id,runId:lease.runId,
              leaseToken:lease.leaseToken,success:false,
              receiptRef:"bounded_check_failed",now:tickNow(),
            });
          }catch{result.failed++;}
        }
      }
    }
  }
  return result;
}
