import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {isPurchaseCorrection} from "./purchaseIntent";
/** Parse into owner-provided quantities only. No silent new ingredient or purchase. */
export const purchaseToolLine=z.strictObject({
 ingredientId:z.uuid().nullable(),name:z.string().trim().min(1).max(160),
 quantity:z.number().finite().positive().max(1e9),
 unit:z.string().trim().min(1).max(40),
 costCents:z.number().int().nonnegative().safe().nullable(),
 date:z.iso.date()
});
export const purchaseToolInput=z.strictObject({
 lines:z.array(purchaseToolLine).min(1).max(10),
 source:z.enum(["receipt_chat","chat_text"]),
 receiptVendor:z.string().trim().min(1).max(160).nullable(),
 receiptTotalCents:z.number().int().positive().safe().nullable(),
 documentKind:z.enum(["receipt","invoice","purchase_order","unknown"]).nullable().optional()
});
export const purchasesTools={propose_purchases:{
 agentId:"maya" as const,schema:purchaseToolInput,
 description:"When an owner says they bought stock or sends a purchase receipt, prepare validated per-line inventory purchases through the existing proposal gateway. An explicitly authorized owner instruction may complete the purchase immediately; all other lines remain inert owner-review proposals. Use owner-given quantity, unit, date, and cost only; omit unknown cost as null. Find a real matching ingredient UUID from read tools, or pass null and name for a New item needing review. For receipt_chat, include the receipt vendor and exact printed receipt total in integer cents when legible; otherwise use null and the owner must complete them in the approval card. For chat_text, set receiptVendor and receiptTotalCents to null. Set documentKind to receipt only when visible source is clearly an actual shopping receipt, purchase_order for an order that is not evidence of delivery, otherwise unknown. Never estimate taxes, gratuities, units or missing totals. The server independently checks the actual owner message for direct authorization and verifies any database write; otherwise each line remains an approval proposal.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const input=purchaseToolInput.parse(raw);
  // A correction must edit/reconcile the ORIGINAL stock line, never create a
  // second additive line even when the model calls this proposal tool.
  if(isPurchaseCorrection(ctx.ownerText??""))
   return {source:"purchase_proposal",period:null,agentId:"maya",
    draft:false,saved:false,missing:["existingPurchaseCorrectionRequiresReview"],proposals:[]};
  if(!ctx.proposals?.proposePurchases)
   return {source:"purchase_proposal",period:null,agentId:"maya",draft:true,saved:false,missing:["proposalsUnavailable"]};
  const results=await ctx.proposals.proposePurchases(input);
  const saved=results.some(r=>r.saved===true);
  const needsReview=results.some(r=>r.saved!==true);
  return {source:"purchase_proposal",period:null,agentId:"maya",
   draft:needsReview,saved,missing:needsReview?["someLinesNeedReview"]:[],
   proposals:results};
 }
}} as const;
