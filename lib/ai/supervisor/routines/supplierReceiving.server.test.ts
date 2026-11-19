import {describe,expect,it} from "vitest";
import {verifyInvestigationTurn,investigationPrompt} from "./investigation";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
const source={name:"get_investigation_source",result:{source:"investigation_source",period:null,missing:[],
 sourceType:"operating_task",sourceId:"supplier-receiving:po",incidentKind:"supplier_receiving",
 selectors:{entityType:"purchase_order",entityId:"po"}}};
const recon=(po="po")=>({name:"inspect_purchase_reconciliation",result:{source:"purchase_reconciliation",
 period:null,missing:[],reconciliation:{purchaseOrderId:po,lines:[{acceptedQuantity:60,orderedQuantity:100}],
 closureVerified:false}}});
const stock={name:"get_inventory",result:{source:"inventory",period:null,missing:[],
 ingredients:[{ingredientId:"milk",quantity:60}]}};
const expenses={name:"get_expenses",result:{source:"expenses",period:null,missing:[],totalCents:12000}};
const expected={sourceType:"operating_task" as const,sourceId:"supplier-receiving:po",kind:"supplier_receiving"};
const run=(calls:unknown[])=>verifyInvestigationTurn({endReason:"complete",unverified:[],
 text:"The receiving evidence is incomplete. Please verify what arrived before we record stock.",
 toolInvocations:calls} as unknown as AgentTurn,expected);
describe("Task14D off-turn receiving evidence gate",()=>{
 it("requires actual exact-PO reconciliation and independent source",()=>{
  expect(run([source,recon(),stock]).ok).toBe(true);
  expect(run([source,recon()]).ok).toBe(false);
  expect(run([source,stock,expenses]).ok).toBe(false);
  expect(run([source,recon("foreign-po"),stock]).ok).toBe(false);
 });
 it("never allows effect tools or absent source",()=>{
  expect(run([source,recon(),stock,{name:"propose_purchase_receiving",result:{}}]).ok).toBe(false);
  expect(run([recon(),stock]).ok).toBe(false);
 });
 it("reminds Luna not to equate supplier dispatch and invoices with physical receipt",()=>{
  const p=investigationPrompt({kind:"supplier_receiving",status:"watching",severity:null,
   quality:"high",relatedAlerts:[],relatedTasks:[]},true);
  expect(p).toContain("never establishes actual physical receipt");
  expect(p).toContain("Recheck on every follow-up");
 });
});

describe("one narrowly scoped inert receiving follow-up during existing investigation",()=>{
 const draft=(po="po",sent=false)=>({name:"propose_supplier_discrepancy_followup",
  result:{source:"supplier_vendor_dispatch",period:null,missing:[],proposalCreated:true,
   approvalRequired:true,sent,purchaseOrderId:po,proposalId:"inert-draft"}});
 it("requires independently observed exact PO and does not allow claimed send",()=>{
  expect(run([source,recon(),stock,draft()]).ok).toBe(true);
  expect(run([source,recon(),stock,draft("foreign-po")]).ok).toBe(false);
  expect(run([source,recon(),stock,draft("po",true)]).ok).toBe(false);
  expect(run([source,recon(),draft()]).ok).toBe(false);
 });
});
