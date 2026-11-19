import {describe,expect,it,vi} from "vitest";
import {supplierPurchasingTools} from "./supplierPurchasing";
import type {AgentToolContext} from "./index";
const purchaseOrderId="77777777-7777-4777-8777-777777777777";
describe("Task14D registered reconciliation read",()=>{
 it("does not let model input select a café, owner or effect",async()=>{
  const receivingRead=vi.fn();
  await expect(supplierPurchasingTools.inspect_purchase_reconciliation.execute(
   {purchaseOrderId,businessId:"foreign"}, {receivingRead} as unknown as AgentToolContext)).rejects.toThrow();
  expect(receivingRead).not.toHaveBeenCalled();
 });
 it("uses the exact server scope and returns absent evidence honestly",async()=>{
  const receivingRead=vi.fn().mockResolvedValue({missing:["purchase_order_unavailable"],reconciliation:null});
  const r=await supplierPurchasingTools.inspect_purchase_reconciliation.execute(
   {purchaseOrderId},{receivingRead} as unknown as AgentToolContext);
  expect(receivingRead).toHaveBeenCalledExactlyOnceWith(purchaseOrderId);
  expect(r).toMatchObject({source:"purchase_reconciliation",missing:["purchase_order_unavailable"],reconciliation:null});
 });
 it("does not invent source evidence without the authenticated port",async()=>{
  const r=await supplierPurchasingTools.inspect_purchase_reconciliation.execute(
   {purchaseOrderId},{} as AgentToolContext);
  expect(r).toMatchObject({source:"purchase_reconciliation",missing:["receiving_read_unavailable"],reconciliation:null});
 });
});

describe("Task14D supplier discrepancy follow-up",()=>{
 it("accepts only exact PO identity, no model-selected recipient or authorization",async()=>{
  const receivingFollowup=vi.fn();
  await expect(supplierPurchasingTools.propose_supplier_discrepancy_followup.execute(
   {purchaseOrderId,to:"foreign@example.invalid",send:true},{receivingFollowup} as unknown as AgentToolContext)).rejects.toThrow();
  expect(receivingFollowup).not.toHaveBeenCalled();
 });
 it("returns an inert owner-click card, never a successful supplier send",async()=>{
  const receivingFollowup=vi.fn().mockResolvedValue({proposalId:"draft",revision:1,purchaseOrderId,
   recipient:"verified@example.invalid"});
  const r=await supplierPurchasingTools.propose_supplier_discrepancy_followup.execute(
   {purchaseOrderId},{receivingFollowup} as unknown as AgentToolContext);
  expect(r).toMatchObject({proposalCreated:true,approvalRequired:true,sent:false,purchaseOrderId});
  expect(receivingFollowup).toHaveBeenCalledExactlyOnceWith(purchaseOrderId);
 });
 it("keeps unverified or unavailable contact/source open without a send",async()=>{
  const receivingFollowup=vi.fn().mockRejectedValue(new Error("supplier_followup_verified_contact_required"));
  const r=await supplierPurchasingTools.propose_supplier_discrepancy_followup.execute(
   {purchaseOrderId},{receivingFollowup} as unknown as AgentToolContext);
  expect(r).toMatchObject({proposalCreated:false,sent:false,
   missing:["supplier_followup_requires_verified_contact_or_open_evidence"]});
 });
});
