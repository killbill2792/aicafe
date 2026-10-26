import {describe,it,expect} from "vitest";
import {parseOwnerDecimal} from "./localeDecimal";
describe("owner locale decimals",()=>{
 it("reads Spanish decimal commas",()=>{
  expect(parseOwnerDecimal("4,5","es")).toBe(4.5);
  expect(parseOwnerDecimal("4,5","en")).toBeNull();
 });
 it("reads Arabic-Indic and Eastern Arabic digits",()=>{
  expect(parseOwnerDecimal("٤٫٥","ar")).toBe(4.5);
  expect(parseOwnerDecimal("۴٫۵","ar")).toBe(4.5);
  expect(parseOwnerDecimal("٤","ar")).toBe(4);
 });
 it("rejects ambiguous punctuation, infinities and negatives",()=>{
  expect(parseOwnerDecimal("1,200.5","es")).toBeNull();
  expect(parseOwnerDecimal("Infinity","en")).toBeNull();
  expect(parseOwnerDecimal("-4","en")).toBeNull();
 });
});
