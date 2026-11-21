import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {formatInTimeZone,fromZonedTime} from "date-fns-tz";
import {paidHoursForTimecard} from "@/lib/calc/staff";
import {shiftCafeDate} from "@/lib/metrics/core/clock";

const uuid=z.uuid();
const replySchema=z.strictObject({
 requestId:uuid.nullable(),response:z.enum(["confirm","decline","complete","message","report"]),
 body:z.string().max(2000).nullable(),nonce:uuid,
});
const linkSchema=z.strictObject({
 employeeId:uuid,email:z.email().max(320).nullable(),
});
const createLoginSchema=z.strictObject({
 employeeId:uuid,email:z.email().max(320),password:z.string().min(12).max(128),
});
type EmployeeIdentity={id:string;businessId:string;name:string};
export class StaffChannelError extends Error{
 constructor(public code:"unauthorized"|"not_linked"|"invalid"|"storage"|"conflict"|"stale_request"){super(code);}
}
/** Auth never comes from an employee-supplied business ID, email or phone.
 * This is a service read of only the identity needed for worker isolation. */
export async function currentStaffIdentity():Promise<EmployeeIdentity|null>{
 const session=await createServerSupabaseClient();
 const {data:{user},error}=await session.auth.getUser();
 if(error||!user)return null;
 const {data,error:lookupError}=await createAdminSupabaseClient().from("employees")
  .select("id,business_id,display_name").eq("staff_auth_user_id",user.id)
  .eq("active",true).limit(2);
 if(lookupError||!data)throw new StaffChannelError("storage");
 if(data.length>1)throw new StaffChannelError("conflict");
 const employee=data[0];
 return employee?{id:employee.id,businessId:employee.business_id,name:employee.display_name}:null;
}
export type StaffRequest={
 id:string;kind:string;title:string;prompt:string;status:string;created_at:string;source_type?:string;
};
export type StaffMessage={
 id:string;request_id:string|null;response_code:string;body:string|null;
 channel:string;received_at:string;employee_id?:string;actor:string;
};
export type StaffOwnWork={
 timezone:string;
 dailyHours:Array<{date:string;hours:number|null}>;
 shifts:Array<{id:string;date:string;start:string;end:string;overnight:boolean;breakMinutes:number}>;
 timecards:Array<{id:string;date:string;hours:number|null;hasOpenClockOut:boolean}>;
 breakNotices:Array<{timecardId:string;message:string;at:string}>;
};
/** This is the existing staff channel's employee-only projection, never an
 * owner roster, full labor table, wage record or unrestricted query endpoint.
 * The identity is resolved from the authenticated session before this call;
 * a client cannot supply or override its employee or café identifiers. */
