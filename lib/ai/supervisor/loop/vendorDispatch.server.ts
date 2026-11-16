import "server-only";
import {z} from "zod";
import type {OwnerLoopScope} from "./engine";
import {proposeLoop} from "./engine";
import {SupabaseLoopRepository} from "./supabase.server";
import {supervisorLoopRegistry} from "./priceExperiment.server";
import {gmailCapabilityId,gmailEffectInput} from "./gmail.server";
import {simulationOwnerReader} from "./simulationOwner.server";
import {getConnectorAccount,allowsGmail} from "@/lib/connectors/registry.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {buildVendorOrderEmail} from "@/lib/purchasing/vendorDispatch";

export const vendorOrderSendInputSchema=z.strictObject({purchaseOrderId:z.uuid()});
export class VendorOrderOwnerInputRequired extends Error{
 constructor(readonly reason:string,readonly question:string){
   super(reason);this.name="VendorOrderOwnerInputRequired";
 }
}
const ask=(reason:string,question:string):never=>{
 throw new VendorOrderOwnerInputRequired(reason,question);
};
/** The only Task14C proposal writer. It reuses the ordinary owner-click Gmail
 * capability and connector; the PO/recipient link is recorded before showing
 * its approval card. A model never supplies a recipient or an approved total. */
export async function proposeApprovedSupplierEmail(scope:OwnerLoopScope,
 orderId:string,requestKey:string){
 const {client}=await simulationOwnerReader(scope);
 const order=await client.from("purchase_orders").select(
  "id,business_id,owner_user_id,supplier_id,supplier_name_snapshot,status,revision,effect_hash,currency_code,subtotal_cents,needed_by"
 ).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
  .eq("id",orderId).maybeSingle();
 if(order.error)throw new Error("vendor_order_source_unavailable");
 const po=order.data??ask("supplier_order_missing",
   "I cannot find that approved purchase order for this café. Which order did you mean?");
 if(po.status!=="approved_for_ordering")
   ask("supplier_order_not_open","This purchase order is no longer approved for ordering. Should we prepare a new order?");
 const [lines,contacts,existing,account]=await Promise.all([
  client.from("purchase_order_lines").select(
    "item_name_snapshot,packs,pack_quantity,pack_unit,subtotal_cents,ordinal"
  ).eq("business_id",scope.businessId).eq("purchase_order_id",po.id)
   .order("ordinal",{ascending:true}).limit(11),
  client.from("cafe_supplier_order_contacts").select("id,channel,email,verified_at,revoked_at,owner_user_id")
   .eq("business_id",scope.businessId).eq("supplier_id",po.supplier_id)
   .eq("owner_user_id",scope.ownerUserId).maybeSingle(),
  client.from("purchase_order_dispatches").select("id,proposal_id,state")
   .eq("business_id",scope.businessId).eq("purchase_order_id",po.id).maybeSingle(),
  getConnectorAccount({businessId:scope.businessId,ownerUserId:scope.ownerUserId})
   .catch(()=>ask("gmail_status_unavailable",
      "I could not check the Gmail connection right now. Did you communicate with this supplier in Gmail, by phone, or by portal? Please tell me how and whether the order was accepted.")),
 ]);
 if(lines.error||contacts.error||existing.error)throw new Error("vendor_order_evidence_unavailable");
 if(existing.data)ask("supplier_order_already_prepared",
   "There is already a saved send attempt or approval for this order. Please review its status before doing anything else; I will not send it twice.");
 const contact=contacts.data??ask("supplier_channel_unknown",
   "I could not verify how you normally contact this supplier. Do you use Gmail, phone, a supplier portal or another way? Please confirm the supplier's ordering address or tell me the channel.");
 if(contact.revoked_at||!contact.verified_at)
   ask("supplier_channel_unknown",
     "The saved supplier contact is not currently verified. Which Gmail, phone, portal or other channel do you use? Please confirm the ordering contact.");
 if(contact.channel!=="gmail"||!contact.email)
   ask("supplier_uses_other_channel",
     "You told us this supplier uses "+contact.channel+". Is an order already in progress there? Please tell me whom you contacted and what they confirmed. I cannot place a portal or phone order without an approved connector.");
 const gmailAccount=account??ask("gmail_not_connected",
   "I cannot find a Gmail connection for this café. Do you use Gmail, phone or a supplier portal to contact this supplier?");
 if(gmailAccount.status!=="active")
   ask("gmail_not_connected",
     "I cannot use an active Gmail connection for this café. Do you want to connect Gmail, or do you contact this supplier another way?");
 if(!allowsGmail(gmailAccount,"send"))
   ask("gmail_send_permission_missing",
     "Gmail is connected but sending is not authorized. Would you like to enable send permission, or handle this supplier through another channel?");
 if(lines.data?.length===0||(lines.data?.length??0)>10)
   throw new Error("vendor_order_lines_unavailable");
 const {subject,body}=buildVendorOrderEmail({
   id:po.id,supplierName:po.supplier_name_snapshot,currency:po.currency_code,
   subtotalCents:po.subtotal_cents,neededBy:po.needed_by,
   lines:(lines.data??[]).map(l=>({
     itemName:l.item_name_snapshot,packs:l.packs,packQuantity:l.pack_quantity,
     packUnit:l.pack_unit,lineSubtotalCents:l.subtotal_cents
   }))
 });
 const input=gmailEffectInput.parse({
   operation:"send",action:null,to:[contact.email],cc:[],bcc:[],
   subject,body,messageId:null,threadId:null,labelId:null,labelName:null
 });
 const repo=new SupabaseLoopRepository();
 const proposal=await proposeLoop(scope,supervisorLoopRegistry,repo,gmailCapabilityId,input,requestKey);
 if(proposal.status!=="draft")throw new Error("supplier_gmail_approval_not_draft");
 const db=createAdminSupabaseClient();
 const saved=await db.from("purchase_order_dispatches").insert({
   business_id:scope.businessId,purchase_order_id:po.id,owner_user_id:scope.ownerUserId,
   contact_id:contact.id,proposal_id:proposal.id,po_revision:po.revision,
   po_effect_hash:po.effect_hash,recipient_email:contact.email,state:"prepared"
 }).select("id,proposal_id").maybeSingle();
 if(saved.error||!saved.data){
   const prior=await db.from("purchase_order_dispatches").select("proposal_id")
     .eq("business_id",scope.businessId).eq("purchase_order_id",po.id).maybeSingle();
   if(prior.error||prior.data?.proposal_id!==proposal.id){
     // Orphan Gmail draft: reject it, never return an actionable approval card.
     await repo.transition(scope,proposal.id,proposal.revision,"reject").catch(()=>{});
     ask("supplier_order_already_prepared",
       "The order could already have a prepared or uncertain vendor message. I will not create another send. Please review the saved order status.");
   }
 }
 return {proposalId:proposal.id,revision:proposal.revision,
   purchaseOrderId:po.id,supplierName:po.supplier_name_snapshot,
   recipient:contact.email,account:gmailAccount.email,
   note:"Gmail will be sent ONLY after a separate owner click. Supplier acceptance is not yet verified."};
}
