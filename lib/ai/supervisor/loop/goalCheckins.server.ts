import "server-only";
import {createHash} from "node:crypto";
import {z} from "zod";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {CHECKIN_ANSWERS,type CheckinAnswer,type GoalEffect} from "@/lib/calc/goals/goalSpec";
import {goalCheckinText,type GoalLocale} from "@/lib/calc/goals/goalText";

/** Check-ins live in the shared inbox (operating_tasks): one item per goal and
 * day, "needs_owner" until answered, then "handled" with the answer. The same
 * question goes to the goal's chat thread. Ids are stable per goal (proposal)
 * and day, so nothing posts twice and identical goals never share a check-in. */
type Db=ReturnType<typeof createAdminSupabaseClient>;
export const checkinTaskId=(proposalId:string,date:string)=>"goal-checkin:"+proposalId+":"+date;
function messageId(key:string){
  const d=createHash("sha256").update(key).digest("hex");
  return d.slice(0,8)+"-"+d.slice(8,12)+"-4"+d.slice(13,16)+"-a"+d.slice(17,20)+"-"+d.slice(20,32);
}
export type GoalScope={businessId:string;ownerUserId:string;threadId:string;locale:GoalLocale};

export async function postGoalCheckin(db:Db,scope:GoalScope,proposalId:string,effect:GoalEffect,date:string):Promise<boolean>{
  if(!effect.checkin)return false;
  const id=checkinTaskId(proposalId,date);
  const task=await db.from("operating_tasks").upsert({business_id:scope.businessId,id,agent_id:"leo",kind:"goal_checkin",
    status:"needs_owner",confidence:"high",entity_type:"goal",entity_id:proposalId,
    payload:{goalTitle:effect.title,question:effect.checkin.question,audience:effect.checkin.audience,
      businessDate:date,proposalId,threadId:scope.threadId,answer:null,note:null},
    evidence:[]},{onConflict:"business_id,id",ignoreDuplicates:true});
  if(task.error)throw new Error("Goal check-in inbox unavailable");
  // Only the newest question stays open; older unanswered ones close quietly
  // (still counted as asked) so a daily goal never floods the inbox.
  const now=new Date().toISOString();
  const closed=await db.from("operating_tasks").update({status:"handled",resolved_at:now,updated_at:now})
    .eq("business_id",scope.businessId).eq("kind","goal_checkin").eq("entity_id",proposalId)
    .eq("status","needs_owner").neq("id",id);
  if(closed.error)throw new Error("Goal check-in inbox unavailable");
  const inserted=await db.from("ai_messages").insert({id:messageId(scope.businessId+":"+id),business_id:scope.businessId,
    thread_id:scope.threadId,owner_user_id:scope.ownerUserId,author_user_id:null,role:"supervisor",
    content_type:"blocks",text_content:null,structured_content:[{type:"text",text:goalCheckinText(effect,scope.locale)}],
    grounding:{status:"partial",intent:"operating_tasks",evidence:[{source:"operating_tasks",identifier:id,asOf:date}]}});
  if(inserted.error&&inserted.error.code!=="23505")throw new Error("Goal check-in message unavailable");
  return !inserted.error;
}

const row=z.object({id:z.string(),status:z.string(),payload:z.record(z.string(),z.unknown())});
/** Every check-in asked for this goal so far, with its answer if given. */
export async function readGoalCheckins(db:Db,businessId:string,proposalId:string){
  const {data,error}=await db.from("operating_tasks").select("id,status,payload")
    .eq("business_id",businessId).eq("kind","goal_checkin").eq("entity_id",proposalId).limit(200);
  if(error)throw new Error("Goal check-ins unavailable");
  return z.array(row).parse(data??[]).map(r=>{
    const a=r.payload.answer;
    return {id:r.id,date:String(r.payload.businessDate??""),
      answer:(CHECKIN_ANSWERS as readonly unknown[]).includes(a)?a as CheckinAnswer:null,
      note:typeof r.payload.note==="string"?r.payload.note:null};
  });
}

/** Records the owner's answer on the given (or latest open) check-in of a goal
 * the owner owns. Returns null when there is no such open check-in. */
export async function recordGoalCheckin(db:Db,scope:{businessId:string;ownerUserId:string},goalId:string,
  input:{date:string|null;answer:CheckinAnswer;note:string|null}){
  let q=db.from("operating_tasks").select("id,status,payload").eq("business_id",scope.businessId)
    .eq("kind","goal_checkin").eq("entity_id",goalId);
  q=input.date?q.eq("id",checkinTaskId(goalId,input.date)):q.eq("status","needs_owner");
  const {data,error}=await q.order("created_at",{ascending:false}).limit(1);
  if(error)throw new Error("Goal check-ins unavailable");
  const [found]=z.array(row).parse(data??[]);
  if(!found)return null;
  const now=new Date().toISOString();
  const updated=await db.from("operating_tasks").update({status:"handled",resolved_at:now,updated_at:now,
    payload:{...found.payload,answer:input.answer,note:input.note?.slice(0,500)??null,answeredAt:now}})
    .eq("business_id",scope.businessId).eq("id",found.id);
  if(updated.error)throw new Error("Goal check-in save failed");
  return {id:found.id,date:String(found.payload.businessDate??""),answer:input.answer};
}
