import {describe,expect,it,vi} from "vitest";
import {supplierPurchasingTools} from "./supplierPurchasing";
import type {AgentToolContext} from "./index";
const purchaseOrderId="77777777-7777-4777-8777-777777777777";
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
  expect(r).toMatchObject({source:"gmail_proposal",proposalCreated:true,draft:true,saved:false,
   approvalRequired:true,requiredApproval:"owner_click",operation:"send",sent:false,purchaseOrderId});
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
