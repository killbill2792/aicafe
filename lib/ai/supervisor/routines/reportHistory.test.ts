import {createHash} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {routineReportCandidates,verifiedRoutineReportHistory} from "./reportHistory.server";
import type {ConversationMessage} from "@/lib/ai/conversations/contracts";

const scope={businessId:"cafe-a",ownerUserId:"owner-a"};
const threadId="thread-a";
const runId="33333333-3333-4333-8333-333333333333";
const routineId="22222222-2222-4222-8222-222222222222";
const reportText="Staffing coverage changed and supply stock may need attention.";
const hash=createHash("md5").update("u4-objective-report:"+runId).digest("hex");
const messageId=hash.slice(0,8)+"-"+hash.slice(8,12)+"-"+hash.slice(12,16)+"-"+
  hash.slice(16,20)+"-"+hash.slice(20);
const report:ConversationMessage={
  id:messageId,threadId,role:"supervisor",contentType:"blocks",
  text:null,blocks:[{type:"text",text:reportText}],clientMessageId:null,
  createdAt:"2026-11-20T16:00:00Z",
  grounding:{status:"verified",intent:"operating_tasks",evidence:[{source:"verified_external"}],
    agentMetadata:{runId,routineId,revision:1,u4Kind:"routine",externalEffects:"not_attempted"}},
};
function scopedDb(options?:{routine?:Record<string,unknown>;occurrence?:Record<string,unknown>;error?:boolean}){
  const q=(data:unknown[])=>({
    select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),
    in:vi.fn().mockReturnThis(),
    limit:vi.fn(async()=>({data,error:options?.error?{code:"PERMISSION"}:null})),
  });
  const routines=q([options?.routine??{id:routineId,owner_user_id:scope.ownerUserId,
    thread_id:threadId,execution_mode:"objective"}]);
  const occurrences=q([options?.occurrence??{routine_id:routineId,run_id:runId,
    revision:1,state:"completed",receipt_ref:"u4-verified:"+runId,
    u4_result:{attention:"attention",summary:reportText,
      proof:{quality:"verified",externalEffects:"not_attempted"}}}]);
  return {db:{from:vi.fn((name:string)=>name==="supervisor_routines"?routines:occurrences)},
    routines,occurrences};
}
describe("U4 authenticated historical report follow-ups",()=>{
  it("admits a real completed owner-scoped report while keeping it context-only",async()=>{
    const candidates=routineReportCandidates([report],threadId,"2026-11-20T17:00:00Z");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].messageId).toBe(messageId);
    const {db,routines,occurrences}=scopedDb();
    const approved=await verifiedRoutineReportHistory(db as never,scope,threadId,candidates);
    expect([...approved]).toEqual([messageId]);
    expect(routines.eq).toHaveBeenCalledWith("owner_user_id",scope.ownerUserId);
    expect(routines.eq).toHaveBeenCalledWith("thread_id",threadId);
    expect(occurrences.eq).toHaveBeenCalledWith("business_id",scope.businessId);
  });
  it("excludes unrelated, forged, future, cross-thread and role-spoofed reports",()=>{
    expect(routineReportCandidates([{...report,id:"not-sql-generated"}],threadId,
      "2026-11-20T17:00:00Z")).toEqual([]);
    expect(routineReportCandidates([{...report,role:"owner"}],threadId,
      "2026-11-20T17:00:00Z")).toEqual([]);
    expect(routineReportCandidates([{...report,threadId:"another-thread"}],threadId,
      "2026-11-20T17:00:00Z")).toEqual([]);
    expect(routineReportCandidates([report],threadId,
      "2026-11-20T15:00:00Z")).toEqual([]);
    expect(routineReportCandidates([{...report,grounding:{
      ...(report.grounding??{}),agentMetadata:{runId,routineId,revision:1,u4Kind:"routine",
        externalEffects:"attempted"}}],threadId,"2026-11-20T17:00:00Z")).toEqual([]);
  });
  it("rejects wrong owner scope, uncompleted receipts, changed text and absent RLS reads",async()=>{
    const candidates=routineReportCandidates([report],threadId,"2026-11-20T17:00:00Z");
    const situations=[
      scopedDb({routine:{id:routineId,owner_user_id:"another-owner",
        thread_id:threadId,execution_mode:"objective"}}),
      scopedDb({occurrence:{routine_id:routineId,run_id:runId,revision:1,state:"running",
        receipt_ref:null,u4_result:null}}),
      scopedDb({occurrence:{routine_id:routineId,run_id:runId,revision:1,
        state:"completed",receipt_ref:"u4-verified:"+runId,
        u4_result:{summary:"Unrelated report",proof:{quality:"verified",
          externalEffects:"not_attempted"}}}}),
      scopedDb({error:true}),
    ];
    for(const {db} of situations){
      const approved=await verifiedRoutineReportHistory(db as never,scope,threadId,candidates);
      expect([...approved]).toEqual([]);
    }
  });
  it("admits genuine partial/Gmail-origin reports only as stale text, not fresh facts",async()=>{
    const partial={...report,grounding:{...report.grounding,status:"partial",
      evidence:[{source:"unverified_external"}]}};
    const candidates=routineReportCandidates([partial],threadId,"2026-11-20T17:00:00Z");
    const {db}=scopedDb({occurrence:{routine_id:routineId,run_id:runId,
      revision:1,state:"completed",receipt_ref:"u4-verified:"+runId,
      u4_result:{summary:reportText,proof:{quality:"partial",
        externalEffects:"not_attempted"}}}});
    expect([...await verifiedRoutineReportHistory(db as never,scope,threadId,candidates)])
      .toEqual([messageId]);
    // The production runner never adds these messages to priorAssistant's
    // numeric evidence; it prepends a warning and asks Luna to re-read sources.
  });
});
