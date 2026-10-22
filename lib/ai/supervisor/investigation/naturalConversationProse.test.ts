import {describe,it,expect} from "vitest";
import {groundedNaturalProse} from "./naturalConversationProse";
describe("native Supervisor prose grounding without generic questions",()=>{
 it("preserves the exact sourced-size owner clarification",()=>{
  const question="Would you like to increase the 12 oz or 16 oz latte by 10 cents?";
  expect(groundedNaturalProse(question,["12 oz latte","16 oz latte","10 cents"],"en"))
    .toEqual({text:question,redacted:false});
 });
 it("retains verified hyphenated, Spanish and Arabic size options",()=>{
  expect(groundedNaturalProse("Choose the 12-ounce or 16-ounce latte.",
    ["12 oz latte","16 oz latte"],"en").redacted).toBe(false);
  expect(groundedNaturalProse("¿Prefieres el latte de 12 onzas o 16 onzas?",
    ["12 oz latte","16 oz latte"],"es").redacted).toBe(false);
  expect(groundedNaturalProse("هل تفضل لاتيه 12 أونصة أو 16 أونصة؟",
    ["12 oz latte","16 oz latte"],"ar").redacted).toBe(false);
 });
 it("allows natural equivalent monetary expressions with exact cents",()=>{
  const out=groundedNaturalProse("Your latte costs $7.00. Increase it by $0.10?",
    ["$7","10 cents"],"en");
  expect(out.redacted).toBe(false);
  expect(out.text).toContain("$7.00");
 });
 it("preserves owner-stated dates and counts without a blanket digit ban",()=>{
  const text="Would you like to compare the last 7 days?";
  expect(groundedNaturalProse(text,["show me the last 7 days"],"en").text).toBe(text);
 });
 it("redacts unsupported numbers rather than discarding entire natural answer",()=>{
  const out=groundedNaturalProse("The recorded latte costs $999. I can still check its recipe.",
    ["$7.00"],"en");
  expect(out.redacted).toBe(true);
  expect(out.text).not.toContain("$999");
  expect(out.text).toContain("I can still check its recipe.");
 });
 it("rejects a model assertion of an executed action without a receipt",()=>{
  const out=groundedNaturalProse("I published your schedule. Would you like to review the coverage?",
    [],"en");
  expect(out.redacted).toBe(true);
  expect(out.text).not.toContain("I published your schedule");
  expect(out.text).toContain("Would you like to review the coverage?");
 });
 it("does not turn a percent into a size, money or scalar",()=>{
  const out=groundedNaturalProse("Try increasing by 16%.",["16 oz latte"],"en");
  expect(out.redacted).toBe(true);expect(out.text).not.toContain("16%");
 });
});