async function readOwnStaffWork(identity:EmployeeIdentity,admin:ReturnType<typeof createAdminSupabaseClient>):
 Promise<StaffOwnWork>{
 const business=await admin.from("businesses").select("timezone")
  .eq("id",identity.businessId).maybeSingle();
 if(business.error||!business.data?.timezone)throw new StaffChannelError("storage");
 const timezone=business.data.timezone;
 let today:string,since:string;
 try{
  today=formatInTimeZone(new Date(),timezone,"yyyy-MM-dd");
  since=fromZonedTime(shiftCafeDate(today,-30)+"T00:00:00",timezone).toISOString();
 }catch{throw new StaffChannelError("storage");}
 const until=shiftCafeDate(today,14);
 // Every service-role query is doubly bound to this verified worker and café.
 // Unlinked Toast workers stay unlinked; never match a name to infer hours.
 const [shifts,cards,alerts]=await Promise.all([
  admin.from("scheduled_shifts")
   .select("id,local_date,start_local,end_local,overnight,break_minutes")
   .eq("business_id",identity.businessId).eq("employee_id",identity.id)
   .eq("status","sent").is("deleted_at",null).gte("local_date",today)
   .lte("local_date",until).order("local_date").limit(51),
  admin.from("timecards")
   .select("id,clock_in,clock_out,breaks,source_type")
   .eq("business_id",identity.businessId).eq("employee_id",identity.id)
   .neq("source_type","owner_schedule").gte("clock_in",since)
   .order("clock_in",{ascending:false}).limit(101),
  admin.from("staff_rule_alerts")
   .select("timecard_id,message,created_at")
   .eq("business_id",identity.businessId).eq("employee_id",identity.id)
   .eq("status","new").order("created_at",{ascending:false}).limit(51),
 ]);
 if(shifts.error||cards.error||alerts.error||!shifts.data||!cards.data||!alerts.data||
  shifts.data.length>50||cards.data.length>100||alerts.data.length>50)
  throw new StaffChannelError("storage");
 const timecards=cards.data.map(card=>{
  const breaks=Array.isArray(card.breaks)?card.breaks.filter((b):b is {start:string;end:string;paid:boolean}=>
   b!==null&&typeof b==="object"&&typeof b.start==="string"&&
   typeof b.end==="string"&&typeof b.paid==="boolean"&&
   Number.isFinite(Date.parse(b.start))&&Number.isFinite(Date.parse(b.end))&&
   Date.parse(b.end)>=Date.parse(b.start)):[];
  const breaksComplete=Array.isArray(card.breaks)&&breaks.length===card.breaks.length;
  const closed=Boolean(card.clock_out)&&Number.isFinite(Date.parse(card.clock_out));
  const known=closed&&breaksComplete&&Number.isFinite(Date.parse(card.clock_in));
  // Reuse the same existing recorded-hours calculation; open clock-outs are
  // unknown, not hours worked through an invented end time.
  const hours=known?paidHoursForTimecard({
   clockIn:card.clock_in,clockOut:card.clock_out,hourlyWageCents:null,breaks,
  }):null;
  if(hours!==null&&(!Number.isFinite(hours)||hours<0))throw new StaffChannelError("storage");
  return {id:card.id,date:formatInTimeZone(card.clock_in,timezone,"yyyy-MM-dd"),
   hours:hours===null?null:Math.round(hours*100)/100,hasOpenClockOut:!card.clock_out};
 });
 const grouped=new Map<string,number|null>();
 for(const card of timecards){
  const last=grouped.get(card.date);
  grouped.set(card.date,card.hours===null||last===null?null:
   Math.round(((last??0)+card.hours)*100)/100);
 }
 return {timezone,dailyHours:[...grouped].map(([date,hours])=>({date,hours})),
  shifts:shifts.data.map(row=>({id:row.id,date:row.local_date,start:row.start_local,
   end:row.end_local,overnight:row.overnight,breakMinutes:row.break_minutes})),
  timecards,
  breakNotices:alerts.data.map(row=>({
   timecardId:row.timecard_id,message:row.message,at:row.created_at,
  })),
 };
}
export async function getStaffInbox():Promise<{
 name:string;requests:StaffRequest[];messages:StaffMessage[];self:StaffOwnWork|null;
}>{
 const identity=await currentStaffIdentity();
 if(!identity)throw new StaffChannelError("not_linked");
 const admin=createAdminSupabaseClient();
 const synced=await admin.rpc("staff_channel_sync_shift_requests",{
  p_business_id:identity.businessId,
 });
 if(synced.error)throw new StaffChannelError("storage");
 // RLS is enforced by the user's own session as well as explicit identity keys.
 const db=await createServerSupabaseClient();
 const [requestRows,messageRows,self]=await Promise.all([
  db.from("staff_communication_requests")
   .select("id,kind,title,prompt,status,created_at,source_type")
   .eq("business_id",identity.businessId).eq("employee_id",identity.id)
   .in("status",["open","responded"])
   .order("created_at",{ascending:false}).limit(100),
  db.from("staff_communication_messages")
   .select("id,request_id,response_code,body,channel,received_at,actor")
   .eq("business_id",identity.businessId).eq("employee_id",identity.id)
   .order("received_at",{ascending:false}).limit(60),
  // A temporary private timecard or break-alert read failure must not
  // prevent this employee from replying to assigned work or reporting an issue.
  readOwnStaffWork(identity,admin).catch(()=>null),
 ]);
 if(requestRows.error||messageRows.error)throw new StaffChannelError("storage");
 return {name:identity.name,requests:requestRows.data??[],messages:messageRows.data??[],self};
}
export async function submitStaffReply(raw:unknown){
 const parsed=replySchema.safeParse(raw);
 if(!parsed.success)throw new StaffChannelError("invalid");
 if(!await currentStaffIdentity())throw new StaffChannelError("unauthorized");
 const db=await createServerSupabaseClient();
 const {data,error}=await db.rpc("staff_channel_submit",{
  p_request_id:parsed.data.requestId,p_response:parsed.data.response,
  p_body:parsed.data.body,p_nonce:parsed.data.nonce,
 });
 if(error){
  // The SQL RPC checks exact (worker,nonce,payload) replay BEFORE request
  // status/revision. These specific errors prove the operation did NOT write.
  // A nonce_conflict is different: a previous write may exist, so retain its
  // uncertain outbox rather than labeling it definitively unsaved.
  if(["shift_changed","unavailable_request","response_not_allowed"]
   .some(reason=>error.message.includes(reason)))
   throw new StaffChannelError("stale_request");
  if(error.code==="40900")throw new StaffChannelError("conflict");
  throw new StaffChannelError("invalid");
 }
 if(!data||typeof data.id!=="string")throw new StaffChannelError("storage");
 return data as {id:string;replayed:boolean};
}
export async function ownerStaffLoginList(){
 const owner=await requireSchedulingOwner();
 if(!owner)throw new StaffChannelError("unauthorized");
 const {data,error}=await owner.supabase.from("employees")
  .select("id,display_name,active,staff_auth_user_id")
  .eq("business_id",owner.businessId)
  .order("display_name").limit(201);
 if(error||!data||data.length>200)throw new StaffChannelError("storage");
 return data.map(e=>({id:e.id,name:e.display_name,active:e.active,linked:Boolean(e.staff_auth_user_id)}));
}
export async function ownerLinkExistingLogin(raw:unknown){
 const parsed=linkSchema.safeParse(raw);
 if(!parsed.success)throw new StaffChannelError("invalid");
 const owner=await requireSchedulingOwner();
 if(!owner)throw new StaffChannelError("unauthorized");
 const {data,error}=await owner.supabase.rpc("staff_link_existing_login",{
  p_business_id:owner.businessId,p_employee_id:parsed.data.employeeId,
  p_email:parsed.data.email,
 });
 if(error||!data)throw new StaffChannelError(error?.code==="23505"?"conflict":"invalid");
 return {linked:data.linked===true};
}
/** Owner-provisioned password account. The password stays in this authenticated
 * server request only: never return, retain, log or embed it in a share URL.
 * Reuse the existing confirmed-user linking RPC and all its tenant/role gates. */
