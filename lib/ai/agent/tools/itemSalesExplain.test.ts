import {describe,it,expect} from "vitest";
import {salesTools} from "./sales";
import type {AgentToolContext} from "./index";
const productId="11111111-1111-4111-8111-111111111111";
const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
describe("item sales explanation",()=>{
 it("asks for the exact Latte instead of selecting a same-name or prefixed product",async()=>{
  const secondId="22222222-2222-4222-8222-222222222222";
  const ctx={asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles",
    tools:{
      getProductSales:async()=>({available:true,value:[
        {id:productId,name:"Latte",category:"drink",units:28},
        {id:secondId,name:"Iced Latte",category:"drink",units:48}],quality}),
      getMenuCatalog:async()=>({available:true,value:[
        {id:productId,name:"Latte",active:true,category:"drink",priceCents:450},
        {id:secondId,name:"Iced Latte",active:true,category:"drink",priceCents:500}],quality})
    }} as unknown as AgentToolContext;
  const result=await salesTools.get_item_sales.execute({period:"week",query:"Latte"},ctx);
  expect(result.needsOwnerChoice).toBe(true);
  expect((result.candidates as Array<{id:string}>).map(c=>c.id)).toEqual([productId,secondId]);
  expect(result.items).toBeUndefined();
 });

 it("uses 2800 sold units and the tool's $20 menu price without claiming a recorded sales amount",async()=>{
  const ctx={asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles",
   tools:{getProductSales:async()=>({available:true,value:[{id:productId,name:"Latte",category:"drink",units:2800}],quality}),
    getMenuCatalog:async()=>({available:true,value:[{id:productId,name:"Latte",category:"drink",priceCents:2000,active:true}],quality})}
  } as unknown as AgentToolContext;
  const answer=await salesTools.get_item_sales.execute({period:{from:"2026-08-22",to:"2026-09-04"}},ctx);
  expect(answer.missing).toEqual([]);
  expect(answer.period).toEqual({from:"2026-08-22",to:"2026-09-04"});
  expect((answer.items as Array<{illustrativeRevenueCents:number}>)[0].illustrativeRevenueCents).toBe(5600000);
  expect(answer.explain).toEqual([{label:"Latte",inputs:[
   {name:"qtySold",value:{kind:"count",n:2800}},
   {name:"unitPrice",value:{kind:"money",cents:2000}}],
   formula:"multiply",result:{kind:"money",cents:5600000},
   period:{from:"2026-08-22",to:"2026-09-04"},source:"get_item_sales",provenance:"estimate"}]);
  expect(answer.estimated).toContain("currentMenuPriceNotHistoricalSoldPrice");
 });
});
