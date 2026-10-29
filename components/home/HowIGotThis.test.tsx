import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import HowIGotThis from "./HowIGotThis";
import {money,count,type ExplainLine} from "@/lib/ai/agent/explain";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
const line:ExplainLine={label:"Latte",inputs:[
 {name:"qtySold",value:count(2800)},{name:"unitPrice",value:money(2000)}],
 formula:"multiply",result:money(5600000),period:{from:"2026-08-22",to:"2026-09-04"},
 source:"get_item_sales",provenance:"estimate"};
describe("How I got this disclosure",()=>{
 it.each([["en","Last month"],["es","El mes pasado"],["ar","الشهر الماضي"]] as const)(
  "renders the period labelKey with dates in %s",(locale,expected)=>{
   const copy={en,es,ar}[locale].SupervisorChat;
   const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{
     ...line,period:{from:"2026-09-01",to:"2026-09-30"},periodLabelKey:"periodLastMonth"
   }],locale,copy}));
   expect(html).toContain(expected);
   expect(html).toContain("30");
 });
 it("unknown labelKey uses the raw localized date label",()=>{
  const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{
    ...line,periodLabelKey:"unknownPeriodKey"
  }],locale:"en",copy:en.SupervisorChat}));
  expect(html).toContain("Aug 22, 2026");
  expect(html).not.toContain("unknownPeriodKey");
 });
 it("translates owner/actual/estimate/default/projected basis in three locales",()=>{
  const bases=["owner_provided","actual","estimated","default_estimate","projected"];
  for(const [locale,copy] of [["en",en.SupervisorChat],["es",es.SupervisorChat],["ar",ar.SupervisorChat]] as const)
   for(const basis of bases){
    const markup=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{...line,basis}],locale,copy}));
    expect(markup).not.toContain(" · "+basis+"</span>");
   }
 });

 it("never renders an English free-text basis in Spanish or Arabic",()=>{
  for(const [locale,copy] of [["es",es.SupervisorChat],["ar",ar.SupervisorChat]] as const){
   const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{
    ...line,label:"Unknown English input",basis:"Product cost / target drink cost percentage"
   }],locale,copy}));
   expect(html).not.toContain("Product cost / target");
   expect(html).toContain("Unknown English input");
  }
 });
 it("is native collapsed details with 48px target and formatted recorded inputs",()=>{
  const markup=renderToStaticMarkup(createElement(HowIGotThis,{lines:[line],locale:"en",copy:en.SupervisorChat,currency:"USD"}));
  expect(markup).toContain("<details");
  expect(markup).not.toContain("<details open");
  expect(markup).toContain("min-h-12");
  expect(markup).toContain("How I got this");
  expect(markup).toContain("2,800");
  expect(markup).toContain("$20.00");
  expect(markup).toContain("$56,000.00");
  expect(markup).toContain("Estimate");
 });
 it("uses RTL and isolated left-to-right mathematics for Arabic",()=>{
  const markup=renderToStaticMarkup(createElement(HowIGotThis,{lines:[line],locale:"ar",copy:ar.SupervisorChat}));
  expect(markup).toContain('dir="rtl"');
  expect(markup).toContain('<bdi dir="ltr">');
 });
 it("uses locale-aware Spanish currency formatting",()=>{
  const markup=renderToStaticMarkup(createElement(HowIGotThis,{lines:[line],locale:"es",copy:es.SupervisorChat,currency:"USD"}));
  expect(markup).toContain("56.000,00");
  expect(markup).toContain("US$");
 });
 it.each([["es",es],["ar",ar]] as const)("preserves localized new-item-price labels in %s",(locale,messages)=>{
  const translated=messages.MetricsNotes.itemIngredientsPackaging;
  const input=messages.MetricsNotes.itemInputsIngredients;
  const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{
   ...line,label:translated,inputs:[{name:input,value:money(125)}]
  }],locale,copy:messages.SupervisorChat,currency:"EUR"}));
  expect(html).toContain(translated);
  expect(html).toContain(input);
  expect(html).not.toContain(messages.OwnerQuestions.generic+":");
 });
 it("renders the exact 5-cent ceiling formula in the disclosure",()=>{
  const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{
   ...line,source:"milk_swap",label:"Suggested upcharge",
   formula:"divide",inputs:[{name:"costDeltaCents",value:money(50)},
    {name:"targetProductCostPercent",value:{kind:"percent",bps:3000}},
    {name:"roundingStepCents",value:money(5)}],result:money(170)
  }],locale:"en",copy:en.SupervisorChat,currency:"EUR"}));
  expect(html).toContain("ceil(max(0,");
  expect(html).toContain("30%");
  expect(html).toContain("€1.70");
  expect(html).not.toContain("70%");
 });
 it("keeps translated explain and clarify key parity",()=>{
  const keys=["howIGotThis","explainYouToldMe","explainEstimate","explainSold",
   "clarifyOther","clarifySend","clarifyYouChose","clarifySkipped","clarifyOtherPlaceholder",
   "howCalculated","explainMissing","explainMultiply","explainSum","explainDivide","explainRatio","explainProrate","explainSubtract"];
  for(const key of keys)for(const messages of [en,es,ar]){
    expect(Object.hasOwn(messages.SupervisorChat,key)).toBe(true);
    expect(typeof (messages.SupervisorChat as Record<string,unknown>)[key]).toBe("string");
  }
 });
});
