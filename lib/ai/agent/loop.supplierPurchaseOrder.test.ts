import {describe,it,expect,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import type {AgentToolContext} from "./tools";
const completed={type:"response.completed",response:{usage:{
 input_tokens:100,output_tokens:25,input_tokens_details:{cached_tokens:0}}}};
const call=(name:string,args:string,id:string)=>({type:"response.output_item.done",
 item:{type:"function_call",name,arguments:args,call_id:id}});
const text=(delta:string)=>({type:"response.output_text.delta",delta});
const ingredientId="11111111-1111-4111-8111-111111111111";
const args=(quantity:number)=>JSON.stringify({items:[{
 ingredientId,itemName:"Milk",quantity,unit:"gal"}],
 neededBy:"2026-11-17",preferredSupplier:null});
const plan={offers:[{supplierName:"Farm A",currency:"CAD",subtotalCents:2250,
 totalCents:null,shippingCents:null,taxCents:null,limitations:["shipping_unknown","tax_unknown"],
 lines:[{quoteId:"22222222-2222-4222-8222-222222222222",ingredientId,
 itemName:"Milk",neededBaseQuantity:18927.05892,baseUnit:"ml",packs:5,
 packQuantity:1,packUnit:"gal",priceCents:450,lineSubtotalCents:2250,
 quotedOn:"2026-11-13",deliveryOn:"2026-11-16"}]}],
 missing:[],comparison:"subtotal_only",truncated:false} as const;
function playback(rounds:Array<Array<Record<string,unknown>>>){
 const requests:Array<Record<string,unknown>>=[];
 const provider:AgentProvider=async function* (params){
  requests.push(params as Record<string,unknown>);
  for(const event of rounds[requests.length-1]??[])yield event as never;
 };
 return {provider,requests};
}
const baseContext={
 locale:"en" as const,asOf:"2026-11-13",timezone:"America/Los_Angeles",
 tools:{
  getMenuCatalog:async()=>({available:true,value:[],quality:{
   level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getSalesTrend:async()=>({available:false,value:null,quality:{
   level:"low" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getProfitability:async()=>({available:false,value:null,quality:{
   level:"low" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
 },
};
describe("Task14B agentic purchasing: Supervisor works through a goal, not Q&A",()=>{
 it("makes multiple actual model-directed tool calls: investigate → persist approval draft → report limitation",async()=>{
  const order:string[]=[];
  const inspect=vi.fn(async()=>{order.push("inspect");return plan;});
  const propose=vi.fn(async()=>{order.push("propose");return {
   proposalId:"33333333-3333-4333-8333-333333333333",
   revision:1,supplierName:"Farm A",subtotalCents:2250,currency:"CAD"};});
  const ctx={...baseContext,purchasing:{inspect,propose}} as unknown as AgentToolContext;
  const {requests,provider}=playback([
   [call("inspect_supplier_purchase",args(5),"inspect-1"),completed],
   [call("propose_supplier_purchase_order",args(5),"propose-2"),completed],
   [text("I investigated the quoted milk supply and prepared a CAD 22.50 subtotal draft. Shipping and tax are unknown; owner approval is still required. I have not ordered or received stock."),completed]
  ]);
  const result=await runAgentTurn({ownerText:"Handle our milk needs for Monday. Find a supplier and prepare the purchase order.",context:ctx,provider});
  expect(requests).toHaveLength(3);
  expect(order).toEqual(["inspect","propose"]);
  expect(inspect).toHaveBeenCalledWith(JSON.parse(args(5)));
  expect(propose).toHaveBeenCalledWith(JSON.parse(args(5)));
  expect(result.text).toContain("owner approval");
  expect((requests[2].input as unknown[]).length).toBeGreaterThan(1);
  expect(requests[0].tools).toEqual(expect.arrayContaining([
   expect.objectContaining({name:"inspect_supplier_purchase",strict:true}),
   expect.objectContaining({name:"propose_supplier_purchase_order",strict:true})
  ]));
 });
 it("owner correction is a fresh bounded read+proposal, not auto-approval or silent inventory write",async()=>{
  const count:number[]=[];
  const propose=vi.fn(async (input:{items:Array<{quantity:number}>})=>{
   count.push(input.items[0].quantity);
   return {proposalId:"44444444-4444-4444-8444-444444444444",
    revision:1,supplierName:"Farm A",subtotalCents:3150,currency:"CAD"};
  });
  const ctx={...baseContext,purchasing:{
   inspect:vi.fn(async()=>({...plan,offers:[{...plan.offers[0],subtotalCents:3150}]})),propose
  }} as unknown as AgentToolContext;
  const {provider}=playback([
   [call("inspect_supplier_purchase",args(7),"inspect-corrected"),completed],
   [call("propose_supplier_purchase_order",args(7),"propose-corrected"),completed],
   [text("I revised the draft to seven gallons. It remains unapproved."),completed],
  ]);
  await runAgentTurn({ownerText:"Change it to seven gallons and update the draft.",context:ctx,provider});
  expect(count).toEqual([7]);
  expect(propose).toHaveBeenCalledOnce();
  // The actual owner click belongs only to the protected /proposals API,
  // not to any model tool or this test context.
  expect(Object.hasOwn(ctx,"approve")).toBe(false);
 });
});