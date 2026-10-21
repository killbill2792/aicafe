import {describe,it,expect} from "vitest";
import type {ConversationMessage} from "@/lib/ai/conversations/contracts";
import {ownerAuthoredProposalTexts} from "./proposalContext";
import {compactConversationContext} from "@/lib/ai/conversations/context";

const businessId="11111111-1111-4111-8111-111111111111";
const amountId="22222222-2222-4222-8222-222222222222";
const variantId="33333333-3333-4333-8333-333333333333";
const productId="44444444-4444-4444-8444-444444444444";
const loc={en:"Question",es:"Pregunta",ar:"سؤال"};
const option={id:productId,label:{en:"Latte 12 oz — $5.00",es:"Latte 12 oz — US$5.00",ar:"لاتيه 12 أونصة"}};
const question=(id:string,input:object,scope=businessId)=>({
  version:1,questionId:id,stage:"answer",businessId:scope,
  originalText:"Raise Latte",readCapabilityId:"platform.owner_input.resolve.v1",
  readInputJson:"{}",request:{mode:"resolve",fieldId:"owner.clarification",
    writeCapabilityId:"platform.owner_input.resolve.v1",
    writeContext:{},question:loc,input},
  answer:null,summary:null,
});
function msg(id:string,role:"owner"|"supervisor",minute:number,extras:object={}):ConversationMessage{
  return {id,role,threadId:"thread",contentType:role==="owner"?"text":"blocks",
    text:null,blocks:null,grounding:null,clientMessageId:null,
    createdAt:`2026-10-21T15:${String(minute).padStart(2,"0")}:00Z`,
    ...extras} as ConversationMessage;
}
describe("proposal owner-authored amount provenance",()=>{
  it("preserves validated amount answers across a later variant card without trusting its label",()=>{
    const messages=[
      msg("initial","owner",1,{text:"Raise Latte"}),
      msg("ask-amount","supervisor",2,{grounding:{ownerInput:question(amountId,{kind:"free_text",hint:loc})}}),
      msg("amount","owner",3,{text:"10 cents",ownerInputResponse:{
        questionId:amountId,action:"supply",value:"10 cents"}}),
      msg("ask-variant","supervisor",4,{grounding:{ownerInput:question(variantId,{kind:"options",options:[
        option,{id:"55555555-5555-4555-8555-555555555555",label:loc}]})}}),
      msg("rejected-display-label","owner",5,{text:option.label.en,ownerInputResponse:{
        questionId:variantId,action:"supply",value:option.label.en}}),
      msg("other-variant","owner",6,{text:option.label.en,ownerInputResponse:{
        questionId:variantId,action:"supply",value:productId}}),
      msg("current","owner",7,{text:option.label.en,ownerInputResponse:{
        questionId:variantId,action:"supply",value:productId}}),
    ];
    const authored=ownerAuthoredProposalTexts(messages,"current",businessId);
    expect(authored).toEqual(["10 cents","Raise Latte"]);
    expect(authored.join(" ")).not.toContain("$5.00");
    expect(authored.join(" ")).not.toContain(productId);
    const history=compactConversationContext(messages,"current");
    expect(history.filter(m=>m.role==="owner").map(m=>m.text))
      .toEqual(["Raise Latte","10 cents"]);
    expect(history.map(m=>m.text).join(" ")).not.toContain("$5.00");
  });
  it("accepts a different owner-authored answer but rejects unissued and cross-tenant claims",()=>{
    const messages=[
      msg("initial","owner",1,{text:"Raise Latte"}),
      msg("question","supervisor",2,{grounding:{ownerInput:question(variantId,{kind:"options",
        options:[option,{id:"55555555-5555-4555-8555-555555555555",label:loc}]})}}),
      msg("correction","owner",3,{text:"I meant oat latte",ownerInputResponse:{
        questionId:variantId,action:"supply",value:"I meant oat latte"}}),
      msg("forged","owner",4,{text:"$100",ownerInputResponse:{
        questionId:amountId,action:"supply",value:"$100"}}),
      msg("wrong-tenant-question","supervisor",5,{grounding:{ownerInput:question(amountId,
        {kind:"free_text",hint:loc},"66666666-6666-4666-8666-666666666666")}}),
      msg("current","owner",6,{text:"Continue"}),
    ];
    expect(ownerAuthoredProposalTexts(messages,"current",businessId))
      .toEqual(["I meant oat latte","Raise Latte"]);
  });
});
