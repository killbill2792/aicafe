import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";
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
/** Rotating a bounded window prevents later-created Watch and owner goals
 * from being permanently hidden behind the first 100 older active routines.
 * The existing refresh cron revisits all windows; no new scheduler or queue. */
export function routinePageWindow(now:Date,total:number):{start:number;end:number}{
  if(!Number.isFinite(now.getTime())||!Number.isSafeInteger(total)||total<0)
    throw Error("routine_page_invalid");
  const pageCount=Math.max(1,Math.ceil(total/batchLimit));
  // Hour-only rotation aliases with an everyday fixed-hour cron (e.g. a
  // two-page café always sees the same page at 09:00). The UTC calendar day
  // also advances the window so infrequent but regular ticks cannot leave
  // later owner goals or system Watch permanently outside the bounded read.
  const slot=Math.floor(now.getTime()/86_400_000)+now.getUTCHours();
  const selected=((slot%pageCount)+pageCount)%pageCount;
  const start=selected*batchLimit;
  return {start,end:start+batchLimit-1};
}
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
      .not("kind","in","(priority_notice,commitment,event_plan,event_change,event_report,u4_report,u4_run_failure)")
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
    if(["commitment","priority_notice","event_plan","event_change","event_report","u4_report","u4_run_failure"].includes(String(raw.kind)))continue;
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
  title:string;cadence:"once"|"daily"|"weekly";weekdays:number[];
  once_local_date?:string|null;once_due_at_utc?:string|null;
  local_time:string;timezone:string;status:"active"|"paused"|"revoked";
  revision:number;created_at:string;updated_at:string;
  execution_mode?:"priority"|"objective"|"watch";objective_text?:string|null;
  objective_source_message_id?:string|null;objective_updates?:unknown;
};
function parseRoutine(row:RoutineRow):RoutineRecord{
  return {
    businessId:row.business_id,id:row.id,ownerUserId:row.owner_user_id,threadId:row.thread_id,
    title:row.title,cadence:row.cadence,weekdays:row.weekdays,
    ...(row.cadence==="once"?{onceLocalDate:row.once_local_date??null}:{}),
    onceDueAtUtc:row.once_due_at_utc??null,
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
/** Fairness is a work-scheduling policy, not a café business procedure:
 * verified owner routines and silent Watch rotate by their last actual
 * occurrence update. A daily Watch cannot starve behind a growing backlog
 * of owner objectives, and new owner objectives are not starved by Watch.
 * Legacy priority checks retain their original execution order. */
export function orderRoutinesFairly<T extends Pick<RoutineRecord,"id"|"executionMode">>(
  routines:readonly T[],lastAttempt:ReadonlyMap<string,string>):T[]{
  const legacy=routines.filter(r=>(r.executionMode??"priority")==="priority");
  const objectives=routines.filter(r=>(r.executionMode??"priority")!=="priority");
  objectives.sort((a,b)=>{
    const left=lastAttempt.get(a.id)??"";
    const right=lastAttempt.get(b.id)??"";
    return left.localeCompare(right)||a.id.localeCompare(b.id);
  });
  return [...legacy,...objectives];
}
type OwnerScope={ownerUserId:string;threadId:string};
/** The existing refresh-derived cron calls this once per café *after* alert
 * generation. Every owner with actionable evidence receives change-driven notices,
 * even on dates where no routine is due. No new AI worker, event loop or inbox. */
export async function dispatchRoutinesForBusiness(db:SupabaseClient,businessId:string,
  timezone:string,now:Date,
  enqueueInvestigations?:(db:SupabaseClient,scope:Scope,now:Date)=>Promise<number>,
  /** Trusted acceptance may meter the real provider; production uses the
   * original configured Luna provider when this server-only port is absent. */
  modelProvider?:AgentProvider,
  options:{skipObjectives?:boolean}={},
):Promise<RoutineDispatchResult>{
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid routine now");
  const started=Date.now();
  // Keep the scheduler's supplied instant, but account for real elapsed
  // execution when issuing/acknowledging leases later in this invocation.
  const tickNow=()=>new Date(now.getTime()+Math.max(0,Date.now()-started));
  const localDate=localDateAt(now,timezone);
  const result:RoutineDispatchResult={routinesChecked:0,runs:0,notices:0,failed:0,evidenceChecks:0,investigationsQueued:0};
  const u4Enabled=process.env.SUPERVISOR_U4_ENABLED==="true";
  // Owner-requested objectives and unsolicited Watch are separate consents.
  // Enabling U4 must NEVER silently start proactive model spending.
  const watchEnabled=u4Enabled&&process.env.SUPERVISOR_U4_WATCH_ENABLED==="true";
  // Bound and rotate BOTH owner and routine cohorts. A fixed first-100
  // owner scan also permanently hides Watch for later café co-owners.
  // The original legacy window stays unchanged when U4 is off.
  const [activeCount,ownerCount]=u4Enabled?await Promise.all([
    db.from("supervisor_routines").select("id",{count:"exact"})
      .eq("business_id",businessId).eq("status","active").limit(0),
    db.from("memberships").select("user_id",{count:"exact"})
      .eq("business_id",businessId).eq("role","owner").limit(0),
  ]):[null,null];
  if(u4Enabled&&(activeCount?.error||typeof activeCount?.count!=="number"||
    ownerCount?.error||typeof ownerCount?.count!=="number"))
    throw activeCount?.error??ownerCount?.error??Error("u4_census_unavailable");
  const window=u4Enabled?routinePageWindow(now,activeCount!.count!):null;
  const ownerWindow=u4Enabled?routinePageWindow(now,ownerCount!.count!):null;
  const scopedRoutines=db.from("supervisor_routines").select("*")
    .eq("business_id",businessId).eq("status","active")
    .order("created_at",{ascending:true}).order("id",{ascending:true});
  const scopedOwners=db.from("memberships").select("user_id")
    .eq("business_id",businessId).eq("role","owner")
    .order("user_id",{ascending:true});
  const [ownerRows,threadRows,routineRows]=await Promise.all([
    ownerWindow?scopedOwners.range(ownerWindow.start,ownerWindow.end):
      scopedOwners.limit(batchLimit),
    db.from("ai_threads").select("id,owner_user_id").eq("business_id",businessId)
      .order("updated_at",{ascending:false}).limit(batchLimit*2),
    window?scopedRoutines.range(window.start,window.end):
      scopedRoutines.limit(batchLimit),
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
  // Rotating the owner notice/Watch window must NOT deny a valid saved
  // routine whose owner falls on a different page this tick. Verify those
  // identities together in ONE current membership read, never by guessing
  // from the selected owner cohort or issuing 100 per-routine DB requests.
  const offPageOwners=[...new Set(routines.map(r=>r.ownerUserId)
    .filter(id=>!owners.has(id)))];
  const extraOwners=offPageOwners.length?
    await db.from("memberships").select("user_id").eq("business_id",businessId)
      .eq("role","owner").in("user_id",offPageOwners).limit(batchLimit):null;
  if(extraOwners?.error)throw extraOwners.error;
  const authorizedRoutineOwners=new Set([...owners,
    ...(extraOwners?.data??[]).map(row=>row.user_id)]);
  // A leased model execution is bounded to one objective per café tick so
  // it cannot starve source refresh, chat or unrelated incident investigation.
  let objectiveExecutions=0;
  if(u4Enabled&&routines.some(r=>r.executionMode!=="priority")){
    // Reuse authoritative occurrence updates; never create a second queue or
    // turn a model-selected hypothesis into a scheduler priority.
    const history=await db.from("supervisor_routine_occurrences")
      .select("routine_id,updated_at").eq("business_id",businessId)
      .order("updated_at",{ascending:false}).limit(batchLimit*10);
    if(history.error)throw history.error;
    const mostRecent=new Map<string,string>();
    for(const row of history.data??[]){
      if(typeof row.routine_id==="string"&&
         typeof row.updated_at==="string"&&!mostRecent.has(row.routine_id))
        mostRecent.set(row.routine_id,row.updated_at);
    }
    const ordered=orderRoutinesFairly(routines,mostRecent);
    routines.splice(0,routines.length,...ordered);
  }
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
  const dueQuestions=await db.rpc("staff_question_escalate_due",{p_business_id:businessId});
  if(dueQuestions.error)result.failed++;
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
        if(!threadId&&u4Enabled){
          // Unlike the legacy alert-driven path, a newly connected owner
          // needs an autonomous research identity BEFORE the first incident.
          // This additive service-only RPC reuses the existing owner-thread
          // fence and advisory lock, never creating a fabricated owner turn.
          const watchThread=await db.rpc("u4_ensure_watch_thread",{
            p_business_id:businessId,p_owner_user_id:ownerUserId,
          });
          if(watchThread.error)throw watchThread.error;
          if(typeof watchThread.data==="string")threadId=watchThread.data;
        }
      }catch{result.failed++;continue;}
      // Null is a successful no-work result, not an outage. A failed RPC is handled above.
      if(!threadId)continue;
    }
    // The default autonomous review is a SYSTEM-origin routine (hidden from
    // owner-created routines). Its SQL identity and original owner/thread
    // binding are verified; no fake owner chat utterance is inserted.
    if(watchEnabled){
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
    if((routine.executionMode==="watch"&&!watchEnabled)||
      (options.skipObjectives&&routine.executionMode!=="priority"))continue;
    result.routinesChecked++;
    if(!authorizedRoutineOwners.has(routine.ownerUserId)||routine.timezone!==timezone){
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
            ...(modelProvider?{provider:modelProvider}:{}),
          });
          if(outcome.yielded)continue;
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

/** Cheap global due admission: the SAME routine/occurrence lease is reused by
 * every café. SQL rotates only authorized due owners before any source fetch.
 * Independent leased cafés execute concurrently; no cross-café await chain.
 * The server-only flag NEVER activates unsolicited Watch by itself. */
export async function dispatchDueObjectivesAcrossCafes(
  db:SupabaseClient,now:Date,provider?:AgentProvider,
):Promise<{admitted:number;claimed:number;completed:number;failed:number;deferred:number}>{
  const result={admitted:0,claimed:0,completed:0,failed:0,deferred:0};
  const batchStartedAt=Date.now();
  if(process.env.SUPERVISOR_U4_ENABLED!=="true")return result;
  const watchEnabled=process.env.SUPERVISOR_U4_WATCH_ENABLED==="true";
  const selected=await db.rpc("u4_due_objective_admission",{
    p_now:now.toISOString(),p_limit:6,p_watch_enabled:watchEnabled,
  });
  if(selected.error)throw Error("u4_due_admission_unavailable");
  if(!Array.isArray(selected.data))throw Error("u4_due_admission_invalid");
  type Candidate={routine:RoutineRow;localDate:string;scheduledForUtc:string|null};
  const rows=(selected.data as unknown[]).filter((entry):entry is Candidate=>{
    if(!entry||typeof entry!=="object"||Array.isArray(entry))return false;
    const x=entry as Record<string,unknown>;
    return !!x.routine&&typeof x.routine==="object"&&
      typeof x.localDate==="string"&&/^\d{4}-\d{2}-\d{2}$/u.test(x.localDate)&&
      (x.scheduledForUtc===null||typeof x.scheduledForUtc==="string");
  }).slice(0,6);
  result.admitted=rows.length;
  const outcomes=await Promise.allSettled(rows.map(async row=>{
    const routine=parseRoutine(row.routine);
    if(routine.status!=="active"||!["objective","watch"].includes(routine.executionMode??"")||
      routine.executionMode==="watch"&&!watchEnabled)
      return "deferred" as const;
    const at=new Date();
    const due=row.scheduledForUtc?new Date(row.scheduledForUtc):
      dueScheduleOnDate(routine,routine.timezone,row.localDate,at);
    if(!due||!Number.isFinite(due.getTime())||due.getTime()>at.getTime())
      return "deferred" as const;
    let lease:Awaited<ReturnType<typeof claimRoutineOccurrence>>=null;
    try{
      lease=await claimRoutineOccurrence(db,{
        businessId:routine.businessId,routineId:routine.id,
        revision:routine.revision,localDate:row.localDate,dueAt:due,now:at,
      });
      if(!lease)return "deferred" as const;
      const outcome=await executeClaimedObjective(db,{
        routine,lease,localDate:row.localDate,...(provider?{provider}:{}),
      });
      return outcome.yielded?"deferred" as const:"completed" as const;
    }catch{
      if(lease){
        try{
          await finishRoutineOccurrence(db,{
            businessId:routine.businessId,routineId:routine.id,
            runId:lease.runId,leaseToken:lease.leaseToken,
            success:false,receiptRef:"u4_bounded_execution_failed",now:new Date(),
          });
        }catch{/* A failed finish stays leased until the existing reclaim window. */}
      }
      return lease?"claimed_failed" as const:"failed" as const;
    }
  }));
  for(const outcome of outcomes){
    if(outcome.status!=="fulfilled"){result.failed++;continue;}
    switch(outcome.value){
      case "completed":result.claimed++;result.completed++;break;
      case "claimed_failed":result.claimed++;result.failed++;break;
      case "failed":result.failed++;break;
      default:result.deferred++;
    }
  }
  // Admission-only due lag and workload metrics. We never log café IDs,
  // owner utterances, source values or payment records.
  const nowMs=Date.now();
  const lagMs=rows.flatMap(row=>{
    if(!row.scheduledForUtc)return [];
    const timestamp=Date.parse(row.scheduledForUtc);
    return Number.isFinite(timestamp)?[Math.max(0,nowMs-timestamp)]:[];
  }).sort((a,b)=>a-b);
  const percentile=(rank:number)=>lagMs.length?
    lagMs[Math.min(lagMs.length-1,Math.ceil(rank*lagMs.length)-1)]:null;
  console.info("u4_due_dispatch",{
    ...result,lagSamples:lagMs.length,
    admittedDueLagP50Ms:percentile(.5),admittedDueLagP95Ms:percentile(.95),
    executionBatchMs:Math.max(0,Date.now()-batchStartedAt),
  });
  return result;
}
