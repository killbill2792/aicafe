import { describe,expect,it,vi } from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import { suppliesTools } from "./supplies";
import { agentToolDefinitions,executeAgentTool,type AgentToolContext } from "./index";
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
        quantity:3.5,business_date:"2026-10-22",data:{source_as_of:"2026-10-22T18:00:00Z",evidence_state:"observed_current"}}],
        sourceMix:{toast:1},sourceCount:1,truncated:false}};
    });
    const context={...ctx({}),canonicalData:async()=>({
      db:{rpc} as unknown as SupabaseClient,
      businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})};
    const got=await suppliesTools.get_inventory.execute({},context);
    expect(got.inventory).toEqual([expect.objectContaining({
      quantity:3.5,stock_status:"QUANTITY",source:"toast"})]);
    expect(got.missing).not.toContain("source_freshness_unverified");
    expect(got.quantitySemantics).toBe("no_unobserved_zero");
  });
  it("hides historical Toast quantity when latest successful source omitted the item",async()=>{
    const rpc=vi.fn(async()=>({error:null,data:{
      rows:[{source:"toast",source_ref:"toast-current:1",stock_status:null,quantity:null,
       data:{source_as_of:"2026-10-21T18:00:00Z",reported_stock_status:"QUANTITY",
        evidence_state:"not_observed"}}],sourceMix:{toast:1},sourceCount:1,truncated:false
    }}));
    const context={...ctx({}),canonicalData:async()=>({db:{rpc} as unknown as SupabaseClient,
      businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})};
    const got=await suppliesTools.get_inventory.execute({},context);
    expect(got.inventory).toEqual([expect.objectContaining({
      quantity:null,evidence_state:"not_observed",stock_status:null})]);
    expect(got.missing).toContain("stockNotObservedInLatestSuccess");
  });
  it("returns missing, not empty live stock, after an unavailable canonical read",async()=>{
    const context={...ctx({}),canonicalData:async()=>({
      db:{rpc:async()=>({error:{message:"not available"},data:null})} as unknown as SupabaseClient,
      businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})};
    const got=await suppliesTools.get_inventory.execute({},context);
    expect(got.inventory).toBeNull();
    expect(got.missing).toContain("source_read_failed");
  });
  it("actually dispatches registered Supervisor stock for the signed-in café with current, historic and zero evidence",async()=>{
    // Calling suppliesTools.get_inventory directly is NOT enough. This exercises
    // the production name dispatcher and reproduces the context-loss regression.
    expect(agentToolDefinitions.some(tool=>tool.name==="get_inventory")).toBe(true);
    const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
      expect(name).toBe("ai_query_view");
      expect(args).toMatchObject({p_business_id:businessId,p_view:"cv_inventory",
        p_date_from:"2026-10-22",p_date_to:"2026-10-22"});
      return {error:null,data:{rows:[
        {source:"toast",source_ref:"current:item",menu_item_ref:"current-guid",
          quantity:3.5,stock_status:"QUANTITY",business_date:"2026-10-22",
          data:{evidence_state:"observed_current",source_as_of:"2026-10-22T16:00:00Z"}},
        {source:"toast",source_ref:"historical:item",menu_item_ref:"historical-guid",
          quantity:8,stock_status:"QUANTITY",business_date:"2026-10-22",
          data:{evidence_state:"not_observed",reported_stock_status:"QUANTITY",
            source_as_of:"2026-10-21T16:00:00Z"}},
        {source:"app",source_ref:"stock:milk",quantity:0,business_date:"2026-10-22",
          data:{evidence_state:"dated_owner_count",ingredient_id:"milk",count_date:"2026-10-22"}}
      ],sourceCount:3,sourceMix:{toast:2,app:1},truncated:false}};
    });
    const canonicalData=vi.fn(async()=>({db:{rpc} as unknown as SupabaseClient,businessId}));
    const result=await executeAgentTool("get_inventory",{},{
      ...ctx({}),asOf:"2026-10-22T23:30:00.000Z",canonicalData
    });
    expect(canonicalData).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({source:"inventory",period:{from:"2026-10-22",to:"2026-10-22"},
      quantitySemantics:"no_unobserved_zero",scope:"observed_inventory_only"});
    expect(result.inventory).toEqual([
      expect.objectContaining({source_ref:"current:item",quantity:3.5,evidence_state:"observed_current"}),
      expect.objectContaining({source_ref:"historical:item",quantity:null,stock_status:null,
        evidence_state:"not_observed"}),
      expect.objectContaining({source_ref:"stock:milk",quantity:0,evidence_state:"dated_owner_count"})
    ]);
    expect(result.missing).toContain("stockNotObservedInLatestSuccess");
  });
  it("registered inventory chat fails closed without a scoped database or when the RPC fails",async()=>{
    const noScope=await executeAgentTool("get_inventory",{},ctx({}));
    expect(noScope).toMatchObject({inventory:null,missing:["inventoryNotTracked"]});
    const rpc=vi.fn(async()=>({data:null,error:{message:"provider/database unavailable"}}));
    const context={...ctx({}),canonicalData:async()=>({
      db:{rpc} as unknown as SupabaseClient,
      businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})};
    const unavailable=await executeAgentTool("get_inventory",{},context);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(unavailable).toMatchObject({inventory:null});
    expect(unavailable.missing).toContain("source_read_failed");
  });
  it("never invents inventory quantities",async()=>{
    expect(await suppliesTools.get_inventory.execute({})).toMatchObject({
      inventory:null,missing:["inventoryNotTracked"],agentId:"maya"});
  });
});
