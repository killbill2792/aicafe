import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import HowIGotThis from "./HowIGotThis";
import {money,count,type ExplainLine} from "@/lib/ai/agent/explain";
import {calculateBreakEvenSales} from "@/lib/calc/breakEvenSales";
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
   }],locale,copy,currency:"EUR"}));
   expect(html).toContain(expected);
   expect(html).toContain("30");
 });
 it("unknown labelKey uses the raw localized date label",()=>{
  const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{
    ...line,periodLabelKey:"unknownPeriodKey"
  }],locale:"en",copy:en.SupervisorChat,currency:"EUR"}));
  expect(html).toContain("Aug 22, 2026");
  expect(html).not.toContain("unknownPeriodKey");
 });
 it("translates owner/actual/estimate/default/projected basis in three locales",()=>{
  const bases=["owner_provided","actual","estimated","default_estimate","projected"];
  for(const [locale,copy] of [["en",en.SupervisorChat],["es",es.SupervisorChat],["ar",ar.SupervisorChat]] as const)
   for(const basis of bases){
    const markup=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{...line,basis}],locale,copy,currency:"EUR"}));
    expect(markup).not.toContain(" · "+basis+"</span>");
   }
 });

 it("never renders an English free-text basis in Spanish or Arabic",()=>{
  for(const [locale,copy] of [["es",es.SupervisorChat],["ar",ar.SupervisorChat]] as const){
   const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[{
    ...line,label:"Unknown English input",basis:"Product cost / target drink cost percentage"
   }],locale,copy,currency:"EUR"}));
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
  const markup=renderToStaticMarkup(createElement(HowIGotThis,{lines:[line],locale:"ar",copy:ar.SupervisorChat,currency:"EUR"}));
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
 it("renders a what-if with price, weekly volume, fee and disclosed weekly result",()=>{
  const scenario:ExplainLine={label:"Weekly gain after processing fees",
    inputs:[{name:"New price",value:money(785)},{name:"Old price",value:money(775)},
      {name:"Weekly units",value:count(82)},{name:"Processing fee rate",value:{kind:"percent",bps:415}}],
    formula:"scenarioPrice",result:money(786),period:null,source:"scenario",provenance:"estimate"};
  const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[scenario],locale:"en",
    copy:en.SupervisorChat,currency:"USD"}));
  expect(html).toContain("How I got this");
  expect(html).toContain("$7.85");
  expect(html).toContain("$7.75");
  expect(html).toContain("82");
  expect(html).toContain("4.15%");
  expect(html).toContain("$7.86");
  expect(html).toContain("($7.85 − $7.75) × 82 × (1 − 4.15%)");
 });
 it("renders monthly what-if conversion with division by seven, not multiplication",()=>{
  const monthly:ExplainLine={label:"Monthly equivalent of weekly change",
    inputs:[{name:"Weekly change",value:money(971)},
      {name:"Days in month",value:count(31)},
      {name:"Days in week",value:count(7)}],
    formula:"scenarioProrate",result:money(Math.round(971*31/7)),
    period:null,source:"scenario",provenance:"estimate"};
  const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[monthly],locale:"en",
    copy:en.SupervisorChat,currency:"USD"}));
  expect(html).toContain("$9.71 × 31 ÷ 7 = $43.00");
 });
 it.each([["es",es],["ar",ar]] as const)(
  "localizes scenario explanation headings and inputs in %s",(locale,messages)=>{
    const scenario:ExplainLine={label:"Weekly price difference",
      inputs:[{name:"New price",value:money(785)},{name:"Old price",value:money(775)}],
      formula:"subtract",result:money(10),period:null,source:"scenario",provenance:"estimate"};
    const second:ExplainLine={label:"Weekly gain after processing fees",
      inputs:[{name:"New price",value:money(785)},{name:"Old price",value:money(775)},
        {name:"Weekly units",value:count(82)},{name:"Processing fee rate",value:{kind:"percent",bps:415}}],
      formula:"scenarioPrice",result:money(786),period:null,source:"scenario",provenance:"estimate"};
    const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[scenario,second],
      locale,copy:messages.SupervisorChat,currency:"EUR"}));
    expect(html).toContain(messages.OwnerQuestions.scenarioPriceDifference);
    expect(html).toContain(messages.OwnerQuestions.scenarioWeeklyPriceGain);
    for(const english of ["Weekly price difference","Weekly gain after processing fees","New price","Old price",
      "Weekly units","Processing fee rate"])expect(html).not.toContain(english);
    expect(html).toContain("4,15".replace(",",locale==="ar"?"٫":"," ).slice(0,1));
  });
 it("shows the exact core break-even equation, with each displayed input once",()=>{
  const breakEven=calculateBreakEvenSales({monthlyBillsCents:14000,monthlyStaffCents:6915,
    observedSalesCents:100000,observedIngredientCents:30000,observedProcessingFeesCents:3000});
  expect(breakEven.kind).toBe("ready");
  if(breakEven.kind!=="ready")throw new Error("fixture unavailable");
  expect(breakEven.breakEvenSalesCents).toBe(31216);
  const line:ExplainLine={label:"Daily break-even sales",inputs:[
    {name:"billsForPeriod",value:money(14000)},
    {name:"loadedLaborForPeriod",value:money(6915)},
    {name:"observedNetSales",value:money(100000)},
    {name:"ingredientCostCalibration",value:money(30000)},
    {name:"feeCalibrationForScenario",value:money(3000)}],
    formula:"breakEven",result:money(breakEven.breakEvenSalesCents),
    period:null,source:"get_break_even",provenance:"estimate"};
  const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[line],locale:"en",
    copy:en.SupervisorChat,currency:"USD"}));
  const equation=html.match(/<bdi dir="ltr">([\s\S]*?)<\/bdi>/)?.[1]?.replace(/<[^>]+>/g,"").replace(/\s+/g," ");
  expect(equation).toContain("÷ (1 − ((");
  expect(equation).toContain(") ÷ ");
  const amounts=[...((equation??"").matchAll(/\$([\d,]+\.\d{2})/g))].map(m=>Math.round(Number(m[1].replaceAll(",",""))*100));
  expect(amounts).toEqual([14000,6915,30000,3000,100000,31216]);
  const [bills,labor,ingredients,fees,sales,shownResult]=amounts;
  // Evaluate only displayed numbers, using the core's exact rounding rule.
  const evaluated=Math.round((bills+labor)/(1-(ingredients+fees)/sales));
  expect(evaluated).toBe(shownResult);
  expect(shownResult).toBe(breakEven.breakEvenSalesCents);
 });

});
