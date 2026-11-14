import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {buildScheduleMessage} from "@/lib/calc/scheduling/ownerDeliveryLinks";
import {staffProviderBlockers,sendStaffScheduleTemplate} from "@/lib/whatsapp/staffScheduleDelivery.server";

type Scope={businessId:string;ownerUserId:string};
type Shift={employee_id:string;date:string;start:string;end:string};
type Publication={id:string;business_id:string;owner_user_id:string;
 proposal_id:string;week_start:string;snapshot:Shift[];status:string};
type Delivery={id:string;employee_id:string;status:string;recipient_e164:string};
const result=(error:unknown)=>{throw new Error("staff_publication_storage_unavailable",{cause:error});};

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

/** Called from the EXISTING durable café routine refresh. Never creates a new
 * cron/AI loop. Publication is a verified idempotent SQL effect; each staff
 * delivery is claimed once and is never replayed after a provider ambiguity.
 * Owner questions are written into existing operating_tasks, then the routine's
 * existing notice writer surfaces them in Supervisor and Operations. */
export async function followUpStaffPublicationForBusiness(db:SupabaseClient,
 businessId:string,localDate:string):Promise<{published:number;attempted:number;blocked:number}>{
 const state={published:0,attempted:0,blocked:0};
 // Only a newly created v2 effect with explicit owner-visible publish intent
 // is eligible. Old committed COPY-only approvals never get sent.
 const proposals=await db.from("supervisor_proposals")
  .select("id,owner_user_id,canonical_effect_payload")
  .eq("business_id",businessId).eq("capability_id","olivia.staff_propose_send_schedule.v2")
  .eq("status","committed").order("created_at",{ascending:false}).limit(60);
 if(proposals.error)result(proposals.error);
 for(const p of proposals.data??[]){
  const effect=p.canonical_effect_payload as {payload?:{week_start?:unknown;publish_and_notify?:unknown}}|null;
  if(effect?.payload?.publish_and_notify!==true||typeof effect.payload.week_start!=="string"||
    effect.payload.week_start<addDay(localDate,-6))continue;
  try{
   const done=await publishApprovedStaffSchedule({businessId,ownerUserId:p.owner_user_id},p.id);
   if(!done.replayed)state.published++;
  }catch{state.blocked++;}
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
  if(updated.error||!updated.data)result(updated.error);
  const possible=new Set(p.snapshot.map(s=>s.employee_id));
  const present=new Set(updated.data.map(x=>x.employee_id));
  const missing=[...possible].filter(id=>!present.has(id)).length;
  const failures=updated.data.filter(x=>["failed","uncertain","sending"].includes(x.status)).length;
  const pending=updated.data.filter(x=>["prepared","sent"].includes(x.status)).length;
  const delivered=updated.data.filter(x=>["delivered","read","sent_by_owner"].includes(x.status)).length;
  const complete=errors===0&&missing===0&&failures===0&&pending===0;
  const evidence={week:p.week_start,publicationId:p.id,
   eligible:updated.data.length,delivered,missing,failures,pending,
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
