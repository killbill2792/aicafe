import {describe,it,expect} from "vitest";
import {researchInvestigationPrompt,verifyResearchInvestigationTurn} from "./investigation";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
const sql={name:"run_sql",result:{source:"sql_research",period:null,missing:[],tool:"run_sql"}};
function turn(calls:unknown[]=[sql],patch:Record<string,unknown>={}):AgentTurn{
 return {text:"Recorded evidence is incomplete. Review the source and recheck.",endReason:"complete",unverified:[],toolInvocations:calls,results:[],...patch} as unknown as AgentTurn;
}

const expected={sourceType:"operating_task" as const,sourceId:"supplier-receiving:po",kind:"supplier_receiving"};
const claim={sourceType:expected.sourceType,sourceId:expected.sourceId,incidentKind:expected.kind,missing:[],selectors:{entityType:"purchase_order",entityId:"po"}};
const draft=(po="po",sent=false)=>({name:"propose_supplier_discrepancy_followup",result:{source:"gmail_proposal",period:null,missing:[],proposalCreated:true,approvalRequired:true,sent,purchaseOrderId:po,proposalId:"inert-draft"}});
const run=(calls:unknown[],source=claim)=>verifyResearchInvestigationTurn(turn(calls),expected,["propose_supplier_discrepancy_followup"],source);
describe("SQL receiving evidence and exact owner-approved follow-up",()=>{
 it("requires the server-verified claim and a completed SQL read; no unadmitted receiving effect",()=>{
  expect(run([sql]).ok).toBe(true);
  expect(run([]).ok).toBe(false);
  expect(run([sql],{...claim,sourceId:"foreign"}).ok).toBe(false);
  expect(run([sql,{name:"propose_purchase_receiving",result:{}}]).ok).toBe(false);
 });
 it("does not permit a different PO or a claimed send",()=>{
  expect(run([sql,draft()]).ok).toBe(true);
  expect(run([sql,draft("foreign")]).ok).toBe(false);
  expect(run([sql,draft("po",true)]).ok).toBe(false);
  expect(run([draft()]).ok).toBe(false);
 });
 it("keeps physical receipt distinct from an invoice or dispatch",()=>{
  const prompt=researchInvestigationPrompt({kind:expected.kind,status:"watching",severity:null,quality:"high",relatedAlerts:[],relatedTasks:[]},true,null,JSON.stringify(claim));
  expect(prompt).toContain("never establishes actual physical receipt");
  expect(prompt).toContain("Recheck on every follow-up");
 });
});
