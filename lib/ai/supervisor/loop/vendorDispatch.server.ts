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
 const [lines,contacts,existing,terminalReports,account]=await Promise.all([
  client.from("purchase_order_lines").select(
    "item_name_snapshot,packs,pack_quantity,pack_unit,subtotal_cents,ordinal"
  ).eq("business_id",scope.businessId).eq("purchase_order_id",po.id)
   .order("ordinal",{ascending:true}).limit(11),
  client.from("cafe_supplier_order_contacts").select("id,channel,email,verified_at,revoked_at,owner_user_id")
   .eq("business_id",scope.businessId).eq("supplier_id",po.supplier_id)
   .eq("owner_user_id",scope.ownerUserId).maybeSingle(),
  client.from("purchase_order_dispatches").select("id,proposal_id,state,contact_id,recipient_email,po_revision,po_effect_hash")
   .eq("business_id",scope.businessId).eq("purchase_order_id",po.id).maybeSingle(),
  client.from("purchase_order_channel_reports").select("outcome")
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .eq("purchase_order_id",po.id)
   .in("outcome",["supplier_accepted","supplier_declined"]).limit(1),
  getConnectorAccount({businessId:scope.businessId,ownerUserId:scope.ownerUserId})
   .catch(()=>ask("gmail_status_unavailable",
      "I could not check the Gmail connection right now. Did you communicate with this supplier in Gmail, by phone, or by portal? Please tell me how and whether the order was accepted.")),
 ]);
 if(lines.error||contacts.error||existing.error||terminalReports.error)
   throw new Error("vendor_order_evidence_unavailable");
 if(terminalReports.data?.length){
   const accepted=terminalReports.data[0].outcome==="supplier_accepted";
   ask("supplier_order_already_resolved",
     accepted?"You already reported that this supplier accepted this purchase order. I will not prepare another supplier send. If that report was mistaken, tell me so we can review the order.":
     "You already reported that this supplier declined this purchase order. I will not prepare another send for the same order. Should we review a new one?");
 }
 // A PREPARED draft has never been authorized or reserved for provider send.
 // The secure SQL replacement below may retire it after a NEW owner request.
 // Reserved/uncertain/accepted sends are never replaced or retried.
 if(existing.data&&existing.data.state!=="prepared")
   ask("supplier_order_already_prepared",
     "There is already a reserved or accepted supplier send for this PO. Please review the saved receipt before doing anything else; I will not send it twice.");
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
 const rebind=async()=>{
   // PostgreSQL row locks make the old draft rejection and the new recipient
   // binding atomic. A competing owner click either wins (and we do NOT
   // rebind) or loses (the old card is rejected before the click executes).
   const result=await db.rpc("supervisor_rebind_supplier_gmail_draft",{
     p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
     p_purchase_order_id:po.id,p_new_proposal_id:proposal.id
   });
   return !result.error&&result.data===true;
 };
 let linked=false;
 if(existing.data){
   linked=await rebind();
 }else{
   const saved=await db.from("purchase_order_dispatches").insert({
     business_id:scope.businessId,purchase_order_id:po.id,owner_user_id:scope.ownerUserId,
     contact_id:contact.id,proposal_id:proposal.id,po_revision:po.revision,
     po_effect_hash:po.effect_hash,recipient_email:contact.email,state:"prepared"
   }).select("id,proposal_id").maybeSingle();
   if(!saved.error&&saved.data?.proposal_id===proposal.id){
     linked=true;
   }else{
     // Another owner turn may have prepared the same PO concurrently.
     // The RPC is the ONLY allowed replacement and refuses any send attempt.
     linked=await rebind();
   }
 }
 if(!linked){
   // A failed rebind is not evidence of non-delivery. Never make another
   // proposal actionable when an attempted send may already be uncertain.
   if(!existing.data||existing.data.proposal_id!==proposal.id)
     await repo.transition(scope,proposal.id,proposal.revision,"reject").catch(()=>{});
   ask("supplier_order_send_state_unverified",
     "I cannot safely replace the prior supplier email. It may already have an authorized or uncertain send. Please review its receipt and tell me whether the supplier was contacted; I will not resend.");
 }
 return {proposalId:proposal.id,revision:proposal.revision,
   purchaseOrderId:po.id,supplierName:po.supplier_name_snapshot,
   recipient:contact.email,account:gmailAccount.email,
   note:"Gmail will be sent ONLY after a separate owner click. Supplier acceptance is not yet verified."};
}
