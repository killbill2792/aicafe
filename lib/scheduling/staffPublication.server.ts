import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {buildScheduleMessage} from "@/lib/calc/scheduling/ownerDeliveryLinks";
import {staffProviderBlockers,sendStaffScheduleTemplate} from "@/lib/whatsapp/staffScheduleDelivery.server";

type Scope={businessId:string;ownerUserId:string};
type Shift={employee_id:string;date:string;start:string;end:string};
type Publication={id:string;business_id:string;owner_user_id:string;
 proposal_id:string;week_start:string;snapshot:Shift[];status:string};
type Delivery={id:string;employee_id:string;status:string;recipient_e164:string};
const result=(error:unknown):never=>{throw new Error("staff_publication_storage_unavailable",{cause:error});};

/** Only a NEW, explicit publish_and_notify approval may pass the SQL gateway;
 * past copy-ready approvals cannot accidentally become actual staff sends. */
export async function publishApprovedStaffSchedule(scope:Scope,proposalId:string){
 const {data,error}=await createAdminSupabaseClient().rpc("staff_schedule_publish",{
  p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_proposal_id:proposalId,
 });
 if(error||!data||typeof data!=="object"||typeof data.id!=="string"||
    data.state!=="published")result(error);
 return data as {id:string;week:string;state:"published";replayed:boolean;
  expectedRecipients?:number;eligibleRecipients?:number};
}

/** Explicit authenticated owner cancellation, never a model-triggered action.
 * Provider-accepted or in-flight messages cannot be unsent; report that count. */
export async function cancelStaffPublication(scope:Scope,proposalId:string){
 const db=createAdminSupabaseClient();
 const publication=await db.from("staff_schedule_publications")
  .select("id").eq("business_id",scope.businessId)
  .eq("owner_user_id",scope.ownerUserId).eq("proposal_id",proposalId).maybeSingle();
 const authorizedPublication=publication.data;
 if(publication.error||!authorizedPublication)throw new Error("staff_publication_scope_unavailable",{cause:publication.error});
 const {data,error}=await db.rpc("staff_schedule_cancel_publication",{
  p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
  p_publication_id:authorizedPublication.id,
 });
 if(error||!data||data.state!=="cancelled")result(error);
 return data as {state:"cancelled";publicationId:string;
  revision:number;inFlight:number;alreadyAccepted:number};
}

export async function recordSignedStaffScheduleStatus(event:{
 wamid:string;state:"sent"|"delivered"|"read"|"failed"}):Promise<void>{
 const {error}=await createAdminSupabaseClient().rpc("staff_schedule_record_provider_status",{
  p_wamid:event.wamid,p_status:event.state,
 });
 if(error)result(error);
}

