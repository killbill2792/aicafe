import { describe,expect,it,vi } from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import { suppliesTools } from "./supplies";
import type { AgentToolContext } from "./index";
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
  it("queries the same owner-scoped canonical stock view as Supervisor, without an invented zero",async()=>{
    const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
      expect(name).toBe("ai_query_view");
      expect(args.p_view).toBe("cv_inventory");
      expect(args.p_business_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      return {error:null,data:{rows:[{source:"toast",source_ref:"toast-current:1",
        menu_item_ref:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",stock_status:"QUANTITY",
        quantity:3.5,business_date:"2026-10-22",data:{source_as_of:"2026-10-22T18:00:00Z"}}],
        sourceMix:{toast:1},sourceCount:1,truncated:false}};
    });
    const context={...ctx({}),canonicalData:async()=>({
      db:{rpc} as unknown as SupabaseClient,
      businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})};
    const got=await suppliesTools.get_inventory.execute({},context);
    expect(got.inventory).toEqual([expect.objectContaining({
      quantity:3.5,stock_status:"QUANTITY",source:"toast"})]);
    expect(got.missing).toContain("source_freshness_unverified");
    expect(got.quantitySemantics).toBe("no_unobserved_zero");
  });
  it("returns missing, not empty live stock, after an unavailable canonical read",async()=>{
    const context={...ctx({}),canonicalData:async()=>({
      db:{rpc:async()=>({error:{message:"not available"},data:null})} as unknown as SupabaseClient,
      businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})};
    const got=await suppliesTools.get_inventory.execute({},context);
    expect(got.inventory).toBeNull();
    expect(got.missing).toContain("source_read_failed");
  });
  it("never invents inventory quantities",async()=>{
    expect(await suppliesTools.get_inventory.execute({})).toMatchObject({
      inventory:null,missing:["inventoryNotTracked"],agentId:"maya"});
  });
});
