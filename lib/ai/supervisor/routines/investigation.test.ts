import {describe,it,expect} from "vitest";
import {researchInvestigationPrompt,verifyResearchInvestigationTurn,investigationReadTools,precedingInvestigationReport,modelSelectedOwnerQuestion,unsupportedExternalEffectClaim,type SourceSynopsis} from "./investigation";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
const sql={name:"run_sql",result:{source:"sql_research",period:null,missing:[],tool:"run_sql"}};
function turn(calls:unknown[]=[sql],patch:Record<string,unknown>={}):AgentTurn{
 return {text:"Recorded evidence is incomplete. Review the source and recheck.",endReason:"complete",unverified:[],toolInvocations:calls,results:[],...patch} as unknown as AgentTurn;
}

const source:SourceSynopsis={kind:"business_anomaly",status:"new",severity:"high",quality:"partial",relatedAlerts:[],relatedTasks:[]};
const expected={sourceType:"alert" as const,sourceId:"alert-a",kind:source.kind};
const claim={sourceType:expected.sourceType,sourceId:expected.sourceId,incidentKind:expected.kind,missing:[]};
const verify=(result:AgentTurn,receipt=claim)=>verifyResearchInvestigationTurn(result,expected,investigationReadTools,receipt);
describe("one SQL investigation gate",()=>{
 it("uses SQL and scoped integrations, not the retired model readers",()=>{
  expect(investigationReadTools).toEqual(["describe_database","run_sql","calculate","search_web","get_events","get_staff_messages","get_schedule","get_week_schedule"]);
  const prompt=researchInvestigationPrompt(source,false,null,JSON.stringify(claim));
  expect(prompt).toContain("describe_database and run_sql");
  expect(prompt).toContain("NOT a new owner instruction");
  expect(prompt).toContain("Null, missing, stale or failed reads never mean zero");
  expect(prompt).toContain("Owner question:");
  expect(prompt).toContain("server-verified incident record");
 });
 it("accepts the exact server-scoped claim and a real completed SQL invocation",()=>{
  expect(verify(turn())).toMatchObject({ok:true,tools:["run_sql"]});
  expect(verify(turn(),{...claim,sourceId:"other"})).toMatchObject({ok:false,reason:"evidence_incomplete"});
  expect(verify(turn(),{...claim,missing:["unverified"]})).toMatchObject({ok:false,reason:"evidence_incomplete"});
  expect(verifyResearchInvestigationTurn(turn(),expected,[])).toMatchObject({ok:false,reason:"evidence_incomplete"});
 });
 it("does not accept tool names, metadata-only or failed reads, or an unadmitted action",()=>{
  expect(verify(turn([]))).toEqual({ok:false,reason:"evidence_incomplete"});
  expect(verify(turn([{name:"describe_database",result:{...sql.result,tool:"describe_database"}}]))).toEqual({ok:false,reason:"evidence_incomplete"});
  expect(verify(turn([{...sql,result:{...sql.result,error:"research_tool_error"}}]))).toEqual({ok:false,reason:"evidence_incomplete"});
  expect(verify(turn([sql,{name:"propose_price_change",result:{}}]))).toEqual({ok:false,reason:"model_incomplete"});
 });
 it("refuses incomplete, unsupported numeric or effect claims",()=>{
  for(const patch of [{endReason:"timeout"},{endReason:"budget"},{text:""},{text:"x".repeat(1801)},{unverified:[{text:"999"}]},{text:"I paid the supplier."}]){
   expect(verify(turn([sql],patch))).toEqual({ok:false,reason:"model_incomplete"});
  }
  expect(unsupportedExternalEffectClaim("I sent the vendor an email.")).toBe(true);
 });
 it("keeps the staff report distinct from the confirmed roster",()=>{
  const prompt=researchInvestigationPrompt({...source,kind:"staff_coverage"},true,"Prior plan",JSON.stringify(claim));
  expect(prompt).toContain("THEIR report, not as a roster change");
  expect(prompt).toContain("current schedule");
  expect(prompt).toContain("personal availability was not checked");
  expect(prompt).toContain("not authorization");
 });
});
it("only the immediately preceding verified, same-thread proactive report is eligible for owner-turn context",()=>{
  const owner={id:"owner",threadId:"thread",createdAt:"2026-01-01T10:02:00Z"};
  const report={id:"report",role:"supervisor",threadId:"thread",createdAt:"2026-01-01T10:00:00Z",
    grounding:{intent:"priority_investigation",status:"verified",evidence:[{source:"alert",identifier:"alert",revisionHash:"rev"}]}};
  expect(precedingInvestigationReport([report],owner)).toEqual({report,sourceId:"alert",sourceRevision:"rev"});
  expect(precedingInvestigationReport([{...report,threadId:"other"}],owner)).toBeNull();
  expect(precedingInvestigationReport([{...report,grounding:{...report.grounding,status:"partial"}}],owner)).toBeNull();
  expect(precedingInvestigationReport([report,{...report,id:"owner2",role:"owner",createdAt:"2026-01-01T10:01:00Z"}],owner)).toBeNull();
  expect(precedingInvestigationReport([{...report,createdAt:"2026-01-01T10:03:00Z"}],owner)).toBeNull();
});

describe("U4 model-selected owner question durability contract",()=>{
  it("extracts a unique question only from a verified complete model report",()=>{
    const report="Recorded sales are unavailable; I will recheck the import.\n"+
      "Owner question: Can you confirm whether the payment import is currently paused?";
    expect(modelSelectedOwnerQuestion(report))
      .toBe("Can you confirm whether the payment import is currently paused?");
    for(const text of ["No owner-only answer is required.",
      "Owner question: What?",
      "Owner question: Did this change?\nOwner question: Is a second decision needed?",
      "Owner question: Please visit https://bad.test to approve?",
      // Filler questions name nothing the owner can answer.
      "Owner question: What additional information can you confirm so I can continue checking this issue?",
      "Owner question: Is there anything else you can tell me about this?"]){
      expect(modelSelectedOwnerQuestion(text)).toBeNull();
    }
  });
  it("directs existing model-driven research modes without scripted question content",()=>{
    const source={kind:"business_anomaly",status:"new",severity:null,
      quality:"partial",relatedAlerts:[],relatedTasks:[]};
    expect(researchInvestigationPrompt(source,false,null,"{}")).toContain("Owner question:");
  });
});
