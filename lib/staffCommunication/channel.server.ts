import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";

const uuid=z.uuid();
const replySchema=z.strictObject({
 requestId:uuid.nullable(),response:z.enum(["confirm","decline","complete","message","report"]),
 body:z.string().max(2000).nullable(),nonce:uuid,
});
const linkSchema=z.strictObject({
 employeeId:uuid,email:z.email().max(320).nullable(),
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
 id:string;kind:string;title:string;prompt:string;status:string;created_at:string;
};
export type StaffMessage={
 id:string;request_id:string|null;response_code:string;body:string|null;
 channel:string;received_at:string;employee_id?:string;actor:string;
};
export async function getStaffInbox():Promise<{
 name:string;requests:StaffRequest[];messages:StaffMessage[];
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
 const [requestRows,messageRows]=await Promise.all([
  db.from("staff_communication_requests")
   .select("id,kind,title,prompt,status,created_at")
   .eq("business_id",identity.businessId).eq("employee_id",identity.id)
   .in("status",["open","responded"])
   .order("created_at",{ascending:false}).limit(100),
  db.from("staff_communication_messages")
   .select("id,request_id,response_code,body,channel,received_at,actor")
   .eq("business_id",identity.businessId).eq("employee_id",identity.id)
   .order("received_at",{ascending:false}).limit(60),
 ]);
 if(requestRows.error||messageRows.error)throw new StaffChannelError("storage");
 return {name:identity.name,requests:requestRows.data??[],messages:messageRows.data??[]};
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
