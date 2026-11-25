import {describe,expect,it} from "vitest";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
import {universalInvestigationPrompt,maintenanceInvestigationTools,verifyUniversalInvestigationTurn,
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
const verifyInvestigationTurn=(t:AgentTurn,e:typeof expected)=>verifyUniversalInvestigationTurn(t,e,maintenanceInvestigationTools);
describe("Task15B agent-directed and independently checked maintenance investigation",()=>{
  it("uses the existing registered cross-domain evidence readers",()=>{
    const choices=maintenanceInvestigationTools;
    expect(choices).toContain("get_sales");
    expect(choices).toContain("get_schedule");
    expect(choices).toContain("get_expenses");
    expect(choices).not.toContain("propose_gmail_action");
    expect(verifyInvestigationTurn(turn(),expected)).toMatchObject({
      ok:true,tools:["get_investigation_source","get_sales","get_schedule"]});
  });
  it("allows relevant single-source research but rejects fabricated closure",()=>{
    expect(verifyInvestigationTurn(turn([incident,sales]),expected)).toMatchObject({ok:true});
    expect(verifyInvestigationTurn(turn([sales,incident,schedule]),expected)).toMatchObject({ok:true});
    expect(verifyInvestigationTurn(turn([incident,sales,schedule],
      "I emailed the technician and the machine was repaired."),expected))
      .toEqual({ok:false,reason:"model_incomplete"});
  });
  it("rejects a physical repair assertion without independent closure evidence",()=>{
    expect(verifyInvestigationTurn(turn([incident,sales,schedule],
      "The equipment is now repaired. No vendor message was sent."),expected))
      .toEqual({ok:false,reason:"model_incomplete"});
    expect(verifyInvestigationTurn(turn([incident,sales,schedule],
      "The equipment is not verified working. Ask staff for an independent check."),expected).ok).toBe(true);
  });
  it("allows attributed or explicitly uncertain repair claims, but not an independent affirmative assertion",()=>{
    for(const text of [
      "The technician says the machine is repaired, but this is unverified; please approve an independent physical check.",
      "We cannot confirm the machine is fixed until an employee tests it.",
      "The vendor reports that the equipment was fixed. An independent check remains required.",
      "Check whether the boiler is repaired before resuming service.",
      "We cannot yet confirm the machine is fixed.",
      "The technician reports that the machine at the counter is repaired.",
    ])expect(verifyInvestigationTurn(turn([incident,sales,schedule],text),expected).ok,text).toBe(true);
    for(const text of [
      "The technician says the machine is repaired, but the equipment is now verified working.",
      "We cannot confirm the machine is fixed. The case is closed.",
      "The machine itself was successfully repaired.",
      "The machine at the counter is fixed.",
      "The technician says the machine is repaired, and the boiler in the kitchen is now fixed.",
    ])expect(verifyInvestigationTurn(turn([incident,sales,schedule],text),expected),text).toEqual({ok:false,reason:"model_incomplete"});
  });
  it("instructs model to replan when a vendor contact is missing, without inventing a send",()=>{
    const first=universalInvestigationPrompt(source,false);
    const follow=universalInvestigationPrompt(source,true,"Need email of verified technician");
    expect(first).toContain("one actionable next step");
    expect(first).toContain("separately authorized inert drafts");
    expect(first).toContain("specific necessary question");
    expect(follow).toContain("persistent follow-up");
    expect(follow).toContain("inert approval request from a sent message");
    expect(unsupportedExternalEffectClaim("I sent the vendor an email.")).toBe(true);
  });
});
