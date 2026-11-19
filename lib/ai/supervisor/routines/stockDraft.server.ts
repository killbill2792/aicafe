import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {LoopCreate,OwnerLoopScope} from "@/lib/ai/supervisor/loop/engine";
import {proposeLoop} from "@/lib/ai/supervisor/loop/engine";
import {proposalRequestKey} from "@/lib/ai/supervisor/loop/requestKeys";
import {investigateSupplierPurchase,supplierPurchaseOrderCapabilityId,supplierPurchaseInputSchema,supplierPurchaseOrderEffectSchema} from "@/lib/ai/supervisor/loop/purchaseOrders.server";
import {readOwnerProposals} from "@/lib/ai/supervisor/loop/reads.server";
import {readSupplierPurchaseOrders,readSupplierPurchasingEvidence,readSupplierOrderCommunications} from "@/lib/data/supplierPurchasing.server";
import {readUsageVariance} from "@/lib/data/usageVariance.server";
import {readCanonicalView} from "@/lib/data/canonical/reads.server";
import {projectInventoryEvidence} from "@/lib/calc/inventoryEvidence";

import {proposeApprovedSupplierEmail,VendorOrderOwnerInputRequired} from "@/lib/ai/supervisor/loop/vendorDispatch.server";
import {readSupplierReconciliation} from "@/lib/data/supplierReceiving.server";

