import {describe,expect,it} from "vitest";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
import {investigationPrompt,relevantInvestigationTools,verifyInvestigationTurn,
  unsupportedExternalEffectClaim,type SourceSynopsis}
  from "@/lib/ai/supervisor/routines/investigation";

const source:SourceSynopsis={
  kind:"maintenance_issue",status:"needs_owner",severity:"high",quality:"low",
  relatedAlerts:[],relatedTasks:["maintenance_issue"],
};
const incident={name:"get_investigation_source",result:{
  source:"investigation_source",period:null,sourceType:"operating_task",
  sourceId:"maintenance:case-123",incidentKind:"maintenance_issue",missing:[],
  selectors:{maintenanceStage:"reported",equipmentLabel:"Main espresso machine"},
  maintenanceHistory:[{kind:"report",sourceKind:"owner_report",
    verifiedWorking:false,occurredAt:"2026-11-16T15:00:00Z"}],
}};
const sales={name:"get_sales",result:{
  source:"daily_sales",period:null,missing:[],netSalesCents:19800,
  days:[{date:"2026-11-16",netSalesCents:19800}],
}};
const schedule={name:"get_schedule",result:{
  source:"dated_schedule",period:null,missing:[],scheduleSet:true,
  shifts:[{id:"shift-a",date:"2026-11-16"}],
}};
function turn(calls= [incident,sales,schedule],text="A machine failure was reported. I checked available sales and staffing records; I recommend preparing a vendor request for your explicit approval. No message has been sent. I will recheck the case."):AgentTurn{
  return {text,endReason:"complete",tools:calls.map(x=>x.name),unverified:[],
    results:calls.map(x=>x.result),toolInvocations:calls,
    usage:{modelCalls:2,toolCalls:calls.length,inputTokens:150,outputTokens:150,cachedTokens:0,latencyMs:100},
  } as unknown as AgentTurn;
}
const expected={sourceType:"operating_task" as const,sourceId:"maintenance:case-123",kind:"maintenance_issue"};
describe("Task15B agent-directed and independently checked maintenance investigation",()=>{
  it("uses the existing registered cross-domain evidence readers",()=>{
    const choices=relevantInvestigationTools("maintenance_issue");
    expect(choices).toContain("get_sales");
    expect(choices).toContain("get_schedule");
    expect(choices).toContain("get_expenses");
    expect(choices).not.toContain("propose_gmail_action");
    expect(verifyInvestigationTurn(turn(),expected)).toMatchObject({
      ok:true,tools:["get_investigation_source","get_sales","get_schedule"]});
  });
  it("rejects irrelevant one-source or fabricated no-effect closure",()=>{
    expect(verifyInvestigationTurn(turn([incident,sales]),expected))
      .toEqual({ok:false,reason:"evidence_incomplete"});
    expect(verifyInvestigationTurn(turn([sales,incident,schedule]),expected))
      .toEqual({ok:false,reason:"model_incomplete"});
    expect(verifyInvestigationTurn(turn([incident,sales,schedule],
      "I emailed the technician and the machine was repaired."),expected))
      .toEqual({ok:false,reason:"model_incomplete"});
  });
  it("instructs model to replan when a vendor contact is missing, without inventing a send",()=>{
    const first=investigationPrompt(source,false);
    const follow=investigationPrompt(source,true,"Need email of verified technician");
    expect(first).toContain("best next steps");
    expect(first).toContain("owner approval");
    expect(first).toContain("communication channel are missing");
    expect(follow).toContain("persistent follow-up");
    expect(follow).toContain("not a claim that a message was sent");
    expect(unsupportedExternalEffectClaim("I sent the vendor an email.")).toBe(true);
  });
});
