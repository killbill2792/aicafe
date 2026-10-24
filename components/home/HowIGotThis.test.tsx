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
 it("is native collapsed details with 48px target and formatted recorded inputs",()=>{
  const markup=renderToStaticMarkup(createElement(HowIGotThis,{lines:[line],locale:"en",copy:en.SupervisorChat}));
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
  const markup=renderToStaticMarkup(createElement(HowIGotThis,{lines:[line],locale:"es",copy:es.SupervisorChat}));
  expect(markup).toContain("56.000,00");
  expect(markup).toContain("US$");
 });
 it("keeps translated explain and clarify key parity",()=>{
  const keys=["howIGotThis","explainYouToldMe","explainEstimate","explainSold",
   "clarifyOther","clarifySend","clarifyYouChose","clarifySkipped","clarifyOtherPlaceholder",
   "explainMultiply","explainSum","explainDivide","explainRatio","explainProrate","explainSubtract"];
  for(const key of keys)for(const messages of [en,es,ar]){
    expect(Object.hasOwn(messages.SupervisorChat,key)).toBe(true);
    expect(typeof (messages.SupervisorChat as Record<string,unknown>)[key]).toBe("string");
  }
 });
});
