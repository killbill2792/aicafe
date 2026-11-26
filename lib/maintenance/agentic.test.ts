import {describe,expect,it} from "vitest";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
import {researchInvestigationPrompt,investigationReadTools,verifyResearchInvestigationTurn,
  unsupportedExternalEffectClaim,type SourceSynopsis}
  from "@/lib/ai/supervisor/routines/investigation";

const source:SourceSynopsis={
  kind:"maintenance_issue",status:"needs_owner",severity:"high",quality:"low",
  relatedAlerts:[],relatedTasks:["maintenance_issue"],
};
const incident={result:{
  source:"investigation_source",period:null,sourceType:"operating_task",
  sourceId:"maintenance:case-123",incidentKind:"maintenance_issue",missing:[],
  selectors:{maintenanceStage:"reported",equipmentLabel:"Main espresso machine"},
  maintenanceHistory:[{kind:"report",sourceKind:"owner_report",
    verifiedWorking:false,occurredAt:"2026-11-16T15:00:00Z"}],
}};
const sales={name:"run_sql",result:{source:"sql_research",period:null,missing:[],tool:"run_sql"}};
const schedule={name:"get_schedule",result:{
  source:"dated_schedule",period:null,missing:[],scheduleSet:true,
  shifts:[{id:"shift-a",date:"2026-11-16"}],
}};
function turn(calls:unknown[]= [sales,schedule],text="A machine failure was reported. I checked available sales and staffing records; I recommend preparing a vendor request for your explicit approval. No message has been sent. I will recheck the case."):AgentTurn{
  return {text,endReason:"complete",tools:[],unverified:[],results:[],toolInvocations:calls,
    usage:{modelCalls:2,toolCalls:calls.length,inputTokens:150,outputTokens:150,cachedTokens:0,latencyMs:100},
  } as unknown as AgentTurn;
}
const expected={sourceType:"operating_task" as const,sourceId:"maintenance:case-123",kind:"maintenance_issue"};
const verify=(result:AgentTurn,expectedClaim=incident.result)=>verifyResearchInvestigationTurn(result,expected,investigationReadTools,expectedClaim);
describe("Task15B agent-directed and independently checked maintenance investigation",()=>{
  it("uses the existing registered cross-domain evidence readers",()=>{
    const choices=investigationReadTools;
    expect(choices).toContain("run_sql");
    expect(choices).toContain("get_schedule");
    expect(choices).toContain("describe_database");
    expect(choices).not.toContain("propose_gmail_action");
    expect(verify(turn())).toMatchObject({
      ok:true,tools:["run_sql","get_schedule"]});
  });
  it("rejects irrelevant one-source or fabricated no-effect closure",()=>{
    expect(verify(turn([schedule])))
      .toEqual({ok:false,reason:"evidence_incomplete"});
    expect(verify(turn([sales,schedule]),{...incident.result,sourceId:"other"}))
      .toEqual({ok:false,reason:"evidence_incomplete"});
    expect(verify(turn([sales,schedule],
      "I emailed the technician and the machine was repaired."))))
      .toEqual({ok:false,reason:"model_incomplete"});
  });
  it("rejects a physical repair assertion without independent closure evidence",()=>{
    expect(verify(turn([sales,schedule],
      "The equipment is now repaired. No vendor message was sent."))))
      .toEqual({ok:false,reason:"model_incomplete"});
    expect(verify(turn([sales,schedule],
      "The equipment is not verified working. Ask staff for an independent check." )).ok).toBe(true);
  });
  it("allows attributed or explicitly uncertain repair claims, but not an independent affirmative assertion",()=>{
    for(const text of [
      "The technician says the machine is repaired, but this is unverified; please approve an independent physical check.",
      "We cannot confirm the machine is fixed until an employee tests it.",
      "The vendor reports that the equipment was fixed. An independent check remains required.",
      "Check whether the boiler is repaired before resuming service.",
      "We cannot yet confirm the machine is fixed.",
      "The technician reports that the machine at the counter is repaired.",
    ])expect(verify(turn([sales,schedule],text )).ok,text).toBe(true);
    for(const text of [
      "The technician says the machine is repaired, but the equipment is now verified working.",
      "We cannot confirm the machine is fixed. The case is closed.",
      "The machine itself was successfully repaired.",
      "The machine at the counter is fixed.",
      "The technician says the machine is repaired, and the boiler in the kitchen is now fixed.",
    ])expect(verify(turn([sales,schedule],text)),text).toEqual({ok:false,reason:"model_incomplete"});
  });
  it("instructs model to replan when a vendor contact is missing, without inventing a send",()=>{
    const first=researchInvestigationPrompt(source,false,null,JSON.stringify(incident.result));
    const follow=researchInvestigationPrompt(source,true,"Need email of verified technician",JSON.stringify(incident.result));
    expect(first).toContain("independent working-equipment check");
    expect(first).toContain("owner approval");
    expect(first).toContain("communication channel is missing");
    expect(follow).toContain("persistent follow-up");
    expect(follow).toContain("not a claim that a message was sent");
    expect(unsupportedExternalEffectClaim("I sent the vendor an email.")).toBe(true);
  });
});
