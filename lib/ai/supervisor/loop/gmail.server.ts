import "server-only";
import {z} from "zod";
import {getConnectorAccount,assertGmailCapability} from "@/lib/connectors/registry.server";
import {performGmailEffect,type GmailEffect} from "@/lib/connectors/gmail/provider.server";
import {registerLoopCapability,effectHash} from "./engine";

export const gmailCapabilityId="alex.gmail_effect.v1";
export const gmailOperation=z.enum(["send","draft","modify","trash","restore","create_label"]);
export const gmailAction=z.enum(["mark_read","mark_unread","star","unstar","archive","unarchive","add_label","remove_label"]);
export const gmailEffectInput=z.strictObject({
  operation:gmailOperation,
  action:gmailAction.nullable(),
  to:z.array(z.email()).max(12),
  cc:z.array(z.email()).max(12),
  bcc:z.array(z.email()).max(12),
  subject:z.string().max(300),
  body:z.string().max(12000),
  messageId:z.string().max(120).nullable(),
  threadId:z.string().max(120).nullable(),
  labelId:z.string().max(200).nullable(),
  labelName:z.string().max(160).nullable(),
});
export const gmailEffectSchema=gmailEffectInput.extend({
  accountId:z.uuid(),generation:z.number().int().positive(),
  from:z.email(),
});
export type GmailProposalInput=z.infer<typeof gmailEffectInput>;
function validate(input:GmailProposalInput){
  // A non-modify effect must never smuggle a different action into the preview.
  if(input.operation!=="modify"&&input.action!==null)
    throw new Error("gmail_action_operation_mismatch");
  if((input.operation==="send"||input.operation==="draft")&&
    (input.operation==="send"&&!input.to.length||!input.subject.trim()||!input.body.trim()))
    throw new Error("gmail_message_details_required");
  if(["modify","trash","restore"].includes(input.operation)&&
    (!input.messageId||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.messageId)))
    throw new Error("gmail_message_required");
  if(input.operation==="modify"&&(!input.action||
    ["add_label","remove_label"].includes(input.action)&&!input.labelId))
    throw new Error("gmail_modify_details_required");
  if(input.operation==="create_label"&&!input.labelName?.trim())
    throw new Error("gmail_label_name_required");
}
export const gmailCapability=registerLoopCapability({
  id:gmailCapabilityId,version:1,inputSchema:gmailEffectInput,effectSchema:gmailEffectSchema,
  proposalDescription:"Prepare an inert Gmail owner approval card only on a clear owner request. Never send, alter or create a Gmail draft without the exact owner click. Read the connected Gmail account and selected original message first. Do not invent recipients or the mail body.",
  dependencyScope:(e)=>({gmailAccount:e.accountId,operation:e.operation,
    messageId:e.messageId,hash:effectHash(e)}),
  simulate:async(scope,input)=>{
    validate(input);
    const owner={businessId:scope.businessId,ownerUserId:scope.ownerUserId};
    const account=await getConnectorAccount(owner);
    assertGmailCapability(account,input.operation==="send"?"send":input.operation==="draft"?"draft":"organize");
    const effect={...input,accountId:account.id,generation:account.generation,from:account.email};
    return {effect,baseline:{source:"gmail",account:account.email,
      preview:[{field:"account",label:"Gmail account",before:null,after:{kind:"text",text:account.email}}]},
      monitorSpec:{durationDays:1,metricScope:"gmail_provider_receipt"}};
  },
  commit:async(scope,effect,proposalId)=>{
    if(!proposalId)throw new Error("gmail_proposal_id_required");
    await performGmailEffect({businessId:scope.businessId,ownerUserId:scope.ownerUserId},
      effect as GmailEffect,proposalId,effectHash(effect));
    return {status:"verified",evidenceSource:"gmail_provider_receipt"};
  },
  monitor:async()=>null,
  report:async()=>({status:"complete",result:{provider:"gmail",delivery:"not_guaranteed"},recommendation:"keep",source:"gmail_provider_receipt"}),
});
