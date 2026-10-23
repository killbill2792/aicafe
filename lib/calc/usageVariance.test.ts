import {describe,it,expect} from "vitest";
import {calculateUsage,previousDate} from "./usageVariance";
const ingredients=[{id:"milk",name:"Milk",unit:"ml" as const},{id:"coffee",name:"Coffee",unit:"g" as const}];
const recipe=[{menuItemId:"large",ingredientId:"milk",quantity:200},{menuItemId:"large",ingredientId:"coffee",quantity:18}];
const sales=[{menuItemId:"large",quantity:2,businessDate:"2026-10-21",closedAt:"2026-10-21T12:00:00Z",locationId:"loc-a",modifiers:[]}];
const base={ingredients,recipes:recipe,modifiers:[],sales,salesCovered:true,from:"2026-10-20",to:"2026-10-21",counts:[
 {ingredientId:"milk",date:"2026-10-19",quantity:1000},{ingredientId:"milk",date:"2026-10-21",quantity:650}],purchases:[]};
describe("weekly ingredient reconciliation",()=>{
 it("multiplies each sale by the sized recipe and applies stock math",()=>{
  const [milk,coffee]=calculateUsage(base);
  expect(milk).toMatchObject({expected:400,actual:350,differencePct:-12.5,status:"watch"});
  expect(coffee).toMatchObject({expected:36,actual:null,differencePct:null});
  expect(coffee.missing).toContain("startCount:2026-10-19");
 });
 it("adds purchases and labels >10% extra use",()=>{
  const rows=calculateUsage({...base,purchases:[{ingredientId:"milk",date:"2026-10-20",quantity:100}]});
  expect(rows[0]).toMatchObject({expected:400,actual:450,differencePct:12.5,status:"over"});
 });
 it("preserves unknown sales or either missing boundary as null, never zero",()=>{
  const rows=calculateUsage({...base,salesCovered:false,counts:[]});
  expect(rows[0]).toMatchObject({expected:null,actual:null,differencePct:null,status:null});
  expect(rows[0].missing).toContain("toastSalesCoverage");
 });
 it("subtracts replaced milk, adds recorded swap and addon for each sold drink",()=>{
  const rows=calculateUsage({...base,ingredients:[...ingredients,{id:"oat",name:"Oat",unit:"ml" as const}],
   sales:[{...sales[0],modifiers:[{posModifierId:"swap",name:"Oat milk"},{posModifierId:"shot",name:"Extra shot"}]}],
   modifiers:[{posModifierId:"swap",ingredientId:"oat",quantityDelta:220,replacesIngredientId:"milk"},
   {posModifierId:"shot",ingredientId:"coffee",quantityDelta:18,replacesIngredientId:null}]});
  expect(rows.find(x=>x.ingredientId==="milk")?.expected).toBe(0);
  expect(rows.find(x=>x.ingredientId==="oat")?.expected).toBe(440);
  expect(rows.find(x=>x.ingredientId==="coffee")?.expected).toBe(72);
 });
 it("will not claim complete expected totals for unmapped Toast modifiers",()=>{
  const rows=calculateUsage({...base,sales:[{...sales[0],modifiers:[{posModifierId:"?",name:"Unknown"}]}]});
  expect(rows[0].expected).toBeNull();
  expect(rows[0].groups).toEqual([]);
  for(const groupBy of ["day","shift","staff"] as const){
   expect(calculateUsage({...base,sales:[{...sales[0],modifiers:[{posModifierId:"?",name:"Unknown"}]}],groupBy})[0].groups).toEqual([]);
  }
 });
 it("hides expected group numbers when Toast coverage is unproven",()=>{
  for(const groupBy of ["day","shift","staff"] as const){
   const result=calculateUsage({...base,salesCovered:false,groupBy})[0];
   expect(result.expected).toBeNull();
   expect(result.groups).toEqual([]);
  }
 });
 it("splits expected once per crew/shift, with no invented actual split",()=>{
  const staff=[{id:"one",staffId:"a",staff:"Ada",locationId:"loc-a",clockIn:"2026-10-21T10:00:00Z",clockOut:"2026-10-21T13:00:00Z"},
   {id:"two",staffId:"b",staff:"Ben",locationId:"loc-a",clockIn:"2026-10-21T11:00:00Z",clockOut:"2026-10-21T13:00:00Z"}];
  const shifts=calculateUsage({...base,staff,groupBy:"shift"})[0];
  expect(shifts.groups).toMatchObject([{expected:400,actual:null,expectedOnly:true,staff:["Ada","Ben"]}]);
  const perStaff=calculateUsage({...base,staff,groupBy:"staff"})[0];
  expect(perStaff.groups.map(g=>g.expected)).toEqual([200,200]);
  expect(perStaff.groups.reduce((n,g)=>n+g.expected,0)).toBe(400);
  expect(calculateUsage({...base,staff,groupBy:"day"})[0].groups[0].key).toBe("2026-10-21");
 });
 it("never assigns one restaurant's sales to another restaurant\'s crew",()=>{
  const staff=[{id:"a",staffId:"a",staff:"Ada",locationId:"loc-a",clockIn:"2026-10-21T10:00:00Z",clockOut:"2026-10-21T13:00:00Z"},
   {id:"b",staffId:"b",staff:"Ben",locationId:"loc-b",clockIn:"2026-10-21T10:00:00Z",clockOut:"2026-10-21T13:00:00Z"}];
  const a=calculateUsage({...base,staff,groupBy:"staff"})[0];
  expect(a.groups).toMatchObject([{label:"Ada",expected:400,actual:null}]);
  const b=calculateUsage({...base,staff,groupBy:"shift"})[0];
  expect(b.groups[0].staff).toEqual(["Ada"]);
  const unknown=calculateUsage({...base,sales:[{...sales[0],locationId:null}],staff,groupBy:"staff"})[0];
  expect(unknown.groups[0].label).toContain("No matched");
 });
 it("uses the prior closing count as the opening boundary",()=>expect(previousDate("2026-03-01")).toBe("2026-02-28"));
});
