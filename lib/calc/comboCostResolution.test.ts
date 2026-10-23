import {describe,it,expect} from "vitest";
import {resolveComboCosts} from "./comboCostResolution";
const cost=(cents:number|null,estimated=false)=>({costCents:cents,status:cents===null?"NO_RECIPE" as const:"READY" as const,estimated});
describe("combo cost shared by menu/editor/owner snapshots",()=>{
 it("quantities, buy-ins and estimates have one calculation",()=>{
  const rows=[{comboItemId:"combo",componentItemId:"milk",quantity:2,buyInCostCents:null},{comboItemId:"combo",componentItemId:"pastry",quantity:1,buyInCostCents:125}];
  expect(resolveComboCosts(rows,new Map([["milk",cost(112,true)],["pastry",cost(null)]])).get("combo")).toEqual({status:"READY",costCents:349,estimated:true});
 });
 it("never invents unknown or zero for unknown priced parts",()=>{
  const rows=[{comboItemId:"c",componentItemId:"x",quantity:1,buyInCostCents:null}];
  expect(resolveComboCosts(rows,new Map([["x",cost(null)]])).get("c")).toEqual({status:"MISSING_INGREDIENT_COST",costCents:null,estimated:false});
 });
 it("rejects cyclical/nested family members even if given an override",()=>{
  const rows=[{comboItemId:"a",componentItemId:"b",quantity:1,buyInCostCents:100},{comboItemId:"b",componentItemId:"a",quantity:1,buyInCostCents:null}];
  expect(resolveComboCosts(rows,new Map()).get("a")?.status).toBe("MISSING_INGREDIENT_COST");
  expect(resolveComboCosts(rows,new Map()).get("b")?.status).toBe("MISSING_INGREDIENT_COST");
 });
});