export async function ownerCreateEmployeeLogin(raw:unknown){
 const parsed=createLoginSchema.safeParse(raw);
 if(!parsed.success)throw new StaffChannelError("invalid");
 const owner=await requireSchedulingOwner();
 if(!owner)throw new StaffChannelError("unauthorized");
 const {data:employee,error:lookupError}=await owner.supabase.from("employees")
  .select("id,active,staff_auth_user_id").eq("business_id",owner.businessId)
  .eq("id",parsed.data.employeeId).maybeSingle();
 if(lookupError)throw new StaffChannelError("storage");
 if(!employee||!employee.active)throw new StaffChannelError("invalid");
 if(employee.staff_auth_user_id)throw new StaffChannelError("conflict");
 const admin=createAdminSupabaseClient();
 const email=parsed.data.email.trim().toLowerCase();
 const created=await admin.auth.admin.createUser({
  email,password:parsed.data.password,email_confirm:true,
 });
 if(created.error||!created.data.user)throw new StaffChannelError(
  created.error?.status===422||created.error?.status===409?"conflict":"storage");
 const userId=created.data.user.id;
 const linked=await owner.supabase.rpc("staff_link_existing_login",{
  p_business_id:owner.businessId,p_employee_id:parsed.data.employeeId,p_email:email,
 });
 if(linked.error||linked.data?.linked!==true){
  // The link may have committed while its HTTP receipt was lost. Never
  // delete a successfully linked login on an uncertain network response.
  const verified=await owner.supabase.from("employees").select("staff_auth_user_id")
   .eq("business_id",owner.businessId).eq("id",parsed.data.employeeId).maybeSingle();
  if(!verified.error&&verified.data?.staff_auth_user_id===userId)
   return {linked:true,loginPath:"/crew/login"};
  if(!verified.error&&["23505","42501","22023"].includes(linked.error?.code??"")){
   // Only a definitive database rejection permits cleanup; a late RPC
   // acknowledgement could still commit, so uncertain outcomes retain access.
   // Another worker's successful identity link always blocks deletion.
   const linkedElsewhere=await admin.from("employees")
    .select("id").eq("staff_auth_user_id",userId).limit(1);
   if(linkedElsewhere.error)throw new StaffChannelError("storage");
   if(linkedElsewhere.data?.length)throw new StaffChannelError("conflict");
   const removed=await admin.auth.admin.deleteUser(userId);
   if(removed.error)throw new StaffChannelError("storage");
  }
  throw new StaffChannelError("storage");
 }
 return {linked:true,loginPath:"/crew/login"};
}
const ownerMessageSchema=z.strictObject({
 employeeId:uuid,body:z.string().trim().min(1).max(2000),nonce:uuid,
});
/** Owner click is the sole authority for direct in-app messaging. It does
 * not send through Meta, create an employee login or mark any shift covered. */
