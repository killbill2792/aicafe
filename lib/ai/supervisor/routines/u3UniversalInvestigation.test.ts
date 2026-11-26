import {describe,it,expect} from "vitest";
import {researchInvestigationPrompt,verifyResearchInvestigationTurn,investigationReadTools} from "./investigation";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
const sql={name:"run_sql",result:{source:"sql_research",period:null,missing:[],tool:"run_sql"}};
function turn(calls:unknown[]=[sql],patch:Record<string,unknown>={}):AgentTurn{
 return {text:"Recorded evidence is incomplete. Review the source and recheck.",endReason:"complete",unverified:[],toolInvocations:calls,results:[],...patch} as unknown as AgentTurn;
}

const expected={sourceType:"alert" as const,sourceId:"source-1",kind:"surprising_new_business_signal"};
const claim={sourceType:expected.sourceType,sourceId:expected.sourceId,incidentKind:expected.kind,missing:[]};
describe("SQL autonomous research",()=>{
 it("permits unfamiliar incidents without a forced tool sequence",()=>{
  const prompt=researchInvestigationPrompt({kind:expected.kind,status:"new",severity:null,quality:"partial",relatedAlerts:[],relatedTasks:[]},false,null,JSON.stringify(claim));
  expect(prompt).toContain("No mandatory query order");
  expect(prompt).toContain("describe_database and run_sql");
  expect(verifyResearchInvestigationTurn(turn([sql]),expected,investigationReadTools,claim)).toMatchObject({ok:true,tools:["run_sql"]});
 });
 it("fails closed for claim mismatch, missing SQL or effects",()=>{
  expect(verifyResearchInvestigationTurn(turn(),expected,[],{...claim,incidentKind:"other"})).toEqual({ok:false,reason:"evidence_incomplete"});
  expect(verifyResearchInvestigationTurn(turn([]),expected,[],claim)).toEqual({ok:false,reason:"evidence_incomplete"});
  expect(verifyResearchInvestigationTurn(turn([sql],{text:"I purchased replacement stock."}),expected,[],claim)).toEqual({ok:false,reason:"model_incomplete"});
 });
});
