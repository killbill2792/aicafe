import {describe,it,expect,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ClarifyCard from "./ClarifyCard";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
const copy={pricingLaborPrefix:"",pricingBillsPrefix:"",clarifyOther:"Other",clarifySend:"Send",clarifyYouChose:"",clarifySkipped:"",
 clarifyOtherPlaceholder:"",clarifyFillError:"",clarifySaveError:"",clarifyCountSummary:"",clarifyPurchaseSummary:""};
const change={type:"clarify" as const,kind:"facts" as const,questionId:"11111111-1111-4111-8111-111111111111",
 question:"Change what I remember?",changeSaved:true as const,fields:[
  {key:"supplier",label:"Milk supplier",inputType:"text" as const,units:[],defaultUnit:"",
   current:{value:"Mill Street Dairy",savedOn:"2026-10-30",canForget:true}},
  {key:"monthly_bills_cents",label:"Monthly bills",inputType:"money" as const,units:[],defaultUnit:"",
   current:{value:"3200.00",savedOn:"2026-11-01",canForget:false}}]};
const render=(block:Parameters<typeof ClarifyCard>[0]["block"],locale:"en"|"es"|"ar")=>
 renderToStaticMarkup(createElement(ClarifyCard,{block,locale,copy,state:"active",choice:null,
  disabled:false,onSend:vi.fn(),onFacts:vi.fn()}));

describe("saved facts on the question card",()=>{
 it.each(["en","es","ar"] as const)("shows the saved value, its date and Forget only where allowed (%s)",locale=>{
  const c=({en,es,ar}[locale]).OwnerQuestions;
  const markup=render(change,locale);
  expect(markup).toContain("Mill Street Dairy");
  expect(markup).toContain('value="3200.00"');
  expect(markup).toContain(c.savedOn.replace("{date}","2026-10-30"));
  expect(markup).toContain(c.savedOn.replace("{date}","2026-11-01"));
  expect(markup.split(c.forgetThis).length-1).toBe(1);
 });
 it("says a one-day answer is used for this question only",()=>{
  const markup=render({...change,changeSaved:undefined,fields:[{key:"guests_thursday",label:"Guests on Thursday",
   inputType:"number" as const,units:[],defaultUnit:"",remember:"this_question" as const}]},"en");
  expect(markup).toContain(en.OwnerQuestions.usedOnceHint);
  expect(markup).not.toContain(en.OwnerQuestions.forgetThis);
 });
});
