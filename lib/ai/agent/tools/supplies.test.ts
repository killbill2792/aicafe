import { describe,expect,it } from "vitest";
import { suppliesTools } from "./supplies";
import { executeAgentTool, type AgentToolContext } from "./index";
const unavailable={available:false as const,value:null,quality:{level:"low" as const,missingInputs:["missing"],estimatedInputs:[],staleInputs:[]}};
function ctx(extra:Partial<AgentToolContext["tools"]>):AgentToolContext{
  return {timezone:"America/Los_Angeles",asOf:"2026-10-22",locale:"en",tools:{
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

  it("reproduces a whole-month variance source error without guessing zero waste",async()=>{
    const r=await executeAgentTool("get_usage_variance",{
      from:"2026-10-01",to:"2026-10-31",ingredient:null,group_by:null,
    },ctx({getUsageVariance:async()=>{throw new Error("source unavailable");}}));
    expect(r).toMatchObject({source:"usage_variance",rows:null,
      missing:["usageVarianceReadFailed"]});
  });
  it("reports Postgres October timeout as source failure, never observed zero wastage",async()=>{
    const r=await executeAgentTool("get_usage_variance",{
      from:"2026-10-01",to:"2026-10-31",ingredient:null,group_by:null,
    },ctx({getUsageVariance:async()=>{throw new Error("usage_source_timeout");}}));
    expect(r).toMatchObject({source:"usage_variance",rows:null,
      missing:["usageVarianceSourceTimeout"]});
  });
  it("labels failed cost sources without filling absent ingredient prices",async()=>{
    const context=ctx({
      getIngredientCosts:async()=>{throw new Error("read failed");},
      getProductEconomics:async()=>{throw new Error("read failed");},
    });
    const ingredient=await executeAgentTool("get_ingredient_costs",{query:null,limit:null},context);
    const product=await executeAgentTool("get_product_costs",{
      itemId:"11111111-1111-4111-8111-111111111111"},context);
    expect(ingredient).toMatchObject({items:null,missing:["ingredientCostReadFailed"]});
    expect(product).toMatchObject({item:null,missing:["productCostReadFailed"]});
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
});