export async function sendOwnerStaffMessage(raw:unknown){
 const parsed=ownerMessageSchema.safeParse(raw);
 if(!parsed.success)throw new StaffChannelError("invalid");
 const owner=await requireSchedulingOwner();
 if(!owner)throw new StaffChannelError("unauthorized");
 const {data,error}=await owner.supabase.rpc("staff_channel_owner_send",{
  p_employee_id:parsed.data.employeeId,p_body:parsed.data.body,
  p_nonce:parsed.data.nonce,
 });
 if(error){
  // A serialized, owner-authorized nonce lookup already proved no prior save.
  if(error.message.includes("owner_target_unavailable"))
   throw new StaffChannelError("stale_request");
  if(error.code==="42501")throw new StaffChannelError("unauthorized");
  if(error.code==="40900")throw new StaffChannelError("conflict");
  if(error.code==="22023")throw new StaffChannelError("invalid");
  throw new StaffChannelError("storage");
 }
 if(!data||typeof data.id!=="string")throw new StaffChannelError("storage");
 return data as {id:string;replayed:boolean};
}
const ownerAssignmentSchema=z.strictObject({
 employeeId:uuid,kind:z.enum(["checklist","task"]),
 title:z.string().trim().min(1).max(200),
 prompt:z.string().trim().min(1).max(2000),nonce:uuid,
});
/** Shared task/checklist producer: owner click is its in-app authority.
 * Future automated producers must obtain their own scope+approval and may
 * NOT call this owner-session function with a synthetic identity. */
export async function assignOwnerStaffWork(raw:unknown){
 const parsed=ownerAssignmentSchema.safeParse(raw);
 if(!parsed.success)throw new StaffChannelError("invalid");
 const owner=await requireSchedulingOwner();
 if(!owner)throw new StaffChannelError("unauthorized");
 const {data,error}=await owner.supabase.rpc("staff_channel_owner_assign",{
  p_employee_id:parsed.data.employeeId,p_kind:parsed.data.kind,
  p_title:parsed.data.title,p_prompt:parsed.data.prompt,
  p_nonce:parsed.data.nonce,
 });
 if(error){
  // A serialized, owner-authorized nonce lookup already proved no prior save.
  if(error.message.includes("owner_target_unavailable"))
   throw new StaffChannelError("stale_request");
  if(error.code==="42501")throw new StaffChannelError("unauthorized");
  if(error.code==="40900"||error.code==="23505")throw new StaffChannelError("conflict");
  if(error.code==="22023")throw new StaffChannelError("invalid");
  throw new StaffChannelError("storage");
 }
 if(!data||typeof data.id!=="string")throw new StaffChannelError("storage");
 return data as {id:string;replayed:boolean};
}
export type OwnerStaffMessage=StaffMessage&{
 employee_name:string;request_title:string|null;request_status:string|null;
};
/** Read source-scoped staff records through the caller's verified DB scope.
 * Do not accept a café identifier from the model or a worker browser. */
