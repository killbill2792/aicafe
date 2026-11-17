import {describe,it,expect,vi} from "vitest";
import {supplierPurchasingTools} from "./supplierPurchasing";
import type {AgentToolContext} from "./index";
const input={items:[{ingredientId:"11111111-1111-4111-8111-111111111111",
 itemName:"Milk",quantity:5,unit:"gal"}],neededBy:"2026-11-17",preferredSupplier:null};
const newProposal={...input,replaceProposalId:null};
describe("Task14B: one agent, real purchasing work—not chat-only advice",()=>{
 it("investigates server-side evidence before a proposal and does not claim a full cost",async()=>{
  const inspect=vi.fn().mockResolvedValue({offers:[{
   supplierName:"Farm A",currency:"CAD",subtotalCents:2250,totalCents:null,
   shippingCents:null,taxCents:null,lines:[],limitations:["shipping_unknown"]}],
   missing:[],comparison:"subtotal_only",truncated:false});
  const result=await supplierPurchasingTools.inspect_supplier_purchase.execute(input,{
   purchasing:{inspect,propose:vi.fn()},asOf:"2026-11-13"
  } as unknown as AgentToolContext);
  expect(inspect).toHaveBeenCalledOnce();
  expect(result.comparison).toBe("subtotal_only");
  expect(result.offers).toMatchObject([{subtotalCents:2250,totalCents:null}]);
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
 it("reads durable PO status rather than inventing supplier contact",async()=>{
  const list=vi.fn().mockResolvedValue({orders:[{
   id:"77777777-7777-4777-8777-777777777777",status:"approved_for_ordering",
   sentToSupplier:false,receivedIntoInventory:false,subtotalCents:2250,currency:"CAD"}],
   truncated:false,drafts:[{id:"55555555-5555-4555-8555-555555555555",
     revision:1,supplierName:"Farm A",itemNames:["Milk"],subtotalCents:2250,currency:"CAD"}],
   draftsTruncated:false,unresolvedApprovals:[],unresolvedApprovalsTruncated:false});
  const result=await supplierPurchasingTools.get_supplier_purchase_orders.execute({},{
   purchasing:{inspect:vi.fn(),propose:vi.fn(),list}
  } as unknown as AgentToolContext);
  expect(list).toHaveBeenCalledOnce();
  expect(result).toMatchObject({source:"purchase_orders",missing:[],
   orders:[{status:"approved_for_ordering",sentToSupplier:false,receivedIntoInventory:false}],
   drafts:[{id:"55555555-5555-4555-8555-555555555555",itemNames:["Milk"]}]});
 });
 it("reveals interrupted owner approvals separately from drafts and never invents a PO",async()=>{
  const list=vi.fn().mockResolvedValue({
    orders:[],truncated:false,drafts:[],draftsTruncated:false,
    unresolvedApprovals:[
      {id:"66666666-6666-4666-8666-666666666666",revision:2,
       supplierName:"Farm A",itemNames:["Milk"],subtotalCents:2250,currency:"CAD",
       status:"approved",attemptState:null,recovery:"owner_retry_or_cancel"},
      {id:"88888888-8888-4888-8888-888888888888",revision:3,
       supplierName:"Farm B",itemNames:["Flour"],subtotalCents:1350,currency:"CAD",
       status:"executing",attemptState:"uncertain",recovery:"receipt_only"}
    ],unresolvedApprovalsTruncated:false
  });
  const result=await supplierPurchasingTools.get_supplier_purchase_orders.execute({},{
    purchasing:{inspect:vi.fn(),propose:vi.fn(),list}
  } as unknown as AgentToolContext);
  expect(result.orders).toEqual([]);
  expect(result.drafts).toEqual([]);
  expect(result.missing).toContain("supplier_po_approval_unresolved");
  expect(result.unresolvedApprovals).toMatchObject([
    {status:"approved",attemptState:null,recovery:"owner_retry_or_cancel"},
    {status:"executing",attemptState:"uncertain",recovery:"receipt_only"}
  ]);
  expect(list).toHaveBeenCalledOnce();
 });
 it("reports truncated unresolved approval history rather than treating the list as complete",async()=>{
  const list=vi.fn().mockResolvedValue({
    orders:[],truncated:false,drafts:[],draftsTruncated:false,
    unresolvedApprovals:[],unresolvedApprovalsTruncated:true
  });
  const result=await supplierPurchasingTools.get_supplier_purchase_orders.execute({},{
    purchasing:{inspect:vi.fn(),propose:vi.fn(),list}
  } as unknown as AgentToolContext);
  expect(result.missing).toContain("supplier_po_unresolved_history_truncated");
  expect(result.unresolvedApprovalsTruncated).toBe(true);
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