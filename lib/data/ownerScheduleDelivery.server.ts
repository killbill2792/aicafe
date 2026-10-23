import "server-only";
import {z} from "zod";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {buildScheduleMessage,eligibleForChannel,type OwnerChannel,type ShiftForMessage} from "@/lib/calc/scheduling/ownerDeliveryLinks";

const uuid=z.uuid(),weekInput=z.iso.date();
const addDays=(day:string,count:number)=>
  new Date(Date.parse(day+"T12:00:00Z")+count*86400000).toISOString().slice(0,10);
const isMonday=(day:string)=>new Date(day+"T12:00:00Z").getUTCDay()===1;
export const scheduleSource=z.strictObject({
  proposalId:uuid.optional(),week:weekInput.optional(),
}).refine(s=>Boolean(s.proposalId)!==Boolean(s.week));
export type Recipient={
  id:string;name:string;phone:string|null;optedIn:boolean;preferredChannel:OwnerChannel;
  message:string;ledgerStatus:"prepared"|"sent_by_owner"|null;lastChannel:OwnerChannel|null;
  sentAt:string|null;
};
export type DeliveryList={source:{proposalId?:string;planRevisionId?:string};
  week:string;recipients:Recipient[]};
export class DeliveryReadError extends Error {
  constructor(public code:string){super(code);}
}
type Auth=NonNullable<Awaited<ReturnType<typeof requireSchedulingOwner>>>;
export async function scheduleDeliveryContext(){
 const owner=await requireSchedulingOwner();
 if(!owner)throw new DeliveryReadError("unauthorized");
 const {data:{user},error}=await owner.supabase.auth.getUser();
 if(error||!user)throw new DeliveryReadError("unauthorized");
 return {...owner,userId:user.id};
}
function checked<T>(data:T|null,error:{message:string}|null):T{
 if(error||data===null)throw new DeliveryReadError("storage_unavailable");
 return data;
}
function localClock(iso:string,zone:string,locale:"en"|"es"|"ar"){
 const date=new Date(iso);
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",
   month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
 const get=(type:string)=>parts.find(x=>x.type===type)?.value??"";
 void locale;
 return {date:get("year")+"-"+get("month")+"-"+get("day"),
   time:get("hour")+":"+get("minute")};
}
export async function readApprovedScheduleDelivery(source:unknown,
  locale:"en"|"es"|"ar",authenticated?:Auth&{userId:string}):Promise<DeliveryList>{
 const params=scheduleSource.parse(source);
 const owner=authenticated??await scheduleDeliveryContext();
 const db=createAdminSupabaseClient();
 let proposalId:string|undefined,planRevisionId:string|undefined,week:string;
 if(params.proposalId){
  const {data,error}=await db.from("supervisor_proposals")
    .select("id,capability_id,status,canonical_effect_payload")
    .eq("id",params.proposalId).eq("business_id",owner.businessId)
    .eq("owner_user_id",owner.userId).maybeSingle();
  if(error)throw new DeliveryReadError("storage_unavailable");
  if(!data||data.status!=="committed"||!["olivia.staff_propose_schedule.v1",
       "olivia.staff_propose_send_schedule.v1"].includes(data.capability_id))
   throw new DeliveryReadError("not_approved");
  const effect=data.canonical_effect_payload as {operation?:string;payload?:{week_start?:string}};
  week=effect.payload?.week_start??"";
  if(!weekInput.safeParse(week).success||!isMonday(week))
   throw new DeliveryReadError("invalid_week");
  proposalId=data.id;
 }else{
  week=params.week!;
  if(!isMonday(week))throw new DeliveryReadError("invalid_week");
  const {data:series,error}=await db.from("scheduling_plan_series")
    .select("id,current_revision,published_revision").eq("business_id",owner.businessId)
    .eq("horizon_start",week).maybeSingle();
  if(error)throw new DeliveryReadError("storage_unavailable");
  if(!series)throw new DeliveryReadError("not_approved");
  const {data:revisions,error:revisionError}=await db.from("scheduling_plan_revisions")
    .select("id,revision,status").eq("business_id",owner.businessId)
    .eq("series_id",series.id).in("status",["approved","published"]).limit(501);
  if(revisionError||!revisions||revisions.length>500)
    throw new DeliveryReadError("storage_unavailable");
  const revision=revisions.find(r=>r.status==="approved"&&r.revision===series.current_revision)
   ??revisions.find(r=>r.status==="published"&&r.revision===series.published_revision);
  if(!revision)throw new DeliveryReadError("not_approved");
  planRevisionId=revision.id;
 }
 let shifts:Array<{employee_id:string;date:string;start:string;end:string}>=[];
 if(proposalId){
  const {data:prop,error:propErr}=await db.from("supervisor_proposals")
    .select("capability_id,committed_at").eq("id",proposalId).eq("business_id",owner.businessId).single();
  if(propErr||!prop)throw new DeliveryReadError("storage_unavailable");
  let q=db.from("scheduled_shifts")
    .select("employee_id,local_date,start_local,end_local,updated_at")
    .eq("business_id",owner.businessId).is("deleted_at",null)
    .gte("local_date",week).lte("local_date",addDays(week,6))
    .order("local_date").order("start_local").limit(201);
  if(prop.capability_id==="olivia.staff_propose_schedule.v1")q=q.eq("proposal_id",proposalId);
  else q=q.lte("updated_at",prop.committed_at);
  const {data,error}=await q;
  if(error||!data||data.length>200)throw new DeliveryReadError("storage_unavailable");
  shifts=data.map(s=>({employee_id:s.employee_id,date:s.local_date,
    start:String(s.start_local).slice(0,5),end:String(s.end_local).slice(0,5)}));
 }else{
  const {data,error}=await db.from("scheduling_plan_assignments")
    .select("employee_id,starts_at,ends_at,location_id").eq("business_id",owner.businessId)
    .eq("plan_revision_id",planRevisionId!).order("starts_at").limit(201);
  if(error||!data||data.length>200)throw new DeliveryReadError("storage_unavailable");
  const ids=[...new Set(data.map(s=>s.location_id))];
  const {data:locations,error:locationError}=ids.length?await db.from("locations")
    .select("id,timezone").eq("business_id",owner.businessId).in("id",ids)
    :{data:[],error:null};
  if(locationError||!locations)throw new DeliveryReadError("storage_unavailable");
  const tzs=new Map(locations.map(l=>[l.id,l.timezone??"UTC"]));
  shifts=data.map(s=>{
   const tz=tzs.get(s.location_id)??"UTC";
   const start=localClock(s.starts_at,tz,locale),end=localClock(s.ends_at,tz,locale);
   return {employee_id:s.employee_id,date:start.date,start:start.time,end:end.time};
  });
 }
 if(!shifts.length)return {source:{...(proposalId?{proposalId}:{planRevisionId})},
   week,recipients:[]};
 const ids=[...new Set(shifts.map(s=>s.employee_id))];
 const [{data:people,error:peopleError},{data:history,error:historyError}]=await Promise.all([
   db.from("employees").select("id,display_name,phone_e164,whatsapp_opt_in,preferred_schedule_channel,active")
     .eq("business_id",owner.businessId).in("id",ids),
   db.from("staff_schedule_deliveries")
     .select("employee_id,status,channel,sent_at").eq("business_id",owner.businessId)
     .eq(proposalId?"proposal_id":"plan_revision_id",(proposalId??planRevisionId)!)
     .limit(201),
 ]);
 if(peopleError||historyError||!people||!history||people.length!==ids.length)
   throw new DeliveryReadError("storage_unavailable");
 const recipients=people.filter(p=>p.active).map(p=>{
   const rows:ShiftForMessage[]=shifts.filter(s=>s.employee_id===p.id)
     .map(s=>({date:s.date,start:s.start,end:s.end}));
   const h=history.find(x=>x.employee_id===p.id);
   const phone=eligibleForChannel(p.phone_e164,p.whatsapp_opt_in,"sms")==="ready"?p.phone_e164:null;
   return {id:p.id,name:p.display_name,phone,optedIn:p.whatsapp_opt_in===true,
     preferredChannel:(p.preferred_schedule_channel==="sms"?"sms":"whatsapp") as OwnerChannel,
     message:buildScheduleMessage(locale,p.display_name,week,rows),
     ledgerStatus:(h?.status==="sent_by_owner"?"sent_by_owner":h?.status==="prepared"?"prepared":null) as Recipient["ledgerStatus"],
     lastChannel:(h?.channel==="sms"?"sms":h?.channel==="whatsapp"?"whatsapp":null) as OwnerChannel|null,
     sentAt:h?.sent_at??null};
 });
 return {source:{...(proposalId?{proposalId}:{planRevisionId})},week,recipients};
}
export async function markOwnerScheduleDelivery(raw:unknown){
 const params=z.strictObject({proposalId:uuid.optional(),week:weekInput.optional(),
   employeeId:uuid,channel:z.enum(["whatsapp","sms"])}).parse(raw);
 const owner=await scheduleDeliveryContext();
 // Resolve source on every write (including approval status/tenant) before SQL CAS.
 const schedule=await readApprovedScheduleDelivery({
   ...(params.proposalId?{proposalId:params.proposalId}:{week:params.week}),
 },"en",owner);
 const person=schedule.recipients.find(x=>x.id===params.employeeId);
 if(!person||eligibleForChannel(person.phone,person.optedIn,params.channel)!=="ready")
  throw new DeliveryReadError("recipient_not_eligible");
 const {data,error}=await createAdminSupabaseClient().rpc("staff_mark_owner_delivery",{
   p_business_id:owner.businessId,p_owner_user_id:owner.userId,p_employee_id:params.employeeId,
   p_channel:params.channel,p_proposal_id:schedule.source.proposalId??null,
   p_plan_revision_id:schedule.source.planRevisionId??null,
 });
 if(error)throw new DeliveryReadError("delivery_conflict");
 return data as {state:"opened"|"already_opened";channel:OwnerChannel;at?:string};
}
export async function updateScheduleChannelPreference(raw:unknown){
 const params=z.strictObject({employeeId:uuid,channel:z.enum(["whatsapp","sms"])}).parse(raw);
 const owner=await scheduleDeliveryContext();
 const {data,error}=await owner.supabase.from("employees")
   .update({preferred_schedule_channel:params.channel})
   .eq("business_id",owner.businessId).eq("id",params.employeeId)
   .select("id").maybeSingle();
 if(error||!data)throw new DeliveryReadError("not_found");
 return {channel:params.channel};
}
