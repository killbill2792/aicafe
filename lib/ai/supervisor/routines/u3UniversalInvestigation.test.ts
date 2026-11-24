import {describe,expect,it} from "vitest";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
import {investigationReadTools,universalInvestigationPrompt,
 verifyUniversalInvestigationTurn,type SourceSynopsis} from "./investigation";
const signal:SourceSynopsis={kind:"surprising_new_business_signal",
 status:"new",severity:null,quality:"partial",
 relatedAlerts:[],relatedTasks:[]};
const expected={sourceType:"alert" as const,sourceId:"source-1",
 kind:"surprising_new_business_signal"};
const caseRead={name:"get_investigation_source",result:{
 source:"investigation_source",period:null,missing:[],
 sourceType:"alert",sourceId:"source-1",
 incidentKind:"surprising_new_business_signal"
}};
const analytics={name:"query_data",result:{
 source:"u3_canonical_research",period:null,missing:[],truncated:false,
 rows:[{net_sales_cents:"11900"}],rowCount:1,
 evidence:{scope:"verified_owner_cafe_lease",
  receipt_id:"11111111-1111-4111-8111-111111111111",
  query_fingerprint:"a".repeat(64),catalog_version:"b".repeat(16),
  column_units:{net_sales_cents:"cents"}}
}};
const permitted=[...investigationReadTools,"get_events"];
const turn=(changes:Record<string,unknown>={}):AgentTurn=>({
 text:"Recorded net sales changed; the available evidence does not yet establish the cause. Review costs and recheck source freshness.",
 endReason:"complete",tools:[caseRead.name,analytics.name],unverified:[],
 results:[caseRead.result,analytics.result],toolInvocations:[caseRead,analytics],
 usage:{modelCalls:2,toolCalls:2,inputTokens:300,outputTokens:200,cachedTokens:0,latencyMs:80},
 ...changes
} as unknown as AgentTurn);

