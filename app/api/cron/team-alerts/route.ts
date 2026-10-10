import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {notificationEnabled,safeTaskKind,deliverOwnerTemplate} from "@/lib/ai/notifications/whatsapp.server";
import {NextResponse} from "next/server";
export const runtime="nodejs";export const dynamic="force-dynamic";
const respond=(status:number,result:unknown)=>NextResponse.json(result,{status,headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request){
 // Secret must be configured and match exactly. Never reveal whether a user/phone exists.
 const secret=process.env.CRON_SECRET;
 if(!secret||request.headers.get("authorization")!=="Bearer "+secret)return respond(401,{error:"unauthorized"});
 if(!notificationEnabled())return respond(503,{error:"provider_not_configured"});
 const db=createAdminSupabaseClient();
 const {data:subscribers,error}=await db.from("ai_owner_notifications")
   .select("business_id,owner_user_id,phone_e164").eq("opted_in",true).limit(100);
 if(error)return respond(503,{error:"delivery_queue_unavailable"});
 const today=new Date().toISOString().slice(0,10);
 let sent=0,failed=0;
 for(const sub of subscribers??[]){
  // Auth phone confirmation can be revoked after subscription.
  const auth=await db.auth.admin.getUserById(sub.owner_user_id);
  const person=auth.data.user;
  if(auth.error||!person?.phone_confirmed_at||person.phone!==sub.phone_e164)continue;
  const {data:tasks,error:taskError}=await db.from("operating_tasks")
    .select("id,kind,status").eq("business_id",sub.business_id).eq("status","needs_owner")
    .order("created_at",{ascending:false}).limit(1);
  if(taskError||!tasks?.length)continue;
  const task=tasks[0];
  const kind=safeTaskKind(task);
  if(!kind)continue;
  // Reserve before external send. A timeout cannot accidentally trigger a duplicate.
  const {data:reservation,error:reserveError}=await db.from("ai_delivery_attempts").insert({
   business_id:sub.business_id,owner_user_id:sub.owner_user_id,
   task_id:task.id,task_status:"needs_owner",business_date:today,
  }).select("id").single();
  if(reserveError?.code==="23505")continue;
  if(reserveError||!reservation){failed++;continue;}
  const delivery=await deliverOwnerTemplate(sub.phone_e164,kind);
  await db.from("ai_delivery_attempts").update({
   state:delivery.sent?"sent":"failed",
   provider_message_id:delivery.sent?delivery.providerId:null,
   failure_code:delivery.sent?null:delivery.reason,
   sent_at:delivery.sent?new Date().toISOString():null,
  }).eq("id",reservation.id);
  if(delivery.sent)sent++;else failed++;
 }
 return respond(200,{sent,failed,checked:(subscribers??[]).length});
}
