import {describe,it,expect,vi} from "vitest";
import {proposalTools} from "./proposals";
import type {AgentToolContext} from "./index";
const input={product_id:"22222222-2222-4222-8222-222222222222",new_price_cents:550};
const minimal={
 tools:{getMenuCatalog:async()=>({
   available:true as const,
   value:[{id:input.product_id,name:"Latte",category:"drink" as const,active:true,priceCents:450}],
   quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}
 })} as unknown as AgentToolContext["tools"],
 timezone:"America/Los_Angeles",asOf:"2026-10-22",locale:"en" as const,
};
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
 it("refuses ambiguous model-selected IDs, but accepts a specifically named product",async()=>{
  const hot="11111111-1111-4111-8111-111111111111";
  const rows=[{id:hot,name:"Latte",category:"drink" as const,active:true,priceCents:450},
    {id:input.product_id,name:"Iced Latte",category:"drink" as const,active:true,priceCents:500}];
  const proposePriceChange=vi.fn().mockResolvedValue({proposalId:"33333333-3333-4333-8333-333333333333",
    revision:1,productName:"Iced Latte",oldPriceCents:500,newPriceCents:550});
  const {newResolveState}=await import("../resolve");
  const ctx={...minimal,tools:{getMenuCatalog:async()=>({available:true as const,value:rows,
    quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}})} as unknown as AgentToolContext["tools"],
    proposals:{proposePriceChange}};
  for(const product_id of [hot,input.product_id]){
    const result=await proposalTools.propose_price_change.execute({product_id,new_price_cents:550},
      {...ctx,resolveState:newResolveState("raise latte to $5.50")});
    expect(result).toMatchObject({missing:["ownerChoiceRequired"],needsOwnerChoice:true});
  }
  expect(proposePriceChange).not.toHaveBeenCalled();
  const wrongProduct=await proposalTools.propose_price_change.execute(input,{
    ...ctx,resolveState:newResolveState("raise espresso to $5.50")});
  expect(wrongProduct).toMatchObject({missing:["targetNotConfirmed"],saved:false});
  expect(proposePriceChange).not.toHaveBeenCalled();
  const chosen=await proposalTools.propose_price_change.execute(input,
    {...ctx,resolveState:newResolveState("raise iced latte to $5.50")});
  expect(chosen.missing).toEqual([]);
  expect(proposePriceChange).toHaveBeenCalledTimes(1);
 });
 it("lets an unambiguous 'yes, do it' draft one real price card only",async()=>{
  const {newResolveState}=await import("../resolve");
  const proposePriceChange=vi.fn().mockResolvedValue({
   proposalId:"33333333-3333-4333-8333-333333333333",revision:1,
   productName:"Latte",oldPriceCents:450,newPriceCents:550
  });
  const state=newResolveState("yes, do it",[
   {role:"user",content:"Should I price Latte at $5.50?"},
   {role:"assistant",content:"I recommend changing Latte to $5.50."}
  ]);
  const result=await proposalTools.propose_price_change.execute(input,{
   ...minimal,resolveState:state,proposals:{proposePriceChange}
  });
  expect(result).toMatchObject({draft:true,proposalId:"33333333-3333-4333-8333-333333333333"});
  expect(proposePriceChange).toHaveBeenCalledTimes(1);
 });
 it("rejects generic assent when multiple product names appear in the last assistant turn",async()=>{
  const {newResolveState}=await import("../resolve");
  const rows=[{id:input.product_id,name:"Latte",category:"drink" as const,active:true,priceCents:450},
   {id:"11111111-1111-4111-8111-111111111111",name:"Mocha",category:"drink" as const,active:true,priceCents:500}];
  const proposePriceChange=vi.fn();
  const result=await proposalTools.propose_price_change.execute(input,{
   ...minimal,tools:{getMenuCatalog:async()=>({available:true as const,value:rows,
    quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}})} as unknown as AgentToolContext["tools"],
   resolveState:newResolveState("yes",[
    {role:"assistant",content:"You could raise Latte to $5.50 or Mocha to $6."}]),
   proposals:{proposePriceChange}
  });
  expect(result.missing).toContain("targetNotConfirmed");
  expect(proposePriceChange).not.toHaveBeenCalled();
 });
 it("validates the product UUID and maximum price",async()=>{
  await expect(proposalTools.propose_price_change.execute({...input,product_id:"bad"},minimal)).rejects.toThrow();
  await expect(proposalTools.propose_price_change.execute({...input,new_price_cents:100001},minimal)).rejects.toThrow();
 });
});
