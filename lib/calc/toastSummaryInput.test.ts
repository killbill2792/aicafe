import {describe,it,expect} from "vitest";
import {parseToastNumber,parseToastSummaryCsv} from "./toastSummaryInput";
describe("Toast report numbers",()=>{
 it.each([["en","$1,234.56",123456],["es","1.234,56",123456],["ar","١٬٢٣٤٫٥٦",123456],["en","-40.00",-4000]])("parses %s integer cents",(locale,text,expected)=>{
  expect(parseToastNumber(text,locale)).toBe(expected);
 });
 it("never silently rounds partial cents or unknown text",()=>{
  expect(()=>parseToastNumber("12.345","en")).toThrow();
  expect(()=>parseToastNumber("abc","en")).toThrow();
  expect(()=>parseToastNumber("1.23","es")).toThrow();
  expect(()=>parseToastNumber("1,23","en")).toThrow();
  expect(parseToastNumber("","en")).toBeNull();
  expect(()=>parseToastNumber("1.5","en",false)).toThrow();
 });
 it("CSV yields the identical confirmed typed values, including Spanish decimal commas",()=>{
  expect(parseToastSummaryCsv('Date;Net sales;Total orders\n2026-10-20;1234,56;210',"es","2026-10-20"))
   .toEqual([{date:"2026-10-20",netSalesCents:123456,ordersCount:210,discountsCents:null,refundsCents:null,voidsCount:null}]);
 });
 it("does not apply a multi-day total to one date",()=>{
  expect(()=>parseToastSummaryCsv('Net sales,Total orders\n1234.56,210\n1234.56,210',"en","2026-10-20")).toThrow();
 });
});
