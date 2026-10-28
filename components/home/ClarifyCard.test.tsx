import {describe,it,expect,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ClarifyCard,{pricingOtherResponse} from "./ClarifyCard";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {clarifyCardState} from "./supervisorChatBehavior";
import type {ConversationMessage} from "@/lib/ai/conversations/contracts";
const block={type:"clarify" as const,question:"Which Latte?",options:[
 {label:"Latte — Hot",value:"11111111-1111-4111-8111-111111111111"},
 {label:"Latte — Iced",value:"22222222-2222-4222-8222-222222222222"}],allowOther:true};
const copy={pricingLaborPrefix:"Monthly labor",pricingBillsPrefix:"Monthly bills",clarifyOther:"Other…",clarifySend:"Send",clarifyYouChose:"You chose: {choice}",clarifySkipped:"Skipped",clarifyOtherPlaceholder:"Your answer",clarifyFillError:"Enter a valid number",clarifyCountSummary:"Count: {item} {amount} {unit}",clarifyPurchaseSummary:"I purchased {amount} {unit} of {item} on {date}. Please draft a purchase proposal for my approval; do not save stock yet."};
const msg=(role:"owner"|"supervisor",id:string,text:string|null,blocks:unknown[]|null=null):ConversationMessage=>({
 role,id,text,blocks,threadId:"thread",contentType:blocks?"blocks":"text",createdAt:"2026-10-24",grounding:null,clientMessageId:null
});
describe("clarify choice card",()=>{
 it("keeps localized labels on typed amounts",()=>{
  for(const c of [en.SupervisorChat,es.SupervisorChat,ar.SupervisorChat]){
   expect(pricingOtherResponse("13,000",[{value:"labor-monthly"}],c)).toBe(c.pricingLaborPrefix+": 13,000");
   expect(pricingOtherResponse("8,360",[{value:"bills-monthly"}],c)).toBe(c.pricingBillsPrefix+": 8,360");
  }
 });
 it("renders 48px full-width options and RTL in Arabic",()=>{
  const markup=renderToStaticMarkup(createElement(ClarifyCard,{block,locale:"ar",copy,
   state:"active",choice:null,disabled:false,onSend:vi.fn()}));
  expect(markup).toContain('dir="rtl"');
  expect(markup).toContain("min-h-12");
  expect(markup).toContain("w-full");
  expect(markup).toContain("Latte — Iced");
 });
 it("collapses for the next matching owner reply without actionable buttons",()=>{
  const history=[msg("supervisor","a","Which Latte?",[block]),msg("owner","b","Latte — Iced")];
  expect(clarifyCardState(history,0)).toEqual({state:"chosen",choice:"Latte — Iced"});
  const markup=renderToStaticMarkup(createElement(ClarifyCard,{block,locale:"en",copy,
   state:"chosen",choice:"Latte — Iced",disabled:false,onSend:vi.fn()}));
  expect(markup).toContain("You chose: Latte — Iced");
  expect(markup).not.toContain("<button");
 });
 it("dismisses after a different follow-up and older cards",()=>{
  expect(clarifyCardState([msg("supervisor","a",null,[block]),msg("owner","b","what were sales today?")],0).state).toBe("skipped");
  expect(clarifyCardState([msg("supervisor","a",null,[block]),msg("supervisor","b",null)],0).state).toBe("skipped");
 });
});
