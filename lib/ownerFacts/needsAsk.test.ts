import {describe,it,expect} from "vitest";
import {classifyNeedsAsk} from "./needsAsk";
describe("Prompt C question triggers",()=>{
 it("missing payroll -> owner question",()=>{expect(classifyNeedsAsk([{source:"labor",period:null,missing:["payroll"]}],"Some wages are recorded.","What is payroll?").some(r=>r.key==="payroll")).toBe(true);});
 it("empty schedule -> owner question without missing keys",()=>{expect(classifyNeedsAsk([{source:"get_schedule",period:null,missing:[],shifts:[]}],"None found.","Who works Saturday?").some(r=>r.kind==="empty")).toBe(true);});
 it("null value or explicitly unavailable tool is EMPTY, even with no missing key",()=>{
  expect(classifyNeedsAsk([{source:"get_profit",period:null,missing:[],value:null}],
   "Partial profit is $4.","What is profit?").some(r=>r.kind==="empty")).toBe(true);
  expect(classifyNeedsAsk([{source:"get_sales",period:null,missing:[],available:false}],
   "We saw $4.","How much sales?").some(r=>r.kind==="empty")).toBe(true);
 });
 it("failed pricing input -> owner question",()=>{expect(classifyNeedsAsk([{source:"suggest_new_item_price",period:null,missing:[],error:"internal"}],"The recorded price is $5.","Price this latte").some(r=>r.kind==="failed")).toBe(true);});
 it("finds default estimates after 40 rows and inside deeply nested canonical evidence",()=>{
  const rows=Array.from({length:60},(_,i)=>i===59?
   {payload:{a:{b:{c:{d:{basis:"default_estimate"}}}}}}:
   {payload:{basis:"actual"}});
  expect(classifyNeedsAsk([{source:"query_data",period:null,missing:[],rows}],
   "We have partial sales.","How much were sales?").some(r=>r.kind==="missing")).toBe(true);
 });
 it("treats explicitly empty tool status as an owner-question trigger",()=>{
  expect(classifyNeedsAsk([{source:"get_schedule",period:null,missing:[],status:"empty"}],
    "No shifts.","Who works Saturday?").some(r=>r.kind==="empty")).toBe(true);
 });
 it("good measured answers are not classified as missing",()=>{expect(classifyNeedsAsk([{source:"sales",period:null,missing:[],rows:[{value:5}]}],"Sales were $5.","How much did we sell?")).toEqual([]);});
});
