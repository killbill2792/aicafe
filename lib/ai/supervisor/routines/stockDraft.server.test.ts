import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {OwnerLoopScope} from "@/lib/ai/supervisor/loop/engine";

const f=vi.hoisted(()=>({
 orders:vi.fn(), evidence:vi.fn(), communication:vi.fn(), reconciliation:vi.fn(),
 proposals:vi.fn(), inspect:vi.fn(), email:vi.fn(), usage:vi.fn(), stock:vi.fn(), project:vi.fn(),
}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/supervisor/loop/engine",()=>({proposeLoop:vi.fn()}));
vi.mock("@/lib/ai/supervisor/loop/requestKeys",()=>({proposalRequestKey:()=> "key"}));
vi.mock("@/lib/ai/supervisor/loop/purchaseOrders.server",()=>({
 investigateSupplierPurchase:f.inspect,supplierPurchaseOrderCapabilityId:"maya.supplier_purchase_order.v1",
 supplierPurchaseOrderEffectSchema:{safeParse:(data:unknown)=>({success:true,data})},
 supplierPurchaseInputSchema:{safeParse:(data:unknown)=>({success:true,data})},
}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({readOwnerProposals:f.proposals}));
vi.mock("@/lib/data/supplierPurchasing.server",()=>({readSupplierPurchaseOrders:f.orders,readSupplierPurchasingEvidence:f.evidence,readSupplierOrderCommunications:f.communication}));
vi.mock("@/lib/data/supplierReceiving.server",()=>({readSupplierReconciliation:f.reconciliation}));
vi.mock("@/lib/data/usageVariance.server",()=>({readUsageVariance:f.usage}));
vi.mock("@/lib/data/canonical/reads.server",()=>({readCanonicalView:f.stock}));
vi.mock("@/lib/calc/inventoryEvidence",()=>({projectInventoryEvidence:f.project}));
vi.mock("@/lib/ai/supervisor/loop/vendorDispatch.server",()=>({proposeApprovedSupplierEmail:f.email,VendorOrderOwnerInputRequired:class extends Error{question=""}}));
import {prepareProactiveStockDraft} from "./stockDraft.server";

const scope={businessId:"cafe",ownerUserId:"owner",threadId:"thread",locale:"en"} as OwnerLoopScope;
const ingredient="coffee";
const po={id:"po",status:"approved_for_ordering",revision:2,receivingEvidence:"not_yet_verified",lines:[{ingredientId:ingredient,baseUnit:"g"}]};
let revoked=false;
let foreignOrders=false;
function db(){
 const response=(table:string)=>{
  if(table==="supervisor_investigations")return revoked?null:{source_id:"alert"};
  if(table==="memberships")return {role:"owner"};
  if(table==="alerts")return {kind:"business_anomaly",status:"new",payload:{family:"stock_shortage",subject:ingredient}};
  if(table==="purchase_order_dispatches")return {proposal_id:"email",po_revision:2};
  if(table==="purchase_order_lines")return foreignOrders?[{purchase_order_id:"other-po"}]:[];
  if(table==="purchase_orders")return foreignOrders?[{id:"other-po",owner_user_id:"other-owner"}]:[];
  throw Error(table);
 };
 return {from:vi.fn((table:string)=>{
  const chain={select:()=>chain,eq:()=>chain,gt:()=>chain,neq:()=>chain,in:()=>chain,limit:async()=>({data:response(table),error:null}),maybeSingle:async()=>({data:response(table),error:null})};
  return chain;
 })} as unknown as SupabaseClient;
}
const run=()=>prepareProactiveStockDraft(db(),scope,"alert","episode","lease",ingredient,"2026-11-19");
beforeEach(()=>{
 vi.resetAllMocks();revoked=false;foreignOrders=false;
 f.stock.mockResolvedValue({rows:[],error:null,truncated:false});
 f.usage.mockResolvedValue({rows:[],provenance:{coverage:"complete"}});
 f.evidence.mockResolvedValue({ingredients:[],truncated:false});
 f.proposals.mockResolvedValue([]);
 f.orders.mockResolvedValue({orders:[po],truncated:false});
 f.communication.mockResolvedValue([{purchaseOrderId:"po",state:"not_prepared",contactVerified:true,channel:"gmail",ownerReportedOutcome:null,providerVerified:false}]);
 f.reconciliation.mockResolvedValue({missing:[],reconciliation:{closureVerified:false,receipts:[]}});
 f.email.mockResolvedValue({proposalId:"email"});
 f.project.mockReturnValue({rows:[]});
});
describe("proactive procurement lifecycle",()=>{
 it("requires the still-authorized lease before any purchase work",async()=>{
  revoked=true;await expect(run()).rejects.toThrow("stock_claim_unavailable");
  expect(f.orders).not.toHaveBeenCalled();expect(f.email).not.toHaveBeenCalled();
 });
 it("does not expose or duplicate another owner's outstanding café order",async()=>{
  foreignOrders=true;
  f.orders.mockResolvedValueOnce({orders:[],truncated:false}).mockResolvedValueOnce({orders:[{...po,id:"other-po"}],truncated:false});
  const result=await run();
  expect(result).toEqual({state:"existing",summary:"An existing café order covers this ingredient. I will not prepare a duplicate purchase."});
  expect(f.orders).toHaveBeenCalledWith(expect.anything(),"cafe","other-owner","other-po");
  expect(f.email).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();
 });
 it("prepares a separate inert email for a verified approved PO",async()=>{
  expect(await run()).toMatchObject({state:"existing",emailProposalId:"email"});
  expect(f.email).toHaveBeenCalledWith(scope,"po","key");
  expect(f.inspect).not.toHaveBeenCalled();
 });
 it("recovers the exact prepared email instead of creating another draft",async()=>{
  f.communication.mockResolvedValue([{state:"prepared"}]);
  f.proposals.mockResolvedValueOnce([]).mockResolvedValueOnce([{id:"email"}]);
  expect(await run()).toMatchObject({state:"existing",emailProposalId:"email"});
  expect(f.email).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();
 });
 it.each(["send_uncertain","provider_accepted"])("does not repeat %s",async state=>{
  f.communication.mockResolvedValue([{state,providerVerified:state==="provider_accepted"}]);
  expect(await run()).toMatchObject({state:"existing"});
  expect(f.email).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();
 });
 it("does not order again after receiving until a newer count and reconciliation exist",async()=>{
  f.orders.mockResolvedValue({orders:[{...po,receivingEvidence:"complete_verified"}],truncated:false});
  f.reconciliation.mockResolvedValue({missing:[],reconciliation:{closureVerified:true,receipts:[{receivedOn:"2026-11-18"}]}});
  f.project.mockReturnValue({rows:[{source:"app",ingredient_id:ingredient,quantity:0,quantity_unit:"g",source_as_of:"2026-11-18"}]});
  expect(await run()).toMatchObject({state:"existing",question:"Please record a new physical count after the delivery."});
  expect(f.email).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();
 });
});
