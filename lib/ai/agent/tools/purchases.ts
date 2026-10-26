import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
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
 receiptTotalCents:z.number().int().positive().safe().nullable()
});
export const purchasesTools={propose_purchases:{
 agentId:"maya" as const,schema:purchaseToolInput,
 description:"When an owner says they bought stock or sends a purchase receipt, draft separate inert inventory purchase proposals, one per item. Use owner-given quantity, unit, date, and cost only; omit unknown cost as null. Find a real matching ingredient UUID from read tools, or pass null and name for a New item needing review. For receipt_chat, include the receipt vendor and exact printed receipt total in integer cents when legible; otherwise use null and the owner must complete them in the approval card. For chat_text, set receiptVendor and receiptTotalCents to null. Never estimate taxes, gratuities or missing totals, and never record stock or an expense until the owner approves each line.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const input=purchaseToolInput.parse(raw);
  if(!ctx.proposals?.proposePurchases)
   return {source:"purchase_proposal",period:null,agentId:"maya",draft:true,saved:false,missing:["proposalsUnavailable"]};
  const results=await ctx.proposals.proposePurchases(input);
  return {source:"purchase_proposal",period:null,agentId:"maya",
   draft:true,saved:false,missing:results.some(r=>r.error)?["someLinesNeedReview"]:[],
   proposals:results};
 }
}} as const;