async function loadOwnerMessages(db:SupabaseClient,businessId:string,limit:number,employeeOnly=false):
 Promise<OwnerStaffMessage[]>{
 const query=db.from("staff_communication_messages")
  .select("id,employee_id,request_id,response_code,body,channel,received_at,actor")
  .eq("business_id",businessId)
  .order("received_at",{ascending:false}).limit(Math.min(limit,100));
 const {data,error}=await (employeeOnly?query.eq("actor","employee"):query);
 if(error||!data)throw new StaffChannelError("storage");
 if(!data.length)return [];
 const empIds=[...new Set(data.map(x=>x.employee_id))];
 const reqIds=[...new Set(data.flatMap(x=>x.request_id?[x.request_id]:[]))];
 const [people,requests]=await Promise.all([
  db.from("employees").select("id,display_name")
   .eq("business_id",businessId).in("id",empIds),
  reqIds.length?db.from("staff_communication_requests")
   .select("id,title,status").eq("business_id",businessId).in("id",reqIds):
   Promise.resolve({data:[] as Array<{id:string;title:string;status:string}>,error:null}),
 ]);
 if(people.error||requests.error)throw new StaffChannelError("storage");
 const names=new Map((people.data??[]).map(p=>[p.id,p.display_name]));
 const req=new Map((requests.data??[]).map(r=>[r.id,r]));
 return data.map(m=>({...m,employee_name:names.get(m.employee_id)??"Staff member",
  request_title:m.request_id?req.get(m.request_id)?.title??null:null,
  request_status:m.request_id?req.get(m.request_id)?.status??null:null}));
}
/** Owner interactive UI: require a real authenticated owner session. */
export async function readOwnerStaffMessages(limit=40):Promise<OwnerStaffMessage[]>{
 const owner=await requireSchedulingOwner();
 if(!owner)throw new StaffChannelError("unauthorized");
 return loadOwnerMessages(owner.supabase,owner.businessId,limit);
}
/** Existing off-turn Supervisor: the SQL-claimed owner/thread is verified
 * again against memberships, rather than assuming a browser cookie exists. */
export async function readStaffMessagesForVerifiedOwner(
 db:SupabaseClient,businessId:string,ownerUserId:string,limit=40
):Promise<OwnerStaffMessage[]>{
 const {data,error}=await db.from("memberships").select("role")
  .eq("business_id",businessId).eq("user_id",ownerUserId)
  .eq("role","owner").maybeSingle();
 if(error||!data)throw new StaffChannelError("unauthorized");
 return loadOwnerMessages(db,businessId,limit,true);
}

/** Full staff-to-owner communication history on the existing two tables.
 * Page by a strict (timestamp, UUID) cursor, never a capped latest-25 slice.
 * Every employee submission has its existing transactional owner inbox notice. */
