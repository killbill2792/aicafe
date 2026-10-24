import { describe,expect,it } from "vitest";
import { suppliesTools } from "./supplies";
import type { AgentToolContext } from "./index";
const unavailable={available:false as const,value:null,quality:{level:"low" as const,missingInputs:["missing"],estimatedInputs:[],staleInputs:[]}};
function ctx(extra:Partial<AgentToolContext["tools"]>):AgentToolContext{
  return {asOf:"2026-10-22",locale:"en",tools:{
    getProfitability:async()=>unavailable,getSalesTrend:async()=>unavailable,
    getMenuCatalog:async()=>unavailable,...extra}};
}
describe("Maya read-only costs and unavailable inventory",()=>{
  it("asks which ingredient when the search returns several matching records",async()=>{
    const result=await suppliesTools.get_ingredient_costs.execute({query:"Milk",limit:12},ctx({
      getIngredientCosts:async()=>({available:true,quality:{
        level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]},
        value:{items:[{id:"whole",name:"Milk",baseUnit:"ml",costPerBaseUnitMicros:1000,effectiveFrom:"2026-10-01"},
         {id:"oat",name:"Oat Milk",baseUnit:"ml",costPerBaseUnitMicros:1200,effectiveFrom:"2026-10-01"}]}}),
    }));
    expect(result.needsOwnerChoice).toBe(true);
    expect((result.candidates as Array<{id:string}>).map(c=>c.id)).toEqual(["whole","oat"]);
  });

  it("keeps missing recipe cost unknown instead of free",async()=>{
    const r=await suppliesTools.get_product_costs.execute({itemId:"11111111-1111-4111-8111-111111111111"},ctx({
      getProductEconomics:async()=>({available:true,quality:{level:"high",missingInputs:["recipeMissing"],estimatedInputs:[],staleInputs:[]},
        value:{id:"11111111-1111-4111-8111-111111111111",name:"Latte",priceCents:650,
          prepSeconds:90,category:"drink",ingredientsCentsToday:0,hasRecipe:false,
          costStatus:"NO_RECIPE",quantitySoldLast28Days:5}}),
    }));
    expect(r.item).toMatchObject({ingredientsCentsToday:null});
  });
  it("returns dated micros without pretending they are cents",async()=>{
    const r=await suppliesTools.get_ingredient_costs.execute({query:null,limit:null},ctx({
      getIngredientCosts:async()=>({available:true,quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]},
        value:{items:[{id:"milk",name:"Milk",baseUnit:"ml",costPerBaseUnitMicros:1210,effectiveFrom:"2026-10-01"}]}}),
    }));
    expect(r.items).toHaveLength(1);
  });
  it("never invents inventory quantities",async()=>{
    expect(await suppliesTools.get_inventory.execute({})).toMatchObject({
      inventory:null,missing:["inventoryNotTracked"],agentId:"maya"});
  });
});
