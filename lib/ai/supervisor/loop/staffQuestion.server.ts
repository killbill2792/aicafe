import "server-only";
import {z} from "zod";
import {formatInTimeZone} from "date-fns-tz";
import {shiftCafeDate} from "@/lib/metrics/core/clock";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {registerLoopCapability,effectHash} from "./engine";
import {simulationOwnerReader} from "./simulationOwner.server";
import {staffQuestionInput} from "@/lib/staffCommunication/ownerQuestion.contract";

export const staffQuestionCapabilityId="olivia.staff_question.v1";
export const staffQuestionEffect=staffQuestionInput.extend({
  sourceRevision:z.iso.datetime({offset:true}),
  employeeName:z.string().min(1).max(200),
});
export type StaffQuestionEffect=z.infer<typeof staffQuestionEffect>;
export type StaffQuestionInput=z.infer<typeof staffQuestionInput>;

/** A draft is not authorization to contact a worker. Only the existing owner
 * proposal's click-claimed effect may commit through its verified SQL writer. */
export const staffQuestionCapability=registerLoopCapability({
 id:staffQuestionCapabilityId,version:1,inputSchema:staffQuestionInput,
 effectSchema:staffQuestionEffect,
 proposalDescription:"Ask the verified on-shift employee only after owner approval, allow the owner to answer naturally in chat, or ignore. Never send on model authority.",
 dependencyScope:e=>({sourceKind:e.sourceKind,sourceTaskId:e.sourceTaskId,employeeId:e.employeeId,sourceRevision:e.sourceRevision}),
 simulate:async(scope,input)=>{
  const {client}=await simulationOwnerReader(scope);
  const taskSource=input.sourceKind==="operating_task";
  const [task,person,business]=await Promise.all([
   taskSource?client.from("operating_tasks").select("id,status,kind,updated_at")
    .eq("business_id",scope.businessId)
    .or("owner_user_id.is.null,owner_user_id.eq."+scope.ownerUserId)
    .eq("id",input.sourceTaskId).maybeSingle():
    client.from("alerts").select("id,status,kind,created_at")
     .eq("business_id",scope.businessId).eq("id",input.sourceTaskId).maybeSingle(),
   client.from("employees").select("id,display_name,active,staff_auth_user_id")
    .eq("business_id",scope.businessId).eq("id",input.employeeId).maybeSingle(),
   client.from("businesses").select("timezone").eq("id",scope.businessId).maybeSingle()
  ]);
  if(task.error||person.error||business.error||!task.data||!person.data?.active||
     !person.data.staff_auth_user_id||!business.data?.timezone||
     !(taskSource?["needs_owner","needs_response","watching"]:["new","seen"]).includes(task.data.status))
   throw new Error("staff_question_source_or_employee_unavailable");
  let localDate:string,localClock:string;
  try{
   localDate=formatInTimeZone(new Date(),business.data.timezone,"yyyy-MM-dd");
   localClock=formatInTimeZone(new Date(),business.data.timezone,"HH:mm:ss");
  }catch{throw new Error("cafe_timezone_invalid");}
  const prior=shiftCafeDate(localDate,-1);
  const shifts=await client.from("scheduled_shifts")
   .select("local_date,start_local,end_local,overnight")
   .eq("business_id",scope.businessId).eq("employee_id",person.data.id)
   .eq("status","sent").is("deleted_at",null)
   .gte("local_date",prior).lte("local_date",localDate).limit(30);
  if(shifts.error||!shifts.data||shifts.data.length>=30)throw new Error("staff_shift_unavailable");
  const onShift=shifts.data.some(s=>{
   const start=String(s.start_local),end=String(s.end_local);
   return s.local_date===localDate&&localClock>=start&&(s.overnight||localClock<end)||
    s.local_date===prior&&s.overnight&&localClock<end;
  });
  if(!onShift)throw new Error("worker_not_on_current_published_shift");
  if(input.followUpAfter&&Date.parse(input.followUpAfter)<=Date.now())
   throw new Error("staff_follow_up_must_be_future");
  const sourceRow=task.data as {id:string;updated_at?:string;created_at?:string};
  const sourceRevision=taskSource?sourceRow.updated_at:sourceRow.created_at;
  if(!sourceRevision)throw new Error("staff_question_source_revision_unavailable");
  const effect={...input,sourceRevision,employeeName:person.data.display_name};
  return {effect,baseline:{source:input.sourceKind,sourceTaskId:sourceRow.id,
    sourceRevision,evidence:input.evidence,
    selection:"scheduled_now_not_attendance_confirmed"},
   monitorSpec:{durationDays:1,metricScope:"staff_question_receipt"}};
 },
 commit:async(scope,effect,proposalId)=>{
  if(!proposalId)throw new Error("staff_question_proposal_required");
  const {data,error}=await createAdminSupabaseClient().rpc("supervisor_commit_staff_question",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
   p_thread_id:scope.threadId,p_proposal_id:proposalId,p_effect_hash:effectHash(effect)
  });
  if(error?.code==="40001"){
   const stale=new Error("source_or_worker_changed");stale.name="StaleProposalError";throw stale;
  }
  if(error||typeof data?.id!=="string")throw new Error("staff_question_receipt_not_verified");
  return {status:"verified",evidenceSource:"staff_communication_requests"};
 },
 monitor:async()=>null,
 report:async()=>({status:"complete",result:{questionReceiptOnly:true,staffAnswerVerified:false},
  recommendation:"keep",source:"staff_communication_requests"}),
});
