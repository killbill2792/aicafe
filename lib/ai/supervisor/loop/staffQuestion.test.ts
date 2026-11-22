import {beforeEach,describe,expect,it,vi} from "vitest";
import {staffQuestionInput,ownerStaffQuestionDecision} from "@/lib/staffCommunication/ownerQuestion.contract";
import {staffQuestionCapability,staffQuestionCapabilityId} from "./staffQuestion.server";
import {simulationOwnerReader} from "./simulationOwner.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {staffQuestionTools} from "@/lib/ai/agent/tools/staffQuestion";
import type {AgentToolContext} from "@/lib/ai/agent/tools";
vi.mock("server-only",()=>({}));
vi.mock("./simulationOwner.server",()=>({simulationOwnerReader:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:vi.fn()}));
vi.mock("date-fns-tz",()=>({formatInTimeZone:(_now:Date,_tz:string,fmt:string)=>
 fmt==="yyyy-MM-dd"?"2026-11-21":"12:00:00"}));
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const owner="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const employee="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const thread="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const input={sourceKind:"operating_task" as const,sourceTaskId:"staff-note-17",employeeId:employee,question:"How many cups remain in storage?",
 reason:"Physical stock is not independently verified",
 evidence:[{source:"verified_order_lines",asOf:"2026-11-21T20:00:00Z"}],
 followUpAfter:new Date(Date.now()+3*60*60_000).toISOString()};
const sourceRevision="2026-11-21T20:00:00Z";
function dbRows({staffActive=true,linked=true,onShift=true,taskStatus="needs_owner"}={}){
 const sources:Record<string,unknown[]>={
  operating_tasks:[{id:input.sourceTaskId,status:taskStatus,kind:"data_quality",updated_at:sourceRevision}],
  alerts:[{id:input.sourceTaskId,status:"new",kind:"business_anomaly",created_at:sourceRevision}],
  employees:[{id:employee,display_name:"Priya",active:staffActive,staff_auth_user_id:linked?owner:null}],
  businesses:[{timezone:"America/Los_Angeles"}],
  scheduled_shifts:onShift?[{local_date:"2026-11-21",start_local:"11:00:00",
   end_local:"14:00:00",overnight:false}]:[],
 };
 const from=vi.fn((table:string)=>{
  if(!(table in sources))throw Error("unknown table "+table);
  const q={select:()=>q,eq:()=>q,or:()=>q,is:()=>q,gte:()=>q,lte:()=>q,
   limit:vi.fn(async()=>({data:sources[table],error:null})),
   maybeSingle:vi.fn(async()=>({data:sources[table][0]??null,error:null}))};
  return q;
 });
 vi.mocked(simulationOwnerReader).mockResolvedValue({client:{from} as never,explicit:true});
 return {from};
}
const scope={businessId:business,ownerUserId:owner,threadId:thread,locale:"en" as const};
beforeEach(()=>vi.resetAllMocks());
describe("owner-click-only proactive worker question",()=>{
 it("rejects invented authority and invalid follow-up inputs",()=>{
  expect(staffQuestionInput.safeParse({...input,approved:true}).success).toBe(false);
  expect(staffQuestionInput.safeParse({...input,followUpAfter:null}).success).toBe(false);
  for(const action of ["ask","ignore"]){
   expect(ownerStaffQuestionDecision.safeParse({action,proposalId:thread,revision:1}).success).toBe(true);
  }
  expect(ownerStaffQuestionDecision.safeParse({action:"answer",proposalId:thread,revision:1,answer:"40"}).success).toBe(false);
  expect(ownerStaffQuestionDecision.safeParse({action:"ask",proposalId:thread,revision:1,
   answer:"secret"}).success).toBe(false);
 });
 it("records only an existing saved owner chat answer and never accepts model-supplied answer text",async()=>{
  const save=vi.fn().mockResolvedValue({proposalId:thread,ownerMessageId:owner,employeeContacted:false});
  const ctx={staffQuestionAnswer:save} as unknown as AgentToolContext;
  const input={proposalId:thread,revision:1};
  const result=await staffQuestionTools.record_staff_question_owner_answer.execute(input,ctx);
  expect(save).toHaveBeenCalledExactlyOnceWith(thread,1);
  expect(result).toMatchObject({saved:true,ownerReported:true,independentlyVerified:false,employeeContacted:false});
  await expect(staffQuestionTools.record_staff_question_owner_answer.execute({...input,answer:"invented"},ctx)).rejects.toThrow();
  expect((await staffQuestionTools.record_staff_question_owner_answer.execute(input,{} as AgentToolContext)).missing).toEqual(["owner_answer_not_recorded"]);
 });
 it("creates an inert source- and employee-scoped draft with no messaging effect",async()=>{
  const db=dbRows();
  const draft=await staffQuestionCapability.simulate(scope,input);
  expect(draft.effect).toMatchObject({employeeName:"Priya",sourceKind:"operating_task",sourceRevision,employeeId:employee});
  expect(draft.monitorSpec.metricScope).toBe("staff_question_receipt");
  expect(staffQuestionCapabilityId).toBe("olivia.staff_question.v1");
  expect(db.from).toHaveBeenCalledWith("scheduled_shifts");
  expect(createAdminSupabaseClient).not.toHaveBeenCalled();
 });
 it("also supports a source-backed active alert from an inventory anomaly",async()=>{
  const db=dbRows();
  const draft=await staffQuestionCapability.simulate(scope,{...input,sourceKind:"alert"});
  expect(draft.effect).toMatchObject({sourceKind:"alert",sourceRevision});
  expect(db.from).toHaveBeenCalledWith("alerts");
 });
 it("refuses an unlinked, inactive, or off-shift worker",async()=>{
  dbRows({linked:false});
  await expect(staffQuestionCapability.simulate(scope,input)).rejects.toThrow();
  dbRows({staffActive:false});
  await expect(staffQuestionCapability.simulate(scope,input)).rejects.toThrow();
  dbRows({onShift:false});
  await expect(staffQuestionCapability.simulate(scope,input)).rejects.toThrow("worker_not_on_current_published_shift");
 });
 it("only the already-claimed effect commit invokes the verified SQL receipt",async()=>{
  const rpc=vi.fn(async()=>({data:{id:thread,replayed:false},error:null}));
  vi.mocked(createAdminSupabaseClient).mockReturnValue({rpc} as never);
  const draft=await staffQuestionCapability.simulate(scope,input).catch(()=>null);
  void draft;
  const effect={...input,sourceRevision,employeeName:"Priya"};
  await expect(staffQuestionCapability.commit(scope,effect)).rejects.toThrow("staff_question_proposal_required");
  expect(rpc).not.toHaveBeenCalled();
  expect(await staffQuestionCapability.commit(scope,effect,thread)).toEqual({
   status:"verified",evidenceSource:"staff_communication_requests"});
  expect(rpc).toHaveBeenCalledExactlyOnceWith("supervisor_commit_staff_question",
   expect.objectContaining({p_business_id:business,p_owner_user_id:owner,
    p_thread_id:thread,p_proposal_id:thread}));
 });
});
