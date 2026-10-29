import {describe,it,expect,vi} from "vitest";
import {milkSwapTools} from "./milkSwap";
import * as inputs from "@/lib/ownerFacts/milkSwapInputs";
import type {AgentToolContext} from "./index";
import type {SavedFact} from "@/lib/ownerFacts/inject";

const fact=(fact_key:string,value_json:unknown):SavedFact=>({
 fact_key,value_json,created_at:"2026-10-28T00:00:00Z",unit:null,period_scope:null
});
const facts=[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
 fact("milk_base_serving_cost_cents:16oz",40),
 fact("milk_oat_serving_cost_cents:16oz",90)];
const context:AgentToolContext&{savedOwnerFacts:readonly SavedFact[]}={
 asOf:"2026-10-28",timezone:"America/Los_Angeles",locale:"en",currency:"EUR",
 savedOwnerFacts:facts,
 tools:{
  getMenuCatalog:async()=>({available:true,value:[],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getProfitability:async()=>({available:false,value:null,quality:{level:"low",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getSalesTrend:async()=>({available:false,value:null,quality:{level:"low",missingInputs:[],estimatedInputs:[],staleInputs:[]}})
 }
};
describe("milk_swap_price strict tool",()=>{
 it("rejects unrecognized fields and non-array sizes",()=>{
  expect(milkSwapTools.milk_swap_price.schema.safeParse({targetMilk:"oat milk",baseMilk:null,sizes:[],guessPrice:12}).success).toBe(false);
  expect(milkSwapTools.milk_swap_price.schema.safeParse({targetMilk:"oat milk",baseMilk:null,sizes:"16 oz"}).success).toBe(false);
 });
 it("calls the single read boundary, then the existing shared calculator",async()=>{
  const read=vi.spyOn(inputs,"readMilkSwapInputs").mockResolvedValue({
   sizes:[{id:"16oz",label:"16 oz"}],results:[],missing:[]
  });
  try{
   const result=await milkSwapTools.milk_swap_price.execute({
    targetMilk:"oat milk",baseMilk:null,sizes:["16 oz"]
   },context);
   expect(read).toHaveBeenCalledWith(context,"oat milk",null,["16 oz"]);
   expect(result.missing).toEqual([]);
   expect(result.rows).toMatchObject([{additionalCostCents:50,suggestedUpchargeCents:170}]);
   expect(result.explain).toEqual(expect.arrayContaining([
    expect.objectContaining({inputs:expect.arrayContaining([
     expect.objectContaining({name:"targetProductCostPercent",value:{kind:"percent",bps:3000}}),
     expect.objectContaining({name:"roundingStepCents",value:{kind:"money",cents:5}})
    ])})
   ]));
  }finally{read.mockRestore();}
 });
});