const date=(d:string,n:number)=>new Date(Date.parse(d+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
/** An unattended investigation may prepare an inert, owner-click-only proposal.
 * The stock shortage is not an authority to send or commit anything. */
export async function prepareProactiveStockDraft(db:SupabaseClient,scope:OwnerLoopScope,sourceId:string,episodeId:string,leaseToken:string,ingredientId:string,today:string):Promise<{state:"draft"|"existing"|"missing";proposalId?:string;emailProposalId?:string;summary?:string;question?:string}>{
 const assertClaim=async()=>{
  const [claim,owner,alert]=await Promise.all([
   db.from("supervisor_investigations").select("source_id").eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).eq("thread_id",scope.threadId).eq("source_type","alert").eq("source_id",sourceId).eq("episode_id",episodeId).eq("lease_token",leaseToken).gt("lease_until",new Date().toISOString()).maybeSingle(),
   db.from("memberships").select("role").eq("business_id",scope.businessId).eq("user_id",scope.ownerUserId).maybeSingle(),
   db.from("alerts").select("kind,status,payload").eq("business_id",scope.businessId).eq("id",sourceId).maybeSingle(),
  ]);
  if(claim.error||!claim.data||owner.error||owner.data?.role!=="owner"||alert.error||alert.data?.kind!=="business_anomaly"||!["new","seen"].includes(alert.data.status)||!["stockout_risk","stock_shortage"].includes(String(alert.data.payload?.family))||alert.data.payload?.subject!==ingredientId)throw Error("stock_claim_unavailable");
 };
 await assertClaim();
 // The database checks this observation window again when the inert draft is inserted.
 const checkedAt=new Date().toISOString();
 const [stock,usage,evidence,proposals,orders]=await Promise.all([
  readCanonicalView(db,scope.businessId,"cv_inventory",{dateFrom:date(today,-1),dateTo:today},100),
  readUsageVariance({from:date(today,-7),to:date(today,-1),ingredient:ingredientId},{client:db,businessId:scope.businessId}),
  readSupplierPurchasingEvidence(db,scope.businessId),
  readOwnerProposals(db,scope,{capabilityId:supplierPurchaseOrderCapabilityId,statuses:["draft","approved","executing"],limit:101}),
  readSupplierPurchaseOrders(db,scope.businessId,scope.ownerUserId),
 ]);
 if(stock.error||stock.truncated||orders.truncated||proposals.length>100||evidence.truncated)return {state:"missing"};
 for(const p of proposals){
  const parsed=supplierPurchaseOrderEffectSchema.safeParse(p.canonical_effect_payload);
  if(!parsed.success)return {state:"missing"};
  if(parsed.data.lines.some(l=>l.ingredientId===ingredientId))return p.status==="draft"&&p.thread_id===scope.threadId?{state:"draft",proposalId:p.id}:{state:"existing"};
 }
 // Other owners' private orders are never attached to this thread. Inspect only
 // the shared café/ingredient's outstanding order condition, and disclose no
 // private order IDs, supplier details or owner identity.
 const matchingLines=await db.from("purchase_order_lines").select("purchase_order_id")
  .eq("business_id",scope.businessId).eq("ingredient_id",ingredientId).limit(101);
 if(matchingLines.error||(matchingLines.data??[]).length>100)return {state:"missing"};
 const orderIds=[...new Set((matchingLines.data??[]).map(l=>String(l.purchase_order_id)))];
 if(orderIds.length){
  const foreign=await db.from("purchase_orders").select("id,owner_user_id")
   .eq("business_id",scope.businessId).eq("status","approved_for_ordering")
   .neq("owner_user_id",scope.ownerUserId).in("id",orderIds).limit(101);
  if(foreign.error||(foreign.data??[]).length>100)return {state:"missing"};
  for(const order of foreign.data??[]){
   const readback=await readSupplierPurchaseOrders(db,scope.businessId,order.owner_user_id,order.id);
   const other=readback.orders.find(o=>o.id===order.id);
   if(readback.truncated||!other||other.receivingEvidence!=="complete_verified")
    return {state:"existing",summary:"An existing café order covers this ingredient. I will not prepare a duplicate purchase."};
   const verified=await readSupplierReconciliation(db,scope.businessId,order.owner_user_id,order.id);
   const last=verified.reconciliation?.receipts.map(r=>r.receivedOn).sort().at(-1);
   const fresh=projectInventoryEvidence(stock.rows,100).rows.some(r=>r.source==="app"&&r.ingredient_id===ingredientId&&r.quantity!==null&&r.quantity_unit===other.lines.find(l=>l.ingredientId===ingredientId)?.baseUnit&&last&&String(r.source_as_of).slice(0,10)>last);
   if(!fresh||!verified.reconciliation?.closureVerified)
    return {state:"existing",summary:"The café already has a purchase for this ingredient, but current stock or reconciliation is not verified."};
  }
 }
 const relevant=orders.orders.filter(o=>o.status==="approved_for_ordering"&&o.lines.some(l=>l.ingredientId===ingredientId));
 // Multiple outstanding own orders must not be ignored in favor of a completed order.
 const incoming=relevant.find(o=>o.receivingEvidence!=="complete_verified")??relevant[0];
 if(incoming){
  const [communications,reconciliation]=await Promise.all([
   readSupplierOrderCommunications(db,scope.businessId,scope.ownerUserId,[incoming.id]),
   readSupplierReconciliation(db,scope.businessId,scope.ownerUserId,incoming.id)
  ]);
  const communication=communications[0];
  if(!communication)return {state:"missing"};
  const verifiedReceipt=incoming.receivingEvidence==="partial_verified";
  if(incoming.receivingEvidence==="complete_verified"){
   const lastReceipt=reconciliation.reconciliation?.receipts.map(r=>r.receivedOn).sort().at(-1);
   const freshCount=projectInventoryEvidence(stock.rows,100).rows.some(r=>r.source==="app"&&r.ingredient_id===ingredientId&&r.quantity!==null&&r.quantity_unit===incoming.lines.find(l=>l.ingredientId===ingredientId)?.baseUnit&&lastReceipt&&String(r.source_as_of).slice(0,10)>lastReceipt);
   if(!freshCount||!reconciliation.reconciliation?.closureVerified)return {state:"existing",summary:"The existing order has verified receiving evidence. I will not assume current stock or invoice settlement.",question:!freshCount?"Please record a new physical count after the delivery.": "Please review the outstanding receipt and invoice reconciliation."};
  }
  if(incoming.receivingEvidence!=="complete_verified"){
  const summary=verifiedReceipt?"The existing order has verified partial receipts; I will continue checking the remaining quantities.":
   communication.providerVerified?"The supplier email has a verified provider receipt; delivery is not verified.":
   "An approved purchase order already exists. I will not create another order or assume delivery.";
  if(communication.state==="prepared"){
   const saved=await db.from("purchase_order_dispatches").select("proposal_id,po_revision").eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).eq("purchase_order_id",incoming.id).eq("state","prepared").maybeSingle();
   if(saved.error)throw Error("vendor_order_status_unavailable");
   if(saved.data?.proposal_id&&saved.data.po_revision===incoming.revision){
    const matching=await readOwnerProposals(db,scope,{id:saved.data.proposal_id,threadId:scope.threadId,statuses:["draft"],limit:1});
    if(matching.length===1)return {state:"existing",emailProposalId:matching[0].id,summary:"The saved supplier email draft is ready for separate owner approval. No send is verified."};
   }
  }
  if(communication.state==="not_prepared"&&communication.ownerReportedOutcome!=="supplier_accepted"&&communication.ownerReportedOutcome!=="supplier_declined"&&communication.contactVerified&&communication.channel==="gmail"){
   await assertClaim();
   try{
    const prepared=await proposeApprovedSupplierEmail(scope,incoming.id,proposalRequestKey(episodeId,"stock-vendor-email:"+incoming.id+":"+incoming.revision));
    return {state:"existing",emailProposalId:prepared.proposalId,summary:"The existing approved purchase order has a separate supplier-email draft for your approval. It has not been sent."};
   }catch(error){
    if(error instanceof VendorOrderOwnerInputRequired)return {state:"existing",summary,question:error.question.slice(0,200)};
    throw error;
   }
  }
  return {state:"existing",summary,question:communication.ownerQuestion?.slice(0,200)??(reconciliation.missing.length||!reconciliation.reconciliation?.closureVerified?"Can you provide the missing receipt or invoice evidence for the existing purchase order?":undefined)};
  }
 }
 const item=evidence.ingredients.find(i=>i.id===ingredientId),u=usage.rows.find(r=>r.ingredientId===ingredientId);
 const counted=projectInventoryEvidence(stock.rows,100).rows.filter(r=>r.source==="app"&&r.ingredient_id===ingredientId&&r.quantity!==null&&r.quantity_unit===item?.base_unit).sort((a,b)=>String(b.source_as_of).localeCompare(String(a.source_as_of)))[0];
 if(!item||!u||!counted||counted.quantity===null||usage.provenance.coverage!=="complete"||u.expected===null||u.unit!==item.base_unit||u.missing.some(m=>/sales|recipe|modifier|unmapped/i.test(m)))return {state:"missing"};
 const qty=(u.expected/7)-counted.quantity;
 if(!Number.isFinite(qty)||qty<=0)return {state:"missing"};
 const input=supplierPurchaseInputSchema.safeParse({items:[{itemName:item.name,ingredientId,quantity:qty,unit:item.base_unit}],neededBy:date(today,1),preferredSupplier:null});
 if(!input.success)return {state:"missing"};
 const plan=await investigateSupplierPurchase(scope,input.data);
 if(!plan.offers.length)return {state:"missing"};
 await assertClaim();
 const [{supervisorLoopRegistry},{SupabaseLoopRepository}]=await Promise.all([import("@/lib/ai/supervisor/loop/priceExperiment.server"),import("@/lib/ai/supervisor/loop/supabase.server")]);
 // Stable for this source episode; retry cannot create another draft.
 const key=proposalRequestKey(episodeId,"stock-purchase:"+ingredientId);
 // Retain the shared proposal repository and canonical effect simulation.
 // The insert trigger consumes the transient lease token before storage.
 const repository=new SupabaseLoopRepository();
 const create=repository.create.bind(repository);
 repository.create=(owner:OwnerLoopScope,requestKey:string,proposal:LoopCreate)=>create(owner,requestKey,{
  ...proposal,baseline:{...proposal.baseline,proactiveStock:{sourceId,episodeId,ingredientId,leaseToken,checkedAt}},
 });
 try{
  const draft=await proposeLoop(scope,supervisorLoopRegistry,repository,supplierPurchaseOrderCapabilityId,input.data,key);
  return draft.status==="draft"?{state:"draft",proposalId:draft.id}:{state:"existing"};
 }catch(error){
  const cause=error instanceof Error?error.cause:null;
  if(cause&&typeof cause==="object"&&"message" in cause&&cause.message==="proactive_stock_order_overlap")
   return {state:"existing",summary:"An existing café purchase or draft covers this ingredient. I will not prepare a duplicate."};
  throw error;
 }
}
