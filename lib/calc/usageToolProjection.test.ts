import {describe,it,expect} from "vitest";
import {projectUsageTool} from "./usageToolProjection";
import {checkNumbers,compactEvidence} from "@/lib/ai/agent/checkNumbers";
import type {UsageRow} from "./usageVariance";

const milk:UsageRow={ingredientId:"milk",name:"Milk",unit:"ml",
 expected:400,actual:450,differencePct:12.5,status:"over",missing:[],groups:[]};
describe("budgeted Maya usage evidence",()=>{
 it("registers typed, ingredient-scoped numbers with the existing checker",()=>{
  const result=projectUsageTool({from:"2026-10-20",to:"2026-10-21",rows:[milk],missing:[],groupBy:null});
  const evidence=compactEvidence([result]);
  expect(evidence.flatMap(e=>e.values).map(x=>x.key)).toEqual(expect.arrayContaining([
   "2026-10-20/2026-10-21/items:milk:expected/quantity",
   "2026-10-20/2026-10-21/items:milk:actual/quantity",
   "2026-10-20/2026-10-21/items:milk:expected/differencePercent",
  ]));
  expect(checkNumbers("Expected 400 ml, actual 450 ml, 12.5% over", "", [result], "en")).toEqual([]);
  expect(checkNumbers("Expected 999 ml", "", [result], "en")).toHaveLength(1);
 });
 it("preserves missing actuals as null rather than generating zero evidence",()=>{
  const r=projectUsageTool({from:"2026-10-20",to:"2026-10-21",rows:[{...milk,actual:null,differencePct:null,status:null}],missing:["endCount"],groupBy:null});
  expect(r.rows[0].actual).toBeNull();
  expect(r.items.find(x=>x.metric==="actual")?.quantity).toBeNull();
  expect(compactEvidence([r]).flatMap(x=>x.values).some(x=>x.key.includes("actual")&&x.value===0)).toBe(false);
 });
 it("caps both nested groups and rows and marks omissions without inventing actual shift use",()=>{
  const rows=Array.from({length:45},(_,i)=>({...milk,ingredientId:"ingredient-"+i,
   name:"Ingredient "+i,groups:Array.from({length:31},(_,j)=>({
    key:"day-"+j,label:"Day "+j,staff:[],expected:22,actual:null as null,expectedOnly:true as const}))}));
  const r=projectUsageTool({from:"2026-10-01",to:"2026-10-31",rows,missing:[],groupBy:"day"});
  expect(JSON.stringify(r).length).toBeLessThanOrEqual(3400);
  expect(r.omittedIngredients+r.omittedGroups).toBeGreaterThan(0);
  expect(r.missing).toContain("usageResultTruncated");
  expect(r.actualShiftUsage).toBeNull();
 });
});