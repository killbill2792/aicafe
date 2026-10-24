import {describe,it,expect,vi} from "vitest";
import {proposalTools} from "./proposals";
import type {AgentToolContext} from "./index";
const input={product_id:"22222222-2222-4222-8222-222222222222",new_price_cents:550};
const minimal={tools:{getMenuCatalog:async()=>({available:true as const,
 value:[{id:input.product_id,name:"Latte",category:"drink" as const,active:true,priceCents:450}],
 quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}})}
 as unknown as AgentToolContext["tools"],asOf:"2026-10-22",locale:"en" as const};
describe("price proposal agent tool",()=>{
 it("fails closed when proposal capability is missing",async()=>{
  expect(await proposalTools.propose_price_change.execute(input,minimal)).toMatchObject({
   draft:true,saved:false,missing:["proposalsUnavailable"]});
 });
 it("creates only an inert card with exact user arguments",async()=>{
  const proposePriceChange=vi.fn().mockResolvedValue({proposalId:"33333333-3333-4333-8333-333333333333",
   revision:1,productName:"Latte",oldPriceCents:450,newPriceCents:550});
  const a=await proposalTools.propose_price_change.execute(input,{
   ...minimal,proposals:{proposePriceChange}});
  expect(proposePriceChange).toHaveBeenCalledWith({productId:input.product_id,newPriceCents:550});
  expect(a).toMatchObject({source:"price_change_proposal",draft:true,saved:false,
   proposalId:"33333333-3333-4333-8333-333333333333",missing:[]});
 });
 it("validates the product UUID and maximum price",async()=>{
  await expect(proposalTools.propose_price_change.execute({...input,product_id:"bad"},minimal)).rejects.toThrow();
  await expect(proposalTools.propose_price_change.execute({...input,new_price_cents:100001},minimal)).rejects.toThrow();
 });
});
