import {describe,it,expect} from "vitest";
import {acceptedExplainLines,money,count,type ExplainLine} from "./explain";
import type {NumericEvidence} from "./checkNumbers";
const line:ExplainLine={label:"Latte",inputs:[{name:"qtySold",value:count(2800)},
  {name:"unitPrice",value:money(2000)}],formula:"multiply",result:money(5600000),
  period:{from:"2026-08-22",to:"2026-09-04"},source:"get_item_sales",provenance:"estimate"};
const evidence:NumericEvidence[]=[{tool:"item_sales",values:[
 {key:"2026-08-22/2026-09-04/item:latte/illustrativeRevenueCents",unit:"cents",value:5600000}]}];
describe("trusted explanation selection",()=>{
 it("shows a trusted calculation only when the owner reply actually uses its verified result",()=>{
  expect(acceptedExplainLines([line],evidence,"Latte: $56,000.00",[],"en")).toEqual([line]);
 });
 it("does not explain an invented $60,000 claim",()=>{
  expect(acceptedExplainLines([line],evidence,"Latte: $60,000.00",[],"en")).toEqual([]);
 });
 it("does not repeat a numeric claim rejected by the verifier",()=>{
  const text="Latte: $56,000.00";
  expect(acceptedExplainLines([line],evidence,text,[{start:7,end:text.length}],"en")).toEqual([]);
 });
 it("does not trust model-provided math without exact tool evidence",()=>{
  expect(acceptedExplainLines([line],[], "Latte: $56,000.00",[],"en")).toEqual([]);
 });
 it("does not attach a calculation with coincidentally equal money from another tool",()=>{
  const wrongSource=[{tool:"expenses",values:evidence[0].values}];
  expect(acceptedExplainLines([line],wrongSource,"Latte: $56,000.00",[],"en")).toEqual([]);
 });
 it("rejects a different period and numeric substring inside a larger amount",()=>{
  const other:ExplainLine={...line,period:{from:"2025-08-22",to:"2025-09-04"}};
  expect(acceptedExplainLines([other],evidence,"Latte: $56,000.00",[],"en")).toEqual([]);
  expect(acceptedExplainLines([line],evidence,"Latte: $156,000.00",[],"en")).toEqual([]);
 });
});