async function attemptEmployee(db:SupabaseClient,p:Publication,d:Delivery):Promise<"sent"|"failed"|"uncertain"|"skipped">{
 const people=await db.from("employees").select("id,display_name,preferred_language")
  .eq("business_id",p.business_id).eq("id",d.employee_id).maybeSingle();
 if(people.error||!people.data)return "failed";
 const person=people.data;
 const rows=p.snapshot.filter(s=>s.employee_id===d.employee_id).map(s=>({
   date:s.date,start:s.start,end:s.end,
 }));
 if(!rows.length)return "failed";
 // Meta's independently approved staff template currently uses English only.
 const message=buildScheduleMessage("en",person.display_name,p.week_start,rows);
 if(message.length>1000)return "failed";
 const claimed=await db.rpc("staff_schedule_claim_delivery",{
  p_publication_id:p.id,p_employee_id:d.employee_id,
 });
 if(claimed.error)throw new Error("staff_send_authorization_changed");
 if(!claimed.data)return "skipped";
 const claim=claimed.data as {deliveryId:string;attemptToken:string;to:string};
 // Owner cancellation or staff opt-out after the queued claim must still
 // prevent dispatch. A provider request is never made on unknown auth state.
 const fresh=await db.rpc("staff_schedule_can_send",{
  p_delivery_id:claim.deliveryId,p_attempt_token:claim.attemptToken,
 });
 if(fresh.error||fresh.data!==true){
  const rejected=await db.rpc("staff_schedule_finish_delivery",{
   p_delivery_id:claim.deliveryId,p_attempt_token:claim.attemptToken,
   p_state:"failed",p_wamid:null,p_error:"revoked_before_send",
  });
  if(rejected.error||rejected.data!==true)throw new Error("staff_revocation_receipt_uncertain");
  return "failed";
 }
 const receipt=await sendStaffScheduleTemplate(claim.to,message);
 const state=receipt.state==="accepted"?"sent":
  receipt.state==="failed"?"failed":"uncertain";
 const finished=await db.rpc("staff_schedule_finish_delivery",{
  p_delivery_id:claim.deliveryId,p_attempt_token:claim.attemptToken,
  p_state:state,p_wamid:receipt.state==="accepted"?receipt.wamid:null,
  p_error:receipt.state==="accepted"?null:receipt.reason,
 });
 // A lost finish response is uncertain; never issue another provider request.
 if(finished.error||finished.data!==true)throw new Error("staff_send_receipt_uncertain");
 return state;
}
const addDay=(day:string,n:number)=>new Date(Date.parse(day+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);

/** Proactive source-based owner question. Do not claim feasibility/legality
 * without the 13A planner. This notices a real missing publication before the
 * week starts, and the same Supervisor subsequently resumes approved work.
 * No synthetic owner prompt, second agent, or invented schedule. */
async function surfaceUpcomingScheduleNeed(db:SupabaseClient,businessId:string,
 localDate:string):Promise<void>{
 const d=new Date(localDate+"T12:00:00Z");
 if(Number.isNaN(d.getTime()))throw new Error("invalid_cafe_date");
 const daysUntilMonday=(8-d.getUTCDay())%7||7;
 // Inform Thursday–Sunday before the following work week; no daily spam.
 if(daysUntilMonday>4)return;
 const week=addDay(localDate,daysUntilMonday);
 const prior=await db.from("staff_schedule_publications").select("id")
  .eq("business_id",businessId).eq("week_start",week)
  .eq("status","published").maybeSingle();
 if(prior.error)result(prior.error);
 if(prior.data)return;
 const [employees,shifts,owners]=await Promise.all([
  db.from("employees").select("id").eq("business_id",businessId)
   .eq("active",true).limit(201),
  db.from("scheduled_shifts").select("id").eq("business_id",businessId)
   .gte("local_date",week).lte("local_date",addDay(week,6))
   .is("deleted_at",null).limit(201),
  db.from("memberships").select("user_id").eq("business_id",businessId)
   .eq("role","owner").limit(30),
 ]);
 if(employees.error||shifts.error||owners.error)
   result(employees.error??shifts.error??owners.error);
 if(!employees.data?.length)return; // no café staff, so no shift schedule
 const count=shifts.data?.length??0;
 const evidence={week,plannedShiftRows:count,employees:employees.data.length,
  state:"approval_and_validated_publication_needed",
  legalAndCoverageVerification:"not_claimed"};
 for(const owner of owners.data??[]){
  const id="staff-publish-needed:"+week+":"+owner.user_id;
  const task=await db.from("operating_tasks").upsert({
   business_id:businessId,id,owner_user_id:owner.user_id,agent_id:"olivia",
   kind:"staff_schedule_publication",entity_type:"schedule",entity_id:week,
   status:"needs_owner",confidence:"high",
   payload:{title:count?
      "Supervisor: review and approve week "+week+" schedule publication":
      "Supervisor: prepare and review the week "+week+" staff schedule",
     ...evidence,nextAction:count?
      "Review the actual staffing/coverage and explicitly approve publication and notification":
      "Use the Task13A planner to draft, review, and approve the week"},
   evidence:[{source:"scheduled_shifts",facts:evidence}],
  },{onConflict:"business_id,id",ignoreDuplicates:true});
  if(task.error)result(task.error);
 }
}
/** Called from the EXISTING durable café routine refresh. Never creates a new
 * cron/AI loop. Publication is a verified idempotent SQL effect; each staff
 * delivery is claimed once and is never replayed after a provider ambiguity.
 * Owner questions are written into existing operating_tasks, then the routine's
 * existing notice writer surfaces them in Supervisor and Operations. */
export async function followUpStaffPublicationForBusiness(db:SupabaseClient,
 businessId:string,localDate:string):Promise<{published:number;attempted:number;blocked:number}>{
 const state={published:0,attempted:0,blocked:0};
 await surfaceUpcomingScheduleNeed(db,businessId,localDate);
 // Only a newly created v2 effect with explicit owner-visible publish intent
 // is eligible. Old committed COPY-only approvals never get sent.
 // A cancelled publication is terminal for this approval. Never let the
 // routine resurrect it or indefinitely show the old open delivery task.
 const cancelledRows=await db.from("staff_schedule_publications")
  .select("id,proposal_id").eq("business_id",businessId)
  .eq("status","cancelled").limit(100);
 if(cancelledRows.error)result(cancelledRows.error);
 const cancelled=new Set((cancelledRows.data??[]).map(x=>x.proposal_id));
 for(const row of cancelledRows.data??[]){
  const done=await db.from("operating_tasks").update({
    status:"handled",resolved_at:new Date().toISOString(),updated_at:new Date().toISOString(),
  }).eq("business_id",businessId).eq("id","staff-publication:"+row.id)
   .neq("status","handled");
  if(done.error)result(done.error);
 }
 const proposals=await db.from("supervisor_proposals")
  .select("id,owner_user_id,canonical_effect_payload")
  .eq("business_id",businessId).eq("capability_id","olivia.staff_propose_send_schedule.v2")
  .eq("status","committed").order("created_at",{ascending:false}).limit(60);
 if(proposals.error)result(proposals.error);
 for(const p of proposals.data??[]){
  const effect=p.canonical_effect_payload as {payload?:{week_start?:unknown;publish_and_notify?:unknown}}|null;
  if(cancelled.has(p.id)||effect?.payload?.publish_and_notify!==true||
    typeof effect.payload.week_start!=="string"||
    effect.payload.week_start<addDay(localDate,-6))continue;
  const exceptionId="staff-publication-pending:"+p.id;
  try{
   const done=await publishApprovedStaffSchedule({businessId,ownerUserId:p.owner_user_id},p.id);
   if(!done.replayed)state.published++;
   // A previous ambiguous/failed publication is now independently verified.
   const closed=await db.from("operating_tasks").update({
     status:"handled",resolved_at:new Date().toISOString(),
   }).eq("business_id",businessId).eq("id",exceptionId)
     .neq("status","handled");
   if(closed.error)result(closed.error);
  }catch{
   state.blocked++;
   const pending=await db.from("operating_tasks").upsert({
    business_id:businessId,id:exceptionId,agent_id:"olivia",
    owner_user_id:p.owner_user_id,kind:"staff_schedule_publication_exception",
    entity_type:"schedule",entity_id:p.id,status:"needs_owner",confidence:"high",
    payload:{title:"Supervisor: approved schedule publication needs verification",
      week:effect.payload.week_start,proposalId:p.id,
      nextAction:"Review stale roster, approval or storage evidence; Supervisor will safely reconcile",
      verified:"no"},
    evidence:[{source:"supervisor_proposals",
      facts:{id:p.id,week:effect.payload.week_start,status:"committed"}}],
   },{onConflict:"business_id,id"});
   if(pending.error)result(pending.error);
  }
 }
 const publications=await db.from("staff_schedule_publications")
  .select("id,business_id,owner_user_id,proposal_id,week_start,snapshot,status")
  .eq("business_id",businessId).eq("status","published")
  .gte("week_start",addDay(localDate,-6)).order("week_start").limit(30);
 if(publications.error)result(publications.error);
 const blockers=staffProviderBlockers();
 for(const p of (publications.data??[]) as Publication[]){
  const list=await db.from("staff_schedule_deliveries")
    .select("id,employee_id,status,recipient_e164")
    .eq("business_id",businessId).eq("publication_id",p.id).limit(201);
  if(list.error||!list.data)result(list.error);
  let errors=0;
  if(blockers.length)errors++;
  else for(const d of (list.data??[]) as Delivery[]){
    if(d.status!=="prepared")continue;
    try{
     const attempt=await attemptEmployee(db,p,d);
     if(attempt==="sent"||attempt==="failed"||attempt==="uncertain")state.attempted++;
     if(attempt!=="sent")errors++;
    }catch{errors++;}
  }
  const updated=await db.from("staff_schedule_deliveries")
   .select("status,employee_id").eq("business_id",businessId).eq("publication_id",p.id).limit(201);
  if(updated.error||!updated.data)throw new Error("staff_publication_receipts_unavailable",{cause:updated.error});
  const receiptRows=updated.data;
  const possible=new Set(p.snapshot.map(s=>s.employee_id));
  const present=new Set(receiptRows.map(x=>x.employee_id));
  const missing=[...possible].filter(id=>!present.has(id)).length;
  const failures=receiptRows.filter(x=>["failed","uncertain","sending"].includes(x.status)).length;
  const pending=receiptRows.filter(x=>["prepared","sent"].includes(x.status)).length;
  const delivered=receiptRows.filter(x=>["delivered","read","sent_by_owner"].includes(x.status)).length;
  const complete=errors===0&&missing===0&&failures===0&&pending===0;
  const evidence={week:p.week_start,publicationId:p.id,
   eligible:receiptRows.length,delivered,missing,failures,pending,
   providerEnabled:blockers.length===0};
  const taskId="staff-publication:"+p.id;
  const t=await db.from("operating_tasks").upsert({
   business_id:businessId,id:taskId,agent_id:"olivia",owner_user_id:p.owner_user_id,
   kind:"staff_schedule_delivery",entity_type:"schedule",entity_id:p.id,
   status:complete?"handled":"needs_owner",confidence:"high",
   payload:{title:complete?"Staff schedule receipts confirmed":
    blockers.length?"Staff schedule published; messaging requires provider setup":
    missing||failures?"Staff schedule requires messaging attention":"Staff schedule delivery awaiting confirmation",
    ...evidence},
   evidence:[{source:"staff_schedule_deliveries",facts:evidence}],
   ...(complete?{resolved_at:new Date().toISOString()}:{}),
  },{onConflict:"business_id,id"});
  if(t.error)result(t.error);
  if(!complete)state.blocked++;
 }
 return state;
}

/** A live, RLS-authorized Staff screen projection. Status never implies that
 * acceptance, delivery, employee acknowledgement or attendance are the same. */
export async function readStaffWeekPublication(week:string):Promise<null|{
 publishedAt:string;publicationId:string;expected:number;prepared:number;accepted:number;
 delivered:number;read:number;openedManually:number;failed:number;uncertain:number;
}>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(week))return null;
 const owner=await requireSchedulingOwner();
 if(!owner)return null;
 const publication=await owner.supabase.from("staff_schedule_publications")
  .select("id,published_at,snapshot").eq("business_id",owner.businessId)
  .eq("week_start",week).eq("status","published").maybeSingle();
 if(publication.error)result(publication.error);
 if(!publication.data)return null;
 const p=publication.data;
 const deliveries=await owner.supabase.from("staff_schedule_deliveries")
  .select("employee_id,status").eq("business_id",owner.businessId)
  .eq("publication_id",p.id).limit(201);
 if(deliveries.error||!deliveries.data)result(deliveries.error);
 const rows=deliveries.data??[];
 const shifts=p.snapshot as Shift[];
 if(!Array.isArray(shifts))result("invalid_snapshot");
 return {publishedAt:p.published_at,publicationId:p.id,
  expected:new Set(shifts.map(x=>x.employee_id)).size,
  prepared:rows.filter(x=>x.status==="prepared"||x.status==="sending").length,
  accepted:rows.filter(x=>x.status==="sent").length,
  delivered:rows.filter(x=>x.status==="delivered").length,
  read:rows.filter(x=>x.status==="read").length,
  openedManually:rows.filter(x=>x.status==="sent_by_owner").length,
  failed:rows.filter(x=>x.status==="failed").length,
  uncertain:rows.filter(x=>x.status==="uncertain").length};
}