export type OwnerStaffHistoryCursor={at:string;id:string};
export type OwnerStaffHistoryEvent={
 id:string;at:string;employeeId:string;employeeName:string;
 actor:"employee"|"owner"|"supervisor";kind:"request"|"message";
 text:string|null;requestTitle:string|null;status:string|null;
 responseCode:string|null;channel:string|null;
};
export type OwnerStaffHistoryPage={
 events:OwnerStaffHistoryEvent[];nextCursor:OwnerStaffHistoryCursor|null;
};
const historyCursor=z.strictObject({at:z.iso.datetime({offset:true}),id:uuid});
export async function readOwnerStaffHistory(rawCursor:unknown=null):
 Promise<OwnerStaffHistoryPage>{
 const parsed=rawCursor===null?null:historyCursor.safeParse(rawCursor);
 if(parsed!==null&&!parsed.success)throw new StaffChannelError("invalid");
 const cursor=parsed?.data??null,limit=25;
 const owner=await requireSchedulingOwner();
 if(!owner)throw new StaffChannelError("unauthorized");
 // Stable cursor across both request-created and message-received time. Never
 // trust an employeeId or businessId from URL; RLS checks the owner as well.
 let msg=owner.supabase.from("staff_communication_messages")
  .select("id,employee_id,request_id,response_code,body,channel,received_at,actor")
  .eq("business_id",owner.businessId);
 let req=owner.supabase.from("staff_communication_requests")
  .select("id,employee_id,title,prompt,status,source_type,created_at")
  .eq("business_id",owner.businessId);
 if(cursor){
  msg=msg.or(`received_at.lt.${cursor.at},and(received_at.eq.${cursor.at},id.lt.${cursor.id})`);
  req=req.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
 }
 const [messages,requests]=await Promise.all([
  msg.order("received_at",{ascending:false}).order("id",{ascending:false}).limit(limit+1),
  req.order("created_at",{ascending:false}).order("id",{ascending:false}).limit(limit+1),
 ]);
 if(messages.error||requests.error)throw new StaffChannelError("storage");
 const ms=messages.data??[],rs=requests.data??[];
 const ids=[...new Set([...ms.map(m=>m.employee_id),...rs.map(r=>r.employee_id)])];
 const linkedIds=[...new Set(ms.flatMap(m=>m.request_id?[m.request_id]:[]))];
 const [people,links]=await Promise.all([
  ids.length?owner.supabase.from("employees").select("id,display_name")
   .eq("business_id",owner.businessId).in("id",ids):
   Promise.resolve({data:[] as Array<{id:string;display_name:string}>,error:null}),
  linkedIds.length?owner.supabase.from("staff_communication_requests")
   .select("id,title").eq("business_id",owner.businessId).in("id",linkedIds):
   Promise.resolve({data:[] as Array<{id:string;title:string}>,error:null}),
 ]);
 if(people.error||links.error)throw new StaffChannelError("storage");
 const names=new Map((people.data??[]).map(p=>[p.id,p.display_name]));
 const titles=new Map((links.data??[]).map(r=>[r.id,r.title]));
 const events:OwnerStaffHistoryEvent[]=[
  ...rs.map(r=>({
   id:r.id,at:r.created_at,employeeId:r.employee_id,
   employeeName:names.get(r.employee_id)??"Staff member",
   actor:r.source_type==="owner_manual"?"owner" as const:"supervisor" as const,
   kind:"request" as const,text:r.prompt,requestTitle:r.title,
   status:r.status,responseCode:null,channel:null,
  })),
  ...ms.map(m=>({
   id:m.id,at:m.received_at,employeeId:m.employee_id,
   employeeName:names.get(m.employee_id)??"Staff member",
   actor:m.actor as OwnerStaffHistoryEvent["actor"],kind:"message" as const,
   text:m.body,requestTitle:m.request_id?titles.get(m.request_id)??null:null,
   status:null,responseCode:m.response_code,channel:m.channel,
  })),
 ];
 // PostgreSQL emits UTC timestamps at microsecond precision. Do not truncate
 // to JS milliseconds or an entire same-millisecond batch can be lost.
 const normalized=(at:string)=>at.replace("+00:00","Z")
  .replace(/\.(\d+)Z$/,(_match,digits:string)=>"."+digits.padEnd(6,"0")+"Z");
 events.sort((a,b)=>normalized(b.at).localeCompare(normalized(a.at))||
  b.id.localeCompare(a.id));
 const current=events.slice(0,limit),tail=current.at(-1);
 return {events:current,nextCursor:events.length>limit&&tail?
  {at:tail.at,id:tail.id}:null};
}

/** Compact owner-only preview for the EXISTING staff-response inbox task.
 * No new notification writer, source copy, or customer-facing content cache.
 * The caller supplies a verified owner/café-scoped database client. */
export async function staffResponseNoticePreviews(
 db:SupabaseClient,businessId:string,ids:readonly string[]
):Promise<Map<string,string>>{
 const wanted=[...new Set(ids)].filter(id=>uuid.safeParse(id).success).slice(0,60);
 if(!wanted.length)return new Map();
 const result=await db.from("staff_communication_messages")
  .select("id,employee_id,response_code,body")
  .eq("business_id",businessId).eq("actor","employee").in("id",wanted).limit(60);
 if(result.error||!result.data)throw new StaffChannelError("storage");
 const peopleIds=[...new Set(result.data.map(x=>x.employee_id))];
 if(!peopleIds.length)return new Map();
 const names=await db.from("employees").select("id,display_name")
  .eq("business_id",businessId).in("id",peopleIds).limit(60);
 if(names.error||!names.data)throw new StaffChannelError("storage");
 const byId=new Map(names.data.map(p=>[p.id,p.display_name]));
 return new Map(result.data.map(m=>{
  const who=(byId.get(m.employee_id)??"Employee").replace(/\s+/g," ").slice(0,55);
  const reply=typeof m.body==="string"?
   m.body.replace(/\s+/g," ").trim().slice(0,90):null;
  const fallback=m.response_code==="confirm"?"Confirmed a request (not a schedule change)":
   m.response_code==="decline"?"Declined an assignment":
   m.response_code==="complete"?"Reported completing assigned work":"Sent a response";
  return [m.id,who+(m.response_code==="report"?" reported: ":" replied: ")+(reply||fallback)] as const;
 }));
}
