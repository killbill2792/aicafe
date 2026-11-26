import {describe,it,expect,vi} from "vitest";
import {supplierPurchasingTools} from "./supplierPurchasing";
import type {AgentToolContext} from "./index";
const input={items:[{ingredientId:"11111111-1111-4111-8111-111111111111",
 itemName:"Milk",quantity:5,unit:"gal"}],neededBy:"2026-11-17",preferredSupplier:null};
const newProposal={...input,replaceProposalId:null};
describe("Task14C: canonical owner-reported supplier outcomes from Supervisor chat",()=>{
 const po="77777777-7777-4777-8777-777777777777";
 const note="The supplier accepted this PO by phone.";
 const payload={purchaseOrderId:po,channel:"phone",outcome:"supplier_accepted"};
 it("persists the current authenticated owner's explicit outcome through the canonical port",async()=>{
  const recordOwnerOutcome=vi.fn().mockResolvedValue({
    reportId:"66666666-6666-4666-8666-666666666666",
    reportedAt:"2026-11-18T12:00:00Z",alreadyRecorded:false,
    source:"owner_reported",providerVerified:false,outcome:"supplier_accepted"
  });
  const result=await supplierPurchasingTools.record_supplier_order_outcome.execute(payload,{
    ownerText:note,purchasing:{recordOwnerOutcome}
  } as unknown as AgentToolContext);
  expect(recordOwnerOutcome).toHaveBeenCalledExactlyOnceWith({...payload,note});
  expect(result).toMatchObject({saved:true,source:"supplier_owner_report",
    outcome:"supplier_accepted",supplierAcceptanceSource:"owner_reported",providerVerified:false});
 });
 it("rejects an outcome copied from earlier history or invented by the model",async()=>{
  const recordOwnerOutcome=vi.fn();
  const stale=await supplierPurchasingTools.record_supplier_order_outcome.execute(payload,{
    ownerText:"Did the supplier accept this order?",purchasing:{recordOwnerOutcome}
  } as unknown as AgentToolContext);
  const negated=await supplierPurchasingTools.record_supplier_order_outcome.execute(
    payload,{
      ownerText:"The supplier did not accept the PO.",purchasing:{recordOwnerOutcome}
    } as unknown as AgentToolContext);
  expect(stale).toMatchObject({saved:false,missing:["explicit_current_owner_report_required"]});
  expect(negated).toMatchObject({saved:false,missing:["explicit_current_owner_report_required"]});
  expect(recordOwnerOutcome).not.toHaveBeenCalled();
 });
 it("requires a working canonical writer instead of claiming a chat-only save",async()=>{
  const result=await supplierPurchasingTools.record_supplier_order_outcome.execute(payload,{
    ownerText:note
  } as unknown as AgentToolContext);
  expect(result).toMatchObject({saved:false,missing:["owner_report_writer_unavailable"]});
 });
});

describe("Task14B: one agent, real purchasing work—not chat-only advice",()=>{
 it("drafts one Gmail vendor send only from the approved-PO authority port",async()=>{
  const id="77777777-7777-4777-8777-777777777777";
  const proposeVendorSend=vi.fn().mockResolvedValue({
    proposalId:"33333333-3333-4333-8333-333333333333",
    revision:1,purchaseOrderId:id,supplierName:"Sample Dairy",
    recipient:"verified@supplier.example",account:"owner@example.com",note:"Awaiting owner click"
  });
  const result=await supplierPurchasingTools.propose_supplier_vendor_email.execute(
    {purchaseOrderId:id},{
      purchasing:{proposeVendorSend}
    } as unknown as AgentToolContext);
  expect(proposeVendorSend).toHaveBeenCalledExactlyOnceWith({purchaseOrderId:id});
  expect(result).toMatchObject({proposalCreated:true,sent:false,
    approvalRequired:true,purchaseOrderId:id});
 });
 it("does not silently stop if Gmail is unavailable or supplier uses a portal",async()=>{
  const id="77777777-7777-4777-8777-777777777777";
  const noPort=await supplierPurchasingTools.propose_supplier_vendor_email.execute(
    {purchaseOrderId:id},{} as AgentToolContext);
  expect(noPort).toMatchObject({proposalCreated:false,
    missing:["purchasing_unavailable"]});
  expect(noPort.ownerQuestion).toContain("normally contact");
 });
 it("can actually save a draft through a real server port, not claim ordering",async()=>{
  const propose=vi.fn().mockResolvedValue({proposalId:"22222222-2222-4222-8222-222222222222",
   revision:1,supplierName:"Farm A",subtotalCents:2250,currency:"CAD"});
  const result=await supplierPurchasingTools.propose_supplier_purchase_order.execute(newProposal,{
   purchasing:{inspect:vi.fn(),propose}
  } as unknown as AgentToolContext);
  expect(propose).toHaveBeenCalledOnce();
  expect(propose).toHaveBeenCalledWith(newProposal);
  expect(result).toMatchObject({draft:true,saved:false,approvalRequired:true,
   orderSent:false,inventoryUpdated:false});
 });
 it("requires a nullable explicit replacement ID; never guesses from owner wording",async()=>{
  const propose=vi.fn().mockResolvedValue({proposalId:"33333333-3333-4333-8333-333333333333",
   revision:1,supplierName:"Farm B",subtotalCents:900,currency:"CAD"});
  const ctx={purchasing:{inspect:vi.fn(),propose}} as unknown as AgentToolContext;
  const oldId="55555555-5555-4555-8555-555555555555";
  await supplierPurchasingTools.propose_supplier_purchase_order.execute(
   {...input,replaceProposalId:oldId},ctx);
  expect(propose).toHaveBeenLastCalledWith({...input,replaceProposalId:oldId});
  await supplierPurchasingTools.propose_supplier_purchase_order.execute(newProposal,ctx);
  expect(propose).toHaveBeenLastCalledWith(newProposal);
  // No optional/guessed correction target: strict OpenAI tool schema uses null.
  await expect(supplierPurchasingTools.propose_supplier_purchase_order.execute(
   input,ctx)).rejects.toThrow();
  await expect(supplierPurchasingTools.propose_supplier_purchase_order.execute(
   {...input,replaceProposalId:"other draft"},ctx)).rejects.toThrow();
 });
 it("a missing server authority never invents a prepared PO",async()=>{
  const result=await supplierPurchasingTools.propose_supplier_purchase_order.execute(newProposal,{} as AgentToolContext);
  expect(result).toMatchObject({draft:false,saved:false,missing:["purchasing_unavailable"]});
 });
 it("rejects model-authored prices and business IDs",async()=>{
  await expect(supplierPurchasingTools.propose_supplier_purchase_order.execute(
    {...newProposal,subtotalCents:0,businessId:"elsewhere"},{} as AgentToolContext)).rejects.toThrow();
 });
});