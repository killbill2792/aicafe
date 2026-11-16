import {z} from "zod";
import {authenticatedConversationContext,ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson,parseInput,readBoundedJson,requireSameOrigin}
 from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";

export const runtime="nodejs";export const dynamic="force-dynamic";
const uuid=z.uuid();
const channel=z.enum(["gmail","phone","portal","in_person","other"]);
const input=z.discriminatedUnion("action",[
 z.strictObject({action:z.literal("verify_contact"),supplierId:uuid,
   channel,email:z.email().max(320).nullable(),details:z.string().trim().max(600).nullable()}),
 z.strictObject({action:z.literal("revoke_contact"),supplierId:uuid}),
 z.strictObject({action:z.literal("report_outcome"),purchaseOrderId:uuid,channel,
   outcome:z.enum(["unknown","not_contacted","supplier_contacted","supplier_acknowledged",
     "supplier_accepted","supplier_declined"]),note:z.string().trim().min(1).max(1000)}),
]);
const contactColumns="id,supplier_id,channel,email,details,verified_at,revoked_at";
export async function GET(){
 try{
  const {scope}=await authenticatedConversationContext();
  const db=await createServerSupabaseClient();
  const [suppliers,contacts,orders]=await Promise.all([
   db.from("cafe_suppliers").select("id,display_name").eq("business_id",scope.businessId)
    .order("display_name").limit(150),
   db.from("cafe_supplier_order_contacts").select(contactColumns)
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).limit(150),
   db.from("purchase_orders").select("id,supplier_id,supplier_name_snapshot,status,approved_at")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .order("approved_at",{ascending:false}).limit(60),
  ]);
  if(suppliers.error||contacts.error||orders.error)throw new Error("supplier_contacts_unavailable");
  return conversationJson({
   suppliers:(suppliers.data??[]).map(s=>({id:s.id,name:s.display_name,
     contact:(contacts.data??[]).find(c=>c.supplier_id===s.id)??null})),
   orders:(orders.data??[]).map(o=>({id:o.id,supplierId:o.supplier_id,
     supplierName:o.supplier_name_snapshot,status:o.status,approvedAt:o.approved_at})),
  });
 }catch(error){return conversationError(error);}
}
export async function POST(request:Request){
 try{
  requireSameOrigin(request);
  const x=parseInput(input,await readBoundedJson(request));
  const {scope}=await authenticatedConversationContext();
  const db=await createServerSupabaseClient();
  if(x.action==="report_outcome"){
   const order=await db.from("purchase_orders").select("id,status")
     .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
     .eq("id",x.purchaseOrderId).maybeSingle();
   if(order.error)throw order.error;
   if(!order.data)throw new ConversationApiError(404,"supplier_order_not_found");
   // An owner's outside-channel report is evidence about THAT order only.
   const saved=await db.from("purchase_order_channel_reports").insert({
     business_id:scope.businessId,owner_user_id:scope.ownerUserId,
     purchase_order_id:x.purchaseOrderId,channel:x.channel,outcome:x.outcome,note:x.note
   }).select("id,reported_at").single();
   if(saved.error)throw saved.error;
   return conversationJson({saved:true,source:"owner_reported",providerVerified:false,
     reportId:saved.data.id,reportedAt:saved.data.reported_at},201);
  }
  const supplier=await db.from("cafe_suppliers").select("id")
    .eq("business_id",scope.businessId).eq("id",x.supplierId).maybeSingle();
  if(supplier.error)throw supplier.error;
  if(!supplier.data)throw new ConversationApiError(404,"supplier_not_found");
  const current=await db.from("cafe_supplier_order_contacts").select("id")
    .eq("business_id",scope.businessId).eq("supplier_id",x.supplierId)
    .eq("owner_user_id",scope.ownerUserId).maybeSingle();
  if(current.error)throw current.error;
  if(x.action==="revoke_contact"){
   if(!current.data)return conversationJson({saved:true,revoked:true});
   const revoked=await db.from("cafe_supplier_order_contacts").update({
     revoked_at:new Date().toISOString(),updated_at:new Date().toISOString()
   }).eq("id",current.data.id).eq("business_id",scope.businessId)
    .eq("owner_user_id",scope.ownerUserId).select("id").maybeSingle();
   if(revoked.error||!revoked.data)throw new Error("supplier_contact_revoke_unverified");
   return conversationJson({saved:true,revoked:true});
  }
  if((x.channel==="gmail")!==Boolean(x.email)||
    (x.channel!=="gmail"&&x.email!==null))
    throw new ConversationApiError(422,"supplier_contact_channel_mismatch");
  const payload={
   channel:x.channel,email:x.channel==="gmail"?x.email!.toLowerCase():null,
   details:x.details,verified_at:new Date().toISOString(),revoked_at:null,
   updated_at:new Date().toISOString(),
  };
  const result=current.data?
   await db.from("cafe_supplier_order_contacts").update(payload)
     .eq("id",current.data.id).eq("business_id",scope.businessId)
     .eq("owner_user_id",scope.ownerUserId).select(contactColumns).single():
   await db.from("cafe_supplier_order_contacts").insert({
     ...payload,business_id:scope.businessId,owner_user_id:scope.ownerUserId,
     supplier_id:x.supplierId
   }).select(contactColumns).single();
  if(result.error||!result.data)throw result.error??new Error("supplier_contact_save_unverified");
  return conversationJson({saved:true,source:"owner_verified",
    contact:result.data,sendApproved:false},current.data?200:201);
 }catch(error){return conversationError(error);}
}