describe("U3 model-led autonomous investigation",()=>{
 it("explains objectives and evidence without mandating a tool sequence or count",()=>{
  const prompt=universalInvestigationPrompt(signal,false);
  expect(prompt).toContain("You choose what authorized data");
  expect(prompt).toContain("No mandatory query order");
  expect(prompt).toContain("get_investigation_source");
  expect(prompt).not.toMatch(/FIRST call|get_sales then|at least TWO/);
  expect(prompt).toContain("not a published shift");
  const follow=universalInvestigationPrompt(signal,true,"We assumed 07:00 sales would rise");
  expect(follow).toContain("Continue the original unresolved work");
  expect(follow).not.toContain("07:00");
 });
 it("does not discard a long verified report or the final context of an earlier investigation",()=>{
  const report="Observed evidence and uncertainty. ".repeat(100)+"Closing qualification.";
  expect(report.length).toBeGreaterThan(1800);
  expect(verifyUniversalInvestigationTurn(turn({text:report}),expected,permitted))
   .toMatchObject({ok:true,text:report});
  const follow=universalInvestigationPrompt(signal,true,"Earlier source notes. ".repeat(100)+"Final unresolved hypothesis.");
  expect(follow).toContain("Final unresolved hypothesis.");
 });
 it("accepts unfamiliar incidents with source-backed research in a model-chosen order",()=>{
  const reordered=[analytics,caseRead];
  const result=verifyUniversalInvestigationTurn(turn({
   toolInvocations:reordered,tools:reordered.map(x=>x.name)}),expected,permitted);
  expect(result).toMatchObject({ok:true});
 });
 it("rejects fabricated incident identity, denied tool, empty and truncated evidence",()=>{
  expect(verifyUniversalInvestigationTurn(turn({
   toolInvocations:[analytics]}),expected,permitted))
   .toEqual({ok:false,reason:"evidence_incomplete"});
  expect(verifyUniversalInvestigationTurn(turn({
   toolInvocations:[caseRead,{...analytics,name:"propose_purchases"}]}),expected,permitted))
   .toEqual({ok:false,reason:"model_incomplete"});
  expect(verifyUniversalInvestigationTurn(turn({
   toolInvocations:[caseRead,{...analytics,result:{...analytics.result,rows:[],
    missing:["source_read_failed"]}}]}),expected,permitted))
   .toEqual({ok:false,reason:"evidence_incomplete"});
  expect(verifyUniversalInvestigationTurn(turn({
   toolInvocations:[caseRead,{...analytics,result:{...analytics.result,truncated:true}}]}),
   expected,permitted)).toEqual({ok:false,reason:"evidence_incomplete"});
 });
 it("does not mistake discovery, failed readers or scenario arithmetic for observed business facts",()=>{
  const metadata={name:"describe_data",result:{source:"u3_semantic_catalog",period:null,
    missing:[],total:32,relations:[{name:"orders",fieldsTotal:12}]}};
  const hypothetical={name:"calculate",result:{source:"calculate",period:null,
    missing:[],result:12000,estimated:true}};
  const failed={name:"get_sales",result:{source:"daily_rollups",period:null,
    missing:["source_read_failed"],error:"source_read_failed",days:[{netSalesCents:0}]}};
  for(const read of [metadata,hypothetical,failed]){
   expect(verifyUniversalInvestigationTurn(turn({toolInvocations:[caseRead,read],
     results:[caseRead.result,read.result]}),expected,permitted))
     .toEqual({ok:false,reason:"evidence_incomplete"});
  }
  expect(verifyUniversalInvestigationTurn(turn({toolInvocations:[metadata,analytics,hypothetical,caseRead]}),
    expected,permitted)).toMatchObject({ok:true});
 });
 it("binds receiving findings and inert proposals to the actual claimed order",()=>{
  const target={...expected,kind:"supplier_receiving"};
  const source={...caseRead,result:{...caseRead.result,incidentKind:target.kind,
    selectors:{entityId:"po-a"}}};
  const receiving={name:"inspect_purchase_reconciliation",result:{source:"purchase_reconciliation",
    period:null,missing:[],reconciliation:{purchaseOrderId:"po-a",lines:[{acceptedQuantity:2}]}}};
  const proposal={name:"propose_supplier_discrepancy_followup",result:{source:"gmail_proposal",
    period:null,missing:[],proposalCreated:true,approvalRequired:true,sent:false,
    purchaseOrderId:"po-a",proposalId:"draft"}};
  const admitted=[...permitted,proposal.name];
  expect(verifyUniversalInvestigationTurn(turn({toolInvocations:[source,receiving,proposal]}),target,admitted))
    .toMatchObject({ok:true});
  expect(verifyUniversalInvestigationTurn(turn({toolInvocations:[source,receiving,
    {...proposal,result:{...proposal.result,purchaseOrderId:"po-b"}}]}),target,admitted))
    .toEqual({ok:false,reason:"evidence_incomplete"});
 });
 it("rejects model-picked SQL constants without attested source units",()=>{
  const forged={...analytics,result:{...analytics.result,
    rows:[{fakeCents:99999}],evidence:{...analytics.result.evidence,column_units:{}}}};
  expect(verifyUniversalInvestigationTurn(turn({
    toolInvocations:[caseRead,forged],results:[caseRead.result,forged.result]
  }),expected,permitted)).toEqual({ok:false,reason:"evidence_incomplete"});
 });
 it("preserves zero-effect owner approvals and uncertain facts",()=>{
  expect(verifyUniversalInvestigationTurn(turn({text:"I purchased replacement stock."}),
   expected,permitted)).toEqual({ok:false,reason:"model_incomplete"});
  expect(verifyUniversalInvestigationTurn(turn({unverified:[{text:"unknown",
   start:0,end:7,kind:"number"}]}),expected,permitted))
   .toEqual({ok:false,reason:"model_incomplete"});
  expect(verifyUniversalInvestigationTurn(turn({endReason:"budget"}),expected,permitted))
   .toEqual({ok:false,reason:"model_incomplete"});
 });
});
