import {beforeEach,describe,expect,it,vi} from "vitest";
import {createHash,randomUUID} from "node:crypto";
import type {AgentToolContext} from "@/lib/ai/agent/tools";
import {observeDurableToolEffect} from "@/lib/ai/agent/tools";
import {staffQuestionTools} from "@/lib/ai/agent/tools/staffQuestion";
import {openOwnerRunCheckpoint} from "./repository.server";

const fake=vi.hoisted(()=>({
 ids:{business:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  otherBusiness:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  owner:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  otherOwner:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  thread:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  run:"11111111-1111-4111-8111-111111111111",
  token:"22222222-2222-4222-8222-222222222222",
  job:"33333333-3333-4333-8333-333333333333",
  proposal:"44444444-4444-4444-8444-444444444444",
  message:"55555555-5555-4555-8555-555555555555",
 },
 tables:{} as Record<string,Array<Record<string,unknown>>>,
 log:[] as Array<{name:string;params:Record<string,unknown>}>,
}));
function subset(row:unknown,part:unknown):boolean{
 if(part===null||typeof part!=="object"||Array.isArray(part))
  return Object.is(row,part);
 if(!row||typeof row!=="object"||Array.isArray(row))return false;
 return Object.entries(part).every(([key,v])=>subset((row as Record<string,unknown>)[key],v));
}
function db(){
 return {
  from:(table:string)=>{
   const filters:Array<(x:Record<string,unknown>)=>boolean>=[];
   let max=1_000;
   const apply=()=>fake.tables[table]?.filter(x=>filters.every(f=>f(x))).slice(0,max)??[];
   type Query={
    select:(fields:string)=>Query;
    eq:(key:string,value:unknown)=>Query;
    is:(key:string,value:unknown)=>Query;
    contains:(key:string,value:unknown)=>Query;
    limit:(n:number)=>Promise<{data:Array<Record<string,unknown>>;error:null}>;
    maybeSingle:()=>Promise<{data:Record<string,unknown>|null;error:{message:string}|null}>;
    single:()=>Promise<{data:Record<string,unknown>|null;error:{message:string}|null}>;
   };
   const q:Query={
    select:(_fields:string)=>q,
    eq:(key:string,value:unknown)=>{filters.push(x=>x[key]===value);return q;},
    is:(key:string,value:unknown)=>{filters.push(x=>x[key]===value);return q;},
    contains:(key:string,value:unknown)=>{filters.push(x=>
      Array.isArray(x[key])&&Array.isArray(value)&&value.every(v=>(x[key] as unknown[]).some(y=>subset(y,v))));return q;},
    limit:async(count:number)=>{max=count;return {data:apply(),error:null};},
    maybeSingle:async()=>{const a=apply();return {data:a.length===1?a[0]:null,error:a.length>1?{message:"nonunique"}:null};},
    single:async()=>{const a=apply();return {data:a[0]??null,error:a.length===1?null:{message:"missing"}};},
   };
   return q;
  },
  rpc:async(name:string,params:Record<string,unknown>)=>{
   fake.log.push({name,params});
   if(name==="supervisor_owner_job_fence_v2"||name==="supervisor_update_owner_job_v2")
     return {data:true,error:null};
   if(name!=="supervisor_checkpoint_owner_run_v2")
     throw Error("unreviewed RPC "+name);
   const step=fake.tables.supervisor_run_steps[0];
   if(params.p_expected_seq!==step.checkpoint_seq)
     return {data:null,error:{message:"checkpoint_seq_mismatch"}};
   const phase=step.checkpoint_phase as string;
   if(params.p_action==="complete"){
    const existing=step.checkpoint_receipts as Array<Record<string,unknown>>;
    existing.push({operation:step.checkpoint_operation,phase,tool:step.checkpoint_tool,
      receipt:params.p_receipt_ref});
    step.checkpoint_phase="ready";step.checkpoint_operation=null;step.checkpoint_tool=null;
   }else{
    if(phase!=="ready")return {data:null,error:{message:"effect_not_ready"}};
    step.checkpoint_phase=params.p_action==="begin_read"?"read_pending":
     params.p_action==="begin_provider"?"provider_pending":"effect_pending";
    step.checkpoint_operation=params.p_operation;
    step.checkpoint_tool=params.p_tool;
   }
   step.checkpoint_seq=Number(step.checkpoint_seq)+1;
   return {data:structuredClone(step),error:null};
  },
 };
}
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>db()}));
const scope={businessId:fake.ids.business,ownerUserId:fake.ids.owner,threadId:fake.ids.thread};
const tool="record_staff_question_owner_answer";
const args={proposalId:fake.ids.proposal,revision:1};
const ref="staff_owner_report:"+fake.ids.proposal+":"+fake.ids.message;
function reset(){
 const a=fake.ids,created="2026-11-21T20:00:00.000Z";
 fake.log.length=0;
 fake.tables={
  supervisor_run_steps:[{business_id:a.business,run_id:a.run,step_key:"owner_turn",
    checkpoint_seq:0,checkpoint_phase:"ready",checkpoint_operation:null,
    checkpoint_tool:null,checkpoint_receipts:[]}],
  supervisor_runs:[{id:a.run,business_id:a.business,owner_user_id:a.owner,
    thread_id:a.thread,request_key:a.message}],
  supervisor_proposals:[{id:a.proposal,business_id:a.business,owner_user_id:a.owner,
    thread_id:a.thread,status:"draft",revision:1,capability_id:"olivia.staff_question.v1",
    created_at:created,canonical_effect_payload:{sourceTaskId:"staff-note-1"},effect_hash:"a".repeat(64)}],
  ai_messages:[{id:a.message,business_id:a.business,owner_user_id:a.owner,author_user_id:a.owner,
    thread_id:a.thread,role:"owner",content_type:"text",text_content:"We have exactly 40 cups.",
    created_at:"2026-11-21T20:05:00.000Z",owner_input_response:null,owner_input_prompt_message_id:null}],
  operating_tasks:[],
  staff_communication_requests:[],
 };
}
function recordReport(){
 const a=fake.ids;
 fake.tables.supervisor_proposals[0].status="rejected";
 fake.tables.supervisor_proposals[0].revision=2;
 fake.tables.operating_tasks.push({business_id:a.business,owner_user_id:a.owner,
  id:"staff-question-owner-answer:"+a.proposal,kind:"data_quality",entity_type:"staff_question_answer",
  evidence:[{source:"owner_report",facts:{proposalId:a.proposal,ownerUserId:a.owner,
   ownerMessageId:a.message,answer:"We have exactly 40 cups.",
   independentlyVerified:false,sourceTaskId:"staff-note-1"}}]});
}
async function open(){
 return openOwnerRunCheckpoint(scope,fake.ids.run,fake.ids.token,fake.ids.job);
}
async function callTool(checkpoint:Awaited<ReturnType<typeof open>>){
 expect(await checkpoint.beginTool(tool,args,false)).toBeNull();
 const save=vi.fn(async()=>{
  recordReport();
  return {proposalId:fake.ids.proposal,ownerMessageId:fake.ids.message,employeeContacted:false as const};
 });
 const observation=observeDurableToolEffect(tool,{staffQuestionAnswer:save} as unknown as AgentToolContext,
  ()=>checkpoint.assertLive());
 const result=await staffQuestionTools.record_staff_question_owner_answer.execute(args,observation.context);
 observation.settle();
 expect(observation.noEffect()).toBe(false);
 expect(save).toHaveBeenCalledExactlyOnceWith(fake.ids.proposal,1);
 return {result,observation,save};
}
beforeEach(reset);
describe("actual durable checkpoint for a natural authenticated staff-question owner answer",()=>{
 it("commits only the exact scoped saved owner message receipt and safely rehydrates it",async()=>{
  const checkpoint=await open();
  const {result,observation}=await callTool(checkpoint);
  await checkpoint.endTool(result,observation.noEffect());
  const state=fake.tables.supervisor_run_steps[0];
  expect(state.checkpoint_phase).toBe("ready");
  expect((state.checkpoint_receipts as Array<{receipt:string}>)[0].receipt).toBe(ref);
  expect(fake.tables.staff_communication_requests).toHaveLength(0);
  const restarted=await open();
  expect(await restarted.restoredResults?.()).toEqual([expect.objectContaining({
   source:"staff_question_owner_report",saved:true,proposalId:fake.ids.proposal,
   ownerMessageId:fake.ids.message,independentlyVerified:false,employeeContacted:false
  })]);
  expect(await restarted.beginTool(tool,args,false)).toMatchObject({saved:true,ownerMessageId:fake.ids.message});
  await restarted.endTool(result);
  expect(fake.tables.operating_tasks).toHaveLength(1);
 });
 it("recovers an interrupted post-commit owner report without calling the effect again",async()=>{
  const checkpoint=await open();
  const {result,save}=await callTool(checkpoint);
  // A worker died between its successful SQL commit and checkpoint endTool.
  expect(fake.tables.supervisor_run_steps[0].checkpoint_phase).toBe("effect_pending");
  const restarted=await open();
  expect(fake.tables.supervisor_run_steps[0].checkpoint_phase).toBe("ready");
  expect((fake.tables.supervisor_run_steps[0].checkpoint_receipts as Array<{receipt:string}>)[0].receipt).toBe(ref);
  expect(await restarted.beginTool(tool,args,false)).toMatchObject({saved:true,ownerMessageId:fake.ids.message});
  await restarted.endTool(result);
  expect(save).toHaveBeenCalledTimes(1);
  expect(fake.tables.operating_tasks).toHaveLength(1);
 });
 it("recovers the exact interrupted question when one owner message answered two drafts",async()=>{
  const checkpoint=await open();
  const {result,observation}=await callTool(checkpoint);
  await checkpoint.endTool(result,observation.noEffect());
  const secondProposalId=randomUUID(),secondArgs={proposalId:secondProposalId,revision:1};
  const previous=fake.tables.supervisor_proposals[0];
  fake.tables.supervisor_proposals.push({...previous,id:secondProposalId});
  const oldReport=fake.tables.operating_tasks[0];
  const originalFacts=(oldReport.evidence as Array<{source:string;facts:Record<string,unknown>}>)[0];
  fake.tables.operating_tasks.push({...oldReport,id:"staff-question-owner-answer:"+secondProposalId,
   evidence:[{source:"owner_report",facts:{...originalFacts.facts,proposalId:secondProposalId}}]});
  expect(await checkpoint.beginTool(tool,secondArgs,false)).toBeNull();
  // The second SQL owner-report commit was saved, but its ACK was lost.
  expect(fake.tables.supervisor_run_steps[0].checkpoint_phase).toBe("effect_pending");
  const restarted=await open();
  const refs=fake.tables.supervisor_run_steps[0].checkpoint_receipts as Array<{receipt:string}>;
  expect(refs).toHaveLength(2);
  expect(refs[0].receipt).toBe(ref);
  expect(refs[1].receipt).toBe("staff_owner_report:"+secondProposalId+":"+fake.ids.message);
  expect(await restarted.beginTool(tool,secondArgs,false)).toMatchObject({
   saved:true,proposalId:secondProposalId,ownerMessageId:fake.ids.message});
  expect(fake.tables.staff_communication_requests).toHaveLength(0);
 });
 it("quarantines missing, forged or cross-café evidence rather than approving an uncertain effect",async()=>{
  const checkpoint=await open();
  const {result,observation}=await callTool(checkpoint);
  for(const mutate of [
    ()=>{fake.tables.operating_tasks.length=0;},
    ()=>{(fake.tables.operating_tasks[0].evidence as Array<{facts:{answer:string}}>)[0].facts.answer="41 cups";},
    ()=>{fake.tables.operating_tasks[0].business_id=fake.ids.otherBusiness;},
    ()=>{fake.tables.ai_messages[0].owner_user_id=fake.ids.otherOwner;},
    ()=>{fake.tables.staff_communication_requests.push({business_id:fake.ids.business,
      source_type:"owner_manual",source_id:fake.ids.proposal,id:randomUUID()});},
  ]){
    const copy=structuredClone(fake.tables);
    mutate();
    await expect(checkpoint.endTool(result,observation.noEffect())).rejects.toThrow("checkpoint_receipt_unavailable");
    expect(fake.tables.supervisor_run_steps[0].checkpoint_phase).toBe("effect_pending");
    fake.tables=copy;
  }
 });
 it("cannot recover if the prior model operation revision or run owner-message differs",async()=>{
  const checkpoint=await open();
  await callTool(checkpoint);
  fake.tables.supervisor_proposals[0].revision=3;
  await expect(open()).rejects.toThrow("checkpoint_effect_uncertain");
  fake.tables.supervisor_proposals[0].revision=2;
  fake.tables.supervisor_runs[0].request_key=randomUUID();
  await expect(open()).rejects.toThrow("checkpoint_effect_uncertain");
 });
 it("does not infer permission to replay any other pending writer",async()=>{
  fake.tables.supervisor_run_steps[0].checkpoint_phase="effect_pending";
  fake.tables.supervisor_run_steps[0].checkpoint_tool="propose_staff_question";
  fake.tables.supervisor_run_steps[0].checkpoint_operation=randomUUID();
  await expect(open()).rejects.toThrow("checkpoint_effect_uncertain");
 });
 it("records a local no-op only for a rejected predispatch tool, with no saved report",async()=>{
  const checkpoint=await open();
  await checkpoint.beginTool(tool,args,false);
  const observer=observeDurableToolEffect(tool,{} as AgentToolContext,()=>checkpoint.assertLive());
  const result=await staffQuestionTools.record_staff_question_owner_answer.execute(args,observer.context);
  observer.settle();
  expect(observer.noEffect()).toBe(true);
  await checkpoint.endTool(result,observer.noEffect());
  expect(fake.tables.operating_tasks).toHaveLength(0);
  expect((fake.tables.supervisor_run_steps[0].checkpoint_receipts as Array<{receipt:string}>)[0].receipt).toMatch(/^noop:/);
 });
});
