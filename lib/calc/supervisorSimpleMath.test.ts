import {describe,it,expect} from "vitest";
import {calculateSimple,parseQuotedOperand,quoteAppearsInOwnerText} from "./supervisorSimpleMath";
describe("Supervisor simple calculator uses exact cents and checked operand types",()=>{
 it("increases a verified 7-dollar price by ten percent",()=>{
  expect(calculateSimple("percent_increase",{value:700,unit:"USD_cents"},
    {value:1000,unit:"ratio_bps"})).toEqual({value:770,unit:"USD_cents"});
 });
 it("distinguishes ten cents from ten percent",()=>{
  expect(parseQuotedOperand("10 cents")).toEqual({value:10,unit:"USD_cents"});
  expect(parseQuotedOperand("10%")).toEqual({value:1000,unit:"ratio_bps"});
  expect(calculateSimple("add",{value:700,unit:"USD_cents"},
    parseQuotedOperand("10 cents")!)).toEqual({value:710,unit:"USD_cents"});
 });
 it("rejects invented, fractional and wrong-unit inputs",()=>{
  expect(quoteAppearsInOwnerText("10%","increase it 100%")).toBe(false);
  expect(quoteAppearsInOwnerText("10%","increase it 10%")).toBe(true);
  expect(quoteAppearsInOwnerText("5 cents","raise by 1.5 cents")).toBe(false);
  expect(quoteAppearsInOwnerText("10","raise by $10")).toBe(false);
  expect(quoteAppearsInOwnerText("10","raise by -10")).toBe(false);
  expect(quoteAppearsInOwnerText("10 cents","increase it 10 cents")).toBe(true);
  expect(parseQuotedOperand("1.5 cents")).toBe(null);
  expect(calculateSimple("add",{value:700,unit:"USD_cents"},
    {value:1000,unit:"ratio_bps"})).toBe(null);
 });
 it("uses deterministic rounding without floating-point money",()=>{
  expect(calculateSimple("percent_increase",{value:105,unit:"USD_cents"},
    {value:1000,unit:"ratio_bps"})).toEqual({value:116,unit:"USD_cents"});
 });
 it("rejects division by zero and unsafe arithmetic",()=>{
  expect(calculateSimple("divide",{value:100,unit:"USD_cents"},
    {value:0,unit:"count"})).toBe(null);
  expect(calculateSimple("add",{value:Number.MAX_SAFE_INTEGER,unit:"USD_cents"},
    {value:1,unit:"USD_cents"})).toBe(null);
 });
});
