import {describe,it,expect} from "vitest";
import {parseOwnerFactDecimal} from "./numbers";
describe("owner input locale numbers",()=>{
 it("parses Arabic-Indic and Eastern Arabic digits",()=>{
  expect(parseOwnerFactDecimal("١٢٣٤٫٥٠","ar")).toBe(1234.5);
  expect(parseOwnerFactDecimal("۱۲۳۴٫۵۰","ar")).toBe(1234.5);
 });
 it("parses grouped English and Spanish money",()=>{
  expect(parseOwnerFactDecimal("13,000.50","en")).toBe(13000.5);
  expect(parseOwnerFactDecimal("13.000,50","es")).toBe(13000.5);
 });
 it("rejects grouping ambiguity",()=>{
  expect(parseOwnerFactDecimal("1,23,4","en")).toBeNull();
  expect(parseOwnerFactDecimal("hello","ar")).toBeNull();
 });
});
