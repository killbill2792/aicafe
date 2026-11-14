import "server-only";
import {z} from "zod";
import {cafeToday} from "@/lib/metrics/core/clock";
import {ToolError} from "@/lib/ai/agent/toolErrors";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {readSupplierPurchasingEvidence} from "@/lib/data/supplierPurchasing.server";
import {planSupplierOrder} from "@/lib/purchasing/planOrder";
import {effectHash,registerLoopCapability} from "./engine";
import {simulationOwnerReader} from "./simulationOwner.server";

/** OWNER REQUIREMENT: Supervisor is a multi-step operational agent, not a chat
 * response generator. This capability shares its planning evidence and effect
 * gateway with the one universal Supervisor. Approval is never model-authored. */
export const supplierPurchaseOrderCapabilityId="maya.supplier_purchase_order.v1";

export const supplierPurchaseNeedSchema=z.strictObject({
 itemName:z.string().trim().min(1).max(120),
 ingredientId:z.uuid().nullable(),
 quantity:z.number().finite().positive().max(100000),
 unit:z.enum(["gal","qt","l","ml","fl_oz","lb","kg","oz","g","each","dozen","case"]),
});
export const supplierPurchaseInputSchema=z.strictObject({
 items:z.array(supplierPurchaseNeedSchema).min(1).max(10),
 neededBy:z.iso.date().nullable(),
 preferredSupplier:z.string().trim().min(2).max(120).nullable(),
});
export type SupplierPurchaseInput=z.infer<typeof supplierPurchaseInputSchema>;
const poLine=z.strictObject({
 quoteId:z.uuid(),ingredientId:z.uuid(),itemName:z.string().min(1).max(120),
 neededBaseQuantity:z.number().finite().positive(),baseUnit:z.enum(["g","ml","each"]),
 packs:z.number().int().min(1).max(100000),packQuantity:z.number().int().min(1).max(100000),
 packUnit:z.string().min(1).max(40),priceCents:z.number().int().positive().safe(),
 lineSubtotalCents:z.number().int().positive().safe(),quotedOn:z.iso.date(),
 deliveryOn:z.iso.date().nullable(),
});
export const supplierPurchaseOrderEffectSchema=z.strictObject({
 supplierName:z.string().min(2).max(120),currency:z.string().regex(/^[A-Z]{3}$/u),
 neededBy:z.iso.date().nullable(),subtotalCents:z.number().int().positive().safe(),
 totalCents:z.null(),shippingCents:z.null(),taxCents:z.null(),
 limitations:z.array(z.string().max(100)).min(1).max(12),
 lines:z.array(poLine).min(1).max(10),
});
export type SupplierPurchaseOrderEffect=z.infer<typeof supplierPurchaseOrderEffectSchema>;

export async function investigateSupplierPurchase(scope:Parameters<typeof simulationOwnerReader>[0],
 input:SupplierPurchaseInput){
 const {client}=await simulationOwnerReader(scope);
 const evidence=await readSupplierPurchasingEvidence(client,scope.businessId);
 return planSupplierOrder({
  needs:input.items,ingredients:evidence.ingredients,quotes:evidence.quotes,
  currency:evidence.currency,today:cafeToday(evidence.timezone),
  neededBy:input.neededBy,preferredSupplier:input.preferredSupplier,
  truncated:evidence.truncated,
 });
}
export const supplierPurchaseOrderCapability=registerLoopCapability({
 id:supplierPurchaseOrderCapabilityId,version:1,
 inputSchema:supplierPurchaseInputSchema,effectSchema:supplierPurchaseOrderEffectSchema,
 proposalDescription:"AGENTIC purchasing: independently inspect scoped ingredient and supplier evidence, compare verified quantities/prices, then PREPARE an inert order for explicit owner click. Never treat a proposal or approval as supplier delivery, an invoice or inventory stock.",
 dependencyScope:effect=>({kind:"supplier_purchase_order",supplierName:effect.supplierName}),
 simulate:async(scope,input)=>{
  const plan=await investigateSupplierPurchase(scope,input);
  const offer=plan.offers[0];
  if(!offer)throw new ToolError("validation","No complete supplier quote covers the requested items; investigate missing evidence and never invent a price or delivery.");
  const effect:SupplierPurchaseOrderEffect={
   supplierName:offer.supplierName,currency:offer.currency,neededBy:input.neededBy,
   subtotalCents:offer.subtotalCents,totalCents:null,shippingCents:null,taxCents:null,
   lines:offer.lines,limitations:offer.limitations,
  };
  return {effect,baseline:{otherOffers:plan.offers.slice(1).map(o=>({
    supplierName:o.supplierName,subtotalCents:o.subtotalCents,currency:o.currency})),
   missing:plan.missing,comparison:plan.comparison,
   ownerNotice:"Only a subtotal estimate: freight and tax are unknown. No order is sent."},
   monitorSpec:{durationDays:1,metricScope:"supplier_purchase_order"}};
 },
 commit:async(scope,effect,proposalId)=>{
  if(!proposalId)throw new Error("supplier_po_proposal_id_required");
  const {data,error}=await createAdminSupabaseClient().rpc("supervisor_commit_supplier_po",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
   p_thread_id:scope.threadId,p_proposal_id:proposalId,p_effect_hash:effectHash(effect)});
  if(error||!data||data.status!=="approved_for_ordering"||
    data.subtotalCents!==effect.subtotalCents||data.currency!==effect.currency||
    typeof data.orderId!=="string")
   throw new Error("supplier_po_save_unverified");
  return {status:"verified",evidenceSource:"purchase_orders"};
 },
 monitor:async()=>null,
 report:async()=>({status:"complete",result:{},recommendation:"keep",source:"purchase_orders"}),
});
