import {describe,it,expect,vi} from "vitest";
import {supplierPurchasingTools} from "./supplierPurchasing";
import type {AgentToolContext} from "./index";
const input={items:[{ingredientId:"11111111-1111-4111-8111-111111111111",
 itemName:"Milk",quantity:5,unit:"gal"}],neededBy:"2026-11-17",preferredSupplier:null};
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
  const result=await supplierPurchasingTools.propose_supplier_purchase_order.execute(input,{
   purchasing:{inspect:vi.fn(),propose}
  } as unknown as AgentToolContext);
  expect(propose).toHaveBeenCalledOnce();
  expect(result).toMatchObject({draft:true,saved:false,approvalRequired:true,
   orderSent:false,inventoryUpdated:false});
 });
 it("reads durable PO status rather than inventing supplier contact",async()=>{
  const list=vi.fn().mockResolvedValue({orders:[{
   id:"77777777-7777-4777-8777-777777777777",status:"approved_for_ordering",
   sentToSupplier:false,receivedIntoInventory:false,subtotalCents:2250,currency:"CAD"}],
   truncated:false});
  const result=await supplierPurchasingTools.get_supplier_purchase_orders.execute({},{
   purchasing:{inspect:vi.fn(),propose:vi.fn(),list}
  } as unknown as AgentToolContext);
  expect(list).toHaveBeenCalledOnce();
  expect(result).toMatchObject({source:"purchase_orders",missing:[],
   orders:[{status:"approved_for_ordering",sentToSupplier:false,receivedIntoInventory:false}]});
 });
 it("a missing server authority never invents a prepared PO",async()=>{
  const result=await supplierPurchasingTools.propose_supplier_purchase_order.execute(input,{} as AgentToolContext);
  expect(result).toMatchObject({draft:false,saved:false,missing:["purchasing_unavailable"]});
 });
 it("rejects model-authored prices and business IDs",async()=>{
  await expect(supplierPurchasingTools.propose_supplier_purchase_order.execute(
    {...input,subtotalCents:0,businessId:"elsewhere"},{} as AgentToolContext)).rejects.toThrow();
 });
});