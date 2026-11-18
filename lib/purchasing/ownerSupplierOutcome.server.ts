import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";

export const supplierOutcomeInput=z.strictObject({
 purchaseOrderId:z.uuid(),
 channel:z.enum(["gmail","phone","portal","in_person","other"]),
 outcome:z.enum(["unknown","not_contacted","supplier_contacted",
   "supplier_acknowledged","supplier_accepted","supplier_declined"]),
 note:z.string().trim().min(1).max(1000)
});
// The model does NOT author source attribution. The authenticated turn
// supplies the exact current owner text as note on the trusted server.
export const ownerSupplierOutcomeToolInput=supplierOutcomeInput.omit({note:true});
export type SupplierOutcomeInput=z.infer<typeof supplierOutcomeInput>;
export type SupplierOutcomeScope={businessId:string;ownerUserId:string};
export type SupplierOwnerReport={
 reportId:string;reportedAt:string;alreadyRecorded:boolean;
 source:"owner_reported";providerVerified:false;outcome:SupplierOutcomeInput["outcome"]
};

/** Single canonical writer for the authenticated Operations screen and an
 * owner-sourced Supervisor report. Never upgrades a Gmail transport receipt.
 * The RLS-protected PO and report tables additionally enforce this scope. */
export async function recordOwnerSupplierOutcome(db:SupabaseClient,
 scope:SupplierOutcomeScope,raw:SupplierOutcomeInput):Promise<SupplierOwnerReport>{
 const input=supplierOutcomeInput.parse(raw);
 const order=await db.from("purchase_orders").select("id,status")
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .eq("id",input.purchaseOrderId).maybeSingle();
 if(order.error)throw new Error("supplier_order_status_unavailable");
 if(!order.data)throw new Error("supplier_order_not_found");
 // Accepted/declined reports are terminal owner observations, not editable
 // model memory. Prevent a later ambiguous chat answer from reversing one.
 const terminal=await db.from("purchase_order_channel_reports")
   .select("id,outcome,channel,note,reported_at")
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .eq("purchase_order_id",input.purchaseOrderId)
   .in("outcome",["supplier_accepted","supplier_declined"])
   .order("reported_at",{ascending:false}).limit(1);
 if(terminal.error)throw new Error("supplier_report_status_unavailable");
 const prior=terminal.data?.[0];
 if(prior){
   if(prior.outcome===input.outcome&&prior.channel===input.channel&&prior.note===input.note)
     return {reportId:prior.id,reportedAt:prior.reported_at,alreadyRecorded:true,
       source:"owner_reported",providerVerified:false,outcome:input.outcome};
   throw new Error("supplier_terminal_report_requires_owner_review");
 }
 const saved=await db.from("purchase_order_channel_reports").insert({
   business_id:scope.businessId,owner_user_id:scope.ownerUserId,
   purchase_order_id:input.purchaseOrderId,channel:input.channel,
   outcome:input.outcome,note:input.note
 }).select("id,reported_at").single();
 if(saved.error||!saved.data)throw new Error("supplier_report_save_failed");
 return {reportId:saved.data.id,reportedAt:saved.data.reported_at,
   alreadyRecorded:false,source:"owner_reported",providerVerified:false,outcome:input.outcome};
}

/** Normal authenticated browser/WhatsApp owner messages run through a
 * durable AgentJob. A job is evidence of provenance if (and only if) its
 * owner-message and thread match the persisted owner text; it is NOT an
 * automatic reason to deny an otherwise authorized owner report. */
export function authenticatedSupplierOwnerTurn(input:{
 owner:{id:string;role:string;text?:string|null};
 ownerText:string;threadId:string;
 job:{ownerMessageId:string;threadId:string;status:string}|null;
}):boolean{
 const text=input.ownerText.trim();
 return input.owner.role==="owner"&&text.length>0&&
   input.owner.text?.trim()===text&&
   (!input.job||(input.job.status==="running"&&
     input.job.ownerMessageId===input.owner.id&&
     input.job.threadId===input.threadId));
}

