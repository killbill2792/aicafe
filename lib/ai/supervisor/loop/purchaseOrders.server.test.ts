import {beforeEach,describe,it,expect,vi} from "vitest";
import {readSupplierPurchasingEvidence} from "@/lib/data/supplierPurchasing.server";
import {simulationOwnerReader} from "./simulationOwner.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {supplierPurchaseOrderCapability,supplierPurchaseOrderCapabilityId} from "./purchaseOrders.server";
vi.mock("server-only",()=>({}));
vi.mock("./simulationOwner.server",()=>({simulationOwnerReader:vi.fn()}));
vi.mock("@/lib/data/supplierPurchasing.server",()=>({readSupplierPurchasingEvidence:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:vi.fn()}));
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",
 threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const ingredientId="44444444-4444-4444-8444-444444444444";
const quoteId="55555555-5555-4555-8555-555555555555";
const proposalId="66666666-6666-4666-8666-666666666666";
const input={items:[{itemName:"Milk",ingredientId,quantity:5,unit:"gal" as const}],
 neededBy:"2026-11-17",preferredSupplier:null};
const baseQuote={id:quoteId,supplier_name:"Farm A",item_name:"Milk",ingredient_id:ingredientId,
 price_cents:450,package_count:1,package_unit:"gal",currency_code:"CAD",
 source_kind:"supplier_quote",quoted_on:"2026-11-12",valid_until:"2026-11-20",
 available_status:"confirmed",available_checked_at:"2026-11-13",delivery_on:"2026-11-16"};
beforeEach(()=>{
 vi.mocked(simulationOwnerReader).mockReset().mockResolvedValue({client:{} as never,explicit:true});
 vi.mocked(readSupplierPurchasingEvidence).mockReset().mockResolvedValue({
  ingredients:[{id:ingredientId,name:"Milk",base_unit:"ml"}],
  quotes:[baseQuote],currency:"CAD",timezone:"UTC",truncated:false,
 } as never);
 vi.mocked(createAdminSupabaseClient).mockReset();
});
describe("Task14B Supervisor PO: independently investigates, then prepares a durable proposal",()=>{
 it("uses the verified scoped reader and the same supplier evidence planner as the tool",async()=>{
  const p=await supplierPurchaseOrderCapability.simulate(scope,input);
  expect(supplierPurchaseOrderCapabilityId).toBe("maya.supplier_purchase_order.v1");
  expect(simulationOwnerReader).toHaveBeenCalledWith(scope);
  expect(readSupplierPurchasingEvidence).toHaveBeenCalledWith({},scope.businessId);
  expect(p.effect).toMatchObject({supplierName:"Farm A",currency:"CAD",neededBy:"2026-11-17",
   subtotalCents:2250,totalCents:null,shippingCents:null,taxCents:null,
   lines:[{quoteId,packs:5,priceCents:450}]});
  expect(p.monitorSpec).toMatchObject({durationDays:1,metricScope:"supplier_purchase_order"});
 });
 it("fails closed when the only supplier evidence is unconfirmed",async()=>{
  vi.mocked(readSupplierPurchasingEvidence).mockResolvedValue({
   ingredients:[{id:ingredientId,name:"Milk",base_unit:"ml"}],
   quotes:[{...baseQuote,currency_code:null}],currency:"CAD",timezone:"UTC",truncated:false,
  } as never);
  await expect(supplierPurchaseOrderCapability.simulate(scope,input)).rejects.toThrow(/No complete supplier quote/);
 });
 it("commits only through one scoped PO RPC and validates its durable return receipt",async()=>{
  const proposal=await supplierPurchaseOrderCapability.simulate(scope,input);
  const rpc=vi.fn().mockResolvedValue({data:{orderId:"77777777-7777-4777-8777-777777777777",
   status:"approved_for_ordering",subtotalCents:2250,currency:"CAD"},error:null});
  vi.mocked(createAdminSupabaseClient).mockReturnValue({rpc} as never);
  const result=await supplierPurchaseOrderCapability.commit(scope,proposal.effect,proposalId);
  expect(result).toMatchObject({status:"verified",evidenceSource:"purchase_orders"});
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith("supervisor_commit_supplier_po",
   expect.objectContaining({p_business_id:scope.businessId,
    p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,p_proposal_id:proposalId}));
 });
 it("never claims saved from missing or mismatched receipts",async()=>{
  const proposal=await supplierPurchaseOrderCapability.simulate(scope,input);
  const rpc=vi.fn().mockResolvedValue({data:{orderId:proposalId,status:"approved_for_ordering",
   subtotalCents:99999,currency:"CAD"},error:null});
  vi.mocked(createAdminSupabaseClient).mockReturnValue({rpc} as never);
  await expect(supplierPurchaseOrderCapability.commit(scope,proposal.effect,proposalId))
   .rejects.toThrow("supplier_po_save_unverified");
 });
});
