import { describe,it,expect } from "vitest";
import { tokenizeNumbers } from "./numberTokens";
describe("shared numeric tokenizer",()=>{
 const forms:[string,"en"|"es"|"ar",string][]=[
  ["7:30","en","clock"],["6:30–14:00","en","clockRange"],
  ["13.5 hours","en","duration"],["94.5 hrs","en","duration"],
  ["Mon 10/27","en","date"],["$1,274.25","en","money"],
  ["1.274,25 €","es","money"],["١٬٢٧٤٫٢٥","ar","decimal"],
  ["($5.00)","en","money"],["٣ ساعات","ar","duration"],
  ["7:30 a.m.–2:30 p.m.","en","clockRange"],
  ["12,5 %","es","percent"],["27 أكتوبر","ar","date"],
 ];
 it.each(forms)("groups %s as %s", (text,locale,kind)=>{
  const tokens=tokenizeNumbers(text,locale);
  expect(tokens[0]?.kind).toBe(kind);
  expect(tokens.every((t,i)=>i===0||t.start>=tokens[i-1].end)).toBe(true);
 });
 it("uses money cents and parentheses sign",()=>{
  expect(tokenizeNumbers("($5.00)","en")[0]?.value).toBe(-500);
  expect(tokenizeNumbers("$1,274.25","en")[0]?.value).toBe(127425);
  expect(tokenizeNumbers("1.274,25 €","es")[0]?.value).toBe(127425);
 });
 it.each([
   ["10–20%","en",1000,2000],
   ["10%-20%","en",1000,2000],
   ["10,5–20,5 %","es",1050,2050],
   ["١٠–٢٠٪","ar",1000,2000],
 ] as const)("keeps both endpoints of %s in percentage units", (source,locale,low,high)=>{
   const tokens=tokenizeNumbers(source,locale);
   expect(tokens.map(t=>t.kind)).toEqual(["percent","percent"]);
   expect(tokens.map(t=>t.unit)).toEqual(["bps","bps"]);
   expect(tokens.map(t=>t.value)).toEqual([low,high]);
   expect(tokens[0].end).toBeLessThanOrEqual(tokens[1].start);
 });
 it("keeps sentence punctuation out of bare AM/PM time tokens",()=>{
   const text="We open at 8:00 AM.";
   const tokens=tokenizeNumbers(text,"en");
   expect(tokens.filter(t=>t.kind==="clock").map(t=>text.slice(t.start,t.end)))
     .toEqual(["8:00 AM"]);
   expect(tokenizeNumbers("We open at 7:30 a.m.","en").filter(t=>t.kind==="clock"))
     .toHaveLength(1);
 });
 it("does not allow a count to replace a percent-range endpoint",()=>{
   const tokens=tokenizeNumbers("Margin 10–20% after 10 orders","en");
   expect(tokens.filter(t=>t.kind==="percent")).toHaveLength(2);
   expect(tokens.filter(t=>t.kind==="count").map(t=>t.value)).toEqual([10]);
 });
 it("never overlaps, including malformed randomized prose",()=>{
  let seed=47;
  const chars="0:31, .$٧٪١-5a| ١٢";
  for(let sample=0;sample<300;sample++){
   let text="";
   for(let i=0;i<60;i++){seed=(seed*1664525+1013904223)>>>0;text+=chars[seed%chars.length];}
   const tokens=tokenizeNumbers(text,"en");
   for(let i=1;i<tokens.length;i++)expect(tokens[i].start).toBeGreaterThanOrEqual(tokens[i-1].end);
  }
 });
});