/** Never assign a statement covering multiple POs to a model-selected
 * target. An owner can report one canonical purchase order per message.
 * A message with no UUID requires independent single-PO verification. */
export function explicitSingleOwnerPurchaseOrder(text:string,targetId:string):boolean|null{
 const found=[...new Set((text.match(
   /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi)??[])
   .map(v=>v.toLowerCase()))];
 if(found.length>1)return false;
 if(found.length===1)return found[0]===targetId.toLowerCase();
 return null;
}

/** A free-text turn can record a supplier outcome only when the owner
 * explicitly supplied the source statement in THIS authenticated message.
 * Conservative failures ask for clarification; never infer supplier acceptance
 * from a Gmail sent receipt, an assistant claim, or a prior owner message. */
/** A source channel is owner evidence too, never a model-selected default. */
export function explicitOwnerSupplierChannel(text:string,channel:SupplierOutcomeInput["channel"]):boolean{
 const signals:Record<SupplierOutcomeInput["channel"],RegExp>={
   phone:/\b(?:phone|called|telephone|call with|by call)\b/i,
   portal:/\b(?:portal|supplier website|vendor site)\b/i,
   gmail:/\b(?:gmail|email|e-mail|emailed)\b/i,
   in_person:/\b(?:in person|face to face|at the supplier|met with)\b/i,
   other:/\b(?:whatsapp|text message|sms|other channel|other way)\b/i
 };
 return signals[channel].test(text);
}
export function explicitOwnerSupplierOutcome(text:string,outcome:SupplierOutcomeInput["outcome"]):boolean{
 // Normalize Unicode smart quotes and full-width apostrophes before
 // checking a source report. "hasn’t accepted" must never become accepted.
 const t=text.trim().toLowerCase().normalize("NFKC")
   .replace(/[\u2018\u2019\u02bc\uff07]/g,"'").replace(/\s+/g," ");
 const patterns:Record<SupplierOutcomeInput["outcome"],RegExp>={
   supplier_accepted:/\b(?:accepted|accepts|agreed to fulfill|agreed to supply)\b/i,
   supplier_declined:/\b(?:declin(?:ed|es)?|reject(?:ed|s)?|refus(?:ed|es)?)\b/i,
   supplier_acknowledged:/\b(?:acknowledg(?:ed|es)?|confirm(?:ed|s)? receipt)\b/i,
   supplier_contacted:/\b(?:contact(?:ed)?|call(?:ed)?|email(?:ed)?|messag(?:ed)?)\b/i,
   not_contacted:/\b(?:not contacted|haven't contacted|didn't contact|never contacted)\b/i,
   unknown:/\b(?:unknown|not sure|don't know|uncertain)\b/i,
 };
 if(!patterns[outcome].test(t))return false;
 if((outcome==="supplier_accepted"||outcome==="supplier_declined")&&
   !/\b(?:supplier|vendor|purchase order|po)\b/i.test(t))return false;
 if((outcome==="supplier_accepted"||outcome==="supplier_declined")&&
   /\?/.test(t))return false;
 // A single message containing incompatible terminal assertions needs an
 // owner clarification before any one-way terminal SQL report is written.
 if((outcome==="supplier_accepted"||outcome==="supplier_declined")&&
   /\b(?:accepted|accepts|agreed to fulfill|agreed to supply)\b/i.test(t)&&
   /\b(?:declin(?:ed|es)?|reject(?:ed|s)?|refus(?:ed|es)?)\b/i.test(t))
   return false;
 // Negated, hypothetical, and unresolved statements are not terminal
 // owner assertions. Fail closed instead of making an irreversible report.
 const uncertain=/\b(?:not|never|no|didn't|doesn't|hasn't|haven't|wasn't|isn't|won't|wouldn't|can't|cannot|don't know|not sure|maybe|perhaps|might|may|possibly|pending|awaiting|uncertain|unconfirmed)\b.{0,75}\b(?:accepted|accepts|agreed|declined|reject(?:ed|s)?|refus(?:ed|es)?)\b/i;
 if((outcome==="supplier_accepted"||outcome==="supplier_declined")&&uncertain.test(t))
   return false;
 return true;
}
